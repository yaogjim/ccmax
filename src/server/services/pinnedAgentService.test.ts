import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import type { ConversationService } from './conversationService.js'
import {
  PinnedAgentService,
  projectWorkerMessage,
  type PinnedAgentEvent,
} from './pinnedAgentService.js'
import { ProviderService } from './providerService.js'

let home: string
let workDir: string
let originalEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'pinned-agent-service-'))
  workDir = join(home, 'project')
  await mkdir(workDir)
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

async function bind(modelId = 'deepseek-flash') {
  const provider = await new ProviderService().addProvider({
    presetId: 'custom',
    name: 'DeepSeek',
    baseUrl: 'http://127.0.0.1:32111',
    apiKey: 'fake-key',
    models: { main: 'ds-main', sonnet: 'ds-main', opus: 'ds-main', haiku: 'ds-main' },
  } as any)
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ agentRuntimeBindings: { niuma: { providerId: provider.id, modelId } } }),
  )
  return provider
}

type Sent = { sessionId: string; content: string }

/** A ConversationService stand-in that never spawns a process. */
function createFakeConversation(options: { sendAccepted?: boolean; sendGate?: Promise<void> } = {}) {
  const live = new Map<string, { workDir: string; permissionMode: string; worker: boolean }>()
  const callbacks = new Map<string, Set<(message: any) => void>>()
  const calls = {
    started: [] as Array<{ id: string; workDir: string; url: string; options: any }>,
    controls: [] as Array<{ id: string; request: any }>,
    sent: [] as Sent[],
    stopped: [] as string[],
  }
  live.set('parent', { workDir, permissionMode: 'default', worker: false })
  const fake = {
    hasSession: (id: string) => live.has(id),
    isWorkerSession: (id: string) => live.get(id)?.worker === true,
    getSessionPermissionMode: (id: string) => live.get(id)?.permissionMode ?? 'default',
    getSessionWorkDir: (id: string) => live.get(id)?.workDir ?? '',
    async startSession(id: string, dir: string, url: string, startOptions: any) {
      calls.started.push({ id, workDir: dir, url, options: startOptions })
      live.set(id, { workDir: dir, permissionMode: startOptions.permissionMode ?? 'default', worker: !!startOptions.agentWorker })
    },
    async requestControl(id: string, request: any) {
      calls.controls.push({ id, request })
      return {}
    },
    onOutput(id: string, callback: (message: any) => void) {
      const set = callbacks.get(id) ?? new Set()
      set.add(callback)
      callbacks.set(id, set)
    },
    removeOutputCallback(id: string, callback: (message: any) => void) {
      callbacks.get(id)?.delete(callback)
    },
    async sendMessage(id: string, content: string, _attachments?: unknown, sendOptions?: { canSend?: () => boolean }) {
      // The real service awaits network and token refreshes here.
      if (options.sendGate) await options.sendGate
      if (sendOptions?.canSend && !sendOptions.canSend()) return false
      calls.sent.push({ sessionId: id, content })
      return options.sendAccepted !== false
    },
    stopSession(id: string) {
      calls.stopped.push(id)
      live.delete(id)
    },
    async stopSessionAndWait(id: string) {
      calls.stopped.push(id)
      live.delete(id)
    },
  }
  return {
    conversation: fake as unknown as ConversationService,
    calls,
    live,
    emit(id: string, message: any) {
      for (const callback of [...(callbacks.get(id) ?? [])]) callback(message)
    },
    workerId: () => calls.started[0]!.id,
  }
}

const definition = {
  systemPrompt: 'You are niuma.',
  tools: ['Read'],
  description: 'Runs tasks',
}
const body = (extra: Record<string, unknown> = {}) => ({
  agentType: 'niuma',
  definition,
  prompt: 'do the thing',
  ...extra,
})

async function collect(iterable: AsyncIterable<PinnedAgentEvent>) {
  const events: PinnedAgentEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function serviceFor(fake: ReturnType<typeof createFakeConversation>, extra: Record<string, unknown> = {}) {
  return new PinnedAgentService({
    conversation: fake.conversation,
    serverPort: () => 4321,
    watchIntervalMs: 10,
    ...extra,
  })
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to be rejected')
}

describe('request parsing', () => {
  const service = new PinnedAgentService({ conversation: {} as ConversationService })

  test('rejects a runtime supplied by the caller', () => {
    for (const field of ['providerId', 'modelId', 'provider', 'model', 'runtime']) {
      expect(() => service.parseRequest(body({ [field]: 'x' }))).toThrow(/cannot be set/)
    }
  })

  test('rejects unknown fields, blank prompts and empty system prompts', () => {
    expect(() => service.parseRequest(body({ surprise: 1 }))).toThrow(/Invalid pinned agent request/)
    expect(() => service.parseRequest(body({ prompt: '   ' }))).toThrow(/prompt/)
    expect(() => service.parseRequest(body({ definition: { systemPrompt: '  ' } }))).toThrow(/systemPrompt/)
    expect(() => service.parseRequest('nope')).toThrow(/Invalid pinned agent request/)
  })

  test('accepts a minimal valid request', () => {
    expect(service.parseRequest(body()).agentType).toBe('niuma')
  })
})

describe('projectWorkerMessage', () => {
  test('keeps text and tool_use of top-level assistant messages', () => {
    const projected = projectWorkerMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }, { type: 'thinking', thinking: 'secret' }] },
    })
    expect(projected).toEqual({
      type: 'progress',
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }],
    })
  })

  test('summarizes tool results and bounds oversized content', () => {
    const projected = projectWorkerMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] }] },
    })!
    const block = projected.blocks[0] as { text: string; isError: boolean }
    expect(projected.kind).toBe('tool_result')
    expect(block.isError).toBe(true)
    expect(block.text.length).toBeLessThan(2100)
    expect(block.text.endsWith('[truncated]')).toBe(true)
  })

  test('bounds a huge tool input and drops nested-subagent and unrelated messages', () => {
    const projected = projectWorkerMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'y'.repeat(9000) } }] },
    })!
    expect((projected.blocks[0] as any).input._truncated).toBe(true)
    expect(projectWorkerMessage({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'nested' }] } })).toBeNull()
    expect(projectWorkerMessage({ type: 'system', subtype: 'init' })).toBeNull()
    expect(projectWorkerMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } })).toBeNull()
  })
})

describe('start', () => {
  test('launches a worker pinned to the configured runtime and streams started, progress, result', async () => {
    const provider = await bind()
    const fake = createFakeConversation()
    const run = await serviceFor(fake).start('parent', body({ toolUseId: 'toolu_1', agentId: 'agent-1' }))

    const [started] = fake.calls.started
    expect(started!.workDir).toBe(workDir)
    expect(started!.url).toContain('/sdk/')
    expect(started!.options.providerId).toBe(provider.id)
    expect(started!.options.model).toBe('deepseek-flash')
    expect(started!.options.agentWorker).toMatchObject({ parentSessionId: 'parent', agentType: 'niuma', systemPrompt: 'You are niuma.', tools: ['Read'] })
    expect(fake.calls.controls[0]!.request).toEqual({ subtype: 'set_model', model: 'deepseek-flash' })
    expect(fake.calls.sent).toEqual([{ sessionId: run.workerSessionId, content: 'do the thing' }])

    fake.emit(run.workerSessionId, { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })
    fake.emit(run.workerSessionId, { type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { output_tokens: 2 }, num_turns: 1, duration_ms: 7 })

    const events = await collect(run.events)
    expect(events.map(event => event.type)).toEqual(['started', 'progress', 'result'])
    expect(events[0]).toMatchObject({ provider: { id: provider.id, name: 'DeepSeek' }, requestedModel: 'deepseek-flash', model: 'deepseek-flash', toolUseId: 'toolu_1', agentId: 'agent-1' })
    expect(events[2]).toMatchObject({ ok: true, text: 'done', numTurns: 1, durationMs: 7, usage: { output_tokens: 2 } })
    // The worker is gone and its slot is free again once the result is delivered.
    await Bun.sleep(5)
    expect(fake.calls.stopped).toContain(run.workerSessionId)
    expect(serviceFor(fake).activeCount('parent')).toBe(0)
  })

  test('maps a model alias through the provider', async () => {
    await bind('opus')
    const fake = createFakeConversation()
    await serviceFor(fake).start('parent', body())
    expect(fake.calls.started[0]!.options.model).toBe('ds-main')
  })

  test('reads the binding fresh from settings on every run', async () => {
    const provider = await bind('first-model')
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    await service.start('parent', body())
    await writeFile(join(home, 'settings.json'), JSON.stringify({ agentRuntimeBindings: { niuma: { providerId: provider.id, modelId: 'second-model' } } }))
    await service.start('parent', body())
    expect(fake.calls.started.map(call => call.options.model)).toEqual(['first-model', 'second-model'])
  })

  test('refuses to run an agent whose binding was removed, without starting anything', async () => {
    await bind()
    await writeFile(join(home, 'settings.json'), '{}')
    const fake = createFakeConversation()
    const error = await rejection(serviceFor(fake).start('parent', body()))
    expect(error.statusCode).toBe(404)
    expect(error.code).toBe('PINNED_AGENT_BINDING_MISSING')
    expect(fake.calls.started).toEqual([])
    expect(serviceFor(fake).activeCount('parent')).toBe(0)
  })

  test('refuses a binding whose provider no longer exists or whose model cannot be resolved', async () => {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ agentRuntimeBindings: { niuma: { providerId: 'gone', modelId: 'x' } } }))
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    expect((await rejection(service.start('parent', body()))).code).toBe('PROVIDER_NOT_FOUND')

    await bind('fable')
    const unresolved = await rejection(service.start('parent', body()))
    expect(unresolved.statusCode).toBe(409)
    expect(unresolved.code).toBe('MODEL_UNRESOLVABLE')
    expect(fake.calls.started).toEqual([])
    expect(service.activeCount('parent')).toBe(0)
  })

  test('rejects a definition that a worker cannot honor', async () => {
    await bind()
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    const isolation = await rejection(service.start('parent', body({ definition: { ...definition, isolation: 'worktree' } })))
    expect(isolation.statusCode).toBe(400)
    expect(isolation.message).toContain('isolation')
    const mode = await rejection(service.start('parent', body({ definition: { ...definition, permissionMode: 'bypassPermissions' } })))
    expect(mode.message).toContain('permission mode')
    expect(fake.calls.started).toEqual([])
  })

  test('rejects callers that are not running sessions or are themselves workers', async () => {
    await bind()
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    expect((await rejection(service.start('missing', body()))).code).toBe('PINNED_AGENT_PARENT_UNAVAILABLE')
    fake.live.set('team-worker', { workDir, permissionMode: 'default', worker: true })
    const nested = await rejection(service.start('team-worker', body()))
    expect(nested.statusCode).toBe(403)
    expect(nested.code).toBe('PINNED_AGENT_NESTED')
  })

  test('admits at most three concurrent workers per parent, counting ones still starting', async () => {
    await bind()
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    // Concurrent requests race through admission before any worker is running.
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => service.start('parent', body())))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    const refused = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[]
    expect(refused.map(result => (result.reason as ApiError).statusCode)).toEqual([429, 429])
    expect(service.activeCount('parent')).toBe(3)

    // Another parent is unaffected; finishing one frees a slot.
    fake.live.set('other', { workDir, permissionMode: 'default', worker: false })
    await service.start('other', body())
    const first = fake.calls.started[0]!.id
    fake.emit(first, { type: 'result', subtype: 'success', result: 'ok' })
    await Bun.sleep(20)
    expect(service.activeCount('parent')).toBe(2)
    await service.start('parent', body())
  })

  test('frees the slot and the worker when startup fails', async () => {
    await bind()
    const fake = createFakeConversation()
    fake.conversation.requestControl = async () => { throw new Error('control timed out') }
    const service = serviceFor(fake)
    const error = await rejection(service.start('parent', body()))
    expect(error.statusCode).toBe(502)
    expect(fake.calls.stopped).toContain(fake.workerId())
    expect(service.activeCount('parent')).toBe(0)
  })

  test('a worker that does not accept the task ends with an error result', async () => {
    await bind()
    const fake = createFakeConversation({ sendAccepted: false })
    const run = await serviceFor(fake).start('parent', body())
    const events = await collect(run.events)
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false, errorCode: 'worker_error' })
  })

  test('an aborted request never leaves a worker behind', async () => {
    await bind()
    const fake = createFakeConversation()
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(serviceFor(fake).start('parent', body(), controller.signal))
    expect(error.statusCode).toBe(499)
    expect(fake.calls.started).toEqual([])
  })
})

describe('run lifecycle', () => {
  test('cancel stops the worker and yields exactly one cancelled result', async () => {
    await bind()
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    const run = await service.start('parent', body())
    await run.cancel()
    await run.cancel()
    // A late result from the dying process must not produce a second result.
    fake.emit(run.workerSessionId, { type: 'result', subtype: 'success', result: 'late' })
    const events = await collect(run.events)
    expect(events.filter(event => event.type === 'result')).toEqual([expect.objectContaining({ ok: false, errorCode: 'cancelled' })])
    expect(fake.calls.stopped.filter(id => id === run.workerSessionId)).toHaveLength(1)
    expect(service.activeCount('parent')).toBe(0)
  })

  test('aborting the request cancels the run', async () => {
    await bind()
    const fake = createFakeConversation()
    const controller = new AbortController()
    const run = await serviceFor(fake).start('parent', body(), controller.signal)
    controller.abort()
    const events = await collect(run.events)
    expect(events.at(-1)).toMatchObject({ type: 'result', errorCode: 'cancelled' })
    expect(fake.live.has(run.workerSessionId)).toBe(false)
  })

  test('a cancel that lands while the task is being prepared keeps it from being submitted', async () => {
    await bind()
    let release!: () => void
    const fake = createFakeConversation({ sendGate: new Promise<void>(resolve => { release = resolve }) })
    const controller = new AbortController()
    const starting = serviceFor(fake).start('parent', body(), controller.signal)
    for (let i = 0; i < 200 && fake.calls.controls.length === 0; i++) await Bun.sleep(5)
    controller.abort()
    release()
    const run = await starting
    const events = await collect(run.events)
    expect(fake.calls.sent).toEqual([])
    expect(events.filter(event => event.type === 'result')).toEqual([expect.objectContaining({ ok: false, errorCode: 'cancelled' })])
    expect(fake.live.has(run.workerSessionId)).toBe(false)
  })

  test('a parent that went away while the task was being prepared keeps it from being submitted', async () => {
    await bind()
    let release!: () => void
    const fake = createFakeConversation({ sendGate: new Promise<void>(resolve => { release = resolve }) })
    const starting = serviceFor(fake).start('parent', body())
    for (let i = 0; i < 200 && fake.calls.controls.length === 0; i++) await Bun.sleep(5)
    fake.live.delete('parent')
    release()
    const run = await starting
    const events = await collect(run.events)
    expect(fake.calls.sent).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false })
  })

  test('a worker that vanishes without a result is reported instead of hanging', async () => {
    await bind()
    const fake = createFakeConversation()
    const run = await serviceFor(fake).start('parent', body())
    fake.live.delete(run.workerSessionId)
    const events = await collect(run.events)
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false, errorCode: 'worker_stopped' })
  })

  test('stopping the parent stops its pinned worker', async () => {
    await bind()
    const fake = createFakeConversation()
    const service = serviceFor(fake)
    const run = await service.start('parent', body())
    fake.live.delete('parent')
    const events = await collect(run.events)
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false })
    expect(fake.calls.stopped).toContain(run.workerSessionId)
    expect(service.activeCount('parent')).toBe(0)
  })

  test('an error result carries its code and the worker text', async () => {
    await bind()
    const fake = createFakeConversation()
    const run = await serviceFor(fake).start('parent', body())
    fake.emit(run.workerSessionId, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })
    const events = await collect(run.events)
    expect(events.at(-1)).toMatchObject({ ok: false, text: 'boom', errorCode: 'worker_error' })
  })
})
