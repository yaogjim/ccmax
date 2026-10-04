import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { SessionStore } from '../../common/session-store.js'
import { WsBridge } from '../../common/ws-bridge.js'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'
import { TelegramStreamDelivery } from '../stream-delivery.js'

// Import the actual entrypoint with isolated configuration. Telegram API calls
// terminate in grammY's documented transformer; HTTP and WS use loopback only.
describe('Telegram entrypoint session routing', () => {
  const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'TELEGRAM_BOT_TOKEN', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS', 'ADAPTER_DEFAULT_PROJECT_DIR', 'CLAUDE_ADAPTER_DEFAULT_WORK_DIR', 'CC_HAHA_LOCAL_ACCESS_TOKEN']
  const previousEnv = new Map<string, string | undefined>()
  let directory: string
  let project: string
  let worktree: string
  let entry: typeof import('../index.js')
  let server: ReturnType<typeof Bun.serve<{ sessionId: string }>>
  let store: SessionStore
  let nextId = 100
  const apiCalls: Array<{ method: string; payload: any; result?: any }> = []
  const requests: string[] = []
  const messages: Array<{ sessionId: string; message: any }> = []
  const sockets = new Map<string, Set<ServerWebSocket<{ sessionId: string }>>>()
  const sessionPaths = new Map<string, string>()

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
    return apiCalls.filter((call) => call.payload.chat_id === chatId && call.payload.text).map((call) => call.payload.text)
  }

  function lastMarkup(chatId: number) {
    return [...apiCalls].reverse().find((call) =>
      (call.method === 'sendMessage' || call.method === 'editMessageText')
      && call.payload?.chat_id === chatId
      && call.payload?.reply_markup?.inline_keyboard,
    )
  }

  function keyboardButtons(chatId: number): Array<{ text: string; callback_data: string }> {
    return lastMarkup(chatId)?.payload.reply_markup.inline_keyboard.flat() ?? []
  }

  function callbackData(chatId: number, match: string | RegExp): string {
    const buttons = keyboardButtons(chatId)
    const found = [...buttons].reverse().find((button) => {
      const haystack = `${button.text}\n${button.callback_data}`
      return typeof match === 'string' ? haystack.includes(match) : match.test(button.text) || match.test(button.callback_data)
    })
    if (!found) throw new Error(`button not found: ${String(match)}; buttons=${JSON.stringify(buttons)}`)
    return found.callback_data
  }

  function lastCardMessageId(chatId: number): number | undefined {
    const call = lastMarkup(chatId)
    if (typeof call?.result?.message_id === 'number') return call.result.message_id
    if (typeof call?.payload?.message_id === 'number') return call.payload.message_id
    return undefined
  }

  async function text(chatId: number, value: string, options: { userId?: number; messageId?: number; photo?: boolean; replyToMessageId?: number } = {}): Promise<void> {
    const messageId = options.messageId ?? nextId++
    const message = {
      message_id: messageId,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: options.userId ?? 7, is_bot: false, first_name: 'Fixture' },
      ...(options.replyToMessageId !== undefined ? {
        reply_to_message: {
          message_id: options.replyToMessageId,
          date: 1,
          chat: { id: chatId, type: 'private' },
        },
      } : {}),
      ...(options.photo ? {
        photo: [{ file_id: 'fixture-photo', file_unique_id: 'unique', width: 1, height: 1 }],
        caption: value,
      } : {
        text: value,
        ...(value.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0].length }] } : {}),
      }),
    }
    await entry.bot.handleUpdate({ update_id: messageId, message } as any)
  }

  async function callback(chatId: number, data: string, options: { id?: string; messageId?: number } = {}): Promise<void> {
    const messageId = options.messageId ?? lastCardMessageId(chatId) ?? 1
    await entry.bot.handleUpdate({
      update_id: nextId++,
      callback_query: {
        id: options.id ?? `callback-${nextId++}`,
        data,
        chat_instance: 'fixture',
        from: { id: 7, is_bot: false, first_name: 'Fixture' },
        message: { message_id: messageId, date: 1, chat: { id: chatId, type: 'private' }, text: 'fixture menu' },
      },
    } as any)
  }

  async function click(chatId: number, match: string | RegExp, options: { id?: string; messageId?: number } = {}): Promise<void> {
    await callback(chatId, callbackData(chatId, match), {
      id: options.id,
      messageId: options.messageId ?? lastCardMessageId(chatId),
    })
  }

  function broadcast(sessionId: string, message: unknown): void {
    for (const socket of sockets.get(sessionId) ?? []) socket.send(JSON.stringify(message))
  }

  function permissionResponses(requestId: string): any[] {
    return messages.filter((item) => item.message.type === 'permission_response' && item.message.requestId === requestId)
  }

  function questionActivities(requestId: string): any[] {
    return messages.filter((item) => item.message.type === 'ask_user_question_activity' && item.message.requestId === requestId)
  }

  const singleQuestionInput = {
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
    metadata: { source: 'fixture-meta' },
  }

  const multiQuestionInput = {
    questions: [
      { question: '前端框架？', header: 'Framework', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false },
      { question: '数据库？', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
    ],
  }

  const multiSelectInput = {
    questions: [
      {
        question: '启用哪些能力？',
        header: 'Features',
        options: [
          { label: '缓存', description: '加速读取' },
          { label: '日志', description: '排查问题' },
          { label: '监控', description: '观察运行' },
        ],
        multiSelect: true,
      },
    ],
  }

  beforeAll(async () => {
    for (const key of envKeys) previousEnv.set(key, process.env[key])
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'telegram-entry-')))
    project = join(directory, 'repo')
    worktree = join(directory, 'repo-feature')
    mkdirSync(project)
    mkdirSync(worktree)
    for (const id of ['old', 'history', 'running', 'stream']) sessionPaths.set(id, id === 'history' ? worktree : project)
    server = Bun.serve<{ sessionId: string }>({
      hostname: '127.0.0.1', port: 0,
      async fetch(request, server) {
        const url = new URL(request.url)
        requests.push(`${request.method} ${url.pathname}`)
        if (url.pathname.startsWith('/ws/')) {
          if (server.upgrade(request, { data: { sessionId: url.pathname.split('/')[2] } })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/api/sessions/recent-projects') return Response.json({
          projects: [
            { projectName: 'repo', realPath: project, projectPath: '-fixture-repo', branch: 'main', sessionCount: 3 },
            { projectName: 'repo-feature', realPath: worktree, projectPath: '-fixture-repo-feature', branch: 'feat', sessionCount: 1 },
          ],
        })
        if (url.pathname === '/api/sessions' && request.method === 'POST') {
          const body = await request.json() as { workDir: string }
          const sessionId = `created-${nextId++}`
          sessionPaths.set(sessionId, body.workDir)
          return Response.json({ sessionId })
        }
        if (url.pathname === '/api/sessions') return Response.json({
          sessions: ['history', 'running', 'old'].map((id, index) => ({ id, title: `${id} title`, createdAt: '2026-01-01', modifiedAt: `2026-06-0${3 - index}`, workDir: sessionPaths.get(id), projectRoot: project, projectPath: '-fixture-repo', workDirExists: true, messageCount: 4 })), total: 3,
        })
        const sessionId = url.pathname.split('/')[3]
        if (sessionPaths.has(sessionId)) return Response.json({ workDir: sessionPaths.get(sessionId), repoName: 'repo', branch: 'main' })
        if (url.pathname === '/api/skills') return Response.json({ skills: [{ name: 'fixture', displayName: 'Fixture', description: 'Fixture skill', source: 'plugin', userInvocable: true }] })
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
          socket.send(JSON.stringify({ type: 'permission_requests_snapshot', turnActive: socket.data.sessionId === 'running', toolRequestIds: [], computerUseRequestIds: [] }))
        },
        message(socket, raw) {
          const message = JSON.parse(String(raw))
          messages.push({ sessionId: socket.data.sessionId, message })
          if (message.content === '/clear') socket.send(JSON.stringify({ type: 'message_complete' }))
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
    writeFileSync(join(directory, 'adapters.json'), JSON.stringify({ telegram: { allowedUsers: [7], defaultWorkDir: project, allowedProjectRoots: [directory] } }))
    store = new SessionStore(join(directory, 'adapter-sessions.json'))
    entry = await import('../index.js')
    entry.bot.botInfo = { id: 12345, is_bot: true, first_name: 'Fixture', username: 'fixture_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false }
    entry.bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getFile') throw new Error('Fixture download rejected before network')
      const result = ['answerCallbackQuery', 'deleteMessage'].includes(method)
        ? true
        : { message_id: nextId++, date: 1, chat: { id: (payload as any).chat_id, type: 'private' }, text: (payload as any).text }
      apiCalls.push({ method, payload, result })
      return { ok: true, result } as any
    })
  })

  afterAll(async () => {
    await entry?.stopTelegramAdapter()
    await server?.stop(true)
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('retains the original session and project through reconnect timeout and retries that conversation', async () => {
    const chatId = 709
    store.set(String(chatId), 'history', worktree)
    const originalBinding = store.get(String(chatId))
    const creationsBefore = requests.filter((request) => request === 'POST /api/sessions').length
    const failedOpen = spyOn(WsBridge.prototype, 'waitForOpen').mockImplementationOnce(async function (this: WsBridge, id) {
      this.resetSession(id)
      return false
    })
    try {
      await text(chatId, 'Continue after reconnect')
      expect(store.get(String(chatId))).toEqual(originalBinding)
      expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
      expect(messages.some((item) => item.message.content === 'Continue after reconnect')).toBe(false)
      expect(texts(chatId).at(-1)).toContain('已保留会话和工作目录')
      expect(texts(chatId).at(-1)).not.toContain('/new')

      await text(chatId, 'Retry the original conversation')
      await eventually(() => expect(messages.some((item) => item.sessionId === 'history' && item.message.content === 'Retry the original conversation')).toBe(true))
      expect(store.get(String(chatId))).toEqual(originalBinding)
      expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
      broadcast('history', { type: 'message_complete' })
    } finally {
      failedOpen.mockRestore()
    }
  })

  it.each(['status', 'stop', 'clear'] as const)('preserves the session and project when /%s cannot reconnect, then retries the original session', async (command) => {
    const chatId = nextId++
    const sessionId = `retry-${command}`
    sessionPaths.set(sessionId, worktree)
    store.set(String(chatId), sessionId, worktree)
    const originalBinding = store.get(String(chatId))
    const creationsBefore = requests.filter((request) => request === 'POST /api/sessions').length
    const sendMessage = spyOn(WsBridge.prototype, 'sendUserMessage')
    const sendStop = spyOn(WsBridge.prototype, 'sendStopGeneration')
    const failedOpen = spyOn(WsBridge.prototype, 'waitForOpen').mockImplementationOnce(async function (this: WsBridge, id) {
      this.resetSession(id)
      return false
    })
    try {
      await text(chatId, `/${command}`)
      // /stop and /clear dispatch asynchronously, so wait for their failure reply.
      await eventually(() => expect(texts(chatId).at(-1)).toContain('已保留会话和工作目录'))
      expect(store.get(String(chatId))).toEqual(originalBinding)
      expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
      expect(sendMessage).not.toHaveBeenCalled()
      expect(sendStop).not.toHaveBeenCalled()
      expect(messages.filter((item) => item.sessionId === sessionId)).toEqual([])
      expect(texts(chatId).at(-1)).not.toContain('/new')

      await text(chatId, `/${command}`)
      await eventually(() => {
        if (command === 'status') {
          expect(texts(chatId).at(-1)).toContain(sessionId)
        } else if (command === 'stop') {
          expect(messages.some((item) => item.sessionId === sessionId && item.message.type === 'stop_generation')).toBe(true)
          expect(texts(chatId).at(-1)).toContain('已发送停止信号')
        } else {
          expect(messages.some((item) => item.sessionId === sessionId && item.message.content === '/clear')).toBe(true)
          expect(texts(chatId).some((value) => value.includes('已清空当前会话上下文'))).toBe(true)
        }
      })
      expect(store.get(String(chatId))).toEqual(originalBinding)
      expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
      expect(failedOpen).toHaveBeenCalledTimes(2)
    } finally {
      failedOpen.mockRestore()
      sendMessage.mockRestore()
      sendStop.mockRestore()
    }
  })

  it('runs registered history commands after authorization and deduplication', async () => {
    const before = requests.length
    await text(701, '/sessions', { userId: 99 })
    expect(texts(701).at(-1)).toContain('未授权')
    expect(requests.length).toBe(before)
    store.set('702', 'old', project)
    await text(702, '/sessions', { messageId: 10001 })
    const afterFirst = requests.length
    await text(702, '/sessions', { messageId: 10001 })
    expect(requests.length).toBe(afterFirst)
    await text(702, '/resume 1')
    expect(store.get('702')?.sessionId).toBe('history')
    expect(store.get('702')?.workDir).toBe(worktree)
    await text(702, 'Continue this history')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'history' && item.message.content === 'Continue this history')).toBe(true))
    await text(702, '/sessions')
    await text(702, '/resume 3')
    expect(store.get('702')?.sessionId).toBe('history')
    expect(texts(702).at(-1)).toContain('/stop')
    broadcast('history', { type: 'message_complete' })
  })

  it('reads active-turn snapshots when resuming history before any status event', async () => {
    store.set('703', 'old', project)
    await text(703, '/sessions')
    await text(703, '/resume 2')
    expect(store.get('703')?.sessionId).toBe('running')
    await text(703, '/sessions')
    await text(703, '1')
    expect(store.get('703')?.sessionId).toBe('running')
    expect(texts(703).at(-1)).toContain('/stop')
  })

  it('serializes menu and text input and clears conflicting selection states', async () => {
    store.set('704', 'old', project)
    await Promise.all([text(704, '/sessions'), text(704, '/resume')])
    expect(texts(704).at(-1)).toMatch(/历史会话/)
    const historyButtons = keyboardButtons(704)
    expect(historyButtons.some((button) => /^tgh:[0-9a-f]+:pick:\d+$/.test(button.callback_data))).toBe(true)
    expect(historyButtons.some((button) => /tgh:[0-9a-f]+:projects$/.test(button.callback_data))).toBe(true)
    expect(historyButtons.some((button) => /tgh:[0-9a-f]+:refresh$/.test(button.callback_data))).toBe(true)
    expect(historyButtons.some((button) => /tgh:[0-9a-f]+:cancel$/.test(button.callback_data))).toBe(true)
    const stalePick = callbackData(704, /tgh:[0-9a-f]+:pick:0$/)
    await text(704, '/sessions')
    const freshPick = callbackData(704, /tgh:[0-9a-f]+:pick:0$/)
    const freshMessageId = lastCardMessageId(704)
    expect(freshPick).not.toBe(stalePick)
    await callback(704, stalePick)
    expect(texts(704).at(-1)).toMatch(/过期|不存在/)
    expect(store.get('704')?.sessionId).toBe('old')
    await callback(704, freshPick, { id: 'dedup-callback', messageId: freshMessageId })
    const afterFirst = requests.length
    await callback(704, freshPick, { id: 'dedup-callback', messageId: freshMessageId })
    expect(requests.length).toBe(afterFirst)
    expect(store.get('704')?.sessionId).toBe('history')
    const creationsBeforeProjects = requests.filter((request) => request === 'POST /api/sessions').length
    await text(704, '/sessions')
    await text(704, '/cancel')
    expect(texts(704).at(-1)).toContain('已取消')
    expect(store.get('704')?.sessionId).toBe('history')
    await text(704, '/projects')
    expect(callbackData(704, /tgsel:new_project:[0-9a-f]+:pick:0$/)).toMatch(/^tgsel:new_project:[0-9a-f]+:pick:0$/)
    await click(704, /tgsel:new_project:[0-9a-f]+:pick:0$/)
    expect(store.get('704')?.sessionId).toStartWith('created-')
    expect(store.get('704')?.workDir).toBe(project)
    expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBeforeProjects + 1)
    await text(704, '/projects')
    await click(704, /tgsel:new_project:[0-9a-f]+:pick:1$/)
    expect(store.get('704')?.workDir).toBe(worktree)
    await text(704, '/new')
    expect(store.get('704')?.workDir).toBe(project)
  })

  it('lists projects with tgh when /resume has no binding and restores history without creating a session', async () => {
    const chatId = 770
    const creationsBefore = requests.filter((request) => request === 'POST /api/sessions').length
    await text(chatId, '/resume')
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选择历史会话所在的项目'))).toBe(true))
    const buttons = keyboardButtons(chatId)
    expect(buttons.some((button) => /^tgh:[0-9a-f]+:pick:0$/.test(button.callback_data))).toBe(true)
    expect(buttons.some((button) => /tgh:[0-9a-f]+:refresh$/.test(button.callback_data))).toBe(true)
    expect(buttons.some((button) => /tgh:[0-9a-f]+:cancel$/.test(button.callback_data))).toBe(true)
    expect(buttons.some((button) => /tgh:[0-9a-f]+:projects$/.test(button.callback_data))).toBe(false)
    await click(chatId, /tgh:[0-9a-f]+:pick:0$/)
    await eventually(() => expect(texts(chatId).some((value) => /历史会话/.test(value))).toBe(true))
    expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
    await click(chatId, /tgh:[0-9a-f]+:pick:0$/)
    expect(store.get(String(chatId))?.sessionId).toBe('history')
    expect(store.get(String(chatId))?.workDir).toBe(worktree)
    expect(requests.filter((request) => request === 'POST /api/sessions').length).toBe(creationsBefore)
  })

  it('keeps failed-download captions as conversation content and routes permission callbacks', async () => {
    store.set('705', 'old', project)
    await text(705, '/sessions')
    const logError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await text(705, '/resume 1', { photo: true })
      expect(logError).toHaveBeenCalled()
    } finally {
      logError.mockRestore()
    }
    expect(store.get('705')?.sessionId).toBe('old')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'old' && item.message.content === '/resume 1')).toBe(true))
    broadcast('old', { type: 'permission_request', requestId: 'fixture-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(705).some((value) => value.includes('fixture-request'))).toBe(true))
    await callback(705, 'permit:fixture-request:yes')
    await eventually(() => expect(messages.some((item) => item.message.type === 'permission_response' && item.message.requestId === 'fixture-request')).toBe(true))
    broadcast('old', { type: 'message_complete' })
    await text(705, '/clear')
    await eventually(() => expect(messages.some((item) => item.message.content === '/clear')).toBe(true))
  })

  it('updates model and busy state through existing Skill and model menu wiring', async () => {
    store.set('706', 'old', project)
    await text(706, '/model fixture-model')
    await eventually(() => expect(texts(706).some((value) => value.includes('已切换模型'))).toBe(true))
    await text(706, '/skills')
    await eventually(() => expect(texts(706).some((value) => value.includes('当前项目可用 Skills'))).toBe(true))
    await callback(706, callbackData(706, /tgsel:skill:[0-9a-f]+:pick:0$/))
    await text(706, '/sessions')
    await text(706, '/resume 1')
    expect(store.get('706')?.sessionId).toBe('old')
    expect(texts(706).at(-1)).toContain('/stop')
  })

  it('accepts desktop permission resolution and restores history after completion', async () => {
    store.set('707', 'old', project)
    await text(707, 'Need approval')
    broadcast('old', { type: 'permission_request', requestId: 'desktop-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(707).some((value) => value.includes('desktop-request'))).toBe(true))
    broadcast('old', { type: 'permission_resolved', permissionType: 'tool', requestId: 'desktop-request' })
    broadcast('old', { type: 'message_complete' })
    await text(707, '/status')
    await eventually(() => expect(texts(707).some((value) => value.includes('old'))).toBe(true))
    await text(707, '/stop')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'old' && item.message.type === 'stop_generation')).toBe(true))
    await text(707, '/sessions')
    await text(707, '/resume 1')
    expect(store.get('707')?.sessionId).toBe('history')
    expect(texts(707).at(-1)).toContain('已恢复会话')
  })

  it('delivers a resumed answer and accepts text approval through the same entrypoint', async () => {
    store.set('708', 'stream', project)
    await text(708, 'Show the result')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'stream' && item.message.content === 'Show the result')).toBe(true))
    broadcast('stream', { type: 'status', state: 'thinking', verb: 'Thinking' })
    broadcast('stream', { type: 'thinking', text: 'Checking the previous context' })
    broadcast('stream', { type: 'content_start', blockType: 'text' })
    broadcast('stream', { type: 'content_delta', text: 'Result from the restored session.' })
    broadcast('stream', { type: 'content_start', blockType: 'tool_use' })
    broadcast('stream', { type: 'tool_use_complete' })
    broadcast('stream', { type: 'tool_result' })
    broadcast('stream', { type: 'system_notification', subtype: 'init', data: { model: 'fixture-model' } })
    broadcast('stream', { type: 'permission_request', requestId: 'text-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(708).some((value) => value.includes('text-request'))).toBe(true))
    await text(708, '/allow text-request')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'stream' && item.message.type === 'permission_response' && item.message.requestId === 'text-request')).toBe(true))
    broadcast('stream', { type: 'message_complete' })
    broadcast('stream', { type: 'error', message: 'Fixture turn failed' })
    await eventually(() => expect(texts(708).some((value) => value.includes('Fixture turn failed'))).toBe(true))
    expect(texts(708).some((value) => value.includes('Result from the restored session.'))).toBe(true)
    expect(texts(708).some((value) => value.includes('Checking the previous context'))).toBe(true)
  })

  it('answers a unique AskUserQuestion from a button without showing the request id', async () => {
    const chatId = 720
    const session = 'question-single'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Ask me a question')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Ask me a question')).toBe(true))

    const promptStart = apiCalls.length
    broadcast(session, { type: 'permission_request', requestId: 'q-single', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))
    expect(questionActivities('q-single')).toEqual([])

    const prompt = apiCalls.slice(promptStart).find((call) =>
      call.method === 'sendMessage' && call.payload.chat_id === chatId && call.payload.text?.includes('选哪个库？'))
    expect(prompt).toBeDefined()
    expect(prompt!.payload.text).not.toContain('q-single')
    expect(prompt!.payload.text).not.toContain('/answer q-single')
    const keyboard = JSON.stringify(prompt!.payload.reply_markup)
    expect(keyboard).toMatch(/tgq:[0-9a-f]+:\d+:c:0/)
    expect(keyboard).toContain('拒绝')

    await click(chatId, 'Axios')
    await eventually(() => expect(permissionResponses('q-single').some((item) =>
      item.message.allowed === true &&
      item.message.updatedInput?.answers?.['选哪个库？'] === 'Axios' &&
      Array.isArray(item.message.updatedInput?.questions) &&
      item.message.updatedInput?.questions[0]?.question === '选哪个库？' &&
      item.message.updatedInput?.metadata?.source === 'fixture-meta',
    )).toBe(true))
    expect(permissionResponses('q-single')).toHaveLength(1)
    expect(questionActivities('q-single').length).toBeGreaterThan(0)
  })

  it('walks a multi-question guide and only submits once from the summary', async () => {
    const chatId = 721
    const session = 'question-guide'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Multi question')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Multi question')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-multi', toolName: 'AskUserQuestion', input: multiQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('前端框架？'))).toBe(true))

    await click(chatId, 'React')
    expect(permissionResponses('q-multi')).toEqual([])
    await eventually(() => expect(texts(chatId).some((value) => value.includes('数据库？'))).toBe(true))
    await click(chatId, 'Postgres')
    expect(permissionResponses('q-multi')).toEqual([])
    await eventually(() => expect(texts(chatId).some((value) => /确认|摘要|全部答案/.test(value))).toBe(true))
    await click(chatId, '提交全部')
    await eventually(() => expect(permissionResponses('q-multi')).toHaveLength(1))
    expect(permissionResponses('q-multi')[0]!.message.updatedInput?.answers).toEqual({
      '前端框架？': 'React',
      '数据库？': 'Postgres',
    })
    expect(Array.isArray(permissionResponses('q-multi')[0]!.message.updatedInput?.questions)).toBe(true)
  })

  it('still accepts a complete JSON /answer payload and numeric JSON without a request id', async () => {
    const chatId = 771
    const session = 'question-json'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'JSON question')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'JSON question')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-json-full', toolName: 'AskUserQuestion', input: multiQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('前端框架？'))).toBe(true))

    await text(chatId, '/answer q-json-full React')
    expect(permissionResponses('q-json-full')).toEqual([])

    await text(chatId, '/answer q-json-full {"前端框架？":"React"}')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/JSON|无法识别|不完整/))
    expect(permissionResponses('q-json-full')).toEqual([])

    const fullJson = `/answer q-json-full ${JSON.stringify({ '前端框架？': 'React', '数据库？': 'Postgres' })}`
    await text(chatId, fullJson)
    await eventually(() => expect(permissionResponses('q-json-full').some((item) =>
      item.message.updatedInput?.answers?.['数据库？'] === 'Postgres' &&
      item.message.updatedInput?.answers?.['前端框架？'] === 'React' &&
      Array.isArray(item.message.updatedInput?.questions),
    )).toBe(true))
    expect(permissionResponses('q-json-full')).toHaveLength(1)
    expect(messages.some((item) => item.message.type === 'user_message' && item.message.content === fullJson)).toBe(false)

    const numericInput = {
      questions: [
        { question: '数字题一？', header: 'N1', options: [{ label: 'Vue' }, { label: 'Svelte' }], multiSelect: false },
        { question: '数字题二？', header: 'N2', options: [{ label: 'SQLite' }, { label: 'MySQL' }], multiSelect: false },
      ],
    }
    broadcast(session, { type: 'permission_request', requestId: 'q-json-numeric', toolName: 'AskUserQuestion', input: numericInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('数字题一？'))).toBe(true))
    const numericJson = `/answer ${JSON.stringify({ '1': 'Vue', '2': 'SQLite' })}`
    await text(chatId, numericJson)
    await eventually(() => expect(permissionResponses('q-json-numeric').some((item) =>
      item.message.updatedInput?.answers?.['数字题一？'] === 'Vue' &&
      item.message.updatedInput?.answers?.['数字题二？'] === 'SQLite' &&
      Array.isArray(item.message.updatedInput?.questions),
    )).toBe(true))
    expect(messages.some((item) => item.message.type === 'user_message' && item.message.content === numericJson)).toBe(false)
  })

  it('treats unique ordinary text as the answer and still rejects /allow or /always', async () => {
    const chatId = 722
    const session = 'question-guard'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Guard me')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Guard me')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-guard', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))

    await text(chatId, '1')
    await eventually(() => expect(permissionResponses('q-guard').some((item) =>
      item.message.allowed === true &&
      item.message.updatedInput?.answers?.['选哪个库？'] === '1',
    )).toBe(true))
    expect(permissionResponses('q-guard').some((item) => item.message.allowed === false)).toBe(false)
    expect(messages.some((item) => item.message.type === 'user_message' && item.message.content === '1')).toBe(false)
    expect(questionActivities('q-guard').length).toBeGreaterThan(0)

    broadcast(session, { type: 'permission_request', requestId: 'q-guard-allow', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).filter((value) => value.includes('选哪个库？')).length).toBeGreaterThan(1))
    await text(chatId, '/allow q-guard-allow')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/answer|作答|点选/))
    expect(permissionResponses('q-guard-allow')).toEqual([])

    await text(chatId, '/always q-guard-allow')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/answer|作答|点选/))
    expect(permissionResponses('q-guard-allow')).toEqual([])

    await text(chatId, '/deny q-guard-allow')
    await eventually(() => expect(permissionResponses('q-guard-allow').some((item) => item.message.allowed === false)).toBe(true))
  })

  it('rejects leftover permit-yes on a question and denies from the tgq button', async () => {
    const chatId = 723
    const session = 'question-callback'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Callback guard')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Callback guard')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-callback', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))

    await callback(chatId, 'permit:q-callback:yes')
    expect(permissionResponses('q-callback')).toEqual([])
    expect(callbackData(chatId, '拒绝')).toMatch(/tgq:[0-9a-f]+:\d+:d$/)

    await click(chatId, '拒绝')
    await eventually(() => expect(permissionResponses('q-callback').some((item) => item.message.allowed === false)).toBe(true))
  })

  it('keeps a failed answer retryable via the latest button and clears questions on resolution, snapshot, /new, and /stop', async () => {
    const chatId = 724
    const session = 'question-retry'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Retry me')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Retry me')).toBe(true))

    broadcast(session, { type: 'permission_request', requestId: 'q-retry', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))

    const failing = spyOn(WsBridge.prototype, 'sendPermissionResponse').mockReturnValueOnce(false)
    try {
      await click(chatId, 'Axios')
      await eventually(() => expect(texts(chatId).some((value) => /发送失败|稍后重试/.test(value))).toBe(true))
      expect(permissionResponses('q-retry')).toEqual([])
    } finally {
      failing.mockRestore()
    }

    await click(chatId, '提交全部')
    await eventually(() => expect(permissionResponses('q-retry').some((item) =>
      item.message.updatedInput?.answers?.['选哪个库？'] === 'Axios')).toBe(true))

    const resolvedInput = { questions: [{ question: '桌面已处理？', options: [{ label: 'A' }], multiSelect: false }] }
    broadcast(session, { type: 'permission_request', requestId: 'q-resolved', toolName: 'AskUserQuestion', input: resolvedInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('桌面已处理？'))).toBe(true))
    broadcast(session, { type: 'permission_resolved', permissionType: 'tool', requestId: 'q-resolved' })
    broadcast(session, { type: 'permission_request', requestId: 'q-barrier-resolved', toolName: 'AskUserQuestion', input: { questions: [{ question: '屏障已处理？', options: [{ label: 'A' }], multiSelect: false }] } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('屏障已处理？'))).toBe(true))
    await text(chatId, '/answer q-resolved A')
    await eventually(() => expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求'))
    expect(permissionResponses('q-resolved')).toEqual([])

    const snapshotInput = { questions: [{ question: '快照将清掉？', options: [{ label: 'A' }], multiSelect: false }] }
    broadcast(session, { type: 'permission_request', requestId: 'q-snapshot', toolName: 'AskUserQuestion', input: snapshotInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('快照将清掉？'))).toBe(true))
    broadcast(session, { type: 'permission_requests_snapshot', toolRequestIds: [], computerUseRequestIds: [], turnActive: true })
    broadcast(session, { type: 'permission_request', requestId: 'q-barrier-snapshot', toolName: 'AskUserQuestion', input: { questions: [{ question: '快照屏障？', options: [{ label: 'A' }], multiSelect: false }] } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('快照屏障？'))).toBe(true))
    await text(chatId, '/answer q-snapshot A')
    await eventually(() => expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求'))
    expect(permissionResponses('q-snapshot')).toEqual([])

    broadcast(session, { type: 'permission_request', requestId: 'q-stop', toolName: 'AskUserQuestion', input: { questions: [{ question: '停止后失效？', options: [{ label: 'A' }], multiSelect: false }] } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('停止后失效？'))).toBe(true))
    await text(chatId, '/stop')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.type === 'stop_generation')).toBe(true))
    await text(chatId, '/answer q-stop A')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/未找到待回答的问题请求|失效/))
    expect(permissionResponses('q-stop')).toEqual([])

    broadcast(session, { type: 'permission_request', requestId: 'q-new', toolName: 'AskUserQuestion', input: { questions: [{ question: '新建后失效？', options: [{ label: 'A' }], multiSelect: false }] } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('新建后失效？'))).toBe(true))
    await text(chatId, '/new')
    await text(chatId, '/answer q-new A')
    await eventually(() => expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求'))
    expect(permissionResponses('q-new')).toEqual([])
  })

  it('clears both pending maps before terminal delivery and guards replayed worker questions', async () => {
    const chatId = 728
    const session = 'question-terminal'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Terminal boundary')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Terminal boundary')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-terminal', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))

    // Hold final Telegram delivery while the user clicks an old allow button.
    // Clearing only question input used to leave the same id approvable without answers.
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = TelegramStreamDelivery.prototype.handleEvent
    const sendResponse = spyOn(WsBridge.prototype, 'sendPermissionResponse')
    const delivery = spyOn(TelegramStreamDelivery.prototype, 'handleEvent').mockImplementation(async function (this: TelegramStreamDelivery, id, event) {
      if (id === String(chatId) && event.type === 'message_complete') {
        entered = true
        await gate
      }
      return original.call(this, id, event)
    })
    try {
      broadcast(session, { type: 'message_complete' })
      await eventually(() => expect(entered).toBe(true))
      await text(chatId, '/allow q-terminal')
      expect(sendResponse).not.toHaveBeenCalled()
      expect(permissionResponses('q-terminal')).toEqual([])
      await callback(chatId, 'permit:q-terminal:yes')
      expect(sendResponse).not.toHaveBeenCalled()
      expect(permissionResponses('q-terminal')).toEqual([])
      await text(chatId, '/answer q-terminal Axios')
      expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求')
      await text(chatId, '/status')
      await eventually(() => expect(texts(chatId).at(-1)).toContain('当前会话状态'))
      expect(texts(chatId).at(-1)).not.toContain('待确认')

      // The server replays independent worker requests after the leader result.
      // Replayed questions must recover the answer guard and pending count.
      release()
      const beforeReplay = texts(chatId).filter((value) => value.includes('选哪个库？')).length
      broadcast(session, { type: 'permission_request', requestId: 'q-worker-replay', toolName: 'AskUserQuestion', input: singleQuestionInput })
      await eventually(() => expect(texts(chatId).filter((value) => value.includes('选哪个库？')).length).toBeGreaterThan(beforeReplay))
      await text(chatId, '/allow q-worker-replay')
      expect(texts(chatId).at(-1)).toMatch(/answer|作答|点选/)
      expect(permissionResponses('q-worker-replay')).toEqual([])
      await text(chatId, '/answer q-worker-replay Fetch')
      await eventually(() => expect(permissionResponses('q-worker-replay')).toHaveLength(1))
      // A second submission cannot send another approval or enter ordinary chat.
      await text(chatId, '/answer q-worker-replay Axios')
      expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求')
      expect(permissionResponses('q-worker-replay')).toHaveLength(1)
      expect(messages.some((item) => item.message.type === 'user_message' && item.message.content === '/answer q-worker-replay Axios')).toBe(false)
    } finally {
      release()
      delivery.mockRestore()
      sendResponse.mockRestore()
    }
  })

  it('does not double-count a repeated question request and splits long prompts', async () => {
    const chatId = 725
    const session = 'stream'
    store.set(String(chatId), session, project)
    await text(chatId, 'Count me')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Count me')).toBe(true))

    broadcast(session, { type: 'permission_request', requestId: 'q-count', toolName: 'AskUserQuestion', input: singleQuestionInput })
    broadcast(session, { type: 'permission_request', requestId: 'q-count', toolName: 'AskUserQuestion', input: singleQuestionInput })
    broadcast(session, { type: 'permission_request', requestId: 'q-barrier-count', toolName: 'AskUserQuestion', input: { questions: [{ question: '计数屏障？', options: [{ label: 'A' }], multiSelect: false }] } })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('计数屏障？'))).toBe(true))
    // Two frames for one requestId must count once; a third distinct request makes two.
    await text(chatId, '/status')
    await eventually(() => expect(texts(chatId).filter((value) => value.includes('当前会话状态')).at(-1)).toContain('审批: 2 个待确认'))

    const longQuestion = `长问题 ${'x'.repeat(5000)}`
    const longInput = { questions: [{ question: longQuestion, options: [{ label: 'A' }] }] }
    const longStart = apiCalls.length
    broadcast(session, { type: 'permission_request', requestId: 'q-long', toolName: 'AskUserQuestion', input: longInput })
    await eventually(() => expect(apiCalls.slice(longStart).some((call) =>
      call.method === 'sendMessage' && call.payload.chat_id === chatId && call.payload.text?.includes('长问题'),
    )).toBe(true))

    const chunks = apiCalls.slice(longStart).filter((call) => call.method === 'sendMessage' && call.payload.chat_id === chatId)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) expect(chunk.payload.text.length).toBeLessThanOrEqual(4000)
    expect(chunks.map((chunk) => chunk.payload.text).join('')).toContain('x'.repeat(20))
    expect(chunks.at(-1)!.payload.reply_markup).toBeDefined()
    expect(JSON.stringify(chunks.at(-1)!.payload.reply_markup)).toMatch(/tgq:[0-9a-f]+:/)
    for (const chunk of chunks.slice(0, -1)) expect(chunk.payload.reply_markup).toBeUndefined()
    expect(chunks.some((chunk) => chunk.payload.text?.includes('q-long'))).toBe(false)
  })

  it('rejects unauthorized, unknown, and malformed /answer commands', async () => {
    await text(726, '/answer q-single Axios', { userId: 99 })
    await eventually(() => expect(texts(726).at(-1)).toContain('未授权'))

    const chatId = 727
    const session = 'stream'
    store.set(String(chatId), session, project)
    await text(chatId, 'Unknown answer')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Unknown answer')).toBe(true))

    await text(chatId, '/answer does-not-exist Axios')
    await eventually(() => expect(texts(chatId).at(-1)).toContain('未找到待回答的问题请求'))
    expect(permissionResponses('does-not-exist')).toEqual([])
    expect(messages.some((item) => item.message.content === '/answer does-not-exist Axios' && item.message.type === 'user_message')).toBe(false)

    await text(chatId, '/answer Axios')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/没有待回答|未找到待回答/))
    expect(messages.some((item) => item.message.content === '/answer Axios' && item.message.type === 'user_message')).toBe(false)

    await text(chatId, '/answer')
    await eventually(() => expect(texts(chatId).at(-1)).toMatch(/用法|\/answer/))
    expect(texts(chatId).at(-1)).not.toContain('请求ID')
    expect(messages.some((item) => item.message.content === '/answer' && item.message.type === 'user_message')).toBe(false)
  })

  it('joins multi-select toggles and only submits after confirm', async () => {
    const chatId = 772
    const session = 'question-toggle'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Toggle me')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Toggle me')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-toggle', toolName: 'AskUserQuestion', input: multiSelectInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('启用哪些能力？'))).toBe(true))
    await click(chatId, '缓存')
    expect(permissionResponses('q-toggle')).toEqual([])
    await eventually(() => expect(keyboardButtons(chatId).some((button) => button.text.includes('✓') && button.text.includes('缓存'))).toBe(true))
    await click(chatId, '日志')
    expect(permissionResponses('q-toggle')).toEqual([])
    await click(chatId, /提交|下一题/)
    await eventually(() => expect(permissionResponses('q-toggle')).toHaveLength(1))
    expect(permissionResponses('q-toggle')[0]!.message.updatedInput?.answers?.['启用哪些能力？']).toBe('缓存, 日志')
  })

  it('answers the replied-to question among several requests and asks to pick on conflict', async () => {
    const chatId = 773
    const session = 'question-reply'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Several questions')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Several questions')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-first', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))
    const firstMessageId = lastCardMessageId(chatId)
    expect(firstMessageId).toBeDefined()
    broadcast(session, { type: 'permission_request', requestId: 'q-second', toolName: 'AskUserQuestion', input: multiQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('前端框架？'))).toBe(true))

    await text(chatId, 'Fetch', { replyToMessageId: firstMessageId })
    await eventually(() => expect(permissionResponses('q-first').some((item) =>
      item.message.updatedInput?.answers?.['选哪个库？'] === 'Fetch',
    )).toBe(true))
    expect(permissionResponses('q-second')).toEqual([])

    broadcast(session, { type: 'permission_request', requestId: 'q-third', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).filter((value) => value.includes('选哪个库？')).length).toBeGreaterThan(1))
    await text(chatId, 'Axios')
    expect(permissionResponses('q-second')).toEqual([])
    expect(permissionResponses('q-third')).toEqual([])
    await eventually(() => expect(texts(chatId).some((value) => /多个待回答|点选要回答/.test(value))).toBe(true))
    expect(keyboardButtons(chatId).some((button) => /tgq:[0-9a-f]+:\d+:f$/.test(button.callback_data))).toBe(true)
  })

  it('does not answer the next question from an old card reply or a repeated callback', async () => {
    const chatId = 774
    const session = 'question-stale'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Stale card')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Stale card')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-stale', toolName: 'AskUserQuestion', input: multiQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('前端框架？'))).toBe(true))
    const firstData = callbackData(chatId, 'React')
    const firstMessageId = lastCardMessageId(chatId)
    expect(firstMessageId).toBeDefined()
    await callback(chatId, firstData, { messageId: firstMessageId })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('数据库？'))).toBe(true))
    expect(permissionResponses('q-stale')).toEqual([])

    await text(chatId, 'Vue', { replyToMessageId: firstMessageId })
    await eventually(() => expect(texts(chatId).some((value) => /失效|过期/.test(value))).toBe(true))
    expect(permissionResponses('q-stale')).toEqual([])

    await callback(chatId, firstData, { messageId: firstMessageId })
    expect(permissionResponses('q-stale')).toEqual([])
    await click(chatId, 'SQLite')
    await click(chatId, '提交全部')
    await eventually(() => expect(permissionResponses('q-stale')).toHaveLength(1))
    expect(permissionResponses('q-stale')[0]!.message.updatedInput?.answers).toEqual({
      '前端框架？': 'React',
      '数据库？': 'SQLite',
    })
  })

  it('records ask_user_question_activity on the first real interaction and not on receive', async () => {
    const chatId = 775
    const session = 'question-activity'
    sessionPaths.set(session, project)
    store.set(String(chatId), session, project)
    await text(chatId, 'Activity')
    await eventually(() => expect(messages.some((item) => item.sessionId === session && item.message.content === 'Activity')).toBe(true))
    broadcast(session, { type: 'permission_request', requestId: 'q-activity', toolName: 'AskUserQuestion', input: singleQuestionInput })
    await eventually(() => expect(texts(chatId).some((value) => value.includes('选哪个库？'))).toBe(true))
    expect(questionActivities('q-activity')).toEqual([])
    await text(chatId, '/answer Axios')
    await eventually(() => expect(permissionResponses('q-activity')).toHaveLength(1))
    expect(questionActivities('q-activity').length).toBeGreaterThan(0)
    expect(permissionResponses('q-activity')[0]!.message.updatedInput?.answers?.['选哪个库？']).toBe('Axios')
  })

  it('starts the registered bot and publishes its menu without external access', async () => {
    const gc = spyOn(AttachmentStore.prototype, 'gc').mockResolvedValue({ removed: 0, bytes: 0 })
    const start = spyOn(entry.bot, 'start').mockImplementation(async (options) => { await options?.onStart?.(entry.bot.botInfo) })
    const previousListeners = process.listeners('SIGINT')
    const previousTermListeners = process.listeners('SIGTERM')
    try {
      entry.startTelegramAdapter()
      await eventually(() => expect(apiCalls.some((call) => call.method === 'setMyCommands')).toBe(true))
      expect(gc).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      const commands = apiCalls.find((call) => call.method === 'setMyCommands')!.payload.commands
      expect(commands.some((command: { command: string }) => command.command === 'sessions')).toBe(true)
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!previousListeners.includes(listener)) process.removeListener('SIGINT', listener)
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!previousTermListeners.includes(listener)) process.removeListener('SIGTERM', listener)
      }
      start.mockRestore()
      gc.mockRestore()
    }
  })
})
