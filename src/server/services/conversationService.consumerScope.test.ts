import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService } from './conversationService.js'
import { mutateTeamFileAsync, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../../utils/tasks.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'scoped-sdk-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

async function fixture() {
  const teamName = 'scoped-sdk'
  const team = {
    name: teamName, createdAt: 10, leadSessionId: 'lead', leadAgentId: `team-lead@${teamName}`,
    members: [{ agentId: `reader@${teamName}`, name: 'reader', consumerInstanceId: 'instance-1', sessionId: 'child', backendType: 'process' as const, joinedAt: 10, cwd: home, tmuxPaneId: '', subscriptions: [] }],
  }
  await writeTeamFileAsync(teamName, team)
  const taskListId = getCanonicalTeamTaskListId(teamName)
  const lifecycle = await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, { teamName, createdAt: 10, leadSessionId: 'lead' }))
  const scope = { version: 1, teamName, generation: lifecycle.generation, createdAt: 10, leadSessionId: 'lead', ownerSessionId: 'child', recipient: { kind: 'member', backend: 'process', agentName: 'reader', memberInstanceId: 'instance-1', memberSessionId: 'child' } }
  const service = new ConversationService() as any
  const session = { sdkSocket: null, pendingOutbound: [], pendingPermissionRequests: new Map(), outputCallbacks: [], workDir: home, usesOfficialOAuth: false }
  service.sessions.set('child', session)
  service.buildUserContent = async (content: string) => content
  service.refreshNetworkEnvironmentBeforeTurn = async () => true
  service.refreshOfficialOAuthTokenBeforeTurn = async () => {}
  service.killProcess = () => {}
  return { teamName, service, session, scope }
}

test('Stop rejects unsent SDK work exactly once and reconnect does not replay it', async () => {
  const { service, session, scope } = await fixture()
  const receipt = await service.sendScopedMessage('child', 'held work', scope)
  expect(receipt.status).toBe('queued')
  let resolutions = 0
  void receipt.completion.then(() => { resolutions++ })
  service.cancelScopedMessages('child', { recipient: { ...scope.recipient }, ...scope }, 'cancelled')
  service.cancelScopedMessages('child', scope, 'cancelled')
  expect(await receipt.completion).toEqual({ status: 'rejected', reason: 'cancelled' })
  const sent: string[] = []
  service.attachSdkConnection('child', { send: (line: string) => sent.push(line) })
  await session.outboundDrain
  expect(resolutions).toBe(1)
  expect(sent).toEqual([])
})

test('concurrent attaches use only the final socket and send a queued item once', async () => {
  const { service, session, scope } = await fixture()
  const receipt = await service.sendScopedMessage('child', 'valid work', scope)
  const old: string[] = []
  const current: string[] = []
  service.attachSdkConnection('child', { send: (line: string) => old.push(line) })
  service.attachSdkConnection('child', { send: (line: string) => current.push(line) })
  expect(await receipt.completion).toEqual({ status: 'sent' })
  await session.outboundDrain
  expect(old).toEqual([])
  expect(current).toHaveLength(1)
  expect(JSON.parse(current[0]!).message.content).toBe('valid work')
})

test('synchronous transport failure rejects the receipt and ends the failed session without replay', async () => {
  const { service, scope } = await fixture()
  const receipt = await service.sendScopedMessage('child', 'uncertain transport', scope)
  let attempts = 0
  service.attachSdkConnection('child', { send: () => { attempts++; throw new Error('fixture transport failure') } })
  expect(await receipt.completion).toEqual({ status: 'rejected', reason: 'transport' })
  // The receipt settles inside the short commit; session teardown follows outside.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(service.hasSession('child')).toBe(false)
  expect(attempts).toBe(1)
})

test('session replacement rejects queued work without sending into the replacement', async () => {
  const { service, session, scope } = await fixture()
  const receipt = await service.sendScopedMessage('child', 'old process work', scope)
  const sent: string[] = []
  service.attachSdkConnection('child', { send: (line: string) => sent.push(line) })
  service.sessions.set('child', { ...session, sdkSocket: { send: (line: string) => sent.push(line) }, pendingOutbound: [] })
  expect(await receipt.completion).toEqual({ status: 'rejected', reason: 'session_replaced' })
  expect(sent).toEqual([])
})

test('scoped SDK enqueue is not sent, and member replacement fences attach without sending', async () => {
  const { teamName, service, scope } = await fixture()
  const receipt = await service.sendScopedMessage('child', 'private old work', scope)
  expect(receipt.status).toBe('queued')
  let settled = false
  void receipt.completion.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  await mutateTeamFileAsync(teamName, team => ({ ...team, members: team.members.map(member => ({ ...member, consumerInstanceId: 'instance-2' })) }))
  const sent: string[] = []
  service.attachSdkConnection('child', { send: (line: string) => sent.push(line) })
  expect(await receipt.completion).toMatchObject({ status: 'rejected', reason: 'stale' })
  expect(sent).toEqual([])
})
