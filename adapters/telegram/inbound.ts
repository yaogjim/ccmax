/**
 * Telegram inbound media boundary — the seam between grammY's message objects
 * and the shared attachment pipeline described in
 * `docs/internals/im-media-pipeline.md`（「平台入口」/「物化与组装」）.
 *
 *  - collectTelegramLocalAttachments: ctx.message → materialized
 *    LocalAttachment[] (duration pre-check, download, size/mime gates). Only
 *    `message.voice` (a voice note) is marked `mediaKind: 'voice'` and
 *    therefore eligible for local transcription; `message.audio`
 *    (music/recordings) stays a plain file and is never turned into text.
 *  - assembleTelegramMessage / planTelegramOutbound: LocalAttachment[] +
 *    text → the exact content/attachments handed to bridge.sendUserMessage,
 *    plus user-visible degradation notices.
 *
 * Ordering and lifecycle are owned by the entrypoint: collection runs only
 * after the private-chat/authorization/dedup gates and inside the chat's
 * serial queue, and every step accepts the caller's `AbortSignal` so
 * `/stop`, session switches and shutdown can cancel a download or a
 * transcription before it reaches the Agent.
 */

import type { Context } from 'grammy'
import type {
  AttachmentRef,
  LocalAttachment,
} from '../common/attachment/attachment-types.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import {
  DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS,
  enrichAndAssemble,
  type EnrichedMessage,
} from '../common/attachment/pipeline.js'
import type { TranscriptionProvider } from '../common/attachment/transcribe/types.js'
import {
  TelegramDownloadCancelledError,
  type DownloadHint,
  type DownloadLimits,
} from './media.js'

/** Bound (fileId, hint, limits) → LocalAttachment download, session-scoped by the caller. */
export type TelegramFileDownloader = (
  fileId: string,
  hint: DownloadHint,
  limits?: DownloadLimits,
) => Promise<LocalAttachment>

/** Active transcriber for the Telegram inbound path; set once at startup from
 *  the resolved `stt.*` config. Unset means no local transcription runs and
 *  every voice note degrades to a file reference with a notice. */
let activeTranscriber: TranscriptionProvider | undefined

/** Language hint forwarded to the active transcriber ('zh' default). */
let activeLanguageHint = 'zh'

/** The entrypoint installs the configured provider here at startup; tests
 *  inject `FakeTranscriptionProvider`. */
export function setTelegramTranscriber(provider?: TranscriptionProvider): void {
  activeTranscriber = provider
}

/**
 * Whether voice notes will actually be transcribed. The entrypoint uses this
 * to decide whether a progress notice is honest: with no provider the voice
 * degrades straight to a file reference and no local work happens at all.
 */
export function isTelegramTranscriptionEnabled(): boolean {
  return activeTranscriber !== undefined
}

export function setTelegramLanguageHint(hint: string): void {
  const trimmed = hint.trim()
  activeLanguageHint = trimmed || 'zh'
}

type TelegramMessage = NonNullable<Context['message']>

/**
 * Refusal text for a voice note whose *platform-reported* duration exceeds the
 * transcription ceiling. The bytes are never downloaded, so the notice must
 * not claim a file was delivered — the user has to resend or use text.
 */
export function formatVoiceTooLongHint(durationSeconds: number, maxSeconds: number): string {
  return `🎧 语音时长 ${Math.round(durationSeconds)} 秒，超过 ${maxSeconds} 秒上限，已拒绝转写；该语音未下载，请改发文字或更短的语音。`
}

/** Scan a grammY message for photo/document/video/audio/voice, download each
 *  through the shared TelegramMediaService-backed downloader, apply the
 *  size/mime gates, and return the staged LocalAttachment list plus any
 *  rejection hints to reply with.
 *
 *  Only `voice` is marked `mediaKind: 'voice'`. `audio` and audio documents
 *  are intentionally left unmarked: the shared pipeline never guesses intent
 *  from MIME, so music and forwarded recordings stay plain file references.
 *
 *  Voice duration is checked against the transcription ceiling *before* the
 *  download, because `voice.duration` is the only trustworthy duration signal
 *  and compressed bytes cannot be converted into one. An over-long voice is
 *  refused outright rather than downloaded and then rejected.
 *
 *  `signal` aborts an in-flight download (and is forwarded to the
 *  downloader's own limits). A cancelled download produces no notice — the
 *  caller dropped the work on purpose. */
export async function collectTelegramLocalAttachments(
  msg: TelegramMessage | undefined,
  deps: {
    download: TelegramFileDownloader
    signal?: AbortSignal
    /** Voice duration ceiling; defaults to the shared pipeline's limit. */
    maxTranscribeDurationSeconds?: number
  },
): Promise<{ locals: LocalAttachment[]; rejections: string[] }> {
  const locals: LocalAttachment[] = []
  const rejections: string[] = []
  if (!msg) return { locals, rejections }
  const signal = deps.signal
  if (signal?.aborted) return { locals, rejections }
  const maxDurationSeconds = deps.maxTranscribeDurationSeconds ?? DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS

  const runOne = async (
    fileId: string,
    fileName?: string,
    mimeType?: string,
    extras: Pick<DownloadHint, 'mediaKind' | 'durationSeconds'> = {},
  ): Promise<void> => {
    try {
      const local = await deps.download(fileId, { fileName, mimeType, ...extras }, { signal })
      const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
      if (!check.ok) {
        rejections.push(check.hint)
        return
      }
      locals.push(local)
    } catch (err) {
      if (err instanceof TelegramDownloadCancelledError) return
      console.error('[Telegram] downloadFile failed:', err)
      rejections.push('📎 附件下载失败,请稍后重试')
    }
  }

  // Photos: grammY exposes an array of sizes, largest last.
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!
    await runOne(largest.file_id, `photo-${largest.file_unique_id}.jpg`, 'image/jpeg')
  }
  if (msg.document) {
    await runOne(msg.document.file_id, msg.document.file_name, msg.document.mime_type)
  }
  if (msg.video) {
    await runOne(msg.video.file_id, msg.video.file_name, msg.video.mime_type)
  }
  // Ordinary audio files (music, recordings): no mediaKind — never transcribed.
  if (msg.audio) {
    await runOne(msg.audio.file_id, msg.audio.file_name, msg.audio.mime_type)
  }
  // Voice notes are the only auto-transcribed media.
  if (msg.voice) {
    const duration = typeof msg.voice.duration === 'number' ? msg.voice.duration : undefined
    if (duration !== undefined && duration > maxDurationSeconds) {
      // Refused before the download: the audio is never staged, so the notice
      // must not promise the file was handed to the agent.
      rejections.push(formatVoiceTooLongHint(duration, maxDurationSeconds))
    } else {
      await runOne(
        msg.voice.file_id,
        `voice-${msg.voice.file_unique_id}.ogg`,
        msg.voice.mime_type ?? 'audio/ogg',
        {
          mediaKind: 'voice',
          ...(duration !== undefined ? { durationSeconds: duration } : {}),
        },
      )
    }
  }

  return { locals, rejections }
}

/** Run the shared enrichAndAssemble pipeline with the Telegram-configured
 *  transcriber. With no provider configured, voice degrades to a file
 *  reference and the notice explains why. `signal` cancels the transcription
 *  and yields `cancelled: true` (callers must not send that result). */
export async function assembleTelegramMessage(
  locals: LocalAttachment[],
  text: string,
  signal?: AbortSignal,
): Promise<EnrichedMessage> {
  return enrichAndAssemble(locals, text, {
    transcriber: activeTranscriber,
    languageHint: activeLanguageHint,
    signal,
  })
}

/**
 * Split pipeline notices into degrade notices (the user must know the voice
 * was not understood), the handover claims, and success receipts. The Telegram
 * entrypoint replies with the degrade notices *before* the send, then echoes
 * the *actual outbound content* after a successful send instead of the receipt
 * line, so what the user sees is exactly what reached the Agent — not a
 * filename-only confirmation.
 */
const TRANSCRIPT_RECEIPT_PREFIX = '📝'

/** The pipeline's assertion that the audio was handed to the Agent. */
export const TELEGRAM_HANDOVER_DONE = '已作为文件转交'
/** The same notice before the send: a statement of intent, not a result. */
export const TELEGRAM_HANDOVER_PENDING = '将作为文件转交'

/**
 * `bridge.sendUserMessage` is what actually hands the audio over, so a notice
 * that says 「已作为文件转交」 is only true after that send succeeded. Splitting
 * the claim out of the degrade notice lets the entrypoint show *why* the voice
 * was not understood immediately, while a failed or cancelled send can no
 * longer tell the user the file arrived when it did not.
 */
export function splitTelegramNotices(notices: string[]): {
  /** Safe before the send: states the outcome, never that it was delivered. */
  degrade: string[]
  /** Only true once the outbound message reached the Agent. */
  claims: string[]
  receipts: string[]
} {
  const degrade: string[] = []
  const claims: string[] = []
  const receipts: string[] = []
  for (const notice of notices) {
    if (notice.startsWith(TRANSCRIPT_RECEIPT_PREFIX)) {
      receipts.push(notice)
      continue
    }
    if (!notice.includes(TELEGRAM_HANDOVER_DONE)) {
      degrade.push(notice)
      continue
    }
    degrade.push(notice.replace(TELEGRAM_HANDOVER_DONE, TELEGRAM_HANDOVER_PENDING))
    const name = /「([^」]*)」/.exec(notice)?.[1]
    claims.push(`✅ 语音${TELEGRAM_HANDOVER_DONE}${name ? `：「${name}」` : ''}。`)
  }
  return { degrade, claims, receipts }
}

/** Map an EnrichedMessage onto the exact bridge.sendUserMessage arguments.
 *  A successful transcript counts as real content: a voice-only message is
 *  represented by its transcript and never falls back to the
 *  「(用户发送了附件)」placeholder. */
export function planTelegramOutbound(enriched: EnrichedMessage): {
  content: string
  attachments?: AttachmentRef[]
} {
  const content =
    enriched.text || (enriched.attachments.length > 0 ? '(用户发送了附件)' : '')
  const attachments =
    enriched.attachments.length > 0 ? enriched.attachments : undefined
  return { content, attachments }
}