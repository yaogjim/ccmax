/**
 * Explicit local voice-pipeline smoke entry (plan D2).
 *
 * Proves WhisperLocalProvider + enrichAndAssemble wiring only. Does not claim
 * recognition quality, does not load adapter config, does not import Telegram,
 * does not read ~/.claude, does not download, and is not a CI live gate.
 *
 * Usage (all paths must be absolute):
 *   bun --no-env-file scripts/smoke-voice-local.ts \
 *     --file /abs/sample.ogg \
 *     --whisper /abs/whisper-cli \
 *     --ffmpeg /abs/ffmpeg \
 *     --model /abs/ggml-base.bin \
 *     [--language zh]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { FILE_MAX_BYTES } from '../common/attachment/attachment-limits.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import { inferMimeFromFileName } from '../common/attachment/mime.js'
import { enrichAndAssemble } from '../common/attachment/pipeline.js'
import { WhisperLocalProvider } from '../common/attachment/transcribe/whisper-local.js'

const REQUIRED = ['file', 'whisper', 'ffmpeg', 'model'] as const

export type SmokeVoiceArgs = {
  file: string
  whisper: string
  ffmpeg: string
  model: string
  language: string
}

export type SmokeVoiceReport = {
  ok: boolean
  cancelled: boolean
  ms?: number
  text?: string
  transcripts?: Array<{ name: string; text: string; language?: string }>
  notices?: string[]
  reason?: string
  attachments?: Array<{ type: string; name?: string; path?: string; mimeType?: string }>
}

export function parseSmokeVoiceArgs(argv: string[]):
  | { ok: true; value: SmokeVoiceArgs }
  | { ok: false; reason: string } {
  let values: Record<string, string | undefined>
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        whisper: { type: 'string' },
        ffmpeg: { type: 'string' },
        model: { type: 'string' },
        language: { type: 'string', default: 'zh' },
      },
      strict: true,
      allowPositionals: false,
    })
    values = parsed.values
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  for (const key of REQUIRED) {
    const value = values[key]?.trim() ?? ''
    if (!value) return { ok: false, reason: `missing --${key}` }
    if (!path.isAbsolute(value)) return { ok: false, reason: `--${key} must be an absolute path` }
  }

  const language = values.language?.trim() || 'zh'
  return {
    ok: true,
    value: {
      file: values.file!.trim(),
      whisper: values.whisper!.trim(),
      ffmpeg: values.ffmpeg!.trim(),
      model: values.model!.trim(),
      language,
    },
  }
}

function readInputFile(file: string): { ok: true; buffer: Buffer } | { ok: false; reason: string } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, reason: `file not found: ${file}` }
  }
  if (!stat.isFile()) return { ok: false, reason: `not a file: ${file}` }
  if (stat.size > FILE_MAX_BYTES) {
    return { ok: false, reason: `file exceeds ${FILE_MAX_BYTES} bytes` }
  }
  return { ok: true, buffer: fs.readFileSync(file) }
}

function writeReport(report: SmokeVoiceReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

export async function runSmokeVoice(
  args: SmokeVoiceArgs,
  signal?: AbortSignal,
): Promise<SmokeVoiceReport> {
  const started = Date.now()
  const loaded = readInputFile(args.file)
  if (!loaded.ok) {
    return { ok: false, cancelled: false, ms: Date.now() - started, reason: loaded.reason }
  }

  const name = path.basename(args.file)
  const local: LocalAttachment = {
    kind: 'file',
    mediaKind: 'voice',
    name,
    path: args.file,
    size: loaded.buffer.length,
    mimeType: inferMimeFromFileName(name) ?? 'audio/ogg',
    buffer: loaded.buffer,
  }

  const transcriber = new WhisperLocalProvider({
    command: args.whisper,
    decodeCommand: args.ffmpeg,
    model: args.model,
  })

  const result = await enrichAndAssemble([local], '', {
    transcriber,
    languageHint: args.language,
    signal,
  })

  const ms = Date.now() - started
  if (result.cancelled) {
    return { ok: false, cancelled: true, ms, text: result.text, reason: 'cancelled' }
  }

  const attachments = result.attachments.map((item) => ({
    type: item.type,
    name: item.name,
    ...('path' in item ? { path: item.path } : {}),
    ...('mimeType' in item && item.mimeType ? { mimeType: item.mimeType } : {}),
  }))
  const ok = result.transcripts.length > 0 && attachments.length === 0
  return {
    ok,
    cancelled: false,
    ms,
    text: result.text,
    transcripts: result.transcripts,
    notices: result.notices,
    ...(!ok ? { attachments, reason: result.notices[0] ?? 'degraded' } : {}),
  }
}

async function main(): Promise<void> {
  const parsed = parseSmokeVoiceArgs(process.argv.slice(2))
  if (!parsed.ok) {
    writeReport({ ok: false, cancelled: false, reason: parsed.reason })
    process.exitCode = 1
    return
  }

  const controller = new AbortController()
  const onSignal = (): void => {
    controller.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const report = await runSmokeVoice(parsed.value, controller.signal)
    writeReport(report)
    process.exitCode = report.ok && !report.cancelled ? 0 : 1
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

if (import.meta.main) {
  void main().catch((err) => {
    writeReport({
      ok: false,
      cancelled: false,
      reason: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
}