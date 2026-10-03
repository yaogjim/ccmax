import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * OS-signal shutdown evidence for Telegram voice (plan B4).
 *
 * Parent: bun:test. Child: this file spawned as a script with
 * CC_TG_SHUTDOWN_RUNNER=1, so Bun does not scan a fixture as a test.
 *
 * Child imports the real telegram entry, stubs only bot.start (no public
 * getUpdates), intercepts grammY API + file fetch, then
 * startTelegramAdapter() registers SIGINT/SIGTERM. A voice update drives the
 * real WhisperLocalProvider; fake CLI/FFmpeg hang and write PID + jobDir.
 * Parent waits for that ready sentinel, signals the adapter PID, and checks
 * process/file/WS outcomes. Not a helper-return mock.
 */

const RUNNER = process.env.CC_TG_SHUTDOWN_RUNNER === '1'
const SELF = fileURLToPath(import.meta.url)
const CHAT_ID = 770
const SESSION_ID = 'voice-session'
const TEST_BUDGET_MS = 15_000
const READY_WAIT_MS = 8_000
const EXIT_WAIT_MS = 6_000

const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const input = get('-i')
const out = args[args.length - 1]
const raw = fs.readFileSync(input)
const m = raw.toString('utf8').match(/^SECONDS=([0-9.]+)$/m)
const seconds = m ? Number(m[1]) : 1
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
const dataSize = Math.max(2, Math.round(seconds * 32000))
header.writeUInt32LE(dataSize, 40)
header.writeUInt32LE(36 + dataSize, 4)
fs.writeFileSync(out, Buffer.concat([header, raw, Buffer.alloc(Math.max(0, dataSize - raw.length))]))
`

const FAKE_WHISPER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const selfDir = path.dirname(process.argv[1])
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const wav = get('-f')
const of = get('-of')
fs.writeFileSync(path.join(selfDir, 'job-dir.txt'), path.dirname(wav ?? of ?? selfDir))
const payload = fs.readFileSync(wav).subarray(44).toString('utf8').split('\\0')[0]
if (payload.includes('HANG')) {
  fs.writeFileSync(path.join(selfDir, 'pid.txt'), String(process.pid))
  setInterval(() => {}, 1000)
} else {
  const ofPath = get('-of')
  if (ofPath) fs.writeFileSync(ofPath + '.txt', 'should-not-finish')
  process.exit(0)
}
`

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPid(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return
  try { process.kill(pid, signal) } catch { /* already gone */ }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal) } catch { /* not a group leader / already gone */ }
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function writeFakeBinary(dir: string, name: string, source: string): string {
  const target = join(dir, name)
  writeFileSync(target, source)
  chmodSync(target, 0o755)
  return target
}

type ReadyPayload = { pid: number; whisperPid: number; jobDir: string }

async function runAdapterChild(): Promise<void> {
  const binDir = process.env.CC_TG_SHUTDOWN_BIN
  const readyPath = process.env.CC_TG_SHUTDOWN_READY
  const echoPath = process.env.CC_TG_SHUTDOWN_ECHO
  if (!binDir || !readyPath || !echoPath) {
    console.error('[tg-shutdown-runner] missing CC_TG_SHUTDOWN_* paths')
    process.exit(2)
  }

  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.includes('/file/bot')) {
      return new Response(Buffer.from('SECONDS=1\nHANG\n'), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      })
    }
    if (url.includes('api.telegram.org')) {
      return new Response('blocked-public-telegram', { status: 599 })
    }
    return previousFetch(input, init)
  }) as typeof fetch

  const entry = await import('../index.js') as typeof import('../index.js')
  const botInfo = {
    id: 12345,
    is_bot: true as const,
    first_name: 'Fixture',
    username: 'fixture_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_manage_bots: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  }
  entry.bot.botInfo = botInfo
  entry.bot.api.config.use(async (_previous, method, payload) => {
    const text = (payload as { text?: string }).text
    if (method === 'sendMessage' && text) appendFileSync(echoPath, `${text}\n`)
    const result = method === 'getFile'
      ? {
          file_id: (payload as { file_id: string }).file_id,
          file_unique_id: 'uniq',
          file_path: 'voice/file.ogg',
          file_size: 18,
        }
      : method === 'getMe'
        ? botInfo
        : ['answerCallbackQuery', 'deleteMessage', 'setMyCommands'].includes(method)
          ? true
          : {
              message_id: 1,
              date: 1,
              chat: { id: (payload as { chat_id?: number }).chat_id ?? CHAT_ID, type: 'private' },
              text,
            }
    return { ok: true, result } as any
  })
  entry.bot.start = (async (options?: { onStart?: (info: typeof botInfo) => unknown }) => {
    await options?.onStart?.(botInfo)
  }) as typeof entry.bot.start

  entry.startTelegramAdapter()

  void entry.bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: CHAT_ID, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Fixture' },
      voice: {
        file_id: 'hang-fid',
        file_unique_id: 'uniq-hang-fid',
        duration: 12,
        mime_type: 'audio/ogg',
      },
    },
  } as any)

  const pidFile = join(binDir, 'pid.txt')
  const jobFile = join(binDir, 'job-dir.txt')
  const deadline = Date.now() + READY_WAIT_MS
  while (!existsSync(pidFile) || !existsSync(jobFile)) {
    if (Date.now() >= deadline) {
      console.error('[tg-shutdown-runner] fake whisper did not hang in time')
      process.exit(2)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const whisperPid = Number(readFileSync(pidFile, 'utf8'))
  const jobDir = readFileSync(jobFile, 'utf8').trim()
  writeFileSync(readyPath, JSON.stringify({
    pid: process.pid,
    whisperPid,
    jobDir,
  } satisfies ReadyPayload))
  await new Promise(() => {})
}

if (RUNNER) {
  await runAdapterChild()
} else {
  // POSIX signal delivery and executable script fixtures are tested on macOS/Linux.
  describe.skipIf(process.platform === 'win32')('Telegram adapter OS signal shutdown during local transcription', () => {
    it.each(['SIGINT', 'SIGTERM'] as const)(
      'kills the hanging whisper child on %s without delivering or echoing',
      async (signal) => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tg-voice-shutdown-')))
        const project = join(directory, 'repo')
        const binDir = join(directory, 'bin')
        mkdirSync(project)
        mkdirSync(binDir)
        const ffmpegPath = writeFakeBinary(binDir, 'fake-ffmpeg', FAKE_FFMPEG)
        const whisperPath = writeFakeBinary(binDir, 'fake-whisper', FAKE_WHISPER)
        const modelPath = join(directory, 'ggml-base.bin')
        writeFileSync(modelPath, 'fake-model-bytes')
        writeFileSync(join(directory, 'adapters.json'), JSON.stringify({
          telegram: {
            botToken: '12345:fixture-token',
            allowedUsers: [7],
            defaultWorkDir: project,
            allowedProjectRoots: [directory],
          },
          stt: {
            provider: 'whisper-local',
            whisperPath,
            ffmpegPath,
            whisperModel: modelPath,
            language: 'zh',
          },
        }))
        writeFileSync(join(directory, 'adapter-sessions.json'), JSON.stringify({
          [String(CHAT_ID)]: { sessionId: SESSION_ID, workDir: project, updatedAt: 1 },
        }))

        const wsMessages: Array<{ sessionId: string; message: { type?: string; content?: string } }> = []
        const readyPath = join(directory, 'ready.json')
        const echoPath = join(directory, 'echo.log')
        writeFileSync(echoPath, '')

        const server = Bun.serve<{ sessionId: string }>({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request, server) {
            const url = new URL(request.url)
            if (url.pathname.startsWith('/ws/')) {
              if (server.upgrade(request, { data: { sessionId: url.pathname.split('/')[2]! } })) return
              return new Response('upgrade failed', { status: 400 })
            }
            if (url.pathname === `/api/sessions/${SESSION_ID}`) {
              return Response.json({ workDir: project, repoName: 'repo', branch: 'main' })
            }
            if (url.pathname === '/api/sessions') {
              return Response.json({
                sessions: [{
                  id: SESSION_ID,
                  title: 'voice',
                  createdAt: '2026-01-01',
                  modifiedAt: '2026-06-03',
                  workDir: project,
                  projectRoot: project,
                  projectPath: '-fixture-repo',
                  workDirExists: true,
                  messageCount: 1,
                }],
                total: 1,
              })
            }
            if (url.pathname === '/api/models/current') return Response.json({ model: { id: 'fixture-model' } })
            if (url.pathname === '/api/tasks') return Response.json({ tasks: [] })
            return new Response('Unexpected fixture endpoint', { status: 404 })
          },
          websocket: {
            open(socket) {
              socket.send(JSON.stringify({ type: 'connected' }))
            },
            message(socket, raw) {
              wsMessages.push({ sessionId: socket.data.sessionId, message: JSON.parse(String(raw)) })
            },
            close() {},
          },
        })

        let child: ReturnType<typeof Bun.spawn> | undefined
        let whisperPid = 0
        let jobDir = ''
        try {
          const processChild = Bun.spawn([process.execPath, '--no-env-file', SELF], {
            cwd: directory,
            stdout: 'ignore',
            stderr: 'pipe',
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: directory,
              TMPDIR: directory,
              CLAUDE_CONFIG_DIR: directory,
              TELEGRAM_BOT_TOKEN: '12345:fixture-token',
              ADAPTER_SERVER_URL: `ws://127.0.0.1:${server.port}`,
              ADAPTER_ALLOWED_PROJECT_ROOTS: directory,
              ADAPTER_DEFAULT_PROJECT_DIR: project,
              CLAUDE_ADAPTER_DEFAULT_WORK_DIR: project,
              CC_HAHA_LOCAL_ACCESS_TOKEN: 'fixture-local-token',
              CC_STT_PROVIDER: 'whisper-local',
              CC_STT_WHISPER_PATH: whisperPath,
              CC_STT_FFMPEG_PATH: ffmpegPath,
              CC_STT_WHISPER_MODEL: modelPath,
              CC_TG_SHUTDOWN_RUNNER: '1',
              CC_TG_SHUTDOWN_READY: readyPath,
              CC_TG_SHUTDOWN_BIN: binDir,
              CC_TG_SHUTDOWN_ECHO: echoPath,
            },
          })

          child = processChild
          await waitUntil(() => existsSync(readyPath) || processChild.exitCode !== null, READY_WAIT_MS, 'ready sentinel')
          if (!existsSync(readyPath)) {
            const stderr = await new Response(processChild.stderr).text()
            throw new Error(`adapter exited ${child.exitCode} before ready\n${stderr}`)
          }
          const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as ReadyPayload
          whisperPid = ready.whisperPid
          jobDir = ready.jobDir
          expect(isAlive(whisperPid)).toBe(true)
          expect(existsSync(jobDir)).toBe(true)
          expect(child.pid).toBeGreaterThan(0)

          child.kill(signal)
          let exitTimedOut = false
          const exitTimer = setTimeout(() => {
            exitTimedOut = true
            killPid(processChild.pid)
          }, EXIT_WAIT_MS)
          const exitCode = await child.exited
          clearTimeout(exitTimer)
          expect(exitTimedOut).toBe(false)
          expect(exitCode).toBe(0)
          expect(isAlive(whisperPid)).toBe(false)
          expect(existsSync(jobDir)).toBe(false)
          expect(wsMessages.filter((item) => item.message.type === 'user_message')).toEqual([])
          const echo = existsSync(echoPath) ? readFileSync(echoPath, 'utf8') : ''
          expect(echo).not.toContain('🎤 语音转写')
          expect(echo).not.toContain('已作为文件转交')
          expect(echo).not.toContain('should-not-finish')
        } finally {
          if (child && child.exitCode === null) killPid(child.pid)
          if (!whisperPid && existsSync(join(binDir, 'pid.txt'))) {
            whisperPid = Number(readFileSync(join(binDir, 'pid.txt'), 'utf8'))
          }
          killPid(whisperPid)
          if (child) await child.exited
          await server.stop(true)
          rmSync(directory, { recursive: true, force: true })
        }
      },
      TEST_BUDGET_MS,
    )
  })
}