import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

async function eventually<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  let value: T
  do {
    value = await read()
    if (ready(value)) return value
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value!)}`)
}

let home: string
let original: NodeJS.ProcessEnv
let server: ReturnType<typeof Bun.serve>
let socket: WebSocket | undefined
let shutdown: (() => Promise<void>) | undefined
let base: string
let rootId: string
let rootHeaders: Record<string, string>
let conversation: typeof import('../../services/conversationService.js').conversationService

const PARENT_BASE_URL = 'http://127.0.0.1:32112'
const PINNED_BASE_URL = 'http://127.0.0.1:32111'
const definition = { systemPrompt: 'You are niuma.', tools: ['Read'], description: 'Runs tasks' }

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'pinned-agent-e2e-'))
  original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url)),
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    MOCK_SDK_PROVIDER_AUDIT: join(home, 'provider-audit.jsonl'),
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)

  const workDir = join(home, 'project')
  await mkdir(workDir)
  const { ProviderService } = await import('../../services/providerService.js')
  const providers = new ProviderService()
  // The session's own provider (A) is the active one; the agent is pinned to another (B).
  const parentProvider = await providers.addProvider({
    presetId: 'custom',
    name: 'Parent Provider',
    baseUrl: PARENT_BASE_URL,
    apiKey: 'fake-parent-key',
    models: { main: 'parent-main', sonnet: 'parent-main', opus: 'parent-main', haiku: 'parent-main' },
  } as any)
  await providers.activateProvider(parentProvider.id)
  const provider = await providers.addProvider({
    presetId: 'custom',
    name: 'DeepSeek',
    baseUrl: PINNED_BASE_URL,
    apiKey: 'fake-key',
    models: { main: 'ds-main', sonnet: 'ds-main', opus: 'ds-main', haiku: 'ds-main' },
  } as any)
  await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true })
  // Activating a provider wrote managed settings here; add the binding to them.
  const settingsPath = join(env.CLAUDE_CONFIG_DIR!, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'))
  await writeFile(settingsPath, JSON.stringify({
    ...settings,
    agentRuntimeBindings: { niuma: { providerId: provider.id, modelId: 'deepseek-flash' } },
  }))

  const runtime = await import('../../index.js')
  shutdown = runtime.stopServerRuntimeForShutdown
  server = runtime.startServer(0, '127.0.0.1')
  base = `http://127.0.0.1:${server.port}`
  conversation = (await import('../../services/conversationService.js')).conversationService

  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workDir }),
  })).json() as { sessionId: string }
  rootId = created.sessionId
  const events: any[] = []
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${rootId}`)
  socket.addEventListener('message', event => events.push(JSON.parse(String(event.data))))
  await eventually(() => events, values => values.some(value => value.type === 'connected'), 'root websocket')
  socket.send(JSON.stringify({ type: 'user_message', content: 'boot the parent' }))
  await eventually(() => events, values => values.some(value => value.type === 'message_complete'), 'parent turn')
  rootHeaders = headersFor(rootId)
}, 30_000)

afterAll(async () => {
  socket?.close()
  await shutdown?.()
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(home, { recursive: true, force: true })
})

function headersFor(sessionId: string) {
  const record = (conversation as unknown as { sessions: Map<string, { sdkToken: string }> }).sessions.get(sessionId)!
  return { authorization: `Bearer ${record.sdkToken}`, 'x-session-id': sessionId }
}

function run(body: unknown, headers: Record<string, string> = rootHeaders, signal?: AbortSignal) {
  return fetch(`${base}/api/pinned-agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
}

const request = (prompt: string, extra: Record<string, unknown> = {}) => ({ agentType: 'niuma', definition, prompt, ...extra })

const readers = new WeakMap<Response, AsyncGenerator<any>>()

/** Yields parsed NDJSON events as they arrive; repeated calls continue the same stream. */
function ndjson(response: Response): AsyncGenerator<any> {
  let reader = readers.get(response)
  if (!reader) {
    reader = readNdjson(response)
    readers.set(response, reader)
  }
  return reader
}

async function* readNdjson(response: Response): AsyncGenerator<any> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) yield JSON.parse(line)
    }
  }
}

async function firstEvent(response: Response) {
  const next = await ndjson(response).next()
  if (next.done) throw new Error('stream ended without an event')
  return next.value
}

test('the route only trusts a running CLI session holding its own SDK token', async () => {
  const body = JSON.stringify(request('hi'))
  const bare = await fetch(`${base}/api/pinned-agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect(bare.status).toBe(401)
  const wrongToken = await run(request('hi'), { authorization: 'Bearer nope', 'x-session-id': rootId })
  expect(wrongToken.status).toBe(401)
  // A browser page cannot use the credential either.
  const browser = await run(request('hi'), { ...rootHeaders, origin: 'http://evil.example' })
  expect(browser.status).toBe(401)
  const get = await fetch(`${base}/api/pinned-agent/run`, { headers: rootHeaders })
  expect(get.status).toBe(401)
})

test('a caller cannot choose the runtime or send a malformed request', async () => {
  const withProvider = await run(request('hi', { providerId: 'anything', modelId: 'anything' }))
  expect(withProvider.status).toBe(400)
  expect(((await withProvider.json()) as any).message).toContain('cannot be set')
  expect((await run({ agentType: 'niuma' })).status).toBe(400)
  const unbound = await run({ ...request('hi'), agentType: 'not-bound' })
  expect(unbound.status).toBe(404)
  expect(((await unbound.json()) as any).error).toBe('PINNED_AGENT_BINDING_MISSING')
})

test('runs an agent in a hidden worker and streams started then a single result', async () => {
  const response = await run(request('hello pinned', { toolUseId: 'toolu_1' }))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  const events: any[] = []
  for await (const event of ndjson(response)) events.push(event)

  expect(events[0]).toMatchObject({ type: 'started', requestedModel: 'deepseek-flash', model: 'deepseek-flash', provider: { name: 'DeepSeek' }, toolUseId: 'toolu_1' })
  expect(events.filter(event => event.type === 'result')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: 'result', ok: true, text: 'Echo: hello pinned' })

  // The worker is torn down and never shows up as a user session.
  const workerId = events[0].workerSessionId as string
  await eventually(() => conversation.hasSession(workerId), alive => !alive, 'worker stopped')
  const listed = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string }> }
  expect(listed.sessions.some(session => session.id === workerId)).toBe(false)
  expect(conversation.hasSession(rootId)).toBe(true)
})

test('the worker is sent to the pinned provider while the session stays on its own, even with runs in parallel', async () => {
  const auditPath = process.env.MOCK_SDK_PROVIDER_AUDIT!
  const audit = async () => (await readFile(auditPath, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { sessionId: string; pinnedWorker: boolean; baseUrl?: string; model?: string })

  const controllers = [0, 1].map(() => new AbortController())
  const held = await Promise.all(controllers.map((controller, index) =>
    run(request(`MOCK_RECONNECT_GATE parallel-${index}`), rootHeaders, controller.signal)))
  const started = await Promise.all(held.map(firstEvent))
  const workerIds = started.map(event => event.workerSessionId as string)
  expect(new Set(workerIds).size).toBe(2)

  const entries = await eventually(audit, all => workerIds.every(id => all.some(entry => entry.sessionId === id)), 'worker audit')
  for (const id of workerIds) {
    const worker = entries.find(entry => entry.sessionId === id)!
    expect(worker.pinnedWorker).toBe(true)
    expect(worker.baseUrl).toBe(PINNED_BASE_URL)
    expect(worker.model).toBe('deepseek-flash')
  }
  // Nothing that is not a pinned worker was pointed at the pinned provider,
  // and no pinned worker was pointed at the session's own.
  expect(entries.filter(entry => !entry.pinnedWorker).every(entry => entry.baseUrl !== PINNED_BASE_URL)).toBe(true)
  expect(entries.filter(entry => entry.pinnedWorker).every(entry => entry.baseUrl === PINNED_BASE_URL)).toBe(true)
  const parent = entries.find(entry => entry.sessionId === rootId)
  expect(parent?.pinnedWorker).toBe(false)
  expect(parent?.baseUrl).toBe(PARENT_BASE_URL)
  expect(conversation.hasSession(rootId)).toBe(true)

  // Cancelling both runs stops both workers and leaves the session alone.
  controllers.forEach(controller => controller.abort())
  for (const id of workerIds) await eventually(() => conversation.hasSession(id), alive => !alive, 'cancelled worker stopped')
  expect(conversation.hasSession(rootId)).toBe(true)
  const { pinnedAgentService } = await import('../../services/pinnedAgentService.js')
  await eventually(() => pinnedAgentService.activeCount(rootId), count => count === 0, 'pinned slots freed')
}, 30_000)

test('the CLI adapter carries a task to the worker and back, and stops it on abort', async () => {
  const { runPinnedAgent } = await import('../../../tools/AgentTool/runPinnedAgent.js')
  process.env.CC_HAHA_DESKTOP_SERVER_URL = base
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = rootHeaders.authorization!.replace('Bearer ', '')
  process.env.CC_HAHA_SESSION_ID = rootId
  const params = (prompt: string, signal: AbortSignal, state: any) => ({
    agentType: 'niuma', definition, prompt, description: 'e2e', agentId: `a${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, signal, state,
  })
  try {
    const state: any = {}
    const messages: any[] = []
    for await (const message of runPinnedAgent(params('hello adapter', new AbortController().signal, state))) messages.push(message)
    // What the Agent tool finalizes is the worker's answer, and the runtime is what the server reported.
    expect(messages.at(-1).message.content[0]).toMatchObject({ type: 'text', text: 'Echo: hello adapter' })
    expect(state.runtime).toMatchObject({ providerName: 'DeepSeek', requestedModel: 'deepseek-flash', model: 'deepseek-flash' })

    // Aborting the caller (what killing a background task or ESC does) stops the worker.
    const controller = new AbortController()
    const heldState: any = {}
    const held = runPinnedAgent(params('MOCK_RECONNECT_GATE adapter-hold', controller.signal, heldState)).next().catch(error => error)
    await eventually(() => heldState.runtime?.workerSessionId, id => Boolean(id), 'adapter worker started')
    const workerId = heldState.runtime.workerSessionId as string
    expect(conversation.isWorkerSession(workerId)).toBe(true)
    controller.abort()
    expect(await held).toBeInstanceOf(Error)
    await eventually(() => conversation.hasSession(workerId), alive => !alive, 'adapter worker stopped')
    expect(conversation.hasSession(rootId)).toBe(true)
    // The slot is released a moment after the worker goes; later tests count on all three being free.
    const { pinnedAgentService } = await import('../../services/pinnedAgentService.js')
    await eventually(() => pinnedAgentService.activeCount(rootId), count => count === 0, 'pinned slots freed')
  } finally {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
    delete process.env.CC_HAHA_SESSION_ID
  }
}, 30_000)

test('limits concurrency, frees a slot on client disconnect, and refuses nested callers', async () => {
  const controllers = [0, 1, 2].map(() => new AbortController())
  const held = await Promise.all(controllers.map((controller, index) => run(request(`MOCK_RECONNECT_GATE hold-${index}`), rootHeaders, controller.signal)))
  const started = await Promise.all(held.map(firstEvent))
  expect(started.map(event => event.type)).toEqual(['started', 'started', 'started'])
  const workerIds = started.map(event => event.workerSessionId as string)
  for (const id of workerIds) expect(conversation.isWorkerSession(id)).toBe(true)

  const fourth = await run(request('one too many'))
  expect(fourth.status).toBe(429)
  expect(((await fourth.json()) as any).error).toBe('PINNED_AGENT_LIMIT')

  // A worker cannot start workers of its own: its permission relay would have no UI.
  const nested = await run(request('nested'), headersFor(workerIds[0]!))
  expect(nested.status).toBe(403)
  expect(((await nested.json()) as any).error).toBe('PINNED_AGENT_NESTED')

  // Dropping the connection stops that worker and frees its slot.
  controllers[0]!.abort()
  await eventually(() => conversation.hasSession(workerIds[0]!), alive => !alive, 'aborted worker stopped')
  const replacement = await run(request('after disconnect'))
  expect(replacement.status).toBe(200)
  const replacementEvents: any[] = []
  for await (const event of ndjson(replacement)) replacementEvents.push(event)
  expect(replacementEvents.at(-1)).toMatchObject({ type: 'result', ok: true })

  // Stopping the parent takes its remaining workers down and ends their streams.
  const remaining = held.slice(1)
  conversation.stopSession(rootId)
  for (const response of remaining) {
    let last: any
    for await (const event of ndjson(response)) last = event
    expect(last).toMatchObject({ type: 'result', ok: false })
  }
  for (const id of workerIds) await eventually(() => conversation.hasSession(id), alive => !alive, 'worker stopped with parent')
  controllers.forEach(controller => controller.abort())
}, 30_000)
