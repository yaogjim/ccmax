import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import {
  DESKTOP_SERVER_URL_ENV,
  LOCAL_ACCESS_TOKEN_ENV,
  LocalScheduledTaskApiError,
} from './client.js'
import { LocalMessageSendTool } from './LocalMessageSendTool.js'
import {
  LOCAL_MESSAGE_SEND_DESCRIPTION,
  buildLocalMessageSendPrompt,
} from './LocalMessageSendTool.prompt.js'

// ─── Hermetic environment ────────────────────────────────────────────────────
//
// Requests go to a loopback Bun.serve on an ephemeral port. Nothing here touches
// the developer's real desktop server, its internal token, or a real messaging
// platform.

const ENV_KEYS = [DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV] as const
const originalEnv: Record<string, string | undefined> = {}

const FIXTURE_TOKEN = 'fixture-internal-token'

type CapturedRequest = {
  path: string
  method: string
  authorization: string | null
  contentType: string | null
  body?: unknown
}

type Responder = (request: CapturedRequest) => Response | Promise<Response>

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A successful delivery, exactly as `POST /api/notifications/send` shapes it. */
function deliveredFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    delivery: {
      channel: 'telegram',
      recipientId: '111',
      recipientLabel: 'Alice',
      outcome: 'delivered',
      attempts: 1,
    },
    issues: [],
    recordPath: '/tmp/notification-deliveries.json',
    ...overrides,
  }
}

// ─── Loopback harness ────────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''
let requests: CapturedRequest[] = []
let responder: Responder = () => jsonResponse(deliveredFixture())

function startServer(): void {
  requests = []
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const raw = request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.clone().text()
      const captured: CapturedRequest = {
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get('Authorization'),
        contentType: request.headers.get('Content-Type'),
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      }
      requests.push(captured)
      return await responder(captured)
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  responder = () => jsonResponse(deliveredFixture())
  startServer()
  process.env[DESKTOP_SERVER_URL_ENV] = baseUrl
  process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
})

afterEach(() => {
  server?.stop(true)
  server = null
  for (const key of ENV_KEYS) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

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

// ─── Availability gate ───────────────────────────────────────────────────────

describe('LocalMessageSend availability', () => {
  test('is invisible with no desktop server URL or token', () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    expect(LocalMessageSendTool.isEnabled()).toBe(false)
  })

  test('is invisible when only the token is present', () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
    expect(LocalMessageSendTool.isEnabled()).toBe(false)
  })

  test('is visible only for a loopback origin plus the internal token', () => {
    expect(LocalMessageSendTool.isEnabled()).toBe(true)

    for (const url of ['http://10.0.0.5:3456', 'http://example.com', 'https://evil.test']) {
      process.env[DESKTOP_SERVER_URL_ENV] = url
      expect(LocalMessageSendTool.isEnabled()).toBe(false)
    }
  })

  test('an unavailable tool refuses before reaching the network', async () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message.toLowerCase()).toContain('unavailable')
    expect(requests).toHaveLength(0)
  })
})

// ─── Protocol ────────────────────────────────────────────────────────────────

describe('LocalMessageSend protocol', () => {
  test('posts channel/recipient/text to the local send route with the internal bearer token', async () => {
    const result = await callTool({ channel: 'telegram', recipient: 111, text: 'hello there' })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/api/notifications/send')
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
    expect(requests[0]!.contentType).toBe('application/json')
    expect(requests[0]!.body).toEqual({ channel: 'telegram', recipient: 111, text: 'hello there' })

    expect(result.data.message).toContain('Alice')
    expect(result.data.channel).toBe('telegram')
    expect(result.data.recipientId).toBe('111')
  })

  test('passes an explicit object recipient through unchanged for server-side pairing checks', async () => {
    await callTool({
      channel: 'feishu',
      recipient: { userId: 'ou_abc', displayName: 'Fei One' },
      text: 'ping',
    })
    expect(requests[0]!.body).toEqual({
      channel: 'feishu',
      recipient: { userId: 'ou_abc', displayName: 'Fei One' },
      text: 'ping',
    })
  })

  test('surfaces a server-side recipient rejection as a real error, never a fake success', async () => {
    responder = () => jsonResponse({
      ok: false,
      delivery: {
        channel: 'telegram',
        recipientId: '999',
        recipientLabel: '999',
        outcome: 'failed',
        attempts: 0,
        errorCode: 'recipient_not_verified',
        error: 'telegram 收件人「999」未在服务端配对记录（pairedUsers）中登记，拒绝投递',
      },
      issues: [{
        channel: 'telegram',
        code: 'recipient_not_verified',
        message: 'telegram 收件人「999」未在服务端配对记录（pairedUsers）中登记，拒绝投递',
      }],
      recordPath: '/tmp/notification-deliveries.json',
    })

    const message = await callToolError({ channel: 'telegram', recipient: 999, text: 'nope' })
    expect(message).toContain('999')
    expect(message).toContain('未在服务端配对记录')
  })

  test('surfaces an indeterminate delivery as a real error', async () => {
    responder = () => jsonResponse({
      ok: false,
      delivery: {
        channel: 'telegram',
        recipientId: '111',
        recipientLabel: 'Alice',
        outcome: 'indeterminate',
        attempts: 3,
        errorCode: 'timeout',
        error: 'sendMessage timed out after 10000ms',
      },
      issues: [],
      recordPath: '/tmp/notification-deliveries.json',
    })

    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message).toContain('timed out')
  })

  test('surfaces a missing delivery confirmation as an error', async () => {
    responder = () => jsonResponse({ ok: true, issues: [], recordPath: '/tmp/x' })
    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message.length).toBeGreaterThan(0)
  })

  test('maps an HTTP failure to a real error with the server message', async () => {
    responder = () => jsonResponse({ error: 'UNAUTHORIZED', message: 'requires the local desktop access token' }, 401)
    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message).toContain('401')
    expect(message).toContain('local desktop access token')
  })

  test('reports a missing desktop token as unavailable, not a fake success', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    const message = await callToolError({ channel: 'telegram', recipient: 111, text: 'hi' })
    expect(message.toLowerCase()).toContain('unavailable')
    expect(requests).toHaveLength(0)
  })
})

// ─── Input validation ────────────────────────────────────────────────────────

describe('LocalMessageSend input validation', () => {
  test('rejects unusable input before making any request', async () => {
    const cases: unknown[] = [
      { channel: 'telegram', text: 'hi' }, // no recipient — no default broadcast
      { channel: 'telegram', recipient: 111 }, // no text
      { channel: 'telegram', recipient: 111, text: '   ' }, // blank text
      { channel: 'telegram', recipient: '', text: 'hi' }, // empty recipient
      { channel: 'telegram', recipient: {}, text: 'hi' }, // neither id nor name
      { channel: 'sms', recipient: 111, text: 'hi' }, // unsupported channel
      { channel: 'desktop', recipient: 111, text: 'hi' }, // desktop channel is not an IM send
      { channel: 'telegram', recipient: 111, text: 'x'.repeat(4_001) }, // oversized
      { channel: 'telegram', recipient: 'x'.repeat(200), text: 'hi' }, // oversized recipient
      { channel: 'telegram', recipient: 111, text: 'hi', url: 'http://evil.test' }, // unknown field
      { channel: 'telegram', recipient: 111, text: 'hi', token: 'leak' }, // credential-looking field
    ]
    for (const input of cases) {
      requests = []
      const message = await callToolError(input)
      expect(message.length).toBeGreaterThan(0)
      expect(requests).toHaveLength(0)
    }
  })

  test('validateInput rejects the same malformed inputs', async () => {
    const cases: unknown[] = [
      { channel: 'telegram', text: 'hi' },
      { channel: 'telegram', recipient: 111, text: '   ' },
      { channel: 'telegram', recipient: {}, text: 'hi' },
      { channel: 'sms', recipient: 111, text: 'hi' },
    ]
    for (const input of cases) {
      const validation = await LocalMessageSendTool.validateInput?.(
        input as never,
        makeToolUseContext(),
      )
      expect(validation?.result).toBe(false)
    }
  })

  test('a rejected call is a plain Error, not an unavailable transport error', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    let error: unknown
    try {
      await callTool({ channel: 'telegram', recipient: 111, text: 'hi' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LocalScheduledTaskApiError)
  })
})

// ─── Model-facing text ───────────────────────────────────────────────────────

describe('LocalMessageSend model-facing description', () => {
  test('the description states server-side pairing verification and explicit user intent', () => {
    expect(LOCAL_MESSAGE_SEND_DESCRIPTION).toContain('LocalMessageSend')
    expect(LOCAL_MESSAGE_SEND_DESCRIPTION.toLowerCase()).toContain('paired')
    expect(LOCAL_MESSAGE_SEND_DESCRIPTION.toLowerCase()).toContain('explicitly')
  })

  test('the prompt states pairing verification, explicit request, and no broadcast', () => {
    const prompt = buildLocalMessageSendPrompt()
    expect(prompt).toContain('LocalMessageSend')
    expect(prompt.toLowerCase()).toContain('paired')
    expect(prompt.toLowerCase()).toContain('explicitly')
    // No default broadcast and no guessed recipient.
    expect(prompt.toLowerCase()).toMatch(/broadcast|do not guess|never guess|no default/)
  })

  test('never leaks the internal token and never instructs a raw HTTP request', () => {
    const combined = `${LOCAL_MESSAGE_SEND_DESCRIPTION}\n${buildLocalMessageSendPrompt()}`
    expect(combined).not.toContain(FIXTURE_TOKEN)
    expect(combined).not.toMatch(/bearer/i)
    expect(combined).not.toContain('CC_HAHA_LOCAL_ACCESS_TOKEN')
    expect(combined).not.toMatch(/https?:\/\//)
  })

  test('the tool result never echoes the internal token', async () => {
    const result = await callTool({ channel: 'telegram', recipient: 111, text: 'hello' })
    const serialized = JSON.stringify(result.data)
    expect(serialized).not.toContain(FIXTURE_TOKEN)
    const block = LocalMessageSendTool.mapToolResultToToolResultBlockParam(
      result.data as never,
      'toolu_1',
    )
    expect(JSON.stringify(block)).not.toContain(FIXTURE_TOKEN)
    expect(String(block.content)).not.toContain(FIXTURE_TOKEN)
  })
})