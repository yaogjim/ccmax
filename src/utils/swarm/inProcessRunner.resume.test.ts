import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import * as promptsModule from '../../constants/prompts.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { CustomAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as runAgentModule from '../../tools/AgentTool/runAgent.js'
import { spawnTeammate } from '../../tools/shared/spawnMultiAgent.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import { createAgentId } from '../uuid.js'
import {
  leadConsumerScope,
  memberConsumerScope,
  type ConsumerScope,
} from './consumerScope.js'
import { createFileStateCacheWithSizeLimit } from '../fileStateCache.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import {
  type AgentMetadata,
  readAgentMetadata,
  resetProjectForTesting,
  writeAgentMetadata,
} from '../sessionStorage.js'
import {
  hasResumableInProcessTeammate,
  resumeInProcessTeammate,
} from './inProcessRunner.js'
import * as spawnInProcessModule from './spawnInProcess.js'
import { readTeamFile, type TeamFile, writeTeamFileAsync } from './teamHelpers.js'
import { getSessionId } from '../../bootstrap/state.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'

const TEAM = 'resume-team'
type RunAgentInput = Parameters<typeof runAgentModule.runAgent>[0]

const savedEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  userType: process.env.USER_TYPE,
}
let configDir: string

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function writeTeam(
  members: TeamFile['members'],
  createdAt = Date.now(),
): Promise<{ team: TeamFile; generation: number }> {
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt,
    leadAgentId: `team-lead@${TEAM}`,
    leadSessionId: getSessionId(),
    members,
  })
  const listId = getCanonicalTeamTaskListId(TEAM)
  const token = await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, {
    teamName: TEAM, createdAt, leadSessionId: getSessionId(),
  }))
  return { team: readTeamFile(TEAM)!, generation: token.generation }
}

function teamLeadScope(team: TeamFile, generation: number): ConsumerScope {
  return leadConsumerScope({
    team,
    generation,
    ownerSessionId: getSessionId(),
  })
}

const reviewer: CustomAgentDefinition = {
  agentType: 'deep-reviewer',
  whenToUse: 'Review deeply',
  rawSystemPrompt: 'Review carefully.',
  getSystemPrompt: () => 'Review carefully.',
  source: 'projectSettings',
  tools: ['Read'],
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-runner-resume-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.USER_TYPE = 'external'
  resetStateForTests()
  setIsInteractive(false)
  switchSession('9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0' as SessionId)
  resetProjectForTesting()
  spyOn(promptsModule, 'getSystemPrompt').mockResolvedValue(['System prompt'])
})

afterEach(async () => {
  mock.restore()
  drainSdkEvents()
  resetProjectForTesting()
  resetStateForTests()
  restoreEnv('CLAUDE_CONFIG_DIR', savedEnv.configDir)
  restoreEnv('TEST_ENABLE_SESSION_PERSISTENCE', savedEnv.persistence)
  restoreEnv('USER_TYPE', savedEnv.userType)
  await rm(configDir, { recursive: true, force: true })
})

function leadContext(consumerScope?: ConsumerScope) {
  let state = {
    mainLoopModel: 'claude-sonnet-4-6',
    toolPermissionContext: { mode: 'default' },
    teamContext: {
      teamName: TEAM,
      teamFilePath: '',
      leadAgentId: `team-lead@${TEAM}`,
      teammates: {},
      consumerScope,
    },
    agentNameRegistry: new Map(),
    tasks: {},
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      agentDefinitions: { activeAgents: [reviewer], allAgents: [reviewer] },
      tools: [],
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
      thinkingConfig: { type: 'disabled' },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
  } as unknown as ToolUseContext
  const teammates = () =>
    Object.values(state.tasks).filter(
      (task): task is InProcessTeammateTaskState =>
        task.type === 'in_process_teammate',
    )
  // Every teammate run ends after one turn
  const calls: RunAgentInput[] = []
  spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
    input: RunAgentInput,
  ) {
    calls.push(input)
    for (const task of teammates()) task.abortController?.abort()
    yield* []
  })
  return { context, teammates, calls }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

async function resumeWorker(lead: ReturnType<typeof leadContext>, name = 'worker') {
  const before = lead.calls.length
  const outcome = await resumeInProcessTeammate({
    agentName: name,
    teamName: TEAM,
    prompt: 'Carry on',
    from: 'team-lead',
    context: lead.context,
  })
  await waitFor(() => lead.calls.length === before + 1 && lead.teammates().length === 0)
  return { outcome, run: lead.calls.at(-1)! }
}

describe('resuming an in-process teammate', () => {
  test('reads metadata written before the teammate fields existed', async () => {
    const { team, generation } = await writeTeam([])
    const lead = leadContext(teamLeadScope(team, generation))
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const transcriptId = asAgentId(lead.calls[0]!.override!.agentId!)

    // A sidecar from an older version: no taskKind, no permission mode
    await writeAgentMetadata(transcriptId, { agentType: 'worker', description: 'Start' })
    expect(await readAgentMetadata(transcriptId)).toMatchObject({ agentType: 'worker', description: 'Start' })
    const fromOld = await resumeWorker(lead)
    expect(fromOld.outcome).toMatchObject({
      kind: 'resumed',
      restoredAs: 'original',
      consumerScope: { recipient: { memberInstanceId: transcriptId } },
    })
    expect(fromOld.run.override?.agentId).toBe(transcriptId)
    expect(fromOld.run.agentDefinition.permissionMode).toBe('default')

    const teammateMetadata: AgentMetadata = {
      agentType: 'worker',
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: 'worker',
      permissionMode: 'acceptEdits',
    }
    await writeAgentMetadata(transcriptId, teammateMetadata)
    expect((await resumeWorker(lead)).run.agentDefinition.permissionMode).toBe('acceptEdits')

    // A file on disk never grants bypassPermissions
    await writeAgentMetadata(transcriptId, { ...teammateMetadata, permissionMode: 'bypassPermissions' })
    expect((await resumeWorker(lead)).run.agentDefinition.permissionMode).toBe('default')
  })

  test('refuses to restart a roster member with no persisted consumer identity', async () => {
    const { team, generation } = await writeTeam([
      {
        agentId: `scout@${TEAM}`,
        name: 'scout',
        agentType: 'deep-reviewer',
        model: 'gpt-5.6-luna',
        color: 'green',
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: configDir,
        subscriptions: [],
        backendType: 'in-process',
      },
    ])
    const lead = leadContext(teamLeadScope(team, generation))

    await expect(
      resumeInProcessTeammate({
        agentName: 'scout',
        teamName: TEAM,
        prompt: 'Carry on',
        from: 'team-lead',
        context: lead.context,
      }),
    ).rejects.toThrow('not an in-process teammate')
    expect(lead.calls).toEqual([])
    expect(lead.teammates()).toEqual([])
  })

  test('resumes a roster member from its persisted instance scope', async () => {
    const instanceId = createAgentId()
    const { team, generation } = await writeTeam([
      {
        agentId: `scout@${TEAM}`,
        name: 'scout',
        consumerInstanceId: instanceId,
        agentType: 'deep-reviewer',
        model: 'gpt-5.6-luna',
        color: 'green',
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: configDir,
        subscriptions: [],
        backendType: 'in-process',
      },
    ])
    const scope = memberConsumerScope({
      team,
      generation,
      ownerSessionId: getSessionId(),
      backend: 'in-process',
      agentName: 'scout',
      memberInstanceId: instanceId,
    })
    await writeAgentMetadata(asAgentId(instanceId), {
      agentType: 'deep-reviewer',
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: 'scout',
      permissionMode: 'acceptEdits',
      consumerScope: scope,
      parentSessionId: getSessionId(),
    })
    const lead = leadContext(teamLeadScope(team, generation))

    const { outcome, run } = await resumeWorker(lead, 'scout')

    expect(outcome).toMatchObject({
      kind: 'resumed',
      restoredAs: 'original',
      resumedMessageCount: 0,
      consumerScope: scope,
    })
    expect(run.override?.agentId).toBe(instanceId)
    expect(run.agentDefinition.permissionMode).toBe('acceptEdits')
    expect(run.extraMetadata?.consumerScope).toMatchObject({
      recipient: { memberInstanceId: instanceId },
    })
    expect(
      readTeamFile(TEAM)!.members
        .filter(member => member.name === 'scout')
        .map(member => member.consumerInstanceId),
    ).toEqual([instanceId])
  })

  test('coalesces a concurrent resume and reports the running instance scope', async () => {
    const instanceId = createAgentId()
    const { team, generation } = await writeTeam([
      {
        agentId: `scout@${TEAM}`,
        name: 'scout',
        consumerInstanceId: instanceId,
        agentType: 'deep-reviewer',
        model: 'gpt-5.6-luna',
        color: 'green',
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: configDir,
        subscriptions: [],
        backendType: 'in-process',
      },
    ])
    const scope = memberConsumerScope({
      team,
      generation,
      ownerSessionId: getSessionId(),
      backend: 'in-process',
      agentName: 'scout',
      memberInstanceId: instanceId,
    })
    await writeAgentMetadata(asAgentId(instanceId), {
      agentType: 'deep-reviewer',
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: 'scout',
      consumerScope: scope,
      parentSessionId: getSessionId(),
    })
    const lead = leadContext(teamLeadScope(team, generation))

    const originalSpawn = spawnInProcessModule.spawnInProcessTeammate
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>(resolve => {
      releaseSpawn = resolve
    })
    let spawnCalls = 0
    spyOn(spawnInProcessModule, 'spawnInProcessTeammate').mockImplementation(
      async (...args) => {
        spawnCalls++
        await spawnGate
        return originalSpawn(...args)
      },
    )

    const params = {
      agentName: 'scout',
      teamName: TEAM,
      prompt: 'Carry on',
      from: 'team-lead',
      context: lead.context,
    }
    const first = resumeInProcessTeammate(params)
    await waitFor(() => spawnCalls === 1)
    const second = resumeInProcessTeammate(params)
    // The second resume resolves the same target and waits for the first
    // instead of starting a second registration.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(spawnCalls).toBe(1)
    releaseSpawn()

    const outcomes = await Promise.all([first, second])
    await waitFor(() => lead.teammates().length === 0)
    expect(outcomes.filter(outcome => outcome.kind === 'resumed')).toHaveLength(1)
    const queued = outcomes.find(outcome => outcome.kind === 'already_running')
    expect(queued).toBeDefined()
    expect(queued!.consumerScope.recipient).toMatchObject({
      kind: 'member',
      memberInstanceId: instanceId,
    })
  })

  test('rejoins a removed teammate under a new instance and keeps its old history', async () => {
    const { team, generation } = await writeTeam([])
    const lead = leadContext(teamLeadScope(team, generation))
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const original = readTeamFile(TEAM)!
    const originalInstanceId = original.members.find(member => member.name === 'worker')!
      .consumerInstanceId!
    const oldMetadata: AgentMetadata = {
      agentType: 'worker',
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: 'worker',
      consumerScope: memberConsumerScope({
        team: original,
        generation,
        ownerSessionId: getSessionId(),
        backend: 'in-process',
        agentName: 'worker',
        memberInstanceId: originalInstanceId,
      }),
      parentSessionId: getSessionId(),
    }
    await writeAgentMetadata(asAgentId(originalInstanceId), oldMetadata)
    const metadataBeforeRejoin = await readAgentMetadata(asAgentId(originalInstanceId))

    // The member left the roster but the team incarnation did not change
    await writeTeamFileAsync(TEAM, {
      ...original,
      members: original.members.filter(member => member.name !== 'worker'),
    })

    const { outcome, run } = await resumeWorker(lead)

    const rejoined = readTeamFile(TEAM)!.members.find(member => member.name === 'worker')!
    expect(outcome).toMatchObject({
      kind: 'resumed',
      restoredAs: 'rejoined',
      consumerScope: { recipient: { memberInstanceId: rejoined.consumerInstanceId } },
    })
    expect(rejoined.consumerInstanceId).toBeDefined()
    expect(rejoined.consumerInstanceId).not.toBe(originalInstanceId)
    expect(run.override?.agentId).toBe(rejoined.consumerInstanceId)
    expect(run.override?.agentId).not.toBe(originalInstanceId)
    // The old transcript's sidecar belongs to the old instance and is untouched
    expect(await readAgentMetadata(asAgentId(originalInstanceId))).toEqual(
      metadataBeforeRejoin,
    )
  })

  test('refuses to resume a member replaced under the same name', async () => {
    const { team, generation } = await writeTeam([])
    const lead = leadContext(teamLeadScope(team, generation))
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const original = readTeamFile(TEAM)!
    const replacementInstanceId = createAgentId()
    await writeTeamFileAsync(TEAM, {
      ...original,
      members: original.members.map(member =>
        member.name === 'worker'
          ? { ...member, consumerInstanceId: replacementInstanceId }
          : member,
      ),
    })

    await expect(
      resumeInProcessTeammate({
        agentName: 'worker',
        teamName: TEAM,
        prompt: 'Carry on',
        from: 'team-lead',
        context: lead.context,
      }),
    ).rejects.toThrow('replaced')
    expect(lead.calls).toHaveLength(1)
    expect(lead.teammates()).toEqual([])
  })

  test('does not bring back a teammate of an earlier team with the same name', async () => {
    const { team, generation } = await writeTeam([])
    const lead = leadContext(teamLeadScope(team, generation))
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const original = readTeamFile(TEAM)!
    expect(hasResumableInProcessTeammate('worker', TEAM, original.createdAt)).toBe(true)

    // The team is deleted and created again under the same name
    await writeTeam([], original.createdAt + 1)

    expect(hasResumableInProcessTeammate('worker', TEAM, original.createdAt + 1)).toBe(false)
    await expect(
      resumeInProcessTeammate({
        agentName: 'worker',
        teamName: TEAM,
        prompt: 'Carry on',
        from: 'team-lead',
        context: lead.context,
      }),
    ).rejects.toThrow('not an in-process teammate')
    expect(lead.teammates()).toEqual([])
  })
})
