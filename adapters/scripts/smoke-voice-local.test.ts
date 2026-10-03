import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILE_MAX_BYTES } from '../common/attachment/attachment-limits.js'
import { parseSmokeVoiceArgs, runSmokeVoice, type SmokeVoiceArgs } from './smoke-voice-local.js'

// These tests prove the explicit smoke tool contract, not real audio recognition.
const cli = fileURLToPath(new URL('./smoke-voice-local.ts', import.meta.url))
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'] as const
let directory: string
let args: SmokeVoiceArgs
let savedEnv: Array<string | undefined>

function argv(value = args): string[] {
  return ['--file', value.file, '--whisper', value.whisper, '--ffmpeg', value.ffmpeg, '--model', value.model]
}

function binary(name: string, source: string): string {
  const file = join(directory, name)
  writeFileSync(file, `#!/usr/bin/env node\n${source}`)
  chmodSync(file, 0o755)
  return file
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'voice-smoke-tool-'))
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) process.env[key] = directory
  mkdirSync(join(directory, 'user-config'))
  const configFile = join(directory, 'user-config', 'adapters.json')
  writeFileSync(configFile, '{"stt":{"provider":"should-not-be-read"}}')
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'user-config')
  const file = join(directory, 'fixture.ogg')
  writeFileSync(file, 'fake-audio-bytes')
  const model = join(directory, 'model.bin')
  writeFileSync(model, 'fake-model')
  const ffmpeg = binary('fake-ffmpeg', `
const fs = require('node:fs')
const args = process.argv.slice(2)
const wav = Buffer.alloc(44 + 32000)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVE', 8)
wav.write('fmt ', 12)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(32000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(32000, 40)
fs.writeFileSync(args[args.length - 1], wav)
`)
  const whisper = binary('fake-whisper', `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const out = args[args.indexOf('-of') + 1]
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'job.txt'), path.dirname(out))
fs.writeFileSync(out + '.txt', '不要删除文件，数量是 17。')
`)
  args = { file, model, ffmpeg, whisper, language: 'zh' }
})

afterEach(() => {
  for (const [index, key] of envKeys.entries()) {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  }
  rmSync(directory, { recursive: true, force: true })
})

describe('explicit local voice smoke arguments', () => {
  it('requires every path and rejects unknown options', () => {
    for (let index = 0; index < 8; index += 2) {
      const values = argv()
      values.splice(index, 2)
      expect(parseSmokeVoiceArgs(values).ok).toBe(false)
    }
    expect(parseSmokeVoiceArgs([...argv(), '--download']).ok).toBe(false)
  })

  it('rejects relative paths and defaults to Chinese', () => {
    for (const key of ['file', 'whisper', 'ffmpeg', 'model'] as const) {
      expect(parseSmokeVoiceArgs(argv({ ...args, [key]: 'relative-path' })).ok).toBe(false)
    }
    expect(parseSmokeVoiceArgs(argv())).toEqual({ ok: true, value: args })
    expect(parseSmokeVoiceArgs([...argv(), '--language', 'en'])).toEqual({ ok: true, value: { ...args, language: 'en' } })
  })

  it('exits nonzero with JSON when arguments are missing without spawning binaries', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', cli], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: directory, TMPDIR: directory },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const report = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(1)
    expect(report).toMatchObject({ ok: false, reason: 'missing --file' })
    expect(existsSync(join(directory, 'job.txt'))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('voice smoke fake-program process contract (POSIX script fixtures)', () => {
  it('uses explicit programs, preserves text and cleans private processing files', async () => {
    const report = await runSmokeVoice(args)
    expect(report.ok).toBe(true)
    expect(report.cancelled).toBe(false)
    expect(report.ms).toBeGreaterThanOrEqual(0)
    expect(report.transcripts?.[0]?.text).toBe('不要删除文件，数量是 17。')
    expect(report.text).toContain('不要删除文件，数量是 17。')
    expect(report.attachments).toBeUndefined()
    expect(existsSync(readFileSync(join(directory, 'job.txt'), 'utf8'))).toBe(false)
    expect(readFileSync(join(directory, 'user-config', 'adapters.json'), 'utf8')).toBe('{"stt":{"provider":"should-not-be-read"}}')
    expect(readFileSync(args.file, 'utf8')).toBe('fake-audio-bytes')
  })

  it('reports degradation and exits nonzero instead of pretending to recognize', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...argv({ ...args, whisper: join(directory, 'missing-engine') })], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: directory, TMPDIR: directory },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const report = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.attachments).toHaveLength(1)
    expect(report.transcripts).toEqual([])
    expect(existsSync(join(directory, 'job.txt'))).toBe(false)
  })

  it('rejects oversize and missing input before running local programs', async () => {
    truncateSync(args.file, FILE_MAX_BYTES + 1)
    expect((await runSmokeVoice(args)).reason).toContain('exceeds')
    expect((await runSmokeVoice({ ...args, file: join(directory, 'missing.ogg') })).ok).toBe(false)
    expect((await runSmokeVoice({ ...args, file: dirname(args.file) })).reason).toContain('not a file')
    expect(existsSync(join(directory, 'job.txt'))).toBe(false)
  })

  it('honors cancellation without reading default user configuration', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await runSmokeVoice(args, controller.signal)).toMatchObject({ ok: false, cancelled: true, reason: 'cancelled' })
    expect(existsSync(join(directory, 'job.txt'))).toBe(false)
  })
})