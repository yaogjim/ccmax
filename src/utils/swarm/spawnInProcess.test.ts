import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import * as sdk from '../sdkEventQueue.js'
import * as diskOutput from '../task/diskOutput.js'
import * as framework from '../task/framework.js'
import * as tracing from '../telemetry/perfettoTracing.js'
import { readMailbox, writeToMailbox } from '../teammateMailbox.js'
import { killInProcessTeammate, spawnInProcessTeammate } from './spawnInProcess.js'
import * as consumers from './consumerScope.js'
import { readTeamFile, writeTeamFileAsync } from './teamHelpers.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'
import type { ConsumerScope } from './consumerScope.js'

async function withKillFixture(run: (fixture: {
  setAppState: (update: (state: AppState) => AppState) => void
  getState: () => AppState
  abortController: AbortController
  remove: ReturnType<typeof spyOn<typeof consumers, 'removeScopedMember'>>
  terminated: ReturnType<typeof spyOn<typeof sdk, 'emitTaskTerminatedSdk'>>
  evictOutput: ReturnType<typeof spyOn<typeof diskOutput, 'evictTaskOutput'>>
  unregister: ReturnType<typeof spyOn<typeof tracing, 'unregisterAgent'>>
  timer: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-kill-teammate-'))
  const originalHome = process.env.HOME
  const originalConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude')
  const abortController = new AbortController()
  let state = {
    tasks: {
      worker: {
        id: 'worker',
        type: 'in_process_teammate',
        status: 'running',
        identity: { teamName: 'fixture', agentId: 'worker@fixture', consumerScope: { version: 1, teamName: 'fixture', generation: 1, createdAt: 10, leadSessionId: 'lead', ownerSessionId: 'lead', recipient: { kind: 'member', backend: 'in-process', agentName: 'worker', memberInstanceId: 'original' } } },
        description: 'fixture teammate',
        toolUseId: 'fixture-tool',
        abortController,
      },
    },
    teamContext: { teammates: { 'worker@fixture': {} } },
  } as unknown as AppState
  const remove = spyOn(consumers, 'removeScopedMember').mockResolvedValue({ status: 'current', value: true })
  const terminated = spyOn(sdk, 'emitTaskTerminatedSdk').mockImplementation(() => {})
  const evictOutput = spyOn(diskOutput, 'evictTaskOutput').mockResolvedValue(undefined)
  const unregister = spyOn(tracing, 'unregisterAgent').mockImplementation(() => {})
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(
    (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
  )
  try {
    await run({
      setAppState: update => { state = update(state) },
      getState: () => state,
      abortController,
      remove,
      terminated,
      evictOutput,
      unregister,
      timer,
    })
  } finally {
    for (const mock of [remove, terminated, evictOutput, unregister, timer]) mock.mockRestore()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    await rm(directory, { recursive: true, force: true })
  }
}

for (const failureCode of [undefined, 'ELOCKED', 'EPERM']) {
  test(`killing a teammate finalizes exactly once when removal ${failureCode ?? 'succeeds'}`, async () => {
    await withKillFixture(async fixture => {
      const failure = Object.assign(new Error('fixture removal failure'), { code: failureCode })
      if (failureCode) fixture.remove.mockRejectedValue(failure)
      const kill = killInProcessTeammate('worker', fixture.setAppState)
      if (failureCode) await expect(kill).rejects.toBe(failure)
      else expect(await kill).toBe(true)

      expect(fixture.abortController.signal.aborted).toBe(true)
      expect(fixture.getState().tasks.worker).toMatchObject({ status: 'killed', notified: true })
      expect(fixture.getState().teamContext?.teammates).toEqual({})
      expect(fixture.remove).toHaveBeenCalledWith(expect.objectContaining({ teamName: 'fixture', recipient: expect.objectContaining({ memberInstanceId: 'original' }) }), 'worker@fixture')
      expect(fixture.terminated).toHaveBeenCalledWith('worker', 'stopped', {
        toolUseId: 'fixture-tool', summary: 'fixture teammate', ownerAgentId: 'worker@fixture',
      })
      expect(fixture.evictOutput).toHaveBeenCalledWith('worker')
      expect(fixture.unregister).toHaveBeenCalledWith('worker@fixture')
      expect(fixture.timer).toHaveBeenCalledWith(expect.any(Function), framework.STOPPED_DISPLAY_MS)

      // A repeated stop must neither retry persistence nor duplicate finalizers.
      expect(await killInProcessTeammate('worker', fixture.setAppState)).toBe(false)
      expect(await killInProcessTeammate('missing', fixture.setAppState)).toBe(false)
      for (const mock of [fixture.remove, fixture.terminated, fixture.evictOutput, fixture.unregister, fixture.timer]) {
        expect(mock).toHaveBeenCalledTimes(1)
      }
    })
  })
}

async function withSpawnFixture(run: (fixture: {
  spawn: (resumableAgentId?: string) => ReturnType<typeof spawnInProcessTeammate>
  scope: ConsumerScope
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-spawn-teammate-'))
  const originalConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  let state = { tasks: {} } as unknown as AppState
  const spawned: AbortController[] = []
  const team = { name: 'spawn-team', createdAt: 10, leadSessionId: 'lead', leadAgentId: 'team-lead@spawn-team',
    members: [{ name: 'worker', agentId: 'worker@spawn-team', consumerInstanceId: 'a0123456789abcdef',
      backendType: 'in-process' as const, joinedAt: 10, cwd: directory, tmuxPaneId: 'in-process', subscriptions: [] }] }
  await writeTeamFileAsync(team.name, team)
  const list = getCanonicalTeamTaskListId(team.name)
  const lifecycle = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, { teamName: team.name, createdAt: 10, leadSessionId: 'lead' }))
  const scope = consumers.memberConsumerScope({ team, generation: lifecycle.generation, ownerSessionId: 'lead',
    backend: 'in-process', agentName: 'worker', memberInstanceId: 'a0123456789abcdef' })
  try {
    await run({
      scope,
      spawn: async resumableAgentId => {
        const result = await spawnInProcessTeammate(
          { name: 'worker', teamName: 'spawn-team', prompt: 'Work', planModeRequired: false,
            consumerScope: scope, resumableAgentId: 'a0123456789abcdef', isResume: resumableAgentId !== undefined },
          { setAppState: update => { state = update(state) } },
        )
        if (result.abortController) spawned.push(result.abortController)
        return result
      },
    })
  } finally {
    for (const controller of spawned) controller.abort()
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    await rm(directory, { recursive: true, force: true })
  }
}

async function unreadFor(name: string): Promise<string[]> {
  return (await readMailbox(name, 'spawn-team')).filter(m => !m.read).map(m => m.text)
}

test('a delayed spawn cannot clear mail or create a task for a replacement instance', async () => {
  await withSpawnFixture(async fixture => {
    const team = readTeamFile('spawn-team')!
    team.members[0]!.consumerInstanceId = 'replacement'
    await writeTeamFileAsync(team.name, team)
    await writeToMailbox('worker', { from: 'team-lead', text: 'For replacement', timestamp: '2026-10-27T00:00:00Z' }, team.name)
    const result = await fixture.spawn()
    expect(result.success).toBe(false)
    expect(result.taskId).toBeUndefined()
    expect(await unreadFor('worker')).toEqual(['For replacement'])
  })
})

test('a fresh teammate gets a durable transcript id and none of the mail left for an earlier one', async () => {
  await withSpawnFixture(async fixture => {
    await writeToMailbox('worker', { from: 'reviewer', text: 'Stale note for the old worker', timestamp: new Date().toISOString() }, 'spawn-team')

    const result = await fixture.spawn()

    expect(result.success).toBe(true)
    expect(result.identity?.resumableAgentId).toMatch(/^a[0-9a-f]{16}$/)
    expect(await unreadFor('worker')).toEqual([])
  })
})

test('a resumed teammate keeps its transcript id and the mail that arrived while it was stopped', async () => {
  await withSpawnFixture(async fixture => {
    await writeToMailbox('worker', { from: 'team-lead', text: 'Waiting for you', timestamp: new Date().toISOString() }, 'spawn-team')

    const result = await fixture.spawn('aworker-0123456789abcdef')

    expect(result.identity?.resumableAgentId).toBe('a0123456789abcdef')
    expect(await unreadFor('worker')).toEqual(['Waiting for you'])
  })
})
