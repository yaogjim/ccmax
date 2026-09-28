/**
 * Immediate message API (`src/server/api/notifications.ts`).
 *
 * The endpoint is the only way the proactive-send tool can reach a messaging
 * platform through the server. Two properties matter and are pinned here:
 *
 * - It is reachable **only** with the local desktop bearer token; an Anthropic
 *   API key (and any other credential) is rejected with 401.
 * - It reuses the task-notification pairing check, so an unpaired id is a
 *   visible failure and never a real send.
 *
 * Every request is served by a stubbed `fetch`, so no test touches Telegram or
 * Feishu.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleNotificationsApi } from '../api/notifications.js'
import { handleApiRequest } from '../router.js'
import { LOCAL_ACCESS_TOKEN_ENV } from '../localAccessAuth.js'
import { NotificationDeliveryStore } from '../services/notificationDeliveryStore.js'
import { resetNotificationRecoveryStateForTests } from '../services/notificationService.js'

const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY'
const FIXTURE_TOKEN = 'fixture-local-desktop-token'

type FetchCall = { url: string }

let tmpDir: string
let originalConfigDir: string | undefined
let originalToken: string | undefined
let originalAnthropicKey: string | undefined
let originalFetch: typeof globalThis.fetch
let calls: FetchCall[]

function stubFetch(handler: (call: FetchCall) => Response = () => Response.json({ ok: true, result: { message_id: 123 } })): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const call = { url: String(input) }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}

async function writeAdapters(): Promise<void> {
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
}

function sendRequest(
  body: unknown,
  { token = FIXTURE_TOKEN, method = 'POST' }: { token?: string | null; method?: string } = {},
): Request {
  return new Request('http://127.0.0.1:3456/api/notifications/send', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}

async function callSend(
  body: unknown,
  options?: { token?: string | null; method?: string },
): Promise<Response> {
  const req = sendRequest(body, options)
  return handleNotificationsApi(req, new URL(req.url), ['api', 'notifications', 'send'])
}

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalToken = process.env[LOCAL_ACCESS_TOKEN_ENV]
  originalAnthropicKey = process.env[ANTHROPIC_API_KEY_ENV]
  originalFetch = globalThis.fetch

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notifications-api-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
  process.env[ANTHROPIC_API_KEY_ENV] = 'anthropic-fixture-key'
  calls = []
  stubFetch()
  await writeAdapters()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetNotificationRecoveryStateForTests()
  restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
  restoreEnv(LOCAL_ACCESS_TOKEN_ENV, originalToken)
  restoreEnv(ANTHROPIC_API_KEY_ENV, originalAnthropicKey)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('POST /api/notifications/send', () => {
  test('Telegram 缺少消息回执时保持不确定，不能声称送达', async () => {
    stubFetch(() => Response.json({ ok: true }))
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello' })
    expect(await resp.json()).toMatchObject({
      ok: false,
      delivery: { outcome: 'indeterminate', errorCode: 'invalid_receipt', attempts: 1 },
    })
    expect(calls).toHaveLength(1)
  })

  test.each([
    { result: { message_id: 123 } },
    { ok: 'true', result: { message_id: 123 } },
    { ok: true, result: { message_id: '123' } },
    { ok: true, result: { message_id: 0 } },
    { ok: true, result: { message_id: -1 } },
    { ok: true, result: { message_id: 1.5 } },
    { ok: true, result: { message_id: Number.MAX_SAFE_INTEGER + 1 } },
    { ok: true, result: [] },
  ])('Telegram 无效成功回执保持不确定 %#', async (payload) => {
    stubFetch(() => Response.json(payload))
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello' })
    expect(await resp.json()).toMatchObject({
      ok: false,
      delivery: { outcome: 'indeterminate', errorCode: 'invalid_receipt' },
    })
    expect(calls).toHaveLength(1)
  })

  test('Telegram 不可解析的响应只记不确定，重启后同一运行不重发', async () => {
    stubFetch(() => new Response('not-json'))
    const input = { channel: 'telegram', recipient: 111, text: 'hello', runId: 'uncertain-run' }
    expect(await (await callSend(input)).json()).toMatchObject({ ok: false, delivery: { outcome: 'indeterminate' } })
    resetNotificationRecoveryStateForTests()
    expect(await (await callSend(input)).json()).toMatchObject({ ok: false })
    expect(calls).toHaveLength(1)
    const reopened = new NotificationDeliveryStore(path.join(tmpDir, 'ccmax', 'notification-deliveries.json'))
    expect(await reopened.list({ runId: 'uncertain-run' })).toMatchObject([
      { outcome: 'indeterminate', errorCode: 'invalid_receipt', attempts: 1 },
    ])
  })

  test('Telegram 有效回执透传并可由重新打开的存储查询', async () => {
    stubFetch(() => Response.json({ ok: true, result: { message_id: 271828 } }))
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello', runId: 'receipt-run' })
    expect(await resp.json()).toMatchObject({
      ok: true,
      delivery: { outcome: 'delivered', messageId: 271828 },
    })
    const reopened = new NotificationDeliveryStore(path.join(tmpDir, 'ccmax', 'notification-deliveries.json'))
    expect(await reopened.list({ runId: 'receipt-run' })).toMatchObject([
      { outcome: 'delivered', messageId: 271828, attempts: 1 },
    ])
  })

  test('sends through the shared sender to a paired recipient', async () => {
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello' })

    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      ok: boolean
      delivery?: { outcome: string; recipientId: string }
    }
    expect(body.ok).toBe(true)
    expect(body.delivery?.outcome).toBe('delivered')
    expect(body.delivery?.recipientId).toBe('111')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('api.telegram.org')
  })

  test('accepts a display-name recipient that maps to exactly one paired user', async () => {
    const resp = await callSend({ channel: 'telegram', recipient: { displayName: 'Alice' }, text: 'hi' })

    expect(resp.status).toBe(200)
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('rejects an unpaired recipient as a visible failure without contacting the platform', async () => {
    // 999 is only in the access allowlist; it is not a notification target.
    const resp = await callSend({ channel: 'telegram', recipient: 999, text: 'nope' })

    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; delivery?: { outcome: string; errorCode?: string } }
    expect(body.ok).toBe(false)
    expect(body.delivery?.outcome).toBe('failed')
    expect(body.delivery?.errorCode).toBe('recipient_not_verified')
    expect(calls).toHaveLength(0)
  })

  test('requires the local desktop bearer token', async () => {
    for (const token of [null, 'not-the-local-token']) {
      const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello' }, { token })
      expect(resp.status).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  test('does not accept the Anthropic API key as a local credential', async () => {
    const resp = await callSend(
      { channel: 'telegram', recipient: 111, text: 'hello' },
      { token: 'anthropic-fixture-key' },
    )

    expect(resp.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test('validates the channel, text and recipient before any send', async () => {
    const cases: unknown[] = [
      { channel: 'sms', recipient: 111, text: 'x' },
      { channel: 'telegram', recipient: 111, text: '   ' },
      { channel: 'telegram', recipient: 111 },
      { channel: 'telegram', text: 'x' },
      { channel: 'telegram', recipient: {}, text: 'x' },
      { channel: 'telegram', recipient: 111, text: 'x', title: 42 },
    ]
    for (const body of cases) {
      const resp = await callSend(body)
      expect(resp.status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  test('rejects an oversized body instead of truncating it silently', async () => {
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'x'.repeat(4_001) })
    expect(resp.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('is method-scoped', async () => {
    const resp = await callSend(undefined, { method: 'GET' })
    expect(resp.status).toBe(405)
  })

  test('is reachable through the API router at /api/notifications/send', async () => {
    const req = sendRequest({ channel: 'telegram', recipient: 111, text: 'via router' })
    const resp = await handleApiRequest(req, new URL(req.url))

    expect(resp.status).toBe(200)
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('never writes the local bearer token into the response body or the delivery log', async () => {
    const resp = await callSend({ channel: 'telegram', recipient: 111, text: 'hello' })
    const raw = await resp.text()
    expect(raw).not.toContain(FIXTURE_TOKEN)

    const recordPath = path.join(tmpDir, 'ccmax', 'notification-deliveries.json')
    const onDisk = await fs.readFile(recordPath, 'utf-8')
    expect(onDisk).not.toContain(FIXTURE_TOKEN)
    expect(onDisk).not.toContain('fixture-bot-token')
  })
})