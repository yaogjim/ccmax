import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  emptyTaskDelivery,
  TASK_DELIVERY_UNSUPPORTED_ERROR,
  type TaskDelivery,
} from '../../shared/taskDelivery.js'
import { TeamService } from './teamService.js'

const TEAM = 'delivery-projection-team'

let configDir: string
let originalConfigDir: string | undefined
let service: TeamService

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmax-team-delivery-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const teamDir = path.join(configDir, 'teams', TEAM)
  await fs.mkdir(teamDir, { recursive: true })
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: TEAM,
      createdAt: 1700000000000,
      leadAgentId: `team-lead@${TEAM}`,
      members: ['team-lead', 'builder'].map(name => ({
        agentId: `${name}@${TEAM}`,
        name,
        joinedAt: 1700000000000,
        tmuxPaneId: '',
        cwd: configDir,
        isActive: true,
      })),
    }),
  )
  await fs.mkdir(path.join(configDir, 'tasks', TEAM), { recursive: true })
  service = new TeamService()
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

async function writeTask(id: string, record: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(configDir, 'tasks', TEAM, `${id}.json`),
    JSON.stringify({
      id,
      subject: `Task ${id}`,
      description: '',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      ...record,
    }),
  )
}

function supportedDelivery(artifact: string): TaskDelivery {
  return {
    schemaVersion: 1,
    revision: 1,
    submissions: [
      { version: 1, artifact, criteria: 'criteria', owner: 'builder', submittedAt: 1 },
    ],
    receipts: [],
    notices: [],
  }
}

describe('TeamService delivery projection', () => {
  test('sends an unreadable history as a read-only reason, never the raw record', async () => {
    await writeTask('1', {
      status: 'completed',
      delivery: {
        schemaVersion: 2,
        revision: 5,
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

    const snapshot = await service.getWorkbench(TEAM)
    const task = snapshot.tasks.find(candidate => candidate.id === '1')

    expect(task?.deliveryError).toBe(TASK_DELIVERY_UNSUPPORTED_ERROR)
    expect(task?.delivery).toEqual(emptyTaskDelivery())
    // Without the acceptance its history cannot prove, the status fails closed.
    expect(task?.status).toBe('in_progress')
    // The desktop would try to render the raw record as history, so it must not
    // travel at all -- not in the task, and not inside the snapshot payload.
    expect('deliveryUnsupported' in task!).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('raw-unsupported-payload')
    expect(JSON.stringify(snapshot)).not.toContain('hidden-artifact')
  })

  test('leaves a supported delivery readable and accepted', async () => {
    await writeTask('2', { status: 'completed', delivery: supportedDelivery('artifact-v1') })

    const snapshot = await service.getWorkbench(TEAM)
    const task = snapshot.tasks.find(candidate => candidate.id === '2')

    expect(task?.deliveryError).toBeUndefined()
    expect(task?.delivery?.submissions[0]?.artifact).toBe('artifact-v1')
    expect(task?.status).toBe('completed')
    expect(JSON.stringify(snapshot)).not.toContain('deliveryUnsupported')
  })
})