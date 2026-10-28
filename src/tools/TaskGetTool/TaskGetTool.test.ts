import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import {
  emptyTaskDelivery,
  TASK_DELIVERY_UNSUPPORTED_ERROR,
} from '../../shared/taskDelivery.js'
import { TaskGetTool } from './TaskGetTool.js'

const TASK_LIST = 'task-get-delivery'
const context = {
  setAppState: () => {},
  getAppState: () => ({}),
} as unknown as ToolUseContext

let root: string
let saved: NodeJS.ProcessEnv

beforeEach(async () => {
  saved = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'ccmax-task-get-'))
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.CLAUDE_CODE_TASK_LIST_ID = TASK_LIST
  await mkdir(join(root, 'tasks', TASK_LIST), { recursive: true })
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(root, { recursive: true, force: true })
})

async function writeTask(task: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(root, 'tasks', TASK_LIST, `${String(task.id)}.json`),
    JSON.stringify({
      subject: 'Ship the artifact',
      description: 'Deliver it for independent review.',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      ...task,
    }),
  )
}

test('reports an unreadable delivery history as read-only instead of an empty one', async () => {
  await writeTask({
    id: '1',
    status: 'completed',
    delivery: {
      schemaVersion: 2,
      revision: 9,
      futureField: 'raw-unsupported-payload',
      submissions: [
        {
          version: 1,
          artifact: 'hidden-artifact',
          criteria: 'hidden-criteria',
          owner: 'builder',
          submittedAt: 1,
        },
      ],
      receipts: [],
      notices: [],
    },
  })

  const detail = await TaskGetTool.call({ taskId: '1' }, context)
  const task = detail.data.task!

  expect(task.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
  expect(task.delivery).toEqual(emptyTaskDelivery())
  // A `completed` status cannot claim an acceptance this server cannot read.
  expect(task.status).toBe('in_progress')
  expect(TaskGetTool.outputSchema.parse(detail.data)).toEqual(detail.data)
  // The raw record stays in the task store; neither shape may carry it.
  expect('deliveryUnsupported' in task).toBe(false)
  expect(JSON.stringify(detail.data)).not.toContain('raw-unsupported-payload')
  expect(JSON.stringify(detail.data)).not.toContain('hidden-artifact')

  const block = TaskGetTool.mapToolResultToToolResultBlockParam(detail.data, 'tool-get')
  expect(block.content).toContain('Delivery: read-only')
  expect(block.content).toContain(TASK_DELIVERY_UNSUPPORTED_ERROR)
  // The protocol's empty history would read as "nothing submitted yet".
  expect(block.content).not.toContain('"submissions"')
})

test('reports a damaged delivery record with the same read-only reason', async () => {
  await writeTask({
    id: '2',
    delivery: { schemaVersion: 1, revision: 'not-a-revision' },
  })

  const detail = await TaskGetTool.call({ taskId: '2' }, context)

  expect(detail.data.task?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
  expect(detail.data.task?.delivery).toEqual(emptyTaskDelivery())
})

test('keeps a supported delivery readable and writes no read-only reason', async () => {
  await writeTask({
    id: '3',
    delivery: {
      schemaVersion: 1,
      revision: 1,
      submissions: [
        {
          version: 1,
          artifact: 'artifact-v1',
          criteria: 'criteria-v1',
          owner: 'builder',
          submittedAt: 1,
        },
      ],
      receipts: [],
      notices: [],
    },
  })

  const detail = await TaskGetTool.call({ taskId: '3' }, context)

  expect(detail.data.task?.deliveryError).toBeUndefined()
  expect(detail.data.task?.delivery?.submissions[0]?.artifact).toBe('artifact-v1')

  const block = TaskGetTool.mapToolResultToToolResultBlockParam(detail.data, 'tool-get')
  expect(block.content).toContain('Delivery: {"schemaVersion":1')
  expect(block.content).toContain('artifact-v1')
  expect(block.content).not.toContain('read-only')
})