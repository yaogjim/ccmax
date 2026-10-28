// Opt-in observation probe, deliberately not a *.test.ts or a regular gate.
// Run: bun --no-env-file run ./src/services/tools/fixtures/teamPermissionCancellation.probe.ts
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type { Message } from '../../../types/message.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function observe(root: string) {
  // Set sandbox bootstrap state before importing the real execution graph.
  Object.assign(globalThis, { MACRO: { BUILD_TIME: '', VERSION: 'probe' } })
  const { mock } = await import('bun:test')
  const { z } = await import('zod/v4')
  const bootstrap = await import('../../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)

  let networkAttempts = 0
  globalThis.fetch = (() => {
    networkAttempts++
    throw new Error('Probe forbids network/model calls')
  }) as typeof fetch

  const classifier = await import('../../../utils/permissions/bashClassifier.js')
  mock.module('../../../utils/permissions/bashClassifier.js', () => ({
    ...classifier,
    classifyBashCommand: async () => { throw new Error('Unexpected Bash classifier call') },
  }))
  const preHookCalls: string[] = []
  const postHookCalls: string[] = []
  const legalPipelineFinished = barrier()
  // Mock hooks/permission classification only; keep StreamingToolExecutor,
  // runToolUse, tool.call dispatch, Stream and abort propagation real.
  mock.module('../toolHooks.js', () => ({
    runPreToolUseHooks: async function* (_context: unknown, tool: Tool) {
      preHookCalls.push(tool.name)
    },
    runPostToolUseHooks: async function* (_context: unknown, tool: Tool) {
      postHookCalls.push(tool.name)
      if (tool.name === 'ProbeLegal') legalPipelineFinished.release()
    },
    runPostToolUseFailureHooks: async function* () {},
    resolveHookPermissionDecision: async (
      _hook: unknown, tool: Tool, input: Record<string, unknown>,
      context: ToolUseContext, canUseTool: CanUseToolFn,
      assistant: Parameters<CanUseToolFn>[3], id: string,
    ) => ({ decision: await canUseTool(tool, input, context, assistant, id), input }),
  }))

  const { StreamingToolExecutor } = await import('../StreamingToolExecutor.js')
  const { createAssistantMessage } = await import('../../../utils/messages.js')
  const revokedStarted = barrier()
  const legalStarted = barrier()
  const finishLegal = barrier()
  const legalWorkFinished = barrier()
  let revokedController!: AbortController
  let legalController!: AbortController
  let revokedWorkFinished = false
  let legalFinished = false
  let permissionCalls = 0
  let inProgress = new Set<string>()
  let sendLegalProgress!: () => void
  const events: string[] = []

  function fakeTool(name: string, call: Tool['call']): Tool {
    return {
      name,
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      interruptBehavior: () => 'cancel',
      maxResultSizeChars: 1000,
      call,
      mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
        type: 'tool_result', tool_use_id: id, content: String(data),
      }),
    } as unknown as Tool
  }
  const revoked = fakeTool('ProbeRevoked', async (_input, context) => {
    revokedController = context.abortController
    events.push('revoked:started')
    revokedStarted.release()
    await new Promise<void>(resolve => {
      revokedController.signal.addEventListener('abort', () => {
        events.push('revoked:abort-observed')
        resolve()
      }, { once: true })
    })
    revokedWorkFinished = true
    return { data: 'revoked:cooperatively-stopped' }
  })
  const legal = fakeTool('ProbeLegal', async (_input, context, _canUse, _assistant, onProgress) => {
    legalController = context.abortController
    legalController.signal.addEventListener('abort', () => events.push('legal:abort-observed'), { once: true })
    sendLegalProgress = () => {
      assert.ok(onProgress)
      onProgress({ toolUseID: 'legal', data: { type: 'bash_progress', output: 'still working', elapsedTimeSeconds: 0, totalLines: 1, totalBytes: 13 } } as Parameters<NonNullable<typeof onProgress>>[0])
    }
    events.push('legal:started')
    legalStarted.release()
    // Deliberately ignore abort; only this explicit barrier ends actual work.
    await finishLegal.promise
    legalFinished = true
    events.push('legal:actual-work-finished')
    legalWorkFinished.release()
    return { data: 'legal:success' }
  })
  const tools = [revoked, legal]
  const parent = new AbortController()
  parent.signal.addEventListener('abort', () => events.push('parent:abort-observed'), { once: true })
  const context = {
    options: { tools, mcpClients: [], isNonInteractiveSession: true },
    messages: [],
    abortController: parent,
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    setInProgressToolUseIDs: (update: (previous: Set<string>) => Set<string>) => {
      inProgress = update(inProgress)
    },
  } as unknown as ToolUseContext
  const canUseTool: CanUseToolFn = async (_tool, input) => {
    permissionCalls++
    return { behavior: 'allow', updatedInput: input }
  }
  const blocks = tools.map((tool, index) => ({
    type: 'tool_use' as const,
    id: index === 0 ? 'revoked' : 'legal',
    name: tool.name,
    input: {},
  }))
  const assistant = createAssistantMessage({ content: blocks })
  const executor = new StreamingToolExecutor(tools, canUseTool, context)
  const updates: Message[] = []
  for (const block of blocks) executor.addTool(block, assistant)
  const drained = (async () => {
    for await (const update of executor.getRemainingResults()) {
      if (update.message) updates.push(update.message)
    }
    events.push('executor:results-drained')
  })()

  try {
    await Promise.all([revokedStarted.promise, legalStarted.promise])
    assert.equal(parent.signal.aborted, false)
    assert.equal(revokedWorkFinished, false)
    assert.equal(legalFinished, false)
    assert.equal(inProgress.size, 2)
    events.push('probe:both-tools-running')
    revokedController.abort('permission_revoked')
    const propagation = {
      bothToolsStartedBeforeAbort: true,
      parentAborted: parent.signal.aborted,
      parentReason: parent.signal.reason,
      legalChildAborted: legalController.signal.aborted,
      legalChildReason: legalController.signal.reason,
      legalActualWorkFinished: legalFinished,
    }
    // A real progress update lets the real executor see the parent abort,
    // without releasing the legal tool's actual-work barrier.
    sendLegalProgress()
    await drained
    const results = updates.flatMap(message =>
      message.type === 'user' && Array.isArray(message.message.content)
        ? message.message.content.filter(block => block.type === 'tool_result')
        : [],
    )
    const legalResult = results.find(result => result.tool_use_id === 'legal')
    const beforeRelease = {
      executorResultsDrained: true,
      legalSyntheticError: legalResult?.is_error === true,
      legalActualWorkFinished: legalFinished,
      executorInProgressIDs: [...inProgress],
      results,
    }

    // Assert current observations, NOT the desired isolation/drain contract.
    assert.equal(propagation.parentAborted, true)
    assert.equal(propagation.parentReason, 'permission_revoked')
    assert.equal(propagation.legalChildAborted, true)
    assert.equal(propagation.legalChildReason, 'permission_revoked')
    assert.equal(results.length, 2)
    assert.ok(results.every(result => result.is_error === true))
    assert.ok(updates.every(message => message.type !== 'progress'))
    assert.equal(beforeRelease.legalSyntheticError, true)
    assert.ok(updates.some(message =>
      message.type === 'user' &&
      message.toolUseResult === 'User rejected tool use' &&
      Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'legal'),
    ))
    assert.equal(beforeRelease.legalActualWorkFinished, false)
    assert.deepEqual(beforeRelease.executorInProgressIDs, [])
    assert.ok(!postHookCalls.includes('ProbeLegal'))

    finishLegal.release()
    await Promise.all([legalWorkFinished.promise, legalPipelineFinished.promise])
    assert.equal(legalFinished, true)
    assert.equal(permissionCalls, 2)
    assert.deepEqual(preHookCalls.sort(), ['ProbeLegal', 'ProbeRevoked'])
    assert.equal(networkAttempts, 0)
    return {
      executor: 'src/services/tools/StreamingToolExecutor.ts (unmodified)',
      execution: 'real runToolUse + fake tools + mocked classifier/permission decision and hooks',
      scope: 'one controlled parallel experiment, two observations; not team/runtime acceptance',
      scenarios: {
        permissionRevocationIsolation: {
          observed: propagation,
          requirement: 'Revoking one child must not abort its parent or another authorized tool',
          requirementSatisfied: !propagation.parentAborted && !propagation.legalChildAborted,
        },
        syntheticResultVsActualCompletion: {
          observed: { beforeRelease, legalActualWorkFinishedAfterRelease: legalFinished },
          requirement: 'Executor completion must not be treated as actual-work drain while an abort-ignoring call still runs',
          requirementSatisfied: beforeRelease.legalActualWorkFinished,
        },
      },
      events,
      networkAttempts,
      observationAssertionsPassed: true,
    }
  } finally {
    finishLegal.release()
    await Promise.all([drained, legalWorkFinished.promise])
    mock.restore()
  }
}

if (process.env.CCMAX_PERMISSION_CANCELLATION_PROBE_CHILD === '1') {
  const watchdog = setTimeout(() => {
    console.error('Probe barrier watchdog expired')
    process.exit(1)
  }, 10_000)
  try {
    console.log(JSON.stringify(await observe(process.env.HOME!)))
  } finally {
    clearTimeout(watchdog)
  }
} else {
  const root = await mkdtemp(join(tmpdir(), 'ccmax-permission-cancellation-probe-'))
  const { createSandboxedTestEnvironment } = await import('../../../../scripts/pr/test-environment.js')
  const child = Bun.spawn([process.execPath, '--no-env-file', 'run', fileURLToPath(import.meta.url)], {
    cwd: root,
    env: createSandboxedTestEnvironment(root, {
      CCMAX_PERMISSION_CANCELLATION_PROBE_CHILD: '1',
      NODE_ENV: 'production',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      ANTHROPIC_API_KEY: 'offline-probe-key',
    }),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    assert.equal(exitCode, 0, stdout + stderr)
    const evidence = JSON.parse(stdout)
    await rm(root, { recursive: true, force: true })
    console.log(JSON.stringify({ ...evidence, sandbox: { home: root, config: join(root, '.claude'), cleaned: true } }, null, 2))
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}
