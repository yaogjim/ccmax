import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import {
  DESKTOP_SERVER_URL_ENV,
  LOCAL_ACCESS_TOKEN_ENV,
  LocalScheduledTaskApiError,
  callLocalDesktopApi,
  callLocalScheduledTasksApi,
  isLocalScheduledTaskApiAvailable,
  resolveLocalDesktopApiPath,
  resolveLocalScheduledTaskBaseUrl,
} from './client.js'
import { LocalScheduledTaskTool } from './LocalScheduledTaskTool.js'
import { buildLocalScheduledTaskPrompt } from './prompt.js'

// ─── Hermetic environment ────────────────────────────────────────────────────
//
// Requests go to a loopback Bun.serve on an ephemeral port. Nothing here
// touches the developer's real desktop server or its internal token.

const ENV_KEYS = [DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV] as const
const originalEnv: Record<string, string | undefined> = {}

const FIXTURE_TOKEN = 'fixture-internal-token'

type CapturedRequest = {
  url: string
  path: string
  method: string
  authorization: string | null
  contentType: string | null
  hasSignal: boolean
  body?: unknown
  headers: Record<string, string>
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

function taskFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ab12cd34',
    cron: '30 9 * * *',
    prompt: 'Summarize the deploy log',
    enabled: true,
    recurring: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ─── Loopback harness ────────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''
let requests: CapturedRequest[] = []
let responder: Responder = () => jsonResponse({ tasks: [] })

function startServer(): void {
  requests = []
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      const raw = request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.clone().text()
      const captured: CapturedRequest = {
        url: request.url,
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get('Authorization'),
        contentType: request.headers.get('Content-Type'),
        hasSignal: true,
        headers,
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
  responder = () => jsonResponse({ tasks: [] })
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

// ─── Availability gate ───────────────────────────────────────────────────────

describe('local scheduled task availability', () => {
  test('is unavailable with no desktop server URL or token', () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    expect(resolveLocalScheduledTaskBaseUrl()).toBeNull()
    expect(isLocalScheduledTaskApiAvailable()).toBe(false)
    expect(LocalScheduledTaskTool.isEnabled()).toBe(false)
  })

  test('is unavailable when only the token is configured', () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
    expect(isLocalScheduledTaskApiAvailable()).toBe(false)
    expect(LocalScheduledTaskTool.isEnabled()).toBe(false)
  })

  test('is unavailable when the URL has no internal token', () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    expect(resolveLocalScheduledTaskBaseUrl()).toBe(baseUrl)
    expect(isLocalScheduledTaskApiAvailable()).toBe(false)
    expect(LocalScheduledTaskTool.isEnabled()).toBe(false)
  })

  test('is enabled for a loopback URL plus token', () => {
    expect(resolveLocalScheduledTaskBaseUrl()).toBe(baseUrl)
    expect(isLocalScheduledTaskApiAvailable()).toBe(true)
    expect(LocalScheduledTaskTool.isEnabled()).toBe(true)
  })

  test.each([
    ['http://0.0.0.0:3456', 'wildcard bind'],
    ['http://10.0.0.5:3456', 'private LAN address'],
    ['http://example.com', 'public host'],
    ['https://evil.test:3456', 'remote TLS host'],
    ['http://user:pass@127.0.0.1:3456', 'embedded credentials'],
    ['http://127.0.0.1:3456/api', 'unexpected path'],
    ['http://127.0.0.1:3456/?x=1', 'query string'],
    ['not-a-url', 'unparsable'],
    ['file:///etc/passwd', 'non-http scheme'],
  ])('refuses %s (%s)', url => {
    process.env[DESKTOP_SERVER_URL_ENV] = url
    process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN
    expect(resolveLocalScheduledTaskBaseUrl()).toBeNull()
    expect(isLocalScheduledTaskApiAvailable()).toBe(false)
    expect(LocalScheduledTaskTool.isEnabled()).toBe(false)
  })

  test('accepts localhost and IPv6 loopback spellings', () => {
    for (const url of ['http://localhost:3456', 'http://[::1]:3456']) {
      process.env[DESKTOP_SERVER_URL_ENV] = url
      expect(resolveLocalScheduledTaskBaseUrl()).not.toBeNull()
    }
  })
})

// ─── Call refusal when unavailable ───────────────────────────────────────────

describe('call when the local server is not configured', () => {
  test('throws an unavailable error and never reaches the network', async () => {
    delete process.env[DESKTOP_SERVER_URL_ENV]
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    let error: unknown
    try {
      await callLocalScheduledTasksApi({ method: 'GET', segments: [] })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LocalScheduledTaskApiError)
    expect((error as LocalScheduledTaskApiError).kind).toBe('unavailable')
    expect(requests).toHaveLength(0)
  })
})

// ─── Request shape ───────────────────────────────────────────────────────────

describe('local scheduled task API client', () => {
  test('sends an authenticated request to /api/scheduled-tasks', async () => {
    await callLocalScheduledTasksApi({ method: 'GET', segments: [] })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/api/scheduled-tasks')
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
  })

  test('refuses to follow a redirect instead of forwarding the token', async () => {
    responder = () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:1/steal' },
      })

    let error: unknown
    try {
      await callLocalScheduledTasksApi({ method: 'GET', segments: [] })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LocalScheduledTaskApiError)
    expect((error as LocalScheduledTaskApiError).kind).toBe('network_error')
    // Only the original request — the redirect target was never contacted.
    expect(requests).toHaveLength(1)
  })

  test('encodes each path segment so a model-supplied id cannot escape the route', async () => {
    responder = () => jsonResponse({ ok: true })
    await callLocalScheduledTasksApi({
      method: 'POST',
      segments: ['a b/c', 'run'],
    })
    expect(requests[0]!.path).toBe('/api/scheduled-tasks/a%20b%2Fc/run')
  })

  test('posts a JSON body with the content type header', async () => {
    responder = () => jsonResponse({ task: taskFixture() })
    await callLocalScheduledTasksApi({
      method: 'POST',
      segments: [],
      body: { cron: '30 9 * * *', prompt: 'hi' },
    })
    expect(requests[0]!.contentType).toBe('application/json')
    expect(requests[0]!.body).toEqual({ cron: '30 9 * * *', prompt: 'hi' })
  })

  test('surfaces the server error message on a non-ok response', async () => {
    responder = () =>
      jsonResponse({ error: 'Bad Request', message: 'Invalid cron expression' }, 400)

    let error: unknown
    try {
      await callLocalScheduledTasksApi({
        method: 'POST',
        segments: [],
        body: { cron: 'bogus', prompt: 'x' },
      })
    } catch (caught) {
      error = caught
    }
    expect((error as LocalScheduledTaskApiError).kind).toBe('http_error')
    expect((error as LocalScheduledTaskApiError).status).toBe(400)
    expect((error as Error).message).toContain('Invalid cron expression')
  })

  test('reports a timeout as its own error kind', async () => {
    responder = () => new Promise<Response>(() => {})
    let error: unknown
    try {
      await callLocalScheduledTasksApi({ method: 'GET', segments: [], timeoutMs: 30 })
    } catch (caught) {
      error = caught
    }
    expect((error as LocalScheduledTaskApiError).kind).toBe('timeout')
  })
})

// ─── Tool behavior ───────────────────────────────────────────────────────────

describe('LocalScheduledTask tool', () => {
  test('creates a task through POST /api/scheduled-tasks and returns next run time', async () => {
    responder = () => jsonResponse({ task: taskFixture() }, 201)
    const result = await LocalScheduledTaskTool.call(
      {
        action: 'create',
        cron: '30 9 * * *',
        prompt: 'Summarize the deploy log',
        name: 'Deploy digest',
        notification: { enabled: true, channels: ['desktop'] },
      },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )

    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.body).toMatchObject({
      cron: '30 9 * * *',
      prompt: 'Summarize the deploy log',
      name: 'Deploy digest',
      notification: { enabled: true, channels: ['desktop'] },
    })
    expect(result.data.task?.id).toBe('ab12cd34')
    expect(result.data.task?.nextRunAt).toBeString()
    expect(result.data.message).toContain('ab12cd34')
  })

  test('passes explicit notification recipients through for server-side validation', async () => {
    responder = () => jsonResponse({ task: taskFixture() }, 201)
    await LocalScheduledTaskTool.call(
      {
        action: 'create',
        cron: '0 8 * * *',
        prompt: 'Morning brief',
        notification: {
          enabled: true,
          channels: ['telegram', 'feishu'],
          recipients: { telegram: [{ userId: 42, displayName: 'Alice' }], feishu: ['ou_abc'] },
        },
      },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )

    expect(requests[0]!.body).toMatchObject({
      notification: {
        enabled: true,
        channels: ['telegram', 'feishu'],
        recipients: { telegram: [{ userId: 42, displayName: 'Alice' }], feishu: ['ou_abc'] },
      },
    })
  })

  test('lists tasks with GET and never echoes the internal token', async () => {
    responder = () => jsonResponse({ tasks: [taskFixture()] })
    const result = await LocalScheduledTaskTool.call(
      { action: 'list' },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(result.data.tasks).toHaveLength(1)

    const serialized = JSON.stringify(result.data)
    expect(serialized).not.toContain(FIXTURE_TOKEN)
    const block = LocalScheduledTaskTool.mapToolResultToToolResultBlockParam(
      result.data,
      'toolu_1',
    )
    expect(JSON.stringify(block)).not.toContain(FIXTURE_TOKEN)
    expect(String(block.content)).not.toContain(FIXTURE_TOKEN)
  })

  test('enable and disable both PUT an explicit enabled flag', async () => {
    for (const [action, expected] of [
      ['enable', true],
      ['disable', false],
    ] as const) {
      requests = []
      responder = () => jsonResponse({ task: taskFixture({ enabled: expected }) })
      await LocalScheduledTaskTool.call(
        { action, id: 'ab12cd34' },
        makeToolUseContext(),
        undefined as never,
        undefined as never,
      )
      expect(requests[0]!.method).toBe('PUT')
      expect(requests[0]!.path).toBe('/api/scheduled-tasks/ab12cd34')
      expect(requests[0]!.body).toEqual({ enabled: expected })
    }
  })

  test('update sends only the provided fields', async () => {
    responder = () => jsonResponse({ task: taskFixture() })
    await LocalScheduledTaskTool.call(
      { action: 'update', id: 'ab12cd34', prompt: 'New prompt', cron: '5 10 * * *' },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(requests[0]!.method).toBe('PUT')
    expect(requests[0]!.body).toEqual({ prompt: 'New prompt', cron: '5 10 * * *' })
  })

  test('delete maps to DELETE and run maps to POST /:id/run', async () => {
    responder = () => jsonResponse({ ok: true })
    await LocalScheduledTaskTool.call(
      { action: 'delete', id: 'ab12cd34' },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(requests[0]!.method).toBe('DELETE')
    expect(requests[0]!.path).toBe('/api/scheduled-tasks/ab12cd34')

    requests = []
    await LocalScheduledTaskTool.call(
      { action: 'run', id: 'ab12cd34' },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.path).toBe('/api/scheduled-tasks/ab12cd34/run')
  })

  test('rejects an id that is not a plain task id before any request', async () => {
    for (const id of ['../../etc/passwd', 'a b', 'x'.repeat(65), '']) {
      const validation = await LocalScheduledTaskTool.validateInput?.(
        { action: 'delete', id } as never,
        makeToolUseContext(),
      )
      expect(validation?.result).toBe(false)
    }

    requests = []
    let rejected = false
    try {
      await LocalScheduledTaskTool.call(
        { action: 'delete', id: '../../etc/passwd' },
        makeToolUseContext(),
        undefined as never,
        undefined as never,
      )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    expect(requests).toHaveLength(0)
  })

  test('rejects unusable notification recipients before any request', async () => {
    const oversized = Array.from({ length: 21 }, () => 'ou_user')
    const cases: unknown[] = [
      { action: 'create', cron: '0 9 * * *', prompt: 'x', notification: { enabled: true, channels: ['sms'] } },
      { action: 'create', cron: '0 9 * * *', prompt: 'x', notification: { enabled: true, channels: ['telegram'], recipients: { telegram: oversized } } },
      { action: 'create', cron: '0 9 * * *', prompt: 'x', notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['x'.repeat(200)] } } },
      { action: 'create', cron: '0 9 * * *', prompt: 'x', notification: { enabled: true, channels: ['telegram'], recipients: { telegram: [{ evil: true }] } } },
      { action: 'create', cron: '0 9 * * *', prompt: 'x', notification: { enabled: true, channels: ['telegram'], recipients: { slack: ['u1'] } } },
    ]
    for (const input of cases) {
      requests = []
      let threw = false
      try {
        await LocalScheduledTaskTool.call(
          input as never,
          makeToolUseContext(),
          undefined as never,
          undefined as never,
        )
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(requests).toHaveLength(0)
    }
  })

  test('rejects create without a cron or prompt', async () => {
    for (const input of [
      { action: 'create', prompt: 'no cron' },
      { action: 'create', cron: '0 9 * * *' },
    ]) {
      requests = []
      let threw = false
      try {
        await LocalScheduledTaskTool.call(
          input as never,
          makeToolUseContext(),
          undefined as never,
          undefined as never,
        )
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(requests).toHaveLength(0)
    }
  })

  test('explains the actual default working directory for an omitted folderPath', () => {
    const prompt = buildLocalScheduledTaskPrompt()
    expect(prompt).toContain('folderPath')
    expect(prompt).toContain('home directory')
    expect(prompt).toContain('current project')
  })

  test('the model-facing prompt never contains the internal token', () => {
    const prompt = buildLocalScheduledTaskPrompt()
    expect(prompt).not.toContain(FIXTURE_TOKEN)
    expect(prompt).toContain('LocalScheduledTask')
  })
})

// ─── Shared authenticated transport ─────────────────────────────────────────
//
// The proactive-send work will need the same loopback origin + bearer token
// boundary the scheduled-task tool already enforces. These tests pin that the
// transport is reusable for another `/api/` route without widening where the
// credential can go.

describe('local desktop API client (shared transport)', () => {
  test('authenticates an arbitrary /api/ route through the same boundary', async () => {
    responder = () => jsonResponse({ accepted: true })
    const result = await callLocalDesktopApi<{ accepted: boolean }>({
      path: '/api/outbound-messages',
      method: 'POST',
      body: { channel: 'telegram', recipientId: '42', text: 'hello' },
    })

    expect(result).toEqual({ accepted: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/api/outbound-messages')
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
    expect(requests[0]!.contentType).toBe('application/json')
    expect(requests[0]!.body).toEqual({ channel: 'telegram', recipientId: '42', text: 'hello' })
  })

  test('refuses a path outside /api/ before making any request', async () => {
    const rejected = [
      '/health',
      '/api/../../etc/passwd',
      '/api/../openai-oauth',
      '/api//double',
      '/api/trailing/',
      '/api/query?token=leak',
      '/api/fragment#x',
      'api/relative',
      'http://evil.test/api/x',
      '',
    ]
    for (const path of rejected) {
      requests = []
      let error: unknown
      try {
        await callLocalDesktopApi({ path, method: 'POST', body: { text: 'x' } })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(LocalScheduledTaskApiError)
      expect((error as LocalScheduledTaskApiError).kind).toBe('invalid_url')
      expect(requests).toHaveLength(0)
    }
  })

  test('accepts a normalized /api/ path and normalizes only the leading slash form', () => {
    expect(resolveLocalDesktopApiPath('/api/outbound-messages')).toBe('/api/outbound-messages')
    expect(resolveLocalDesktopApiPath('/api/tasks/a%20b/run')).toBe('/api/tasks/a%20b/run')
    expect(resolveLocalDesktopApiPath('/api')).toBeNull()
    expect(resolveLocalDesktopApiPath('/API/x')).toBeNull()
  })

  test('is unavailable, not fake-successful, when the desktop token is missing', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    let error: unknown
    try {
      await callLocalDesktopApi({ path: '/api/outbound-messages', method: 'POST', body: { text: 'x' } })
    } catch (caught) {
      error = caught
    }
    expect((error as LocalScheduledTaskApiError).kind).toBe('unavailable')
    expect(requests).toHaveLength(0)
  })
})