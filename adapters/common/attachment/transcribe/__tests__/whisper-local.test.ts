import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  WhisperLocalProvider,
  defaultWhisperModelPath,
  resolveDecodeBinary,
  resolveWhisperBinary,
} from '../whisper-local.js'
import { enrichAndAssemble } from '../../pipeline.js'
import type { LocalAttachment } from '../../attachment-types.js'

/**
 * whisper-local provider 单测 —— 全部 hermetic：
 *  - 「whisper 引擎」与「ffmpeg 解码器」都是临时目录里的 Node 脚本替身；
 *  - 模型文件是临时目录里的占位文件；
 *  - 不联网、不读用户真实 ~/.claude、不运行真实模型。
 *
 * 这些用例只证明「管道接线」正确（发现、参数、输出文件、时长校验、
 * 限额、取消/清理、环境隔离）；它们**不**证明真实 OGG 解码或识别质量。
 *
 * 指令协议：传给 provider 的 buffer 内嵌指令行（`SECONDS=` / `TEXT=` /
 * `HANG` / `FAIL` / `NOOUTPUT` / `NOISY` / `HDRONLY` / `SLOWEXIT`），替身
 * 解码器把它们原样带进 WAV 载荷，替身引擎据此行为，从而完全无需真实音频。
 */

const isWindows = process.platform === 'win32'

let tmpRoot: string
let binDir: string
let modelPath: string

const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const selfDir = path.dirname(process.argv[1])
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const input = get('-i')
const out = args[args.length - 1]
const raw = fs.readFileSync(input)
fs.writeFileSync(path.join(selfDir, 'ffmpeg-args.log'), JSON.stringify(args))
if (raw.includes('HANGDECODE')) { setInterval(() => {}, 1000); }
if (raw.includes('NOTAUDIO')) { process.stderr.write('Invalid data found when processing input\\\\n'); process.exit(1) }
const text = raw.toString('utf8')
const m = text.match(/^SECONDS=([0-9.]+)$/m)
const seconds = m ? Number(m[1]) : raw.length / 100
const header = Buffer.alloc(44)
header.write('RIFF', 0, 'ascii')
header.write('WAVE', 8, 'ascii')
header.write('fmt ', 12, 'ascii')
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(16000, 24)
header.writeUInt32LE(32000, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36, 'ascii')
if (raw.includes('HDRONLY')) {
  // A header claiming 12s while no data bytes exist: must be rejected as
  // corrupt, never reported as a long recording.
  header.writeUInt32LE(384000, 40)
  header.writeUInt32LE(36 + 384000, 4)
  fs.writeFileSync(out, header)
} else {
  // A real, self-consistent 16k mono 16-bit PCM WAV of the requested duration.
  const dataSize = Math.max(2, Math.round(seconds * 32000))
  header.writeUInt32LE(dataSize, 40)
  header.writeUInt32LE(36 + dataSize, 4)
  fs.writeFileSync(out, Buffer.concat([header, raw, Buffer.alloc(Math.max(0, dataSize - raw.length))]))
}
if (raw.includes('SLOWEXIT')) {
  fs.writeFileSync(path.join(selfDir, 'decoded.txt'), '')
  setTimeout(() => process.exit(0), 400)
}
`

const FAKE_WHISPER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const selfDir = path.dirname(process.argv[1])
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
fs.writeFileSync(path.join(selfDir, 'whisper-args.log'), JSON.stringify({
  args,
  token: process.env.TELEGRAM_BOT_TOKEN ?? null,
  hasPath: !!process.env.PATH,
}))
const wav = get('-f')
const of = get('-of')
fs.writeFileSync(path.join(selfDir, 'job-dir.txt'), path.dirname(wav ?? of ?? selfDir))
const payload = fs.readFileSync(wav).subarray(44).toString('utf8').split('\\u0000')[0]
const line = (k) => { const m = payload.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1] : undefined }
if (payload.includes('HANG')) {
  fs.writeFileSync(path.join(selfDir, 'started'), '')
  fs.writeFileSync(path.join(selfDir, 'pid.txt'), String(process.pid))
  setInterval(() => {}, 1000)
} else if (payload.includes('FAIL')) {
  process.stderr.write('fake whisper: model load failed\\n')
  process.exit(3)
} else if (payload.includes('NOOUTPUT')) {
  process.exit(0)
} else {
  const text = line('TEXT') ?? ''
  if (of) fs.writeFileSync(of + '.txt', text)
  if (payload.includes('NOISY')) process.stdout.write('测'.repeat(5000))
  else process.stdout.write(line('STDOUT') ?? '')
  process.stdout.write('\\n')
}
`

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-local-test-'))
  binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  modelPath = path.join(tmpRoot, 'ggml-base.bin')
  fs.writeFileSync(modelPath, 'fake-model-bytes')
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** Write an executable Node script standing in for a real binary. */
function writeFakeBinary(name: string, source: string): string {
  const target = path.join(binDir, name)
  fs.writeFileSync(target, source)
  fs.chmodSync(target, 0o755)
  return target
}

function fakeFfmpeg(): string {
  return writeFakeBinary('fake-ffmpeg', FAKE_FFMPEG)
}

function fakeWhisper(): string {
  return writeFakeBinary('fake-whisper', FAKE_WHISPER)
}

function provider(overrides: Partial<{
  command: string
  model: string
  decodeCommand: string
  prompt: string
  spawnTimeoutMs: number
  maxStdoutBytes: number
  maxTranscriptBytes: number
}> = {}) {
  return new WhisperLocalProvider({
    command: overrides.command ?? fakeWhisper(),
    model: overrides.model ?? modelPath,
    decodeCommand: overrides.decodeCommand ?? fakeFfmpeg(),
    prompt: overrides.prompt,
    spawnTimeoutMs: overrides.spawnTimeoutMs,
    maxStdoutBytes: overrides.maxStdoutBytes,
    maxTranscriptBytes: overrides.maxTranscriptBytes,
  })
}

function readLog<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(binDir, name), 'utf8')) as T
}

function jobDir(): string {
  return fs.readFileSync(path.join(binDir, 'job-dir.txt'), 'utf8')
}

function hangPid(): number {
  return Number(fs.readFileSync(path.join(binDir, 'pid.txt'), 'utf8'))
}

async function waitForHangPid(): Promise<number> {
  await waitUntil(() => fs.existsSync(path.join(binDir, 'pid.txt')), 8000)
  return hangPid()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function audioBuffer(bytes = 'OGGBYTES'): Buffer {
  return Buffer.from(bytes)
}

describe('resolveWhisperBinary', () => {
  it('finds nothing on an empty search path', () => {
    expect(resolveWhisperBinary({ searchPaths: [] })).toBeNull()
  })

  it('probes whisper-cli then whisper-cpp (no generic/Python names)', () => {
    writeFakeBinary('whisper-cli', '#!/usr/bin/env node\n')
    expect(resolveWhisperBinary({ searchPaths: [binDir] })).toBe(path.join(binDir, 'whisper-cli'))
  })

  it('skips occupied names and falls through to the next candidate', () => {
    writeFakeBinary('whisper-cpp', '#!/usr/bin/env node\n')
    expect(resolveWhisperBinary({ searchPaths: [binDir] })).toBe(path.join(binDir, 'whisper-cpp'))
  })

  it('never auto-selects a generic executable named "whisper"', () => {
    // The Python console script is also called `whisper`; only the explicit
    // whisper.cpp names are probed.
    writeFakeBinary('whisper', '#!/usr/bin/env node\n')
    expect(resolveWhisperBinary({ searchPaths: [binDir] })).toBeNull()
  })

  it('an explicit absolute path is used verbatim when executable', () => {
    const bin = writeFakeBinary('my-whisper', '#!/usr/bin/env node\n')
    expect(resolveWhisperBinary({ command: bin, searchPaths: [] })).toBe(bin)
  })

  it('an explicit absolute path that is missing is a miss, no guessing', () => {
    expect(resolveWhisperBinary({ command: path.join(binDir, 'nope'), searchPaths: [binDir] })).toBeNull()
  })

  it('an explicit bare name is searched on the provided paths', () => {
    writeFakeBinary('my-whisper', '#!/usr/bin/env node\n')
    expect(resolveWhisperBinary({ command: 'my-whisper', searchPaths: [binDir] })).toBe(
      path.join(binDir, 'my-whisper'),
    )
    expect(resolveWhisperBinary({ command: 'other', searchPaths: [binDir] })).toBeNull()
  })

  it('a non-executable file with a candidate name is not picked up', () => {
    fs.writeFileSync(path.join(binDir, 'whisper'), 'not executable')
    fs.chmodSync(path.join(binDir, 'whisper'), 0o644)
    expect(resolveWhisperBinary({ searchPaths: [binDir] })).toBeNull()
  })

  it('does not probe a Python "whisper" package, only executables', () => {
    // A `whisper.py` next to the binaries must never be selected.
    fs.writeFileSync(path.join(binDir, 'whisper.py'), '#!/usr/bin/env python\n')
    fs.chmodSync(path.join(binDir, 'whisper.py'), 0o755)
    expect(resolveWhisperBinary({ searchPaths: [binDir] })).toBeNull()
  })
})

describe('resolveDecodeBinary', () => {
  it('defaults to ffmpeg on the search path', () => {
    writeFakeBinary('ffmpeg', '#!/usr/bin/env node\n')
    expect(resolveDecodeBinary({ searchPaths: [binDir] })).toBe(path.join(binDir, 'ffmpeg'))
  })

  it('honors an explicit decodeCommand', () => {
    const bin = writeFakeBinary('my-decoder', '#!/usr/bin/env node\n')
    expect(resolveDecodeBinary({ decodeCommand: bin, searchPaths: [] })).toBe(bin)
  })

  it('is null when nothing is found', () => {
    expect(resolveDecodeBinary({ searchPaths: [] })).toBeNull()
  })
})

describe('WhisperLocalProvider.supported', () => {
  const p = new WhisperLocalProvider()

  it('accepts Telegram voice (audio/ogg) and common decodable formats', () => {
    expect(p.supported('audio/ogg')).toBe(true)
    expect(p.supported('audio/opus')).toBe(true)
    expect(p.supported('audio/mpeg')).toBe(true)
    expect(p.supported('audio/mp3')).toBe(true)
    expect(p.supported('audio/wav')).toBe(true)
    expect(p.supported('audio/x-wav')).toBe(true)
    expect(p.supported('audio/flac')).toBe(true)
    expect(p.supported('audio/webm')).toBe(true)
  })

  it('normalizes case, whitespace and charset parameters', () => {
    expect(p.supported('AUDIO/OGG')).toBe(true)
    expect(p.supported('audio/ogg; charset=binary')).toBe(true)
    expect(p.supported('  audio/ogg  ')).toBe(true)
  })

  it('rejects non-audio payloads', () => {
    expect(p.supported('video/mp4')).toBe(false)
    expect(p.supported('application/octet-stream')).toBe(false)
    expect(p.supported('')).toBe(false)
  })
})

describe('WhisperLocalProvider.transcribe — unavailable paths', () => {
  it('missing engine binary → unavailable, naming the configured path', async () => {
    const requested = path.join(binDir, 'absent')
    const p = provider({ command: requested })
    const result = await p.transcribe({ buffer: audioBuffer(), mimeType: 'audio/ogg' })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    if (!result.ok) {
      expect(result.detail).toContain('whisper executable not found')
      expect(result.detail).toContain(requested)
    }
  })

  it('engine present but model missing → unavailable', async () => {
    const p = provider({ model: path.join(tmpRoot, 'ggml-missing.bin') })
    const result = await p.transcribe({ buffer: audioBuffer(), mimeType: 'audio/ogg' })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    if (!result.ok) expect(result.detail).toContain('model not found')
  })

  it('decoder missing → unavailable', async () => {
    const p = provider({ decodeCommand: path.join(binDir, 'no-ffmpeg') })
    const result = await p.transcribe({ buffer: audioBuffer(), mimeType: 'audio/ogg' })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    if (!result.ok) {
      expect(result.detail).toContain('decoder')
      expect(result.detail).toContain('stt.ffmpegPath')
    }
  })

  it('a pre-aborted signal returns cancelled without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    const p = provider()
    const result = await p.transcribe({
      buffer: audioBuffer(),
      mimeType: 'audio/ogg',
      signal: controller.signal,
    })
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(fs.existsSync(path.join(binDir, 'ffmpeg-args.log'))).toBe(false)
  })
})

describe('WhisperLocalProvider 中文 initial prompt', () => {
  const defaultPrompt = '以下是普通话的简体中文转录。'

  it('默认中文注入提示词，返回引擎原文而不作字典转换或同音字替换', async () => {
    const text = '今天下午3點開會請戴上筆記本'
    const result = await provider().transcribe({ buffer: Buffer.from(`SECONDS=5\nTEXT=${text}`), mimeType: 'audio/ogg' })
    expect(result).toEqual({ ok: true, text, language: 'zh' })
    const args = readLog<{ args: string[] }>('whisper-args.log').args
    expect(args[args.indexOf('--prompt') + 1]).toBe(defaultPrompt)
    expect(args.filter(arg => arg === '--prompt')).toHaveLength(1)
    expect(fs.existsSync(jobDir())).toBe(false)
  })

  it('中文语言别名与空白默认均注入提示词，CLI 语言归一为 zh', async () => {
    const p = provider()
    for (const languageHint of ['zh', 'zh-CN', 'zh-TW', 'ZH', '  ']) {
      const result = await p.transcribe({ buffer: Buffer.from('SECONDS=2\nTEXT=请戴上笔记本。'), mimeType: 'audio/ogg', languageHint })
      expect(result).toEqual({ ok: true, text: '请戴上笔记本。', language: languageHint.trim() || 'zh' })
      const args = readLog<{ args: string[] }>('whisper-args.log').args
      expect(args[args.indexOf('--prompt') + 1]).toBe(defaultPrompt)
      expect(args[args.indexOf('-l') + 1]).toBe('zh')
    }
  })

  it('自定义提示词作为单一 argv 传入，不解释引号或命令', async () => {
    const prompt = '中文转录，保留 ccmax。"; /new $(echo fixture)'
    await provider({ prompt }).transcribe({ buffer: Buffer.from('SECONDS=2\nTEXT=原文'), mimeType: 'audio/ogg' })
    const args = readLog<{ args: string[] }>('whisper-args.log').args
    expect(args[args.indexOf('--prompt') + 1]).toBe(prompt)
    expect(args.filter(arg => arg === '--prompt')).toHaveLength(1)
  })

  it('空白提示词回退到默认值', async () => {
    await provider({ prompt: '  ' }).transcribe({ buffer: Buffer.from('SECONDS=2\nTEXT=原文'), mimeType: 'audio/ogg' })
    const args = readLog<{ args: string[] }>('whisper-args.log').args
    expect(args[args.indexOf('--prompt') + 1]).toBe(defaultPrompt)
  })

  it('非中文与 auto 即使配置了提示词也不注入，保留引擎原文', async () => {
    const p = provider({ prompt: '自定义中文引导' })
    const text = '漢字と図書館，今天開會'
    for (const languageHint of ['ja', 'en', 'auto']) {
      const result = await p.transcribe({ buffer: Buffer.from(`SECONDS=2\nTEXT=${text}`), mimeType: 'audio/ogg', languageHint })
      expect(result).toEqual({ ok: true, text, language: languageHint })
      expect(readLog<{ args: string[] }>('whisper-args.log').args).not.toContain('--prompt')
    }
  })

  it('共享组装保留引擎文字、caption 和普通音频行为', async () => {
    const text = '請戴上筆記本，不要刪除。'
    const bytes = Buffer.from(`SECONDS=2\nTEXT=${text}`)
    const voice: LocalAttachment = {
      kind: 'file', mediaKind: 'voice', name: 'voice.ogg', path: '/fixture/voice.ogg',
      size: bytes.length, mimeType: 'audio/ogg', buffer: bytes,
    }
    const caption = '原始文字：開會 /new'
    const result = await enrichAndAssemble([voice], caption, { transcriber: provider(), languageHint: 'zh' })
    expect(result.transcripts).toEqual([{ name: 'voice.ogg', text, language: 'zh' }])
    expect(result.text).toContain(caption)
    expect(result.text).toContain(text)
    expect(result.attachments).toEqual([])
    const ordinary = await enrichAndAssemble([{ ...voice, mediaKind: undefined }], caption, { transcriber: provider(), languageHint: 'zh' })
    expect(ordinary.transcripts).toEqual([])
    expect(ordinary.text).toBe(caption)
    expect(ordinary.attachments).toHaveLength(1)
  })
})

describe('WhisperLocalProvider.transcribe — decode and duration gates', () => {
  it('an undecodable input is invalid_audio and never reaches the engine', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('NOTAUDIO'),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_audio' })
    expect(fs.existsSync(path.join(binDir, 'whisper-args.log'))).toBe(false)
  })

  it('caps the decode at maxDurationSeconds + 1 so a long input is never fully decoded', async () => {
    const p = provider()
    await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=x'),
      mimeType: 'audio/ogg',
      maxDurationSeconds: 300,
    })
    const args = readLog<string[]>('ffmpeg-args.log')
    const tIndex = args.indexOf('-t')
    expect(tIndex).toBeGreaterThanOrEqual(0)
    // The deliberate +1 second: a too-long input still measures over the
    // limit and is rejected, never truncated into a "successful" short clip.
    expect(args[tIndex + 1]).toBe('301')
  })

  it('rejects an audio longer than maxDurationSeconds as too_long, without spawning the engine', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=4\nTEXT=unused'),
      mimeType: 'audio/ogg',
      maxDurationSeconds: 3,
    })
    expect(result).toMatchObject({ ok: false, reason: 'too_long' })
    expect(fs.existsSync(path.join(binDir, 'whisper-args.log'))).toBe(false)
  })

  it('rejects a header that claims 12s but carries no data bytes as invalid_audio', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('HDRONLY\nTEXT=unused'),
      mimeType: 'audio/ogg',
      maxDurationSeconds: 300,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_audio' })
    if (!result.ok) expect(result.detail).toContain('no usable WAV data')
    expect(fs.existsSync(path.join(binDir, 'whisper-args.log'))).toBe(false)
  })

  it('accepts audio exactly at the ceiling', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=3\nTEXT=边界内'),
      mimeType: 'audio/ogg',
      maxDurationSeconds: 3,
    })
    expect(result).toEqual({ ok: true, text: '边界内', language: 'zh' })
  })

  it('honors a caller-supplied smaller ceiling (no independent policy value)', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=20\nTEXT=unused'),
      mimeType: 'audio/ogg',
      maxDurationSeconds: 10,
    })
    expect(result).toMatchObject({ ok: false, reason: 'too_long' })
  })

  it('falls back to the default ceiling for a non-positive/non-finite value', async () => {
    const p = provider()
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await p.transcribe({
        buffer: Buffer.from('SECONDS=2\nTEXT=回退'),
        mimeType: 'audio/ogg',
        maxDurationSeconds: bad,
      })
      expect(result).toEqual({ ok: true, text: '回退', language: 'zh' })
      const args = readLog<string[]>('ffmpeg-args.log')
      expect(args[args.indexOf('-t') + 1]).toBe('301')
    }
  })
})

describe('WhisperLocalProvider.transcribe — engine invocation', () => {
  it('normalizes through the decoder to 16k mono PCM WAV', async () => {
    const p = provider()
    await p.transcribe({ buffer: Buffer.from('SECONDS=2\nTEXT=x'), mimeType: 'audio/ogg' })
    const args = readLog<string[]>('ffmpeg-args.log')
    expect(args).toContain('-ar')
    expect(args).toContain('16000')
    expect(args).toContain('-ac')
    expect(args).toContain('1')
    expect(args).toContain('pcm_s16le')
    expect(args).toContain('wav')
  })

  it('reads the transcript from the -otxt output file, not from stdout', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=今天发布推迟到周五\nSTDOUT=SHOULD-NOT-APPEAR'),
      mimeType: 'audio/ogg',
    })
    expect(result).toEqual({ ok: true, text: '今天发布推迟到周五', language: 'zh' })
    const log = readLog<{ args: string[] }>('whisper-args.log')
    expect(log.args).toContain('-otxt')
    expect(log.args).toContain('-of')
    expect(log.args).toContain('-nt')
    expect(log.args).toContain('-l')
    expect(log.args).toContain('zh')
    expect(log.args).toContain(modelPath)
  })

  it('forwards an explicit language hint', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=hello'),
      mimeType: 'audio/ogg',
      languageHint: 'en',
    })
    expect(result).toEqual({ ok: true, text: 'hello', language: 'en' })
    const log = readLog<{ args: string[] }>('whisper-args.log')
    expect(log.args[log.args.indexOf('-l') + 1]).toBe('en')
  })

  it('reads multi-byte UTF-8 output correctly', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=你好，世界🌍——中文标点，「引号」'),
      mimeType: 'audio/ogg',
    })
    expect(result).toEqual({ ok: true, text: '你好，世界🌍——中文标点，「引号」', language: 'zh' })
  })

  it('does not leak provider secrets into the child, keeps PATH', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'super-secret'
    try {
      const p = provider()
      await p.transcribe({ buffer: Buffer.from('SECONDS=1\nTEXT=x'), mimeType: 'audio/ogg' })
      const log = readLog<{ token: string | null; hasPath: boolean }>('whisper-args.log')
      expect(log.token).toBeNull()
      expect(log.hasPath).toBe(true)
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN
    }
  })

  it('fails with invalid_audio when the engine writes no output file', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nNOOUTPUT'),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_audio' })
    if (!result.ok) expect(result.detail).toContain('no transcript file')
  })

  it('fails with invalid_audio on an empty transcript (no hallucination)', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT='),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_audio' })
    if (!result.ok) expect(result.detail).toContain('empty transcript')
  })

  it('a non-zero engine exit is a provider_error with stderr detail', async () => {
    const p = provider()
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nFAIL'),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'provider_error' })
    if (!result.ok) expect(result.detail).toContain('model load failed')
  })

  it('the stdout capture limit is a real hard boundary', async () => {
    const p = provider({ maxStdoutBytes: 1024 })
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=ok\nNOISY'),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'provider_error' })
    if (!result.ok) expect(result.detail).toContain('stdout')
  })

  it('refuses an oversized transcript file before reading it', async () => {
    const p = provider({ maxTranscriptBytes: 32 })
    const result = await p.transcribe({
      buffer: Buffer.from(`SECONDS=1\nTEXT=${'x'.repeat(200)}`),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'provider_error' })
    if (!result.ok) expect(result.detail).toContain('transcript output exceeded 32 bytes')
  })

  it('refuses an English-only model for a Chinese request, without spawning', async () => {
    const enModel = path.join(tmpRoot, 'ggml-base.en.bin')
    fs.writeFileSync(enModel, 'fake-en-model')
    const p = provider({ model: enModel })
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=unused'),
      mimeType: 'audio/ogg',
      languageHint: 'zh',
    })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    if (!result.ok) expect(result.detail).toContain('English-only')
    expect(fs.existsSync(path.join(binDir, 'ffmpeg-args.log'))).toBe(false)
  })

  it('still allows an English-only model for an English request', async () => {
    const enModel = path.join(tmpRoot, 'ggml-base.en.bin')
    fs.writeFileSync(enModel, 'fake-en-model')
    const p = provider({ model: enModel })
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nTEXT=hello'),
      mimeType: 'audio/ogg',
      languageHint: 'en',
    })
    expect(result).toEqual({ ok: true, text: 'hello', language: 'en' })
  })

  it('removes the private per-job temp dir after success', async () => {
    const p = provider()
    await p.transcribe({ buffer: Buffer.from('SECONDS=1\nTEXT=x'), mimeType: 'audio/ogg' })
    const dir = jobDir()
    expect(dir.startsWith(os.tmpdir())).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })
})

describe.skipIf(isWindows)('WhisperLocalProvider.transcribe — cancellation (POSIX)', () => {
  it('an external abort terminates the engine and cleans up', async () => {
    const p = provider()
    const controller = new AbortController()
    const pending = p.transcribe({
      buffer: Buffer.from('SECONDS=1\nHANG\nTEXT=never'),
      mimeType: 'audio/ogg',
      signal: controller.signal,
    })
    // Wait for the engine to actually start, then abort.
    await waitUntil(() => fs.existsSync(path.join(binDir, 'started')), 2000)
    const pid = await waitForHangPid()
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(fs.existsSync(jobDir())).toBe(false)
    // The child process itself is gone — not merely abandoned.
    await waitUntil(() => !isAlive(pid), 3000)
  })

  it('aborting during decode cancels and cleans up, and never spawns the engine', async () => {
    const p = provider()
    const controller = new AbortController()
    const pending = p.transcribe({
      buffer: Buffer.from('HANGDECODE'),
      mimeType: 'audio/ogg',
      signal: controller.signal,
    })
    await waitUntil(() => fs.existsSync(path.join(binDir, 'ffmpeg-args.log')), 8000)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(fs.existsSync(path.join(binDir, 'whisper-args.log'))).toBe(false)
  })

  it('an abort observed right after decode returns cancelled without a second spawn', async () => {
    const p = provider()
    const controller = new AbortController()
    const pending = p.transcribe({
      buffer: Buffer.from('SLOWEXIT\nTEXT=never'),
      mimeType: 'audio/ogg',
      signal: controller.signal,
    })
    // The decoder has already written its WAV but its process has not closed;
    // aborting here must resolve cancelled and must not start the engine.
    await waitUntil(() => fs.existsSync(path.join(binDir, 'decoded.txt')), 8000)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(fs.existsSync(path.join(binDir, 'whisper-args.log'))).toBe(false)
  })

  it('the provider spawn timeout kills a hung engine', async () => {
    // The timeout must be generous enough that the decode pass and the
    // engine's own startup complete before the kill, even under load.
    const p = provider({ spawnTimeoutMs: 3000 })
    const result = await p.transcribe({
      buffer: Buffer.from('SECONDS=1\nHANG\nTEXT=never'),
      mimeType: 'audio/ogg',
    })
    expect(result).toMatchObject({ ok: false, reason: 'provider_error' })
    if (!result.ok) expect(result.detail).toContain('whisper timed out')
    const pid = await waitForHangPid()
    await waitUntil(() => !isAlive(pid), 3000)
    expect(fs.existsSync(jobDir())).toBe(false)
  })
})

describe('defaultWhisperModelPath', () => {
  it('lives under the adapter config dir and honors CLAUDE_CONFIG_DIR', () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpRoot, 'cfg')
      expect(defaultWhisperModelPath()).toBe(path.join(tmpRoot, 'cfg', 'whisper', 'ggml-base.bin'))
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })
})

describe('pipeline integration: whisper-local through enrichAndAssemble', () => {
  function stageVoice(): LocalAttachment {
    const target = path.join(tmpRoot, 'voice-pipe.ogg')
    fs.writeFileSync(target, 'OGGPIPE')
    return {
      kind: 'file',
      name: 'voice-pipe.ogg',
      path: target,
      size: 7,
      mimeType: 'audio/ogg',
      buffer: Buffer.from('SECONDS=1\nTEXT=管道集成成功'),
      mediaKind: 'voice',
    }
  }

  it('engine unavailable: voice stays a file ref with a notice', async () => {
    const p = provider({ command: path.join(binDir, 'absent') })
    const { text, attachments, notices } = await enrichAndAssemble([stageVoice()], '正文', {
      transcriber: p,
    })
    expect(text).toBe('正文')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.type).toBe('file')
    expect(attachments[0]?.name).toBe('voice-pipe.ogg')
    expect(notices).toEqual(['🎧 语音转写引擎不可用，「voice-pipe.ogg」已作为文件转交'])
  })

  it('a long voice is rejected by the pipeline before the engine runs', async () => {
    const p = provider()
    const long = { ...stageVoice(), durationSeconds: 400 }
    const { notices } = await enrichAndAssemble([long], '正文', { transcriber: p })
    expect(notices).toEqual(['🎧 语音过长已跳过转写，「voice-pipe.ogg」已作为文件转交'])
    expect(fs.existsSync(path.join(binDir, 'ffmpeg-args.log'))).toBe(false)
  })

  it('success: transcript merges into text with a plain-text receipt', async () => {
    const p = provider()
    const { text, attachments, notices, transcripts, cancelled } = await enrichAndAssemble(
      [stageVoice()],
      '',
      { transcriber: p },
    )
    expect(text).toBe('🎤 语音转写（voice-pipe.ogg）：\n管道集成成功')
    expect(attachments).toEqual([])
    expect(notices).toEqual(['📝 语音转写「voice-pipe.ogg」：管道集成成功'])
    expect(transcripts).toEqual([{ name: 'voice-pipe.ogg', text: '管道集成成功', language: 'zh' }])
    expect(cancelled).toBe(false)
  })

  it('pipeline timeout aborts the hung engine (real child kill, not a race)', async () => {
    const p = provider()
    const hanging = { ...stageVoice(), buffer: Buffer.from('SECONDS=1\nHANG\nTEXT=never') }
    const { text, notices } = await enrichAndAssemble([hanging], '正文', {
      transcriber: p,
      transcribeTimeoutMs: 3000,
    })
    expect(text).toBe('正文')
    expect(notices).toEqual(['🎧 语音转写超时，「voice-pipe.ogg」已作为文件转交'])
    const pid = await waitForHangPid()
    await waitUntil(() => !isAlive(pid), 3000)
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}