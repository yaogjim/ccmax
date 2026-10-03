/**
 * Config → TranscriptionProvider wiring for the inbound voice pipeline.
 *
 * The selector follows docs/internals/im-media-pipeline.md §4.5: no config
 * means no provider, and every voice message degrades to a file reference
 * with a visible notice. 'openai-compat' is a reserved provider id — its
 * implementation is deliberately deferred; configuring it today selects no
 * provider (with a warning) rather than pretending to work.
 */

import type { AdapterConfig } from './config.js'
import type { TranscriptionProvider } from './attachment/transcribe/types.js'
import { WhisperLocalProvider } from './attachment/transcribe/whisper-local.js'

/** Build the configured provider, or undefined when STT is off. */
export function resolveConfiguredTranscriber(config: AdapterConfig): TranscriptionProvider | undefined {
  if (config.stt.provider === 'whisper-local') {
    return new WhisperLocalProvider({
      command: config.stt.whisperPath || undefined,
      model: config.stt.whisperModel || undefined,
      prompt: config.stt.whisperPrompt,
      // `stt.ffmpegPath` / `CC_STT_FFMPEG_PATH` selects the audio decoder; the
      // provider exposes it as `decodeCommand` (empty → probe `ffmpeg`).
      decodeCommand: config.stt.ffmpegPath || undefined,
    })
  }
  return undefined
}

/** Language hint for the pipeline; defaults to 'zh' like the Telegram UI. */
export function sttLanguageHint(config: AdapterConfig): string {
  return config.stt.language || 'zh'
}