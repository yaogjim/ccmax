import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'
import type { FunctionHook } from '../hooks/sessionHooks.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'
import { readMailbox, writeToMailbox } from '../teammateMailbox.js'
import { memberConsumerScope, type ConsumerScope } from './consumerScope.js'
import { getTeamFilePath, mutateTeamFileAsync, readTeamFile, writeTeamFileAsync } from './teamHelpers.js'
import { initializeTeammateHooks } from './teammateInit.js'

const TEAM = 'hook-team'
const SESSION = 'pane-owner'
let configDir: string
let originalConfig: string | undefined
let scope: ConsumerScope
let state: AppState
const setAppState = (update: (previous: AppState) => AppState) => { state = update(state) }

beforeEach(async () => {
  originalConfig = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-teammate-init-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const team = {
    name: TEAM, createdAt: 42, leadSessionId: 'lead-owner', leadAgentId: `lead@${TEAM}`,
    members: [
      { agentId: `lead@${TEAM}`, name: 'lead', joinedAt: 1, tmuxPaneId: '', cwd: '.', subscriptions: [] },
      { agentId: `worker@${TEAM}`, name: 'worker', consumerInstanceId: 'original-instance', sessionId: SESSION,
        backendType: 'tmux' as const, joinedAt: 2, tmuxPaneId: '%1', cwd: '.', subscriptions: [], isActive: true },
    ],
  }
  await writeTeamFileAsync(TEAM, team)
  const listId = getCanonicalTeamTaskListId(TEAM)
  const lifecycle = await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, {
    teamName: TEAM, createdAt: team.createdAt, leadSessionId: team.leadSessionId,
  }))
  scope = memberConsumerScope({ team, generation: lifecycle.generation, ownerSessionId: SESSION,
    backend: 'pane', agentName: 'worker', memberInstanceId: 'original-instance' })
  state = { sessionHooks: new Map(), toolPermissionContext: {
    mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
  } } as unknown as AppState
})

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await rm(configDir, { recursive: true, force: true })
})

async function initialize(consumerScope: ConsumerScope | undefined = scope) {
  await initializeTeammateHooks(setAppState, SESSION, {
    teamName: TEAM, agentId: `worker@${TEAM}`, agentName: 'worker', consumerScope,
  })
}

function stopHook(): FunctionHook {
  const hook = state.sessionHooks.get(SESSION)!.hooks.Stop![0]!.hooks[0]!.hook
  if (hook.type !== 'function') throw new Error('Expected registered function Stop hook')
  return hook
}

test('current Stop hook marks only its member idle and notifies the explicit team leader', async () => {
  await initialize()
  expect(await stopHook().callback([])).toBe(true)
  expect(readTeamFile(TEAM)?.members[1]?.isActive).toBe(false)
  expect(readTeamFile(TEAM)?.members[0]?.isActive).toBeUndefined()
  const messages = await readMailbox('lead', TEAM)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.from).toBe('worker')
  expect(JSON.parse(messages[0]!.text)).toMatchObject({ type: 'idle_notification', from: 'worker', idleReason: 'available' })
})

test('unbound and stale initialization cannot install team permissions or hooks', async () => {
  await mutateTeamFileAsync(TEAM, team => {
    team.teamAllowedPaths = [{ toolName: 'Edit', path: '/shared' }]
  })
  await initializeTeammateHooks(setAppState, SESSION, { teamName: TEAM, agentId: `worker@${TEAM}`, agentName: 'worker' })
  await initialize({ ...scope, generation: scope.generation + 1 })
  expect(state.sessionHooks.size).toBe(0)
  expect(state.toolPermissionContext.alwaysAllowRules).toEqual({})
})

test('trusted initialization retains existing absolute and relative team path rules', async () => {
  await mutateTeamFileAsync(TEAM, team => {
    team.teamAllowedPaths = [{ toolName: 'Edit', path: '/shared' }, { toolName: 'Write', path: 'output' }]
  })
  await initialize()
  expect(state.toolPermissionContext.alwaysAllowRules.session).toEqual(['Edit(//shared/**)', 'Write(output/**)'])
  expect(state.sessionHooks.get(SESSION)?.hooks.Stop).toHaveLength(1)
})

test('registered Stop hook cannot idle a replacement or write its leader mailbox', async () => {
  await initialize()
  await mutateTeamFileAsync(TEAM, team => { team.members[1]!.consumerInstanceId = 'replacement-instance' })
  await writeToMailbox('lead', { from: 'fixture', text: 'existing', timestamp: 'fixture' }, TEAM)
  const before = await readFile(getTeamFilePath(TEAM), 'utf-8')
  const mail = await readMailbox('lead', TEAM)

  expect(await stopHook().callback([])).toBe(true)

  expect(await readFile(getTeamFilePath(TEAM), 'utf-8')).toBe(before)
  expect(await readMailbox('lead', TEAM)).toEqual(mail)
})
