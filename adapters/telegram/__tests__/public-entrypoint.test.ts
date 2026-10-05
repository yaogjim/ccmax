import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'grammy'
import { SessionStore } from '../../common/session-store.js'
import { telegramBotIdFromToken } from '../bot-identity.js'
import {
  getPublicTelegramBot,
  setPublicTelegramBotHook,
  startPublicTelegramAdapter,
  stopPublicTelegramAdapter,
} from '../public.js'

type PublicPost = {
  method: string
  path: string
  authorization: string | null
  body: any
}

const PUBLIC_TOKEN = '222222:public-secret-token'
const DEDICATED_TOKEN = '111111:dedicated-secret-token'

const publicMe = {
  id: 222222,
  is_bot: true as const,
  first_name: 'Public',
  username: 'public_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_manage_bots: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
}

const dedicatedMe = {
  ...publicMe,
  id: 111111,
  first_name: 'Dedicated',
  username: 'dedicated_bot',
}

const envKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'TMPDIR',
  'TELEGRAM_BOT_TOKEN', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS',
  'ADAPTER_DEFAULT_PROJECT_DIR', 'CLAUDE_ADAPTER_DEFAULT_WORK_DIR',
  'CC_HAHA_LOCAL_ACCESS_TOKEN',
]

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2500
  while (true) {
    try { assertion(); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

function interceptPublicBot(bot: Bot, options: {
  me?: typeof publicMe
  getMeError?: Error
  onPoll?: () => void
  realStart?: boolean
  methods?: string[]
  webhookPayloads?: Array<Record<string, unknown>>
  sent?: string[]
  callbacks?: Array<Record<string, unknown>>
  answerError?: Error
}): void {
  const me = options.me ?? publicMe
  bot.api.config.use(async (_previous, method, payload) => {
    options.methods?.push(method)
    if (method === 'getMe') {
      if (options.getMeError) throw options.getMeError
      return { ok: true, result: me } as any
    }
    if (method === 'deleteWebhook') {
      options.webhookPayloads?.push(payload as Record<string, unknown>)
      return { ok: true, result: true } as any
    }
    if (method === 'getUpdates') {
      queueMicrotask(() => { void bot.stop() })
      return { ok: true, result: [] } as any
    }
    if (method === 'sendMessage') {
      const text = typeof (payload as { text?: unknown }).text === 'string'
        ? (payload as { text: string }).text
        : ''
      options.sent?.push(text)
      return {
        ok: true,
        result: {
          message_id: 1,
          date: 1,
          chat: { id: (payload as { chat_id?: number }).chat_id, type: 'private' },
          text,
        },
      } as any
    }
    if (method === 'answerCallbackQuery') {
      options.callbacks?.push(payload as Record<string, unknown>)
      if (options.answerError) throw options.answerError
      return { ok: true, result: true } as any
    }
    return { ok: true, result: true } as any
  })
  if (options.realStart) return
  bot.start = (async (startOptions?: { onStart?: (info: typeof me) => unknown }) => {
    options.onPoll?.()
    await startOptions?.onStart?.(me)
  }) as typeof bot.start
}

function privateMessage(chatId: number, text: string, ids: { updateId: number; messageId: number }) {
  return {
    update_id: ids.updateId,
    message: {
      message_id: ids.messageId,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Fixture' },
      text,
    },
  }
}

function callbackUpdate(chatId: number, ids: { updateId: number; queryId: string }) {
  return {
    update_id: ids.updateId,
    callback_query: {
      id: ids.queryId,
      from: { id: chatId, is_bot: false, first_name: 'Fixture' },
      chat_instance: 'fixture',
      data: 'tgp:token',
      message: {
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: 'private' },
      },
    },
  }
}

function voiceMessage(chatId: number, ids: { updateId: number; messageId: number }) {
  return {
    update_id: ids.updateId,
    message: {
      message_id: ids.messageId,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Fixture' },
      voice: {
        file_id: 'voice-file',
        file_unique_id: 'uniq-voice',
        duration: 3,
        mime_type: 'audio/ogg',
      },
    },
  }
}

describe('Telegram public forwarder', () => {
  const previousEnv = new Map<string, string | undefined>()
  const previousInt = process.listeners('SIGINT')
  const previousTerm = process.listeners('SIGTERM')
  let directory: string
  let project: string
  let configPath: string
  let server: ReturnType<typeof Bun.serve>
  const posts: PublicPost[] = []
  const seenPaths: string[] = []
  let runtimeStatus = 200
  let runtimeBodies: Array<Record<string, unknown> | null> | 'status' = 'status'
  let updateStatus = 200
  let updateBody: Record<string, unknown> | ((count: number) => Record<string, unknown> | Response) = { ok: true }
  let updateDelayMs = 0
  let updateGate: Promise<void> | null = null
  let releaseUpdateGate: (() => void) | null = null
  let concurrentUpdates = 0
  let maxConcurrentUpdates = 0
  let order: string[] = []
  let updateCount = 0

  function writeConfig(overrides: Record<string, unknown> = {}): void {
    writeFileSync(configPath, JSON.stringify({
      telegram: {
        allowedUsers: [7],
        defaultWorkDir: project,
        allowedProjectRoots: [directory],
        public: {
          enabled: true,
          botToken: PUBLIC_TOKEN,
          generation: 1,
          allowedProjectRoots: [directory],
          ...overrides,
        },
      },
    }))
  }

  beforeAll(async () => {
    for (const key of envKeys) previousEnv.set(key, process.env[key])
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'tg-public-')))
    project = join(directory, 'repo')
    mkdirSync(project)
    mkdirSync(join(directory, 'xdg'))
    mkdirSync(join(directory, 'tmp'))
    configPath = join(directory, 'adapters.json')
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.XDG_CONFIG_HOME = join(directory, 'xdg')
    process.env.TMPDIR = join(directory, 'tmp')
    delete process.env.TELEGRAM_BOT_TOKEN
    process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = directory
    process.env.ADAPTER_DEFAULT_PROJECT_DIR = project
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = project
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-token'
    writeConfig()

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        seenPaths.push(`${request.method} ${url.pathname}`)
        if (url.pathname === '/api/telegram/public/runtime' || url.pathname === '/api/telegram/public/update') {
          const body = await request.json()
          posts.push({
            method: request.method,
            path: url.pathname,
            authorization: request.headers.get('authorization'),
            body,
          })
          order.push(url.pathname.endsWith('/runtime')
            ? `${request.method.toLowerCase()}-runtime`
            : 'update')
          if (url.pathname.endsWith('/runtime')) {
            if (request.method === 'DELETE') {
              return Response.json({ ok: true }, { status: 200 })
            }
            const status = runtimeStatus
            if (runtimeBodies !== 'status') {
              const next = runtimeBodies.shift() ?? { ok: false, error: 'runtime exhausted' }
              return Response.json(next, { status })
            }
            if (status >= 300) {
              return Response.json({ error: 'CONFLICT', message: 'runtime conflict' }, { status })
            }
            return Response.json({
              botId: (body as { botId: number }).botId,
              generation: (body as { generation: number }).generation,
              subscriptions: [],
              deliveries: [],
            }, { status })
          }
          updateCount += 1
          concurrentUpdates += 1
          maxConcurrentUpdates = Math.max(maxConcurrentUpdates, concurrentUpdates)
          try {
            if (updateDelayMs > 0) await Bun.sleep(updateDelayMs)
            if (updateGate) await updateGate
            if (typeof updateBody === 'function') {
              const next = updateBody(updateCount)
              if (next instanceof Response) return next
              return Response.json(next, { status: updateStatus })
            }
            return Response.json(updateBody, { status: updateStatus })
          } finally {
            concurrentUpdates -= 1
          }
        }
        return new Response('unexpected', { status: 404 })
      },
    })
    process.env.ADAPTER_SERVER_URL = `ws://127.0.0.1:${server.port}`
  })

  beforeEach(async () => {
    await stopPublicTelegramAdapter()
    posts.length = 0
    seenPaths.length = 0
    order = []
    runtimeStatus = 200
    runtimeBodies = 'status'
    updateStatus = 200
    updateBody = { ok: true }
    updateDelayMs = 0
    updateGate = null
    releaseUpdateGate = null
    concurrentUpdates = 0
    maxConcurrentUpdates = 0
    updateCount = 0
    writeConfig()
    setPublicTelegramBotHook(undefined)
  })

  afterAll(async () => {
    setPublicTelegramBotHook(undefined)
    await stopPublicTelegramAdapter()
    await server?.stop(true)
    for (const listener of process.listeners('SIGINT')) {
      if (!previousInt.includes(listener)) process.removeListener('SIGINT', listener)
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!previousTerm.includes(listener)) process.removeListener('SIGTERM', listener)
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('registers with bearer auth before polling and forwards update ids as-is', async () => {
    let polled = false
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { onPoll: () => { polled = true; order.push('poll') } }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    expect(polled).toBe(true)
    expect(order[0]).toBe('post-runtime')
    expect(order[1]).toBe('poll')
    expect(posts[0]?.path).toBe('/api/telegram/public/runtime')
    expect(posts[0]?.method).toBe('POST')
    expect(posts[0]?.authorization).toBe('Bearer fixture-local-token')
    expect(posts[0]?.body).toEqual({ botId: 222222, generation: 1 })

    const bot = getPublicTelegramBot()
    expect(bot).toBeDefined()
    await bot!.handleUpdate(privateMessage(7, 'hello public', { updateId: 9001, messageId: 42 }) as any)
    await eventually(() => expect(posts.some((post) => post.path === '/api/telegram/public/update')).toBe(true))
    const forwarded = posts.find((post) => post.path === '/api/telegram/public/update')!
    expect(forwarded.authorization).toBe('Bearer fixture-local-token')
    expect(forwarded.body.botId).toBe(222222)
    expect(forwarded.body.generation).toBe(1)
    expect(forwarded.body.update.update_id).toBe(9001)
    expect(forwarded.body.update.message.message_id).toBe(42)
    expect(forwarded.body.update.message.text).toBe('hello public')
    await stopPublicTelegramAdapter()
    expect(posts.some((post) => post.method === 'DELETE' && post.path === '/api/telegram/public/runtime')).toBe(true)
    const deleted = posts.find((post) => post.method === 'DELETE' && post.path === '/api/telegram/public/runtime')
    expect(deleted?.body).toEqual({ botId: 222222, generation: 1 })
  })

  it('waits for grammY onStart after filling botInfo so start() does not getMe again', async () => {
    const methods: string[] = []
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { realStart: true, methods }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    expect(getPublicTelegramBot()?.isInited()).toBe(true)
    expect(methods.filter((method) => method === 'getMe')).toEqual(['getMe'])
    expect(methods).toContain('deleteWebhook')
    await stopPublicTelegramAdapter()
  })

  it('keeps pending updates across public Bot restarts', async () => {
    const webhookPayloads: Array<Record<string, unknown>> = []
    setPublicTelegramBotHook(bot => interceptPublicBot(bot, { realStart: true, webhookPayloads }))
    for (let restart = 0; restart < 2; restart++) {
      expect(await startPublicTelegramAdapter()).toBe(true)
      await stopPublicTelegramAdapter()
    }
    expect(webhookPayloads).toHaveLength(2)
    expect(webhookPayloads.every(payload => payload.drop_pending_updates !== true)).toBe(true)
  })

  it('does not write the dedicated session store for the same chat id', async () => {
    const store = new SessionStore(join(directory, 'adapter-sessions.json'))
    store.set('7', 'dedicated-session', project)
    const before = store.get('7')
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {}))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'from public', { updateId: 2, messageId: 3 }) as any)
    await eventually(() => expect(posts.some((post) => post.path === '/api/telegram/public/update')).toBe(true))
    expect(store.get('7')).toEqual(before)
    await stopPublicTelegramAdapter()
  })

  it('forwards voice updates without downloading media or opening a session websocket', async () => {
    const methods: string[] = []
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { methods }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(voiceMessage(7, { updateId: 70, messageId: 8 }) as any)
    await eventually(() => expect(posts.some((post) => post.path === '/api/telegram/public/update')).toBe(true))
    const forwarded = posts.find((post) => post.path === '/api/telegram/public/update')!
    expect(forwarded.body.update.message.voice.file_id).toBe('voice-file')
    expect(methods.filter((method) => method === 'getFile' || method === 'getFileLink')).toEqual([])
    expect(seenPaths.some((path) => path.includes('/ws/'))).toBe(false)
    await stopPublicTelegramAdapter()
  })

  it('forwards a pairing code without writing dedicated pairing or session state', async () => {
    const store = new SessionStore(join(directory, 'adapter-sessions.json'))
    store.set('7', 'dedicated-session', project)
    const beforeStore = store.get('7')
    writeFileSync(configPath, JSON.stringify({
      pairing: { code: 'ABC234', expiresAt: Date.now() + 60_000, createdAt: 1 },
      telegram: {
        allowedUsers: [7],
        pairedUsers: [{ userId: 7, displayName: 'Owner', pairedAt: 1 }],
        defaultWorkDir: project,
        allowedProjectRoots: [directory],
        public: {
          enabled: true,
          botToken: PUBLIC_TOKEN,
          generation: 1,
          ownerUserId: null,
          pairing: { code: 'PUB999', expiresAt: Date.now() + 60_000, createdAt: 2 },
        },
      },
    }))
    const beforeConfig = readFileSync(configPath, 'utf8')
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {}))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'PUB999', { updateId: 71, messageId: 9 }) as any)
    await eventually(() => expect(posts.some((post) => post.path === '/api/telegram/public/update')).toBe(true))
    expect(posts.find((post) => post.path === '/api/telegram/public/update')?.body.update.message.text).toBe('PUB999')
    expect(store.get('7')).toEqual(beforeStore)
    expect(readFileSync(configPath, 'utf8')).toBe(beforeConfig)
    await stopPublicTelegramAdapter()
  })

  it('handles updates serially so the server can persist a watermark before the next ack', async () => {
    updateDelayMs = 40
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {}))
    expect(await startPublicTelegramAdapter()).toBe(true)
    const bot = getPublicTelegramBot()!
    await Promise.all([
      bot.handleUpdate(privateMessage(7, 'one', { updateId: 11, messageId: 1 }) as any),
      bot.handleUpdate(privateMessage(7, 'two', { updateId: 12, messageId: 2 }) as any),
    ])
    expect(maxConcurrentUpdates).toBe(1)
    expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(2)
    await stopPublicTelegramAdapter()
  })

  it('re-reads config and re-registers after a public generation change', async () => {
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {}))
    expect(await startPublicTelegramAdapter()).toBe(true)
    writeConfig({ generation: 4 })
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'after pairing', { updateId: 8, messageId: 9 }) as any)
    await eventually(() => expect(posts.filter((post) =>
      post.method === 'POST' && post.path === '/api/telegram/public/runtime',
    )).toHaveLength(2))
    const update = posts.find((post) => post.path === '/api/telegram/public/update')
    expect(posts.filter((post) => post.method === 'POST' && post.path === '/api/telegram/public/runtime')[1]?.body)
      .toEqual({ botId: 222222, generation: 4 })
    expect(update?.body.generation).toBe(4)
    await stopPublicTelegramAdapter()
  })

  it('treats HTTP 200 {ok:false} as failure and does not resubmit the update', async () => {
    const sent: string[] = []
    updateBody = { ok: false, error: '公共入口未启用' }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { sent }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'nope', { updateId: 21, messageId: 5 }) as any)
    expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(1)
    expect(sent.some((text) => text.includes('公共入口未启用'))).toBe(true)
    await stopPublicTelegramAdapter()
  })

  it('re-registers once on HTTP 409 and does not retry unknown network errors', async () => {
    const sent: string[] = []
    let updates = 0
    updateBody = (count) => {
      updates = count
      if (count === 1) return new Response(JSON.stringify({ error: 'CONFLICT', message: 'stale runtime' }), { status: 409 })
      return { ok: true }
    }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { sent }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'retry-once', { updateId: 31, messageId: 6 }) as any)
    expect(updates).toBe(2)
    expect(posts.filter((post) => post.method === 'POST' && post.path === '/api/telegram/public/runtime').length)
      .toBeGreaterThanOrEqual(2)
    expect(sent).toEqual([])

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
      if (url.includes('/api/telegram/public/update')) throw new TypeError('network down')
      return previousFetch(input, init)
    }) as typeof fetch
    try {
      const before = posts.filter((post) => post.path === '/api/telegram/public/update').length
      await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'net', { updateId: 32, messageId: 7 }) as any)
      expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(before)
      expect(sent.some((text) => text.includes('转发失败'))).toBe(true)
    } finally {
      globalThis.fetch = previousFetch
    }
    await stopPublicTelegramAdapter()
  })

  it('re-registers once on HTTP 200 代次 mismatch from the server contract', async () => {
    const sent: string[] = []
    let updates = 0
    updateBody = (count) => {
      updates = count
      if (count === 1) return { ok: false, error: 'Bot 运行时身份与配置代次不一致' }
      return { ok: true }
    }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { sent }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'stale-gen', { updateId: 81, messageId: 10 }) as any)
    expect(updates).toBe(2)
    expect(posts.filter((post) => post.method === 'POST' && post.path === '/api/telegram/public/runtime').length)
      .toBeGreaterThanOrEqual(2)
    expect(sent).toEqual([])
    await stopPublicTelegramAdapter()
  })

  it('does not resubmit an unknown inbound update or re-register for it', async () => {
    const sent: string[] = []
    updateBody = { ok: false, error: '该 update 在上次中断后状态未知，不会自动重放' }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { sent }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    const runtimePosts = posts.filter((post) => post.method === 'POST' && post.path === '/api/telegram/public/runtime').length
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'unknown', { updateId: 82, messageId: 11 }) as any)
    expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(1)
    expect(posts.filter((post) => post.method === 'POST' && post.path === '/api/telegram/public/runtime')).toHaveLength(runtimePosts)
    expect(sent.some((text) => text.includes('不会自动重放'))).toBe(true)
    await stopPublicTelegramAdapter()
  })

  it('does not POST a third update when the 409 retry still mismatches', async () => {
    let updates = 0
    updateBody = (count) => {
      updates = count
      return new Response(JSON.stringify({ error: 'CONFLICT', message: 'stale runtime' }), { status: 409 })
    }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {}))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'still-stale', { updateId: 83, messageId: 12 }) as any)
    expect(updates).toBe(2)
    await stopPublicTelegramAdapter()
  })

  it('rejects a 200 runtime response that does not persist botId/generation', async () => {
    let polled = false
    runtimeBodies = [{ ok: true }]
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { onPoll: () => { polled = true } }))
    expect(await startPublicTelegramAdapter()).toBe(false)
    expect(polled).toBe(false)
    expect(getPublicTelegramBot()).toBeUndefined()
  })

  it('refuses to register the old bot id under a new token without getMe', async () => {
    const methods: string[] = []
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {
      methods,
      onPoll: () => {},
    }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    const getMeAtStart = methods.filter((method) => method === 'getMe').length
    writeConfig({ botToken: '333333:other-public-token', generation: 9 })
    await getPublicTelegramBot()!.handleUpdate(privateMessage(7, 'stale poller', { updateId: 41, messageId: 8 }) as any)
    await eventually(() => expect(methods.filter((method) => method === 'getMe').length).toBeGreaterThan(getMeAtStart))
    expect(posts.some((post) =>
      post.method === 'POST'
      && post.path === '/api/telegram/public/runtime'
      && post.body?.botId === 222222
      && post.body?.generation === 9
      && methods.filter((method) => method === 'getMe').length === getMeAtStart,
    )).toBe(false)
    await stopPublicTelegramAdapter()
  })

  it('answers a callback before the serial forward settles so a slow server cannot hold the spinner', async () => {
    const callbacks: Array<Record<string, unknown>> = []
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { callbacks }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    updateGate = new Promise<void>((resolve) => { releaseUpdateGate = resolve })
    const handling = getPublicTelegramBot()!.handleUpdate(
      callbackUpdate(7, { updateId: 61, queryId: 'cb-slow' }) as any,
    )
    // The HTTP forward is still blocked on the gate, yet the ACK already ran.
    await eventually(() => expect(callbacks).toHaveLength(1))
    expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(1)
    releaseUpdateGate!()
    await handling
    expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(1)
    // Exactly one answer: the early ACK, never a second one after forwarding.
    expect(callbacks).toHaveLength(1)
    await stopPublicTelegramAdapter()
  })

  it('reports a failed callback forward with a reply instead of a second answer', async () => {
    const callbacks: Array<Record<string, unknown>> = []
    const sent: string[] = []
    updateBody = { ok: false, error: '公共入口未启用' }
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, { callbacks, sent }))
    expect(await startPublicTelegramAdapter()).toBe(true)
    await getPublicTelegramBot()!.handleUpdate(callbackUpdate(7, { updateId: 62, queryId: 'cb-fail' }) as any)
    expect(callbacks).toHaveLength(1)
    expect(sent.some((text) => text.includes('公共入口未启用'))).toBe(true)
    await stopPublicTelegramAdapter()
  })

  it('keeps forwarding when the early callback answer fails', async () => {
    const callbacks: Array<Record<string, unknown>> = []
    const errors: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {
      callbacks,
      answerError: new Error('answer failed'),
    }))
    try {
      expect(await startPublicTelegramAdapter()).toBe(true)
      await getPublicTelegramBot()!.handleUpdate(callbackUpdate(7, { updateId: 51, queryId: 'cb-1' }) as any)
      expect(posts.filter((post) => post.path === '/api/telegram/public/update')).toHaveLength(1)
      expect(callbacks).toHaveLength(1)
      expect(errors.some((line) => line.includes('callback ack failed'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
    await stopPublicTelegramAdapter()
  })

  it('refuses a public bot that shares the dedicated getMe id and does not poll', async () => {
    let polled = false
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {
      me: { ...publicMe, id: 111111 },
      onPoll: () => { polled = true },
    }))
    expect(await startPublicTelegramAdapter({ dedicatedBotId: 111111 })).toBe(false)
    expect(polled).toBe(false)
    expect(posts.filter((post) => post.method === 'POST')).toEqual([])
    expect(getPublicTelegramBot()).toBeUndefined()
  })

  it('fail-closes on the token prefix before getMe when both tokens are the same bot', async () => {
    let getMe = 0
    let polled = false
    setPublicTelegramBotHook((bot) => {
      bot.api.config.use(async (_previous, method) => {
        if (method === 'getMe') getMe += 1
        return { ok: true, result: publicMe } as any
      })
      bot.start = (async (startOptions?: { onStart?: (info: typeof publicMe) => unknown }) => {
        polled = true
        await startOptions?.onStart?.(publicMe)
      }) as typeof bot.start
    })
    expect(telegramBotIdFromToken(PUBLIC_TOKEN)).toBe(222222)
    expect(await startPublicTelegramAdapter({ dedicatedBotId: 222222 })).toBe(false)
    expect(getMe).toBe(0)
    expect(polled).toBe(false)
    expect(getPublicTelegramBot()).toBeUndefined()
  })

  it('keeps getMe failures from starting polling and redacts tokens in logs', async () => {
    let polled = false
    const errors: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    setPublicTelegramBotHook((bot) => interceptPublicBot(bot, {
      getMeError: new Error(`getMe failed for ${PUBLIC_TOKEN}`),
      onPoll: () => { polled = true },
    }))
    try {
      expect(await startPublicTelegramAdapter()).toBe(false)
      expect(polled).toBe(false)
      expect(posts.filter((post) => post.method === 'POST')).toEqual([])
      expect(errors.join('\n')).not.toContain(PUBLIC_TOKEN)
      expect(errors.join('\n')).not.toContain('public-secret-token')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('Telegram dedicated start isolation', () => {
  it('swallows dedicated start failures without process.exit', async () => {
    const previous = new Map<string, string | undefined>()
    for (const key of envKeys) previous.set(key, process.env[key])
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tg-dedicated-start-')))
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.XDG_CONFIG_HOME = join(directory, 'xdg')
    process.env.TMPDIR = join(directory, 'tmp')
    mkdirSync(join(directory, 'xdg'))
    mkdirSync(join(directory, 'tmp'))
    process.env.TELEGRAM_BOT_TOKEN = DEDICATED_TOKEN
    process.env.ADAPTER_SERVER_URL = 'ws://127.0.0.1:1'
    process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = directory
    process.env.ADAPTER_DEFAULT_PROJECT_DIR = directory
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = directory
    const dedicated = await import('../dedicated.js?dedicated-start-isolation') as typeof import('../dedicated.js')
    dedicated.bot.botInfo = dedicatedMe
    dedicated.bot.api.config.use(async (_previous, method) => {
      if (method === 'getMe') return { ok: true, result: dedicatedMe } as any
      return { ok: true, result: true } as any
    })
    const start = spyOn(dedicated.bot, 'start').mockImplementation(async () => {
      throw new Error(`getMe failed for ${DEDICATED_TOKEN}`)
    })
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
    const errors: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      dedicated.startTelegramAdapter({ registerProcessShutdown: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(exit).not.toHaveBeenCalled()
      expect(errors.join('\n')).not.toContain(DEDICATED_TOKEN)
      expect(errors.join('\n')).toContain('[redacted-token]')
    } finally {
      start.mockRestore()
      exit.mockRestore()
      errorSpy.mockRestore()
      await dedicated.stopTelegramAdapter()
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})