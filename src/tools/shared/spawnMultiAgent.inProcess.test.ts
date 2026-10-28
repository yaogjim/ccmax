import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId, resetStateForTests, setIsInteractive } from '../../bootstrap/state.js'
import { leadConsumerScope, type ConsumerScope } from '../../utils/swarm/consumerScope.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../../utils/tasks.js'
import * as promptsModule from '../../constants/prompts.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { mutateTeamFileAsync, readTeamFile, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { readMailbox, writeToMailbox } from '../../utils/teammateMailbox.js'
import * as runAgentModule from '../AgentTool/runAgent.js'
import * as runnerModule from '../../utils/swarm/inProcessRunner.js'
import * as spawnModule from '../../utils/swarm/spawnInProcess.js'
import { spawnTeammate } from './spawnMultiAgent.js'

const TEAM = 'spawn-team'
let configDir: string
let originalConfigDir: string | undefined
let callerScope: ConsumerScope

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-spawn-in-process-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetStateForTests()
  // A non-interactive session always spawns in-process teammates
  setIsInteractive(false)
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${TEAM}`,
    leadSessionId: getSessionId(),
    members: [],
  })
  const team = readTeamFile(TEAM)!
  const listId = getCanonicalTeamTaskListId(TEAM)
  const lifecycle = await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, {
    teamName: TEAM, createdAt: team.createdAt, leadSessionId: getSessionId(),
  }))
  callerScope = leadConsumerScope({ team, generation: lifecycle.generation, ownerSessionId: getSessionId() })
})

afterEach(async () => {
  mock.restore()
  drainSdkEvents()
  resetStateForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

function leadContext() {
  let state = {
    mainLoopModel: 'claude-sonnet-4-6',
    toolPermissionContext: { mode: 'default' },
    teamContext: {
      teamName: TEAM,
      consumerScope: callerScope,
      teamFilePath: '',
      leadAgentId: `team-lead@${TEAM}`,
      teammates: {},
    },
    tasks: {},
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      agentDefinitions: { activeAgents: [], allAgents: [] },
      tools: [],
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
      thinkingConfig: { type: 'disabled' },
    },
    abortController: new AbortController(),
    messages: [],
  } as unknown as ToolUseContext
  const teammates = () =>
    Object.values(state.tasks).filter(
      (task): task is InProcessTeammateTaskState =>
        task.type === 'in_process_teammate',
    )
  return { context, teammates }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

describe('spawning in-process teammates', () => {
  test('fresh registration shares the transcript id with the fixed consumer instance', async () => {
    spyOn(promptsModule, 'getSystemPrompt').mockResolvedValue(['System prompt'])
    const lead = leadContext()
    spyOn(runAgentModule, 'runAgent').mockImplementation(async function* () {
      for (const task of lead.teammates()) task.abortController?.abort()
      yield* []
    })

    await spawnTeammate({ name: 'worker', prompt: 'Fix the parser', team_name: TEAM }, lead.context)

    const identity = lead.teammates()[0]!.identity
    expect(readTeamFile(TEAM)?.members[0]?.consumerInstanceId).toBe(identity.resumableAgentId)
    expect(identity.consumerScope?.recipient).toMatchObject({
      kind: 'member', backend: 'in-process', memberInstanceId: identity.resumableAgentId,
    })
    expect(readTeamFile(TEAM)?.members[0]?.sessionId).toBeUndefined()
    await waitFor(() => lead.teammates().every(task => task.status !== 'running'))
  })

  test('a stale caller cannot register against a rebuilt team with the same name', async () => {
    const lead = leadContext()
    const replacement = { ...readTeamFile(TEAM)!, createdAt: callerScope.createdAt + 1 }
    await writeTeamFileAsync(TEAM, replacement)
    const listId = getCanonicalTeamTaskListId(TEAM)
    await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, {
      teamName: TEAM, createdAt: replacement.createdAt, leadSessionId: getSessionId(),
    }))
    const start = spyOn(runnerModule, 'startInProcessTeammate').mockImplementation(() => {})

    await expect(spawnTeammate({ name: 'worker', prompt: 'Fix the parser', team_name: TEAM }, lead.context))
      .rejects.toThrow('stale')

    expect(readTeamFile(TEAM)).toEqual(replacement)
    expect(start).not.toHaveBeenCalled()
    expect(lead.teammates()).toEqual([])
  })

  test('failed startup does not roll back a replacement member using the reserved name', async () => {
    const lead = leadContext()
    spyOn(spawnModule, 'spawnInProcessTeammate').mockImplementation(async () => {
      await mutateTeamFileAsync(TEAM, team => {
        team.members[0]!.consumerInstanceId = 'replacement-instance'
      })
      return { success: false, agentId: `worker@${TEAM}`, error: 'fixture startup failed' }
    })

    await expect(spawnTeammate({ name: 'worker', prompt: 'Fix the parser', team_name: TEAM }, lead.context))
      .rejects.toThrow('fixture startup failed')

    expect(readTeamFile(TEAM)?.members).toHaveLength(1)
    expect(readTeamFile(TEAM)?.members[0]?.consumerInstanceId).toBe('replacement-instance')
  })

  test('concurrent spawns with one name reserve distinct names on the roster', async () => {
    spyOn(promptsModule, 'getSystemPrompt').mockResolvedValue(['System prompt'])
    const lead = leadContext()
    spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
      input: Parameters<typeof runAgentModule.runAgent>[0],
    ) {
      // Each teammate ends after its first turn
      for (const task of lead.teammates()) task.abortController?.abort()
      yield* []
      void input
    })

    const [first, second] = await Promise.all([
      spawnTeammate({ name: 'worker', prompt: 'Fix the parser', team_name: TEAM }, lead.context),
      spawnTeammate({ name: 'worker', prompt: 'Write the docs', team_name: TEAM }, lead.context),
    ])

    expect(new Set([first.data.name, second.data.name])).toEqual(
      new Set(['worker', 'worker-2']),
    )
    expect(readTeamFile(TEAM)?.members.map(member => member.agentId).sort()).toEqual([
      `worker-2@${TEAM}`,
      `worker@${TEAM}`,
    ])
    await waitFor(() => lead.teammates().every(task => task.status !== 'running'))
  })

  test('a new teammate does not inherit mail left for an earlier one with its name', async () => {
    spyOn(promptsModule, 'getSystemPrompt').mockResolvedValue(['System prompt'])
    await writeToMailbox(
      'worker',
      { from: 'reviewer', text: 'Stale note for the previous worker', timestamp: new Date().toISOString() },
      TEAM,
    )
    const lead = leadContext()
    let unreadAtFirstTurn: string[] | undefined
    spyOn(runAgentModule, 'runAgent').mockImplementation(async function* () {
      unreadAtFirstTurn = (await readMailbox('worker', TEAM))
        .filter(message => !message.read)
        .map(message => message.text)
      for (const task of lead.teammates()) task.abortController?.abort()
      yield* []
    })

    await spawnTeammate({ name: 'worker', prompt: 'Fix the parser', team_name: TEAM }, lead.context)
    await waitFor(() => unreadAtFirstTurn !== undefined)

    expect(unreadAtFirstTurn).toEqual([])
    await waitFor(() => lead.teammates().every(task => task.status !== 'running'))
  })
})
