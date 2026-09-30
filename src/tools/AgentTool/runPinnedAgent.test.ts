import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { PinnedAgentEvent } from '../../shared/pinnedAgent.js'
import { AbortError } from '../../utils/errors.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import {
  buildPinnedRuntimeInfo,
  pinnedAgentContinuationError,
  pinnedAgentPreflightError,
  runPinnedAgent,
  waitForPinnedStart,
  type PinnedRunParams,
  type PinnedRunState,
} from './runPinnedAgent.js'

const ENV_KEYS = [
  'CC_HAHA_DESKTOP_SERVER_URL',
  'CC_HAHA_SESSION_COLLABORATION_TOKEN',
  'CC_HAHA_SESSION_ID',
  'CC_HAHA_TEAM_WORKER',
  'CC_HAHA_PINNED_AGENT_WORKER',
] as const
const savedEnv: Record<string, string | undefined> = {}

const STARTED: PinnedAgentEvent = {
  type: 'started',
  workerSessionId: 'worker-1',
  provider: { id: 'deepseek', name: 'DeepSeek' },
  requestedModel: 'deepseek-flash',
  model: 'deepseek-v4-flash',
}

type Recorded = { headers: Headers; body: any }
let server: ReturnType<typeof Bun.serve> | undefined
let recorded: Recorded[] = []
let disconnects = 0

/** Serve NDJSON for one request: `events` are written in order, then the stream is held open or closed. */
function serve(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      recorded.push({ headers: req.headers, body: await req.clone().json().catch(() => null) })
      req.signal.addEventListener('abort', () => { disconnects++ })
      return handler(req)
    },
  })
  process.env.CC_HAHA_DESKTOP_SERVER_URL = `http://127.0.0.1:${server.port}`
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-token'
  process.env.CC_HAHA_SESSION_ID = 'parent-session'
}

function ndjson(events: PinnedAgentEvent[], options: { hold?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      if (!options.hold) controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
}

function params(overrides: Partial<PinnedRunParams> = {}): PinnedRunParams {
  return {
    agentType: 'niuma',
    definition: { systemPrompt: 'You are niuma' },
    prompt: 'Summarize the repository',
    description: 'Summarize',
    toolUseId: 'toolu_1',
    agentId: 'agent-run-1',
    ownerAgentId: 'owner-agent',
    signal: new AbortController().signal,
    state: {},
    ...overrides,
  }
}

async function collect(generator: AsyncGenerator<any, void>) {
  const messages: any[] = []
  for await (const message of generator) messages.push(message)
  return messages
}

let recordSpy: ReturnType<typeof spyOn>
let metadataSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  recorded = []
  disconnects = 0
  recordSpy = spyOn(sessionStorage, 'recordSidechainTranscript').mockResolvedValue(undefined as never)
  metadataSpy = spyOn(sessionStorage, 'writeAgentMetadata').mockResolvedValue(undefined as never)
})

afterEach(async () => {
  recordSpy.mockRestore()
  metadataSpy.mockRestore()
  await server?.stop(true)
  server = undefined
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('runPinnedAgent', () => {
  test('authenticates as the calling session and never sends a provider or model', async () => {
    serve(() => ndjson([STARTED, { type: 'result', ok: true, text: 'done' }]))
    await collect(runPinnedAgent(params()))

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.headers.get('authorization')).toBe('Bearer sdk-token')
    expect(recorded[0]!.headers.get('x-session-id')).toBe('parent-session')
    expect(recorded[0]!.body).toEqual({
      agentType: 'niuma',
      definition: { systemPrompt: 'You are niuma' },
      prompt: 'Summarize the repository',
      description: 'Summarize',
      toolUseId: 'toolu_1',
      agentId: 'agent-run-1',
    })
  })

  test('turns worker progress into messages, records the sidechain and reports the runtime', async () => {
    serve(() => ndjson([
      STARTED,
      { type: 'progress', kind: 'assistant', blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a' } }] },
      { type: 'progress', kind: 'tool_result', blocks: [{ type: 'tool_result', toolUseId: 'tool-1', isError: false, text: 'file body' }] },
      { type: 'progress', kind: 'assistant', blocks: [{ type: 'text', text: 'all done' }] },
      { type: 'result', ok: true, text: 'all done', usage: { input_tokens: 11, output_tokens: 7 } },
    ]))
    const state: PinnedRunState = {}
    const messages = await collect(runPinnedAgent(params({ state })))

    expect(messages.map(m => m.type)).toEqual(['assistant', 'user', 'assistant'])
    expect(messages[0].message.content[0]).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'Read' })
    expect(messages[1].message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body', is_error: false })
    // The repeated final text is one message that carries the worker's usage.
    expect(messages[2].message.content).toEqual([{ type: 'text', text: 'all done' }])
    expect(messages[2].message.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 })

    expect(state.runtime).toEqual({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      requestedModel: 'deepseek-flash',
      model: 'deepseek-v4-flash',
      workerSessionId: 'worker-1',
    })
    expect(buildPinnedRuntimeInfo(state, ['careful'])).toEqual({
      mode: 'pinned',
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      requestedModel: 'deepseek-flash',
      status: 'completed',
      warnings: ['careful'],
    })

    // Prompt first, then every yielded message, each chained to its parent.
    const recordedMessages = recordSpy.mock.calls.map((call: any[]) => call[0][0])
    expect(recordedMessages.map((m: any) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(recordedMessages[0].message.content).toBe('Summarize the repository')
    expect(recordSpy.mock.calls.every((call: any[]) => call[1] === 'agent-run-1')).toBe(true)
    expect(recordSpy.mock.calls[1]![2]).toBe(recordedMessages[0].uuid)
    expect(recordSpy.mock.calls[3]![2]).toBe(recordedMessages[2].uuid)

    expect(metadataSpy).toHaveBeenCalledTimes(1)
    expect(metadataSpy.mock.calls[0]![1]).toMatchObject({
      agentType: 'niuma',
      description: 'Summarize',
      toolUseId: 'toolu_1',
      ownerAgentId: 'owner-agent',
      runtime: { mode: 'pinned', providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', workerSessionId: 'worker-1' },
    })
  })

  test('appends the result as its own message when it differs from the last progress text', async () => {
    serve(() => ndjson([
      STARTED,
      { type: 'progress', kind: 'assistant', blocks: [{ type: 'text', text: 'thinking out loud' }] },
      { type: 'result', ok: true, text: 'the report', usage: { input_tokens: 3, output_tokens: 2 } },
    ]))
    const messages = await collect(runPinnedAgent(params()))
    expect(messages.map(m => m.message.content[0].text)).toEqual(['thinking out loud', 'the report'])
    expect(messages[1].message.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 })
  })

  test('a failed run throws with the worker error instead of looking like a success', async () => {
    serve(() => ndjson([
      STARTED,
      { type: 'progress', kind: 'assistant', blocks: [{ type: 'text', text: 'partial work' }] },
      { type: 'result', ok: false, errorCode: 'worker_error', text: 'provider rejected the model' },
    ]))
    const seen: any[] = []
    const run = (async () => { for await (const m of runPinnedAgent(params())) seen.push(m) })()
    await expect(run).rejects.toThrow('failed (worker_error): provider rejected the model')
    // Progress made before the failure is still delivered, in order.
    expect(seen.map(m => m.message.content[0].text)).toEqual(['partial work'])
  })

  test('a cancelled run surfaces as an abort', async () => {
    serve(() => ndjson([STARTED, { type: 'result', ok: false, errorCode: 'cancelled', text: 'cancelled' }]))
    await expect(collect(runPinnedAgent(params()))).rejects.toBeInstanceOf(AbortError)
  })

  test('start-up refusals carry the server message and status', async () => {
    serve(() => Response.json({ error: 'PINNED_AGENT_LIMIT', message: 'At most 3 pinned agents can run at the same time in one session' }, { status: 429 }))
    await expect(collect(runPinnedAgent(params()))).rejects.toThrow('could not start (429): At most 3 pinned agents')
    expect(recordSpy).not.toHaveBeenCalled()
  })

  test('marks the run ended when it cannot start or has finished', async () => {
    serve(() => Response.json({ error: 'PINNED_AGENT_LIMIT', message: 'busy' }, { status: 429 }))
    const failed: PinnedRunState = {}
    await collect(runPinnedAgent(params({ state: failed }))).catch(() => {})
    expect(failed.ended).toBe(true)
    expect(failed.runtime).toBeUndefined()
  })

  test('waitForPinnedStart returns once the worker started, or once the run ended without one', async () => {
    const started: PinnedRunState = {}
    setTimeout(() => { started.runtime = { providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', model: 'm', workerSessionId: 'w' } }, 40)
    const t0 = Date.now()
    await waitForPinnedStart(started, 2_000)
    expect(started.runtime?.providerName).toBe('DeepSeek')
    expect(Date.now() - t0).toBeLessThan(1_000)

    const ended: PinnedRunState = {}
    setTimeout(() => { ended.ended = true }, 40)
    const t1 = Date.now()
    await waitForPinnedStart(ended, 2_000)
    expect(ended.runtime).toBeUndefined()
    expect(Date.now() - t1).toBeLessThan(1_000)

    const t2 = Date.now()
    await waitForPinnedStart({}, 120)
    expect(Date.now() - t2).toBeGreaterThanOrEqual(100)
  })

  test('an unstructured error body is not echoed', async () => {
    serve(() => new Response('<html>secret proxy page</html>', { status: 502 }))
    const error = await collect(runPinnedAgent(params())).catch(e => e as Error)
    expect((error as Error).message).toBe('Pinned agent "niuma" could not start (502)')
  })

  test('a stream that ends without a result is reported, not treated as success', async () => {
    serve(() => ndjson([STARTED, { type: 'progress', kind: 'assistant', blocks: [{ type: 'text', text: 'half' }] }]))
    await expect(collect(runPinnedAgent(params()))).rejects.toThrow('lost its connection')
  })

  test('a malformed event is an error', async () => {
    serve(() => new Response('not json\n'))
    await expect(collect(runPinnedAgent(params()))).rejects.toThrow('malformed event')
  })

  test('aborting closes the stream so the server can stop the worker', async () => {
    serve(() => ndjson([STARTED], { hold: true }))
    const controller = new AbortController()
    const iterator = runPinnedAgent(params({ signal: controller.signal }))
    const first = iterator.next()
    // `started` produces no message; the generator is now waiting for more.
    await Bun.sleep(100)
    controller.abort()
    await expect(first).rejects.toBeInstanceOf(AbortError)
    await Bun.sleep(100)
    expect(disconnects).toBe(1)
  })

  test('abandoning the generator also closes the stream', async () => {
    serve(() => ndjson([
      STARTED,
      { type: 'progress', kind: 'assistant', blocks: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    ], { hold: true }))
    const iterator = runPinnedAgent(params())
    await iterator.next()
    await iterator.return(undefined)
    await Bun.sleep(100)
    expect(disconnects).toBe(1)
  })

  test('refuses without a desktop bridge', async () => {
    await expect(collect(runPinnedAgent(params()))).rejects.toThrow('only available in desktop sessions')
  })
})

describe('pinnedAgentPreflightError', () => {
  const base = { agentType: 'niuma', isForkPath: false }

  function withBridge<T>(fn: () => T): T {
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:9'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 't'
    process.env.CC_HAHA_SESSION_ID = 's'
    return fn()
  }

  test('a plain CLI session is refused rather than downgraded', () => {
    expect(pinnedAgentPreflightError(base)).toContain('needs the desktop app')
  })

  test('accepts an ordinary foreground call from a desktop session', () => {
    expect(withBridge(() => pinnedAgentPreflightError(base))).toBeUndefined()
  })

  test.each([
    ['fork', { isForkPath: true }, 'cannot be used as a fork'],
    ['isolation', { isolation: 'worktree' }, 'does not support isolation "worktree"'],
    ['cwd', { cwd: '/elsewhere' }, 'different working directory'],
  ])('refuses %s', (_name, extra, expected) => {
    expect(withBridge(() => pinnedAgentPreflightError({ ...base, ...extra }))).toContain(expected)
  })

  test.each(['CC_HAHA_PINNED_AGENT_WORKER', 'CC_HAHA_TEAM_WORKER'])('refuses to nest inside a worker (%s)', key => {
    process.env[key] = '1'
    expect(withBridge(() => pinnedAgentPreflightError(base))).toContain('cannot be started from a team worker or another pinned agent')
  })
})

describe('pinnedAgentContinuationError', () => {
  test('refuses an agent whose metadata says it ran pinned', async () => {
    const spy = spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({
      agentType: 'niuma',
      runtime: { mode: 'pinned', providerId: 'p', providerName: 'P', requestedModel: 'm', model: 'm', workerSessionId: 'w' },
    })
    try {
      expect(await pinnedAgentContinuationError('agent-1')).toContain('cannot be resumed or sent messages')
    } finally {
      spy.mockRestore()
    }
  })

  test('leaves ordinary and unknown agents alone', async () => {
    const spy = spyOn(sessionStorage, 'readAgentMetadata')
    try {
      spy.mockResolvedValueOnce({ agentType: 'general-purpose' })
      expect(await pinnedAgentContinuationError('agent-1')).toBeUndefined()
      spy.mockResolvedValueOnce(null)
      expect(await pinnedAgentContinuationError('agent-2')).toBeUndefined()
      spy.mockRejectedValueOnce(new Error('corrupt'))
      expect(await pinnedAgentContinuationError('agent-3')).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})
