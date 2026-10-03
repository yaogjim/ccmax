/**
 * Telegram media service — wraps grammY download/upload helpers.
 *
 * Telegram file download flow:
 *   1. bot.api.getFile(file_id)  → { file_path, file_size? }
 *   2. GET https://api.telegram.org/file/bot<token>/<file_path>
 *
 * Downloads are bounded by one wall-clock budget (`DEFAULT_DOWNLOAD_TIMEOUT_MS`)
 * that covers *every* stage — `getFile`, the body fetch, the read loop and the
 * final staging check — plus a streaming byte cap, so neither a silent Telegram
 * API nor an endless body can hold a download open. The caller can cancel
 * through a real `AbortSignal`, observed before the first byte.
 *
 * Both the deadline and the caller are honoured at every stage, including the
 * two the platform will not abort for us: `bot.api.getFile` is a single request
 * with no signal, and a body reader that is not wired to `fetch` ignores the
 * signal entirely. Both are raced against the download's own signal (see
 * `raceWithSignal`), so no exit path is left behind. A *deadline* is reported
 * as a timeout and never as a user cancellation.
 */

import { InputFile, type Bot } from 'grammy'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { FILE_MAX_BYTES } from '../common/attachment/attachment-limits.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'

/** Wall-clock budget for one Telegram file download: `getFile`, the body
 *  fetch, the read loop and the staging check all spend from it. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000
/** Hard byte cap enforced while streaming; default matches the file gate. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = FILE_MAX_BYTES

function extOf(fileName?: string): string {
  if (!fileName) return ''
  const m = /\.([^./\\]+)$/.exec(fileName)
  return m ? m[1]!.toLowerCase() : ''
}

function classifyKind(mime: string | undefined, fileName: string): 'image' | 'file' {
  if (mime?.startsWith('image/')) return 'image'
  const ext = extOf(fileName)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  return 'file'
}

/** The caller cancelled the download (adapter shutdown, `/stop`, session switch). */
export class TelegramDownloadCancelledError extends Error {
  constructor() {
    super('Telegram download cancelled')
    this.name = 'TelegramDownloadCancelledError'
  }
}

/** The response exceeded the streaming byte cap before completing. */
export class TelegramDownloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Telegram download exceeded ${maxBytes} bytes`)
    this.name = 'TelegramDownloadTooLargeError'
  }
}

/**
 * The download's own signal fired while `work` was still pending.
 *
 * It carries no verdict on *why*: the signal fires for both the deadline and a
 * caller that gave up, so only the download can tell those apart — a deadline
 * is not a cancellation and the caller acts on the two differently.
 */
class TelegramDownloadAbortedError extends Error {
  constructor() {
    super('Telegram download aborted')
    this.name = 'TelegramDownloadAbortedError'
  }
}

/**
 * Settle as soon as `signal` aborts, even when `work` itself cannot be
 * cancelled.
 *
 * `bot.api.getFile` is a single request that grammY does not let us abort, and
 * a response reader that is not wired to `fetch` never notices the signal, so
 * without this the whole download — and the queue slot behind it — would wait
 * for work nobody is waiting for any more. The abandoned promise is observed so
 * its eventual rejection cannot surface as an unhandled rejection.
 */
function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new TelegramDownloadAbortedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new TelegramDownloadAbortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export interface DownloadHint {
  fileName?: string
  mimeType?: string
  /** Only voice notes are marked `'voice'`; the shared pipeline transcribes
   *  exactly that media kind and leaves ordinary audio as a file reference. */
  mediaKind?: 'voice'
  /** Telegram-reported duration in seconds; forwarded for the duration gate. */
  durationSeconds?: number
}

export interface DownloadLimits {
  /** Caller cancellation; observed before, during and after every stage —
   *  including while `getFile` is pending, which the SDK cannot abort. Its
   *  abort is reported as a cancellation, never as a timeout. */
  signal?: AbortSignal
  /** Override the total budget shared by `getFile`, the body fetch, the read
   *  loop and the staging check (tests use a short value). */
  timeoutMs?: number
  /** Override the streaming byte cap. */
  maxBytes?: number
}

export class TelegramMediaService {
  constructor(
    private readonly bot: Bot,
    private readonly store: AttachmentStore,
  ) {}

  async downloadFile(
    fileId: string,
    sessionId: string,
    hint: DownloadHint = {},
    limits: DownloadLimits = {},
  ): Promise<LocalAttachment> {
    const timeoutMs = limits.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    const maxBytes = limits.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    if (limits.signal?.aborted) throw new TelegramDownloadCancelledError()

    // One controller and one deadline cover the whole download: `getFile`, the
    // body fetch, the read loop and the staging check. The deadline is started
    // here, *before* `getFile` — starting it after the metadata call would let
    // a silent Telegram API hang the download (and this chat's queue slot)
    // forever when the caller passes no signal at all.
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort()
    limits.signal?.addEventListener('abort', onOuterAbort, { once: true })
    if (limits.signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    /**
     * Which abort this was. The controller fires for both reasons, so the
     * caller's signal is the tie-breaker: only it knows that a person gave up,
     * and a deadline must never be reported as a cancellation.
     */
    const abortError = (): Error => limits.signal?.aborted
      ? new TelegramDownloadCancelledError()
      : new Error('[TelegramMedia] download timed out')

    try {
      const file = await raceWithSignal(this.bot.api.getFile(fileId), controller.signal)
      if (controller.signal.aborted) throw abortError()
      if (!file.file_path) {
        throw new Error(`[TelegramMedia] getFile returned no file_path for ${fileId}`)
      }
      // Cheap pre-check: reject before pulling the bytes when Telegram already
      // reports a size above the cap.
      const reportedSize = (file as { file_size?: number }).file_size
      if (typeof reportedSize === 'number' && reportedSize > maxBytes) {
        throw new TelegramDownloadTooLargeError(maxBytes)
      }

      const token = (this.bot as unknown as { token: string }).token
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`

      const resp = await fetch(url, { signal: controller.signal })
      if (!resp.ok) {
        throw new Error(`[TelegramMedia] fetch failed: ${resp.status} ${resp.statusText}`)
      }

      const chunks: Buffer[] = []
      let total = 0
      const reader = resp.body?.getReader()
      if (reader) {
        /** Real `fetch` tears its stream down on abort, but a hermetic body
         *  does not have to: the contract cannot depend on that, so a pending
         *  read is raced against the same signal and the reader is released. */
        const readOnce = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          try {
            return await raceWithSignal(reader.read(), controller.signal)
          } catch (err) {
            await reader.cancel().catch(() => {})
            throw err
          }
        }
        while (true) {
          if (controller.signal.aborted) throw abortError()
          const { done, value } = await readOnce()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new TelegramDownloadTooLargeError(maxBytes)
          }
          chunks.push(Buffer.from(value))
        }
      } else {
        const fallback = Buffer.from(await raceWithSignal(resp.arrayBuffer(), controller.signal))
        if (fallback.length > maxBytes) throw new TelegramDownloadTooLargeError(maxBytes)
        total = fallback.length
        chunks.push(fallback)
      }

      const buffer = Buffer.concat(chunks, total)
      const mime = hint.mimeType ?? resp.headers.get('content-type') ?? undefined
      const fallbackName = file.file_path.split('/').pop() || fileId
      const name = hint.fileName ?? fallbackName
      const kind = classifyKind(mime, name)
      const target = this.store.resolvePath('telegram', sessionId, name)
      // Aborted while the last bytes arrived — by the deadline or by the
      // caller: drop the transfer instead of staging a file nobody will use.
      if (controller.signal.aborted) throw abortError()
      await this.store.write(target, buffer)
      return {
        kind,
        mediaKind: hint.mediaKind,
        durationSeconds: hint.durationSeconds,
        name,
        path: target,
        size: buffer.length,
        mimeType: mime ?? (kind === 'image' ? 'image/png' : 'application/octet-stream'),
        buffer,
      }
    } catch (err) {
      if (err instanceof TelegramDownloadCancelledError || err instanceof TelegramDownloadTooLargeError) throw err
      // A raced `getFile`, an aborted fetch and a raced read all arrive as
      // generic errors; the signal is what says which one this was, so a
      // deadline is never mislabelled as a user cancellation.
      if (controller.signal.aborted) throw abortError()
      throw err
    } finally {
      clearTimeout(timer)
      limits.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  async sendPhoto(chatId: number, buffer: Buffer, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(
      chatId,
      new InputFile(buffer),
      caption ? { caption } : undefined,
    )
  }

  async sendDocument(
    chatId: number,
    buffer: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<void> {
    await this.bot.api.sendDocument(
      chatId,
      new InputFile(buffer, fileName),
      caption ? { caption } : undefined,
    )
  }
}