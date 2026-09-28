/**
 * Integration test: the tool mutates real scheduled-task state through the
 * desktop's actual `/api/scheduled-tasks` handler, authenticated with the same
 * internal bearer token the desktop injects.
 *
 * Everything is loopback + temporary HOME/CLAUDE_CONFIG_DIR. No model, no real
 * desktop server, no network beyond 127.0.0.1.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { handleApiRequest } from '../../server/router.js'
import { requireAuth } from '../../server/middleware/auth.js'
import { CronService } from '../../server/services/cronService.js'
import { DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV } from './client.js'
import { LocalScheduledTaskTool } from './LocalScheduledTaskTool.js'

const FIXTURE_TOKEN = 'fixture-internal-token'

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
}

let tmpDir: string
let server: ReturnType<typeof Bun.serve> | null = null
const originalEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-scheduled-task-'))
  for (const key of ['CLAUDE_CONFIG_DIR', 'HOME', DESKTOP_SERVER_URL_ENV, LOCAL_ACCESS_TOKEN_ENV] as const) {
    originalEnv[key] = process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const authError = await requireAuth(request)
      if (authError) return authError
      const url = new URL(request.url)
      return handleApiRequest(request, url)
    },
  })
  process.env[DESKTOP_SERVER_URL_ENV] = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  server?.stop(true)
  server = null
  for (const key of Object.keys(originalEnv)) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function readTasksFile(): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(tmpDir, 'scheduled_tasks.json'), 'utf-8')
  return (JSON.parse(raw) as { tasks: Array<Record<string, unknown>> }).tasks
}

describe('LocalScheduledTask against the real scheduled-task API', () => {
  test('rejects the request without the internal bearer token', async () => {
    const response = await fetch(`${process.env[DESKTOP_SERVER_URL_ENV]}/api/scheduled-tasks`)
    expect(response.status).toBe(401)
  })

  test('creates, lists, disables, enables, and deletes a real persisted task', async () => {
    const created = await LocalScheduledTaskTool.call(
      {
        action: 'create',
        cron: '30 9 * * 1-5',
        prompt: 'Summarize the nightly deploy',
        name: 'Deploy digest',
        notification: { enabled: true, channels: ['desktop'] },
      },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )

    const taskId = created.data.task?.id
    expect(taskId).toBeString()

    // Persisted to the real task file, visible to the desktop's own service.
    const persisted = await readTasksFile()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.prompt).toBe('Summarize the nightly deploy')
    expect(persisted[0]!.enabled).toBe(true)
    expect(persisted[0]!.notification).toEqual({ enabled: true, channels: ['desktop'] })

    const desktopView = await new CronService().listTasks()
    expect(desktopView.map(task => task.id)).toEqual([taskId!])

    // list sees it
    const listed = await LocalScheduledTaskTool.call(
      { action: 'list' },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(listed.data.tasks?.map(task => task.id)).toEqual([taskId!])
    expect(listed.data.tasks?.[0]!.nextRunAt).toBeString()

    // get sees it
    const got = await LocalScheduledTaskTool.call(
      { action: 'get', id: taskId! },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(got.data.task?.id).toBe(taskId!)

    // disable → persisted as explicitly disabled
    await LocalScheduledTaskTool.call(
      { action: 'disable', id: taskId! },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect((await readTasksFile())[0]!.enabled).toBe(false)

    // enable → back on
    await LocalScheduledTaskTool.call(
      { action: 'enable', id: taskId! },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect((await readTasksFile())[0]!.enabled).toBe(true)

    // delete → gone
    await LocalScheduledTaskTool.call(
      { action: 'delete', id: taskId! },
      makeToolUseContext(),
      undefined as never,
      undefined as never,
    )
    expect(await readTasksFile()).toHaveLength(0)
  })

  test('does not create a task when the server rejects an invalid cron', async () => {
    let message = ''
    try {
      await LocalScheduledTaskTool.call(
        { action: 'create', cron: '99 99 * * *', prompt: 'bad' },
        makeToolUseContext(),
        undefined as never,
        undefined as never,
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message.length).toBeGreaterThan(0)
    // Nothing was persisted.
    const tasksPath = path.join(tmpDir, 'scheduled_tasks.json')
    const exists = await fs
      .access(tasksPath)
      .then(() => true)
      .catch(() => false)
    if (exists) expect(JSON.parse(await fs.readFile(tasksPath, 'utf-8')).tasks).toEqual([])
  })

  test('an unknown task id fails without creating anything', async () => {
    let message = ''
    try {
      await LocalScheduledTaskTool.call(
        { action: 'delete', id: 'deadbeef' },
        makeToolUseContext(),
        undefined as never,
        undefined as never,
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('deadbeef')
  })
})