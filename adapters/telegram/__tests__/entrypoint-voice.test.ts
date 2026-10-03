import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { SessionStore } from '../../common/session-store.js'
import { WsBridge } from '../../common/ws-bridge.js'
import { FakeTranscriptionProvider } from '../../common/attachment/transcribe/fake.js'
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../../common/attachment/transcribe/types.js'
import { setTelegramTranscriber } from '../inbound.js'

/**
 * A provider whose transcription only settles when the test says so (or when
 * the caller's signal aborts). `FakeTranscriptionProvider` is scripted ahead of
 * time; ordering, cancellation and shutdown assertions need to decide *while*
 * a transcription is in flight.
 */
class ControllableTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'controllable'
  readonly calls: TranscriptionInput[] = []
  /**
   * When set, a cancellation waits for this promise before settling — the
   * deterministic stand-in for a provider whose detached child-process kill
   * and async temp-file removal must finish before the call resolves. Shutdown
   * must await that cleanup, not race it.
   */
  cleanupGate: Promise<void> | undefined
  private readonly waiting: Array<(result: TranscriptionResult) => void> = []
  private abortedCount = 0

  /** How many calls were killed through the caller's AbortSignal. */
  get aborted(): number {
    return this.abortedCount
  }

  supported(): boolean {
    return true
  }

  transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    this.calls.push(input)
    return new Promise<TranscriptionResult>((resolve) => {
      const signal = input.signal
      const settleCancelled = (): void => {
        this.abortedCount += 1
        if (this.cleanupGate) {
          void this.cleanupGate.then(() => resolve({ ok: false, reason: 'cancelled' }))
        } else {
          resolve({ ok: false, reason: 'cancelled' })
        }
      }
      if (signal?.aborted) {
        settleCancelled()
        return
      }
      signal?.addEventListener('abort', settleCancelled, { once: true })
      this.waiting.push(resolve)
    })
  }

  /** Complete the transcription that is currently in flight. */
  finish(text: string): void {
    const next = this.waiting.shift()
    if (!next) throw new Error('no transcription in flight')
    next({ ok: true, text })
  }
}

/**
 * Module specifier for the entrypoint under test.
 *
 * The query string is what forces bun to evaluate `index.ts` again for this
 * suite instead of handing back the instance another test file already loaded
 * with a different config. It is held in a variable because TypeScript cannot
 * resolve a *literal* specifier with a query string (`TS2307`) — as a
 * non-literal specifier the import stays untyped, which is what the explicit
 * `typeof import('../index.js')` annotation on `entry` is for.
 */
const modulePath = '../index.js?entrypoint-voice-suite'

/**
 * Telegram voice → local transcription → bound session, driven through the
 * *actual* grammY entrypoint with a real loopback WebSocket server standing in
 * for the desktop session. Nothing here is a helper-only test: updates enter
 * through `bot.handleUpdate`, bytes are downloaded through the media service
 * (global fetch is a fixture), and the message the Agent would receive is read
 * off the mock session socket.
 *
 * Isolation: HOME and CLAUDE_CONFIG_DIR point at a fresh temp dir, so no real
 * user config, session store, or download stage is touched.
 */
describe('Telegram entrypoint voice lifecycle', () => {
  const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'TELEGRAM_BOT_TOKEN', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS', 'ADAPTER_DEFAULT_PROJECT_DIR', 'CLAUDE_ADAPTER_DEFAULT_WORK_DIR', 'CC_HAHA_LOCAL_ACCESS_TOKEN', 'CC_STT_PROVIDER']
  const previousEnv = new Map<string, string | undefined>()
  const previousFetch = globalThis.fetch

  let directory: string
  let project: string
  /**
   * Read off the entrypoint module (already loaded inside `beforeAll`, after
   * the temp config dir is in place) instead of a static import: a top-level
   * `import '../index.js'` would run `loadConfig()` against the developer's
   * real `~/.claude` before this file redirects anything.
   */
  let entry: typeof import('../index.js')
  let pendingInputCap: number
  let server: ReturnType<typeof Bun.serve<{ sessionId: string }>>
  let store: SessionStore
  let nextId = 500
  const apiCalls: Array<{ method: string; payload: any; result: any }> = []
  const messages: Array<{ sessionId: string; message: any }> = []
  const sockets = new Map<string, Set<ServerWebSocket<{ sessionId: string }>>>()
  const sessionPaths = new Map<string, string>()
  /**
   * Test-controlled holds. `holdApiCall` freezes one bot-API call (matched on
   * method/payload) and `holdSessionCreation` freezes `POST /api/sessions`, so
   * a test can let a real command land inside the exact window it cares about —
   * e.g. `/clear` while the degrade notice reply is still on the wire.
   */
  let holdApiCall: ((method: string, payload: any) => Promise<void> | undefined) | undefined
  let holdSessionCreation: Promise<void> | undefined
  let sessionCreationStarted = false

  async function eventually(assertion: () => void): Promise<void> {
    const deadline = Date.now() + 2500
    while (true) {
      try { assertion(); return } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  function texts(chatId: number): string[] {
    return apiCalls
      .filter((call) => call.method === 'sendMessage' && call.payload.chat_id === chatId && call.payload.text)
      .map((call) => call.payload.text)
  }

  function getFileCalls(): number {
    return apiCalls.filter((call) => call.method === 'getFile').length
  }

  function getFileCallsFor(fileId: string): number {
    return apiCalls.filter((call) => call.method === 'getFile' && call.payload.file_id === fileId).length
  }

  function voiceMessages(sessionId: string): any[] {
    return messages.filter((item) => item.sessionId === sessionId && item.message.type === 'user_message')
  }

  async function update(message: Record<string, unknown>): Promise<void> {
    await entry.bot.handleUpdate({ update_id: nextId++, message } as any)
  }

  async function text(chatId: number, value: string, userId = 7): Promise<void> {
    await update({
      message_id: nextId++,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Fixture' },
      text: value,
      ...(value.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0].length }] } : {}),
    })
  }

  function voiceUpdate(chatId: number, fileId = 'voice-fid', userId = 7, duration = 12, messageId?: number): Record<string, unknown> {
    return {
      message_id: messageId ?? nextId++,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Fixture' },
      voice: { file_id: fileId, file_unique_id: `uniq-${fileId}`, duration, mime_type: 'audio/ogg' },
    }
  }

  function audioUpdate(chatId: number, fileId = 'audio-fid'): Record<string, unknown> {
    return {
      message_id: nextId++,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Fixture' },
      audio: { file_id: fileId, file_unique_id: `uniq-${fileId}`, file_name: 'song.mp3', mime_type: 'audio/mpeg' },
    }
  }

  async function callback(chatId: number, data: string): Promise<void> {
    await entry.bot.handleUpdate({
      update_id: nextId++,
      callback_query: {
        id: `cb-${nextId++}`,
        data,
        chat_instance: 'fixture',
        from: { id: 7, is_bot: false, first_name: 'Fixture' },
        message: { message_id: 1, date: 1, chat: { id: chatId, type: 'private' }, text: 'fixture menu' },
      },
    } as any)
  }

  function broadcast(sessionId: string, message: unknown): void {
    for (const socket of sockets.get(sessionId) ?? []) socket.send(JSON.stringify(message))
  }

  function writeTelegramAuth(allowedUsers: number[]): void {
    writeFileSync(join(directory, 'adapters.json'), JSON.stringify({
      telegram: { allowedUsers, defaultWorkDir: project, allowedProjectRoots: [directory] },
    }))
  }

  const askUserQuestionInput = {
    questions: [
      {
        question: '选哪个库？',
        header: 'Library',
        options: [
          { label: 'Axios', description: '成熟稳定' },
          { label: 'Fetch', description: '浏览器内置' },
        ],
        multiSelect: false,
      },
    ],
  }

  beforeAll(async () => {
    for (const key of envKeys) previousEnv.set(key, process.env[key])
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'telegram-voice-')))
    project = join(directory, 'repo')
    mkdirSync(project)
    sessionPaths.set('voice-session', project)
    sessionPaths.set('other-session', project)
    server = Bun.serve<{ sessionId: string }>({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.startsWith('/ws/')) {
          if (server.upgrade(request, { data: { sessionId: url.pathname.split('/')[2] } })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/api/sessions/recent-projects') {
          return Response.json({ projects: [{ projectName: 'repo', realPath: project, projectPath: '-fixture-repo', branch: 'main', sessionCount: 1 }] })
        }
        if (url.pathname === '/api/sessions' && request.method === 'POST') {
          sessionCreationStarted = true
          if (holdSessionCreation) await holdSessionCreation
          const body = await request.json() as { workDir: string }
          const sessionId = `created-${nextId++}`
          sessionPaths.set(sessionId, body.workDir)
          return Response.json({ sessionId })
        }
        if (url.pathname === '/api/sessions') {
          const sessions = [
            { id: 'voice-session', title: 'voice', modifiedAt: '2026-06-03' },
            { id: 'other-session', title: 'other', modifiedAt: '2026-06-01' },
          ]
          return Response.json({
            sessions: sessions.map((entry) => ({ ...entry, createdAt: '2026-01-01', workDir: sessionPaths.get(entry.id), projectRoot: project, projectPath: '-fixture-repo', workDirExists: true, messageCount: 1 })),
            total: sessions.length,
          })
        }
        const sessionId = url.pathname.split('/')[3]
        if (sessionPaths.has(sessionId)) return Response.json({ workDir: sessionPaths.get(sessionId), repoName: 'repo', branch: 'main' })
        if (url.pathname === '/api/models/current') return Response.json({ model: { id: 'fixture-model' } })
        if (url.pathname === '/api/tasks') return Response.json({ tasks: [] })
        return new Response('Unexpected fixture endpoint', { status: 404 })
      },
      websocket: {
        open(socket) {
          const peers = sockets.get(socket.data.sessionId) ?? new Set()
          peers.add(socket)
          sockets.set(socket.data.sessionId, peers)
          socket.send(JSON.stringify({ type: 'connected' }))
          socket.send(JSON.stringify({ type: 'permission_requests_snapshot', turnActive: false, toolRequestIds: [], computerUseRequestIds: [] }))
        },
        message(socket, raw) {
          messages.push({ sessionId: socket.data.sessionId, message: JSON.parse(String(raw)) })
        },
        close(socket) { sockets.get(socket.data.sessionId)?.delete(socket) },
      },
    })
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.TELEGRAM_BOT_TOKEN = '12345:fixture-token'
    process.env.ADAPTER_SERVER_URL = `ws://127.0.0.1:${server.port}`
    process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = directory
    process.env.ADAPTER_DEFAULT_PROJECT_DIR = project
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = project
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-token'
    delete process.env.CC_STT_PROVIDER
    writeFileSync(join(directory, 'adapters.json'), JSON.stringify({
      telegram: { allowedUsers: [7], defaultWorkDir: project, allowedProjectRoots: [directory] },
    }))
    store = new SessionStore(join(directory, 'adapter-sessions.json'))

    // Fixture download: intercept only the Telegram file URL and delegate all
    // other requests (the adapter's own API calls) to the real fetch, which
    // reaches the loopback server above.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.includes('/file/bot')) {
        return new Response(Buffer.from('OGG-FIXTURE-BYTES'), { status: 200, headers: { 'content-type': 'audio/ogg' } })
      }
      return previousFetch(input, init)
    }) as typeof fetch

    entry = await import(modulePath) as typeof import('../index.js')
    pendingInputCap = entry.MAX_PENDING_INPUTS_PER_CHAT
    entry.bot.botInfo = { id: 12345, is_bot: true, first_name: 'Fixture', username: 'fixture_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false }
    entry.bot.api.config.use(async (_previous, method, payload) => {
      const result = method === 'getFile'
        ? { file_id: (payload as any).file_id, file_unique_id: 'uniq', file_path: 'voice/file.ogg', file_size: 18 }
        : ['answerCallbackQuery', 'deleteMessage'].includes(method)
          ? true
          : { message_id: nextId++, date: 1, chat: { id: (payload as any).chat_id, type: 'private' }, text: (payload as any).text }
      apiCalls.push({ method, payload, result })
      // Recorded before the hold, so a test can observe the attempt while it is
      // blocked and the entrypoint is still awaiting this call.
      const hold = holdApiCall?.(method, payload)
      if (hold) await hold
      return { ok: true, result } as any
    })
  })

  beforeEach(() => {
    holdApiCall = undefined
    holdSessionCreation = undefined
    sessionCreationStarted = false
  })

  afterAll(async () => {
    await entry?.stopTelegramAdapter()
    setTelegramTranscriber(undefined)
    await server?.stop(true)
    globalThis.fetch = previousFetch
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('downloads only after authorization, transcribes the voice, sends it and echoes the real content', async () => {
    const chatId = 730
    store.set(String(chatId), 'voice-session', project)
    const transcriber = new FakeTranscriptionProvider([{ result: { ok: true, text: '明天上午十点开会' } }])
    setTelegramTranscriber(transcriber)

    const getFileBefore = getFileCalls()
    await update(voiceUpdate(chatId))

    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.content?.includes('voice-uniq-voice-fid.ogg'))).toBe(true))
    const sent = voiceMessages('voice-session').find((item) => item.message.content?.includes('voice-uniq-voice-fid.ogg'))!.message
    expect(sent.content).toBe('🎤 语音转写（voice-uniq-voice-fid.ogg）：\n明天上午十点开会')
    // A fully transcribed voice note is not also attached as a file.
    expect(sent.attachments).toBeUndefined()
    expect(transcriber.calls).toHaveLength(1)
    expect(getFileCalls()).toBe(getFileBefore + 1)

    // The exact outbound content is echoed back as plain text (no parse_mode)
    // so the user can spot a mistranscription.
    const echo = apiCalls.find((call) => call.method === 'sendMessage' && call.payload.text === sent.content)
    expect(echo).toBeDefined()
    expect(echo!.payload.parse_mode).toBeUndefined()
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('never transcribes an ordinary audio file and keeps it as a file reference', async () => {
    const chatId = 731
    store.set(String(chatId), 'voice-session', project)
    const transcriber = new FakeTranscriptionProvider([{ result: { ok: true, text: 'should not run' } }])
    setTelegramTranscriber(transcriber)

    await update(audioUpdate(chatId))

    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.attachments?.[0]?.name === 'song.mp3')).toBe(true))
    const sent = voiceMessages('voice-session').find((item) => item.message.attachments?.[0]?.name === 'song.mp3')!.message
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].type).toBe('file')
    expect(sent.attachments[0].name).toBe('song.mp3')
    // Music is never turned into text, even with a provider configured.
    expect(transcriber.calls).toHaveLength(0)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('does not download media from an unauthorized sender', async () => {
    const chatId = 732
    const beforeDownloads = getFileCalls()
    const beforeMessages = messages.length
    await update(voiceUpdate(chatId, 'unauthorized-fid', 99))
    await eventually(() => expect(texts(chatId).some((value) => value.includes('未授权'))).toBe(true))
    expect(getFileCalls()).toBe(beforeDownloads)
    // Nothing was staged or forwarded for an unauthorized sender.
    expect(messages.length).toBe(beforeMessages)
  })

  it('handles a permission callback while a long transcription still holds the message queue', async () => {
    const chatId = 736
    store.set(String(chatId), 'voice-session', project)
    await text(chatId, 'Open the session')
    broadcast('voice-session', { type: 'permission_request', requestId: 'queue-req', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('queue-req'))).toBe(true))

    const slowProvider = new FakeTranscriptionProvider([
      { result: { ok: true, text: 'unused' }, waitForAbort: true },
    ])
    setTelegramTranscriber(slowProvider)

    // A voice transcription occupies this chat's message queue...
    const pendingVoice = update(voiceUpdate(chatId, 'queue-fid'))
    await eventually(() => expect(slowProvider.calls.length).toBe(1))

    // ...but the permission button still resolves on the control queue.
    await callback(chatId, 'permit:queue-req:yes')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === 'voice-session' &&
      item.message.type === 'permission_response' &&
      item.message.requestId === 'queue-req',
    )).toBe(true))

    await text(chatId, '/stop')
    await pendingVoice
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('lets /stop cancel an in-flight transcription without sending it', async () => {
    const chatId = 733
    store.set(String(chatId), 'voice-session', project)
    // A provider that only settles when its signal aborts: the deterministic
    // stand-in for a long local transcription.
    const slowProvider = new FakeTranscriptionProvider([
      { result: { ok: true, text: 'unused' }, waitForAbort: true },
    ])
    setTelegramTranscriber(slowProvider)

    const before = voiceMessages('voice-session').length
    const pending = update(voiceUpdate(chatId, 'stop-fid'))
    // Wait until the transcription actually started before /stop.
    await eventually(() => expect(slowProvider.calls.length).toBe(1))
    await text(chatId, '/stop')
    await pending

    // /stop cancelled the untranscribed input: nothing reached the Agent.
    expect(voiceMessages('voice-session').length).toBe(before)
    await eventually(() => expect(messages.some((item) => item.sessionId === 'voice-session' && item.message.type === 'stop_generation')).toBe(true))
    // The command handler replies asynchronously (fire-and-forget), so poll.
    await eventually(() => expect(texts(chatId).some((value) => value.includes('已发送停止信号'))).toBe(true))
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('lets /clear invalidate a transcription that has not been sent yet', async () => {
    const chatId = 735
    store.set(String(chatId), 'voice-session', project)
    const slowProvider = new FakeTranscriptionProvider([
      { result: { ok: true, text: 'unused' }, waitForAbort: true },
    ])
    setTelegramTranscriber(slowProvider)

    const before = voiceMessages('voice-session').length
    const pending = update(voiceUpdate(chatId, 'clear-fid'))
    await eventually(() => expect(slowProvider.calls.length).toBe(1))
    await text(chatId, '/clear')
    await pending

    // The late transcript must not be written into the cleared context.
    expect(voiceMessages('voice-session').length).toBe(before)
    await eventually(() => expect(messages.some((item) => item.sessionId === 'voice-session' && item.message.content === '/clear')).toBe(true))
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('degrades to a file reference with a visible notice when transcription is unconfigured', async () => {
    const chatId = 734
    store.set(String(chatId), 'voice-session', project)
    setTelegramTranscriber(undefined)

    await update(voiceUpdate(chatId, 'unconfigured-fid'))

    await eventually(() => expect(texts(chatId).some((value) => value.includes('语音转写未配置'))).toBe(true))
    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.attachments?.[0]?.name === 'voice-uniq-unconfigured-fid.ogg')).toBe(true))
    const sent = voiceMessages('voice-session').find((item) => item.message.attachments?.[0]?.name === 'voice-uniq-unconfigured-fid.ogg')!.message
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].type).toBe('file')
    // The notice before the send states the intent; the handover claim follows
    // only once the file actually rode a successful send.
    const pendingNotice = apiCalls.findIndex((call) => call.payload.text?.includes('将作为文件转交'))
    const claim = apiCalls.findIndex((call) => call.payload.text?.includes('✅ 语音已作为文件转交'))
    expect(pendingNotice).toBeGreaterThanOrEqual(0)
    expect(claim).toBeGreaterThan(pendingNotice)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('drops a voice whose degrade notice was overtaken by /clear and never claims handover', async () => {
    const chatId = 750
    store.set(String(chatId), 'voice-session', project)
    // No provider: this voice degrades to a file reference, so the reply that is
    // on the wire while /clear arrives is a real degrade notice.
    setTelegramTranscriber(undefined)

    let noticeOnTheWire = false
    let releaseNotice!: () => void
    const noticeGate = new Promise<void>((resolve) => { releaseNotice = resolve })
    holdApiCall = async (method, payload) => {
      if (method === 'sendMessage' && payload.text?.includes('语音转写未配置')) {
        noticeOnTheWire = true
        await noticeGate
      }
    }

    const pending = update(voiceUpdate(chatId, 'overtaken-fid'))
    await eventually(() => expect(noticeOnTheWire).toBe(true))
    // /clear lands while the notice reply is still blocked. The cleared binding
    // is the last word: the file must not ride the send that follows.
    await text(chatId, '/clear')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === 'voice-session' && item.message.content === '/clear',
    )).toBe(true))
    releaseNotice()
    await pending
    // Let any late frame (which would be the bug) reach the mock session.
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(messages.filter((item) => JSON.stringify(item.message).includes('overtaken-fid'))).toEqual([])
    expect(texts(chatId).some((value) => value.includes('已作为文件转交'))).toBe(false)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('lets a numeric session pick cancel a voice that is still transcribing', async () => {
    const chatId = 751
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pendingVoice = update(voiceUpdate(chatId, 'pick-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    // The restore list is opened and answered *by number* while the voice is
    // still in flight. The entrypoint knows a list is waiting from the
    // controller's pending picker, so the digits ride the short control queue
    // instead of queueing behind the transcription.
    await text(chatId, '/resume')
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选择要恢复的项目'))).toBe(true))
    await text(chatId, '1')
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选择要恢复的会话'))).toBe(true))
    await text(chatId, '2')

    // Picking a session replaces the binding...
    expect(store.get(String(chatId))?.sessionId).toBe('other-session')
    // ...and the input that was still being transcribed was invalidated.
    expect(provider.aborted).toBe(1)

    await pendingVoice
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(messages.filter((item) => JSON.stringify(item.message).includes('pick-fid'))).toEqual([])
    broadcast('other-session', { type: 'message_complete' })
  })

  it('keeps a message that arrived in the same tick as /new', async () => {
    const chatId = 755
    store.set(String(chatId), 'voice-session', project)
    setTelegramTranscriber(undefined)
    // Both updates enter the entrypoint before either finishes: the `/new` that
    // replaces the binding is received first, so the message received second
    // belongs to the new session and must survive it.
    await Promise.all([text(chatId, '/new'), text(chatId, 'same tick message')])
    const sessionId = store.get(String(chatId))?.sessionId
    expect(sessionId).toStartWith('created-')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === sessionId && item.message.content === 'same tick message',
    )).toBe(true))
    broadcast(sessionId!, { type: 'message_complete' })
  })

  it('delivers a message that arrives while /new is still creating its session', async () => {
    const chatId = 752
    store.set(String(chatId), 'voice-session', project)
    setTelegramTranscriber(undefined)

    // Freeze session creation so `/new` is genuinely mid-operation, then send a
    // message into that window: it belongs to the session `/new` is creating,
    // not to the one it is leaving, and it must not be dropped.
    let releaseCreation!: () => void
    holdSessionCreation = new Promise<void>((resolve) => { releaseCreation = resolve })
    const creating = text(chatId, '/new')
    await eventually(() => expect(sessionCreationStarted).toBe(true))
    const duringNew = text(chatId, 'message received during /new')
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseCreation()
    await Promise.all([creating, duringNew])

    const sessionId = store.get(String(chatId))?.sessionId
    expect(sessionId).toStartWith('created-')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === sessionId && item.message.content === 'message received during /new',
    )).toBe(true))
    broadcast(sessionId!, { type: 'message_complete' })
  })

  it('delivers a voice that arrives while /new is still creating its session', async () => {
    const chatId = 756
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    // Same `/new` window as above, but with the media pipeline behind it: the
    // receive-time invalidation that `/new` performs only covers input received
    // *before* the command, so a voice that lands while the new session is
    // still being created must reach the transcriber and be delivered into
    // that new session instead of being cancelled along with the old binding.
    let releaseCreation!: () => void
    holdSessionCreation = new Promise<void>((resolve) => { releaseCreation = resolve })
    const creating = text(chatId, '/new')
    await eventually(() => expect(sessionCreationStarted).toBe(true))
    const duringNew = update(voiceUpdate(chatId, 'window-creation-fid'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseCreation()
    await creating

    await eventually(() => expect(provider.calls.length).toBe(1))
    expect(provider.aborted).toBe(0)
    provider.finish('窗口期语音')
    await duringNew

    const sessionId = store.get(String(chatId))?.sessionId
    expect(sessionId).toStartWith('created-')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === sessionId
      && item.message.content === '🎤 语音转写（voice-uniq-window-creation-fid.ogg）：\n窗口期语音',
    )).toBe(true))
    broadcast(sessionId!, { type: 'message_complete' })
  })

  it('reports local transcription progress and removes the notice after the outcome', async () => {
    const chatId = 740
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const before = apiCalls.length
    const pending = update(voiceUpdate(chatId, 'progress-fid'))
    await eventually(() => expect(apiCalls.slice(before).some((call) => call.payload.text?.includes('正在本机转写'))).toBe(true))
    const progressId = apiCalls.slice(before).find((call) => call.payload.text?.includes('正在本机转写'))!.result.message_id
    // The progress line is not a result, so it stays until the outcome is known.
    const removed = () => apiCalls.slice(before).some((call) =>
      call.method === 'deleteMessage' && call.payload.message_id === progressId)
    expect(removed()).toBe(false)

    provider.finish('进度用例')
    await pending
    expect(removed()).toBe(true)
    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.content?.includes('进度用例'))).toBe(true))
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('refuses an over-long voice before downloading it and does not claim a file was delivered', async () => {
    const chatId = 741
    store.set(String(chatId), 'voice-session', project)
    setTelegramTranscriber(new FakeTranscriptionProvider([{ result: { ok: true, text: 'never used' } }]))

    const beforeMessages = messages.length
    const beforeGetFile = getFileCallsFor('long-fid')
    await update(voiceUpdate(chatId, 'long-fid', 7, 400))

    // The platform-reported duration is the only trustworthy duration signal,
    // and it is checked before the bytes are pulled.
    expect(getFileCallsFor('long-fid')).toBe(beforeGetFile)
    const notice = texts(chatId).find((value) => value.includes('超过 300 秒'))
    expect(notice).toBeDefined()
    // Nothing was downloaded, so the notice must not claim delivery.
    expect(notice).not.toContain('已作为文件转交')
    expect(messages.length).toBe(beforeMessages)
  })

  it('does not download a duplicate delivery of the same Telegram message', async () => {
    const chatId = 742
    store.set(String(chatId), 'voice-session', project)
    setTelegramTranscriber(new FakeTranscriptionProvider([{ result: { ok: true, text: '只转写一次' } }]))

    const messageId = 90001
    await update(voiceUpdate(chatId, 'dedup-fid', 7, 12, messageId))
    await eventually(() => expect(getFileCallsFor('dedup-fid')).toBe(1))
    await update({ ...voiceUpdate(chatId, 'dedup-fid', 7, 12, messageId), message_id: messageId })

    expect(getFileCallsFor('dedup-fid')).toBe(1)
    await eventually(() => expect(voiceMessages('voice-session').filter((item) => item.message.content?.includes('只转写一次'))).toHaveLength(1))
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('drops a queued second voice and a later text when /stop arrives', async () => {
    const chatId = 743
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const first = update(voiceUpdate(chatId, 'queued-1'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    // The second voice and the text are queued behind the running one: they
    // have not started, and /stop must still reach them.
    const second = update(voiceUpdate(chatId, 'queued-2'))
    const laterText = text(chatId, 'queued text must be dropped')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await text(chatId, '/stop')
    await Promise.all([first, second, laterText])
    // Let any late frame (which would be the bug) reach the mock session.
    await new Promise((resolve) => setTimeout(resolve, 30))

    // /stop reached the transcription that had not finished yet...
    expect(provider.aborted).toBe(1)
    const delivered = messages.map((item) => item.message.content ?? '')
    expect(delivered.filter((content) => content.includes('queued-1'))).toEqual([])
    expect(delivered.filter((content) => content.includes('queued-2'))).toEqual([])
    expect(delivered.filter((content) => content === 'queued text must be dropped')).toEqual([])
    // The queued voice never even reached the download step.
    expect(getFileCallsFor('queued-2')).toBe(0)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('keeps later text behind a slow voice so receive order is preserved', async () => {
    const chatId = 744
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pendingVoice = update(voiceUpdate(chatId, 'order-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))
    const pendingText = text(chatId, 'later text')

    // The text must not overtake the voice that was received first.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(messages.some((item) => item.message.content === 'later text')).toBe(false)

    provider.finish('第一句话')
    await Promise.all([pendingVoice, pendingText])

    await eventually(() => expect(messages.some((item) => item.message.content === 'later text')).toBe(true))
    const voiceIndex = messages.findIndex((item) => item.message.content?.includes('第一句话'))
    const textIndex = messages.findIndex((item) => item.message.content === 'later text')
    expect(voiceIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeGreaterThan(voiceIndex)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('lets /new replace the binding while a transcription is still running', async () => {
    const chatId = 745
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pendingVoice = update(voiceUpdate(chatId, 'new-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    // /new rides the short control queue, so it does not wait for the voice.
    await text(chatId, '/new')
    expect(store.get(String(chatId))?.sessionId).toStartWith('created-')

    await pendingVoice
    // Let any late frame (which would be the bug) reach the mock session.
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The in-flight transcript was invalidated together with the old binding.
    expect(messages.filter((item) => (item.message.content ?? '').includes('new-fid'))).toEqual([])
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('lets a session-selection callback switch the binding while a transcription is still running', async () => {
    const chatId = 746
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pendingVoice = update(voiceUpdate(chatId, 'switch-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    // Every step below must complete while the provider is still blocked: the
    // callback path is the one that used to wait behind the transcription.
    await text(chatId, '/resume')
    await callback(chatId, 'tgsel:resume_project:pick:0')
    await callback(chatId, 'tgsel:resume_session:pick:1')
    expect(store.get(String(chatId))?.sessionId).toBe('other-session')
    // The in-flight transcription was cancelled by the switch itself, not just
    // dropped later by the ownership re-check.
    expect(provider.aborted).toBe(1)

    await pendingVoice
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(messages.filter((item) => (item.message.content ?? '').includes('switch-fid'))).toEqual([])
    broadcast('other-session', { type: 'message_complete' })
  })

  it('全局只同时转写两条，等待容量满时降级，取消后释放并发槽', async () => {
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)
    const chatIds = Array.from({ length: 11 }, (_, index) => 810 + index)
    const pending: Promise<void>[] = []
    try {
      for (const chatId of chatIds) {
        store.set(String(chatId), `limit-session-${chatId}`, project)
        sessionPaths.set(`limit-session-${chatId}`, project)
        pending.push(update(voiceUpdate(chatId, `global-limit-${chatId}`)))
        await eventually(() => expect(getFileCallsFor(`global-limit-${chatId}`)).toBe(1))
        if (chatId < 812) await eventually(() => expect(provider.calls.length).toBe(chatId - 809))
      }
      await eventually(() => expect(texts(820).some((value) => value.includes('转写队列已满'))).toBe(true))
      expect(provider.calls).toHaveLength(2)
      await eventually(() => expect(voiceMessages('limit-session-820')[0]?.message.attachments[0].type).toBe('file'))
    } finally {
      await Promise.all(chatIds.map((chatId) => text(chatId, '/stop')))
      await Promise.all(pending)
    }
    expect(provider.aborted).toBe(2)

    // Cancellation of active jobs and all waiting jobs leaves slots reusable.
    const fresh = new ControllableTranscriptionProvider()
    setTelegramTranscriber(fresh)
    const restarted = chatIds.slice(0, 2).map((chatId) => update(voiceUpdate(chatId, `global-restart-${chatId}`)))
    try {
      await eventually(() => expect(fresh.calls).toHaveLength(2))
    } finally {
      await Promise.all(chatIds.slice(0, 2).map((chatId) => text(chatId, '/stop')))
      await Promise.all(restarted)
    }
  })

  it('refuses new input past the per-chat pending cap instead of queueing without bound', async () => {
    const chatId = 747
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pending: Array<Promise<void>> = []
    for (let index = 0; index <= pendingInputCap; index += 1) {
      pending.push(update(voiceUpdate(chatId, `cap-${index}`)))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(texts(chatId).some((value) => value.includes('待处理消息过多'))).toBe(true)
    // The refused input was never downloaded.
    expect(getFileCallsFor(`cap-${pendingInputCap}`)).toBe(0)
    expect(pendingInputCap).toBeGreaterThan(0)

    await text(chatId, '/stop')
    await Promise.all(pending)
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('creates a session for a chat with no binding and delivers its own transcript into it', async () => {
    const chatId = 748
    // No store entry: this input creates the session it will deliver into, and
    // that must not invalidate the input itself.
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pending = update(voiceUpdate(chatId, 'first-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))
    provider.finish('第一次就发语音')
    await pending

    const sessionId = store.get(String(chatId))?.sessionId
    expect(sessionId).toStartWith('created-')
    await eventually(() => expect(messages.some((item) => item.sessionId === sessionId && item.message.content?.includes('第一次就发语音'))).toBe(true))
    broadcast(sessionId!, { type: 'message_complete' })
  })

  it('lets /answer complete while a slow transcription still holds the message queue', async () => {
    const chatId = 761
    store.set(String(chatId), 'voice-session', project)
    await text(chatId, 'Open the session')
    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.content === 'Open the session')).toBe(true))
    broadcast('voice-session', {
      type: 'permission_request',
      requestId: 'q-voice',
      toolName: 'AskUserQuestion',
      input: askUserQuestionInput,
    })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('/answer q-voice'))).toBe(true))

    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)
    const pendingVoice = update(voiceUpdate(chatId, 'answer-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    await text(chatId, '/answer q-voice Axios')
    await eventually(() => expect(messages.some((item) =>
      item.sessionId === 'voice-session' &&
      item.message.type === 'permission_response' &&
      item.message.requestId === 'q-voice' &&
      item.message.allowed === true &&
      item.message.updatedInput?.answers?.['选哪个库？'] === 'Axios',
    )).toBe(true))
    await eventually(() => expect(texts(chatId).some((value) => value.includes('已提交答案'))).toBe(true))
    // /answer rode the control queue: the voice is still blocked, not delivered.
    expect(provider.calls.length).toBe(1)
    expect(provider.aborted).toBe(0)
    expect(voiceMessages('voice-session').some((item) => item.message.content?.includes('answer-fid'))).toBe(false)

    await text(chatId, '/stop')
    await pendingVoice
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('does not echo success, claim handover, or retry when sendUserMessage fails after a successful transcript', async () => {
    const chatId = 762
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pending = update(voiceUpdate(chatId, 'sendfail-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    const attempted: Array<{ chatId: string; content: string }> = []
    const sendSpy = spyOn(WsBridge.prototype, 'sendUserMessage').mockImplementation(
      (id: string, content: string) => {
        attempted.push({ chatId: id, content })
        return false
      },
    )
    try {
      const wsBefore = voiceMessages('voice-session').length
      provider.finish('发送失败用例')
      await pending

      expect(attempted.some((item) => item.chatId === String(chatId) && item.content.includes('发送失败用例'))).toBe(true)
      expect(attempted.filter((item) => item.content.includes('发送失败用例'))).toHaveLength(1)
      expect(voiceMessages('voice-session').length).toBe(wsBefore)
      expect(messages.filter((item) => JSON.stringify(item.message).includes('sendfail-fid'))).toEqual([])
      expect(texts(chatId).some((value) => value === '🎤 语音转写（voice-uniq-sendfail-fid.ogg）：\n发送失败用例')).toBe(false)
      expect(texts(chatId).some((value) => value.includes('已作为文件转交'))).toBe(false)
      expect(texts(chatId).some((value) => value.includes('消息发送失败'))).toBe(true)

      // Unknown-result sends are not retried: a late frame would be the bug.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(attempted.filter((item) => item.content.includes('发送失败用例'))).toHaveLength(1)
      expect(voiceMessages('voice-session').length).toBe(wsBefore)
    } finally {
      sendSpy.mockRestore()
    }
  })

  it('does not deliver a transcript after pairing authorization is revoked', async () => {
    const chatId = 763
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const pending = update(voiceUpdate(chatId, 'revoke-fid'))
    await eventually(() => expect(provider.calls.length).toBe(1))

    writeTelegramAuth([])
    try {
      const before = voiceMessages('voice-session').length
      provider.finish('撤销后不该投递')
      await pending

      expect(voiceMessages('voice-session').length).toBe(before)
      expect(messages.filter((item) => JSON.stringify(item.message).includes('revoke-fid'))).toEqual([])
      expect(messages.filter((item) => JSON.stringify(item.message).includes('撤销后不该投递'))).toEqual([])
      expect(texts(chatId).some((value) => value.includes('不再被授权'))).toBe(true)
      expect(texts(chatId).some((value) => value.includes('撤销后不该投递'))).toBe(false)
      expect(texts(chatId).some((value) => value.includes('已作为文件转交'))).toBe(false)
    } finally {
      writeTelegramAuth([7])
    }
  })

  it.each(['/new', '/allow'] as const)('treats a transcribed %s as ordinary user text, not a command', async (spoken) => {
    const chatId = spoken === '/new' ? 764 : 765
    store.set(String(chatId), 'voice-session', project)
    const createdBefore = [...sessionPaths.keys()].filter((id) => id.startsWith('created-'))
    await text(chatId, 'Open the session')
    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.content === 'Open the session')).toBe(true))
    broadcast('voice-session', {
      type: 'permission_request',
      requestId: `permit-${chatId}`,
      toolName: 'Bash',
      input: { command: 'echo fixture' },
    })
    await eventually(() => expect(texts(chatId).some((value) => value.includes(`permit-${chatId}`))).toBe(true))

    const fileId = `spoken-${chatId}`
    setTelegramTranscriber(new FakeTranscriptionProvider([{ result: { ok: true, text: spoken } }]))
    await update(voiceUpdate(chatId, fileId))

    const expected = `🎤 语音转写（voice-uniq-${fileId}.ogg）：\n${spoken}`
    await eventually(() => expect(voiceMessages('voice-session').some((item) => item.message.content === expected)).toBe(true))
    const delivered = voiceMessages('voice-session').filter((item) => item.message.content === expected)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.message.type).toBe('user_message')
    expect(delivered[0]!.sessionId).toBe('voice-session')
    expect(store.get(String(chatId))?.sessionId).toBe('voice-session')
    expect([...sessionPaths.keys()].filter((id) => id.startsWith('created-'))).toEqual(createdBefore)
    expect(messages.filter((item) =>
      item.message.type === 'permission_response' && item.message.requestId === `permit-${chatId}`,
    )).toEqual([])
    broadcast('voice-session', { type: 'message_complete' })
  })

  it('stops sending once the adapter is shut down, including queued input, and waits for provider cleanup before stop resolves', async () => {
    const chatId = 749
    store.set(String(chatId), 'voice-session', project)
    const provider = new ControllableTranscriptionProvider()
    setTelegramTranscriber(provider)

    const before = voiceMessages('voice-session').length
    const first = update(voiceUpdate(chatId, 'shutdown-1'))
    await eventually(() => expect(provider.calls.length).toBe(1))
    // A second voice is already queued behind the running one.
    const second = update(voiceUpdate(chatId, 'shutdown-2'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The abort path must wait for the provider's cleanup (detached child
    // killed, temp files removed) before the transcription call settles. Hold
    // that cleanup behind a gate to prove shutdown does not resolve early.
    let releaseCleanup!: () => void
    provider.cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })

    let stopResolved = false
    const stopped = entry.stopTelegramAdapter().then(() => { stopResolved = true })

    // The abort reached the provider, but the stop promise must stay pending
    // while the provider is still cleaning up.
    await eventually(() => expect(provider.aborted).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stopResolved).toBe(false)

    releaseCleanup()
    await stopped
    await Promise.all([first, second])
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Neither the in-flight transcript nor the queued voice is sent or even
    // downloaded after shutdown.
    expect(voiceMessages('voice-session').length).toBe(before)
    expect(getFileCallsFor('shutdown-2')).toBe(0)
  })
})