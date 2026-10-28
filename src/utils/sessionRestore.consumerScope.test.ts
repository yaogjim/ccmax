import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { switchSession } from '../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { asSessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { clearDynamicTeamContext, getDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import { writeTeamFileAsync } from './swarm/teamHelpers.js'
import { beginTaskListLifecycle } from './tasks.js'
import { claimScopedMailbox, readScopedMailbox, type ConsumerScope } from './swarm/consumerScope.js'
import { writeToMailbox } from './teammateMailbox.js'
import { clearSessionMetadata } from './sessionStorage.js'
import { processResumedConversation, restoreSessionStateFromLog } from './sessionRestore.js'

const originalEnv = { ...process.env }
const owner = '11111111-1111-4111-8111-111111111111'
let home: string
let state: AppState
let scope: ConsumerScope
const setState = (update: (prev: AppState) => AppState) => { state = update(state) }
const message = (binding?: unknown): Message => ({
  type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'history' },
  ...(binding === undefined ? {} : { consumerScope: binding }),
}) as Message
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'restore-scope-'))
  const env = createSandboxedTestEnvironment(home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
})
beforeEach(() => {
  switchSession(asSessionId(owner))
  clearDynamicTeamContext()
  state = getDefaultAppState()
})
afterAll(async () => {
  clearDynamicTeamContext()
  clearSessionMetadata()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

test('restoring old name-only history immediately clears a previous consumer binding', async () => {
  setDynamicTeamContext({ agentId: 'old', agentName: 'old', teamName: 'old', planModeRequired: false })
  state = { ...state, teamContext: { teamName: 'old', teamFilePath: 'old', leadAgentId: 'old', isLeader: true, teammates: {} } }
  const pending = restoreSessionStateFromLog({ messages: [message()] }, setState)
  expect(state.teamContext).toBeUndefined()
  expect(getDynamicTeamContext()).toBeNull()
  await pending
  expect(state.teamContext).toBeUndefined()
})

test('identity refusal adds a visible warning without blocking readable history', async () => {
  const result = { messages: [{ ...message(), teamName: 'old-team', agentName: 'reader' } as Message] }
  await restoreSessionStateFromLog(result, setState)
  expect(result.messages).toHaveLength(2)
  expect(result.messages[1]).toMatchObject({ type: 'system', level: 'warning', consumerScope: null })
  expect((result.messages[1] as unknown as { content: string }).content).toContain('history remains readable')
})

test('both restore entries accept the latest current binding but refuse unknown, stale, foreign and forked identities', async () => {
  const team = { name: 'restore-fixture', createdAt: 10, leadAgentId: 'lead@restore-fixture', leadSessionId: owner, members: [] }
  const lifecycle = await beginTaskListLifecycle(team.name, { teamName: team.name, createdAt: team.createdAt, leadSessionId: owner })
  await writeTeamFileAsync(team.name, team)
  scope = { version: 1, teamName: team.name, createdAt: 10, generation: lifecycle.generation, leadSessionId: owner, ownerSessionId: owner, recipient: { kind: 'lead' } }
  for (const forkSession of [false, true]) {
    for (const binding of [scope, { ...scope, version: 99 }, { ...scope, generation: lifecycle.generation + 1 }, { ...scope, ownerSessionId: 'other' }, null]) {
      const messages = [message(scope), message(binding), message()]
      const expected = !forkSession && binding === scope ? scope : undefined
      await restoreSessionStateFromLog({ messages }, setState, { forkSession })
      expect(state.teamContext?.consumerScope).toEqual(expected)
      if (expected) {
        expect(await writeToMailbox('team-lead', { from: 'reader', text: 'restored reception', timestamp: '2026-10-27T00:00:00Z' }, team.name)).toBe(true)
        const unread = await readScopedMailbox(state.teamContext!.consumerScope!)
        expect(unread.status).toBe('current')
        if (unread.status === 'current') {
          expect(unread.value.map(item => item.text)).toEqual(['restored reception'])
          const claimed = await claimScopedMailbox(state.teamContext!.consumerScope!, unread.value)
          expect(claimed.status).toBe('claimed')
        }
      }
      const processed = await processResumedConversation({ messages, sessionId: asSessionId(owner) }, { forkSession }, {
        modeApi: null, mainThreadAgentDefinition: undefined,
        agentDefinitions: { activeAgents: [], allAgents: [] }, currentCwd: home, cliAgents: [],
        initialState: state, hasExplicitCliEffort: false,
      })
      expect(processed.initialState.teamContext?.consumerScope).toEqual(expected)
      if (forkSession) {
        expect(processed.messages.every(item => (item as unknown as { consumerScope: unknown }).consumerScope === null)).toBe(true)
        await restoreSessionStateFromLog({ messages: processed.messages }, setState)
        expect(state.teamContext).toBeUndefined()
      }
    }
  }
})
