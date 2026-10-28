import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, getTask, listTasks, updateTask, updateTaskAtomically } from './tasks.js'
import { applyTaskDeliveryAction, flushTaskDeliveryNotices } from './taskDelivery.js'
import { getTeamDir, writeTeamFileAsync } from './swarm/teamHelpers.js'
import { ensureTeamDraft } from './swarm/teamPlanStore.js'
import { getInboxPath, readMailboxHistory, readUnreadMessages } from './teammateMailbox.js'
import { TaskService } from '../server/services/taskService.js'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { resetHooksConfigSnapshot, updateHooksConfigSnapshot } from './hooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import { isTaskAwaitingReview, taskDeliveryActionSchema } from '../shared/taskDelivery.js'

let root: string
let previous: string | undefined
let previousInteractive: boolean
beforeEach(async () => {
  previousInteractive = getIsInteractive()
  previous = process.env.CLAUDE_CONFIG_DIR
  root = await mkdtemp(join(tmpdir(), 'ccmax-delivery-'))
  process.env.CLAUDE_CONFIG_DIR = root
  await mkdir(join(root, 'tasks', 'delivery-list'), { recursive: true })
  await writeTeamFileAsync('delivery-list', { name: 'delivery-list', createdAt: 1, leadAgentId: 'team-lead@delivery-list', leadSessionId: 'lead', members: ['builder', 'reviewer'].map(name => ({ name, agentId: `${name}@delivery-list`, agentType: 'general-purpose', joinedAt: 1, tmuxPaneId: '', cwd: root, subscriptions: [] })) })
})
afterEach(async () => {
  setIsInteractive(previousInteractive)
  resetHooksConfigSnapshot()
  resetSettingsCache()
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  await rm(root, { recursive: true, force: true })
})
const fixture = { id: '1', subject: 'Build', description: 'Synthetic task', owner: 'builder', status: 'in_progress', blocks: [], blockedBy: [], futureField: { keep: true }, metadata: { future: 'keep' } }
const path = () => join(root, 'tasks', 'delivery-list', '1.json')
const taskPath = (id: string) => join(root, 'tasks', 'delivery-list', `${id}.json`)

test('migrates old fixture on read without inventing acceptance or rewriting original', async () => {
  const original = JSON.stringify({ ...fixture, status: 'completed' })
  await writeFile(path(), original)
  const task = await getTask('delivery-list', '1')
  expect(task?.delivery).toEqual({ schemaVersion: 1, revision: 0, submissions: [], receipts: [], notices: [] })
  expect(task?.status).toBe('completed')
  expect(await readFile(path(), 'utf8')).toBe(original)
  await updateTask('delivery-list', '1', { subject: 'Renamed' })
  const saved = JSON.parse(await readFile(path(), 'utf8'))
  expect(saved.futureField).toEqual({ keep: true })
  expect(saved.metadata).toEqual({ future: 'keep' })
  expect(saved.delivery.revision).toBe(0)
})

test('generic writes cannot bypass a pending independent artifact review', async () => {
  await writeFile(path(), JSON.stringify({ ...fixture, delivery: {
    schemaVersion: 1, revision: 1, submissions: [{ version: 1, artifact: 'build.txt', criteria: 'tests pass', owner: 'builder', submittedAt: 1 }], receipts: [], notices: [],
  } }))
  await expect(updateTask('delivery-list', '1', { status: 'completed' })).rejects.toThrow('review')
  expect((await getTask('delivery-list', '1'))?.status).toBe('in_progress')
})

const submit = { action: 'submit' as const, requestId: 'submit-1', expectedRevision: 0, version: 1, artifact: 'build.txt sha256:fixture-v1', criteria: 'Tests pass and output matches specification' }
const act = (actor: string, action: Parameters<typeof applyTaskDeliveryAction>[3]) => applyTaskDeliveryAction('delivery-list', '1', actor, action)

test('delivery return rework acceptance is independent versioned idempotent and survives reload', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  const first = await act('builder', submit)
  expect(first.task.status).toBe('in_progress')
  expect(isTaskAwaitingReview(first.task)).toBe(true)
  expect((await readUnreadMessages('team-lead', 'delivery-list'))).toHaveLength(1)
  const replay = await act('builder', submit)
  expect(replay.updated).toBe(false)
  expect((await readUnreadMessages('team-lead', 'delivery-list'))).toHaveLength(1)
  await expect(act('builder', { action: 'accept', requestId: 'self-review', expectedRevision: 1, version: 1 })).rejects.toThrow('independent')
  const returned = await act('reviewer', { action: 'return', requestId: 'return-1', expectedRevision: 1, version: 1, reason: 'Missing regression evidence' })
  expect(returned.task.status).toBe('in_progress')
  expect(isTaskAwaitingReview(returned.task)).toBe(false)
  expect((await readUnreadMessages('builder', 'delivery-list'))).toHaveLength(1)
  await expect(act('reviewer', { action: 'accept', requestId: 'repeat-review', expectedRevision: 2, version: 1 })).rejects.toThrow('already reviewed')
  await expect(act('builder', { ...submit, expectedRevision: 2, requestId: 'no-new-facts', version: 2 })).rejects.toThrow('new artifact facts')
  await act('builder', { ...submit, expectedRevision: 2, requestId: 'submit-2', version: 2, artifact: 'build.txt sha256:fixture-v2 plus regression' })
  const beforeAcceptance = await readMailboxHistory('builder', 'delivery-list')
  const accepted = await act('reviewer', { action: 'accept', requestId: 'accept-2', expectedRevision: 3, version: 2 })
  expect(accepted.task.status).toBe('completed')
  expect((await readMailboxHistory('builder', 'delivery-list'))).toEqual(beforeAcceptance)
  const reloaded = await getTask('delivery-list', '1')
  expect(reloaded?.delivery?.submissions).toHaveLength(2)
  expect(reloaded?.delivery?.submissions[0]?.review?.reason).toBe('Missing regression evidence')
  expect(reloaded?.delivery?.submissions[1]?.review?.reviewer).toBe('reviewer')
  expect((await new TaskService().getTask('delivery-list', '1'))?.delivery).toEqual(reloaded?.delivery)
  expect((await act('reviewer', { action: 'accept', requestId: 'accept-2', expectedRevision: 3, version: 2 })).updated).toBe(false)
})

test('concurrent acceptance and return commit exactly one review and stale versions cannot win', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  const outcomes = await Promise.allSettled([
    act('reviewer', { action: 'accept', requestId: 'race-accept', expectedRevision: 1, version: 1 }),
    act('team-lead', { action: 'return', requestId: 'race-return', expectedRevision: 1, version: 1, reason: 'Needs work' }),
  ])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect((await getTask('delivery-list', '1'))?.delivery?.revision).toBe(2)
  await expect(act('user', { action: 'accept', requestId: 'stale-version', expectedRevision: 2, version: 3 })).rejects.toThrow('version changed')
})

test('durable notice retry deduplicates by mailbox envelope and does not create a protocol reply', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  const saved = JSON.parse(await readFile(path(), 'utf8'))
  saved.delivery.notices[0].delivered = false // simulate crash after mailbox write, before receipt commit
  await writeFile(path(), JSON.stringify(saved))
  await flushTaskDeliveryNotices('delivery-list')
  await flushTaskDeliveryNotices('delivery-list')
  expect((await readMailboxHistory('team-lead', 'delivery-list'))).toHaveLength(1)
  expect((await getTask('delivery-list', '1'))?.delivery?.notices[0]?.delivered).toBe(true)
})

test('authorization identity invalid inputs and request reuse fail without changing task', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await expect(act('outsider', submit)).rejects.toThrow('not a team member')
  await expect(act('reviewer', submit)).rejects.toThrow('Only the task owner')
  expect(taskDeliveryActionSchema.safeParse({ action: 'return', requestId: 'empty', expectedRevision: 1, version: 1, reason: ' ' }).success).toBe(false)
  await expect(applyTaskDeliveryAction('delivery-list', '1', 'user', { action: 'accept', requestId: 'old-team', expectedRevision: 0, version: 1 }, { leadSessionId: 'old', incarnationId: 'old' })).rejects.toThrow('identity changed')
  await act('builder', submit)
  await expect(act('builder', { ...submit, artifact: 'different' })).rejects.toThrow('different delivery action')
  await expect(updateTask('delivery-list', '1', { delivery: undefined, owner: 'reviewer' })).rejects.toThrow('review')
  expect((await getTask('delivery-list', '1'))?.delivery?.revision).toBe(1)
})

const futureDelivery = { schemaVersion: 2, revision: 4, submissions: [], receipts: [], notices: [], futureTop: { keep: true } }

test('future or damaged delivery keeps the task visible read-only and never satisfies a dependency', async () => {
  const original = JSON.stringify({ ...fixture, status: 'completed', delivery: futureDelivery })
  await writeFile(path(), original)
  const task = await getTask('delivery-list', '1')
  expect(task).not.toBeNull()
  expect(task?.status).toBe('in_progress')
  expect(task?.delivery).toEqual({ schemaVersion: 1, revision: 0, submissions: [], receipts: [], notices: [] })
  expect(task?.deliveryUnsupported).toEqual(futureDelivery)
  expect(task?.deliveryError).toContain('read-only')
  expect((await listTasks('delivery-list')).map(item => item.id)).toEqual(['1'])
  await expect(updateTask('delivery-list', '1', { subject: 'Rewrite' })).rejects.toThrow('read-only')
  expect(await readFile(path(), 'utf8')).toBe(original)

  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', owner: 'reviewer', blockedBy: ['1'] }))
  await expect(applyTaskDeliveryAction('delivery-list', '2', 'reviewer', { ...submit, requestId: 'blocked-by-future' })).rejects.toThrow('dependencies')
})

test('damaged nested delivery preserves the raw record and refuses writes', async () => {
  const damaged = { schemaVersion: 1, revision: 2, submissions: [{ version: 1, artifact: '', criteria: 'c', owner: 'builder', submittedAt: 1 }], receipts: [], notices: [] }
  const original = JSON.stringify({ ...fixture, delivery: damaged })
  await writeFile(path(), original)
  const task = await getTask('delivery-list', '1')
  expect(task?.deliveryUnsupported).toEqual(damaged)
  expect(task?.status).toBe('in_progress')
  await expect(updateTaskAtomically('delivery-list', '1', () => ({ subject: 'Rewrite' }))).rejects.toThrow('read-only')
  await expect(act('builder', submit)).rejects.toThrow('read-only')
  expect(await readFile(path(), 'utf8')).toBe(original)
})

test('submit requires every dependency to exist and be completed', async () => {
  await writeFile(path(), JSON.stringify({ ...fixture, blockedBy: ['2'] }))
  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', owner: 'reviewer', status: 'pending' }))
  await expect(act('builder', submit)).rejects.toThrow('dependencies')
  await writeFile(path(), JSON.stringify({ ...fixture, blockedBy: ['99'] }))
  await expect(act('builder', submit)).rejects.toThrow('dependencies')
  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', owner: 'reviewer', status: 'completed' }))
  await writeFile(path(), JSON.stringify({ ...fixture, blockedBy: ['2'] }))
  expect((await act('builder', submit)).task.status).toBe('in_progress')
})

test('nested delivery extensions survive an ordinary rewrite', async () => {
  await writeFile(path(), JSON.stringify({ ...fixture, delivery: {
    schemaVersion: 1, revision: 1, receipts: [], notices: [], futureTop: [1, 2],
    submissions: [{ version: 1, artifact: 'build.txt', criteria: 'tests pass', owner: 'builder', submittedAt: 1, futureSubmission: { nested: true }, review: { decision: 'return', reviewer: 'reviewer', reviewedAt: 2, futureReview: 'keep' } }],
  } }))
  await updateTask('delivery-list', '1', { subject: 'Renamed' })
  const saved = JSON.parse(await readFile(path(), 'utf8'))
  expect(saved.delivery.futureTop).toEqual([1, 2])
  expect(saved.delivery.submissions[0].futureSubmission).toEqual({ nested: true })
  expect(saved.delivery.submissions[0].review.futureReview).toBe('keep')
})

test('created tasks persist the default delivery shape', async () => {
  const id = await createTask('delivery-list', { subject: 'New', description: 'Synthetic', status: 'pending', blocks: [], blockedBy: [] })
  const saved = JSON.parse(await readFile(taskPath(id), 'utf8'))
  expect(saved.delivery).toEqual({ schemaVersion: 1, revision: 0, submissions: [], receipts: [], notices: [] })
  expect(saved.owner).toBeUndefined()
})

test('failed mailbox writes keep notices pending for retry and departed recipients are skipped', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  const saved = JSON.parse(await readFile(path(), 'utf8'))
  const noticeId = saved.delivery.notices[0].id
  saved.delivery.notices[0].delivered = false
  saved.delivery.notices.push({ id: 'delivery-ghost', recipient: 'ghost', text: 'go', delivered: false })
  await writeFile(path(), JSON.stringify(saved))

  const inbox = getInboxPath('team-lead', 'delivery-list')
  await rename(inbox, `${inbox}.bak`)
  await mkdir(inbox)
  await flushTaskDeliveryNotices('delivery-list')
  let pending = await getTask('delivery-list', '1')
  expect(pending?.delivery?.notices.find(notice => notice.id === noticeId)?.delivered).toBe(false)
  expect(pending?.delivery?.notices.find(notice => notice.id === 'delivery-ghost')?.delivered).toBe(false)

  await rm(inbox, { recursive: true, force: true })
  await rename(`${inbox}.bak`, inbox)
  await flushTaskDeliveryNotices('delivery-list')
  pending = await getTask('delivery-list', '1')
  expect(pending?.delivery?.notices.find(notice => notice.id === noticeId)?.delivered).toBe(true)
  expect(pending?.delivery?.notices.find(notice => notice.id === 'delivery-ghost')?.delivered).toBe(false)
  expect(await readMailboxHistory('team-lead', 'delivery-list')).toHaveLength(1)
  await expect(readFile(getInboxPath('ghost', 'delivery-list'), 'utf8')).rejects.toThrow()
})

test('atomic guard refuses removals that would bypass or corrupt review state', async () => {
  await writeFile(path(), JSON.stringify({ ...fixture, delivery: {
    schemaVersion: 1, revision: 1, receipts: [], notices: [],
    submissions: [{ version: 1, artifact: 'build.txt', criteria: 'tests pass', owner: 'builder', submittedAt: 1 }],
  } }))
  await expect(updateTaskAtomically('delivery-list', '1', () => ({ owner: undefined }))).rejects.toThrow('review')
  await expect(updateTaskAtomically('delivery-list', '1', () => ({ status: undefined }))).rejects.toThrow('cannot be removed')
  await expect(updateTaskAtomically('delivery-list', '1', () => ({ delivery: undefined }))).rejects.toThrow('review')
  expect((await getTask('delivery-list', '1'))?.owner).toBe('builder')

  await writeFile(path(), JSON.stringify(fixture))
  await expect(updateTaskAtomically('delivery-list', '1', () => ({ status: undefined }))).rejects.toThrow('cannot be removed')
  expect((await updateTask('delivery-list', '1', { owner: undefined, status: 'pending' }))?.owner).toBeUndefined()
})

async function configureCompletionHook(command: string) {
  await writeFile(join(root, 'settings.json'), JSON.stringify({ hooks: { TaskCompleted: [{ matcher: '', hooks: [{ type: 'command', command }] }] } }))
  setIsInteractive(false)
  updateHooksConfigSnapshot()
}

const accept = { action: 'accept' as const, requestId: 'accept', expectedRevision: 1, version: 1 }

test('acceptance runs the completion hook and preserves pending review when it vetoes', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  await configureCompletionHook('echo delivery-veto >&2; exit 2')
  await expect(act('user', accept)).rejects.toThrow('delivery-veto')
  const task = await getTask('delivery-list', '1')
  expect(task?.status).toBe('in_progress')
  expect(task?.delivery?.revision).toBe(1)
  expect(task?.delivery?.submissions[0]?.review).toBeUndefined()
})

test('an already cancelled acceptance cannot skip a vetoing hook and commit', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  await configureCompletionHook('echo delivery-veto >&2; exit 2')
  const controller = new AbortController()
  controller.abort()
  await expect(applyTaskDeliveryAction('delivery-list', '1', 'reviewer', accept, undefined, { signal: controller.signal })).rejects.toThrow('cancelled')
  expect((await getTask('delivery-list', '1'))?.delivery?.revision).toBe(1)
  expect((await getTask('delivery-list', '1'))?.status).toBe('in_progress')
})

test('cancellation during a completion hook never commits an acceptance receipt', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  await act('builder', submit)
  const started = join(root, 'hook-started')
  const release = join(root, 'hook-release')
  await configureCompletionHook(`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.01; done`)
  const controller = new AbortController()
  const result = applyTaskDeliveryAction('delivery-list', '1', 'reviewer', accept, undefined, { signal: controller.signal }).then(
    () => ({ error: undefined }), error => ({ error }),
  )
  try {
    const deadline = Date.now() + 5000
    while (!await Bun.file(started).exists() && Date.now() < deadline) await Bun.sleep(10)
    expect(await Bun.file(started).exists()).toBe(true)
    controller.abort()
    expect(String((await result).error)).toContain('cancelled')
    const task = await getTask('delivery-list', '1')
    expect(task?.status).toBe('in_progress')
    expect(task?.delivery?.revision).toBe(1)
    expect(task?.delivery?.receipts).toHaveLength(1)
  } finally {
    controller.abort()
    await writeFile(release, '')
    await result
  }
}, 10_000)

test('acceptance rechecks dependencies after submission and refuses missing or reopened blockers', async () => {
  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', status: 'completed' }))
  await writeFile(path(), JSON.stringify({ ...fixture, blockedBy: ['2'] }))
  await act('builder', submit)
  await updateTask('delivery-list', '2', { status: 'in_progress' })
  await expect(act('reviewer', accept)).rejects.toThrow('dependencies')
  await rm(taskPath('2'))
  await expect(act('reviewer', accept)).rejects.toThrow('dependencies')
  expect((await getTask('delivery-list', '1'))?.delivery?.revision).toBe(1)
  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', status: 'completed' }))
  expect((await act('reviewer', accept)).task.status).toBe('completed')
})

const planMember = (name: string) => ({ id: name, name, agentType: 'general-purpose', prompt: `${name} work`, runtime: { providerId: 'test-provider', modelId: 'test-model' } })

test('a draft sub-plan review authorizes the task owner through the running parent plan', async () => {
  await writeFile(path(), JSON.stringify(fixture))
  const draft = await ensureTeamDraft('delivery-list', 'lead', { providerId: 'test-provider', modelId: 'test-model' })
  const parentPlanId = '11111111-1111-1111-1111-111111111111'
  const teamDir = getTeamDir('delivery-list')
  await writeFile(join(teamDir, `plan-${parentPlanId}.json`), JSON.stringify({
    ...draft, planId: parentPlanId, parentPlanId: undefined, revision: 2, state: 'running',
    members: [planMember('builder')],
    approvedSnapshot: { revision: 1, members: [planMember('builder')], tasks: [], leaderRuntime: { providerId: 'test-provider', modelId: 'test-model' }, approvedAt: 2, requestId: 'parent-approval' },
  }))
  await writeFile(join(teamDir, 'plan.json'), JSON.stringify({ ...draft, parentPlanId, revision: 2 }))
  // The owner submits under the running parent approval...
  expect((await act('builder', submit)).updated).toBe(true)
  // ...and the human review must resolve the owner, not skip parent backtracking.
  expect((await act('user', { action: 'accept', requestId: 'user-accept', expectedRevision: 1, version: 1 })).task.status).toBe('completed')

  await writeFile(taskPath('2'), JSON.stringify({ ...fixture, id: '2', owner: 'reviewer' }))
  await expect(applyTaskDeliveryAction('delivery-list', '2', 'user', { ...submit, requestId: 'unapproved-owner' })).rejects.toThrow('approval')
})