import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { beginTaskListLifecycle } from '../utils/tasks.js'
import { clearDynamicTeamContext, getDynamicTeamContext } from '../utils/teammate.js'
import { writeTeamFileAsync } from '../utils/swarm/teamHelpers.js'
import { useSwarmInitialization } from './useSwarmInitialization.js'

const originalEnv = { ...process.env }
let home: string
const owner = '11111111-1111-4111-8111-111111111111'
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'swarm-initialization-'))
  const env = createSandboxedTestEnvironment(home, { USER_TYPE: 'ant', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  switchSession(asSessionId(owner))
})
afterAll(async () => {
  clearDynamicTeamContext()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

test('fresh pane installs only its issued scope and resumed name-only history cannot manufacture one', async () => {
  const team = {
    name: 'pane-fixture', createdAt: 10, leadSessionId: 'lead', leadAgentId: 'lead@fixture',
    members: [{ name: 'reader', agentId: 'reader@fixture', consumerInstanceId: 'pane-instance', backendType: 'tmux' as const, sessionId: owner,
      agentType: 'general-purpose', model: 'fixture', joinedAt: 10, tmuxPaneId: 'fixture', cwd: home, subscriptions: [] }],
  }
  const lifecycle = await beginTaskListLifecycle(team.name, { teamName: team.name, createdAt: team.createdAt, leadSessionId: 'lead' })
  await writeTeamFileAsync(team.name, team)
  const scope = { version: 1, teamName: team.name, createdAt: 10, generation: lifecycle.generation, leadSessionId: 'lead', ownerSessionId: owner,
    recipient: { kind: 'member', backend: 'pane', agentName: 'reader', memberInstanceId: 'pane-instance' } }
  for (const fresh of [false, true]) {
    clearDynamicTeamContext()
    let state = getDefaultAppState()
    if (fresh) process.env.CC_HAHA_TEAM_CONSUMER_SCOPE = JSON.stringify(scope)
    const update = (fn: (value: typeof state) => typeof state) => { state = fn(state) }
    const history = [{ type: 'user', teamName: team.name, agentName: 'reader' }] as never
    function Harness() { useSwarmInitialization(update, history); return null }
    const stdout = new PassThrough()
    const mounted = render(<Harness />, { stdout, stderr: stdout, stdin: new PassThrough(), patchConsole: false, exitOnCtrlC: false })
    try {
      for (let index = 0; index < 100 && fresh && !state.teamContext?.consumerScope; index++) await Bun.sleep(1)
      if (!fresh) await Bun.sleep(5)
      expect(state.teamContext?.consumerScope).toEqual(fresh ? scope : undefined)
      expect(getDynamicTeamContext()?.consumerScope).toEqual(fresh ? scope : undefined)
      expect(process.env.CC_HAHA_TEAM_CONSUMER_SCOPE).toBeUndefined()
    } finally { mounted.unmount(); await mounted.waitUntilExit(); stdout.destroy() }
  }
})
