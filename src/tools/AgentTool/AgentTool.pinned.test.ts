import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { createAssistantMessage } from '../../utils/messages.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { AbortError } from '../../utils/errors.js'
import { resetCommandQueue } from '../../utils/messageQueueManager.js'
import { AgentTool, outputSchema } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import * as runAgentModule from './runAgent.js'
import * as runPinnedModule from './runPinnedAgent.js'

const NIUMA: AgentDefinition = {
  agentType: 'niuma',
  whenToUse: 'Does the work',
  source: 'userSettings',
  tools: ['Read'],
  getSystemPrompt: () => 'You are niuma.',
} as AgentDefinition

const BRIDGE_ENV = ['CC_HAHA_DESKTOP_SERVER_URL', 'CC_HAHA_SESSION_COLLABORATION_TOKEN', 'CC_HAHA_SESSION_ID', 'CC_HAHA_PINNED_AGENT_WORKER', 'CC_HAHA_TEAM_WORKER'] as const
const savedEnv: Record<string, string | undefined> = {}
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir = ''

async function pin(agentType: string) {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({
    agentRuntimeBindings: { [agentType]: { providerId: 'deepseek', modelId: 'deepseek-flash' } },
  }))
  resetSettingsCache()
}

function connectBridge() {
  process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:9'
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-token'
  process.env.CC_HAHA_SESSION_ID = 'parent-session'
}

function makeContext(): ToolUseContext {
  let appState = {
    ...getDefaultAppState(),
    agentDefinitions: {
      activeAgents: [GENERAL_PURPOSE_AGENT, NIUMA],
      allAgents: [GENERAL_PURPOSE_AGENT, NIUMA],
    },
  }
  const setAppState = (update: (prev: typeof appState) => typeof appState) => { appState = update(appState) }
  return {
    options: {
      mainLoopModel: 'sonnet',
      tools: [],
      mcpClients: [],
      agentDefinitions: appState.agentDefinitions,
    },
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState,
    setAppStateForTasks: setAppState,
    setResponseLength: () => {},
    messages: [],
    toolUseId: 'toolu_parent',
  } as unknown as ToolUseContext
}

function call(input: Record<string, unknown>, context = makeContext()) {
  return AgentTool.call(
    { description: 'Do the work', prompt: 'Please do it.', subagent_type: 'niuma', ...input } as never,
    context,
    (async () => ({ behavior: 'allow' })) as never,
    createAssistantMessage({ content: 'Launching.' }),
  )
}

/** A pinned run that produces one assistant message, as the adapter would. */
function fakePinnedRun() {
  return spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* (params: runPinnedModule.PinnedRunParams) {
    params.state.runtime = {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      requestedModel: 'deepseek-flash',
      model: 'deepseek-v4-flash',
      workerSessionId: 'worker-1',
    }
    yield createAssistantMessage({
      content: 'The report',
      usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null } as never,
    })
  }) as never)
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-agent-pinned-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  for (const key of BRIDGE_ENV) { savedEnv[key] = process.env[key]; delete process.env[key] }
  resetSettingsCache()
  spyOn(sessionStorage, 'writeAgentMetadata').mockResolvedValue(undefined as never)
  spyOn(sessionStorage, 'recordSidechainTranscript').mockResolvedValue(undefined as never)
})

afterEach(async () => {
  mock.restore()
  // Completion notifications land in a process-wide queue other suites assert on.
  resetCommandQueue()
  for (const key of BRIDGE_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  resetSettingsCache()
  await rm(configDir, { recursive: true, force: true })
})

describe('AgentTool pinned runtime', () => {
  test('an unpinned agent keeps the in-process path and never touches the pinned one', async () => {
    connectBridge()
    const pinnedSpy = fakePinnedRun()
    const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
      (async function* () {
        yield createAssistantMessage({ content: 'in-process answer' })
      }) as typeof runAgentModule.runAgent,
    )

    const result = await call({})

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    expect(pinnedSpy).not.toHaveBeenCalled()
    expect((result.data as Record<string, unknown>).runtime).toBeUndefined()
    expect((result.data as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'in-process answer' }])
  })

  test('a pinned agent runs through the adapter and reports where it ran', async () => {
    await pin('niuma')
    connectBridge()
    const pinnedSpy = fakePinnedRun()
    const runAgentSpy = spyOn(runAgentModule, 'runAgent')
    const registerSpy = spyOn(localAgentTask, 'registerAgentForeground')

    const result = await call({})

    expect(runAgentSpy).not.toHaveBeenCalled()
    // Registered like any foreground agent, so it can be moved to the background.
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(pinnedSpy).toHaveBeenCalledTimes(1)
    const params = pinnedSpy.mock.calls[0]![0] as runPinnedModule.PinnedRunParams
    expect(params).toMatchObject({
      agentType: 'niuma',
      prompt: 'Please do it.',
      description: 'Do the work',
      toolUseId: 'toolu_parent',
    })
    expect(params.definition).toMatchObject({ agentType: 'niuma', systemPrompt: 'You are niuma.', tools: ['Read'] })
    // The definition never carries a provider or model choice of its own.
    expect(params.definition).not.toHaveProperty('providerId')

    const data = result.data as any
    expect(data.status).toBe('completed')
    expect(data.content).toEqual([{ type: 'text', text: 'The report' }])
    expect(data.runtime).toEqual({
      mode: 'pinned',
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      requestedModel: 'deepseek-flash',
      status: 'completed',
      warnings: [],
    })
    expect(outputSchema().safeParse(data).success).toBe(true)

    const rendered = JSON.stringify(AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_parent'))
    expect(rendered).toContain('ran on: DeepSeek · deepseek-flash (pinned)')
    expect(rendered).toContain('pinned agents cannot be continued with SendMessage')
    expect(rendered).not.toContain("use SendMessage with to:")
  })

  test('a per-call model is ignored and the caller is told', async () => {
    await pin('niuma')
    connectBridge()
    const pinnedSpy = fakePinnedRun()

    const result = await call({ model: 'opus' })

    expect(pinnedSpy.mock.calls[0]![0]).not.toHaveProperty('model')
    const data = result.data as any
    expect(data.runtime.warnings).toEqual([expect.stringContaining('model override "opus" was ignored')])
    expect(JSON.stringify(AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_parent'))).toContain('was ignored: agent')
  })

  test('a plain CLI session is refused before any worker is asked for', async () => {
    await pin('niuma')
    const pinnedSpy = fakePinnedRun()
    const runAgentSpy = spyOn(runAgentModule, 'runAgent')

    await expect(call({})).rejects.toThrow('needs the desktop app')

    expect(pinnedSpy).not.toHaveBeenCalled()
    // No silent downgrade to the session's own provider.
    expect(runAgentSpy).not.toHaveBeenCalled()
  })

  test('isolation and nested calls are refused without side effects', async () => {
    await pin('niuma')
    connectBridge()
    const pinnedSpy = fakePinnedRun()
    const runAgentSpy = spyOn(runAgentModule, 'runAgent')
    const registerAsync = spyOn(localAgentTask, 'registerAsyncAgent')

    await expect(call({ isolation: 'worktree' })).rejects.toThrow('does not support isolation "worktree"')
    process.env.CC_HAHA_PINNED_AGENT_WORKER = '1'
    await expect(call({})).rejects.toThrow('cannot be started from a team worker or another pinned agent')

    expect(pinnedSpy).not.toHaveBeenCalled()
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(registerAsync).not.toHaveBeenCalled()
  })

  test('a pin on another agent does not affect this one', async () => {
    await pin('someone-else')
    const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
      (async function* () {
        yield createAssistantMessage({ content: 'normal' })
      }) as typeof runAgentModule.runAgent,
    )
    const result = await call({})
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    expect((result.data as any).content[0].text).toBe('normal')
  })

  test('a failed pinned run fails the call even after progress was produced', async () => {
    await pin('niuma')
    connectBridge()
    spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* () {
      yield createAssistantMessage({ content: 'partial work that must not read as a result' })
      throw new Error('Pinned agent "niuma" failed (worker_error): provider rejected the model')
    }) as never)

    await expect(call({})).rejects.toThrow('failed (worker_error)')
  })

  test('the stream is closed when the caller stops consuming early', async () => {
    await pin('niuma')
    connectBridge()
    let closed = false
    spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* () {
      try {
        yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] as never })
        yield createAssistantMessage({ content: 'second' })
      } finally {
        closed = true
      }
    }) as never)
    const context = makeContext()
    // A consumer failure mid-stream (here: the progress callback) must not leave the worker running.
    const failing = AgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'niuma' } as never,
      context,
      (async () => ({ behavior: 'allow' })) as never,
      createAssistantMessage({ content: 'Launching.' }),
      (progress: any) => { if (progress.data.prompt === '') throw new Error('progress consumer exploded') },
    )
    await expect(failing).rejects.toThrow('progress consumer exploded')
    expect(closed).toBe(true)
  })

  describe('background execution', () => {
    /** A pinned run held open until `release()`, so a test can act while it is in flight. */
    function gatedPinnedRun(texts: string[]) {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const signals: AbortSignal[] = []
      let runs = 0
      let closed = false
      spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* (params: runPinnedModule.PinnedRunParams) {
        runs++
        signals.push(params.signal)
        params.state.runtime = { providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', model: 'deepseek-v4-flash', workerSessionId: 'worker-1' }
        try {
          yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] as never })
          await Promise.race([
            gate,
            new Promise<void>((_, reject) => params.signal.addEventListener('abort', () => reject(new AbortError()), { once: true })),
          ])
          for (const text of texts) yield createAssistantMessage({ content: text })
        } finally {
          closed = true
        }
      }) as never)
      return { release, signals, runs: () => runs, closed: () => closed }
    }

    async function until(check: () => boolean) {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(check()).toBe(true)
    }

    const taskOf = (context: ToolUseContext, agentId: string) => context.getAppState().tasks[agentId] as any

    test('run_in_background runs the worker as a background task and notifies on completion', async () => {
      await pin('niuma')
      connectBridge()
      const run = gatedPinnedRun(['All done'])
      const runAgentSpy = spyOn(runAgentModule, 'runAgent')
      const notifySpy = spyOn(localAgentTask, 'enqueueAgentNotification')
      const context = makeContext()

      const result = await call({ run_in_background: true }, context)

      const data = result.data as any
      expect(data.status).toBe('async_launched')
      // The launch result is what the desktop card shows, so it names the provider.
      expect(data.runtime).toMatchObject({ mode: 'pinned', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', status: 'running' })
      const launchedText = AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_1') as any
      expect(launchedText.content[0].text).toContain('ran on: DeepSeek · deepseek-flash (pinned)')
      expect(launchedText.content[0].text).not.toContain('Use SendMessage')
      expect(runAgentSpy).not.toHaveBeenCalled()
      expect(taskOf(context, data.agentId).status).toBe('running')
      // The run is bound to the background task's own cancellation, not this turn's.
      await until(() => run.signals.length === 1)
      expect(run.signals[0]).toBe(taskOf(context, data.agentId).abortController.signal)

      run.release()
      await until(() => taskOf(context, data.agentId)?.status === 'completed')
      expect(notifySpy).toHaveBeenCalledTimes(1)
      expect(notifySpy.mock.calls[0]![0]).toMatchObject({ taskId: data.agentId, status: 'completed', finalMessage: 'All done' })
    })

    test('a background launch whose worker has not reported in is still marked pinned, with its warnings', async () => {
      await pin('niuma')
      connectBridge()
      spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* (params: runPinnedModule.PinnedRunParams) {
        // The real adapter marks the run ended when it fails before the worker reports in.
        params.state.ended = true
        throw new Error('could not start')
        // eslint-disable-next-line no-unreachable
        yield undefined as never
      }) as never)
      const started = Date.now()

      const result = await call({ run_in_background: true, model: 'opus' })

      const data = result.data as any
      expect(data.status).toBe('async_launched')
      // No provider name yet (so no badge), but it is known to be pinned: no
      // SendMessage hint, the requested model, and the ignored-model warning.
      expect(data.runtime).toMatchObject({ mode: 'pinned', providerId: 'deepseek', requestedModel: 'deepseek-flash', status: 'running' })
      expect(data.runtime.providerName).toBeUndefined()
      expect(data.runtime.warnings.join(' ')).toContain('was ignored')
      const text = (AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_1') as any).content[0].text
      expect(text).not.toContain('Use SendMessage')
      expect(text).toContain('cannot be continued')
      // Gave up as soon as the run ended, not after the full wait.
      expect(Date.now() - started).toBeLessThan(1_500)
    })

    test('a foreground run moved to the background before the worker reported in is still marked pinned', async () => {
      await pin('niuma')
      connectBridge()
      const gate = new Promise<void>(() => {})
      spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* (params: runPinnedModule.PinnedRunParams) {
        try { await Promise.race([gate, new Promise<void>((_, reject) => params.signal.addEventListener('abort', () => reject(new AbortError()), { once: true }))]) } finally { params.state.ended = true }
        yield undefined as never
      }) as never)
      const context = makeContext()

      const pending = call({}, context)
      await until(() => Object.keys(context.getAppState().tasks).length === 1)
      const agentId = Object.keys(context.getAppState().tasks)[0]!
      await Bun.sleep(30)
      expect(localAgentTask.backgroundAgentTask(agentId, context.getAppState, context.setAppState as never)).toBe(true)

      const data = (await pending).data as any
      expect(data).toMatchObject({ status: 'async_launched', agentId, runtime: { mode: 'pinned', status: 'running' } })
      expect(data.runtime.providerName).toBeUndefined()
      expect((AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_1') as any).content[0].text).not.toContain('Use SendMessage')
      taskOf(context, agentId).abortController.abort()
    })

    test('the agent is already marked pinned on disk when a background launch returns', async () => {
      await pin('niuma')
      connectBridge()
      gatedPinnedRun(['x'])
      const context = makeContext()

      const result = await call({ run_in_background: true }, context)

      const calls = (sessionStorage.writeAgentMetadata as any).mock.calls as [string, any][]
      const forAgent = calls.find(([id]) => id === (result.data as any).agentId)
      expect(forAgent?.[1]).toMatchObject({ agentType: 'niuma', runtime: { mode: 'pinned', providerId: 'deepseek', requestedModel: 'deepseek-flash' } })
    })

    test('stopping the task aborts the run; ESC on the launching turn does not', async () => {
      await pin('niuma')
      connectBridge()
      const run = gatedPinnedRun(['never'])
      const notifySpy = spyOn(localAgentTask, 'enqueueAgentNotification')
      const context = makeContext()

      const result = await call({ run_in_background: true }, context)
      const agentId = (result.data as any).agentId as string
      await until(() => run.signals.length === 1)

      context.abortController.abort()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(run.signals[0]!.aborted).toBe(false)
      expect(taskOf(context, agentId).status).toBe('running')

      localAgentTask.killAsyncAgent(agentId, context.setAppState as never)
      await until(() => run.closed())
      expect(run.signals[0]!.aborted).toBe(true)
      expect(taskOf(context, agentId).status).toBe('killed')
      await until(() => notifySpy.mock.calls.length === 1)
      expect(notifySpy.mock.calls[0]![0]).toMatchObject({ taskId: agentId, status: 'killed' })
    })

    test('a failing background run is reported as failed, not completed', async () => {
      await pin('niuma')
      connectBridge()
      spyOn(runPinnedModule, 'runPinnedAgent').mockImplementation((async function* () {
        yield createAssistantMessage({ content: 'partial' })
        throw new Error('Pinned agent "niuma" failed (worker_error): provider rejected the model')
      }) as never)
      const notifySpy = spyOn(localAgentTask, 'enqueueAgentNotification')
      const context = makeContext()

      const result = await call({ run_in_background: true }, context)

      await until(() => notifySpy.mock.calls.length === 1)
      expect(notifySpy.mock.calls[0]![0]).toMatchObject({ taskId: (result.data as any).agentId, status: 'failed' })
      expect(taskOf(context, (result.data as any).agentId).status).toBe('failed')
    })

    test('a foreground run moved to the background keeps the same worker and loses no message', async () => {
      await pin('niuma')
      connectBridge()
      const run = gatedPinnedRun(['Finished later'])
      const runAgentSpy = spyOn(runAgentModule, 'runAgent')
      const notifySpy = spyOn(localAgentTask, 'enqueueAgentNotification')
      const context = makeContext()

      const pending = call({}, context)
      await until(() => Object.keys(context.getAppState().tasks).length === 1)
      const agentId = Object.keys(context.getAppState().tasks)[0]!
      await until(() => run.signals.length === 1)
      expect(localAgentTask.backgroundAgentTask(agentId, context.getAppState, context.setAppState as never)).toBe(true)

      const result = await pending
      expect((result.data as any)).toMatchObject({ status: 'async_launched', agentId, runtime: { providerName: 'DeepSeek', status: 'running' } })
      // Not restarted: the one worker is still the one running, and it was not closed.
      expect(run.runs()).toBe(1)
      expect(run.closed()).toBe(false)
      expect(runAgentSpy).not.toHaveBeenCalled()

      // Cancelling the launching turn no longer reaches the run; the task's own controller does.
      context.abortController.abort()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(run.signals[0]!.aborted).toBe(false)

      run.release()
      await until(() => taskOf(context, agentId)?.status === 'completed')
      expect(notifySpy.mock.calls[0]![0]).toMatchObject({ taskId: agentId, status: 'completed', finalMessage: 'Finished later' })
      expect(run.runs()).toBe(1)
    })

    test('a backgrounded foreground run is stopped by killing its task', async () => {
      await pin('niuma')
      connectBridge()
      const run = gatedPinnedRun(['never'])
      const notifySpy = spyOn(localAgentTask, 'enqueueAgentNotification')
      const context = makeContext()

      const pending = call({}, context)
      await until(() => Object.keys(context.getAppState().tasks).length === 1)
      const agentId = Object.keys(context.getAppState().tasks)[0]!
      await until(() => run.signals.length === 1)
      localAgentTask.backgroundAgentTask(agentId, context.getAppState, context.setAppState as never)
      await pending

      localAgentTask.killAsyncAgent(agentId, context.setAppState as never)
      await until(() => run.closed())
      expect(run.signals[0]!.aborted).toBe(true)
      await until(() => notifySpy.mock.calls.length === 1)
      expect(notifySpy.mock.calls[0]![0]).toMatchObject({ taskId: agentId, status: 'killed' })
    })

    test('an unpinned background agent is untouched by the pinned path', async () => {
      const pinnedSpy = fakePinnedRun()
      const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
        (async function* () { yield createAssistantMessage({ content: 'in-process' }) }) as typeof runAgentModule.runAgent,
      )
      const context = makeContext()
      const result = await call({ subagent_type: 'general-purpose', run_in_background: true }, context)
      expect((result.data as any).status).toBe('async_launched')
      await until(() => runAgentSpy.mock.calls.length === 1)
      expect(pinnedSpy).not.toHaveBeenCalled()
    })
  })
})
