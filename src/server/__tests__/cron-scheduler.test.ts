/**
 * Tests for CronScheduler — cron matching, task execution, log storage, and API endpoints
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  cronMatches,
  extractAssistantText,
  fieldMatches,
  CronScheduler,
  type TaskRun,
} from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import * as lockfile from '../../utils/lockfile.js'
import { SettingsService } from '../services/settingsService.js'
import * as notificationService from '../services/notificationService.js'
import { resetScheduledRunReadModelForTests } from '../services/localIndex/scheduledRunReadModel.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH
const originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
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

async function createFakeCronCli(dir: string): Promise<string> {
  const cliPath = path.join(dir, 'fake-cron-cli.ts')
  await fs.writeFile(
    cliPath,
    [
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fake cron output' }] } }))",
      "console.log(JSON.stringify({ type: 'result', result: 'fake cron result' }))",
    ].join('\n') + '\n',
    'utf-8',
  )
  return cliPath
}

async function createBlockingFakeCronCli(dir: string): Promise<{
  cliPath: string
  readyPath: string
  releasePath: string
}> {
  const cliPath = path.join(dir, 'blocking-fake-cron-cli.ts')
  const readyPath = path.join(dir, 'blocking-fake-cron-cli.ready')
  const releasePath = path.join(dir, 'blocking-fake-cron-cli.release')
  await fs.writeFile(
    cliPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
      `while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(5)`,
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'blocking fake cron output' }] } }))",
      "console.log(JSON.stringify({ type: 'result', result: 'blocking fake cron result' }))",
    ].join('\n') + '\n',
    'utf-8',
  )
  return { cliPath, readyPath, releasePath }
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fs.stat(filePath).then(() => true).catch(() => false)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

/**
 * A fake paired-account config so tasks that turn on a non-desktop channel can
 * name a recipient that the server accepts. No real adapter state is touched.
 */
async function writeFakeAdapters(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'adapters.json'),
    JSON.stringify({
      telegram: {
        botToken: 'fixture-token',
        pairedUsers: [{ userId: 111, displayName: 'Alice', pairedAt: 1 }],
      },
    }),
    'utf-8',
  )
}

// ─── fieldMatches tests ────────────────────────────────────────────────────

describe('extractAssistantText', () => {
  it('does not duplicate the final assistant text repeated by the result event', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'X' }] } }),
      JSON.stringify({ type: 'result', result: 'X' }),
    ].join('\n')

    expect(extractAssistantText(raw)).toBe('X')
  })

  it('keeps a distinct result summary after assistant text', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'details' }] } }),
      JSON.stringify({ type: 'result', result: 'summary' }),
    ].join('\n')

    expect(extractAssistantText(raw)).toBe('details\n\nsummary')
  })
})

describe('fieldMatches', () => {
  it('should match wildcard', () => {
    expect(fieldMatches('*', 0)).toBe(true)
    expect(fieldMatches('*', 59)).toBe(true)
    expect(fieldMatches('*', 23)).toBe(true)
  })

  it('should match exact number', () => {
    expect(fieldMatches('5', 5)).toBe(true)
    expect(fieldMatches('5', 6)).toBe(false)
    expect(fieldMatches('0', 0)).toBe(true)
    expect(fieldMatches('30', 30)).toBe(true)
  })

  it('should match comma-separated list', () => {
    expect(fieldMatches('1,3,5', 1)).toBe(true)
    expect(fieldMatches('1,3,5', 3)).toBe(true)
    expect(fieldMatches('1,3,5', 5)).toBe(true)
    expect(fieldMatches('1,3,5', 2)).toBe(false)
    expect(fieldMatches('1,3,5', 4)).toBe(false)
  })

  it('should match range', () => {
    expect(fieldMatches('1-5', 1)).toBe(true)
    expect(fieldMatches('1-5', 3)).toBe(true)
    expect(fieldMatches('1-5', 5)).toBe(true)
    expect(fieldMatches('1-5', 0)).toBe(false)
    expect(fieldMatches('1-5', 6)).toBe(false)
  })

  it('should match step from wildcard', () => {
    expect(fieldMatches('*/2', 0)).toBe(true)
    expect(fieldMatches('*/2', 2)).toBe(true)
    expect(fieldMatches('*/2', 4)).toBe(true)
    expect(fieldMatches('*/2', 1)).toBe(false)
    expect(fieldMatches('*/2', 3)).toBe(false)
    expect(fieldMatches('*/15', 0)).toBe(true)
    expect(fieldMatches('*/15', 15)).toBe(true)
    expect(fieldMatches('*/15', 30)).toBe(true)
    expect(fieldMatches('*/15', 7)).toBe(false)
  })

  it('should match step within range', () => {
    expect(fieldMatches('1-10/3', 1)).toBe(true)
    expect(fieldMatches('1-10/3', 4)).toBe(true)
    expect(fieldMatches('1-10/3', 7)).toBe(true)
    expect(fieldMatches('1-10/3', 10)).toBe(true)
    expect(fieldMatches('1-10/3', 2)).toBe(false)
    expect(fieldMatches('1-10/3', 11)).toBe(false)
    expect(fieldMatches('1-10/3', 0)).toBe(false)
  })

  it('should handle combined comma and range', () => {
    expect(fieldMatches('1-3,7,10-12', 2)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 7)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 11)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 5)).toBe(false)
  })
})

// ─── cronMatches tests ─────────────────────────────────────────────────────

describe('cronMatches', () => {
  it('should match every-minute expression', () => {
    const date = new Date(2026, 3, 5, 14, 30, 0) // April 5, 2026 14:30 (Sunday)
    expect(cronMatches('* * * * *', date)).toBe(true)
  })

  it('should match daily at 9:00', () => {
    const match = new Date(2026, 3, 5, 9, 0, 0)
    const noMatch = new Date(2026, 3, 5, 9, 1, 0)
    expect(cronMatches('0 9 * * *', match)).toBe(true)
    expect(cronMatches('0 9 * * *', noMatch)).toBe(false)
  })

  it('should match every 2 hours at minute 0', () => {
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 2, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 4, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 1, 0))).toBe(false)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 3, 0))).toBe(false)
  })

  it('should match weekdays at 14:30', () => {
    // April 6, 2026 is a Monday (dow = 1)
    const monday = new Date(2026, 3, 6, 14, 30, 0)
    // April 5, 2026 is a Sunday (dow = 0)
    const sunday = new Date(2026, 3, 5, 14, 30, 0)
    expect(cronMatches('30 14 * * 1-5', monday)).toBe(true)
    expect(cronMatches('30 14 * * 1-5', sunday)).toBe(false)
  })

  it('should match specific month and day', () => {
    // January 15 at midnight
    const jan15 = new Date(2026, 0, 15, 0, 0)
    const feb15 = new Date(2026, 1, 15, 0, 0)
    expect(cronMatches('0 0 15 1 *', jan15)).toBe(true)
    expect(cronMatches('0 0 15 1 *', feb15)).toBe(false)
  })

  it('should reject invalid cron expressions', () => {
    const date = new Date()
    expect(cronMatches('* * *', date)).toBe(false) // only 3 fields
    expect(cronMatches('', date)).toBe(false)
    expect(cronMatches('* * * * * *', date)).toBe(false) // 6 fields
  })

  it('should match day-of-week with Sunday as 0', () => {
    // Sunday = 0
    const sunday = new Date(2026, 3, 5, 10, 0) // April 5, 2026 is Sunday
    expect(cronMatches('0 10 * * 0', sunday)).toBe(true)
    expect(cronMatches('0 10 * * 6', sunday)).toBe(false)
  })

  // Regression: `cronMatches` used to evaluate each field with a hand-rolled
  // matcher whose semantics diverged from `parseCronExpression` — the parser
  // `assertValidCron` validates against. Two divergences were observable:
  // day-of-week `7` (the accepted Sunday alias) never matched, and `*/n` on
  // day-of-month/month counted from 0 instead of the field minimum.

  it('accepts 7 as a Sunday alias in day-of-week, like parseCronExpression', () => {
    const sunday = new Date(2026, 3, 5, 10, 0) // April 5, 2026 is Sunday
    const saturday = new Date(2026, 3, 4, 10, 0) // April 4, 2026 is Saturday
    expect(cronMatches('0 10 * * 7', sunday)).toBe(true)
    // 7 aliases Sunday, it must not be treated as a day index beyond Saturday.
    expect(cronMatches('0 10 * * 7', saturday)).toBe(false)
  })

  it('accepts 7 inside a day-of-week range, like parseCronExpression', () => {
    const friday = new Date(2026, 3, 3, 10, 0) // April 3, 2026 is Friday
    const sunday = new Date(2026, 3, 5, 10, 0)
    const monday = new Date(2026, 3, 6, 10, 0)
    expect(cronMatches('0 10 * * 5-7', friday)).toBe(true)
    expect(cronMatches('0 10 * * 5-7', sunday)).toBe(true)
    expect(cronMatches('0 10 * * 5-7', monday)).toBe(false)
  })

  it('anchors day-of-month steps at 1, like parseCronExpression', () => {
    // `*/2` expands to 1,3,5,… so odd days match and even days do not.
    expect(cronMatches('0 0 */2 * *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 0 */2 * *', new Date(2026, 0, 3, 0, 0))).toBe(true)
    expect(cronMatches('0 0 */2 * *', new Date(2026, 0, 2, 0, 0))).toBe(false)
    expect(cronMatches('0 0 */2 * *', new Date(2026, 0, 4, 0, 0))).toBe(false)
  })

  it('anchors month steps at 1, like parseCronExpression', () => {
    // `*/2` expands to Jan,Mar,May,… so January matches, February does not.
    expect(cronMatches('0 0 1 */2 *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 0 1 */2 *', new Date(2026, 2, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 0 1 */2 *', new Date(2026, 1, 1, 0, 0))).toBe(false)
    expect(cronMatches('0 0 1 */2 *', new Date(2026, 3, 1, 0, 0))).toBe(false)
  })
})

// ─── CronScheduler execution tests ────────────────────────────────────────

describe('CronScheduler', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should start and stop without errors', () => {
    scheduler.start()
    scheduler.stop()
    // Starting again after stop should also work
    scheduler.start()
    scheduler.stop()
  })

  it('should not start twice', () => {
    scheduler.start()
    // Second start should be a no-op (no error)
    scheduler.start()
    scheduler.stop()
  })

  it('settles a recently started abandoned run on the first scheduler tick', async () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString()
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    await fs.writeFile(logPath, JSON.stringify({ runs: [{
      id: 'interrupted-run',
      taskId: 'interrupted-task',
      taskName: 'Interrupted task',
      prompt: 'fixture',
      startedAt,
      status: 'running',
    }] }))

    scheduler.start()
    await scheduler.tick()

    const runs = await scheduler.getTaskRuns('interrupted-task')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'interrupted-run',
      status: 'failed',
      error: 'Process terminated before task could complete',
    })
    expect(runs[0].completedAt).toBeDefined()
  })

  it('preserves a running record while another scheduler holds its task lock', async () => {
    const taskId = 'active-task'
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    await fs.writeFile(logPath, JSON.stringify({ runs: [{
      id: 'active-run',
      taskId,
      taskName: 'Active task',
      prompt: 'fixture',
      startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      status: 'running',
    }] }))
    const lockPath = path.join(tmpDir, 'scheduled_task_locks', `${taskId}.lock`)
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    const release = await lockfile.lock(lockPath, { realpath: false })
    try {
      scheduler.start()
      await scheduler.tick()
      expect((await scheduler.getTaskRuns(taskId))[0].status).toBe('running')
    } finally {
      await release()
    }
    await scheduler.tick()
    expect((await scheduler.getTaskRuns(taskId))[0].status).toBe('failed')
  })

  it('should return empty runs when no tasks have executed', async () => {
    const runs = await scheduler.getRecentRuns()
    expect(runs).toEqual([])
  })

  it('should return empty runs for a non-existent task ID', async () => {
    const runs = await scheduler.getTaskRuns('nonexistent')
    expect(runs).toEqual([])
  })

  it('should persist a task run to the log file', async () => {
    // Create a task that runs "echo hello" — we'll invoke executeTask directly
    // with a mock-like approach: create a task then check the log file
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'echo test',
      name: 'Test Task',
      recurring: true,
    })

    // We can't easily mock Bun.spawn in bun:test, so we'll check the log
    // file was created by reading it after execution attempt.
    // The CLI subprocess will likely fail (not a real CLI available in tests),
    // but the run should still be logged with 'failed' status.
    try {
      await scheduler.executeTask(task)
    } catch {
      // Expected — CLI binary may not be available in test environment
    }

    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const logExists = await fs
      .stat(logPath)
      .then(() => true)
      .catch(() => false)
    expect(logExists).toBe(true)

    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    expect(logContent.runs.length).toBeGreaterThanOrEqual(1)
    expect(logContent.runs[0].taskId).toBe(task.id)
    expect(logContent.runs[0].taskName).toBe('Test Task')
    expect(logContent.runs[0].prompt).toBe('echo test')
    await expect(fs.stat(path.join(
      tmpDir,
      'ccmax',
      'db',
      'scheduled-runs-v1.sqlite',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps both same-second task completions and leaves the task list readable', async () => {
    const first = await cronService.createTask({ cron: '* * * * *', prompt: 'first', recurring: true })
    const second = await cronService.createTask({ cron: '* * * * *', prompt: 'second', recurring: true })
    const now = spyOn(Date, 'now').mockReturnValue(1_790_331_340_000)
    try {
      const results = await Promise.all([
        scheduler.executeTask(first),
        scheduler.executeTask(second),
      ])
      expect(results.map(result => result.status)).toEqual(['completed', 'completed'])

      const runs = await scheduler.getRecentRuns()
      expect(runs).toHaveLength(2)
      expect(runs.map(run => run.taskId).sort()).toEqual([first.id, second.id].sort())
      expect(runs.every(run => run.status === 'completed')).toBe(true)
      const tasks = await cronService.listTasks()
      expect(tasks).toHaveLength(2)
      expect(tasks.every(task => task.lastFiredAt)).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps one execution lifecycle canonical and projected writes in its original scope', async () => {
    const scopeA = path.join(tmpDir, 'scope-a')
    const scopeB = path.join(tmpDir, 'scope-b')
    await fs.mkdir(scopeA, { recursive: true })
    await fs.mkdir(scopeB, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = scopeA
    process.env.CC_HAHA_LOCAL_INDEX = 'on'

    const blockingCli = await createBlockingFakeCronCli(tmpDir)
    process.env.CLAUDE_CLI_PATH = blockingCli.cliPath
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'scope A prompt',
      name: 'Scope A Task',
      recurring: true,
    })
    const scopeBMarker: TaskRun = {
      id: 'scope-b-marker',
      taskId: 'scope-b-task',
      taskName: 'Scope B Task',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      status: 'completed',
      prompt: 'scope B prompt',
    }
    await fs.writeFile(
      path.join(scopeB, 'scheduled_tasks_log.json'),
      JSON.stringify({ runs: [scopeBMarker] }, null, 2) + '\n',
      'utf-8',
    )

    const execution = scheduler.executeTask(task)
    try {
      await waitForFile(blockingCli.readyPath)

      // The running write must already be projected in scope A before the
      // process-level config scope changes while the task is still alive.
      await resetScheduledRunReadModelForTests()
      const scopeADatabasePath = path.join(
        scopeA,
        'ccmax',
        'db',
        'scheduled-runs-v1.sqlite',
      )
      const runningDatabase = new Database(scopeADatabasePath, { readonly: true })
      try {
        expect(runningDatabase.query<{ status: string }, []>(
          'SELECT status FROM scheduled_runs WHERE task_id = ?',
        ).get(task.id)?.status).toBe('running')
      } finally {
        runningDatabase.close()
      }

      process.env.CLAUDE_CONFIG_DIR = scopeB
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8')
      await execution
      await resetScheduledRunReadModelForTests()
    } finally {
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8').catch(() => {})
      await execution.catch(() => {})
      await resetScheduledRunReadModelForTests()
    }

    const scopeARuns = JSON.parse(await fs.readFile(
      path.join(scopeA, 'scheduled_tasks_log.json'),
      'utf-8',
    )) as { runs: TaskRun[] }
    const scopeBRuns = JSON.parse(await fs.readFile(
      path.join(scopeB, 'scheduled_tasks_log.json'),
      'utf-8',
    )) as { runs: TaskRun[] }

    expect(scopeARuns.runs).toHaveLength(1)
    expect(scopeARuns.runs[0]).toMatchObject({
      taskId: task.id,
      status: 'completed',
      prompt: 'scope A prompt',
    })
    expect(scopeBRuns.runs).toEqual([scopeBMarker])

    const scopeADatabasePath = path.join(
      scopeA,
      'ccmax',
      'db',
      'scheduled-runs-v1.sqlite',
    )
    const completedDatabase = new Database(scopeADatabasePath, { readonly: true })
    try {
      expect(completedDatabase.query<{ status: string }, []>(
        'SELECT status FROM scheduled_runs WHERE task_id = ?',
      ).get(task.id)?.status).toBe('completed')
    } finally {
      completedDatabase.close()
    }
    await expect(fs.stat(path.join(
      scopeB,
      'ccmax',
      'db',
      'scheduled-runs-v1.sqlite',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('should disable non-recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'one-shot task',
      recurring: false,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    // After execution, the task should be disabled
    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.enabled).toBe(false)
  })

  it('should NOT disable recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'recurring task',
      recurring: true,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    // enabled should not have been set to false
    expect(updated?.enabled).not.toBe(false)
  })

  it('should update lastFiredAt after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'fire test',
      recurring: true,
    })

    const beforeExec = new Date().toISOString()

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.lastFiredAt).toBeDefined()
    // lastFiredAt should be a valid ISO timestamp at or after beforeExec
    expect(new Date(updated!.lastFiredAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeExec).getTime() - 1000, // allow 1s tolerance
    )
  })

  it('should skip disabled tasks during tick', async () => {
    // Create a task matching every minute but disabled
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'should not run',
      enabled: false,
      recurring: true,
    })

    await scheduler.tick()

    // No runs should be logged
    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs).toHaveLength(0)
  })

  it('getTaskRuns should return runs sorted newest first', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'multi run',
      recurring: true,
    })

    // Execute twice
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs.length).toBeGreaterThanOrEqual(2)
    // Should be sorted newest first
    if (runs.length >= 2) {
      expect(
        new Date(runs[0].startedAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(runs[1].startedAt).getTime())
    }
  })

  it('getRecentRuns should respect limit parameter', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'limit test',
      recurring: true,
    })

    // Execute 3 times
    for (let i = 0; i < 3; i++) {
      try {
        await scheduler.executeTask(task)
      } catch {
        /* ignore */
      }
    }

    const runs = await scheduler.getRecentRuns(2)
    expect(runs.length).toBeLessThanOrEqual(2)
  })
})

// ─── Execution log trimming ────────────────────────────────────────────────

describe('Execution log trimming', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should keep log entries within the max limit', async () => {
    // Pre-populate the log file with 105 entries for a single task
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = []
    for (let i = 0; i < 105; i++) {
      runs.push({
        id: `run-${i}`,
        taskId: 'task-1',
        taskName: 'Test',
        startedAt: new Date(Date.now() - (105 - i) * 1000).toISOString(),
        completedAt: new Date(Date.now() - (105 - i) * 1000 + 100).toISOString(),
        status: 'completed',
        prompt: 'test',
        exitCode: 0,
        durationMs: 100,
      })
    }
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    // Now execute one more task run — this triggers a trim
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'trigger trim',
      recurring: true,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    // Read back the log
    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    const task1Runs = logContent.runs.filter((r) => r.taskId === 'task-1')
    // Should have been trimmed to at most 100
    expect(task1Runs.length).toBeLessThanOrEqual(100)
  })
})

// ─── Scheduled Tasks API with runs endpoints ──────────────────────────────

describe('Scheduled Tasks API — runs endpoints', () => {
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

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

  it('GET /api/scheduled-tasks/runs should return empty runs', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/scheduled-tasks/:id/runs should return empty runs for a task', async () => {
    const req = new Request(
      'http://localhost/api/scheduled-tasks/abc123/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'abc123',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/scheduled-tasks/runs should return runs from log', async () => {
    // Write some runs to the log file
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'test prompt',
        exitCode: 0,
        durationMs: 500,
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        prompt: 'another prompt',
        error: 'some error',
        exitCode: 1,
        durationMs: 200,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request('http://localhost/api/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: TaskRun[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(2)
  })

  it('GET /api/scheduled-tasks/:id/runs should filter by task ID', async () => {
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt a',
        exitCode: 0,
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt b',
        exitCode: 0,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request(
      'http://localhost/api/scheduled-tasks/task-a/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'task-a',
      'runs',
    ])
    const body = (await resp.json()) as { runs: TaskRun[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].taskId).toBe('task-a')
  })
})

// ─── Terminal-state on execution failure ───────────────────────────────────
//
// Every failure path — a throwing Bun.spawn, a failing environment builder, or
// any other unexpected error before the child is awaited — must move the run
// out of `running`. A run left at `running` is invisible to history consumers
// that only look at terminal runs, and blocks nothing from ever finishing it.

describe('CronScheduler failure terminal state', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  function readRuns(): Promise<{ runs: TaskRun[] }> {
    return fs
      .readFile(path.join(tmpDir, 'scheduled_tasks_log.json'), 'utf-8')
      .then((raw) => JSON.parse(raw) as { runs: TaskRun[] })
  }

  it('settles a child that writes more stderr than a pipe can buffer', async () => {
    const cliPath = path.join(tmpDir, 'stderr-heavy-cli.ts')
    await fs.writeFile(cliPath, "process.stderr.write('x'.repeat(1024 * 1024)); console.log(JSON.stringify({ type: 'result', result: 'done' }))\n")
    process.env.CLAUDE_CLI_PATH = cliPath
    const task = await cronService.createTask({ cron: '0 9 * * *', prompt: 'stderr fixture', recurring: true, folderPath: tmpDir })
    const execution = scheduler.executeTask(task)
    try {
      const result = await Promise.race([execution, Bun.sleep(1500).then(() => null)])
      expect(result?.status).toBe('completed')
      expect((await scheduler.getTaskRuns(task.id))[0]?.status).toBe('completed')
    } finally {
      scheduler.stop()
      await execution.catch(() => {})
    }
  })

  it('finishes when a departed CLI leaves its stdout pipe open in a descendant', async () => {
    const cli = path.join(tmpDir, 'inherited-stdout-cli.ts')
    await fs.writeFile(cli, "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { detached: true, stdio: ['ignore', process.stdout, 'ignore'] }).unref(); console.log(JSON.stringify({ type: 'result', result: 'done' }))\n")
    process.env.CLAUDE_CLI_PATH = cli
    const task = await cronService.createTask({ cron: '0 9 * * *', prompt: 'inherited pipe fixture', recurring: true, folderPath: tmpDir })
    const execution = scheduler.executeTask(task)
    const outcome = await Promise.race([execution, Bun.sleep(1500).then(() => null)])
    expect(outcome?.status).toBe('completed')
    await execution
  })

  it('marks a killed over-time run as timeout and releases its execution lock', async () => {
    const blocked = await createBlockingFakeCronCli(tmpDir)
    process.env.CLAUDE_CLI_PATH = blocked.cliPath
    const previousTimeout = process.env.CC_HAHA_TASK_TIMEOUT_MS
    process.env.CC_HAHA_TASK_TIMEOUT_MS = '100'
    const task = await cronService.createTask({ cron: '0 9 * * *', prompt: 'timeout fixture', recurring: true, folderPath: tmpDir })
    try {
      const timedOut = await scheduler.executeTask(task)
      expect(timedOut.status).toBe('timeout')
      expect(timedOut.error).toContain('timed out')
      await fs.writeFile(blocked.releasePath, 'release')
      expect((await scheduler.executeTask(task)).status).toBe('completed')
    } finally {
      if (previousTimeout === undefined) delete process.env.CC_HAHA_TASK_TIMEOUT_MS
      else process.env.CC_HAHA_TASK_TIMEOUT_MS = previousTimeout
      await fs.writeFile(blocked.releasePath, 'release').catch(() => {})
    }
  })

  it('stops a live run and allows a new run after cancellation', async () => {
    const blocking = await createBlockingFakeCronCli(tmpDir)
    process.env.CLAUDE_CLI_PATH = blocking.cliPath
    const task = await cronService.createTask({ cron: '0 9 * * *', prompt: 'cancel fixture', recurring: true })
    const execution = scheduler.executeTask(task)
    try {
      await waitForFile(blocking.readyPath)
      const [running] = await scheduler.getTaskRuns(task.id)
      expect(running?.status).toBe('running')
      const stopped = await scheduler.stopRun(task.id, running!.id)
      expect(stopped.status).toBe('failed')
      expect(stopped.error).toContain('Stopped')
      expect((await execution).status).toBe('failed')
      await fs.writeFile(blocking.releasePath, 'release')
      expect((await scheduler.executeTask(task)).status).toBe('completed')
    } finally {
      scheduler.stop()
      await fs.writeFile(blocking.releasePath, 'release').catch(() => {})
      await execution.catch(() => {})
    }
  })

  it('settles an abandoned run and removes only the requested terminal record', async () => {
    const task = await cronService.createTask({ cron: '0 9 * * *', prompt: 'cleanup fixture', recurring: true })
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const stale = { id: 'stale', taskId: task.id, taskName: 'test', prompt: 'test', status: 'running', startedAt: new Date().toISOString() }
    await fs.writeFile(logPath, JSON.stringify({ runs: [stale, { ...stale, id: 'keep', status: 'completed' }] }))
    const stopped = await scheduler.stopRun(task.id, 'stale')
    expect(stopped.status).toBe('failed')
    await scheduler.deleteRun(task.id, 'stale')
    expect((await scheduler.getTaskRuns(task.id)).map((run) => run.id)).toEqual(['keep'])
  })

  it('records a failed terminal run when Bun.spawn throws', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'spawn will throw',
      recurring: true,
    })

    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('spawn failed: ENOENT')
    }) as typeof Bun.spawn)

    let result: TaskRun | undefined
    try {
      // Must not reject — a thrown error inside the task is the scheduler's
      // to log, not the caller's to catch.
      result = await scheduler.executeTask(task)
    } finally {
      spawnSpy.mockRestore()
    }

    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('spawn failed')

    const { runs } = await readRuns()
    const logged = runs.filter((r) => r.taskId === task.id)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.status).toBe('failed')
    expect(logged[0]?.status).not.toBe('running')
    expect(logged[0]?.completedAt).toBeDefined()
  })

  it('records a failed terminal run when the task environment builder throws', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'env builder will throw',
      recurring: true,
    })

    const envSpy = spyOn(
      SettingsService.prototype,
      'getAgentTeamsEnabled',
    ).mockImplementation(async () => {
      throw new Error('settings unavailable')
    })

    let result: TaskRun | undefined
    try {
      result = await scheduler.executeTask(task)
    } finally {
      envSpy.mockRestore()
    }

    expect(result?.status).toBe('failed')

    const { runs } = await readRuns()
    const logged = runs.filter((r) => r.taskId === task.id)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.status).toBe('failed')
    expect(logged[0]?.status).not.toBe('running')
  })

  it('releases the in-flight guard after a spawn failure so the task can run again', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'retry after failure',
      recurring: true,
    })

    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('transient spawn failure')
    }) as typeof Bun.spawn)

    try {
      await scheduler.executeTask(task)
    } finally {
      spawnSpy.mockRestore()
    }

    // A second execution must spawn again — the guard from the failed attempt
    // must not strand the task as permanently "already running".
    const second = await scheduler.executeTask(task)
    expect(second.status).not.toBe('running')
    const { runs } = await readRuns()
    expect(runs.filter((r) => r.taskId === task.id)).toHaveLength(2)
  })

  it('disables a non-recurring task that fails, and notifies', async () => {
    await writeFakeAdapters(tmpDir)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'one-shot that fails',
      recurring: false,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    const notifySpy = spyOn(notificationService, 'sendTaskNotification').mockResolvedValue()
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('boom')
    }) as typeof Bun.spawn)

    let result: TaskRun | undefined
    try {
      result = await scheduler.executeTask(task)
    } finally {
      spawnSpy.mockRestore()
    }

    // One-shot tasks must be disabled whether they succeeded or failed, so a
    // permanently-broken task does not retry forever.
    const reloaded = (await cronService.listTasks()).find((t) => t.id === task.id)
    expect(reloaded?.enabled).toBe(false)

    expect(notifySpy).toHaveBeenCalledTimes(1)
    const [notifiedRun, notifiedConfig] = notifySpy.mock.calls[0]!
    expect(notifiedRun.status).toBe('failed')
    expect(notifiedRun.id).toBe(result?.id)
    expect(notifiedConfig.enabled).toBe(true)
    notifySpy.mockRestore()
  })

  it('notifies on a failed recurring task without disabling it', async () => {
    await writeFakeAdapters(tmpDir)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'recurring that fails',
      recurring: true,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    const notifySpy = spyOn(notificationService, 'sendTaskNotification').mockResolvedValue()
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('boom')
    }) as typeof Bun.spawn)

    try {
      await scheduler.executeTask(task)
    } finally {
      spawnSpy.mockRestore()
    }

    const reloaded = (await cronService.listTasks()).find((t) => t.id === task.id)
    expect(reloaded?.enabled).not.toBe(false)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    notifySpy.mockRestore()
  })
})

// ─── Concurrency: no duplicate execution of the same task ──────────────────
//
// The in-memory `runningTasks` map is per CronScheduler instance. Two instances
// sharing one config directory (the API handler and the scheduler singleton, or
// two server processes) must not both spawn the same task.

describe('CronScheduler concurrent execution guard', () => {
  let schedulerA: CronScheduler
  let schedulerB: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    schedulerA = new CronScheduler(new CronService())
    schedulerB = new CronScheduler(new CronService())
  })

  afterEach(async () => {
    schedulerA.stop()
    schedulerB.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  it('spawns only once when two scheduler instances start the same task together', async () => {
    const blockingCli = await createBlockingFakeCronCli(tmpDir)
    process.env.CLAUDE_CLI_PATH = blockingCli.cliPath

    const task = await new CronService().createTask({
      cron: '* * * * *',
      prompt: 'contended task',
      recurring: true,
    })

    const realSpawn = Bun.spawn
    let spawnCount = 0
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
      spawnCount += 1
      return (realSpawn as (...a: unknown[]) => unknown)(...args)
    }) as typeof Bun.spawn)

    const first = schedulerA.executeTask(task)
    const second = schedulerB.executeTask(task)

    try {
      await waitForFile(blockingCli.readyPath)
      // Give the loser a beat to (incorrectly) also spawn.
      await Bun.sleep(50)
      expect(spawnCount).toBe(1)
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8')
      await Promise.all([first, second])
    } finally {
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8').catch(() => {})
      spawnSpy.mockRestore()
      await Promise.all([first.catch(() => {}), second.catch(() => {})])
    }

    const runs = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'scheduled_tasks_log.json'), 'utf-8'),
    ) as { runs: TaskRun[] }
    const taskRuns = runs.runs.filter((r) => r.taskId === task.id)
    // Exactly one run lifecycle, not two.
    expect(taskRuns).toHaveLength(1)
  })
})

// ─── Structured notification report on the run ──────────────────────────────
//
// The scheduler must consume the delivery report returned by
// `sendTaskNotification` and record a queryable summary on the run. It must
// never hold the run out of its terminal state: the terminal write happens
// first, and a failing or slow notification cannot change the run's status.

describe('CronScheduler notification report', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    await writeFakeAdapters(tmpDir)
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  function reportFixture(): notificationService.NotificationDeliveryReport {
    return {
      ok: false,
      delivered: [],
      failed: [
        {
          channel: 'telegram',
          recipientId: '111',
          recipientLabel: 'Alice',
          outcome: 'failed',
          attempts: 2,
          errorCode: 'http_error',
          error: 'sendMessage returned HTTP 500',
        },
      ],
      indeterminate: [],
      issues: [
        { channel: 'telegram', code: 'business_error', message: 'platform rejected the message' },
      ],
      recordPath: path.join(tmpDir, 'ccmax', 'notification-deliveries.json'),
    }
  }

  it('routes a completed task notification through the system bridge and records its receipt', async () => {
    const previousFetch = globalThis.fetch
    const previousBridge = process.env.CC_HAHA_SYSTEM_PROXY_URL
    const previousNoProxy = process.env.NO_PROXY
    const previousLowerNoProxy = process.env.no_proxy
    const previousHttpsProxy = process.env.HTTPS_PROXY
    const requests: Array<{ url: string; init: RequestInit & { proxy?: string }; body: Record<string, unknown> }> = []
    process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:17890'
    process.env.NO_PROXY = 'localhost'
    delete process.env.no_proxy
    delete process.env.HTTPS_PROXY
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      network: { proxy: { mode: 'system', url: '' } },
    }))
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'notify via system proxy',
      recurring: true,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const options = init as RequestInit & { proxy?: string }
      requests.push({ url: String(input), init: options, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      if (options.proxy !== process.env.CC_HAHA_SYSTEM_PROXY_URL) {
        throw new Error('unknown certificate verification error')
      }
      return Response.json({ ok: true, result: { message_id: 1 } })
    }) as typeof fetch

    try {
      const run = await scheduler.executeTask(task)
      const persisted = await scheduler.getRunDetail(run.id)
      expect(run.status).toBe('completed')
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe('https://api.telegram.org/botfixture-token/sendMessage')
      expect(requests[0]!.body.chat_id).toBe(111)
      expect(requests[0]!.init.proxy).toBe('http://127.0.0.1:17890')
      expect(persisted?.notificationReport).toMatchObject({ ok: true, delivered: 1, failed: 0, indeterminate: 0 })
      const log = JSON.parse(await fs.readFile(path.join(tmpDir, 'ccmax', 'notification-deliveries.json'), 'utf-8')) as {
        records: Array<{ runId: string; recipientId: string; outcome: string; attempts: number }>
      }
      expect(log.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: run.id, recipientId: '111', outcome: 'delivered', attempts: 1 }),
      ]))
    } finally {
      globalThis.fetch = previousFetch
      if (previousBridge === undefined) delete process.env.CC_HAHA_SYSTEM_PROXY_URL
      else process.env.CC_HAHA_SYSTEM_PROXY_URL = previousBridge
      if (previousNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = previousNoProxy
      if (previousLowerNoProxy === undefined) delete process.env.no_proxy
      else process.env.no_proxy = previousLowerNoProxy
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previousHttpsProxy
    }
  })

  it('records the structured report on the terminal run and keeps it terminal', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'notify report',
      recurring: true,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    const notifySpy = spyOn(notificationService, 'sendTaskNotification').mockResolvedValue(
      reportFixture(),
    )

    let result: TaskRun
    let notifyCount = 0
    try {
      result = await scheduler.executeTask(task)
    } finally {
      notifyCount = notifySpy.mock.calls.length
      notifySpy.mockRestore()
    }

    const persisted = await scheduler.getRunDetail(result.id)
    expect(notifyCount).toBe(1)
    expect(result.status).not.toBe('running')
    expect(persisted?.status).toBe(result.status)
    expect(persisted?.notificationReport).toMatchObject({
      ok: false,
      delivered: 0,
      failed: 1,
      indeterminate: 0,
    })
    expect(persisted?.notificationReport?.issues[0]).toMatchObject({
      channel: 'telegram',
      code: 'business_error',
    })
  })

  it('keeps the run terminal even when the notification sender throws', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'notify throws',
      recurring: true,
      notification: {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [{ userId: 111, displayName: 'Alice' }] },
      },
    })

    const notifySpy = spyOn(notificationService, 'sendTaskNotification').mockRejectedValue(
      new Error('notification pipeline blew up'),
    )

    let result: TaskRun
    try {
      result = await scheduler.executeTask(task)
    } finally {
      notifySpy.mockRestore()
    }

    expect(result.status).toBe('completed')
    const persisted = await scheduler.getRunDetail(result.id)
    expect(persisted?.status).toBe('completed')
  })
})

// ─── Explicit working directory handling ────────────────────────────────────
//
// An explicitly configured working directory that does not exist must fail the
// run visibly. Silently running the task in the home directory hides the
// mistake and executes the prompt somewhere the user never chose.

describe('CronScheduler working directory', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  it('fails the run instead of falling back to homedir when folderPath is missing', async () => {
    const missingDir = path.join(tmpDir, 'missing-work-dir')
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'run somewhere that does not exist',
      recurring: true,
      folderPath: missingDir,
    })

    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('spawn must not be reached for an invalid working directory')
    }) as typeof Bun.spawn)

    let result: TaskRun
    try {
      result = await scheduler.executeTask(task)
    } finally {
      spawnSpy.mockRestore()
    }

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.error).toContain(missingDir)

    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.error).toContain(missingDir)
  })

  it('still runs in the home directory when folderPath is omitted', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'default working directory',
      recurring: true,
    })

    const result = await scheduler.executeTask(task)
    expect(result.status).toBe('completed')
  })
})

// ─── Concurrency: different tasks must not clobber each other's log rows ────
//
// `appendRun`/`updateRun` are read-modify-write operations on one shared file.
// Two different tasks finishing in the same window must each land their own
// row: a stale read followed by a rename would silently drop the other
// writer's run, and a temp file named only by `Date.now()` lets two writers in
// the same millisecond collide so one rename fails with ENOENT.

describe('CronScheduler log write serialization', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  it('keeps every run when different tasks append and update the log at once', async () => {
    // Force every writer into the same millisecond — the historical
    // `${file}.tmp.${Date.now()}` temp name then collided — and delay the
    // rename that publishes the log so overlapping writers reliably race
    // instead of colliding only occasionally.
    const realRename = fs.rename
    const realNow = Date.now
    const frozenNow = Date.now()
    Date.now = () => frozenNow
    const renameSpy = spyOn(fs, 'rename').mockImplementation((async (
      ...args: unknown[]
    ) => {
      const target = String(args[1])
      if (
        target.endsWith('scheduled_tasks_log.json') &&
        String(args[0]).includes('.tmp.')
      ) {
        await Bun.sleep(30)
      }
      return (realRename as (...a: unknown[]) => Promise<void>)(...args)
    }) as typeof fs.rename)

    try {
      const tasks = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          cronService.createTask({
            cron: '* * * * *',
            prompt: `concurrent task ${i}`,
            name: `Concurrent Task ${i}`,
            recurring: true,
          }),
        ),
      )

      // Start every task in the same tick so their appendRun/updateRun writes
      // genuinely overlap instead of running one after another.
      const runs = await Promise.all(
        tasks.map((task) => scheduler.executeTask(task)),
      )

      const log = JSON.parse(
        await fs.readFile(
          path.join(tmpDir, 'scheduled_tasks_log.json'),
          'utf-8',
        ),
      ) as { runs: TaskRun[] }

      for (const run of runs) {
        expect(log.runs.some((entry) => entry.id === run.id)).toBe(true)
        expect(
          log.runs.filter((entry) => entry.taskId === run.taskId),
        ).toHaveLength(1)
      }
    } finally {
      renameSpy.mockRestore()
      Date.now = realNow
    }
  })

  it('does not publish a run while another process holds the log lock', async () => {
    // `mutateRunsFile` serializes same-process writers in a queue, but the
    // queue alone cannot exclude a second server process sharing the config
    // dir — that is the on-disk lock. Hold it from the outside and prove no
    // write escapes it: a reverted implementation would rename its temp file
    // into place within a few milliseconds of the task starting.
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'locked run log',
      recurring: true,
    })
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const release = await lockfile.lock(logPath, { realpath: false })
    const pending = scheduler.executeTask(task)
    let publishedWhileLocked = false
    try {
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline && !publishedWhileLocked) {
        publishedWhileLocked = await fs
          .access(logPath)
          .then(() => true, () => false)
        if (!publishedWhileLocked) await Bun.sleep(25)
      }
    } finally {
      await release()
    }
    expect(publishedWhileLocked).toBe(false)

    const run = await pending
    expect(run.status).toBe('completed')
    const log = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    expect(log.runs.map((entry) => entry.id)).toEqual([run.id])
  })
})
