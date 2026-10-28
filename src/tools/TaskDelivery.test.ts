import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import * as originalHooks from '../utils/hooks.js'
import { handleTeamsApi } from '../server/api/teams.js'
import { teamPlanRecordSchema } from '../shared/teamPlan.js'
import { TASK_DELIVERY_UNSUPPORTED_ERROR } from '../shared/taskDelivery.js'
import {
  claimTask,
  createTask,
  deleteTaskWithCommit,
  getTask,
  listTasks,
  readTaskListSnapshot,
  unassignTeammateTasks,
} from '../utils/tasks.js'
import * as lockfile from '../utils/lockfile.js'
import { PROMPT } from './TaskUpdateTool/prompt.js'
import { getTeamDir, writeTeamFileAsync } from '../utils/swarm/teamHelpers.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../utils/teammate.js'

// The real hook runner yields nothing when its signal is already aborted and
// runs user hooks only after a trust check. These tests need the tool's abort
// contract, not hook spawning, so the fake mirrors that observable behavior:
// no results once aborted, and an optional block or abort from a running hook.
// Snapshot before mock.module() so the fake can delegate to the real runner
// instead of resolving the replacement back to itself.
const realHooks = { ...originalHooks }
type TaskCompletedHookArgs = Parameters<typeof realHooks.executeTaskCompletedHooks>
type TaskCreatedHookArgs = Parameters<typeof realHooks.executeTaskCreatedHooks>
let completedHookRuns = 0
let onCompletedHook: ((signal?: AbortSignal) => void) | undefined
let createdHookBlock: string | undefined
async function* fakeExecuteTaskCompletedHooks(...args: TaskCompletedHookArgs) {
  completedHookRuns++
  onCompletedHook?.(args[6])
  if (args[6]?.aborted) return
  yield* realHooks.executeTaskCompletedHooks(...args)
}
async function* fakeExecuteTaskCreatedHooks(...args: TaskCreatedHookArgs) {
  if (!createdHookBlock) return yield* realHooks.executeTaskCreatedHooks(...args)
  yield { blockingError: { blockingError: createdHookBlock, command: 'fixture' }, outcome: 'blocking' as const }
}
mock.module('../utils/hooks.js', () => ({
  ...realHooks,
  executeTaskCompletedHooks: fakeExecuteTaskCompletedHooks,
  executeTaskCreatedHooks: fakeExecuteTaskCreatedHooks,
}))
const { TaskCreateTool } = await import('./TaskCreateTool/TaskCreateTool.js')
const { TaskGetTool } = await import('./TaskGetTool/TaskGetTool.js')
const { TaskUpdateTool } = await import('./TaskUpdateTool/TaskUpdateTool.js')

let root: string
let saved: NodeJS.ProcessEnv
const teamName = 'delivery-tools'
const incarnationId = createHash('sha256').update(JSON.stringify([teamName, 'lead', 1])).digest('hex')
const context = { setAppState: () => {}, getAppState: () => ({ teamContext: { teamName } }) } as unknown as ToolUseContext
const asMember = (name: string) => setDynamicTeamContext({ agentId: `${name}@${teamName}`, agentName: name, teamName, planModeRequired: false })
const storedTask = async (id = '1') => getTask(teamName, id)
beforeEach(async () => {
  saved = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'ccmax-delivery-tools-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.CLAUDE_CODE_TASK_LIST_ID = teamName
  completedHookRuns = 0
  onCompletedHook = undefined
  createdHookBlock = undefined
  await writeTeamFileAsync(teamName, { name: teamName, createdAt: 1, leadAgentId: `team-lead@${teamName}`, leadSessionId: 'lead', members: ['builder', 'reviewer', 'reworker'].map(name => ({ name, agentId: `${name}@${teamName}`, agentType: 'general-purpose', joinedAt: 1, tmuxPaneId: '', cwd: root, subscriptions: [] })) })
  await mkdir(join(root, 'tasks', teamName), { recursive: true })
  await writeFile(join(root, 'tasks', teamName, '1.json'), JSON.stringify({ id: '1', subject: 'Deliver', description: '', status: 'in_progress', owner: 'builder', blocks: [], blockedBy: [] }))
})
afterEach(async () => {
  clearDynamicTeamContext()
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(root, { recursive: true, force: true })
})
afterAll(() => {
  mock.module('../utils/hooks.js', () => realHooks)
})
const submit = { action: 'submit' as const, expectedRevision: 0, version: 1, artifact: 'artifact@v1 digest:fixture', criteria: 'Regression passed', requestId: 'submit' }
const returnV1 = { action: 'return' as const, expectedRevision: 1, version: 1, reason: 'Add boundary regression', requestId: 'return' }
const acceptV1 = { action: 'accept' as const, expectedRevision: 1, version: 1, requestId: 'accept' }
async function post(body: unknown) {
  const request = new Request(`http://localhost/api/teams/${teamName}/tasks/1/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return handleTeamsApi(request, new URL(request.url), ['api', 'teams', teamName, 'tasks', '1', 'delivery'])
}
async function submitV1() {
  asMember('builder')
  const result = await TaskUpdateTool.call({ taskId: '1', deliveryAction: submit }, context)
  expect(result.data.success).toBe(true)
  return result
}
async function returnV1Artifact() {
  await submitV1()
  asMember('reviewer')
  const result = await TaskUpdateTool.call({ taskId: '1', deliveryAction: returnV1 }, context)
  expect(result.data.success).toBe(true)
  return result
}
async function reviewPendingPlan(): Promise<void> {
  const plan = teamPlanRecordSchema.parse({
    schemaVersion: 1,
    planId: 'plan-1',
    sessionId: 'lead',
    teamName,
    incarnationId,
    revision: 1,
    state: 'review_pending',
    workDir: root,
    leaderRuntime: { providerId: 'fixture-provider', modelId: 'fixture-model' },
    members: [],
    tasks: [],
    createdAt: 1,
    updatedAt: 1,
  })
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
}

test('TaskUpdate deliveryAction submits and TaskGet exposes revision owner and artifact criteria', async () => {
  await submitV1()
  const detail = await TaskGetTool.call({ taskId: '1' }, context)
  expect(detail.data.task?.owner).toBe('builder')
  expect(detail.data.task?.delivery?.revision).toBe(1)
  const block = TaskGetTool.mapToolResultToToolResultBlockParam(detail.data, 'tool-get')
  expect(block.content).toContain('artifact@v1')
  expect(block.content).toContain('Regression passed')
  expect((await TaskUpdateTool.call({ taskId: '1', status: 'completed' }, context)).data.success).toBe(false)
  expect((await TaskUpdateTool.call({ taskId: '1', deliveryAction: { action: 'accept', expectedRevision: 1, version: 1, requestId: 'self' } }, context)).data.success).toBe(false)
  asMember('reviewer')
  expect((await TaskUpdateTool.call({ taskId: '1', deliveryAction: acceptV1 }, context)).data.success).toBe(true)
  expect((await getTask(teamName, '1'))?.status).toBe('completed')
})

test('delivery actions reject mixed edits and missing team without mutating', async () => {
  asMember('builder')
  const mixed = await TaskUpdateTool.call({ taskId: '1', subject: 'Bypass', deliveryAction: submit }, context)
  expect(mixed.data.error).toContain('separate')
  expect((await getTask(teamName, '1'))?.subject).toBe('Deliver')
  clearDynamicTeamContext()
  const noTeamContext = { setAppState: () => {}, getAppState: () => ({}) } as unknown as ToolUseContext
  expect((await TaskUpdateTool.call({ taskId: '1', deliveryAction: submit }, noTeamContext)).data.success).toBe(false)
})

test('REST review validates identity action reason and idempotent replay through the real task store', async () => {
  await submitV1()
  const identity = { leadSessionId: 'lead', incarnationId }
  const action = { action: 'return', expectedRevision: 1, version: 1, requestId: 'return', reason: 'Add boundary regression' }
  expect((await post({ ...identity, deliveryAction: { ...action, reason: '' } })).status).toBe(400)
  expect((await post({ ...identity, leadSessionId: 'stale', deliveryAction: action })).status).toBe(409)
  expect((await post({ ...identity, deliveryAction: submit })).status).toBe(400)
  expect((await post({ ...identity, deliveryAction: action })).status).toBe(200)
  const replay = await post({ ...identity, deliveryAction: action })
  expect(replay.status).toBe(200)
  expect((await replay.json()).updated).toBe(false)
  const stored = await getTask(teamName, '1')
  expect(stored?.delivery?.submissions[0]?.review).toMatchObject({ decision: 'return', reviewer: 'user', reason: action.reason })
  expect((await post({ ...identity, deliveryAction: { ...action, requestId: 'another' } })).status).toBe(409)
})

test('shutdown cleanup releases a delivery owner without throwing and keeps the pending review', async () => {
  await submitV1()
  const plain = await createTask(teamName, {
    subject: 'Plain shutdown work', description: '', owner: 'builder', status: 'in_progress', blocks: [], blockedBy: [],
  })

  // Before the fix this threw from the delivery guard, aborting the whole
  // shutdown cleanup, so the plain task below was never released either.
  const result = await unassignTeammateTasks(teamName, 'builder@delivery-tools', 'builder', 'shutdown')
  expect(result.unassignedTasks.map(task => task.id).sort()).toEqual(['1', plain].sort())
  expect(result.notificationMessage).toContain('#1 stay in progress')

  const task = await storedTask()
  expect(task?.owner).toBeUndefined()
  expect(task?.status).toBe('in_progress')
  expect(task?.delivery?.revision).toBe(1)
  expect(task?.delivery?.submissions).toHaveLength(1)
  expect(task?.delivery?.submissions[0]?.review).toBeUndefined()
  expect((await storedTask(plain))?.status).toBe('pending')

  // The review still belongs to the submitted version and can finish.
  asMember('reviewer')
  expect((await TaskUpdateTool.call({ taskId: '1', deliveryAction: acceptV1 }, context)).data.success).toBe(true)
})

test('shutdown cleanup returns a returned artifact to the pending rework pool', async () => {
  await returnV1Artifact()

  const result = await unassignTeammateTasks(teamName, 'builder@delivery-tools', 'builder', 'shutdown')
  expect(result.unassignedTasks).toEqual([{ id: '1', subject: 'Deliver' }])
  expect(result.notificationMessage).toContain('1 task(s) were unassigned')

  const task = await storedTask()
  expect(task?.owner).toBeUndefined()
  expect(task?.status).toBe('pending')
  expect(task?.delivery?.submissions[0]?.review?.decision).toBe('return')
})

test('rework after a return can be reassigned to a new owner without rewriting delivery', async () => {
  await returnV1Artifact()
  asMember('reviewer')
  const beforeReassign = await storedTask()
  expect(beforeReassign?.delivery?.revision).toBe(2)

  const reassigned = await TaskUpdateTool.call({ taskId: '1', owner: 'reworker' }, context)
  expect(reassigned.data.success).toBe(true)
  expect(reassigned.data.updatedFields).toContain('owner')
  const afterReassign = await storedTask()
  expect(afterReassign?.owner).toBe('reworker')
  expect(afterReassign?.status).toBe('in_progress')
  expect(afterReassign?.delivery).toMatchObject({
    revision: 2,
    submissions: [{ version: 1, owner: 'builder', review: { decision: 'return', reviewer: 'reviewer' } }],
  })

  // Generic completion stays forbidden for a delivery task.
  asMember('reworker')
  const generic = await TaskUpdateTool.call({ taskId: '1', status: 'completed' }, context)
  expect(generic.data.success).toBe(false)
  expect((await storedTask())?.status).toBe('in_progress')

  // The new owner can submit the next version under the delivery protocol.
  const resubmitted = await TaskUpdateTool.call({
    taskId: '1',
    deliveryAction: { action: 'submit', expectedRevision: 2, version: 2, artifact: 'artifact@v2 digest:fixture-2', criteria: 'Boundary regression added', requestId: 'submit-2' },
  }, context)
  expect(resubmitted.data.success).toBe(true)

  asMember('reviewer')
  expect((await TaskUpdateTool.call({
    taskId: '1',
    deliveryAction: { action: 'accept', expectedRevision: 3, version: 2, requestId: 'accept-2' },
  }, context)).data.success).toBe(true)
  expect((await storedTask())?.status).toBe('completed')

  // An accepted artifact cannot be reopened by reassigning the owner.
  const reopened = await TaskUpdateTool.call({ taskId: '1', owner: 'builder' }, context)
  expect(reopened.data.success).toBe(false)
  expect((await storedTask())?.owner).toBe('reworker')
})

test('reassignment while an artifact awaits independent review is refused', async () => {
  await submitV1()
  asMember('reviewer')

  const attempt = await TaskUpdateTool.call({ taskId: '1', owner: 'reworker' }, context)
  expect(attempt.data.success).toBe(false)
  expect(attempt.data.error).toContain('awaiting independent review')
  expect((await storedTask())?.owner).toBe('builder')
  expect((await storedTask())?.delivery?.submissions[0]?.review).toBeUndefined()
})

test('rework reassignment still requires plan approval for the new owner', async () => {
  await returnV1Artifact()
  await reviewPendingPlan()
  asMember('reviewer')

  const attempt = await TaskUpdateTool.call({ taskId: '1', owner: 'reworker' }, context)
  expect(attempt.data.success).toBe(false)
  expect(attempt.data.error).toContain('awaiting human review')
  expect((await storedTask())?.owner).toBe('builder')
})

test('a returned delivery task is claimable once through the existing atomic claim guard', async () => {
  await returnV1Artifact()
  await unassignTeammateTasks(teamName, 'builder@delivery-tools', 'builder', 'shutdown')
  expect((await storedTask())?.status).toBe('pending')

  const first = await claimTask(teamName, '1', 'reworker', { checkAgentBusy: true, markInProgress: true })
  expect(first.success).toBe(true)
  const racing = await claimTask(teamName, '1', 'builder', { checkAgentBusy: true, markInProgress: true })
  expect(racing).toMatchObject({ success: false, reason: 'already_claimed' })

  const claimed = await storedTask()
  expect(claimed?.owner).toBe('reworker')
  expect(claimed?.status).toBe('in_progress')
  expect(claimed?.delivery?.submissions).toHaveLength(1)
})

test('both claim paths refuse an artifact left unowned while awaiting independent review', async () => {
  await submitV1()
  await unassignTeammateTasks(teamName, 'builder@delivery-tools', 'builder', 'shutdown')
  const before = await storedTask()
  expect(before?.owner).toBeUndefined()
  expect(before?.status).toBe('in_progress')
  const revisionBefore = (await readTaskListSnapshot(teamName)).revision

  // The released task still carries a submission nobody has reviewed, so a
  // cheap owner write here would hand the artifact to a new owner before the
  // reviewer judged it, bypassing the TaskUpdate reassignment guard.
  for (const options of [{}, { checkAgentBusy: true, markInProgress: true }]) {
    const result = await claimTask(teamName, '1', 'reworker', options)
    expect(result).toMatchObject({ success: false, reason: 'blocked' })
  }

  const after = await storedTask()
  expect(after?.owner).toBeUndefined()
  expect(after?.status).toBe('in_progress')
  expect(after?.delivery?.submissions).toHaveLength(1)
  expect(after?.delivery?.submissions[0]?.review).toBeUndefined()
  expect((await readTaskListSnapshot(teamName)).revision).toBe(revisionBefore)
})

test('an idempotent claim by the artifact owner stays a no-op while awaiting review', async () => {
  await submitV1()
  const revisionBefore = (await readTaskListSnapshot(teamName)).revision

  for (const options of [{}, { checkAgentBusy: true, markInProgress: true }]) {
    const result = await claimTask(teamName, '1', 'builder', options)
    expect(result.success).toBe(true)
    expect(result.task).toMatchObject({ owner: 'builder', status: 'in_progress' })
  }

  expect((await readTaskListSnapshot(teamName)).revision).toBe(revisionBefore)
  expect((await storedTask())?.delivery?.submissions[0]?.review).toBeUndefined()
})

test('claiming rework after a return keeps the artifact history on both paths', async () => {
  await returnV1Artifact()
  await unassignTeammateTasks(teamName, 'builder@delivery-tools', 'builder', 'shutdown')
  expect((await storedTask())?.status).toBe('pending')

  const cases = [
    // The legacy path only assigns an owner; the caller marks it started.
    { options: {}, status: 'pending' as const },
    { options: { checkAgentBusy: true, markInProgress: true }, status: 'in_progress' as const },
  ]
  for (const { options, status } of cases) {
    const result = await claimTask(teamName, '1', 'reworker', options)
    expect(result.success).toBe(true)
    const claimed = await storedTask()
    expect(claimed).toMatchObject({ owner: 'reworker', status })
    expect(claimed?.delivery?.submissions).toHaveLength(1)
    expect(claimed?.delivery?.submissions[0]?.review).toMatchObject({
      decision: 'return',
      reviewer: 'reviewer',
    })

    // Reset to the released rework state so the second path sees the same input.
    await unassignTeammateTasks(teamName, 'reworker@delivery-tools', 'reworker', 'shutdown')
    expect((await storedTask())?.status).toBe('pending')
  }
})

test('a cancelled REST acceptance leaves the artifact awaiting review', async () => {
  asMember('builder')
  await TaskUpdateTool.call({ taskId: '1', deliveryAction: submit }, context)
  const controller = new AbortController()
  controller.abort()
  const request = new Request(`http://localhost/api/teams/${teamName}/tasks/1/delivery`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leadSessionId: 'lead', incarnationId, deliveryAction: { action: 'accept', expectedRevision: 1, version: 1, requestId: 'cancelled-rest' } }),
  })
  const response = await handleTeamsApi(request, new URL(request.url), ['api', 'teams', teamName, 'tasks', '1', 'delivery'])
  expect(response.status).toBe(409)
  expect((await getTask(teamName, '1'))?.status).toBe('in_progress')
  expect((await getTask(teamName, '1'))?.delivery?.submissions[0]?.review).toBeUndefined()
})

test('both claim paths refuse a dangling dependency instead of treating it as complete', async () => {
  await writeFile(join(root, 'tasks', teamName, '5.json'), JSON.stringify({
    id: '5', subject: 'Waits on a vanished task', description: '', status: 'pending', owner: undefined, blocks: [], blockedBy: ['404'],
  }))

  for (const options of [{}, { checkAgentBusy: true, markInProgress: true }]) {
    const result = await claimTask(teamName, '5', 'reworker', options)
    expect(result).toMatchObject({ success: false, reason: 'blocked', blockedByTasks: ['404'] })
  }

  const stored = await storedTask('5')
  expect(stored?.owner).toBeUndefined()
  expect(stored?.status).toBe('pending')
})

test('a real unfinished blocker still blocks a claim', async () => {
  const blocker = await createTask(teamName, {
    subject: 'Still running', description: '', status: 'in_progress', owner: 'builder', blocks: [], blockedBy: [],
  })
  await writeFile(join(root, 'tasks', teamName, '6.json'), JSON.stringify({
    id: '6', subject: 'Waits on running work', description: '', status: 'pending', owner: undefined, blocks: [], blockedBy: [blocker],
  }))

  for (const options of [{}, { checkAgentBusy: true, markInProgress: true }]) {
    const result = await claimTask(teamName, '6', 'reworker', options)
    expect(result).toMatchObject({ success: false, reason: 'blocked', blockedByTasks: [blocker] })
  }
  expect((await storedTask('6'))?.owner).toBeUndefined()
})

test('both claim paths refuse a delivery record this build cannot read', async () => {
  await writeFile(join(root, 'tasks', teamName, '9.json'), JSON.stringify({
    id: '9', subject: 'Future schema', description: '', status: 'in_progress', owner: undefined, blocks: [], blockedBy: [],
    delivery: { schemaVersion: 2, revision: 3, submissions: [], receipts: [], notices: [] },
  }))
  const before = await storedTask('9')
  expect(before?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
  const revisionBefore = (await readTaskListSnapshot(teamName)).revision

  // The delivery record cannot be judged, so an owner write here would hand
  // the task over without knowing whether a review is outstanding. The claim
  // must say it is blocked rather than reporting the task as missing.
  for (const options of [{}, { checkAgentBusy: true, markInProgress: true }]) {
    const result = await claimTask(teamName, '9', 'reworker', options)
    expect(result).toMatchObject({ success: false, reason: 'blocked' })
  }

  const after = await storedTask('9')
  expect(after?.owner).toBeUndefined()
  expect(after?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
  expect((await readTaskListSnapshot(teamName)).revision).toBe(revisionBefore)
})

test('the tool prompt states that delivery tasks are never deleted and completion is not a review', async () => {
  expect(PROMPT).toContain('cannot be deleted')
  expect(PROMPT).toContain('not a substitute for independent review')
})

test('deleting a task with artifact history is refused and keeps dependency edges intact', async () => {
  await submitV1()
  const dependent = await createTask(teamName, {
    subject: 'Depends on the delivery', description: '', status: 'pending', blocks: [], blockedBy: ['1'],
  })
  asMember('builder')

  const attempt = await TaskUpdateTool.call({ taskId: '1', status: 'deleted' }, context)
  expect(attempt.data.success).toBe(false)
  expect(attempt.data.error).toContain('cannot be deleted')
  await expect(deleteTaskWithCommit(teamName, '1')).rejects.toThrow('cannot be deleted')

  expect(await storedTask()).toBeTruthy()
  expect((await storedTask())?.delivery?.submissions).toHaveLength(1)
  expect((await storedTask(dependent))?.blockedBy).toEqual(['1'])
})

test('deleting a task whose delivery record is unsupported is refused', async () => {
  await writeFile(join(root, 'tasks', teamName, '9.json'), JSON.stringify({
    id: '9', subject: 'Future schema', description: '', status: 'in_progress', owner: 'builder', blocks: [], blockedBy: [],
    delivery: { schemaVersion: 2, revision: 3, submissions: [], receipts: [], notices: [] },
  }))
  expect((await storedTask('9'))?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
  await expect(deleteTaskWithCommit(teamName, '9')).rejects.toThrow(TASK_DELIVERY_UNSUPPORTED_ERROR)
  expect((await storedTask('9'))?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
})

test('TaskCreate failure cleanup can still delete a task without artifact history', async () => {
  createdHookBlock = 'fixture rejected the task'
  const before = (await listTasks(teamName)).map(task => task.id)
  await expect(TaskCreateTool.call({ subject: 'Cleanup target', description: 'Must not survive' }, context))
    .rejects.toThrow('TaskCreated hook feedback')
  const after = await listTasks(teamName)
  expect(after.map(task => task.id).sort()).toEqual(before.sort())
  await expect(readFile(join(root, 'tasks', teamName, '2.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('an ordinary completion that is already aborted does not commit', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortedContext = { ...context, abortController: controller } as unknown as ToolUseContext

  const result = await TaskUpdateTool.call({ taskId: '1', status: 'completed' }, abortedContext)
  expect(result.data.success).toBe(false)
  expect(result.data.error).toContain('cancel')
  expect(completedHookRuns).toBe(0)
  expect((await storedTask())?.status).toBe('in_progress')
})

test('an ordinary completion aborted inside its TaskCompleted hook does not commit', async () => {
  const controller = new AbortController()
  const abortedContext = { ...context, abortController: controller } as unknown as ToolUseContext
  onCompletedHook = () => controller.abort()

  const result = await TaskUpdateTool.call({ taskId: '1', status: 'completed' }, abortedContext)
  expect(result.data.success).toBe(false)
  expect(result.data.error).toContain('cancel')
  expect(completedHookRuns).toBe(1)
  expect((await storedTask())?.status).toBe('in_progress')
})

test('an ordinary completion aborted while waiting for the task lock never commits', async () => {
  const taskPath = join(root, 'tasks', teamName, '1.json')
  const releaseTaskLock = await lockfile.lock(taskPath)
  let released = false
  const release = async () => {
    if (released) return
    released = true
    await releaseTaskLock()
  }
  const controller = new AbortController()
  const abortedContext = { ...context, abortController: controller } as unknown as ToolUseContext

  try {
    const completion = TaskUpdateTool.call({ taskId: '1', status: 'completed' }, abortedContext)
    // The hooks have run; the tool is now blocked inside the atomic update's
    // lock wait. Aborting here exercises the pre-commit check, not the hook one.
    await Bun.sleep(100)
    controller.abort()
    expect((await getTask(teamName, '1'))?.status).toBe('in_progress')

    await release()
    const result = await completion
    expect(result.data.success).toBe(false)
    expect(result.data.error).toContain('cancel')
    expect((await storedTask())?.status).toBe('in_progress')
  } finally {
    await release()
  }
})

/**
 * Writes a task fixture straight to disk. Only `lockedUpdates` should go
 * through the store: these writers deliberately bypass the cooperative locks,
 * which is how a concurrent or out-of-band writer reopens a dependency in the
 * middle of another call.
 */
const writeTaskFile = (id: string, task: Record<string, unknown>) =>
  writeFileSync(
    join(root, 'tasks', teamName, `${id}.json`),
    JSON.stringify({ description: '', owner: undefined, blocks: [], blockedBy: [], ...task, id }),
  )

test('a teammate cannot advance a task whose dependency is missing from the list', async () => {
  writeTaskFile('5', { subject: 'Waits on a vanished task', status: 'pending', owner: 'builder', blockedBy: ['404'] })
  asMember('builder')
  const revisionBefore = (await readTaskListSnapshot(teamName)).revision

  // A dependency that is not in the list is not evidence of finished work, so
  // the missing file must read as unfinished instead of disappearing from the
  // unresolved set.
  for (const status of ['in_progress', 'completed'] as const) {
    const refused = await TaskUpdateTool.call({ taskId: '5', status }, context)
    expect(refused.data.success).toBe(false)
    expect(refused.data.error).toContain('Task #5 waits on #404')
  }

  expect((await storedTask('5'))?.status).toBe('pending')
  expect((await readTaskListSnapshot(teamName)).revision).toBe(revisionBefore)
})

test('a blocker reopened inside the TaskCompleted hook cannot be completed over', async () => {
  const blocker = await createTask(teamName, {
    subject: 'Prerequisite', description: '', status: 'completed', owner: 'builder', blocks: [], blockedBy: [],
  })
  writeTaskFile('1', { subject: 'Deliver', status: 'in_progress', owner: 'builder', blockedBy: [blocker] })
  asMember('builder')

  // The member precheck runs before the completion hooks, so a hook that
  // reopens the prerequisite defeats it. Only a recheck inside the transaction
  // can still see the reopened dependency.
  onCompletedHook = () => writeTaskFile(blocker, { subject: 'Prerequisite', status: 'in_progress', owner: 'builder' })

  const result = await TaskUpdateTool.call({ taskId: '1', status: 'completed' }, context)
  expect(result.data.success).toBe(false)
  expect(result.data.error).toContain(`Task #1 waits on #${blocker}`)
  expect(completedHookRuns).toBe(1)
  expect((await storedTask())?.status).toBe('in_progress')
})

test('a blocker reopened while the completion waits for the task lock cannot be committed', async () => {
  const blocker = await createTask(teamName, {
    subject: 'Prerequisite', description: '', status: 'completed', owner: 'builder', blocks: [], blockedBy: [],
  })
  const taskPath = join(root, 'tasks', teamName, '1.json')
  writeTaskFile('1', { subject: 'Deliver', status: 'in_progress', owner: 'builder', blockedBy: [blocker] })
  asMember('builder')

  const releaseTaskLock = await lockfile.lock(taskPath)
  let released = false
  const release = async () => {
    if (released) return
    released = true
    await releaseTaskLock()
  }

  try {
    const completion = TaskUpdateTool.call({ taskId: '1', status: 'completed' }, context)
    // The precheck and the completion hook have finished; this call is queued
    // on the task file lock. Reopening the dependency now is only observable
    // by the recheck inside the transaction.
    await Bun.sleep(100)
    writeTaskFile(blocker, { subject: 'Prerequisite', status: 'in_progress', owner: 'builder' })

    await release()
    const result = await completion
    expect(result.data.success).toBe(false)
    expect(result.data.error).toContain(`Task #1 waits on #${blocker}`)
    expect((await storedTask())?.status).toBe('in_progress')
  } finally {
    await release()
  }
})

test('a teammate cannot complete a task while adding an unfinished dependency', async () => {
  const blocker = await createTask(teamName, {
    subject: 'Still running', description: '', status: 'pending', owner: 'builder', blocks: [], blockedBy: [],
  })
  asMember('builder')

  // The precheck only knows the edges the task already had; a dependency
  // declared in the same call is part of the transaction's dependency set.
  const refused = await TaskUpdateTool.call({ taskId: '1', status: 'completed', addBlockedBy: [blocker] }, context)
  expect(refused.data.success).toBe(false)
  expect(refused.data.error).toContain(`Task #1 waits on #${blocker}`)

  const stored = await storedTask()
  expect(stored?.status).toBe('in_progress')
  expect(stored?.blockedBy).toEqual([])
  expect((await storedTask(blocker))?.blocks).toEqual([])
})

test('the lead is exempt from the dependency recheck that holds members', async () => {
  writeTaskFile('5', { subject: 'Waits on a vanished task', status: 'pending', owner: 'builder', blockedBy: ['404'] })

  // No dynamic teammate context: this is the lead's main thread, which
  // coordinates and may decide a dependency no longer matters.
  const result = await TaskUpdateTool.call({ taskId: '5', status: 'in_progress' }, context)
  expect(result.data.success).toBe(true)
  expect((await storedTask('5'))?.status).toBe('in_progress')
})