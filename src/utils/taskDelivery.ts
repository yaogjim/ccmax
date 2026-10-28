import { createHash } from 'node:crypto'
import type { ToolUseContext } from '../Tool.js'
import { executeTaskCompletedHooks, getTaskCompletedHookMessage } from './hooks.js'
import { isTaskDeliveryUnsupported, TASK_DELIVERY_UNSUPPORTED_ERROR, taskDeliveryActionSchema, type TaskDeliveryAction } from '../shared/taskDelivery.js'
import { getCanonicalTeamTaskListId, listTasks, updateTaskAtomically, withTaskListLifecycleLock } from './tasks.js'
import { readTeamFileAsync } from './swarm/teamHelpers.js'
import { isTeamExecutionApproved, readTeamPlan, TeamPlanError } from './swarm/teamPlanStore.js'
import { writeToMailbox } from './teammateMailbox.js'

export type DeliveryIdentity = { leadSessionId: string; incarnationId: string }

/**
 * Approval belongs to the member doing the work, not to the reviewer's role.
 * Passing `undefined` for a human or lead review skipped parent-plan
 * backtracking, so reviewing a child draft rejected an owner that the running
 * parent plan still approves. A member actor additionally needs its own
 * approval; the owner's approval is what authorizes the task's execution.
 */
async function assertDeliveryApproval(teamName: string, actor: string, owner: string | undefined): Promise<void> {
  if (!await readTeamPlan(teamName)) return
  const subjects = [...new Set([
    ...(actor === 'user' || actor === 'team-lead' ? [] : [actor]),
    ...(owner === undefined ? [] : [owner]),
  ])]
  if (subjects.length === 0) {
    if (!await isTeamExecutionApproved(teamName)) throw new TeamPlanError('Team execution requires approval', 403)
    return
  }
  for (const subject of subjects) {
    if (!await isTeamExecutionApproved(teamName, subject)) throw new TeamPlanError('Team execution requires approval', 403)
  }
}

/** Uses the existing task-list transaction and mailbox; no second task store. */
export async function applyTaskDeliveryAction(teamName: string, taskId: string, actor: string, input: TaskDeliveryAction, identity?: DeliveryIdentity, options: { context?: ToolUseContext; signal?: AbortSignal } = {}) {
  const action = taskDeliveryActionSchema.parse(input)
  const signal = options.signal ?? options.context?.abortController?.signal
  const assertNotCancelled = () => {
    if (signal?.aborted) throw new TeamPlanError('Task delivery action cancelled')
  }
  assertNotCancelled()
  const taskListId = getCanonicalTeamTaskListId(teamName)
  const fingerprint = createHash('sha256').update(JSON.stringify({ actor, ...action })).digest('hex')
  const authorizedTask = async () => {
    const team = await readTeamFileAsync(teamName)
    if (!team) throw new TeamPlanError('Team no longer exists', 404)
    const createdAt = Number.isFinite(team.createdAt) ? team.createdAt : 0
    const incarnationId = createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId ?? '', createdAt])).digest('hex')
    if (identity && (identity.leadSessionId !== team.leadSessionId || identity.incarnationId !== incarnationId)) throw new TeamPlanError('Team identity changed; refresh before reviewing')
    if (actor !== 'user' && actor !== 'team-lead' && !team.members.some(member => member.name === actor)) throw new TeamPlanError('Reviewer is not a team member', 403)
    const tasks = await listTasks(taskListId)
    const tasksById = new Map(tasks.map(task => [task.id, task]))
    const task = tasksById.get(taskId)
    if (!task) throw new TeamPlanError('Task not found', 404)
    if (isTaskDeliveryUnsupported(task)) throw new TeamPlanError(TASK_DELIVERY_UNSUPPORTED_ERROR)
    await assertDeliveryApproval(teamName, actor, task.owner ?? task.delivery?.submissions.at(-1)?.owner)
    return { task, tasksById, incarnationId }
  }
  if (action.action === 'accept') {
    const { task } = await withTaskListLifecycleLock(taskListId, authorizedTask)
    const latest = task.delivery?.submissions.at(-1)
    const receipt = task.delivery?.receipts.find(item => item.requestId === action.requestId)
    if (!receipt) {
      if (!latest || latest.version !== action.version) throw new TeamPlanError('Artifact version changed; review the latest version')
      if (latest.review) throw new TeamPlanError('This artifact version was already reviewed')
      if (task.delivery?.revision !== action.expectedRevision) throw new TeamPlanError('Delivery changed; refresh before continuing')
      if (actor === task.owner || actor === latest.owner) throw new TeamPlanError('Delivery requires an independent reviewer', 403)
      assertNotCancelled()
      // Like ordinary TaskUpdate completion, hooks run outside the task locks.
      // The commit below revalidates revision, identity, ownership and consent.
      for await (const result of executeTaskCompletedHooks(taskId, task.subject, task.description, actor, teamName, undefined, signal, undefined, options.context)) {
        assertNotCancelled()
        if (result.blockingError) throw new TeamPlanError(getTaskCompletedHookMessage(result.blockingError))
      }
      assertNotCancelled()
    }
  }
  const result = await withTaskListLifecycleLock(taskListId, async () => {
    const { tasksById, incarnationId } = await authorizedTask()
    const mutation = await updateTaskAtomically(taskListId, taskId, current => {
      assertNotCancelled()
      const delivery = structuredClone(current.delivery ?? { schemaVersion: 1 as const, revision: 0, submissions: [], receipts: [], notices: [] })
      const receipt = delivery.receipts.find(item => item.requestId === action.requestId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new TeamPlanError('requestId already belongs to a different delivery action')
        return
      }
      if (delivery.revision !== action.expectedRevision) throw new TeamPlanError('Delivery changed; refresh before continuing')
      const latest = delivery.submissions.at(-1)
      const now = Date.now()
      // A blocker that is missing from the list cannot count as completed.
      const dependenciesCompleted = current.blockedBy.every(id => tasksById.get(id)?.status === 'completed')
      if ((action.action === 'submit' || action.action === 'accept') && !dependenciesCompleted) throw new TeamPlanError('Task dependencies must complete before submitting or accepting a delivery')
      let status = current.status
      let recipient: string | undefined
      let text: string | undefined
      if (action.action === 'submit') {
        if (actor !== current.owner) throw new TeamPlanError('Only the task owner can submit a delivery', 403)
        if (current.status === 'completed') throw new TeamPlanError('Completed task cannot receive another delivery')
        if (latest && latest.review?.decision !== 'return') throw new TeamPlanError('This version is awaiting review or already accepted')
        if (action.version !== (latest?.version ?? 0) + 1) throw new TeamPlanError('Submit the next artifact version')
        if (latest && latest.artifact === action.artifact && latest.criteria === action.criteria) throw new TeamPlanError('A new version requires new artifact facts')
        delivery.submissions.push({ version: action.version, artifact: action.artifact, criteria: action.criteria, owner: actor, submittedAt: now })
        status = 'in_progress'
        recipient = 'team-lead'
        text = `Review required: task #${taskId}, artifact v${action.version} from ${actor}. Artifact: ${action.artifact}\nAcceptance criteria: ${action.criteria}\nUse TaskUpdate deliveryAction to accept or return this exact version. Do not ask the owner to review its own work.`
      } else {
        if (!latest || latest.version !== action.version) throw new TeamPlanError('Artifact version changed; review the latest version')
        if (actor === latest.owner || actor === current.owner) throw new TeamPlanError('Delivery requires an independent reviewer', 403)
        if (latest.review) throw new TeamPlanError('This artifact version was already reviewed')
        latest.review = { decision: action.action, reviewer: actor, reviewedAt: now, ...(action.action === 'return' ? { reason: action.reason } : {}) }
        status = action.action === 'accept' ? 'completed' : 'in_progress'
        if (action.action === 'return') {
          recipient = latest.owner
          text = `Rework required: task #${taskId}, artifact v${action.version} returned by ${actor}. Reason: ${action.reason}\nAddress the reason and submit a new artifact version for independent review.`
        }
        // Acceptance is a protocol receipt, not a new model turn.
      }
      delivery.revision++
      delivery.receipts.push({ requestId: action.requestId, fingerprint })
      if (recipient && text) delivery.notices.push({ id: `delivery-${createHash('sha256').update(`${teamName}:${incarnationId}:${taskId}:${action.requestId}`).digest('hex')}`, recipient, text, delivered: false })
      return { status, delivery }
    }, { deliveryTransition: true })
    if (!mutation) throw new TeamPlanError('Task not found', 404)
    return mutation
  })
  await flushTaskDeliveryNotices(teamName)
  return result
}

/** Durable notices survive a crash between the task commit and mailbox write. */
export async function flushTaskDeliveryNotices(teamName: string): Promise<void> {
  const taskListId = getCanonicalTeamTaskListId(teamName)
  await withTaskListLifecycleLock(taskListId, async () => {
    const team = await readTeamFileAsync(teamName)
    if (!team) return
    const members = new Set(team.members.map(member => member.name))
    for (const task of await listTasks(taskListId)) {
      for (const notice of task.delivery?.notices ?? []) {
        if (notice.delivered) continue
        // The lead's inbox is always valid; any other recipient must still be
        // a member so a stale notice cannot reserve a phantom mailbox.
        if (notice.recipient !== 'team-lead' && !members.has(notice.recipient)) continue
        // writeToMailbox never throws; false means nothing was persisted, so
        // the notice stays pending and the next flush retries the same id.
        if (!await writeToMailbox(notice.recipient, { from: 'team-lead', text: notice.text, timestamp: new Date().toISOString(), id: notice.id }, teamName)) continue
        await updateTaskAtomically(taskListId, task.id, current => {
          if (!current.delivery) return
          const delivery = structuredClone(current.delivery)
          const pending = delivery.notices.find(item => item.id === notice.id)
          if (!pending || pending.delivered) return
          pending.delivered = true
          return { delivery }
        }, { deliveryTransition: true })
      }
    }
  })
}