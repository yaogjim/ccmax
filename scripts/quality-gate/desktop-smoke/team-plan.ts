import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'

export const TEAM_SMOKE_PROVIDER = 'desktop-ui-economy-provider'
export const TEAM_SMOKE_MODEL = 'desktop-ui-economy-model'
export const TEAM_SMOKE_TEAM = 'desktop-ui-review-team'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{ stdout: string; stderr: string }>

export function seedDesktopUiTeamPlan(configDir: string, sessionId: string, workDir: string): TeamPlanRecord {
  const createdAt = 1720000000000
  const teamName = TEAM_SMOKE_TEAM
  const plan: TeamPlanRecord = {
    schemaVersion: 1, planId: 'desktop-ui-review-plan', sessionId, teamName,
    incarnationId: createHash('sha256').update(JSON.stringify([teamName, sessionId, createdAt])).digest('hex'),
    revision: 1, state: 'review_pending', workDir, createdAt, updatedAt: createdAt,
    leaderRuntime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
    agentCatalog: { engineer: { systemPrompt: 'You are an isolated smoke-test engineer. Reply with a short status.', source: 'built-in', sourceIdentity: { kind: 'builtin' }, tools: ['TaskList'] } },
    members: ['builder', 'reviewer'].map(name => ({
      id: name, name, agentType: 'engineer', prompt: `Complete the isolated ${name} task.`,
      runtime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
      suggestedRuntime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
    })),
    tasks: [],
  }
  const directory = join(configDir, 'teams', teamName)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    name: teamName, createdAt, leadSessionId: sessionId, leadAgentId: `team-lead@${teamName}`, reviewRequired: true,
    members: [{ agentId: `team-lead@${teamName}`, name: 'team-lead', agentType: 'team-lead', joinedAt: createdAt, cwd: workDir, tmuxPaneId: '', subscriptions: [] }],
  }))
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan))
  return plan
}

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for team review smoke: ${label}`)
}

export type TeamWorkerEvent = { phase: string; sessionId: string; resume?: boolean; historyEntries?: number; [key: string]: unknown }

export function assertTeamWorkerBoots(events: TeamWorkerEvent[], sessionId: string, resumed: boolean) {
  const boots = events.filter(event => event.phase === 'boot' && event.sessionId === sessionId)
  if (boots.length !== (resumed ? 2 : 1) || boots[0]?.resume !== false || (resumed && boots[1]?.resume !== true)) throw new Error(`Unexpected worker boot sequence: ${JSON.stringify(boots)}`)
  if (resumed && !(Number(boots[1]?.historyEntries) > 0)) throw new Error('Resumed worker lost its history')
}

export function inspectMemberConversation(probe: { keys?: string[]; text?: string }, messageId: string) {
  const keys = probe.keys ?? []
  const pending = keys.includes(messageId)
  const settled = keys.includes(`echo-${messageId}`)
  return { pending, settled, duplicates: pending && settled || keys.filter(key => key === `echo-${messageId}`).length > 1 }
}

export async function runDesktopUiTeamPlanSmoke(options: {
  configDir: string; sessionId: string; projectDir: string; baseUrl: string; artifactDir: string; auditPath: string; echoGatePath: string; browserStep: BrowserStep
  assignTask: () => Promise<string>
  restartServer: () => Promise<{ oldPid: number; newPid: number }>
}) {
  const { configDir, sessionId, projectDir, baseUrl, artifactDir, auditPath, browserStep } = options
  seedDesktopUiTeamPlan(configDir, sessionId, projectDir)
  const getPlan = async () => {
    const response = await fetch(`${baseUrl}/api/teams/session/${encodeURIComponent(sessionId)}/plan`)
    if (!response.ok) throw new Error(`Plan read failed: ${response.status} ${await response.text()}`)
    return (await response.json() as { plan: TeamPlanRecord }).plan
  }
  const assertNoWorkers = () => {
    if (existsSync(auditPath) && readFileSync(auditPath, 'utf8').trim()) throw new Error('A team worker booted before human approval')
    const team = JSON.parse(readFileSync(join(configDir, 'teams', TEAM_SMOKE_TEAM, 'config.json'), 'utf8'))
    if (team.members.length !== 1) throw new Error('A staged member was created before human approval')
  }
  if (!(await getPlan())) throw new Error('Seeded team plan was not readable through the session API')
  await browserStep(['wait', '[data-testid="team-plan-open"]'])
  assertNoWorkers()
  await browserStep(['click', '[data-testid="team-plan-open"]'])
  await browserStep(['click', 'button[aria-label="builder · Provider and model"]'])
  await browserStep(['wait', '[data-testid="model-selector-dropdown"]'])
  // Search keeps the target in view even in the short CI viewport. Assert the
  // controlled trigger changed before introducing a remote revision conflict.
  await browserStep(['fill', '[data-testid="model-selector-dropdown"] input', TEAM_SMOKE_MODEL])
  await browserStep(['find', 'text', TEAM_SMOKE_MODEL, 'click', '--exact'])
  const selectedModel = await browserStep(['get', 'text', 'button[aria-label="builder · Provider and model"]'])
  if (!selectedModel.stdout.includes(TEAM_SMOKE_MODEL)) throw new Error('Member model selection did not update the review draft')
  const current = await getPlan()
  const changedElsewhere = await fetch(`${baseUrl}/api/teams/${TEAM_SMOKE_TEAM}/plan`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, planId: current.planId, incarnationId: current.incarnationId, expectedRevision: current.revision, members: [], tasks: [] }),
  })
  if (!changedElsewhere.ok) throw new Error(`Conflict setup failed: ${await changedElsewhere.text()}`)
  await browserStep(['wait', '[data-testid="team-plan-reapply"]'])
  const conflict = await browserStep(['eval', 'document.querySelector("[data-testid=team-plan-approve]").disabled'])
  if (!conflict.stdout.includes('true')) throw new Error('Stale plan could be approved while a conflicting edit was pending')
  await browserStep(['click', '[data-testid="team-plan-reapply"]'])
  await browserStep(['click', '[data-testid="team-plan-save"]'])
  await until(async () => (await getPlan()).members[0]?.runtime.providerId === TEAM_SMOKE_PROVIDER, 'cross-provider draft save')
  assertNoWorkers()
  await browserStep(['reload'])
  await browserStep(['wait', '[data-testid="team-plan-open"]'])
  await browserStep(['click', '[data-testid="team-plan-open"]'])
  const restored = await browserStep(['get', 'text', 'button[aria-label="builder · Provider and model"]'])
  if (!restored.stdout.includes(TEAM_SMOKE_MODEL)) throw new Error('Reload did not recover the saved member model')
  assertNoWorkers()
  await browserStep(['screenshot', join(artifactDir, 'team-review-pending.png')], { allowFailure: true })
  await browserStep(['click', '[data-testid="team-plan-approve"]'])
  await until(async () => {
    const plan = await getPlan()
    if (plan.state === 'launch_failed' || plan.state === 'interrupted') throw new Error(`Team launch failed: ${plan.launch?.error}`)
    return plan.state === 'running'
  }, 'approved team to reach running')
  const events = (): TeamWorkerEvent[] => existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const readTeam = () => JSON.parse(readFileSync(join(configDir, 'teams', TEAM_SMOKE_TEAM, 'config.json'), 'utf8'))
  const record = (phase: string, evidence: unknown) => appendFileSync(join(artifactDir, 'team-p3-evidence.jsonl'), JSON.stringify({ phase, evidence }) + '\n')
  const evalJson = async <T>(expression: string): Promise<T> => JSON.parse((await browserStep(['eval', expression])).stdout.trim())
  const strip = `[data-testid="agent-teams-strip"][title="${TEAM_SMOKE_TEAM}"]`
  const memberCard = (name: string) => `[data-testid="agent-teams-canvas-member-${name}@${TEAM_SMOKE_TEAM}"]`
  const conversation = '[data-testid="team-member-conversation"]'
  const composer = '[data-composer-editor]:not([data-testid="session-tab-panel"] [data-composer-editor])'
  const send = 'button[aria-label="Send"]:not([data-testid="session-tab-panel"] button[aria-label="Send"])'
  const probeConversation = () => evalJson<{ keys: string[]; text: string }>(`(() => { const root = document.querySelector('${conversation}'); return { keys: [...(root?.querySelectorAll('[data-chat-render-item-key]') ?? [])].map(node => node.getAttribute('data-chat-render-item-key')), text: root?.innerText ?? '' } })()`)
  const openLead = () => browserStep(['click', '[data-testid="tab-bar-scroll-region"] .tab-strip-item:first-child'])
  const openBoard = async () => {
    const alreadyOpen = await evalJson<boolean>('Boolean(document.querySelector("[data-testid=agent-teams-office-viewport]"))')
    if (alreadyOpen) return
    await openLead()
    await browserStep(['wait', strip])
    await browserStep(['click', strip])
    await browserStep(['wait', memberCard('builder')])
  }
  const openMember = async () => {
    await browserStep(['click', memberCard('builder')])
    await browserStep(['find', 'role', 'button', 'click', '--name', 'View builder execution', '--exact'])
    await browserStep(['wait', conversation])
    await browserStep(['wait', composer])
  }
  await until(async () => readTeam().members.length === 3, 'approved roster without processes')
  await openBoard()
  for (const name of ['builder', 'reviewer']) {
    await browserStep(['wait', `${memberCard(name)}[data-member-state="standby"]`])
    const entry = readTeam().members.find((member: { name: string }) => member.name === name)
    if (!entry?.initialStartPending || !entry.sessionId) throw new Error(`${name} did not get a dormant identity`)
  }
  await Bun.sleep(1_000)
  if (events().length > 0) throw new Error('Approval started a role with no task')
  const builderId = readTeam().members.find((member: { name: string }) => member.name === 'builder').sessionId
  const reviewerId = readTeam().members.find((member: { name: string }) => member.name === 'reviewer').sessionId
  record('approved-standby', { team: readTeam(), events: events() })
  const taskId = await options.assignTask()
  const taskPath = join(configDir, 'tasks', TEAM_SMOKE_TEAM, `${taskId}.json`)
  const readTask = () => JSON.parse(readFileSync(taskPath, 'utf8'))
  await until(async () => events().some(event => event.phase === 'submit' && event.version === 1), 'dynamic task first start and owner v1 submit')
  assertTeamWorkerBoots(events(), builderId, false)
  if (events().some(event => event.sessionId === reviewerId)) throw new Error('Unassigned reviewer started')
  const builderBoot = events().find(event => event.phase === 'boot')
  if (builderBoot?.model !== TEAM_SMOKE_MODEL || builderBoot?.baseUrl !== 'http://127.0.0.1:2') throw new Error('Approved runtime routing was lost')
  record('dynamic-first-start', { task: readTask(), events: events() })
  await openMember()
  writeFileSync(options.echoGatePath, '')
  const directText = 'P3 identity-bound direct instruction'
  await browserStep(['type', composer, directText])
  await browserStep(['click', send])
  const inboxPath = join(configDir, 'teams', TEAM_SMOKE_TEAM, 'inboxes', 'builder.json')
  const inbox = () => {
    const live = existsSync(inboxPath) ? JSON.parse(readFileSync(inboxPath, 'utf8')) : []
    const historyPath = inboxPath.replace(/\.json$/, '.history.jsonl')
    const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map(line => ({ ...JSON.parse(line), read: true })) : []
    // The production ACK archives read envelopes and removes them from live.
    return [...history, ...live] as Array<{ id: string; from: string; text: string; read?: boolean }>
  }
  await until(async () => inbox().some(message => message.text === directText), 'identity-bound API delivery')
  const envelope = inbox().find(message => message.text === directText)!
  if (envelope.from !== 'user') throw new Error('Direct sender identity changed')
  await until(async () => inspectMemberConversation(await probeConversation(), envelope.id).pending, 'pending bubble identity')
  record('member-pending', { envelope, probe: await probeConversation() })
  rmSync(options.echoGatePath, { force: true })
  await until(async () => {
    const probe = await probeConversation()
    const inspected = inspectMemberConversation(probe, envelope.id)
    return inspected.settled && !inspected.pending && !inspected.duplicates && probe.text.includes(`Ack: ${directText}`)
  }, 'real mailbox ACK and simulated SDK echo settle the same bubble')
  if (!inbox().find(message => message.id === envelope.id)?.read) throw new Error('Production supervisor did not ACK the direct message')
  record('member-settled', { envelopeId: envelope.id, probe: await probeConversation(), events: events() })
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Back to team overview', '--exact'])
  const taskCard = `[data-testid="agent-teams-canvas-task-${taskId}"]`
  await browserStep(['wait', taskCard])
  await browserStep(['click', taskCard])
  await browserStep(['wait', '[data-testid="agent-teams-delivery-version-1"]'])
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Return', '--exact'])
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Return this version', '--exact'])
  await browserStep(['wait', '--fn', 'document.querySelector("[data-testid=agent-teams-task-delivery] [role=alert]")?.textContent.includes("A reason is required")'])
  if (readTask().delivery.revision !== 1) throw new Error('Empty return reason committed a review')
  await browserStep(['fill', '[data-testid="agent-teams-task-delivery"] textarea', 'Add rollback before acceptance'])
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Return this version', '--exact'])
  await until(async () => readTask().delivery?.submissions.length === 2, 'production return notice causes owner v2 submit')
  const returned = readTask()
  if (returned.delivery.submissions[0].review?.reviewer !== 'user' || returned.delivery.submissions[0].review?.decision !== 'return') throw new Error('v1 lacked independent return')
  record('delivery-return-and-resubmit', returned)
  await browserStep(['reload'])
  await openBoard()
  await browserStep(['click', taskCard])
  await browserStep(['wait', '[data-testid="agent-teams-delivery-version-2"]'])
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Accept', '--exact'])
  await until(async () => readTask().status === 'completed', 'independent v2 acceptance')
  const accepted = readTask()
  if (accepted.delivery.revision !== 4 || accepted.delivery.submissions[1].review?.reviewer !== 'user' || accepted.delivery.submissions[1].review?.decision !== 'accept' || accepted.delivery.submissions[0].review?.reason !== 'Add rollback before acceptance') throw new Error('Delivery version history was not preserved')
  record('delivery-accepted', accepted)
  assertTeamWorkerBoots(events(), builderId, false)
  await browserStep(['reload'])
  await openBoard()
  await openMember()
  const stoppedText = 'P3 pending reply must settle on Stop'
  writeFileSync(options.echoGatePath, '')
  await browserStep(['type', composer, stoppedText])
  await browserStep(['click', send])
  await until(async () => inbox().some(message => message.text === stoppedText), 'held Stop envelope')
  const heldEnvelope = inbox().find(message => message.text === stoppedText)!
  await until(async () => inspectMemberConversation(await probeConversation(), heldEnvelope.id).pending, 'held Stop pending bubble')
  // This is the actual Thinking/Working status line, not the retained pending
  // bubble body. Stop must clear it even though the user's text stays visible.
  const thinkingSelector = `${conversation} [data-testid="turn-status-indicator"]`
  await browserStep(['wait', thinkingSelector])
  record('stop-before-pending-thinking', { envelope: heldEnvelope, probe: await probeConversation() })
  await openLead()
  await browserStep(['screenshot', join(artifactDir, 'team-review-running.png')], { allowFailure: true })
  await browserStep(['wait', '--fn', '!document.querySelector("[data-testid=team-plan-open]") && !document.querySelector("[data-testid=team-plan-approve]")'])
  await browserStep(['wait', 'button[aria-label="Stop"]'])
  await browserStep(['click', 'button[aria-label="Stop"]'])
  // Stop pauses an approved team: every worker stops and keeps its saved
  // conversation, and the plan stays running so a later message resumes it.
  await until(async () => {
    const team = JSON.parse(readFileSync(join(configDir, 'teams', TEAM_SMOKE_TEAM, 'config.json'), 'utf8'))
    return team.members
      .filter((member: { sessionId: string }) => member.sessionId === builderId)
      .every((member: { isActive?: boolean; terminated?: boolean }) => member.isActive === false && member.terminated === true)
  }, 'visible Stop to stop every running team worker')
  const paused = await getPlan()
  if (paused.state !== 'running') throw new Error(`Stop ended the approved team instead of pausing it (plan ${paused.state})`)
  await browserStep(['screenshot', join(artifactDir, 'team-review-stopped.png')], { allowFailure: true })
  if (!readTeam().pausedAt) throw new Error('Stop did not persist its pause fence')
  await openBoard()
  await openMember()
  await browserStep(['wait', '--fn', `!document.querySelector('${thinkingSelector}')`])
  const afterStop = await probeConversation()
  if (afterStop.text.includes(`Ack: ${stoppedText}`) || inspectMemberConversation(afterStop, heldEnvelope.id).settled || events().some(event => event.phase === 'ack' && event.messageId === heldEnvelope.id)) throw new Error('Stop invented a mailbox echo or reply for held input')
  record('stop-pending-thinking-cleared', { probe: afterStop, epoch: readTeam().stopEpoch })
  // The killed mock must not release held work after Stop. A fresh instruction
  // after the real service restart is the only authorized continuation.
  rmSync(options.echoGatePath, { force: true })
  const stoppedEpoch = readTeam().stopEpoch
  const bootCount = events().filter(event => event.phase === 'boot').length
  const lifecycle = await options.restartServer()
  if (lifecycle.oldPid === lifecycle.newPid) throw new Error('Service restart did not replace the local process')
  await browserStep(['reload'])
  await openBoard()
  await Bun.sleep(1_500)
  if (events().filter(event => event.phase === 'boot').length !== bootCount || readTeam().pausedAt === undefined || readTeam().stopEpoch !== stoppedEpoch) throw new Error('Service restart or reload revived a stopped worker')
  if (readTask().delivery?.submissions[1]?.review?.decision !== 'accept') throw new Error('Service restart lost delivery acceptance')
  record('restart-reload-stays-paused', { lifecycle, team: readTeam(), workerEvents: events() })
  await openMember()
  const continueText = 'P3 new legal instruction after local service restart'
  await browserStep(['type', composer, continueText])
  await browserStep(['click', send])
  await until(async () => events().some(event => event.phase === 'ack' && event.text === continueText), 'new legal instruction resumes the saved worker')
  const continued = inbox().find(message => message.text === continueText)!
  await until(async () => {
    const probe = await probeConversation()
    const result = inspectMemberConversation(probe, continued.id)
    return result.settled && !result.pending && !result.duplicates && probe.text.includes(`Ack: ${continueText}`) && probe.text.includes(`Ack: ${directText}`)
  }, 'saved member history and new echo after restart')
  assertTeamWorkerBoots(events(), builderId, true)
  if (events().some(event => event.sessionId === reviewerId)) throw new Error('Dormant reviewer revived without an instruction')
  await until(async () => readTeam().pausedAt === undefined, 'new instruction clears pause fence')
  record('continued', { team: readTeam(), probe: await probeConversation(), workerEvents: events() })
  writeFileSync(join(artifactDir, 'team-review-result.json'), JSON.stringify({ plan: await getPlan(), lifecycle, workerEvents: events(), task: readTask(), evidenceBoundary: { production: ['browser approval', 'dynamic task store', 'supervisor launch and delivery ACK', 'identity-bound HTTP mailbox write', 'delivery protocol and human review', 'Stop', 'service process restart and rehydration'], mock: ['SDK transcript generation and member reply', 'scripted owner delivery submission'] } }, null, 2))
  await browserStep(['screenshot', join(artifactDir, 'team-after-restart-continued.png')], { allowFailure: true })
}
