import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionId, resetStateForTests } from '../../bootstrap/state.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../../utils/tasks.js'
import { leadConsumerScope, type ConsumerScope } from '../../utils/swarm/consumerScope.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import type {
  CustomAgentDefinition,
  PluginAgentDefinition,
} from '../AgentTool/loadAgentsDir.js'

type SpawnMode = 'split-pane' | 'separate-window' | 'in-process'

let spawnMode: SpawnMode = 'split-pane'
const paneCommands: string[] = []
const tmuxCalls: string[][] = []
const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
let originalConfigDir: string | undefined
let configDir: string
let callerScope: ConsumerScope
let beforePaneStart: (() => Promise<void> | void) | undefined

const sendCommandToPaneMock = mock(
  async (_paneId: string, command: string) => {
    await beforePaneStart?.()
    paneCommands.push(command)
  },
)
const execFileNoThrowMock = mock(
  async (_command: string, args: string[]) => {
    if (args[0] === 'send-keys') await beforePaneStart?.()
    tmuxCalls.push(args)
    if (args[0] === 'new-window') {
      return { code: 0, stdout: '%window\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  },
)
const spawnInProcessTeammateMock = mock(async (_config: unknown) => ({
  success: true,
  agentId: 'worker@review-team',
  taskId: 'task-1',
  abortController: new AbortController(),
  teammateContext: { parentSessionId: 'parent-session' },
}))
const startInProcessTeammateMock = mock((_config: unknown) => {})
const execFileNoThrowModule = await import('../../utils/execFileNoThrow.js')
const taskFrameworkModule = await import('../../utils/task/framework.js')
const teamHelpersModule = await import('../../utils/swarm/teamHelpers.js')
const originalTeamHelpers = { ...teamHelpersModule }
const mutateTeamFileAsyncActual = teamHelpersModule.mutateTeamFileAsync
const readTeamFileAsyncActual = teamHelpersModule.readTeamFileAsync

// mock.module replaces exports process-wide and outlives this file, so every
// module mocked below is put back afterwards from these untouched copies.
// Otherwise later files in one `bun test` run (the coverage gate runs all of
// src in a single process) get a runner, mailbox and backends without their
// real exports.
const originalModules: Array<[string, Record<string, unknown>]> = [
  ['../../utils/swarm/backends/registry.js', { ...(await import('../../utils/swarm/backends/registry.js')) }],
  ['../../utils/swarm/backends/detection.js', { ...(await import('../../utils/swarm/backends/detection.js')) }],
  ['../../utils/swarm/teammateLayoutManager.js', { ...(await import('../../utils/swarm/teammateLayoutManager.js')) }],
  ['../../utils/swarm/inProcessRunner.js', { ...(await import('../../utils/swarm/inProcessRunner.js')) }],
  ['../../utils/swarm/spawnInProcess.js', { ...(await import('../../utils/swarm/spawnInProcess.js')) }],
  ['../../utils/task/framework.js', { ...taskFrameworkModule }],
  ['../../utils/teammateMailbox.js', { ...(await import('../../utils/teammateMailbox.js')) }],
  ['../../utils/execFileNoThrow.js', { ...execFileNoThrowModule }],
]

mock.module('../../utils/swarm/backends/registry.js', () => ({
  detectAndGetBackend: async () => ({
    backend: { type: 'tmux' },
    needsIt2Setup: false,
  }),
  getBackendByType: () => ({ killPane: async () => {} }),
  isInProcessEnabled: () => spawnMode === 'in-process',
  markInProcessFallback: () => {},
  resetBackendDetection: () => {},
}))

mock.module('../../utils/swarm/backends/detection.js', () => ({
  isTmuxAvailable: async () => true,
}))

mock.module('../../utils/swarm/teammateLayoutManager.js', () => ({
  assignTeammateColor: () => 'blue',
  createTeammatePaneInSwarmView: async () => ({
    paneId: '%split',
    isFirstTeammate: false,
  }),
  enablePaneBorderStatus: async () => {},
  isInsideTmux: async () => true,
  sendCommandToPane: sendCommandToPaneMock,
}))

mock.module('../../utils/swarm/inProcessRunner.js', () => ({
  startInProcessTeammate: startInProcessTeammateMock,
}))

mock.module('../../utils/swarm/spawnInProcess.js', () => ({
  spawnInProcessTeammate: spawnInProcessTeammateMock,
}))

mock.module('../../utils/swarm/teamHelpers.js', () => ({
  ...teamHelpersModule,
  sanitizeAgentName: (name: string) => name.replaceAll('@', '-'),
  sanitizeName: (name: string) =>
    name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
}))

mock.module('../../utils/task/framework.js', () => ({
  ...taskFrameworkModule,
  registerTask: () => {},
}))

mock.module('../../utils/teammateMailbox.js', () => ({
  writeToMailbox: async () => {},
}))

mock.module('../../utils/execFileNoThrow.js', () => ({
  ...execFileNoThrowModule,
  execFileNoThrow: execFileNoThrowMock,
}))

const { spawnTeammate } = await import('./spawnMultiAgent.js')

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-spawn-callsite-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetStateForTests()
  const team = { name: 'review-team', createdAt: 100, leadAgentId: 'team-lead@review-team', leadSessionId: getSessionId(), members: [] }
  await teamHelpersModule.writeTeamFileAsync(team.name, team)
  const listId = getCanonicalTeamTaskListId(team.name)
  const lifecycle = await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, {
    teamName: team.name, createdAt: team.createdAt, leadSessionId: team.leadSessionId,
  }))
  callerScope = leadConsumerScope({ team, generation: lifecycle.generation, ownerSessionId: getSessionId() })
  beforePaneStart = undefined
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  spawnMode = 'split-pane'
  paneCommands.length = 0
  tmuxCalls.length = 0
  sendCommandToPaneMock.mockClear()
  execFileNoThrowMock.mockClear()
  spawnInProcessTeammateMock.mockClear()
  startInProcessTeammateMock.mockClear()
})

afterEach(async () => {
  resetStateForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('../../utils/swarm/teamHelpers.js', () => originalTeamHelpers)
  for (const [path, original] of originalModules) {
    mock.module(path, () => original)
  }
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

describe('Agent Teams custom Agent runtime call sites', () => {
  test('split-pane has a fixed registration before the child command starts', async () => {
    beforePaneStart = async () => {
      const member = (await readTeamFileAsyncActual('review-team'))?.members[0]
      expect(member).toMatchObject({ name: 'worker', backendType: 'tmux', tmuxPaneId: '%split' })
      expect(member?.consumerInstanceId).toBeString()
      expect(member?.sessionId).toBeString()
    }
    await spawnTeammate(makeConfig(true), makeContext())
    const member = (await readTeamFileAsyncActual('review-team'))!.members[0]!
    expect(paneCommands[0]).toContain(`--session-id ${member.sessionId}`)
    expect(paneCommands[0]).toContain('CC_HAHA_TEAM_CONSUMER_SCOPE=')
    expect(paneCommands[0]).toContain(member.consumerInstanceId!)
    expect(paneCommands[0]).toContain(`"ownerSessionId":"${member.sessionId}"`)
  })

  test('separate-window reserves a unique instance and session before starting the child', async () => {
    spawnMode = 'separate-window'
    beforePaneStart = async () => {
      const member = (await readTeamFileAsyncActual('review-team'))?.members[0]
      expect(member).toMatchObject({ name: 'worker', backendType: 'tmux', tmuxPaneId: '%window' })
      expect(member?.consumerInstanceId).toBeString()
      expect(member?.sessionId).toBeString()
    }
    await spawnTeammate(makeConfig(false), makeContext())
    const member = (await readTeamFileAsyncActual('review-team'))!.members[0]!
    const command = tmuxCalls.find(args => args[0] === 'send-keys')!.find(arg => arg.includes('CLAUDECODE=1'))!
    expect(command).toContain(`--session-id ${member.sessionId}`)
    expect(command).toContain('CC_HAHA_TEAM_CONSUMER_SCOPE=')
    expect(command).toContain(member.consumerInstanceId!)
  })

  test('pane startup rollback preserves a replacement member', async () => {
    beforePaneStart = async () => {
      await mutateTeamFileAsyncActual('review-team', team => {
        team.members[0]!.consumerInstanceId = 'replacement-instance'
      })
      throw new Error('fixture pane startup failed')
    }
    await expect(spawnTeammate(makeConfig(true), makeContext()))
      .rejects.toThrow('fixture pane startup failed')
    expect((await readTeamFileAsyncActual('review-team'))?.members[0]?.consumerInstanceId)
      .toBe('replacement-instance')
  })

  test('unbound pane callers cannot start even when a matching roster exists', async () => {
    const context = makeContext()
    delete context.getAppState().teamContext!.consumerScope
    await expect(spawnTeammate(makeConfig(true), context)).rejects.toThrow('unbound')
    expect(paneCommands).toEqual([])
    expect(tmuxCalls).toEqual([])
    expect((await readTeamFileAsyncActual('review-team'))?.members).toEqual([])
  })

  test('split-pane command receives definition model, effort, and inherited thinking', async () => {
    const result = await spawnTeammate(
      makeConfig(true),
      makeContext(),
    )

    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(sendCommandToPaneMock).toHaveBeenCalledTimes(1)
    expect(paneCommands[0]).toContain('--model gpt-5.6-luna')
    expect(paneCommands[0]).toContain('--effort xhigh')
    expect(paneCommands[0]).toContain('--thinking disabled')
  })

  test('separate-window command receives definition model, effort, and inherited thinking', async () => {
    spawnMode = 'separate-window'

    const result = await spawnTeammate(
      makeConfig(false),
      makeContext(),
    )

    const sendKeys = tmuxCalls.find(args => args[0] === 'send-keys')
    const command = sendKeys?.find(arg => arg.includes('CLAUDECODE=1'))
    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(command).toContain('--model gpt-5.6-luna')
    expect(command).toContain('--effort xhigh')
    expect(command).toContain('--thinking disabled')
  })

  test('in-process runner receives the selected definition and inherited thinking', async () => {
    spawnMode = 'in-process'

    const result = await spawnTeammate(
      makeConfig(),
      makeContext(),
    )

    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(spawnInProcessTeammateMock).toHaveBeenCalledTimes(1)
    expect(spawnInProcessTeammateMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-luna',
    })
    expect(startInProcessTeammateMock).toHaveBeenCalledTimes(1)
    const runnerConfig = startInProcessTeammateMock.mock.calls[0]?.[0] as {
      model?: string
      agentDefinition?: CustomAgentDefinition
      toolUseContext: ToolUseContext
    }
    expect(runnerConfig.model).toBe('gpt-5.6-luna')
    expect(runnerConfig.agentDefinition).toMatchObject({
      agentType: 'deep-reviewer',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    })
    expect(runnerConfig.toolUseContext.options.thinkingConfig).toEqual({
      type: 'disabled',
    })
  })

  test('in-process runner preserves a selected plugin Agent definition', async () => {
    spawnMode = 'in-process'
    const pluginAgent: PluginAgentDefinition = {
      agentType: 'plugin-reviewer',
      whenToUse: 'Review with the plugin',
      getSystemPrompt: () => 'Apply the plugin review policy.',
      source: 'plugin',
      plugin: 'review-suite',
      tools: ['Read'],
      model: 'opus',
      effort: 'max',
    }

    const result = await spawnTeammate(
      {
        name: 'plugin-worker',
        prompt: 'Review the change.',
        team_name: 'review-team',
        agent_type: 'plugin-reviewer',
      },
      makeContext(pluginAgent),
    )

    expect(result.data.model).toBe(parseUserSpecifiedModel('opus'))
    const runnerConfig = startInProcessTeammateMock.mock.calls[0]?.[0] as {
      agentDefinition?: PluginAgentDefinition
    }
    expect(runnerConfig.agentDefinition).toBe(pluginAgent)
    expect(runnerConfig.agentDefinition).toMatchObject({
      agentType: 'plugin-reviewer',
      source: 'plugin',
      plugin: 'review-suite',
      effort: 'max',
    })
  })
})

function makeConfig(useSplitPane?: boolean) {
  return {
    name: 'worker',
    prompt: 'Review the change.',
    team_name: 'review-team',
    agent_type: 'deep-reviewer',
    use_splitpane: useSplitPane,
  }
}

function makeContext(
  selectedAgentDefinition?: CustomAgentDefinition | PluginAgentDefinition,
): ToolUseContext {
  const agentDefinition =
    selectedAgentDefinition ??
    ({
      agentType: 'deep-reviewer',
      whenToUse: 'Review deeply',
      rawSystemPrompt: 'Review carefully.',
      getSystemPrompt: () => 'Review carefully.',
      source: 'projectSettings',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    } satisfies CustomAgentDefinition)
  let state = {
    mainLoopModel: 'claude-sonnet-4-6',
    effortValue: 'medium',
    toolPermissionContext: { mode: 'default' },
    teamContext: {
      teamName: 'review-team',
      consumerScope: callerScope,
      teamFilePath: '',
      leadAgentId: 'team-lead@review-team',
      teammates: {},
    },
  } as unknown as AppState

  return {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      agentDefinitions: {
        activeAgents: [agentDefinition],
        allAgents: [agentDefinition],
      },
      thinkingConfig: { type: 'disabled' },
    },
    messages: [],
  } as unknown as ToolUseContext
}
