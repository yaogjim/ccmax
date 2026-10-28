import { isTaskAwaitingReview, isTaskDeliveryUnsupported } from '../../shared/taskDelivery.js'
import { flushTaskDeliveryNotices } from '../../utils/taskDelivery.js'
import { createHash, randomUUID } from 'node:crypto'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidTeamMemberName, teamPlanRecordSchema, type TeamPlanRecord, type TeamPlanMember, type TeamPlanTask } from '../../shared/teamPlan.js'
import { conversationService, type ScopedSendOutcome } from './conversationService.js'
import { readScopedMailbox, claimScopedMailbox, withConsumerScope, type ConsumerScope } from '../../utils/swarm/consumerScope.js'
import { ProviderService } from './providerService.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { resolveAgentRuntimeModel } from './agentRuntimeModel.js'
import { validateAgentPresetSnapshot } from './agentPresetValidation.js'
import { getModelReasoningCapabilityOverride, isModelReasoningEffort, normalizeModelReasoningEffort } from '../../shared/modelReasoning.js'
import { getPresetDefaultEnv, getPresetReasoningProviderKind } from './providerRuntimeEnv.js'
import { validateTeamPlanPresetSource } from '../../utils/swarm/teamPlanPresetSource.js'
import { readTeamPlan, findTeamPlanForSession, mutateTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { cleanupTeamDirectories, getTeamDir, mutateTeamFileAsync, readTeamFile, TeamFileNotFoundError, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { getTeamsDir as getTeamsDirectory } from '../../utils/envUtils.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { createTask, listTasks, updateTask, withTaskListLifecycleLock, readTaskListLifecycleState, getCanonicalTeamTaskListId, findUnsatisfiedBlockers, type Task } from '../../utils/tasks.js'
import { readMailboxHistory, writeToMailbox, createIdleNotification, formatTeammateMessages, isShutdownRequest, type TeammateMessage } from '../../utils/teammateMailbox.js'
import { formatTeammateAutoContinuePrompt, isTransientTurnFailure, summarizeTurnFailure, TEAMMATE_AUTO_CONTINUE_DELAYS_MS } from '../../utils/swarm/turnFailure.js'

const providerService = new ProviderService()
const essentialTools = ['SendMessage', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']

const SUPERVISOR_INTERVAL_MS = 250
const WORKER_AUTO_CONTINUE_DELAYS_MS = TEAMMATE_AUTO_CONTINUE_DELAYS_MS
const WORKER_RESTART_WINDOW_MS = 10 * 60_000
const WORKER_MAX_RESTARTS_IN_WINDOW = 3
/** Let a member finish its own bookkeeping before a newly ready task wakes it. */
const UNBLOCKED_TASK_WAKE_DELAY_MS = 3_000
const timing = {
  autoContinueDelaysMs: WORKER_AUTO_CONTINUE_DELAYS_MS,
  unblockedTaskWakeDelayMs: UNBLOCKED_TASK_WAKE_DELAY_MS,
}

/** Tests shorten the supervisor's real-time backoffs; `null` restores them. */
export function setTeamRuntimeTimingForTests(overrides: Partial<typeof timing> | null): void {
  timing.autoContinueDelaysMs = overrides?.autoContinueDelaysMs ?? WORKER_AUTO_CONTINUE_DELAYS_MS
  timing.unblockedTaskWakeDelayMs = overrides?.unblockedTaskWakeDelayMs ?? UNBLOCKED_TASK_WAKE_DELAY_MS
}
const RESULT_TEXT_LIMIT = 4_000
const FAILURE_REASON_LIMIT = 200

type WorkerBatch = {
  scope: ConsumerScope
  messages: TeammateMessage[]
  state: 'queued' | 'ack_pending'
  starts: boolean
  error?: string
}

type WorkerRuntime = {
  consumerInstanceId: string
  scope: ConsumerScope
  consumerStopped?: boolean
  inFlight?: WorkerBatch
  member: TeamPlanMember
  /** Stable process identity from approval; a standby member starts with it later. */
  sessionId: string
  /** Its approved instructions were handed over (or are held for a ready task). */
  released: boolean
  /**
   * Whether this member's process has ever run. A first start begins its own
   * conversation; only a member that has started can be restarted or resumed,
   * and a member that has not is never reported as terminated.
   */
  started: boolean
  /**
   * Bumped by the user's Stop. A start that was already in flight is aborted
   * instead of surviving the Stop, without recording a start failure.
   */
  stopGeneration: number
  starting?: Promise<boolean>
  /** When the member's first start failed; only a newer message retries it. */
  startFailedAt?: number
  autoContinueAttempts: number
  autoContinueTimer?: ReturnType<typeof setTimeout>
  restartHistory: number[]
  /** Automatic restarts stopped after a crash loop; only an explicit message retries. */
  restartsExhausted: boolean
  /** The user's Stop ended this process; resuming it is not a crash restart. */
  stoppedByUser?: boolean
  /** Why the member's last turn ended in a failure nothing retries any more. */
  failure?: string
  /** The lead has not yet been told, with the user's next message, that this member waits to be woken. */
  wakeNoticePending?: boolean
  wokenForTaskIds: Set<string>
  lastResultAt?: number
  /**
   * Approved instructions held back because every task the member owns waits
   * on unfinished work. They go out when one of its tasks becomes ready, or
   * when the user writes to the member, whichever comes first.
   */
  brief?: string
  /** When a shutdown request last reached the member; an approval after it makes its exit an ordinary one. */
  shutdownRequestedAt?: number
}

type TeamLaunch = {
  scope?: ConsumerScope
  parentId: string
  plan: TeamPlanRecord
  createdAt: number
  released: boolean
  /** True once every member has been released and the supervisor owns the team. */
  running: boolean
  children: string[]
  workers: Map<string, WorkerRuntime>
  timer?: ReturnType<typeof setInterval>
  supervising: boolean
  stopped: boolean
  /** Set by the user's Stop: hold automatic work until the lead or the user acts again. */
  pausedAt?: number
  /**
   * When the user next messaged the lead after a Stop. Only lead instructions
   * written since then resume the team: earlier ones were sent before the
   * user's Stop took effect, or in turns the user never asked for.
   */
  resumeAllowedAt?: number
  permissionMode: string
}

const launches = new Map<string, TeamLaunch>()

function incarnationOf(team: Pick<TeamFile, 'name' | 'leadSessionId' | 'createdAt'>): string {
  return createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId || '', team.createdAt])).digest('hex')
}

async function approvedLeadScope(plan: TeamPlanRecord): Promise<ConsumerScope> {
  const lifecycle = await readTaskListLifecycleState(getCanonicalTeamTaskListId(plan.teamName))
  const team = readTeamFile(plan.teamName)
  if (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId || lifecycle.deleted || !lifecycle.activeIdentity ||
    (lifecycle.activeIdentity && (lifecycle.activeIdentity.teamName !== team.name || lifecycle.activeIdentity.createdAt !== team.createdAt || lifecycle.activeIdentity.leadSessionId !== team.leadSessionId))) throw new Error('Team generation no longer exists')
  return { version: 1, teamName: team.name, generation: lifecycle.generation, createdAt: team.createdAt, leadSessionId: plan.sessionId, ownerSessionId: plan.sessionId, recipient: { kind: 'lead' } }
}

function processScope(lead: ConsumerScope, member: TeamPlanMember, sessionId: string, consumerInstanceId: string): ConsumerScope {
  return { ...lead, ownerSessionId: sessionId, recipient: { kind: 'member', backend: 'process', agentName: member.name, memberInstanceId: consumerInstanceId, memberSessionId: sessionId } }
}

/** Validation is local: checking a proposal never invokes a model or discovers credentials. */
export async function validateTeamPlanRuntime(plan: TeamPlanRecord): Promise<TeamPlanRecord> {
  if (!(await stat(plan.workDir)).isDirectory()) throw new Error('Team working directory is unavailable')
  const team = plan.teamName ? readTeamFile(plan.teamName) : null
  if (plan.teamName && (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId)) throw new Error('Team generation no longer exists')
  const members: TeamPlanMember[] = []
  for (const member of plan.members) {
    if (!isValidTeamMemberName(member.name)) throw new Error(`Invalid teammate name: ${member.name}`)
    if (team?.members.some(existing => existing.name === member.name)) throw new Error(`Member already exists: ${member.name}. Message the existing member to give it more work; a stopped member restarts from its saved conversation.`)
    const snapshot = plan.agentCatalog?.[member.agentType]
    if (!snapshot || !snapshot.systemPrompt.trim()) throw new Error(`Agent preset is unavailable: ${member.agentType}`)
    validateTeamPlanPresetSource(snapshot)
    validateAgentPresetSnapshot(snapshot, member.agentType, { parentPermissionMode: conversationService.getSessionPermissionMode(plan.sessionId), workerLabel: 'team worker', permissionHint: 'adjust the preset or leader permission mode and submit a new plan' })
    const { provider, modelId } = await resolveAgentRuntimeModel(providerService, member.runtime, member.name)
    const requestedEffort = member.runtime.effortLevel
    if (requestedEffort !== undefined && (!isModelReasoningEffort(requestedEffort) || !normalizeModelReasoningEffort(modelId, requestedEffort, provider?.apiFormat ?? 'anthropic', provider ? getModelReasoningCapabilityOverride(modelId, provider.models, getPresetDefaultEnv(provider.presetId)) : undefined, provider ? getPresetReasoningProviderKind(provider.presetId) : undefined))) throw new Error(`Unsupported reasoning effort for ${member.name}`)
    const runtime = { ...member.runtime, modelId }

    // These restrictions would break the team's mailbox protocol even if the
    // preset were allowed to execute its task successfully.
    if (snapshot.disallowedTools?.some(tool => essentialTools.includes(tool.split('(')[0]!))) throw new Error(`Agent preset ${member.agentType} disables team communication tools`)
    members.push({ ...member, providerName: provider?.name ?? 'Claude', runtime, agentSnapshot: structuredClone(snapshot) })
  }
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Teammate names must be unique')
  return { ...plan, members }
}

/** All children must acknowledge the model control before any task is released. */
export async function startTeamWorkersBarrier<T>(
  members: readonly T[],
  prepare: (member: T) => Promise<string>,
  release: (member: T, id: string) => Promise<void>,
  stop: (id: string) => Promise<void>,
): Promise<string[]> {
  const ids: string[] = []
  try {
    for (const member of members) ids.push(await prepare(member))
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  // A release failure is not retried: another worker may already have acted.
  try {
    for (let i = 0; i < members.length; i++) await release(members[i]!, ids[i]!)
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  return ids
}

async function materializeTasks(plan: TeamPlanRecord): Promise<Record<string, string>> {
  const existing = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
  const mapping: Record<string, string> = {}
  for (const task of plan.approvedSnapshot!.tasks) {
    const old = existing.find(entry => entry.metadata?.teamPlanId === plan.planId && entry.metadata?.teamPlanTaskId === task.id)
      ?? existing.find(entry => entry.id === task.id && entry.subject === task.subject && !entry.metadata?.teamPlanId)
    mapping[task.id] = old?.id ?? await createTask(getCanonicalTeamTaskListId(plan.teamName), {
      subject: task.subject, description: task.description ?? '', status: 'pending', blocks: [], blockedBy: [],
      metadata: { teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  for (const task of plan.approvedSnapshot!.tasks) {
    const owner = plan.approvedSnapshot!.members.find(member => member.id === task.ownerId)
    await updateTask(getCanonicalTeamTaskListId(plan.teamName), mapping[task.id]!, {
      subject: task.subject, description: task.description ?? '',
      owner: owner?.name,
      blockedBy: task.dependencies.map(id => mapping[id]!),
      blocks: plan.approvedSnapshot!.tasks.filter(other => other.dependencies.includes(task.id)).map(other => mapping[other.id]!),
      metadata: { ...existing.find(entry => entry.id === mapping[task.id])?.metadata, teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  return mapping
}

/**
 * What an approved member is told to do: its preset's opening, its prompt and
 * its shared tasks. Each task names who waits on it (`handOffTo`): a member
 * cannot see that from its own tasks, and without it a result only ever went
 * to the lead, reaching the member that needed it late or not at all.
 */
function memberBrief(member: TeamPlanMember, members: TeamPlanMember[], tasks: TeamPlanTask[], taskMapping: Record<string, string>): string {
  const ownerName = (task: TeamPlanTask) => members.find(candidate => candidate.id === task.ownerId)?.name ?? TEAM_LEAD_NAME
  const assigned = tasks.filter(task => task.ownerId === member.id).map(task => {
    const handOffTo = [...new Set(tasks.filter(other => other.dependencies.includes(task.id)).map(ownerName))].filter(name => name !== member.name)
    return { ...task, id: taskMapping[task.id], dependencies: task.dependencies.map(dep => taskMapping[dep]), ...(handOffTo.length > 0 ? { handOffTo } : {}) }
  })
  const handOff = assigned.some(task => 'handOffTo' in task)
    ? '\n\nWhen you finish a task that has handOffTo: first SendMessage its result to each member listed there, then submit its versioned artifact for independent acceptance. Dependent tasks unlock only after acceptance.'
    : ''
  return `${member.agentSnapshot?.initialPrompt ? member.agentSnapshot.initialPrompt + "\n" : ""}${member.prompt}\n\nApproved shared tasks (use TaskGet/TaskUpdate; start a task only once all of its dependencies are completed; submit deliverables with TaskUpdate deliveryAction, including the next artifact version and acceptance criteria; only an independent reviewer may accept, and a return reason requires rework in a new version):\n${JSON.stringify(assigned)}${handOff}`
}

function tasksByIdOf(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map(task => [task.id, task]))
}

/**
 * Unfinished tasks the member owns whose dependencies all exist and are
 * completed. A dependency whose task file vanished is not finished work, and a
 * task whose delivery history this build cannot read is never executable.
 */
function readyTasksOf(memberName: string, tasks: Task[]): Task[] {
  const tasksById = tasksByIdOf(tasks)
  return tasks.filter(task => task.owner === memberName && task.status !== 'completed' && !isTaskAwaitingReview(task)
    && !isTaskDeliveryUnsupported(task) && findUnsatisfiedBlockers(task, tasksById).length === 0)
}

// ── Worker failure classification ───────────────────────────────────────────

/** A worker's CLI `result` text after a failed turn (see utils/swarm/turnFailure). */
export const isTransientWorkerFailure = isTransientTurnFailure

function capText(text: string, limit: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function firstLine(text: string): string {
  return summarizeTurnFailure(text, FAILURE_REASON_LIMIT)
}

// ── Team file updates ───────────────────────────────────────────────────────

type MemberEntry = TeamFile['members'][number]

async function updateWorkerEntry(launch: TeamLaunch, worker: WorkerRuntime, update: (entry: MemberEntry) => MemberEntry): Promise<void> {
  try {
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(launch.plan.teamName), async () => {
      const lifecycle = await readTaskListLifecycleState(getCanonicalTeamTaskListId(launch.plan.teamName))
      if (lifecycle.deleted || lifecycle.generation !== worker.scope.generation) return
      await mutateTeamFileAsync(launch.plan.teamName, team => {
        if (team.createdAt !== launch.createdAt || team.leadSessionId !== launch.parentId) return
        const index = team.members.findIndex(entry => entry.sessionId === worker.sessionId && entry.consumerInstanceId === worker.consumerInstanceId && entry.name === worker.member.name)
        if (index === -1) return
        const members = [...team.members]
        members[index] = update(members[index]!)
        return { ...team, members }
      })
    })
  } catch (error) {
    // The team may have been deleted between ticks; the supervisor notices on its next pass.
    console.warn(`[TeamPlanRuntime] cannot update member ${worker.member.name}:`, error instanceof Error ? error.message : error)
  }
}

function withoutFailure(entry: MemberEntry): MemberEntry {
  const { lastError: _lastError, autoRetry: _autoRetry, ...rest } = entry as MemberEntry & { lastError?: string; autoRetry?: unknown }
  return rest
}

/**
 * Record a member's process id in the launch before the process exists, so a
 * Stop that lands during the spawn stops it with the rest of the launch.
 * Stopping an id that never became a session is a no-op.
 */
function reserveChild(launch: TeamLaunch, worker: WorkerRuntime): void {
  if (!launch.children.includes(worker.sessionId)) launch.children.push(worker.sessionId)
}

async function notifyLead(launch: TeamLaunch, worker: WorkerRuntime, options: { idleReason: 'available' | 'failed'; result?: string; failureReason?: string }): Promise<void> {
  const notification = createIdleNotification(worker.member.name, {
    idleReason: options.idleReason,
    ...(options.result ? { result: capText(options.result, RESULT_TEXT_LIMIT) } : {}),
    ...(options.failureReason ? { failureReason: options.failureReason } : {}),
  })
  const write = () => withConsumerScope(worker.scope, () => writeToMailbox(TEAM_LEAD_NAME, { from: worker.member.name, timestamp: new Date().toISOString(), text: JSON.stringify(notification) }, launch.plan.teamName))
  // A lost failure notice is exactly how a member silently drops out of a long
  // run, so a contended mailbox gets one more attempt.
  const first = await write()
  if (first.status === 'current' && first.value === false) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const second = await write()
    if (second.status === 'current' && second.value === false) console.error(`[TeamPlanRuntime] could not notify the lead about ${worker.member.name}`)
  }
}

// ── Worker processes ────────────────────────────────────────────────────────

function workerSdkUrl(sessionId: string): string {
  const url = new URL(`ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${sessionId}`)
  url.searchParams.set('token', randomUUID())
  return url.toString()
}

async function startWorkerProcess(launch: TeamLaunch, worker: WorkerRuntime, resume: boolean): Promise<void> {
  const { member } = worker
  const snapshot = member.agentSnapshot
  if (!snapshot) throw new Error(`Missing approved preset for ${member.name}`)
  const tools = snapshot.tools ? [...new Set([...snapshot.tools, ...essentialTools])] : undefined
  // Every on-demand start rechecks the current leader permission boundary;
  // the frozen preset is configuration, not permanent permission to bypass it.
  if (conversationService.hasSession(launch.parentId)) {
    launch.permissionMode = conversationService.getSessionPermissionMode(launch.parentId)
  }
  validateAgentPresetSnapshot(snapshot, member.agentType, { parentPermissionMode: launch.permissionMode, workerLabel: 'team worker', permissionHint: 'review a new plan before expanding permissions' })
  const current = await withConsumerScope(worker.scope, () => true)
  if (current.status !== 'current' || worker.consumerStopped || launch.stopped || launch.pausedAt) throw new Error(`Worker consumer identity ${current.status}`)
  try {
    await conversationService.startSession(worker.sessionId, launch.plan.workDir, workerSdkUrl(worker.sessionId), {
      providerId: member.runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : member.runtime.providerId,
      model: member.runtime.modelId,
      effort: member.runtime.effortLevel,
      permissionMode: launch.permissionMode,
      teamWorker: {
        consumerScope: worker.scope,
        parentSessionId: launch.parentId, teamName: launch.plan.teamName, memberId: member.id, name: member.name,
        systemPrompt: snapshot.systemPrompt, tools,
        agentDefinition: { ...snapshot, initialPrompt: undefined, effort: member.runtime.effortLevel },
        ...(resume ? { resume: true } : {}),
      },
    })
    await conversationService.requestControl(worker.sessionId, { subtype: 'set_model', model: member.runtime.modelId }, 30_000)
  } catch (error) {
    await conversationService.stopSessionAndWait(worker.sessionId)
    throw error
  }
  conversationService.onOutput(worker.sessionId, message => {
    if (message?.type !== 'result') return
    void migrationMaintenance.track(handleWorkerResult(launch, worker, message)).catch(error => console.error(`[TeamPlanRuntime] cannot record ${member.name}'s turn`, error))
  })
}

/**
 * Restart a member whose process is gone by resuming its own transcript, so a
 * crash, a lead restart or the user's Stop never costs the member its work.
 */
async function restartWorker(launch: TeamLaunch, worker: WorkerRuntime, reason: 'message' | 'user'): Promise<boolean> {
  if (worker.starting) return worker.starting
  const now = Date.now()
  // A Stop that lands while this start is in flight must win: it kills the
  // process and leaves the member stopped, not failed.
  const generation = worker.stopGeneration
  worker.restartHistory = worker.restartHistory.filter(at => now - at < WORKER_RESTART_WINDOW_MS)
  // Stopping the team is the user's choice, not a crash: however often the
  // user stops and resumes, bringing a member back never trips the guard.
  const resumingFromStop = worker.stoppedByUser === true
  worker.stoppedByUser = false
  if (reason === 'message' && !resumingFromStop && (worker.restartsExhausted || worker.restartHistory.length >= WORKER_MAX_RESTARTS_IN_WINDOW)) {
    if (!worker.restartsExhausted) {
      worker.restartsExhausted = true
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, terminated: true, lastError: 'Stopped restarting after repeated exits. A message from the user restarts it.' }))
      await notifyFailure(launch, worker, `${worker.member.name} exited ${worker.restartHistory.length} times in ${WORKER_RESTART_WINDOW_MS / 60_000} minutes; automatic restarts are paused`)
    }
    return false
  }
  if (!resumingFromStop) worker.restartHistory.push(now)
  if (reason === 'user') worker.restartsExhausted = false
  const start = (async () => {
    try {
      await startWorkerProcess(launch, worker, true)
      // The team was ended, or the user pressed Stop while this process was
      // starting and Stop's kill pass could not see it yet.
      if (launch.stopped || worker.stopGeneration !== generation) {
        await conversationService.stopSessionAndWait(worker.sessionId)
        return false
      }
      worker.started = true
      await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, terminated: false }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A Stop killed the process mid-start: that is not the member's failure.
      if (launch.stopped || worker.stopGeneration !== generation) {
        await conversationService.stopSessionAndWait(worker.sessionId).catch(() => {})
        return false
      }
      console.error(`[TeamPlanRuntime] cannot restart ${worker.member.name}:`, message)
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, terminated: true, lastError: firstLine(`Restart failed: ${message}`) }))
      return false
    } finally {
      worker.starting = undefined
    }
  })()
  worker.starting = start
  return start
}

/**
 * The first start of an approved member that has never run: no task was ready
 * when the team was approved, so no process existed to prepare. It begins its
 * own conversation from the frozen approved snapshot (`resume: false`), so it
 * is neither a restart nor a resume and never counts against the crash guard.
 */
async function firstStartWorker(launch: TeamLaunch, worker: WorkerRuntime): Promise<boolean> {
  if (worker.starting) return worker.starting
  const generation = worker.stopGeneration
  // Reserve the process id before it exists. A Stop or an end of the team that
  // lands while the CLI is spawning then stops it with the rest of the launch
  // instead of leaving an orphan nobody owns.
  reserveChild(launch, worker)
  const start = (async () => {
    try {
      await startWorkerProcess(launch, worker, false)
      if (launch.stopped || worker.stopGeneration !== generation) {
        await conversationService.stopSessionAndWait(worker.sessionId)
        return false
      }
      // The user's earlier Stop no longer applies: this conversation is new.
      worker.stoppedByUser = false
      worker.started = true
      worker.startFailedAt = undefined
      await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, initialStartPending: false, terminated: false }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A Stop killed the spawn: the member is still unstarted, not failed, and
      // its pending instruction can start it once the user continues.
      if (launch.stopped || worker.stopGeneration !== generation) {
        await conversationService.stopSessionAndWait(worker.sessionId).catch(() => {})
        return false
      }
      console.error(`[TeamPlanRuntime] cannot start ${worker.member.name}:`, message)
      // It still has never run: keep it startable instead of calling it exited,
      // and keep the persisted flag saying its first start is still pending.
      worker.startFailedAt = Date.now()
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, awaitingDependencies: true, initialStartPending: true, lastError: firstLine(`Start failed: ${message}`) }))
      await notifyFailure(launch, worker, `${worker.member.name} could not start: ${firstLine(message)}`)
      return false
    } finally {
      worker.starting = undefined
    }
  })()
  worker.starting = start
  return start
}

function cancelAutoContinue(worker: WorkerRuntime): void {
  if (worker.autoContinueTimer) clearTimeout(worker.autoContinueTimer)
  worker.autoContinueTimer = undefined
}

function autoContinuePrompt(reason: string, attempt: number): string {
  return formatTeammateAutoContinuePrompt(reason, attempt, timing.autoContinueDelaysMs.length)
}

async function autoContinueWorker(launch: TeamLaunch, worker: WorkerRuntime, reason: string, attempt: number): Promise<void> {
  if (migrationMaintenance.isActive) return
  worker.autoContinueTimer = undefined
  if (launch.stopped || launch.pausedAt || !conversationService.hasSession(worker.sessionId)) return
  // Queued mail resumes the member anyway, with the newer context.
  if (worker.consumerStopped || worker.inFlight) return
  const unread = await readScopedMailbox(worker.scope)
  if (unread.status !== 'current') {
    if (unread.status !== 'retryable_io') stopWorkerConsumer(worker, unread.status)
    return
  }
  if (unread.value.length > 0) return
  const entry = readTeamFile(launch.plan.teamName)?.members.find(member => member.sessionId === worker.sessionId)
  if (entry?.isActive) return
  await updateWorkerEntry(launch, worker, current => ({ ...current, isActive: true }))
  const generation = worker.stopGeneration
  const receipt = await conversationService.sendScopedMessage(worker.sessionId, autoContinuePrompt(reason, attempt), worker.scope, { canSend: () => !launch.stopped && !launch.pausedAt && !worker.consumerStopped && worker.stopGeneration === generation })
  const outcome = receipt.status === 'queued' ? await receipt.completion : receipt
  if (outcome.status === 'sent') return
  // No retry is scheduled any more: report the failure instead of leaving a
  // stale countdown that also keeps a /goal lead waiting on this member.
  await updateWorkerEntry(launch, worker, current => {
    const { autoRetry: _autoRetry, ...rest } = current as MemberEntry & { autoRetry?: unknown }
    return { ...rest, isActive: false, lastError: reason }
  })
  await notifyFailure(launch, worker, `${reason} (could not continue automatically; message ${worker.member.name} to retry)`)
}

async function handleWorkerResult(launch: TeamLaunch, worker: WorkerRuntime, message: { is_error?: boolean; result?: unknown }): Promise<void> {
  if (launch.stopped || worker.consumerStopped) return
  const current = await withConsumerScope(worker.scope, () => true)
  if (current.status !== 'current') {
    if (current.status !== 'retryable_io') stopWorkerConsumer(worker, current.status)
    return
  }
  worker.lastResultAt = Date.now()
  const alive = conversationService.hasSession(worker.sessionId)
  const text = typeof message.result === 'string' ? message.result : ''
  const failed = !alive || message.is_error === true
  if (launch.pausedAt) {
    // The user's Stop already accounted for this turn; a burst of failure
    // notices would only make the lead restart members the user just halted.
    await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, ...(alive ? {} : { terminated: true }) }))
    return
  }
  if (!failed) {
    worker.autoContinueAttempts = 0
    clearFailure(worker)
    cancelAutoContinue(worker)
    await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, isActive: false }))
    await notifyLead(launch, worker, { idleReason: 'available', ...(text ? { result: text } : {}) })
    return
  }
  if (!alive && await approvedShutdown(launch, worker)) {
    // It left because the lead asked it to and it agreed. Every process exit
    // arrives here as an error result; recording this one as a failure showed
    // a finished team as broken and told the lead its members had crashed.
    worker.autoContinueAttempts = 0
    clearFailure(worker)
    cancelAutoContinue(worker)
    await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, isActive: false, terminated: true }))
    return
  }
  const reason = firstLine(text || 'The member process exited')
  if (alive && isTransientWorkerFailure(text) && worker.autoContinueAttempts < timing.autoContinueDelaysMs.length) {
    const attempt = ++worker.autoContinueAttempts
    const delay = timing.autoContinueDelaysMs[attempt - 1]!
    cancelAutoContinue(worker)
    worker.autoContinueTimer = setTimeout(() => {
      void migrationMaintenance.track(autoContinueWorker(launch, worker, reason, attempt)).catch(error => console.error(`[TeamPlanRuntime] cannot continue ${worker.member.name}`, error))
    }, delay)
    worker.autoContinueTimer.unref?.()
    await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, lastError: reason, autoRetry: { attempt, max: timing.autoContinueDelaysMs.length, nextAt: Date.now() + delay } }))
    return
  }
  const exhausted = alive && isTransientWorkerFailure(text)
  await updateWorkerEntry(launch, worker, entry => {
    const { autoRetry: _autoRetry, ...rest } = entry as MemberEntry & { autoRetry?: unknown }
    return { ...rest, isActive: false, lastError: reason, ...(alive ? {} : { terminated: true }) }
  })
  await notifyFailure(launch, worker, alive
    ? exhausted ? `${reason} (automatic retries exhausted; message ${worker.member.name} to continue)` : reason
    : `${worker.member.name}'s process exited (${reason}). Messaging it restarts it from its saved conversation.`)
}

/**
 * The approval a member writes to the lead before it exits. The mailbox's own
 * isShutdownApproved does not recognise a desktop member's approval, on
 * purpose (see ShutdownApprovedMessageSchema), so the type is read here.
 */
function isShutdownApproval(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown } | null)?.type === 'shutdown_approved'
  } catch {
    return false
  }
}

/** Whether the member approved the shutdown request it was last given; asked once per request. */
async function approvedShutdown(launch: TeamLaunch, worker: WorkerRuntime): Promise<boolean> {
  const since = worker.shutdownRequestedAt
  if (since === undefined) return false
  // A later exit without a new request is a crash again.
  worker.shutdownRequestedAt = undefined
  const approved = async () => {
    const read = await withConsumerScope(worker.scope, () => readMailboxHistory(TEAM_LEAD_NAME, launch.plan.teamName))
    return read.status === 'current' && read.value.some(message => message.from === worker.member.name && Date.parse(message.timestamp) >= since && isShutdownApproval(message.text))
  }
  if (await approved()) return true
  // The lead may be archiving its inbox at this very moment.
  await new Promise(resolve => setTimeout(resolve, 300))
  return approved()
}

/**
 * A failure nothing retries any more: the lead hears it now through its
 * mailbox, and again with the user's next message, which is when the cause
 * (a usage limit, billing, the network) has usually been dealt with.
 */
async function notifyFailure(launch: TeamLaunch, worker: WorkerRuntime, failureReason: string): Promise<void> {
  worker.failure = failureReason
  worker.wakeNoticePending = true
  await notifyLead(launch, worker, { idleReason: 'failed', failureReason })
}

function clearFailure(worker: WorkerRuntime): void {
  worker.failure = undefined
  worker.wakeNoticePending = false
}

// ── Supervisor ──────────────────────────────────────────────────────────────

function stopWorkerConsumer(worker: WorkerRuntime, reason: string): void {
  worker.consumerStopped = true
  cancelAutoContinue(worker)
  conversationService.cancelScopedMessages(worker.sessionId, worker.scope, reason)
  worker.inFlight = undefined
  worker.failure = `Team or member consumer identity ${reason}; automatic receiving stopped; history remains available`
  console.warn(`[TeamPlanRuntime] ${worker.member.name}: ${worker.failure}`)
}

async function settleWorkerBatch(launch: TeamLaunch, worker: WorkerRuntime, batch: WorkerBatch, outcome: ScopedSendOutcome): Promise<void> {
  if (worker.inFlight !== batch || launch.stopped) return
  if (outcome.status === 'rejected') {
    worker.inFlight = undefined
    if (['stale', 'unbound', 'unsupported', 'session_replaced'].includes(outcome.reason)) stopWorkerConsumer(worker, outcome.reason)
    else await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false }))
    return
  }
  // A sent receipt never frees the consumption slot. Only this batch's ACK can.
  batch.state = 'ack_pending'
  clearFailure(worker)
  await acknowledgeWorkerBatch(worker)
  if (worker.consumerStopped) return
  if (batch.starts) {
    worker.brief = undefined
    await updateWorkerEntry(launch, worker, ({ awaitingDependencies: _awaiting, ...entry }) => entry)
  }
}

async function acknowledgeWorkerBatch(worker: WorkerRuntime): Promise<void> {
  const batch = worker.inFlight
  if (!batch || batch.state !== 'ack_pending') return
  const result = await claimScopedMailbox(batch.scope, batch.messages)
  if (worker.inFlight !== batch) return
  if (result.status === 'claimed') {
    worker.inFlight = undefined
  } else if (result.status === 'retryable_io' || result.status === 'commit_uncertain') {
    batch.error = result.status
    console.warn(`[TeamPlanRuntime] ${worker.member.name}: scoped ACK ${result.status}`)
  } else {
    stopWorkerConsumer(worker, result.status)
  }
}

async function deliverToWorker(launch: TeamLaunch, worker: WorkerRuntime, messages: TeammateMessage[]): Promise<void> {
  if (worker.inFlight || worker.consumerStopped || launch.stopped || launch.pausedAt) return
  const generation = worker.stopGeneration
  const batch: WorkerBatch = { scope: worker.scope, messages, state: 'queued', starts: worker.brief !== undefined && !messages.every(message => isShutdownRequest(message.text)) }
  worker.inFlight = batch
  cancelAutoContinue(worker)
  worker.autoContinueAttempts = 0
  await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, isActive: true, terminated: false }))
  if (messages.some(message => isShutdownRequest(message.text))) worker.shutdownRequestedAt = Date.now()
  const text = formatTeammateMessages(messages)
  try {
    const receipt = await conversationService.sendScopedMessage(worker.sessionId, batch.starts ? `${worker.brief}\n\n${text}` : text, batch.scope, {
      canSend: () => !launch.stopped && !launch.pausedAt && !worker.consumerStopped && worker.stopGeneration === generation && worker.inFlight === batch,
    })
    if (receipt.status === 'queued') {
      void receipt.completion.then(outcome => migrationMaintenance.track(settleWorkerBatch(launch, worker, batch, outcome)))
        .catch(error => console.error('[TeamPlanRuntime] cannot settle SDK batch', error))
    } else {
      await settleWorkerBatch(launch, worker, batch, receipt)
    }
  } catch (error) {
    if (worker.inFlight === batch) worker.inFlight = undefined
    console.warn('[TeamPlanRuntime] scoped delivery failed', error instanceof Error ? error.message : 'transport error')
  }
}

/**
 * Wake an idle member when a task it owns becomes ready (its dependencies just
 * completed). Process members have no poll loop of their own, so without this
 * a dependency chain stalls until the lead happens to notice.
 */
async function wakeForReadyTask(launch: TeamLaunch, worker: WorkerRuntime, entry: MemberEntry | undefined, tasks: Task[]): Promise<void> {
  if (!entry || entry.isActive || worker.autoContinueTimer || !conversationService.hasSession(worker.sessionId)) return
  if (worker.lastResultAt === undefined || Date.now() - worker.lastResultAt < timing.unblockedTaskWakeDelayMs) return
  const tasksById = tasksByIdOf(tasks)
  const ready = tasks.find(task => task.owner === worker.member.name && task.status === 'pending' && !isTaskDeliveryUnsupported(task) && !worker.wokenForTaskIds.has(task.id)
    && task.blockedBy.length > 0 && findUnsatisfiedBlockers(task, tasksById).length === 0)
  if (!ready) return
  worker.wokenForTaskIds.add(ready.id)
  await deliverToWorker(launch, worker, [{
    from: 'task-list',
    text: `Task #${ready.id} assigned to you is now ready because its dependencies are complete: ${ready.subject}\nStart it now with TaskUpdate (status in_progress), and mark it completed when done.`,
    timestamp: new Date().toISOString(),
    read: false,
  }])
}

/**
 * Give a standby member its approved instructions once one of its tasks is
 * ready, so it never works ahead of the dependencies the user approved. A
 * member whose process never ran is started for the first time here; one that
 * ran and lost its process resumes its own transcript.
 */
async function startWhenReady(launch: TeamLaunch, worker: WorkerRuntime, tasks: Task[], held: TeammateMessage[]): Promise<void> {
  const ready = readyTasksOf(worker.member.name, tasks)
  if (ready.length === 0) return
  if (!conversationService.hasSession(worker.sessionId)) {
    // A first start that already failed waits for an explicit instruction:
    // retrying it on every supervisor pass would hammer the same failure.
    if (!worker.started && worker.failure !== undefined) return
    void migrationMaintenance.track(worker.started ? restartWorker(launch, worker, 'message') : firstStartWorker(launch, worker))
    return
  }
  // The instructions already say what is ready; no separate wake follows.
  for (const task of ready) worker.wokenForTaskIds.add(task.id)
  // The members it depends on were told to send their results before
  // completing. When one did not, say so now rather than let this member find
  // out halfway through that it is working without its input.
  const teammates = new Set([...launch.workers.values()].map(other => other.member.name))
  const upstream = new Set(ready.flatMap(task => task.blockedBy).map(id => tasks.find(task => task.id === id)?.owner)
    .filter((owner): owner is string => !!owner && owner !== worker.member.name && teammates.has(owner)))
  const silent = [...upstream].filter(owner => !held.some(message => message.from === owner))
  const missing = silent.length > 0
    ? `\nNothing has reached you from ${silent.join(', ')} yet. If you need ${silent.length === 1 ? 'its' : 'their'} result, ask with SendMessage before you rely on it.`
    : ''
  // What the lead and teammates wrote while it waited (the results it depends
  // on) arrives with its instructions.
  await deliverToWorker(launch, worker, [...held, {
    from: 'task-list',
    text: `Ready now (dependencies complete): ${ready.map(task => `#${task.id} ${task.subject}`).join('; ')}${missing}`,
    timestamp: new Date().toISOString(),
    read: false,
  }])
}

async function superviseLaunch(launch: TeamLaunch): Promise<void> {
  if (migrationMaintenance.isActive) return
  const current = await withConsumerScope(launch.scope, (_scope, team) => team)
  if (current.status !== 'current') {
    if (current.status !== 'retryable_io') {
      // Retire this runtime only; cleanup by name would touch a replacement team.
      launch.stopped = true
      if (launch.timer) clearInterval(launch.timer)
      launches.delete(launch.plan.planId)
      for (const worker of launch.workers.values()) stopWorkerConsumer(worker, current.status)
    }
    return
  }
  const team = current.value
  if (!launch.pausedAt) await flushTaskDeliveryNotices(launch.plan.teamName)
  const leadAlive = conversationService.hasSession(launch.parentId)
  let tasks: Task[] | undefined
  const loadTasks = async (): Promise<Task[]> => {
    tasks ??= await listTasks(getCanonicalTeamTaskListId(launch.plan.teamName)).catch(() => [] as Task[])
    return tasks
  }
  for (const worker of launch.workers.values()) {
    // A restart in flight delivers on a later pass, once its process is ready;
    // it never holds up the rest of the team.
    if (!worker.released || launch.stopped || worker.starting || worker.consumerStopped) continue
    if (worker.inFlight) {
      // Stop holds unsent work but must not release or resend an ACK-pending batch.
      if (worker.inFlight.state === 'queued') conversationService.retryScopedMessages(worker.sessionId)
      await acknowledgeWorkerBatch(worker)
      continue
    }
    const inbox = await readScopedMailbox(worker.scope)
    if (inbox.status !== 'current') {
      if (inbox.status !== 'retryable_io') stopWorkerConsumer(worker, inbox.status)
      continue
    }
    // A worker can be stopped without a result (its lead's session was closed
    // or reaped); keep the roster honest so the UI shows it as stopped. A
    // member that never started is not stopped: it has no process to lose.
    const entry = team.members.find(member => member.sessionId === worker.sessionId)
    if (entry && entry.terminated !== true && entry.awaitingDependencies !== true && entry.initialStartPending !== true && !conversationService.hasSession(worker.sessionId)) {
      await updateWorkerEntry(launch, worker, current => ({ ...current, isActive: false, terminated: true }))
    }
    const messages = inbox.value
    if (launch.pausedAt) {
      // Only a new instruction resumes a paused team: the user's own message to
      // a member, or the lead's once the user has spoken to it again.
      const resume = messages.some(message => {
        const at = Date.parse(message.timestamp)
        if (message.from === 'user') return at >= launch.pausedAt!
        return message.from === TEAM_LEAD_NAME && launch.resumeAllowedAt !== undefined && at >= launch.resumeAllowedAt
      })
      if (!resume) continue
      // Only clear the pause being resumed: a Stop that landed while this pass
      // was waiting must keep its own, newer record.
      const resuming = launch.pausedAt
      launch.pausedAt = undefined
      launch.resumeAllowedAt = undefined
      void migrationMaintenance.track(mutateTeamFileAsync(launch.plan.teamName, team => {
        if (team.createdAt !== launch.createdAt || team.pausedAt !== resuming) return
        const { pausedAt: _resumed, ...rest } = team
        return rest
      })).catch(error => console.error('[TeamPlanRuntime] cannot record the resumed team', error))
    }
    // A member that waits on dependencies is started by its tasks, or by the
    // user writing to it. What the lead or a teammate sends it meanwhile (a
    // forwarded result, a broadcast) waits in its inbox and arrives with its
    // instructions; starting on such a message would undo the approved order.
    // A standby member with no unfinished task has no approved order to keep,
    // so a lead's instruction is a real trigger for it.
    const shutdownOnly = messages.every(message => isShutdownRequest(message.text))
    const fromUser = messages.some(message => message.from === 'user')
    const held = messages.length > 0 && worker.brief !== undefined && !fromUser && !shutdownOnly &&
      (await loadTasks()).some(task => task.owner === worker.member.name && task.status !== 'completed')
    if (messages.length === 0 || held) {
      if (!leadAlive) continue
      const currentTasks = await loadTasks()
      if (worker.brief !== undefined) await startWhenReady(launch, worker, currentTasks, messages)
      else await wakeForReadyTask(launch, worker, entry, currentTasks)
      continue
    }
    if (!conversationService.hasSession(worker.sessionId)) {
      if (worker.brief !== undefined) {
        const instructed = messages.some(message => message.from === 'user' || message.from === TEAM_LEAD_NAME)
        // A standby member is not woken by ordinary notices; they wait in its
        // inbox. A ready task or an explicit instruction starts it.
        if (!instructed) {
          if (!leadAlive) continue
          await startWhenReady(launch, worker, await loadTasks(), messages)
          continue
        }
        // Its first start begins its own conversation; the message arrives
        // with its approved instructions on the next pass. A start that just
        // failed waits for a newer message instead of retrying this one.
        if (!worker.started && worker.startFailedAt !== undefined &&
          !messages.some(message => Date.parse(message.timestamp) > worker.startFailedAt!)) continue
        void migrationMaintenance.track(firstStartWorker(launch, worker))
        continue
      }
      // Without a lead nobody coordinates the restarted member; a direct user
      // message is the exception.
      if (!leadAlive && !fromUser) continue
      void migrationMaintenance.track(restartWorker(launch, worker, fromUser ? 'user' : 'message'))
      continue
    }
    await deliverToWorker(launch, worker, messages)
  }
}

function startSupervisor(launch: TeamLaunch): void {
  if (launch.timer || migrationMaintenance.isActive) return
  launch.timer = setInterval(() => {
    if (launch.supervising || launch.stopped || migrationMaintenance.isActive) return
    launch.supervising = true
    void migrationMaintenance.track(superviseLaunch(launch))
      .catch(error => { console.error('[TeamPlanRuntime] team supervision failed', error) })
      .finally(() => { launch.supervising = false })
  }, SUPERVISOR_INTERVAL_MS)
  launch.timer.unref?.()
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

async function sendTeamSnapshot(launch: TeamLaunch): Promise<void> {
  if (!launch.scope) throw new Error('Missing approved team consumer identity')
  const current = await withConsumerScope(launch.scope, () => true)
  if (current.status !== 'current') throw new Error(`Team snapshot consumer identity ${current.status}`)
  await conversationService.requestControl(launch.parentId, { subtype: 'team_runtime_snapshot', team_name: launch.plan.teamName, created_at: launch.createdAt, consumer_scope: launch.scope })
}

/** The user's Stop: every member stops now, nothing is lost, the next instruction resumes. */
function pauseLaunchesForLead(parentSessionId: string): boolean {
  let paused = false
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped || !launch.running) continue
    paused = true
    launch.pausedAt = Date.now()
    launch.resumeAllowedAt = undefined
    for (const worker of launch.workers.values()) {
      cancelAutoContinue(worker)
      conversationService.cancelScopedMessages(worker.sessionId, worker.scope, 'cancelled')
      worker.stoppedByUser = true
      // Anything already spawning belongs to the stopped run, whatever it is.
      worker.stopGeneration = (worker.stopGeneration ?? 0) + 1
      worker.wakeNoticePending = true
    }
    // No notice goes to the lead's mailbox: delivering it would start a lead
    // turn right after the user stopped everything. The user's next message
    // carries it instead (noteLeadUserMessage).
    void migrationMaintenance.track(mutateTeamFileAsync(launch.plan.teamName, team => {
      if (team.createdAt !== launch.createdAt) return
      // A member that never started has no process to lose: it stays a standby
      // member rather than being reported as terminated.
      const sessions = new Set([...launch.workers.values()].filter(worker => worker.started).map(worker => worker.sessionId))
      // The Stop itself is recorded: a restarted runtime reads it back instead
      // of treating the team as one that was never stopped. The epoch counts
      // Stops so the desktop can tell a wait sent before this one from a wait
      // sent after it, without comparing clocks across processes.
      return { ...team, pausedAt: launch.pausedAt, stopEpoch: (team.stopEpoch ?? 0) + 1, members: team.members.map(entry => entry.sessionId && sessions.has(entry.sessionId) ? { ...entry, isActive: false, terminated: true } : entry) }
    })).catch(error => console.error('[TeamPlanRuntime] cannot record the paused team', error))
  }
  return paused
}

/**
 * The user just sent the lead a message. After a Stop this is what allows the
 * lead to resume the team. And whether the team was stopped or members ran
 * into errors (a usage limit, billing, the network, a crash), the lead is told
 * once which members are not running: they keep their saved conversations and
 * do nothing until messaged, so a lead told to "continue" would otherwise wait
 * for them, or redo their work. The lead decides from the user's words whether
 * they go on; nothing is said at the Stop or failure itself, which would start
 * a lead turn the user did not ask for.
 */
export async function noteLeadUserMessage(parentSessionId: string): Promise<void> {
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped) continue
    if (launch.pausedAt) launch.resumeAllowedAt = Date.now()
    const waiting = [...launch.workers.values()].filter(worker => worker.released && worker.wakeNoticePending)
    if (waiting.length === 0) continue
    for (const worker of waiting) worker.wakeNoticePending = false
    const tasks = await listTasks(getCanonicalTeamTaskListId(launch.plan.teamName)).catch(() => [] as Task[])
    const tasksById = tasksByIdOf(tasks)
    const lines = waiting.map(worker => {
      const open = tasks.filter(task => task.owner === worker.member.name && task.status !== 'completed')
      const label = worker.failure ? `${worker.member.name} (stopped on an error: ${worker.failure})` : worker.member.name
      // A member whose start failed is reported like any other failure.
      if (worker.brief !== undefined && !worker.failure) {
        const ready = readyTasksOf(worker.member.name, tasks)
        const blockers = [...new Set(open.flatMap(task => findUnsatisfiedBlockers(task, tasksById)))]
        if (ready.length > 0) return `- ${label}: not started yet; ${ready.map(task => `#${task.id} ${task.subject}`).join('; ')} is ready for it, so message it to start`
        if (blockers.length > 0) return `- ${label}: not started yet; it starts by itself once ${blockers.map(id => `#${id}`).join(', ')} ${blockers.length === 1 ? 'is' : 'are'} completed, and messages to it wait until then`
        return `- ${label}: not started yet; no unfinished task`
      }
      return open.length > 0
        ? `- ${label}: ${open.map(task => `#${task.id} ${task.subject} (${task.status})`).join('; ')}`
        : `- ${label}: no unfinished task`
    })
    const stoppedByUser = waiting.some(worker => worker.stoppedByUser)
    await conversationService.sendMessage(parentSessionId, [
      stoppedByUser
        ? `[Team runtime notice] The user's Stop also stopped your team ${launch.plan.teamName}. These members are stopped and keep their work so far:`
        : `[Team runtime notice] These members of your team ${launch.plan.teamName} stopped on an error and keep their work so far:`,
      ...lines,
      'A stopped member does nothing until it is messaged: if the work should go on, SendMessage each member that still has work, and it resumes from its saved conversation where it left off. Do not spawn replacements or redo their tasks. If a woken member fails again with the same error (a usage limit, billing, the network), tell the user instead of retrying. If the user wants the team to stay stopped, leave them.',
    ].join('\n'))
  }
}

let hooksInstalled = false
function ensureRuntimeHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  conversationService.addTeamRuntimeListener({
    leadInterrupted: pauseLaunchesForLead,
    sessionStarted: (sessionId, { isTeamWorker }) => {
      // A lead that restarted (provider/permission change, crash, reopen, app
      // restart) lost its in-memory roster; give it back so it can keep
      // coordinating, re-owning the team first if the server restarted.
      const ownedLaunch = () => [...launches.values()].find(item => item.parentId === sessionId && item.running && !item.stopped)
      // Workers never lead a team; skip the disk scan a re-own needs.
      if (!ownedLaunch() && isTeamWorker) return
      void migrationMaintenance.track((async () => {
        if (!ownedLaunch()) await rehydrateTeamPlanRuntimesForSession(sessionId)
        const launch = ownedLaunch()
        if (launch) await sendTeamSnapshot(launch)
      })()).catch(error => console.error('[TeamPlanRuntime] cannot restore the team after a lead start', error))
    },
  })
}

// ── Public lifecycle ────────────────────────────────────────────────────────

export async function stopTeamPlanRuntime(planId: string): Promise<void> {
  const launch = launches.get(planId)
  if (!launch) return
  launch.stopped = true
  if (launch.timer) clearInterval(launch.timer)
  for (const worker of launch.workers.values()) {
    cancelAutoContinue(worker)
    conversationService.cancelScopedMessages(worker.sessionId, worker.scope, 'runtime_ended')
    worker.inFlight = undefined
  }
  launches.delete(planId)
  await Promise.allSettled(launch.children.map(id => conversationService.stopSessionAndWait(id)))
  const plan = launch.plan
  // Every member of this launch has a reserved session id, whether or not its
  // process ever started. Removing by that reservation (rather than only by
  // started processes) cleans up a launch cancelled while a member was still
  // preparing, and keeps a released member's row as stopped instead.
  const reserved = new Set([...launch.workers.values()].map(worker => worker.sessionId))
  let sameGeneration = false
  await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
    const lifecycle = await readTaskListLifecycleState(getCanonicalTeamTaskListId(plan.teamName))
    if (!launch.scope || lifecycle.deleted || lifecycle.generation !== launch.scope.generation) return
    sameGeneration = true
    try {
      await mutateTeamFileAsync(plan.teamName, team => {
        if (incarnationOf(team) !== plan.incarnationId) return
        team.members = team.members.flatMap(member => {
          const worker = [...launch.workers.values()].find(worker => worker.sessionId === member.sessionId && worker.consumerInstanceId === member.consumerInstanceId)
          if (!member.sessionId || !reserved.has(member.sessionId) || !worker) return [member]
          return launch.released ? [{ ...member, isActive: false, terminated: true }] : []
        })
      })
    } catch (error) {
      if (!(error instanceof TeamFileNotFoundError)) throw error
    }
  })
  if (launch.released && sameGeneration) {
    const tasks = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
    for (const task of tasks.filter(task => task.metadata?.teamPlanId === plan.planId && task.status === 'in_progress')) {
      await updateTask(getCanonicalTeamTaskListId(plan.teamName), task.id, { metadata: { ...task.metadata, teamRuntimeInterrupted: true } })
    }
  }
}

export async function launchTeamPlanRuntime(plan: TeamPlanRecord): Promise<{ memberIds: Record<string, string> }> {
  migrationMaintenance.assertAvailable()
  const approved = plan.approvedSnapshot
  if (!approved || approved.revision !== plan.revision - 1 || plan.state !== 'launching') throw new Error('Team plan is not approved for launch')
  ensureRuntimeHooks()
  await conversationService.waitForTeamWorkersStopped(plan.sessionId)
  const durable = await readTeamPlan(plan.teamName)
  if (!durable || durable.planId !== plan.planId || durable.incarnationId !== plan.incarnationId || durable.state !== 'launching' || durable.revision !== plan.revision || durable.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
  if (launches.has(plan.planId)) throw new Error('Team plan already has a launch in progress')
  if (!conversationService.hasSession(plan.sessionId)) throw new Error('Team leader must be connected before launching')
  const members = approved.members
  const launch: TeamLaunch = {
    parentId: plan.sessionId, plan, createdAt: 0, released: false, running: false, children: [], workers: new Map(),
    supervising: false, stopped: false, permissionMode: conversationService.getSessionPermissionMode(plan.sessionId),
  }
  launches.set(plan.planId, launch)
  const memberIds: Record<string, string> = {}
  let taskMapping: Record<string, string> = {}
  let executionStarted = false
  try {
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      launch.scope = await approvedLeadScope(plan)
      try {
        await mutateTeamFileAsync(plan.teamName, team => {
          if (team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId) throw new Error('Team generation no longer exists')
          team.reviewRequired = true
          launch.createdAt = team.createdAt
        })
      } catch (error) {
        if (error instanceof TeamFileNotFoundError) throw new Error('Team generation no longer exists')
        throw error
      }
    })
    taskMapping = await materializeTasks(plan)
    const startingTasks = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
    // Approval authorizes roles; it is not work. A member starts now only if
    // it owns a task whose dependencies are already complete. Everyone else
    // keeps a stable identity but gets no process until a task becomes ready
    // or the user (or lead) explicitly instructs it.
    const hasReadyTask = (member: TeamPlanMember) => readyTasksOf(member.name, startingTasks).length > 0
    const starting = members.filter(hasReadyTask)
    const standby = new Set(members.filter(member => !hasReadyTask(member)).map(member => member.id))
    for (const member of members) {
      const sessionId = randomUUID()
      memberIds[member.id] = sessionId
      const consumerInstanceId = randomUUID()
      launch.workers.set(member.id, { member, sessionId, consumerInstanceId, scope: processScope(launch.scope!, member, sessionId, consumerInstanceId), released: false, started: false, stopGeneration: 0, autoContinueAttempts: 0, restartHistory: [], restartsExhausted: false, wokenForTaskIds: new Set() })
    }
    const assertLaunchAuthorized = async (): Promise<void> => {
      const latest = await readTeamPlan(plan.teamName)
      if (launch.stopped || !latest || latest.planId !== plan.planId || latest.incarnationId !== plan.incarnationId || latest.state !== 'launching' || latest.revision !== plan.revision || latest.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
    }
    // The roster is written before any process starts: a standby member needs
    // an address even though nothing runs, and a failed launch still removes
    // every entry (launch.released stays false until authorization is used).
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      try {
        await mutateTeamFileAsync(plan.teamName, team => {
          if (team.createdAt !== launch.createdAt || team.leadSessionId !== plan.sessionId) throw new Error('Team generation changed during launch')
          for (const entry of members) {
            if (team.members.some(old => old.name === entry.name)) throw new Error(`Member already exists: ${entry.name}`)
            team.members.push({ agentId: `${entry.name}@${plan.teamName}`, name: entry.name, agentType: entry.agentType,
              model: entry.runtime.modelId, providerId: entry.runtime.providerId, providerName: typeof entry.providerName === 'string' ? entry.providerName : undefined, effortLevel: entry.runtime.effortLevel,
              planMemberId: entry.id, joinedAt: Date.now(), tmuxPaneId: '', cwd: plan.workDir, subscriptions: [],
              consumerInstanceId: launch.workers.get(entry.id)!.consumerInstanceId,
              sessionId: memberIds[entry.id], backendType: 'process',
              // Every approved member's process is still pending here: a standby
              // member stays so until its first start, and a starting one flips
              // this as soon as its process is up. A crash in between therefore
              // reads as "never ran" rather than resuming a transcript that does
              // not exist.
              initialStartPending: true,
              ...(standby.has(entry.id) ? { isActive: false, awaitingDependencies: true } : { isActive: true }) })
          }
        })
      } catch (error) {
        if (error instanceof TeamFileNotFoundError) throw new Error('Team generation changed during launch')
        throw error
      }
    })
    await startTeamWorkersBarrier(starting, async member => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      const worker = launch.workers.get(member.id)!
      reserveChild(launch, worker)
      await startWorkerProcess(launch, worker, false)
      worker.started = true
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, initialStartPending: false }))
      return worker.sessionId
    }, async (member, id) => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      const worker = launch.workers.get(member.id)!
      const brief = memberBrief(member, members, approved.tasks, taskMapping)
      await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
        // All processes are ready by the time the first release is reached.
        await assertLaunchAuthorized()
        executionStarted = true
        // From here the approval has been used: an end keeps the roster as
        // stopped rather than erasing the members the lead already knows.
        launch.released = true
      })
      const receipt = await conversationService.sendScopedMessage(id, brief, worker.scope, { canSend: () => !launch.stopped && !launch.pausedAt })
      const outcome = receipt.status === 'queued' ? await receipt.completion : receipt
      if (outcome.status !== 'sent') throw new Error(`Failed to release ${member.name}: ${outcome.reason}`)
      worker.released = true
    }, id => conversationService.stopSessionAndWait(id))
    // Release the approval even when nothing runs yet: the roster exists and
    // the supervisor first-starts each standby member on a ready task or an
    // explicit instruction.
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      await assertLaunchAuthorized()
      executionStarted = true
      launch.released = true
      for (const member of members) {
        const worker = launch.workers.get(member.id)!
        worker.released = true
        if (standby.has(member.id)) worker.brief = memberBrief(member, members, approved.tasks, taskMapping)
      }
    })
    await sendTeamSnapshot(launch)

    // One supervisor owns each worker inbox. SDK serializes user turns; a worker
    // remains connected while idle and wakes when another teammate writes.
    launch.running = true
    startSupervisor(launch)
    const waitingNames = members.filter(member => standby.has(member.id)).map(member => member.name)
    const openTasksOf = (member: TeamPlanMember) => startingTasks.filter(task => task.owner === member.name && task.status !== 'completed')
    const blockedNames = members.filter(member => standby.has(member.id) && openTasksOf(member).length > 0).map(member => member.name)
    const idleNames = waitingNames.filter(name => !blockedNames.includes(name))
    const waitingNote = [
      blockedNames.length > 0
        ? ` Every task of ${blockedNames.join(', ')} waits on other tasks: such a member gets its instructions automatically once one of its tasks is ready, and messages sent to it before that wait in its inbox.`
        : '',
      idleNames.length > 0
        ? ` ${idleNames.join(', ')} ${idleNames.length === 1 ? 'is approved with no task and no process yet' : 'are approved with no task and no process yet'}: assign a ready task or SendMessage one and it starts then.`
        : '',
      waitingNames.length > 0
        ? ' Each member is told to send its result to the members whose tasks depend on it before completing, so forward a result yourself only when a member says one is missing.'
        : '',
    ].join('')
    await conversationService.sendMessage(plan.sessionId, `Approved team ${plan.teamName} is running. Members and their shared tasks are ready.${waitingNote} Continue coordinating the approved team; do not spawn these members again. Members report back automatically when they finish or fail; you do not need to poll or wait in a loop.`)
    return { memberIds }
  } catch (error) {
    await stopTeamPlanRuntime(plan.planId)
    if (executionStarted) throw new TeamPlanExecutionInterruptedError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Keep released teams resumable while preventing every supervisor wake. */
export async function quiesceTeamPlanRuntimesForMigration(): Promise<void> {
  const parents = new Set([...launches.values()].map(launch => launch.parentId))
  for (const parent of parents) pauseLaunchesForLead(parent)
  for (const launch of launches.values()) {
    if (launch.timer) clearInterval(launch.timer)
    launch.timer = undefined
    for (const worker of launch.workers.values()) cancelAutoContinue(worker)
    if (launch.running) continue
    launch.stopped = true
    const current = await readTeamPlan(launch.plan.teamName)
    if (current?.planId === launch.plan.planId && current.state === 'launching') {
      await mutateTeamPlan(current.teamName, { ...current, expectedRevision: current.revision }, plan => ({
        ...plan, state: launch.released ? 'interrupted' : 'cancelled',
        launch: { ...plan.launch, status: 'failed', executionStarted: launch.released, error: 'Team startup stopped for data migration.' },
      }))
    }
  }
}

/**
 * Rebuild the supervisor for an approved team whose server-side owner was lost
 * (server or app restart). Members start dormant and restart from their own
 * transcripts as soon as the lead or the user messages them.
 */
export async function rehydrateTeamPlanRuntime(plan: TeamPlanRecord): Promise<boolean> {
  if (migrationMaintenance.isActive) return false
  if (plan.state !== 'running' || !plan.approvedSnapshot || launches.has(plan.planId)) return launches.has(plan.planId)
  let restoredScope: ConsumerScope | undefined
  try {
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      let durable = await readTeamPlan(plan.teamName)
      if (durable?.planId !== plan.planId) {
        if (!/^[a-f0-9-]{36}$/i.test(plan.planId)) return
        durable = teamPlanRecordSchema.parse(JSON.parse(await readFile(join(getTeamDir(plan.teamName), `plan-${plan.planId}.json`), 'utf8')))
      }
      if (!durable || durable.state !== 'running' || durable.planId !== plan.planId || durable.sessionId !== plan.sessionId || durable.incarnationId !== plan.incarnationId ||
        JSON.stringify(durable.approvedSnapshot) !== JSON.stringify(plan.approvedSnapshot) || JSON.stringify(durable.launch?.memberIds) !== JSON.stringify(plan.launch?.memberIds)) return
      const scope = await approvedLeadScope(durable)
      await mutateTeamFileAsync(plan.teamName, current => {
        if (current.createdAt !== scope.createdAt || current.leadSessionId !== scope.leadSessionId || incarnationOf(current) !== durable!.incarnationId) return
        const members = current.members.map(entry => {
          const approved = durable!.approvedSnapshot!.members.find(member => member.id === entry.planMemberId && member.name === entry.name)
          // Name-only roster fallback is not proof of the original worker session.
          if (!approved || entry.backendType !== 'process' || !entry.sessionId || durable!.launch?.memberIds?.[approved.id] !== entry.sessionId || current.members.filter(other => other.name === entry.name).length !== 1) return entry
          if (entry.consumerInstanceId !== undefined && (typeof entry.consumerInstanceId !== 'string' || !entry.consumerInstanceId.trim())) return entry
          return entry.consumerInstanceId ? entry : { ...entry, consumerInstanceId: randomUUID() }
        })
        restoredScope = scope
        return { ...current, members }
      })
    })
  } catch { return false }
  if (!restoredScope) return false
  const team = readTeamFile(plan.teamName)
  if (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId) return false
  const memberIds = plan.launch?.memberIds ?? {}
  const workers = new Map<string, WorkerRuntime>()
  let taskMapping: Record<string, string> | undefined
  for (const member of plan.approvedSnapshot.members) {
    const sessionId = memberIds[member.id]
    if (!sessionId) continue
    const entry = team.members.find(candidate => candidate.sessionId === sessionId && candidate.planMemberId === member.id && candidate.name === member.name && candidate.backendType === 'process')
    if (!entry?.consumerInstanceId) continue
    // `initialStartPending` is the only thing that says a member never ran. It
    // is absent on team files written before the field existed, and every
    // member of those launches had a process — including one whose approved
    // instructions were deferred until a task became ready. Reading the older
    // `awaitingDependencies` as "never started" would resume nothing and lose
    // that member's transcript, so absence migrates to "already started".
    const neverStarted = entry.initialStartPending === true
    const worker: WorkerRuntime = { member, sessionId, consumerInstanceId: entry.consumerInstanceId, scope: processScope(restoredScope, member, sessionId, entry.consumerInstanceId), released: true, started: !neverStarted, stopGeneration: 0, autoContinueAttempts: 0, restartHistory: [], restartsExhausted: false, wokenForTaskIds: new Set() }
    // Still waiting for its first ready task: rebuild the instructions it was approved with.
    if (entry.awaitingDependencies === true) {
      taskMapping ??= Object.fromEntries((await listTasks(getCanonicalTeamTaskListId(plan.teamName)).catch(() => [] as Task[]))
        .filter(task => task.metadata?.teamPlanId === plan.planId && typeof task.metadata?.teamPlanTaskId === 'string')
        .map(task => [task.metadata!.teamPlanTaskId as string, task.id]))
      worker.brief = memberBrief(member, plan.approvedSnapshot.members, plan.approvedSnapshot.tasks, taskMapping)
    }
    workers.set(member.id, worker)
  }
  if (workers.size === 0) return false
  // Another start may have re-owned the team while the task list was read.
  if (launches.has(plan.planId)) return true
  ensureRuntimeHooks()
  const launch: TeamLaunch = {
    scope: restoredScope,
    parentId: plan.sessionId, plan, createdAt: team.createdAt, released: true, running: true,
    // Only members that had started have a process to lose. A standby member
    // keeps its identity and is first-started on demand.
    children: [...workers.values()].filter(worker => worker.started).map(worker => worker.sessionId), workers, supervising: false, stopped: false,
    // Restoring the team is not the user continuing it: a Stop recorded on disk
    // keeps every automatic start held until a new instruction arrives.
    ...(team.pausedAt !== undefined ? { pausedAt: team.pausedAt } : {}),
    permissionMode: conversationService.getSessionPermissionMode(plan.sessionId),
  }
  launches.set(plan.planId, launch)
  await mutateTeamFileAsync(plan.teamName, current => {
    if (current.createdAt !== team.createdAt) return
    const sessions = new Set(launch.children)
    return { ...current, members: current.members.map(entry => entry.sessionId && sessions.has(entry.sessionId) && !conversationService.hasSession(entry.sessionId) ? { ...entry, isActive: false, terminated: true } : entry) }
  }).catch(() => undefined)
  startSupervisor(launch)
  return true
}

/** Restore every approved launch (current and archived parent plans) of a lead's team. */
export async function rehydrateTeamPlanRuntimesForSession(sessionId: string): Promise<boolean> {
  const current = await findTeamPlanForSession(sessionId)
  if (!current) return false
  const plans: TeamPlanRecord[] = [current]
  try {
    for (const file of await readdir(getTeamDir(current.teamName))) {
      if (!/^plan-[a-f0-9-]{36}\.json$/i.test(file)) continue
      try {
        const archived = teamPlanRecordSchema.parse(JSON.parse(await readFile(join(getTeamDir(current.teamName), file), 'utf8')))
        if (archived.incarnationId === current.incarnationId && archived.sessionId === sessionId) plans.push(archived)
      } catch {
        // An unreadable archive cannot be restored; the live plan still can.
      }
    }
  } catch {
    // No team directory: nothing to restore.
  }
  let restored = false
  for (const plan of plans) {
    if (plan.state === 'running' && await rehydrateTeamPlanRuntime(plan)) restored = true
  }
  return restored
}

export async function notifyTeamPlanLeader(plan: TeamPlanRecord, kind: 'approved' | 'returned' | 'cancelled'): Promise<void> {
  // Approval wakes the leader only after launch's readiness barrier and snapshot.
  if (kind === 'approved' || !conversationService.hasSession(plan.sessionId)) return
  await conversationService.sendMessage(plan.sessionId, kind === 'returned'
    ? `The user returned team plan ${plan.teamName} for revision. No members were launched. Feedback: ${plan.feedback ?? 'Revise the team proposal.'}`
    : `The user cancelled team plan ${plan.teamName}. Do not launch its members. Wait for new user instructions.`)
}

export class TeamPlanExecutionInterruptedError extends Error {
  readonly executionStarted = true
}

/** Tests simulate a server restart: owners vanish, processes and files stay. */
export function forgetTeamPlanRuntimesForTests(): void {
  for (const launch of launches.values()) {
    if (launch.timer) clearInterval(launch.timer)
    launch.stopped = true
    for (const worker of launch.workers.values()) {
      cancelAutoContinue(worker)
      conversationService.cancelScopedMessages(worker.sessionId, worker.scope, 'runtime_ended')
      worker.inFlight = undefined
    }
  }
  launches.clear()
}

export function isTeamPlanRuntimeActive(planId: string): boolean {
  const launch = launches.get(planId)
  // A paused or lead-less team is still owned here: its members restart on
  // demand. Only an explicit stop or a deleted team ends ownership.
  return !!launch && !launch.stopped
}

/** Whether a lead's approved team has a member mid-turn (keeps an unattended lead alive). */
export function hasActiveTeamWorkForParent(parentSessionId: string): boolean {
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped || launch.pausedAt) continue
    if (!launch.running) return true
    const team = readTeamFile(launch.plan.teamName)
    for (const worker of launch.workers.values()) {
      if (worker.autoContinueTimer) return true
      if (!conversationService.hasSession(worker.sessionId)) continue
      if (team?.members.find(entry => entry.sessionId === worker.sessionId)?.isActive) return true
    }
  }
  return false
}

/**
 * Stop the teams a lead owns. With `pauseReleased`, a team that is already
 * running is paused (the user's Stop) rather than ended; a launch that has not
 * finished starting is still revoked.
 */
export async function stopTeamPlanRuntimesForParent(parentSessionId: string, options: { pauseReleased?: boolean } = {}): Promise<void> {
  const owned = () => [...launches.entries()].filter(([, launch]) => launch.parentId === parentSessionId && !(options.pauseReleased && launch.running))
  const stopOwned = () => Promise.all(owned().map(([planId]) => stopTeamPlanRuntime(planId)))
  const hadReleasedWork = owned().some(([, launch]) => launch.released)
  const endedRunning = owned().filter(([, launch]) => launch.running).map(([, launch]) => launch.plan)
  await stopOwned()
  const plan = await findTeamPlanForSession(parentSessionId)
  if (plan?.state === 'launching') {
    await mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({
      ...current, state: hadReleasedWork ? 'interrupted' : 'cancelled',
      launch: { ...current.launch, status: 'failed', executionStarted: hadReleasedWork, error: 'The user stopped team startup.' },
    })).catch(error => {
      // A concurrent approval/cancellation changes the revision; the second
      // ownership pass still revokes any process launch admitted in that window.
      console.error('[TeamPlanRuntime] stopped plan changed concurrently', error)
    })
  }
  // An ended (not paused) running team must not be rehydrated later.
  for (const ended of endedRunning) {
    const latest = await readTeamPlan(ended.teamName).catch(() => null)
    if (latest?.planId !== ended.planId || latest.state !== 'running') continue
    await mutateTeamPlan(latest.teamName, { ...latest, expectedRevision: latest.revision }, current => ({
      ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'The team was stopped.' },
    })).catch(error => console.error('[TeamPlanRuntime] cannot record the stopped team', error))
  }
  await stopOwned()
}

/**
 * End a lead's reviewed teams for good (/clear or deleting the session): stop
 * every launch and remove the team and task directories. The lead's CLI no
 * longer deletes them on exit because a desktop lead process restarts often.
 */
export async function endTeamsForParent(parentSessionId: string): Promise<void> {
  await stopTeamPlanRuntimesForParent(parentSessionId)
  let names: string[] = []
  try {
    names = await readdir(getTeamsDirectory())
  } catch {
    return
  }
  for (const name of names) {
    const team = readTeamFile(name)
    if (!team || team.leadSessionId !== parentSessionId || !team.reviewRequired) continue
    await cleanupTeamDirectories(name).catch(error => console.error(`[TeamPlanRuntime] cannot remove ended team ${name}`, error))
  }
}

// Restarts of a lead (and of the server itself) must find the hooks in place
// before any launch happens in this process.
ensureRuntimeHooks()
