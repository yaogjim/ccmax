/**
 * Pluggable speech-to-text provider interface for the IM inbound pipeline.
 *
 * See docs/internals/im-media-pipeline.md §4.5. `whisper-local` (spawn a
 * whisper.cpp-compatible local binary) is implemented today; a remote
 * `openai-compat` provider is deferred. `fake` is the deterministic test
 * double.
 *
 * Contract notes for implementers:
 *  - `transcribe` must never throw for expected failures; return
 *    `{ ok: false, ... }` instead so the pipeline can degrade gracefully.
 *  - `supported` must be cheap and synchronous; the pipeline calls it
 *    before any byte is read.
 *  - Implementations must not mutate the caller's buffer.
 *  - Implementations must honor `signal`: when it aborts they must stop the
 *    underlying work (kill any child process and clean up temp files) and
 *    settle with `{ ok: false, reason: 'cancelled' }` rather than hanging.
 *  - Implementations must never return a partial/truncated transcript as
 *    `ok: true` — truncation is a failure, not a full transcription.
 */

export type TranscriptionFailureReason =
  | 'unsupported_format'
  | 'too_long'
  | 'no_credentials'
  | 'provider_error'
  /** Engine/decoder not installed or not runnable (distinct from bad audio). */
  | 'unavailable'
  /** The caller aborted (pipeline timeout or an upstream signal). */
  | 'cancelled'
  /** The bytes did not decode as usable audio (corrupt/empty/undecodable). */
  | 'invalid_audio'

export type TranscriptionResult =
  | { ok: true; text: string; language?: string }
  | {
      ok: false
      reason: TranscriptionFailureReason
      detail?: string
    }

export interface TranscriptionInput {
  buffer: Buffer
  mimeType: string
  fileName?: string
  /** IM UI language hint; providers default to assuming 'zh'. */
  languageHint?: string
  /**
   * Hard cap on the *real* audio duration, in seconds. The pipeline defaults
   * this to 300 and providers must reject (as `too_long`) rather than
   * truncate. Providers must not invent their own policy value.
   */
  maxDurationSeconds?: number
  /**
   * Cancellation signal. Forwarded to the child process; when aborted the
   * provider kills the process tree, cleans up and returns
   * `{ ok: false, reason: 'cancelled' }`.
   */
  signal?: AbortSignal
}

export interface TranscriptionProvider {
  /** Stable identifier, e.g. 'whisper-local' / 'openai-compat' / 'fake'. */
  readonly id: string
  /** Whether this provider can handle the given MIME type at all. */
  supported(mimeType: string): boolean
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
}