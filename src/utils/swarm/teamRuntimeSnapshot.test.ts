import { expect, test } from 'bun:test'
import { buildTeamRuntimeSnapshot, installProcessConsumerScope } from './teamRuntimeSnapshot.js'
import type { TeamFile } from './teamHelpers.js'

test('process env scope is installed only for its real session and current roster', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { writeTeamFileAsync, mutateTeamFileAsync } = await import('./teamHelpers.js')
  const { beginTaskListLifecycle, getCanonicalTeamTaskListId } = await import('../tasks.js')
  const home = await mkdtemp(join(tmpdir(), 'snapshot-scope-'))
  const oldHome = process.env.HOME
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const fixture = { ...team, members: team.members.map(member => ({ ...member, consumerInstanceId: 'original', sessionId: 'worker-session' })) }
    await writeTeamFileAsync(team.name, fixture)
    const lifecycle = await beginTaskListLifecycle(getCanonicalTeamTaskListId(team.name), { teamName: team.name, createdAt: 1, leadSessionId: 'leader-session' })
    const workerScope = { ...scope, generation: lifecycle.generation, ownerSessionId: 'worker-session', recipient: { kind: 'member', backend: 'process', agentName: 'worker', memberInstanceId: 'original', memberSessionId: 'worker-session' } }
    let installed: unknown
    expect((await installProcessConsumerScope(JSON.stringify(workerScope), 'foreign-session', value => { installed = value })).status).toBe('stale')
    expect(installed).toBeUndefined()
    expect((await installProcessConsumerScope(JSON.stringify(workerScope), 'worker-session', value => { installed = value })).status).toBe('current')
    expect(installed).toMatchObject({ consumerScope: workerScope, isLeader: false, teamName: team.name })
    installed = undefined
    await mutateTeamFileAsync(team.name, current => { current.members[0]!.backendType = 'tmux' })
    const paneScope = { ...workerScope, recipient: { ...workerScope.recipient, backend: 'pane' } }
    expect((await installProcessConsumerScope(paneScope, 'worker-session', value => { installed = value })).status).toBe('current')
    expect(installed).toMatchObject({ consumerScope: paneScope, isLeader: false })
    installed = undefined
    await mutateTeamFileAsync(team.name, current => ({ ...current, members: current.members.map(member => ({ ...member, consumerInstanceId: 'replacement' })) }))
    expect((await installProcessConsumerScope(workerScope, 'worker-session', value => { installed = value })).status).toBe('stale')
    expect(installed).toBeUndefined()
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    await rm(home, { recursive: true, force: true })
  }
})

const team: TeamFile = { name: 'team', createdAt: 1, leadSessionId: 'leader-session', leadAgentId: 'team-lead@team', members: [{ agentId: 'worker@team', name: 'worker', joinedAt: 2, cwd: '/fixture', tmuxPaneId: '', subscriptions: [], backendType: 'process' }] }
const scope = { version: 1 as const, teamName: 'team', generation: 3, createdAt: 1, leadSessionId: 'leader-session', ownerSessionId: 'leader-session', recipient: { kind: 'lead' as const } }

test('reconnect restores approved members structurally without spawning them', () => {
  const context = buildTeamRuntimeSnapshot(team, 1, 'leader-session', '/fixture/team.json', scope)
  expect(context.consumerScope).toEqual(scope)
  expect(context.leadAgentId).toBe('team-lead@team')
  expect(context.teammates['worker@team']?.tmuxSessionName).toBe('process')
  expect(context.isLeader).toBe(true)
})
test('missing and unsupported host identities cannot silently acquire the current team', () => {
  expect(() => buildTeamRuntimeSnapshot(team, 1, 'leader-session', '/fixture/team.json', undefined)).toThrow('unbound')
  expect(() => buildTeamRuntimeSnapshot(team, 1, 'leader-session', '/fixture/team.json', { ...scope, version: 2 })).toThrow('unsupported')
  expect(() => buildTeamRuntimeSnapshot(team, 1, 'leader-session', '/fixture/team.json', { ...scope, ownerSessionId: 'foreign' })).toThrow('foreign')
})
test('old team generations and foreign leaders cannot install a snapshot', () => {
  expect(() => buildTeamRuntimeSnapshot(team, 0, 'leader-session', '/fixture/team.json', scope)).toThrow('Stale')
  expect(() => buildTeamRuntimeSnapshot(team, 1, 'other-session', '/fixture/team.json', scope)).toThrow('foreign')
  expect(() => buildTeamRuntimeSnapshot(null, 1, 'leader-session', '/fixture/team.json', scope)).toThrow('Stale')
})
