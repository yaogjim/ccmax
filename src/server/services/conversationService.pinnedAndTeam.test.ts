import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService, type AgentWorkerStart } from './conversationService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'pinned-and-team-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(home, { recursive: true, force: true })
})

const teamWorker = {
  parentSessionId: 'parent',
  teamName: 'approved',
  memberId: 'research',
  name: 'researcher',
  systemPrompt: 'Read only research',
  tools: ['Read'],
}
const pinnedWorker: AgentWorkerStart = {
  parentSessionId: 'parent',
  agentType: 'niuma',
  runId: 'run-1',
  systemPrompt: 'You are niuma.',
  tools: ['Read'],
}

function harness() {
  const service = new ConversationService() as any
  const killed: string[] = []
  service.killProcess = (id: string) => killed.push(id)
  service.waitForProcessOutputDrain = async () => {}
  service.buildRuntimeExitMessage = () => 'CLI exited'
  const parent = {
    proc: { exited: Promise.resolve(1) },
    outputCallbacks: [],
    pendingPermissionRequests: new Map(),
    sdkMessages: [],
    workDir: home,
    permissionMode: 'default',
  }
  const team = { teamWorker, pendingPermissionRequests: new Map() }
  const pinned = { agentWorker: pinnedWorker, pendingPermissionRequests: new Map() }
  service.sessions.set('parent', parent)
  service.sessions.set('team-child', team)
  service.sessions.set('pinned-child', pinned)
  return { service, killed, parent, team, pinned }
}

test('keepTeamWorkers restarts the lead without treating a pinned agent as a teammate', () => {
  const { service, killed } = harness()

  expect(service.isWorkerSession('team-child')).toBe(true)
  expect(service.isWorkerSession('pinned-child')).toBe(true)
  expect(service.isTeamWorkerSession('team-child')).toBe(true)
  expect(service.isTeamWorkerSession('pinned-child')).toBe(false)

  service.stopSession('parent', { keepTeamWorkers: true })

  expect(killed).toEqual(['pinned-child', 'parent'])
  expect(service.hasSession('team-child')).toBe(true)
  expect(service.hasSession('pinned-child')).toBe(false)
})

test('an explicit parent stop still stops both teammates and pinned agents', () => {
  const { service, killed } = harness()
  service.stopSession('parent')
  expect(killed).toEqual(['team-child', 'pinned-child', 'parent'])
  expect(service.hasSession('team-child')).toBe(false)
  expect(service.hasSession('pinned-child')).toBe(false)
})

test('a crashed lead keeps approved teammates and still stops pinned agents', async () => {
  const { service, killed, parent } = harness()
  await service.handleProcessExit('parent', parent.proc, 1)
  expect(killed).toEqual(['pinned-child'])
  expect(service.hasSession('team-child')).toBe(true)
  expect(service.hasSession('pinned-child')).toBe(false)
})

test('stopSessionAndWait keeps teammates, stops pinned agents, and drains pending controls', async () => {
  const { service, parent, team, pinned } = harness()
  const stopped: string[] = []
  const cancelled: string[] = []
  service.stopProcessAndWait = async (id: string) => { stopped.push(id) }
  parent.pendingControlRequests = new Map([['lead-ctl', (reason: Error) => cancelled.push(`lead:${reason.message}`)]])
  pinned.pendingControlRequests = new Map([['pin-ctl', (reason: Error) => cancelled.push(`pin:${reason.message}`)]])
  team.pendingControlRequests = new Map([['team-ctl', (reason: Error) => cancelled.push(`team:${reason.message}`)]])

  await service.stopSessionAndWait('parent', 50, { keepTeamWorkers: true })

  expect(stopped).toEqual(['pinned-child', 'parent'])
  expect(cancelled.sort()).toEqual(['lead:CLI session stopped', 'pin:CLI session stopped'])
  expect(service.hasSession('team-child')).toBe(true)
  expect(service.hasSession('pinned-child')).toBe(false)
  expect(team.pendingControlRequests.size).toBe(1)
})