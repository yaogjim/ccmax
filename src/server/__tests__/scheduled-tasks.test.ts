/**
 * Unit tests for CronService, SearchService, and Scheduled Tasks API
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { CronService, type CronTask } from '../services/cronService.js'
import { SearchService } from '../services/searchService.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ─── CronService tests ─────────────────────────────────────────────────────

describe('CronService', () => {
  let service: CronService

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should return empty list when no tasks file exists', async () => {
    const tasks = await service.listTasks()
    expect(tasks).toEqual([])
  })

  it('should create a task with generated id and createdAt', async () => {
    const task = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'Review commits',
      recurring: true,
    })

    expect(task.id).toBeDefined()
    expect(task.id).toHaveLength(8) // 4 bytes hex
    expect(task.cron).toBe('0 9 * * *')
    expect(task.prompt).toBe('Review commits')
    expect(task.recurring).toBe(true)
    expect(task.createdAt).toBeGreaterThan(0)
  })

  it('should persist tasks to file', async () => {
    await service.createTask({ cron: '0 9 * * *', prompt: 'Task 1' })
    await service.createTask({ cron: '30 18 * * 5', prompt: 'Task 2' })

    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].prompt).toBe('Task 1')
    expect(tasks[1].prompt).toBe('Task 2')
  })

  it('should update an existing task', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'Original prompt',
    })

    const updated = await service.updateTask(created.id, {
      prompt: 'Updated prompt',
      recurring: true,
    })

    expect(updated.id).toBe(created.id)
    expect(updated.prompt).toBe('Updated prompt')
    expect(updated.recurring).toBe(true)
    expect(updated.createdAt).toBe(created.createdAt)
  })

  it('should throw when updating a non-existent task', async () => {
    await expect(
      service.updateTask('nonexistent', { prompt: 'x' }),
    ).rejects.toThrow('Task not found')
  })

  it('should delete a task', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'To delete',
    })

    await service.deleteTask(created.id)
    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(0)
  })

  it('should throw when deleting a non-existent task', async () => {
    await expect(service.deleteTask('nonexistent')).rejects.toThrow(
      'Task not found',
    )
  })

  it('should generate unique IDs', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const task = await service.createTask({
        cron: '* * * * *',
        prompt: `Task ${i}`,
      })
      ids.add(task.id)
    }
    expect(ids.size).toBe(20)
  })

  it('should reject create when cron or prompt is missing', async () => {
    await expect(
      service.createTask({ cron: '', prompt: 'something' }),
    ).rejects.toThrow()

    await expect(
      service.createTask({ cron: '* * * * *', prompt: '' }),
    ).rejects.toThrow()
  })

  it('should retry the atomic write when rename returns ENOENT', async () => {
    const originalRename = fs.rename
    let renameCalls = 0

    const renameSpy = spyOn(fs, 'rename')
    renameSpy.mockImplementation(async (...args) => {
      renameCalls += 1

      if (renameCalls === 1) {
        const error = new Error(
          'ENOENT: no such file or directory, rename tmp -> scheduled_tasks.json',
        ) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }

      return originalRename(...args)
    })

    try {
      const task = await service.createTask({
        cron: '0 9 * * *',
        prompt: 'Retry rename once',
      })

      const tasks = await service.listTasks()
      expect(task.id).toBeDefined()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.prompt).toBe('Retry rename once')
      expect(renameCalls).toBe(2)
    } finally {
      renameSpy.mockRestore()
    }
  })
})

// ─── CronService: enabled default & persistence ────────────────────────────
//
// The desktop UI treats `enabled: true` as "on" (NewTaskModal always sends
// `enabled: true` on create), and TaskList counts enabled tasks with a plain
// truthiness check. A task persisted without the flag — or with it missing
// after a restart — must therefore read back as enabled, not disabled.

describe('CronService enabled semantics', () => {
  let service: CronService
  let tasksFilePath: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    tasksFilePath = path.join(tmpDir, 'scheduled_tasks.json')
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('defaults enabled to true when createTask omits it', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'omitted enabled',
    })

    expect(created.enabled).not.toBe(false)
    expect(created.enabled).toBe(true)

    // And it is actually persisted, not synthesized by listTasks().
    const onDisk = JSON.parse(await fs.readFile(tasksFilePath, 'utf-8')) as {
      tasks: Array<{ enabled?: boolean }>
    }
    expect(onDisk.tasks[0]?.enabled).toBe(true)
  })

  it('keeps an explicit enabled:true on create', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'explicit true',
      enabled: true,
    })
    expect(created.enabled).toBe(true)
  })

  it('treats a legacy task with no enabled field as enabled when listing', async () => {
    await fs.writeFile(
      tasksFilePath,
      JSON.stringify(
        {
          tasks: [
            {
              id: 'legacy-1',
              cron: '0 9 * * *',
              prompt: 'legacy without enabled',
              createdAt: Date.now(),
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )

    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].enabled).not.toBe(false)
    expect(tasks[0].enabled).toBe(true)
  })

  it('preserves an explicit enabled:false across a restart (new service instance)', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'disabled on purpose',
      enabled: false,
    })
    expect(created.enabled).toBe(false)

    // Simulate a process restart: a fresh CronService reads the same file.
    const afterRestart = new CronService()
    const tasks = await afterRestart.listTasks()
    const reloaded = tasks.find((t) => t.id === created.id)
    expect(reloaded?.enabled).toBe(false)
  })

  it('does not let enabled:false read back as enabled via listTasks', async () => {
    await service.createTask({
      cron: '0 9 * * *',
      prompt: 'a',
      enabled: false,
    })
    const tasks = await service.listTasks()
    expect(tasks[0].enabled).toBe(false)
  })
})

// ─── CronService: invalid cron validation ──────────────────────────────────

describe('CronService cron validation', () => {
  let service: CronService

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('rejects a create with a malformed cron expression', async () => {
    await expect(
      service.createTask({ cron: 'not a cron', prompt: 'x' }),
    ).rejects.toThrow()
    // Rejection must not have written the bad task.
    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(0)
  })

  it('rejects a create whose cron has the wrong number of fields', async () => {
    await expect(
      service.createTask({ cron: '* * *', prompt: 'x' }),
    ).rejects.toThrow()
  })

  it('rejects a create whose cron field is out of range', async () => {
    await expect(
      service.createTask({ cron: '99 9 * * *', prompt: 'x' }),
    ).rejects.toThrow()
  })

  it('rejects an update that sets a malformed cron', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'valid',
    })
    await expect(
      service.updateTask(created.id, { cron: 'bogus' }),
    ).rejects.toThrow()

    // The original expression must survive the rejected update.
    const tasks = await service.listTasks()
    expect(tasks[0]?.cron).toBe('0 9 * * *')
  })

  it('still accepts a valid cron on create', async () => {
    const created = await service.createTask({
      cron: '*/5 8-18 * * 1-5',
      prompt: 'valid',
    })
    expect(created.cron).toBe('*/5 8-18 * * 1-5')
  })
})

// ─── CronService: concurrent read-modify-write ─────────────────────────────
//
// Every mutating method is read → mutate → write. Two CronService instances
// (e.g. the API handler and the scheduler) mutating the same file at the same
// time used to lose one another's writes. They must share a lock so no
// creation/update/delete is silently dropped.

describe('CronService concurrent mutations', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('does not lose tasks when many creates race across service instances', async () => {
    const services = Array.from({ length: 4 }, () => new CronService())
    const count = 24

    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        services[i % services.length]!.createTask({
          cron: '* * * * *',
          prompt: `concurrent ${i}`,
        }),
      ),
    )

    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'scheduled_tasks.json'), 'utf-8'),
    ) as { tasks: Array<{ prompt: string }> }
    expect(persisted.tasks).toHaveLength(count)
    expect(new Set(persisted.tasks.map((t) => t.prompt)).size).toBe(count)
  })

  it('does not lose an enable/disable update when racing a create', async () => {
    const writer = new CronService()
    const updater = new CronService()
    const created = await writer.createTask({
      cron: '0 9 * * *',
      prompt: 'toggle target',
      recurring: true,
    })

    await Promise.all([
      updater.updateTask(created.id, { enabled: false }),
      writer.createTask({ cron: '0 10 * * *', prompt: 'racing create' }),
    ])

    const tasks = await writer.listTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.find((t) => t.id === created.id)?.enabled).toBe(false)
    expect(tasks.some((t) => t.prompt === 'racing create')).toBe(true)
  })
})

// ─── SearchService tests ────────────────────────────────────────────────────

describe('SearchService', () => {
  let service: SearchService
  let searchDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new SearchService()

    // 创建搜索用的临时文件
    searchDir = path.join(tmpDir, 'workspace')
    await fs.mkdir(searchDir, { recursive: true })
    await fs.writeFile(
      path.join(searchDir, 'hello.txt'),
      'Hello World\nThis is a test\nAnother line\n',
    )
    await fs.writeFile(
      path.join(searchDir, 'code.ts'),
      'function greet() {\n  return "hello"\n}\n',
    )
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should find matches in workspace files', async () => {
    const results = await service.searchWorkspace('Hello', { cwd: searchDir })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('Hello')
  })

  it('should return empty results when nothing matches', async () => {
    const results = await service.searchWorkspace('ZZZZNONEXISTENT', {
      cwd: searchDir,
    })
    expect(results).toHaveLength(0)
  })

  it('should respect maxResults limit', async () => {
    // 写入多行匹配
    const lines = Array.from({ length: 50 }, (_, i) => `match line ${i}`).join(
      '\n',
    )
    await fs.writeFile(path.join(searchDir, 'many.txt'), lines)

    const results = await service.searchWorkspace('match', {
      cwd: searchDir,
      maxResults: 5,
    })
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('should reject empty query', async () => {
    await expect(service.searchWorkspace('')).rejects.toThrow()
  })

  it('should return empty session results when no projects dir exists', async () => {
    const { results } = await service.searchSessions('test')
    expect(results).toEqual([])
  })
})

// ─── Scheduled Tasks API integration ────────────────────────────────────────

describe('Scheduled Tasks API', () => {
  // 直接测试 handler 函数，不需要启动完整服务器
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    // 动态导入以获取最新的环境变量
    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should list empty tasks via GET', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
    ])
    const body = (await resp.json()) as { tasks: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.tasks).toEqual([])
  })

  it('should create a task via POST', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cron: '0 9 * * *',
        prompt: 'Daily review',
        recurring: true,
        model: 'provider-fast',
        providerId: 'provider-a',
      }),
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
    ])
    const body = (await resp.json()) as {
      task: { id: string; prompt: string; model?: string; providerId?: string }
    }
    expect(resp.status).toBe(201)
    expect(body.task.id).toBeDefined()
    expect(body.task.prompt).toBe('Daily review')
    expect(body.task.model).toBe('provider-fast')
    expect(body.task.providerId).toBe('provider-a')
  })

  it('should CRUD a full lifecycle', async () => {
    // Create
    const createReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *', prompt: 'Test task' }),
    })
    const createResp = await handleScheduledTasksApi(
      createReq,
      new URL(createReq.url),
      ['api', 'scheduled-tasks'],
    )
    const { task } = (await createResp.json()) as {
      task: { id: string; prompt: string }
    }

    // Update
    const updateReq = new Request(
      `http://localhost/api/scheduled-tasks/${task.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Updated task' }),
      },
    )
    const updateResp = await handleScheduledTasksApi(
      updateReq,
      new URL(updateReq.url),
      ['api', 'scheduled-tasks', task.id],
    )
    const updated = (await updateResp.json()) as {
      task: { id: string; prompt: string }
    }
    expect(updated.task.prompt).toBe('Updated task')

    // Delete
    const deleteReq = new Request(
      `http://localhost/api/scheduled-tasks/${task.id}`,
      { method: 'DELETE' },
    )
    const deleteResp = await handleScheduledTasksApi(
      deleteReq,
      new URL(deleteReq.url),
      ['api', 'scheduled-tasks', task.id],
    )
    expect(deleteResp.status).toBe(200)

    // Verify empty
    const listReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const listResp = await handleScheduledTasksApi(
      listReq,
      new URL(listReq.url),
      ['api', 'scheduled-tasks'],
    )
    const list = (await listResp.json()) as { tasks: unknown[] }
    expect(list.tasks).toHaveLength(0)
  })

  it('defaults created tasks to enabled via POST', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *', prompt: 'no enabled field' }),
    })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
    ])
    const body = (await resp.json()) as { task: { enabled?: boolean } }
    expect(resp.status).toBe(201)
    expect(body.task.enabled).toBe(true)
  })

  it('returns 400 when POST is given an invalid cron', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: 'not a cron', prompt: 'bad' }),
    })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
    ])
    expect(resp.status).toBe(400)

    // And nothing was persisted.
    const listReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const listResp = await handleScheduledTasksApi(
      listReq,
      new URL(listReq.url),
      ['api', 'scheduled-tasks'],
    )
    const list = (await listResp.json()) as { tasks: unknown[] }
    expect(list.tasks).toHaveLength(0)
  })

  it('returns 400 when PUT sets an invalid cron and keeps the original', async () => {
    const createReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *', prompt: 'keep me' }),
    })
    const createResp = await handleScheduledTasksApi(
      createReq,
      new URL(createReq.url),
      ['api', 'scheduled-tasks'],
    )
    const { task } = (await createResp.json()) as { task: { id: string } }

    const updateReq = new Request(
      `http://localhost/api/scheduled-tasks/${task.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron: '99 99 * * *' }),
      },
    )
    const updateResp = await handleScheduledTasksApi(
      updateReq,
      new URL(updateReq.url),
      ['api', 'scheduled-tasks', task.id],
    )
    expect(updateResp.status).toBe(400)

    const listReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const listResp = await handleScheduledTasksApi(
      listReq,
      new URL(listReq.url),
      ['api', 'scheduled-tasks'],
    )
    const list = (await listResp.json()) as { tasks: Array<{ cron: string }> }
    expect(list.tasks[0]?.cron).toBe('0 9 * * *')
  })
})

// ─── CronService: notification shape & recipient validation ─────────────────
//
// Turning on a non-desktop channel requires naming exactly one recipient, and
// that recipient must resolve to exactly one paired account. The server must
// reject arbitrary ids, duplicates, and channel/recipient mismatches, and must
// never treat `allowedUsers` (an access allowlist) as a notification target.

describe('CronService notification validation', () => {
  let service: CronService
  let adaptersPath: string

  async function writeAdapters(telegramPairedUsers: unknown[]): Promise<void> {
    await fs.writeFile(
      adaptersPath,
      JSON.stringify({
        telegram: {
          botToken: 'fixture-token',
          // An access allowlist entry that is intentionally NOT paired.
          allowedUsers: [999],
          pairedUsers: telegramPairedUsers,
        },
        feishu: {
          appId: 'cli_fixture',
          appSecret: 'fixture-secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Fei One', pairedAt: 1 }],
        },
      }),
      'utf-8',
    )
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    adaptersPath = path.join(tmpDir, 'adapters.json')
    await writeAdapters([{ userId: 111, displayName: 'Alice', pairedAt: 1 }])
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('rejects an enabled telegram channel with no explicit recipient', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'no target',
        notification: { enabled: true, channels: ['telegram'] },
      }),
    ).rejects.toThrow(/recipient/i)

    expect(await service.listTasks()).toHaveLength(0)
  })

  it('rejects an arbitrary id that is only in allowedUsers, never paired', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'allowlist is not a target',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [999] },
        },
      }),
    ).rejects.toThrow(/paired/i)

    expect(await service.listTasks()).toHaveLength(0)
  })

  it('rejects an ambiguous display-name recipient', async () => {
    await writeAdapters([
      { userId: 111, displayName: 'Alice', pairedAt: 1 },
      { userId: 222, displayName: 'Alice', pairedAt: 1 },
    ])

    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'ambiguous',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [{ displayName: 'Alice' }] },
        },
      }),
    ).rejects.toThrow(/multiple|ambiguous/i)
  })

  it('rejects more than one recipient for an enabled channel', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'two targets',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [111, { userId: 111 }] },
        },
      }),
    ).rejects.toThrow(/exactly one/i)
  })

  it('rejects a duplicate channel entry', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'duplicate channel',
        notification: {
          enabled: true,
          channels: ['telegram', 'telegram'],
          recipients: { telegram: [111] },
        },
      } as CronTask),
    ).rejects.toThrow(/duplicate/i)
  })

  it('rejects an unknown channel', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'unknown channel',
        notification: {
          enabled: true,
          channels: ['sms'],
          recipients: { sms: ['x'] },
        },
      } as unknown as CronTask),
    ).rejects.toThrow(/unknown channel/i)
  })

  it('rejects a malformed recipient object', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'malformed recipient',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [{ evil: true }] },
        },
      } as unknown as CronTask),
    ).rejects.toThrow(/recipient/i)
  })

  it('rejects recipients for a channel that is not enabled', async () => {
    await expect(
      service.createTask({
        cron: '0 9 * * *',
        prompt: 'mixed up',
        notification: {
          enabled: true,
          channels: ['desktop'],
          recipients: { telegram: [111] },
        },
      }),
    ).rejects.toThrow(/not enabled/i)
  })

  it('accepts a single verified recipient and persists it unchanged', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'verified target',
      recurring: true,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    expect(created.notification).toEqual({
      enabled: true,
      channels: ['telegram'],
      recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
    })

    const reloaded = await new CronService().listTasks()
    expect(reloaded[0]?.notification).toEqual(created.notification)
  })

  it('accepts a desktop-only notification without any recipient', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'desktop only',
      notification: { enabled: true, channels: ['desktop'] },
    })
    expect(created.notification).toEqual({ enabled: true, channels: ['desktop'] })
  })

  it('rejects an invalid notification on update and keeps the original config', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'keep notification',
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    await expect(
      service.updateTask(created.id, {
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [999] },
        },
      }),
    ).rejects.toThrow(/paired/i)

    const reloaded = await service.listTasks()
    expect(reloaded[0]?.notification).toEqual(created.notification)
  })
})

// ─── CronService: legacy notification read-back ─────────────────────────────
//
// Files written before `recipients` existed must keep loading. A channel that
// is on but has no usable recipient is surfaced as "needs recipients" (a
// read-time marker, never written back) and the delivery service refuses to
// broadcast it.

describe('CronService legacy notification read-back', () => {
  let service: CronService
  let tasksFilePath: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    tasksFilePath = path.join(tmpDir, 'scheduled_tasks.json')
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  async function writeLegacyTask(notification: unknown): Promise<void> {
    await fs.writeFile(
      tasksFilePath,
      JSON.stringify(
        {
          tasks: [
            {
              id: 'legacy-im',
              cron: '0 9 * * *',
              prompt: 'legacy notification',
              createdAt: Date.now(),
              notification,
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )
  }

  it('marks an old enabled channel without recipients as needing a recipient', async () => {
    await writeLegacyTask({ enabled: true, channels: ['telegram'] })

    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.notificationNeedsRecipients).toBe(true)
    // The old config is preserved verbatim; no recipient is invented.
    expect(tasks[0]?.notification).toEqual({ enabled: true, channels: ['telegram'] })
    // And the derived marker is never written to disk.
    const onDisk = JSON.parse(await fs.readFile(tasksFilePath, 'utf-8')) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(onDisk.tasks[0]?.notificationNeedsRecipients).toBeUndefined()
  })

  it('does not mark a desktop-only notification as needing a recipient', async () => {
    await writeLegacyTask({ enabled: true, channels: ['desktop'] })

    const tasks = await service.listTasks()
    expect(tasks[0]?.notificationNeedsRecipients).toBeUndefined()
  })

  it('does not mark a legacy channel that already has a recipient', async () => {
    await writeLegacyTask({
      enabled: true,
      channels: ['telegram'],
      recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
    })

    const tasks = await service.listTasks()
    expect(tasks[0]?.notificationNeedsRecipients).toBeUndefined()
  })
})

// ─── Scheduled Tasks API: notification validation ───────────────────────────

describe('Scheduled Tasks API notification validation', () => {
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({
        telegram: {
          botToken: 'fixture-token',
          pairedUsers: [{ userId: 111, displayName: 'Alice', pairedAt: 1 }],
        },
      }),
      'utf-8',
    )

    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('returns 400 when an enabled telegram channel has no recipient', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cron: '0 9 * * *',
        prompt: 'no target',
        notification: { enabled: true, channels: ['telegram'] },
      }),
    })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
    ])
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { message: string }
    expect(body.message).toMatch(/recipient/i)

    const listReq = new Request('http://localhost/api/scheduled-tasks', { method: 'GET' })
    const listResp = await handleScheduledTasksApi(listReq, new URL(listReq.url), [
      'api',
      'scheduled-tasks',
    ])
    expect(((await listResp.json()) as { tasks: unknown[] }).tasks).toHaveLength(0)
  })

  it('returns 400 when the recipient is not a paired user', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cron: '0 9 * * *',
        prompt: 'unknown target',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [999] },
        },
      }),
    })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
    ])
    expect(resp.status).toBe(400)
  })

  it('creates a task with a verified recipient', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cron: '0 9 * * *',
        prompt: 'verified target',
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
        },
      }),
    })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
    ])
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as { task: { notification: unknown } }
    expect(body.task.notification).toEqual({
      enabled: true,
      channels: ['telegram'],
      recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
    })
  })
})

// ─── Scheduled Tasks API: manual run visibility ─────────────────────────────
//
// POST /:id/run used to sleep a fixed 200 ms and hope `appendRun` had written
// the "running" record. If the scheduler's pre-spawn work took longer, the
// response reported success while no run existed yet, so an immediate poll
// could not see it. The handler must wait for the run record to land instead of
// guessing.

describe('Scheduled Tasks API manual run', () => {
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>
  const originalCliPath = process.env.CLAUDE_CLI_PATH
  const originalDisableShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
  const originalLocalIndex = process.env.CC_HAHA_LOCAL_INDEX

  async function createFakeCli(dir: string): Promise<string> {
    const cliPath = path.join(dir, 'fake-manual-run-cli.ts')
    await fs.writeFile(
      cliPath,
      [
        "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'manual run done' }] } }))",
        "console.log(JSON.stringify({ type: 'result', result: 'manual run done' }))",
      ].join('\n') + '\n',
      'utf-8',
    )
    return cliPath
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'

    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalCliPath) process.env.CLAUDE_CLI_PATH = originalCliPath
    else delete process.env.CLAUDE_CLI_PATH
    if (originalDisableShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndex) process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndex
    else delete process.env.CC_HAHA_LOCAL_INDEX
    await cleanupTmpDir(tmpDir)
  })

  it('does not report success before the running record is on disk', async () => {
    const created = await new CronService().createTask({
      cron: '* * * * *',
      prompt: 'manual run visibility',
      recurring: true,
    })

    // Force the pre-spawn work (lastFiredAt write) to take longer than the old
    // fixed 200 ms window, so a guess-based response would race ahead of the
    // "running" record.
    const originalUpdate = CronService.prototype.updateLastFired
    const updateSpy = spyOn(CronService.prototype, 'updateLastFired').mockImplementation(
      async function (this: CronService, ...args: Parameters<typeof originalUpdate>) {
        await Bun.sleep(500)
        return originalUpdate.apply(this, args)
      },
    )

    try {
      const req = new Request(
        `http://localhost/api/scheduled-tasks/${created.id}/run`,
        { method: 'POST' },
      )
      const resp = await handleScheduledTasksApi(req, new URL(req.url), [
        'api',
        'scheduled-tasks',
        created.id,
        'run',
      ])
      expect(resp.status).toBe(200)

      const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
      const log = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
        runs: Array<{ taskId: string; status: string }>
      }
      expect(log.runs.some((run) => run.taskId === created.id)).toBe(true)
    } finally {
      updateSpy.mockRestore()
    }

    // Let the background execution settle so the temp directory can be removed.
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    for (let attempt = 0; attempt < 200; attempt++) {
      const log = await fs
        .readFile(logPath, 'utf-8')
        .then((raw) => JSON.parse(raw) as { runs: Array<{ taskId: string; status: string }> })
        .catch(() => ({ runs: [] as Array<{ taskId: string; status: string }> }))
      const mine = log.runs.filter((run) => run.taskId === created.id)
      if (mine.length > 0 && mine.every((run) => run.status !== 'running')) break
      await Bun.sleep(10)
    }
  })
})

// ─── Scheduled Tasks API: run delivery records ──────────────────────────────
//
// The desktop "run detail" view needs to answer "was the Telegram message
// actually sent, and if not why". The route reads the same delivery journal the
// notification service writes, scoped to one run, and 404s an unknown run so an
// empty list is never confused with "the run delivered nothing".

describe('Scheduled Tasks API run deliveries', () => {
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  async function writeRunLog(runs: unknown[]): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, 'scheduled_tasks_log.json'),
      JSON.stringify({ runs }, null, 2) + '\n',
      'utf-8',
    )
  }

  async function writeDeliveries(records: unknown[]): Promise<void> {
    const dir = path.join(tmpDir, 'ccmax')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'notification-deliveries.json'),
      JSON.stringify({ schemaVersion: 1, records }, null, 2) + '\n',
      'utf-8',
    )
  }

  function deliveryRecord(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      schemaVersion: 1,
      deliveryId: 'd-1',
      runId: 'run-1',
      taskId: 'task-1',
      channel: 'telegram',
      recipientId: '111',
      recipientDisplayName: 'Alice',
      outcome: 'delivered',
      attempts: 1,
      createdAt: '2026-09-26T00:00:00.000Z',
      ...overrides,
    }
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('returns only the deliveries of the requested run', async () => {
    await writeRunLog([
      { id: 'run-1', taskId: 'task-1', taskName: 'Nightly', startedAt: '2026-09-26T00:00:00.000Z', status: 'completed', prompt: 'x' },
    ])
    await writeDeliveries([
      deliveryRecord({ deliveryId: 'd-1', runId: 'run-1', createdAt: '2026-09-26T00:00:01.000Z' }),
      deliveryRecord({ deliveryId: 'd-2', runId: 'other-run', outcome: 'failed', errorCode: 'http_error' }),
    ])

    const req = new Request('http://localhost/api/scheduled-tasks/runs/run-1/deliveries', { method: 'GET' })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
      'runs',
      'run-1',
      'deliveries',
    ])

    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      runId: string
      deliveries: Array<{ deliveryId: string; outcome: string }>
    }
    expect(body.runId).toBe('run-1')
    expect(body.deliveries).toHaveLength(1)
    expect(body.deliveries[0]!.deliveryId).toBe('d-1')
    expect(body.deliveries[0]!.outcome).toBe('delivered')
  })

  it('reports a failed delivery with its reason instead of an empty success', async () => {
    await writeRunLog([
      { id: 'run-2', taskId: 'task-1', taskName: 'Nightly', startedAt: '2026-09-26T00:00:00.000Z', status: 'failed', prompt: 'x' },
    ])
    await writeDeliveries([
      deliveryRecord({
        deliveryId: 'd-9',
        runId: 'run-2',
        outcome: 'failed',
        errorCode: 'recipient_not_verified',
        error: '收件人未在 …配对记录中登记',
      }),
    ])

    const req = new Request('http://localhost/api/scheduled-tasks/runs/run-2/deliveries', { method: 'GET' })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
      'runs',
      'run-2',
      'deliveries',
    ])
    const body = (await resp.json()) as {
      deliveries: Array<{ outcome: string; errorCode?: string }>
    }
    expect(resp.status).toBe(200)
    expect(body.deliveries[0]!.outcome).toBe('failed')
    expect(body.deliveries[0]!.errorCode).toBe('recipient_not_verified')
  })

  it('returns 404 for an unknown run', async () => {
    await writeRunLog([])
    await writeDeliveries([deliveryRecord({})])

    const req = new Request('http://localhost/api/scheduled-tasks/runs/missing/deliveries', { method: 'GET' })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
      'runs',
      'missing',
      'deliveries',
    ])
    expect(resp.status).toBe(404)
  })

  it('still serves the run detail route without a deliveries suffix', async () => {
    await writeRunLog([
      { id: 'run-1', taskId: 'task-1', taskName: 'Nightly', startedAt: '2026-09-26T00:00:00.000Z', status: 'completed', prompt: 'x' },
    ])

    const req = new Request('http://localhost/api/scheduled-tasks/runs/run-1', { method: 'GET' })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
      'runs',
      'run-1',
    ])
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { run: { id: string } }
    expect(body.run.id).toBe('run-1')
  })

  it('returns an empty list for a run that attempted no deliveries', async () => {
    await writeRunLog([
      { id: 'run-3', taskId: 'task-1', taskName: 'Nightly', startedAt: '2026-09-26T00:00:00.000Z', status: 'completed', prompt: 'x' },
    ])
    await writeDeliveries([deliveryRecord({ runId: 'other-run' })])

    const req = new Request('http://localhost/api/scheduled-tasks/runs/run-3/deliveries', { method: 'GET' })
    const resp = await handleScheduledTasksApi(req, new URL(req.url), [
      'api',
      'scheduled-tasks',
      'runs',
      'run-3',
      'deliveries',
    ])
    const body = (await resp.json()) as { deliveries: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.deliveries).toEqual([])
  })
})
