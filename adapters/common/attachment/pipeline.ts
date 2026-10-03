/**
 * Shared inbound attachment pipeline — the voice path.
 *
 * Input is a materialized attachment list (`LocalAttachment[]`, produced by a
 * platform MediaService after the pairing/dedup gates) plus the message's
 * original text. The pipeline transcribes *voice* messages through a
 * pluggable `TranscriptionProvider`, merges transcripts into the text, and
 * maps every surviving attachment back to a wire `AttachmentRef` (image →
 * base64, the rest → path reference). See
 * docs/internals/im-media-pipeline.md §4.2.
 *
 * Candidacy is explicit: only `mediaKind === 'voice'` is auto-transcribed.
 * MIME is never used to infer intent, so any other audio file (music, a
 * forwarded recording) is handed through as a plain file reference.
 *
 * Failure policy (§4.2): every degrade keeps the message flowing — the voice
 * stays as a file reference and the user gets a notice explaining why.
 *
 * Cancellation: `opts.signal` is forwarded to the provider through a real
 * `AbortController` that is also fired by the per-attachment timeout, so a
 * hung child process is actually terminated (not merely raced). When the
 * caller's signal aborts, the pipeline returns `cancelled: true` with the
 * original text and an empty payload; the caller must not send it, and no
 * notices are emitted.
 */

import type { AttachmentRef, LocalAttachment } from './attachment-types.js'
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from './transcribe/types.js'

/** Pipeline-owned duration ceiling; forwarded verbatim to the provider. */
export const DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS = 300

export interface EnrichAndAssembleOptions {
  /** Selected TranscriptionProvider. Absent ⇒ every voice degrades to a file reference. */
  transcriber?: TranscriptionProvider
  /** User-visible notices; wrapped so a throwing callback never blocks the run. */
  onNotice?: (notice: string) => void
  /** Per-attachment transcription timeout; aborts the provider's child process. Default 60s. */
  transcribeTimeoutMs?: number
  /** UI language hint forwarded to the provider. */
  languageHint?: string
  /** Caller cancellation. Aborting returns `cancelled: true` instead of degrading. */
  signal?: AbortSignal
  /**
   * Real-duration ceiling in seconds (default 300). Enforced from the
   * platform-reported `durationSeconds`; the same value is forwarded to the
   * provider so it validates the decoded audio against one policy.
   */
  maxDurationSeconds?: number
}

/** One provider transcript merged into the message, for downstream echo/UI. */
export interface TranscriptResult {
  name: string
  /** The transcript text as merged into `EnrichedMessage.text`. */
  text: string
  language?: string
}

export interface EnrichedMessage {
  text: string
  attachments: AttachmentRef[]
  notices: string[]
  /** Transcripts that were merged into `text`, in message order. */
  transcripts: TranscriptResult[]
  /**
   * True when the caller aborted mid-flight. The payload is not to be sent;
   * `text` carries the original message text and `attachments` is empty.
   */
  cancelled: boolean
}

const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60_000

/** Map one staged attachment onto the wire protocol. Mirrors platform code today. */
function localToRef(local: LocalAttachment): AttachmentRef {
  if (local.kind === 'image') {
    return {
      type: 'image',
      name: local.name,
      data: local.buffer.toString('base64'),
      mimeType: local.mimeType,
    }
  }
  return {
    type: 'file',
    name: local.name,
    path: local.path,
    mimeType: local.mimeType,
  }
}

function degradePhrase(result: Extract<TranscriptionResult, { ok: false }>): string {
  switch (result.reason) {
    case 'too_long':
      return '过长已跳过转写'
    case 'unsupported_format':
      return '格式暂不支持转写'
    case 'no_credentials':
      return '转写服务未配置凭据'
    case 'unavailable':
      return '转写引擎不可用'
    case 'invalid_audio':
      return '音频无法解码'
    case 'cancelled':
      return '转写已取消'
    default:
      return '转写失败'
  }
}

type ProviderOutcome =
  | { kind: 'result'; result: TranscriptionResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted' }

/**
 * Run one transcription with a real cancellation path. The controller is
 * aborted by the timeout timer *and* mirrors `opts.signal`, so the provider
 * can terminate its child process.
 *
 * The provider call is started inside `Promise.resolve().then(…)` so a
 * synchronous throw degrades exactly like a rejection instead of escaping.
 * On abort we deliberately do not return at the race: the provider contract
 * requires `signal` to be honoured, and the caller's concurrency slot must
 * not be released while a real child process is still being cleaned up, so
 * we wait for the guarded promise to settle before handing the outcome back.
 * Both outcomes are guarded, so nothing here can reject.
 */
async function runTranscription(
  provider: TranscriptionProvider,
  input: TranscriptionInput,
  controller: AbortController,
  timeoutMs: number,
): Promise<{ outcome: ProviderOutcome; timedOut: boolean }> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  const guarded = Promise.resolve()
    .then(() => provider.transcribe({ ...input, signal: controller.signal }))
    .then(
      (result): ProviderOutcome => ({ kind: 'result', result }),
      (error): ProviderOutcome => ({ kind: 'error', error }),
    )

  let onAbort: (() => void) | undefined
  const aborted = new Promise<ProviderOutcome>((resolve) => {
    if (controller.signal.aborted) {
      resolve({ kind: 'aborted' })
      return
    }
    onAbort = () => resolve({ kind: 'aborted' })
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const outcome = await Promise.race([guarded, aborted])
    if (outcome.kind === 'aborted') {
      // Wait for the provider to finish terminating its process and cleaning
      // up before releasing the caller's slot.
      await guarded
    }
    return { outcome, timedOut }
  } finally {
    clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

/** One voice attachment through the transcription path. Returns the
 *  transcript, or undefined when the voice must degrade to a file reference
 *  (notice already emitted either way). */
async function transcribeVoice(
  local: LocalAttachment,
  opts: EnrichAndAssembleOptions,
  timeoutMs: number,
  maxDurationSeconds: number,
  emit: (notice: string) => void,
): Promise<TranscriptResult | undefined> {
  const provider = opts.transcriber
  if (!provider) {
    emit(`🎧 语音转写未配置，「${local.name}」已作为文件转交`)
    return undefined
  }

  // Real duration is the only duration signal we trust. Byte size is never
  // used as a proxy.
  if (local.durationSeconds !== undefined && local.durationSeconds > maxDurationSeconds) {
    emit(`🎧 语音过长已跳过转写，「${local.name}」已作为文件转交`)
    return undefined
  }

  if (!provider.supported(local.mimeType)) {
    emit(`🎧 音频格式暂不支持转写，「${local.name}」已作为文件转交`)
    return undefined
  }

  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (opts.signal?.aborted) controller.abort()

  const { outcome, timedOut } = await runTranscription(
    provider,
    {
      buffer: local.buffer,
      mimeType: local.mimeType,
      fileName: local.name,
      languageHint: opts.languageHint,
      maxDurationSeconds,
    },
    controller,
    timeoutMs,
  ).finally(() => {
    opts.signal?.removeEventListener('abort', forwardAbort)
  })

  if (opts.signal?.aborted) {
    // The caller pulled the plug; let the outer loop return `cancelled`.
    return undefined
  }
  if (outcome.kind === 'aborted' || timedOut) {
    emit(`🎧 语音转写超时，「${local.name}」已作为文件转交`)
    return undefined
  }
  if (outcome.kind === 'error') {
    emit(`🎧 语音转写失败，「${local.name}」已作为文件转交`)
    return undefined
  }
  const { result } = outcome
  if (!result.ok) {
    emit(`🎧 语音${degradePhrase(result)}，「${local.name}」已作为文件转交`)
    return undefined
  }
  const transcript = result.text.replace(/\r\n?/g, '\n').trim()
  if (!transcript) {
    // Nothing recognizable came back — keep the audio rather than drop it silently.
    emit(`🎧 语音未能识别出内容，「${local.name}」已作为文件转交`)
    return undefined
  }
  return { name: local.name, text: transcript, language: result.language }
}

/** True when the caller aborted; callers must not send the result. */
function cancelledMessage(text: string): EnrichedMessage {
  return { text: text.trim(), attachments: [], notices: [], transcripts: [], cancelled: true }
}

/**
 * Transcribe voice attachments and assemble the outbound message.
 *
 * Pure with respect to the platform: no SDK imports, no disk writes, no
 * network of its own — the only IO is whatever the configured provider
 * performs. Non-voice attachments are mapped straight through, so a message
 * mixing voice and images (or voice and plain files) works unchanged.
 */
export async function enrichAndAssemble(
  locals: LocalAttachment[],
  text: string,
  opts: EnrichAndAssembleOptions = {},
): Promise<EnrichedMessage> {
  const timeoutMs = opts.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS
  const maxDurationSeconds = opts.maxDurationSeconds ?? DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS
  const notices: string[] = []
  const emit = (notice: string): void => {
    notices.push(notice)
    try {
      opts.onNotice?.(notice)
    } catch {
      // A broken notice sink must never block the message.
    }
  }

  if (opts.signal?.aborted) return cancelledMessage(text)

  const transcripts: TranscriptResult[] = []
  const attachments: AttachmentRef[] = []

  for (const local of locals) {
    if (opts.signal?.aborted) return cancelledMessage(text)

    if (local.mediaKind !== 'voice') {
      attachments.push(localToRef(local))
      continue
    }

    const transcript = await transcribeVoice(local, opts, timeoutMs, maxDurationSeconds, emit)
    if (opts.signal?.aborted) return cancelledMessage(text)
    if (transcript === undefined) {
      // Degrade: the voice stays reachable for the agent as a file reference.
      attachments.push(localToRef(local))
      continue
    }

    // Success receipt: the actual transcript text, plain, in the same notices
    // channel as the degrade notices. It states what was recognized, not that
    // anything was delivered.
    emit(`📝 语音转写「${local.name}」：${transcript.text}`)
    transcripts.push(transcript)
  }

  const blocks = [text.trim(), ...transcripts.map((t) => `🎤 语音转写（${t.name}）：\n${t.text}`)]
  const merged = blocks.filter((block) => block.length > 0).join('\n\n')

  return { text: merged, attachments, notices, transcripts, cancelled: false }
}