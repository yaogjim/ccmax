import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleTelegramPublicApi } from './telegramPublic.js'
import { handleApiRequest } from '../router.js'
import { TelegramPublicService, setTelegramPublicServiceForTests } from '../services/telegramPublicService.js'
import { TelegramPublicStore } from '../services/telegramPublicStore.js'

const OWNER = 4242
const BOT = 99
const GEN = 3

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('telegram public HTTP API', () => {
  const previous = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    TMPDIR: process.env.TMPDIR,
  }
  let root = ''
  let service: TelegramPublicService

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-public-api-'))
    process.env.HOME = path.join(root, 'home')
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
    process.env.TMPDIR = path.join(root, 'tmp')
    await fs.mkdir(process.env.HOME, { recursive: true })
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    const work = path.join(root, 'proj')
    await fs.mkdir(work, { recursive: true })
    service = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(process.env.CLAUDE_CONFIG_DIR, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({
        telegram: { public: { enabled: true, botToken: 't', ownerUserId: OWNER, generation: GEN, allowedProjectRoots: [work] } },
      }),
      getSessionSummary: async id => id === 'sess-a'
        ? { id, title: 'A', projectPath: work, projectRoot: work, workDir: work }
        : null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async () => ({ outcome: 'delivered', messageId: 1 }),
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    setTelegramPublicServiceForTests(service)
    await service.start()
  })

  afterEach(async () => {
    service.stop()
    setTelegramPublicServiceForTests(null)
    restoreEnv('HOME', previous.HOME)
    restoreEnv('CLAUDE_CONFIG_DIR', previous.CLAUDE_CONFIG_DIR)
    restoreEnv('XDG_CONFIG_HOME', previous.XDG_CONFIG_HOME)
    restoreEnv('TMPDIR', previous.TMPDIR)
    await fs.rm(root, { recursive: true, force: true })
  })

  function request(method: string, pathname: string, body?: unknown) {
    const url = new URL(pathname, 'http://127.0.0.1:3456')
    const req = new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { req, url, segments: url.pathname.split('/').filter(Boolean) }
  }

  test('runtime / status / subscriptions 路由', async () => {
    const runtime = request('POST', '/api/telegram/public/runtime', { botId: BOT, generation: GEN })
    const runtimeRes = await handleTelegramPublicApi(runtime.req, runtime.url, runtime.segments)
    expect(runtimeRes.status).toBe(200)
    const sub = request('POST', '/api/telegram/public/subscriptions', { sessionId: 'sess-a' })
    const subRes = await handleTelegramPublicApi(sub.req, sub.url, sub.segments)
    expect(subRes.status).toBe(200)
    const status = request('GET', '/api/telegram/public/status')
    const statusJson = await (await handleTelegramPublicApi(status.req, status.url, status.segments)).json() as {
      botId?: number
      generation: number
      running: boolean
      ownerUserId: number | null
      subscriptions: unknown[]
      deliveries: unknown[]
    }
    expect(statusJson.botId).toBe(BOT)
    expect(statusJson.generation).toBe(GEN)
    expect(statusJson.running).toBe(true)
    expect(statusJson.ownerUserId).toBe(OWNER)
    expect(statusJson.subscriptions).toHaveLength(1)
    expect(Array.isArray(statusJson.deliveries)).toBe(true)
    const routed = await handleApiRequest(status.req, status.url)
    expect(routed.status).toBe(200)
    const del = request('DELETE', '/api/telegram/public/subscriptions/sess-a')
    expect((await handleTelegramPublicApi(del.req, del.url, del.segments)).status).toBe(200)
  })

  test('update 校验 botId 并转发入站 update', async () => {
    await service.registerRuntime({ botId: BOT, generation: GEN })
    const bad = request('POST', '/api/telegram/public/update', { botId: 0, generation: GEN, update: { update_id: 1 } })
    expect((await handleTelegramPublicApi(bad.req, bad.url, bad.segments)).status).toBe(400)
    const ok = request('POST', '/api/telegram/public/update', {
      botId: BOT,
      generation: GEN,
      update: {
        update_id: 9,
        message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: '/subscriptions' },
      },
    })
    expect((await handleTelegramPublicApi(ok.req, ok.url, ok.segments)).status).toBe(200)
    const staleGen = request('POST', '/api/telegram/public/update', {
      botId: BOT,
      generation: GEN - 1,
      update: { update_id: 10, message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: 'x' } },
    })
    const staleRes = await handleTelegramPublicApi(staleGen.req, staleGen.url, staleGen.segments)
    expect(staleRes.status).toBe(200)
    expect(await staleRes.json()).toEqual({ ok: false, error: 'Bot 运行时身份与配置代次不一致' })
    const staleBot = request('POST', '/api/telegram/public/update', {
      botId: BOT + 1,
      generation: GEN,
      update: { update_id: 11, message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: 'x' } },
    })
    const staleBotRes = await handleTelegramPublicApi(staleBot.req, staleBot.url, staleBot.segments)
    expect(staleBotRes.status).toBe(200)
    expect(await staleBotRes.json()).toEqual({ ok: false, error: 'Bot 运行时未注册或已停止' })
  })

  test('DELETE runtime 清除 running 并保留 botId', async () => {
    await service.registerRuntime({ botId: BOT, generation: GEN })
    const del = request('DELETE', '/api/telegram/public/runtime', { botId: BOT, generation: GEN })
    const delRes = await handleTelegramPublicApi(del.req, del.url, del.segments)
    expect(delRes.status).toBe(200)
    const status = request('GET', '/api/telegram/public/status')
    const json = await (await handleTelegramPublicApi(status.req, status.url, status.segments)).json() as {
      running: boolean
      botId?: number
    }
    expect(json.running).toBe(false)
    expect(json.botId).toBe(BOT)
    const mismatch = request('DELETE', '/api/telegram/public/runtime', { botId: BOT, generation: GEN })
    expect((await handleTelegramPublicApi(mismatch.req, mismatch.url, mismatch.segments)).status).toBe(400)
  })
})