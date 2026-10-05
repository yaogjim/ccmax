/**
 * Integration test: LocalMessageSend drives the desktop's real
 * `/api/notifications/send` handler with the internal bearer token, and the
 * handler resolves the recipient against real paired-account records.
 *
 * Everything is loopback + a temporary HOME/CLAUDE_CONFIG_DIR. The only
 * "platform" call (Telegram) is intercepted by a stubbed `fetch`, so no test
 * touches a real messaging service.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { handleApiRequest } from '../../server/router.js'
import { requireAuth } from '../../server/middleware/auth.js'
import { setSendPublicSessionReportForTests } from '../../server/services/notificationService.js'
import { DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV } from './client.js'
import { LocalMessageSendTool } from './LocalMessageSendTool.js'

const FIXTURE_TOKEN = 'fixture-internal-token'

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
}

let tmpDir: string
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''
let originalFetch: typeof globalThis.fetch
const platformCalls: Array<{ url: string; body?: unknown }> = []
const originalEnv: Record<string, string | undefined> = {}

async function callTool(input: unknown): Promise<{ data: Record<string, unknown> }> {
  return (await LocalMessageSendTool.call(
    input as never,
    makeToolUseContext(),
    undefined as never,
    undefined as never,
  )) as { data: Record<string, unknown> }
}

async function callToolError(input: unknown): Promise<string> {
  try {
    await callTool(input)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-message-send-'))
  for (const key of ['CLAUDE_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV] as const) {
    originalEnv[key] = process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.HOME = tmpDir
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg')
  process.env.TMPDIR = path.join(tmpDir, 'tmp')
  process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
  await fs.mkdir(process.env.XDG_CONFIG_HOME, { recursive: true })
  await fs.mkdir(process.env.TMPDIR, { recursive: true })

  await fs.writeFile(
    path.join(tmpDir, 'adapters.json'),
    JSON.stringify({
      telegram: {
        botToken: 'fixture-bot-token',
        allowedUsers: [999],
        pairedUsers: [{ userId: 111, displayName: 'Alice', pairedAt: 1 }],
      },
      feishu: {
        appId: 'cli_fixture',
        appSecret: 'fixture-app-secret',
        pairedUsers: [{ userId: 'ou_1', displayName: 'Fei One', pairedAt: 1 }],
      },
    }),
    'utf-8',
  )

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const authError = await requireAuth(request)
      if (authError) return authError
      const url = new URL(request.url)
      return handleApiRequest(request, url)
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  process.env[DESKTOP_SERVER_URL_ENV] = baseUrl

  // Route the tool's own loopback request to the real server, and intercept
  // everything else (the Telegram/Feishu platform call) with a fixture.
  platformCalls.length = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(baseUrl)) return originalFetch(input as never, init)
    const raw = init?.body ? String(init.body) : undefined
    platformCalls.push({ url, ...(raw ? { body: JSON.parse(raw) as unknown } : {}) })
    return Response.json({ ok: true, result: { message_id: 1 } })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  setSendPublicSessionReportForTests(null)
  server?.stop(true)
  server = null
  for (const key of Object.keys(originalEnv)) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('LocalMessageSend against the real local send API', () => {
  test('delivers to a paired recipient and reports success', async () => {
    const result = await callTool({ channel: 'telegram', recipient: 111, text: 'hello' })

    expect(platformCalls).toHaveLength(1)
    expect(platformCalls[0]!.url).toContain('api.telegram.org')
    expect((platformCalls[0]!.body as Record<string, unknown>).chat_id).toBe(111)
    expect((platformCalls[0]!.body as Record<string, unknown>).text).toBe('hello')

    expect(result.data.channel).toBe('telegram')
    expect(result.data.recipientId).toBe('111')
    expect(String(result.data.message)).toContain('Alice')
  })

  test('refuses an unpaired recipient as a visible error without contacting the platform', async () => {
    // 999 is only in the access allowlist, never a notification target.
    const message = await callToolError({ channel: 'telegram', recipient: 999, text: 'nope' })

    expect(message).toContain('999')
    expect(message).toContain('配对记录')
    expect(platformCalls).toHaveLength(0)
  })

  test('refuses a request without the internal bearer token', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    // The tool is now unavailable, so it never reaches the API at all.
    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message.toLowerCase()).toContain('unavailable')
    expect(platformCalls).toHaveLength(0)
  })

  test('feishu still delivers to a paired recipient', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(baseUrl)) return originalFetch(input as never, init)
      const raw = init?.body ? String(init.body) : undefined
      platformCalls.push({ url, ...(raw ? { body: JSON.parse(raw) as unknown } : {}) })
      if (url.includes('tenant_access_token')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token' })
      }
      return Response.json({ code: 0, data: { message_id: 'om_1' } })
    }) as typeof fetch

    const result = await callTool({ channel: 'feishu', recipient: 'ou_1', text: 'hello feishu' })
    expect(result.data.channel).toBe('feishu')
    expect(result.data.recipientId).toBe('ou_1')
    expect(platformCalls.some(call => call.url.includes('open.feishu.cn'))).toBe(true)
  })

  test('public send cannot bypass a missing subscription and does not use the dedicated token', async () => {
    setSendPublicSessionReportForTests(async (sessionId) => {
      if (sessionId !== 'sess-sub') throw new Error('未订阅该会话')
      return { queued: true }
    })
    const original = getSessionId()
    switchSession('sess-other' as SessionId)
    try {
      const message = await callToolError({ channel: 'telegram', entrypoint: 'public', text: 'report' })
      expect(message).toContain('未订阅')
      expect(platformCalls).toHaveLength(0)
    } finally {
      switchSession(original)
    }
  })

  test('public queued success is not reported as sent or delivered', async () => {
    setSendPublicSessionReportForTests(async () => ({ queued: true }))
    const original = getSessionId()
    switchSession('sess-sub' as SessionId)
    try {
      const result = await callTool({ channel: 'telegram', entrypoint: 'public', text: 'report' })
      expect(result.data.outcome).toBe('pending')
      expect(result.data.queued).toBe(true)
      expect(String(result.data.message)).toContain('待发队列')
      expect(String(result.data.message).toLowerCase()).not.toMatch(/delivered|sent/)
      expect(platformCalls).toHaveLength(0)
    } finally {
      switchSession(original)
    }
  })

  test('dedicated send cannot bypass the current SessionStore binding when public is enabled', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({
        telegram: {
          botToken: 'fixture-bot-token',
          allowedUsers: [999],
          pairedUsers: [{ userId: 111, displayName: 'Alice', pairedAt: 1 }],
          public: { enabled: true, botToken: 'public-token' },
        },
        feishu: {
          appId: 'cli_fixture',
          appSecret: 'fixture-app-secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Fei One', pairedAt: 1 }],
        },
      }),
    )
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        '111': { sessionId: 'sess-bound', workDir: '/tmp', updatedAt: 1 },
      }),
    )
    const original = getSessionId()
    switchSession('sess-other' as SessionId)
    try {
      const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hello' })
      expect(message).toContain('专属')
      expect(platformCalls).toHaveLength(0)
    } finally {
      switchSession(original)
    }
  })
})