import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import { constants } from 'node:fs'
import * as os from 'os'
import * as path from 'path'

import {
  buildCronCliArgs,
  buildCronTaskSpawnOptions,
  CronScheduler,
  resolveCronTaskTimeoutMs,
  resolveCronProjectRoot,
} from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import { SessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  DESKTOP_SERVER_URL_ENV,
  LOCAL_ACCESS_TOKEN_ENV,
  isLocalScheduledTaskApiAvailable,
} from '../../tools/LocalScheduledTaskTool/client.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalPath = process.env.PATH
const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH
const originalClaudeAppRoot = process.env.CLAUDE_APP_ROOT
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalHome = process.env.HOME
const originalShell = process.env.SHELL
const originalZdotdir = process.env.ZDOTDIR
const originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
const originalTaskTimeout = process.env.CC_HAHA_TASK_TIMEOUT_MS
const originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
const originalDesktopServerUrl = process.env[DESKTOP_SERVER_URL_ENV]
const originalSystemProxyUrl = process.env.CC_HAHA_SYSTEM_PROXY_URL
const originalHttpProxy = process.env.HTTP_PROXY
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalLowerHttpProxy = process.env.http_proxy
const originalLowerHttpsProxy = process.env.https_proxy

const isWindows = process.platform === 'win32'
const unixOnly = isWindows ? it.skip : it

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-cron-launcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

async function createSourceRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src', 'entrypoints'), { recursive: true })
  await fs.writeFile(path.join(root, 'preload.ts'), '', 'utf-8')
  await fs.writeFile(
    path.join(root, 'src', 'entrypoints', 'cli.tsx'),
    '',
    'utf-8',
  )
}

function restoreEnv(): void {
  if (originalConfigDir) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  if (originalPath) {
    process.env.PATH = originalPath
  } else {
    delete process.env.PATH
  }
  if (originalClaudeCliPath) {
    process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
  } else {
    delete process.env.CLAUDE_CLI_PATH
  }
  if (originalClaudeAppRoot) {
    process.env.CLAUDE_APP_ROOT = originalClaudeAppRoot
  } else {
    delete process.env.CLAUDE_APP_ROOT
  }
  if (originalAnthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  } else {
    delete process.env.ANTHROPIC_BASE_URL
  }
  if (originalAnthropicModel) {
    process.env.ANTHROPIC_MODEL = originalAnthropicModel
  } else {
    delete process.env.ANTHROPIC_MODEL
  }
  if (originalClaudeCodeEntrypoint) {
    process.env.CLAUDE_CODE_ENTRYPOINT = originalClaudeCodeEntrypoint
  } else {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  }
  if (originalHome) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  if (originalShell) {
    process.env.SHELL = originalShell
  } else {
    delete process.env.SHELL
  }
  if (originalZdotdir) {
    process.env.ZDOTDIR = originalZdotdir
  } else {
    delete process.env.ZDOTDIR
  }
  if (originalDisableTerminalShellEnv) {
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
  } else {
    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
  }
  if (originalTaskTimeout) {
    process.env.CC_HAHA_TASK_TIMEOUT_MS = originalTaskTimeout
  } else {
    delete process.env.CC_HAHA_TASK_TIMEOUT_MS
  }
  if (originalLocalAccessToken !== undefined) {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = originalLocalAccessToken
  } else {
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  }
  if (originalDesktopServerUrl !== undefined) {
    process.env[DESKTOP_SERVER_URL_ENV] = originalDesktopServerUrl
  } else {
    delete process.env[DESKTOP_SERVER_URL_ENV]
  }
  if (originalSystemProxyUrl !== undefined) {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = originalSystemProxyUrl
  } else {
    delete process.env.CC_HAHA_SYSTEM_PROXY_URL
  }
  if (originalHttpProxy !== undefined) process.env.HTTP_PROXY = originalHttpProxy
  else delete process.env.HTTP_PROXY
  if (originalHttpsProxy !== undefined) process.env.HTTPS_PROXY = originalHttpsProxy
  else delete process.env.HTTPS_PROXY
  if (originalLowerHttpProxy !== undefined) process.env.http_proxy = originalLowerHttpProxy
  else delete process.env.http_proxy
  if (originalLowerHttpsProxy !== undefined) process.env.https_proxy = originalLowerHttpsProxy
  else delete process.env.https_proxy
  resetSettingsCache()
  resetTerminalShellEnvironmentCacheForTests()
}

describe('cron scheduler launcher resolution', () => {
  let tmpDir: string
  let previousServerPort: number

  beforeEach(async () => {
    previousServerPort = ProviderService.getServerPort()
    // 每条用例显式固定并恢复代理端口，避免同进程中其他服务测试的端口污染。
    ProviderService.setServerPort(3456)
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'config')
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    resetSettingsCache()
    resetTerminalShellEnvironmentCacheForTests()
  })

  afterEach(async () => {
    mock.restore()
    ProviderService.setServerPort(previousServerPort)
    restoreEnv()
    await cleanupTmpDir(tmpDir)
  })

  it('resolves the timeout from task override, environment, then the 600 s default', () => {
    expect(resolveCronTaskTimeoutMs({}, {})).toBe(600_000)
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '1800000' }),
    ).toBe(1_800_000)
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: 'not-a-number' }),
    ).toBe(600_000)
    expect(resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '0' })).toBe(
      600_000,
    )

    // A valid per-task override wins over the environment.
    expect(
      resolveCronTaskTimeoutMs(
        { timeoutMs: 90_500 },
        { CC_HAHA_TASK_TIMEOUT_MS: '12345' },
      ),
    ).toBe(90_500)
    expect(resolveCronTaskTimeoutMs({ timeoutMs: 2_147_483_647 }, {})).toBe(
      2_147_483_647,
    )
  })

  it('ignores an out-of-range stored task override', () => {
    expect(
      resolveCronTaskTimeoutMs(
        { timeoutMs: 0 },
        { CC_HAHA_TASK_TIMEOUT_MS: '12345' },
      ),
    ).toBe(12_345)
    expect(resolveCronTaskTimeoutMs({ timeoutMs: 1.5 }, {})).toBe(600_000)
    expect(resolveCronTaskTimeoutMs({ timeoutMs: 2_147_483_648 }, {})).toBe(
      600_000,
    )
  })

  it('falls back to the default when the environment timeout is out of range', () => {
    // One millisecond past the accepted ceiling. The bare
    // `Number.isInteger(x) && x > 0` check this replaced returned it unchanged,
    // and `setTimeout` treats a delay above 2^31-1 as 1 ms, so the run's own
    // guard fired before the task had any chance to work.
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '2147483648' }),
    ).toBe(600_000)
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '4294967296' }),
    ).toBe(600_000)
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '9999999999999' }),
    ).toBe(600_000)
    // The boundary value itself is still honoured.
    expect(
      resolveCronTaskTimeoutMs({}, { CC_HAHA_TASK_TIMEOUT_MS: '2147483647' }),
    ).toBe(2_147_483_647)
  })

  unixOnly(
    'executeTask arms each run from its task override, then the environment',
    async () => {
      const binDir = path.join(tmpDir, 'bin')
      const sidecarPath = path.join(tmpDir, 'claude-sidecar')
      const appRoot = path.join(tmpDir, 'app-root')
      await fs.mkdir(binDir, { recursive: true })
      await fs.mkdir(appRoot, { recursive: true })
      await fs.writeFile(
        sidecarPath,
        [
          '#!/bin/sh',
          'read -r _cron_input || true',
          "printf '%s\\n' '{\"type\":\"result\",\"result\":\"timeout env ok\"}'",
          'exit 0',
          '',
        ].join('\n'),
        'utf-8',
      )
      await fs.chmod(sidecarPath, 0o755)

      const originalSetTimeout = globalThis.setTimeout
      const timeoutCalls: number[] = []
      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        timeoutCalls.push(timeout ?? 0)
        return originalSetTimeout(handler, timeout, ...args)
      }) as typeof setTimeout

      process.env.PATH = binDir
      process.env.CLAUDE_CLI_PATH = sidecarPath
      process.env.CLAUDE_APP_ROOT = appRoot
      process.env.HOME = tmpDir
      process.env.CC_HAHA_TASK_TIMEOUT_MS = '12345'

      try {
        const cronService = new CronService()
        const scheduler = new CronScheduler(cronService)

        // No task override: the environment value still applies.
        const envTask = await cronService.createTask({
          cron: '* * * * *',
          prompt: 'cron timeout env test',
          name: 'Timeout Env Task',
          recurring: true,
          folderPath: tmpDir,
        })
        expect((await scheduler.executeTask(envTask)).status).toBe('completed')
        expect(timeoutCalls).toContain(12_345)

        // A task override wins over the still-exported environment.
        const overrideTask = await cronService.createTask({
          cron: '* * * * *',
          prompt: 'cron timeout override test',
          name: 'Timeout Override Task',
          recurring: true,
          folderPath: tmpDir,
          timeoutMs: 90_500,
        })
        timeoutCalls.length = 0
        expect((await scheduler.executeTask(overrideTask)).status).toBe('completed')
        expect(timeoutCalls).toContain(90_500)
        expect(timeoutCalls).not.toContain(12_345)

        // An edited override applies to the next run, not the current one.
        const bumped = await cronService.updateTask(overrideTask.id, {
          timeoutMs: 1_800_000,
        })
        timeoutCalls.length = 0
        expect((await scheduler.executeTask(bumped)).status).toBe('completed')
        expect(timeoutCalls).toContain(1_800_000)
        expect(timeoutCalls).not.toContain(90_500)

        // Clearing the override falls back to the environment.
        const cleared = await cronService.updateTask(overrideTask.id, {
          timeoutMs: null,
        })
        timeoutCalls.length = 0
        expect((await scheduler.executeTask(cleared)).status).toBe('completed')
        expect(timeoutCalls).toContain(12_345)

        // With no environment value either, the 600 s default applies.
        delete process.env.CC_HAHA_TASK_TIMEOUT_MS
        timeoutCalls.length = 0
        expect((await scheduler.executeTask(cleared)).status).toBe('completed')
        expect(timeoutCalls).toContain(600_000)
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    },
  )

  unixOnly(
    'executeTask kills a real overrunning process at the per-task timeout',
    async () => {
      const binDir = path.join(tmpDir, 'bin')
      const sidecarPath = path.join(tmpDir, 'slow-sidecar')
      const appRoot = path.join(tmpDir, 'app-root')
      await fs.mkdir(binDir, { recursive: true })
      await fs.mkdir(appRoot, { recursive: true })
      await fs.writeFile(
        sidecarPath,
        [
          '#!/bin/sh',
          'read -r _cron_input || true',
          // Absolute path: the task child env scopes PATH, so a bare `sleep`
          // may not resolve. `exec` makes the killed pid the sleeper itself.
          'exec /bin/sleep 30',
          '',
        ].join('\n'),
        'utf-8',
      )
      await fs.chmod(sidecarPath, 0o755)

      process.env.PATH = binDir
      process.env.CLAUDE_CLI_PATH = sidecarPath
      process.env.CLAUDE_APP_ROOT = appRoot
      process.env.HOME = tmpDir
      delete process.env.CC_HAHA_TASK_TIMEOUT_MS

      const cronService = new CronService()
      const scheduler = new CronScheduler(cronService)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'overrunning task',
        name: 'Overrunning Task',
        recurring: true,
        folderPath: tmpDir,
        timeoutMs: 300,
      })

      try {
        const startedAt = Date.now()
        const run = await scheduler.executeTask(task)
        const elapsed = Date.now() - startedAt

        expect(run.status).toBe('timeout')
        expect(run.error).toContain('300')
        // The 30 s child is killed at the limit instead of being waited out.
        expect(elapsed).toBeLessThan(10_000)
      } finally {
        scheduler.stop()
      }
    },
  )

  it('uses the bundled sidecar launcher when one is configured', () => {
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const appRoot = path.join(tmpDir, 'app-root')

    const args = buildCronCliArgs(['--print'], {
      cliPath: sidecarPath,
      appRoot,
      execPath: path.join(tmpDir, 'bun'),
      cwd: path.join(tmpDir, 'missing-cwd'),
      moduleDir: path.join(tmpDir, 'missing-module'),
      env: {},
    })

    expect(args).toEqual([
      sidecarPath,
      'cli',
      '--app-root',
      appRoot,
      '--print',
    ])
  })

  it('builds hidden CLI spawn options for scheduled task subprocesses', () => {
    const env = { CLAUDECODE: '1' }

    expect(buildCronTaskSpawnOptions('/workspace/project', env)).toEqual({
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: '/workspace/project',
      env,
      windowsHide: true,
    })
  })

  it('prefers an explicit CC_HAHA_ROOT when it points at a source checkout', async () => {
    const sourceRoot = path.join(tmpDir, 'source')
    await createSourceRoot(sourceRoot)

    expect(
      resolveCronProjectRoot({
        cwd: path.join(tmpDir, 'other'),
        moduleDir: path.join(tmpDir, 'broken', 'src', 'server', 'services'),
        env: { CC_HAHA_ROOT: sourceRoot },
      }),
    ).toBe(sourceRoot)
  })

  it('falls back to the nearest source checkout from cwd before module dir', async () => {
    const sourceRoot = path.join(tmpDir, 'source')
    const nestedCwd = path.join(sourceRoot, 'nested', 'workdir')
    await createSourceRoot(sourceRoot)
    await fs.mkdir(nestedCwd, { recursive: true })

    expect(
      resolveCronProjectRoot({
        cwd: nestedCwd,
        moduleDir: path.join(tmpDir, 'wrong', 'src', 'server', 'services'),
        env: {},
      }),
    ).toBe(sourceRoot)
  })

  unixOnly('executeTask launches the configured desktop sidecar instead of source bun', async () => {
    const binDir = path.join(tmpDir, 'bin')
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')
    const bunArgsPath = path.join(tmpDir, 'bun.args')

    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      path.join(binDir, 'bun'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${bunArgsPath}"`,
        'echo "error: Module not found \\"B:\\\\src\\\\entrypoints\\\\cli.tsx\\"" >&2',
        'exit 1',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(path.join(binDir, 'bun'), 0o755)
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"sidecar ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.PATH = binDir
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron sidecar test',
      name: 'Sidecar Task',
      recurring: true,
      folderPath: tmpDir,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('sidecar ok')

    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs.slice(0, 4)).toEqual([
      'cli',
      '--app-root',
      appRoot,
      '--print',
    ])
    expect(sidecarArgs).not.toContain(path.join('src', 'entrypoints', 'cli.tsx'))

    const bunWasCalled = await fs
      .stat(bunArgsPath)
      .then(() => true)
      .catch(() => false)
    expect(bunWasCalled).toBe(false)
  })

  unixOnly('executeTask still reaches a terminal run when a stored notification has no channel list', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"legacy ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const created = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'legacy notification shape',
      name: 'Legacy Notification Task',
      recurring: true,
      folderPath: tmpDir,
      notification: { enabled: true, channels: ['desktop'] },
    })

    // Store the shape an older writer could produce — notifications enabled but
    // no channel list — and load it back through the real read path so the
    // scheduler sees exactly what a legacy file would give it.
    const tasksFilePath = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'scheduled_tasks.json')
    const raw = JSON.parse(await fs.readFile(tasksFilePath, 'utf-8')) as {
      tasks: Array<{ notification?: Record<string, unknown> }>
    }
    delete raw.tasks[0]!.notification!.channels
    await fs.writeFile(tasksFilePath, JSON.stringify(raw, null, 2), 'utf-8')

    const reloaded = (await cronService.listTasks()).find((task) => task.id === created.id)
    expect(reloaded?.notification?.enabled).toBe(true)
    expect(reloaded?.notificationNeedsRecipients).toBe(true)

    // Before the guard this threw inside executeTask while reading
    // `.channels.length`, so a finished run was reported to the caller as a
    // rejection and no delivery status was ever recorded for it.
    const run = await scheduler.executeTask(reloaded!)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('legacy ok')
    expect(run.notificationReport?.ok).toBe(false)
    expect(run.notificationReport?.issues.map((issue) => issue.code)).toContain(
      'no_recipients_configured',
    )
  })

  unixOnly('executeTask passes provider-scoped model runtime to the sidecar', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        `env | sort > "${sidecarEnvPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"provider ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.ANTHROPIC_BASE_URL = 'https://stale-parent.example'
    process.env.ANTHROPIC_MODEL = 'stale-parent-model'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'stale-parent-entrypoint'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'

    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Provider A',
      apiKey: 'provider-key',
      baseUrl: 'https://api.provider.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'provider-main',
        haiku: 'provider-fast',
        sonnet: 'provider-main',
        opus: '',
      },
    })
    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron provider test',
      name: 'Provider Task',
      recurring: true,
      folderPath: tmpDir,
      model: 'provider-fast',
      providerId: provider.id,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('provider ok')

    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs).toContain('--model')
    expect(sidecarArgs[sidecarArgs.indexOf('--model') + 1]).toBe('provider-fast')

    const env = Object.fromEntries(
      (await fs.readFile(sidecarEnvPath, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(
      `http://127.0.0.1:3456/proxy/providers/${provider.id}`,
    )
    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(env.ANTHROPIC_MODEL).toBe('provider-fast')
    expect(env.ANTHROPIC_MODEL).not.toBe('stale-parent-model')
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
  })

  // Regression: a cron run is the one CLI that has no SDK socket, so it cannot
  // derive a desktop origin the way a conversation session does. It only ever
  // had the internal token (inherited from the server process), which left
  // `isLocalScheduledTaskApiAvailable()` false — the model could create a
  // scheduled task but the task itself could not use LocalScheduledTask /
  // LocalMessageSend. The server process now carries the loopback origin too,
  // and this child inherits it.
  unixOnly('executeTask passes the desktop loopback origin and internal token to the task child', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `env | sort > "${sidecarEnvPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"local env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    // Fixture values only — the exact shape the desktop host exports to the
    // server sidecar. Never a real token, and no network call is made.
    process.env[DESKTOP_SERVER_URL_ENV] = 'http://127.0.0.1:34561'
    process.env[LOCAL_ACCESS_TOKEN_ENV] = 'fixture-cron-local-token'

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron local tool visibility',
      name: 'Local tool task',
      recurring: true,
      folderPath: tmpDir,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('local env ok')

    const env = Object.fromEntries(
      (await fs.readFile(sidecarEnvPath, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
    expect(env[DESKTOP_SERVER_URL_ENV]).toBe('http://127.0.0.1:34561')
    expect(env[LOCAL_ACCESS_TOKEN_ENV]).toBe('fixture-cron-local-token')
    // The gate both local tools read must be satisfied by this exact env.
    expect(isLocalScheduledTaskApiAvailable(env)).toBe(true)
  })

  unixOnly('executeTask applies direct, system, and manual network settings to the sidecar', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `env | sort > "${sidecarEnvPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"network env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:7897'
    process.env.HTTP_PROXY = 'http://stale-parent.example:8080'
    process.env.HTTPS_PROXY = 'http://stale-parent.example:8080'
    process.env.http_proxy = 'http://stale-parent.example:8080'
    process.env.https_proxy = 'http://stale-parent.example:8080'

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron network env test',
      name: 'Network Env Task',
      recurring: true,
      folderPath: tmpDir,
    })
    const cases = [
      { mode: 'direct', url: '', expectedProxyUrl: '' },
      { mode: 'system', url: '', expectedProxyUrl: 'http://127.0.0.1:7897' },
      { mode: 'manual', url: ' http://127.0.0.1:7890 ', expectedProxyUrl: 'http://127.0.0.1:7890' },
    ] as const

    for (const testCase of cases) {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          network: {
            proxy: { mode: testCase.mode, url: testCase.url },
          },
        }),
        'utf-8',
      )
      resetSettingsCache()

      const run = await scheduler.executeTask(task)
      expect(run.status).toBe('completed')
      expect(run.output).toBe('network env ok')

      const env = Object.fromEntries(
        (await fs.readFile(sidecarEnvPath, 'utf-8'))
          .trim()
          .split('\n')
          .map((line) => {
            const index = line.indexOf('=')
            return [line.slice(0, index), line.slice(index + 1)]
          }),
      )
      expect(env.HTTP_PROXY).toBe(testCase.expectedProxyUrl)
      expect(env.HTTPS_PROXY).toBe(testCase.expectedProxyUrl)
      expect(env.http_proxy).toBe(testCase.expectedProxyUrl)
      expect(env.https_proxy).toBe(testCase.expectedProxyUrl)
    }
  })

  unixOnly('executeTask reloads the General team preference for each new scheduled process', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const teamEnvPath = path.join(tmpDir, 'team.env')
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
    const envKeys = [
      'CC_HAHA_AGENT_TEAMS_DEFAULT',
      'CC_HAHA_AGENT_TEAMS_ENABLED',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    ] as const
    const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(sidecarPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$CC_HAHA_AGENT_TEAMS_DEFAULT" "\${CC_HAHA_AGENT_TEAMS_ENABLED-unset}" "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" > "${teamEnvPath}"`,
      'read -r _cron_input || true',
      'printf \'%s\\n\' \'{"type":"result","result":"team env ok"}\'',
      '',
    ].join('\n'))
    await fs.chmod(sidecarPath, 0o755)
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.HOME = tmpDir
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '0'
    process.env.CC_HAHA_AGENT_TEAMS_ENABLED = '1'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'

    try {
      const cronService = new CronService()
      const scheduler = new CronScheduler(cronService)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'cron team environment test',
        recurring: true,
        folderPath: tmpDir,
      })
      for (const enabled of [undefined, true, false, undefined]) {
        await fs.writeFile(settingsPath, JSON.stringify(
          enabled === undefined ? {} : { agentTeamsEnabled: enabled },
        ))
        const run = await scheduler.executeTask(task)
        expect(run.status).toBe('completed')
        expect(run.output).toBe('team env ok')
        expect((await fs.readFile(teamEnvPath, 'utf-8')).trim().split('\n')).toEqual([
          '0',
          enabled === true ? '1' : '0',
          '0',
        ])
      }
    } finally {
      for (const key of envKeys) {
        const value = savedEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  unixOnly('executeTask launches scheduled tasks with full permissions', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"permissions ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const createSessionCalls: unknown[][] = []
    const appendSessionMetadataCalls: unknown[][] = []
    ;(scheduler as unknown as {
      sessionService: {
        createSession: (...args: unknown[]) => Promise<{ sessionId: string }>
        deleteSessionFile: (sessionId: string) => Promise<void>
        appendSessionMetadata: (...args: unknown[]) => Promise<void>
      }
    }).sessionService = {
      createSession: async (...args: unknown[]) => {
        createSessionCalls.push(args)
        return { sessionId: 'scheduled-session' }
      },
      deleteSessionFile: async () => {},
      appendSessionMetadata: async (...args: unknown[]) => {
        appendSessionMetadataCalls.push(args)
      },
    }
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron permission test',
      name: 'Permission Task',
      recurring: true,
      folderPath: tmpDir,
      permissionMode: 'default',
    })

    const run = await scheduler.executeTask(task, { createSession: true })
    const canonicalTmpDir = await fs.realpath(tmpDir)

    expect(run.status).toBe('completed')
    expect(run.sessionId).toBe('scheduled-session')
    expect(createSessionCalls).toEqual([[canonicalTmpDir, undefined, 'bypassPermissions']])
    expect(appendSessionMetadataCalls).toEqual([
      ['scheduled-session', { workDir: canonicalTmpDir, permissionMode: 'bypassPermissions' }],
    ])
    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs).toContain('--dangerously-skip-permissions')
    expect(sidecarArgs).toContain('--permission-mode')
    expect(sidecarArgs[sidecarArgs.indexOf('--permission-mode') + 1]).toBe(
      'bypassPermissions',
    )
  })

  unixOnly('executeTask inherits exported terminal shell variables', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const nvmDir = path.join(tmpDir, '.nvm')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(nodeBin, { recursive: true })
    await fs.mkdir(nvmDir, { recursive: true })
    await fs.writeFile(
      shellPath,
      [
        '#!/bin/sh',
        'command=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-c" ]; then',
        '    shift',
        '    command="$1"',
        '    break',
        '  fi',
        '  shift',
        'done',
        'if [ -f "$HOME/.zshrc" ]; then',
        '  . "$HOME/.zshrc" </dev/null >/dev/null 2>/dev/null || true',
        'fi',
        'exec /bin/sh -c "$command"',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(shellPath, 0o755)
    await fs.writeFile(
      path.join(tmpDir, '.zshrc'),
      [
        `export NVM_DIR="${nvmDir}"`,
        `export PATH="${nodeBin}:$PATH"`,
        '',
      ].join('\n'),
    )
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `env | sort > "${sidecarEnvPath}"`,
        'read -r _cron_input || true',
        'printf \'%s\\n\' \'{"type":"result","result":"shell env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    resetTerminalShellEnvironmentCacheForTests()

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron shell env test',
      name: 'Shell Env Task',
      recurring: true,
      folderPath: tmpDir,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('shell env ok')

    const env = Object.fromEntries(
      (await fs.readFile(sidecarEnvPath, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
    expect(env.NVM_DIR).toBe(nvmDir)
    expect(env.PATH.split(path.delimiter)[0]).toBe(nodeBin)
  })

  unixOnly(
    'executeTask persists the CLI terminal task notification into the automatic run runtime session',
    async () => {
      const appRoot = path.join(tmpDir, 'app-root')
      const sidecarPath = path.join(tmpDir, 'claude-sidecar')
      const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')
      const runtimeSessionId = crypto.randomUUID()
      const projectDir = path.join(
        process.env.CLAUDE_CONFIG_DIR as string,
        'projects',
        '-tmp-cron-notification',
      )
      const transcriptPath = path.join(projectDir, `${runtimeSessionId}.jsonl`)
      const sessionMetaLine = JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: tmpDir,
        timestamp: '2026-08-01T00:00:00.000Z',
      })
      const initLine = JSON.stringify({
        type: 'system',
        subtype: 'init',
        uuid: 'init-1',
        session_id: runtimeSessionId,
      })
      const notificationLine = JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        uuid: 'notification-1',
        task_id: 'background-task-1',
        tool_use_id: 'toolu_background_1',
        status: 'completed',
        summary: 'Background command finished',
        result: 'background result text',
        output_file: '/tmp/tasks/background-task-1.output',
        timestamp: '2026-08-01T00:00:05.000Z',
      })
      const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'scheduled answer',
        uuid: 'result-1',
      })

      await fs.mkdir(appRoot, { recursive: true })
      await fs.writeFile(
        sidecarPath,
        [
          '#!/bin/sh',
          `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
          'read -r _cron_input || true',
          `mkdir -p "${projectDir}"`,
          // The real CLI writes the session transcript itself; the fake process
          // emulates exactly that so the scheduler has a real JSONL to append to.
          `printf '%s\\n' '${sessionMetaLine}' >> "${transcriptPath}"`,
          `printf '%s\\n' '${initLine}'`,
          `printf '%s\\n' '${notificationLine}'`,
          `printf '%s\\n' '${resultLine}'`,
          'exit 0',
          '',
        ].join('\n'),
        'utf-8',
      )
      await fs.chmod(sidecarPath, 0o755)

      process.env.CLAUDE_CLI_PATH = sidecarPath
      process.env.CLAUDE_APP_ROOT = appRoot
      process.env.HOME = tmpDir

      const cronService = new CronService()
      const scheduler = new CronScheduler(cronService)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'cron notification persistence test',
        name: 'Notification Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task)

      expect(run.status).toBe('completed')
      expect(run.output).toBe('scheduled answer')
      // An automatic run still creates no session of its own and passes no
      // --session-id; the runtime id comes from the CLI stream.
      expect(run.sessionId).toBeUndefined()
      const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
        .trim()
        .split('\n')
      expect(sidecarArgs).not.toContain('--session-id')

      const entries = (await fs.readFile(transcriptPath, 'utf-8'))
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const notifications = entries.filter(
        (entry) => entry.type === 'cc-haha-task-notification',
      )
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).toEqual({
        type: 'cc-haha-task-notification',
        isMeta: true,
        taskNotification: {
          taskId: 'background-task-1',
          toolUseId: 'toolu_background_1',
          status: 'completed',
          summary: 'Background command finished',
          result: 'background result text',
          outputFile: '/tmp/tasks/background-task-1.output',
          timestamp: '2026-08-01T00:00:05.000Z',
        },
        timestamp: '2026-08-01T00:00:05.000Z',
      })
    },
  )

  // ─── Scheduled-run task-notification boundaries ────────────────────────────
  //
  // Everything below drives the real `executeTask` against a fake CLI process
  // and reads the resulting JSONL, so the stream parsing, the session
  // attribution, and the persistence outcome are all exercised end to end.

  /** Read the persisted task notifications out of one session transcript. */
  async function readPersistedNotifications(
    projectDirName: string,
    sessionId: string,
  ): Promise<Array<{ entry: Record<string, any>; notification: Record<string, any> }>> {
    const transcriptPath = path.join(
      process.env.CLAUDE_CONFIG_DIR as string,
      'projects',
      projectDirName,
      `${sessionId}.jsonl`,
    )
    const raw = await fs.readFile(transcriptPath, 'utf-8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((entry) => entry.type === 'cc-haha-task-notification')
      .map((entry) => ({ entry, notification: entry.taskNotification }))
  }

  /** Write a fake CLI that emits exactly the given stdout fragments, in order. */
  async function writeFakeCli(
    name: string,
    emits: Array<{ printf: string; args: string[] }>,
  ): Promise<string> {
    const cliPath = path.join(tmpDir, name)
    await fs.writeFile(
      cliPath,
      [
        '#!/bin/sh',
        'read -r _cron_input || true',
        ...emits.map((emit) => `printf '${emit.printf}' ${emit.args.join(' ')}`),
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(cliPath, 0o755)
    return cliPath
  }

  /** Install a fake CLI and return the scheduler wired to a temporary config. */
  async function launchSchedulerWithCli(cliPath: string) {
    const appRoot = path.join(tmpDir, 'app-root')
    await fs.mkdir(appRoot, { recursive: true })
    process.env.CLAUDE_CLI_PATH = cliPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.HOME = tmpDir
    const cronService = new CronService()
    return { cronService, scheduler: new CronScheduler(cronService) }
  }

  /** One `writeFakeCli` emit: a shell-quoted JSON record and a newline. */
  const emit = (record: unknown) => ({
    printf: '%s\\n',
    args: [`'${JSON.stringify(record).replace(/'/g, "'\\''")}'`],
  })

  /** The fields of a `task_notification` record the scheduler reads. */
  const notificationRecord = (
    uuid: string,
    fields: {
      taskId: string
      toolUseId: string
      sessionId?: string
      status?: string
      outputFile?: string
      ownerAgentId?: string
      parentToolUseId?: string
    },
  ) => ({
    type: 'system',
    subtype: 'task_notification',
    uuid,
    task_id: fields.taskId,
    tool_use_id: fields.toolUseId,
    status: fields.status ?? 'completed',
    summary: `${fields.taskId} finished`,
    ...(fields.outputFile ? { output_file: fields.outputFile } : {}),
    ...(fields.sessionId ? { session_id: fields.sessionId } : {}),
    ...(fields.ownerAgentId ? { owner_agent_id: fields.ownerAgentId } : {}),
    ...(fields.parentToolUseId
      ? { parent_tool_use_id: fields.parentToolUseId }
      : {}),
    timestamp: '2026-08-11T00:00:01.000Z',
  })

  const initRecord = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'init',
    uuid: 'init-record',
    session_id: sessionId,
    ...extra,
  })

  const resultRecord = (
    result: string,
    extra: Record<string, unknown> = {},
  ) => ({ type: 'result', subtype: 'success', result, ...extra })

  /**
   * Create the project dir and transcript a fake CLI's session lives in, and
   * return the project dir so a caller can assert what did *not* land there.
   */
  async function createTranscript(
    projectDirName: string,
    sessionId: string,
  ): Promise<string> {
    const projectDir = path.join(
      process.env.CLAUDE_CONFIG_DIR as string,
      'projects',
      projectDirName,
    )
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'session-meta', isMeta: true, workDir: tmpDir, timestamp: '2026-08-11T00:00:00.000Z' })}\n`,
      'utf-8',
    )
    return projectDir
  }

  /** Create a task in the temporary work dir and run it once. */
  async function executeFakeCli(cliPath: string, name: string) {
    const { cronService, scheduler } = await launchSchedulerWithCli(cliPath)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: `${name} notification test`,
      name,
      recurring: true,
      folderPath: tmpDir,
    })
    return await scheduler.executeTask(task)
  }

  /**
   * A fake CLI that leaves its stdout write end open after exiting, by way of a
   * descendant holding it. EOF therefore never arrives inside the drain window,
   * which is exactly the case the window exists for.
   */
  async function writeFakeCliWithInheritedStdout(
    name: string,
    emits: Array<{ printf: string; args: string[] }>,
    trailingLines: string[] = [],
  ): Promise<string> {
    const cliPath = path.join(tmpDir, name)
    await fs.writeFile(
      cliPath,
      [
        '#!/bin/sh',
        'read -r _cron_input || true',
        ...emits.map((emit) => `printf '${emit.printf}' ${emit.args.join(' ')}`),
        ...trailingLines,
        '( sleep 5 ) &',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(cliPath, 0o755)
    return cliPath
  }

  /** The same JSON record `emit` produces, but with no trailing newline. */
  const emitWithoutNewline = (record: unknown) => ({
    printf: '%s',
    args: [`'${JSON.stringify(record).replace(/'/g, "'\\''")}'`],
  })

  unixOnly(
    'reassembles chunked UTF-8, a trailing record without a newline, and a notification before the result',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-chunked'
      const projectDir = path.join(
        process.env.CLAUDE_CONFIG_DIR as string,
        'projects',
        projectDirName,
      )
      await fs.mkdir(projectDir, { recursive: true })
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: 'session-meta', isMeta: true, workDir: tmpDir, timestamp: '2026-08-02T00:00:00.000Z' })}\n`,
        'utf-8',
      )

      // The notification summary holds a multi-byte character that the fake CLI
      // splits across two writes; the final result record has no trailing
      // newline, which is what a CLI that exits immediately after its result
      // actually produces.
      const notificationLine = JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        uuid: 'notification-chunked',
        task_id: 'chunked-task',
        tool_use_id: 'toolu_chunked',
        status: 'completed',
        summary: 'splitted utf8 \u00e9 summary',
        timestamp: '2026-08-02T00:00:01.000Z',
      })
      const splitAt = notificationLine.indexOf('\u00e9')
      const beforeChar = notificationLine.slice(0, splitAt)
      const afterChar = notificationLine.slice(splitAt + 1)
      const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'chunked answer',
      })

      const cliPath = await writeFakeCli('chunked-sidecar', [
        {
          printf: '%s\\n',
          args: [`'${JSON.stringify({ type: 'system', subtype: 'init', uuid: 'init-chunked', session_id: sessionId })}'`],
        },
        { printf: '%s', args: [`'${beforeChar.replace(/'/g, "'\\''")}'`] },
        { printf: '\\303', args: [] },
        { printf: '\\251', args: [] },
        { printf: '%s\\n', args: [`'${afterChar.replace(/'/g, "'\\''")}'`] },
        // No trailing newline on the last record.
        { printf: '%s', args: [`'${resultLine.replace(/'/g, "'\\''")}'`] },
      ])
      const { cronService, scheduler } = await launchSchedulerWithCli(cliPath)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'chunked notification test',
        name: 'Chunked Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task)

      expect(run.status).toBe('completed')
      expect(run.output).toBe('chunked answer')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.notification).toMatchObject({
        taskId: 'chunked-task',
        toolUseId: 'toolu_chunked',
        status: 'completed',
        summary: 'splitted utf8 \u00e9 summary',
      })
    },
  )

  unixOnly(
    'keeps one entry per terminal when the CLI repeats it, and rejects a contradicting status',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-dedupe'
      await createTranscript(projectDirName, sessionId)

      // A re-report of one terminal carries the same task id, so both events
      // resolve to the same identity within the run.
      const notification = (uuid: string, status: string, toolUseId: string) =>
        emit(
          notificationRecord(uuid, {
            taskId: `task-${toolUseId}`,
            toolUseId,
            status,
          }),
        )

      // Same terminal reported under three different event uuids: the same
      // terminal state must land in the transcript exactly once. A fourth event
      // contradicts it and must fail the run rather than be silently dropped.
      const cliPath = await writeFakeCli('dedupe-sidecar', [
        emit(initRecord(sessionId)),
        notification('event-a', 'completed', 'toolu_same_terminal'),
        notification('event-b', 'completed', 'toolu_same_terminal'),
        notification('event-c', 'completed', 'toolu_same_terminal'),
        notification('event-d', 'failed', 'toolu_same_terminal'),
        // A distinct terminal with the same leaf shape is still its own entry.
        notification('event-e', 'completed', 'toolu_other_terminal'),
        // `failed` and `killed` (normalized to `stopped`) are the other two
        // terminal states the CLI reports.
        notification('event-f', 'failed', 'toolu_failed_terminal'),
        notification('event-g', 'killed', 'toolu_killed_terminal'),
        emit(resultRecord('dedupe answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Dedupe Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain('changed from completed to failed')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(
        persisted.map((entry) => ({
          toolUseId: entry.notification.toolUseId,
          status: entry.notification.status,
        })),
      ).toEqual(
        expect.arrayContaining([
          { toolUseId: 'toolu_same_terminal', status: 'completed' },
          { toolUseId: 'toolu_other_terminal', status: 'completed' },
          { toolUseId: 'toolu_failed_terminal', status: 'failed' },
          // `killed` normalizes to `stopped`, the same as the websocket path.
          { toolUseId: 'toolu_killed_terminal', status: 'stopped' },
        ]),
      )
      expect(persisted).toHaveLength(4)
    },
  )

  unixOnly(
    'persists an owned notification under its child owner and never treats a nested init/result as the root',
    async () => {
      const sessionId = crypto.randomUUID()
      const childSessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-owned'
      const projectDir = await createTranscript(projectDirName, sessionId)

      const cliPath = await writeFakeCli('owned-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-root' })),
        // A nested init naming a different session must not become the root
        // session (and must not be reported as a conflicting root id either).
        emit(
          initRecord(childSessionId, {
            uuid: 'init-child',
            parent_tool_use_id: 'toolu_agent_root',
          }),
        ),
        // A nested result is a child's result, not the run's.
        emit(
          resultRecord('child result', {
            parent_tool_use_id: 'toolu_agent_root',
          }),
        ),
        emit(
          notificationRecord('notification-child', {
            taskId: 'child-task',
            toolUseId: 'Agent:0',
            ownerAgentId: 'child-a',
            parentToolUseId: 'toolu_agent_root',
            status: 'stopped',
          }),
        ),
        // A root notification reusing the same leaf tool id stays its own entry.
        emit(
          notificationRecord('notification-root', {
            taskId: 'root-task',
            toolUseId: 'Agent:0',
          }),
        ),
        // A second child owner reusing the very same leaf id is a third entry.
        emit(
          notificationRecord('notification-child-b', {
            taskId: 'child-b-task',
            toolUseId: 'Agent:0',
            ownerAgentId: 'child-b',
            parentToolUseId: 'toolu_agent_root',
            status: 'failed',
          }),
        ),
        emit(resultRecord('owned answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Owned Task')

      expect(run.status).toBe('completed')
      // A child's result text is still part of the raw stream (pre-existing
      // extraction behaviour); what must not happen is treating that result as
      // the root for session attribution.
      expect(run.output).toContain('owned answer')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted.map((entry) => entry.notification)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'child-task',
            toolUseId: 'Agent:0',
            ownerAgentId: 'child-a',
            status: 'stopped',
          }),
          expect.objectContaining({
            taskId: 'root-task',
            toolUseId: 'Agent:0',
            status: 'completed',
          }),
          expect.objectContaining({
            taskId: 'child-b-task',
            toolUseId: 'Agent:0',
            ownerAgentId: 'child-b',
            status: 'failed',
          }),
        ]),
      )
      expect(persisted).toHaveLength(3)
      // Nothing was written against the child's own session id.
      await expect(
        fs.readFile(path.join(projectDir, `${childSessionId}.jsonl`), 'utf-8'),
      ).rejects.toThrow()
    },
  )

  unixOnly(
    'persists a notification that arrives after the root result and ignores progress events',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-after-result'
      await createTranscript(projectDirName, sessionId)

      const notification = (status: string, toolUseId: string) =>
        emit(
          notificationRecord(`notification-${status}`, {
            taskId: `task-${toolUseId}`,
            toolUseId,
            status,
          }),
        )

      const cliPath = await writeFakeCli('after-result-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-after' })),
        // A progress event is not a terminal state and is never persisted.
        notification('running', 'toolu_progress'),
        emit(resultRecord('after answer')),
        // The result ends the turn, not the stream.
        notification('completed', 'toolu_after_result'),
      ])
      const run = await executeFakeCli(cliPath, 'After Result Task')

      expect(run.status).toBe('completed')
      expect(run.output).toBe('after answer')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted.map((entry) => entry.notification)).toEqual([
        expect.objectContaining({ toolUseId: 'toolu_after_result', status: 'completed' }),
      ])
    },
  )

  unixOnly(
    'waits for a slow notification write instead of settling the run without it',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-slow-write'
      await createTranscript(projectDirName, sessionId)

      const cliPath = await writeFakeCli('slow-write-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-slow' })),
        emit(
          notificationRecord('notification-slow', {
            taskId: 'slow-task',
            toolUseId: 'toolu_slow',
          }),
        ),
        emit(resultRecord('slow answer')),
      ])

      // A transcript append that takes ~300 ms: still well inside the settle
      // bound, and the run must not finish before the terminal state landed.
      const realOpen = fs.open
      spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args)
        if (typeof args[1] !== 'number' || (args[1] & constants.O_APPEND) === 0) return handle
        const realWriteFile = handle.writeFile.bind(handle)
        spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
          await Bun.sleep(300)
          return realWriteFile(...writeArgs as Parameters<typeof realWriteFile>)
        })
        return handle
      })

      const run = await executeFakeCli(cliPath, 'Slow Write Task')

      expect(run.status).toBe('completed')
      expect(run.output).toBe('slow answer')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted.map((entry) => entry.notification)).toEqual([
        expect.objectContaining({ taskId: 'slow-task', toolUseId: 'toolu_slow' }),
      ])
    },
  )

  unixOnly(
    'fails the run when a terminal notification cannot be persisted',
    async () => {
      // A well-formed runtime id with no transcript on disk: the session was
      // cleared or never materialized, so its terminal state has nowhere to go.
      const sessionId = crypto.randomUUID()
      const cliPath = await writeFakeCli('unpersistable-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-missing' })),
        emit(
          notificationRecord('notification-missing', {
            taskId: 'missing-task',
            toolUseId: 'toolu_missing',
          }),
        ),
        emit(resultRecord('unpersistable answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Unpersistable Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain('Failed to persist scheduled task notification')
      expect(run.error).toContain('missing-task')
      // The transcript was not created as a side effect.
      expect(await new SessionService().findSessionFile(sessionId)).toBeNull()
    },
  )

  unixOnly(
    'writes notifications into the manual session the run passed to the CLI',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-manual'
      await createTranscript(projectDirName, sessionId)

      const argsPath = path.join(tmpDir, 'manual.args')
      const cliPath = await writeFakeCli('manual-sidecar', [
        { printf: '%s\\n', args: [`"$@" > "${argsPath}"`] },
        emit(initRecord(sessionId, { uuid: 'init-manual' })),
        emit(
          notificationRecord('notification-manual', {
            taskId: 'manual-task',
            toolUseId: 'toolu_manual',
            status: 'killed',
          }),
        ),
        emit(resultRecord('manual answer')),
      ])
      const { cronService, scheduler } = await launchSchedulerWithCli(cliPath)
      // Only the session creation boundary is faked; the append under test is
      // the real one, writing the real JSONL.
      const realSessionService = (scheduler as unknown as {
        sessionService: SessionService
      }).sessionService
      spyOn(realSessionService, 'createSession').mockResolvedValue({ sessionId } as never)
      spyOn(realSessionService, 'deleteSessionFile').mockResolvedValue(undefined)
      spyOn(realSessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'manual notification test',
        name: 'Manual Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task, { createSession: true })

      expect(run.status).toBe('completed')
      expect(run.sessionId).toBe(sessionId)
      const args = (await fs.readFile(argsPath, 'utf-8')).trim().split('\n')
      expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId)
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted.map((entry) => entry.notification)).toEqual([
        expect.objectContaining({
          taskId: 'manual-task',
          toolUseId: 'toolu_manual',
          // `killed` normalizes to `stopped`, the same as the websocket path.
          status: 'stopped',
        }),
      ])
    },
  )

  unixOnly(
    'refuses a manual run whose CLI reports a different session id',
    async () => {
      const requestedSessionId = crypto.randomUUID()
      const reportedSessionId = crypto.randomUUID()
      const requestedProjectDir = '-tmp-cron-notification-manual-mismatch'
      const reportedProjectDir = '-tmp-cron-notification-manual-reported'
      await createTranscript(requestedProjectDir, requestedSessionId)
      await createTranscript(reportedProjectDir, reportedSessionId)

      const cliPath = await writeFakeCli('manual-mismatch-sidecar', [
        emit(initRecord(reportedSessionId, { uuid: 'init-mismatch' })),
        emit(
          notificationRecord('notification-mismatch', {
            taskId: 'mismatch-task',
            toolUseId: 'toolu_mismatch',
          }),
        ),
        emit(resultRecord('mismatch answer')),
      ])
      const { cronService, scheduler } = await launchSchedulerWithCli(cliPath)
      const realSessionService = (scheduler as unknown as {
        sessionService: SessionService
      }).sessionService
      spyOn(realSessionService, 'createSession').mockResolvedValue({
        sessionId: requestedSessionId,
      } as never)
      spyOn(realSessionService, 'deleteSessionFile').mockResolvedValue(undefined)
      spyOn(realSessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'manual mismatch test',
        name: 'Manual Mismatch Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task, { createSession: true })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('instead of the requested')
      expect(await readPersistedNotifications(requestedProjectDir, requestedSessionId))
        .toHaveLength(0)
      expect(await readPersistedNotifications(reportedProjectDir, reportedSessionId))
        .toHaveLength(0)
    },
  )

  // ─── Session attribution across the root init / root result ─────────────────
  //
  // The CLI stamps every message it emits with the id of the session that
  // produced it, so a terminal notification may only be written once the run's
  // own root session is known and agrees with it. These cases drive that
  // boundary through a real child process and the real JSONL writer.

  unixOnly(
    'refuses a notification naming a session other than the root init session, root-owned and child-owned alike',
    async () => {
      const rootSessionId = crypto.randomUUID()
      const foreignSessionId = crypto.randomUUID()
      const rootProjectDir = '-tmp-cron-notification-foreign-root'
      const foreignProjectDir = '-tmp-cron-notification-foreign-target'
      await createTranscript(rootProjectDir, rootSessionId)
      await createTranscript(foreignProjectDir, foreignSessionId)

      const cliPath = await writeFakeCli('foreign-session-sidecar', [
        emit(initRecord(rootSessionId)),
        emit(
          notificationRecord('notification-foreign-root', {
            taskId: 'foreign-root-task',
            toolUseId: 'toolu_foreign_root',
            sessionId: foreignSessionId,
          }),
        ),
        // Ownership makes no difference: a child-owned terminal claiming a
        // foreign session is refused exactly the same way.
        emit(
          notificationRecord('notification-foreign-child', {
            taskId: 'foreign-child-task',
            toolUseId: 'Agent:0',
            sessionId: foreignSessionId,
            ownerAgentId: 'child-a',
            parentToolUseId: 'toolu_agent_parent',
          }),
        ),
        emit(resultRecord('foreign answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Foreign Session Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain('instead of the run session')
      expect(await readPersistedNotifications(rootProjectDir, rootSessionId))
        .toHaveLength(0)
      // The named session is not a fallback home either.
      expect(await readPersistedNotifications(foreignProjectDir, foreignSessionId))
        .toHaveLength(0)
    },
  )

  unixOnly(
    'fails a run whose notification reports an unusable session id instead of writing it anywhere',
    async () => {
      const rootSessionId = crypto.randomUUID()
      const projectDir = '-tmp-cron-notification-unusable-claim'
      await createTranscript(projectDir, rootSessionId)

      const cliPath = await writeFakeCli('unusable-claim-sidecar', [
        emit(initRecord(rootSessionId)),
        emit(
          notificationRecord('notification-unusable', {
            taskId: 'unusable-task',
            toolUseId: 'toolu_unusable',
            sessionId: 'not-a-session-id',
          }),
        ),
        emit(resultRecord('unusable answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Unusable Claim Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain('unusable session id')
      expect(await readPersistedNotifications(projectDir, rootSessionId))
        .toHaveLength(0)
    },
  )

  unixOnly(
    'never lets a child init or child result define the run session',
    async () => {
      const rootSessionId = crypto.randomUUID()
      const childInitSessionId = crypto.randomUUID()
      const childResultSessionId = crypto.randomUUID()
      const rootProjectDir = '-tmp-cron-notification-child-attribution'
      const childInitProjectDir = '-tmp-cron-notification-child-init'
      const childResultProjectDir = '-tmp-cron-notification-child-result'
      await createTranscript(rootProjectDir, rootSessionId)
      await createTranscript(childInitProjectDir, childInitSessionId)
      await createTranscript(childResultProjectDir, childResultSessionId)

      const cliPath = await writeFakeCli('child-attribution-sidecar', [
        emit(initRecord(rootSessionId)),
        // A child init and a child result name sessions of their own; neither
        // may become — or contradict — the run's session.
        emit(
          initRecord(childInitSessionId, {
            uuid: 'init-child',
            parent_tool_use_id: 'toolu_agent_parent',
          }),
        ),
        emit(
          resultRecord('child result', {
            session_id: childResultSessionId,
            parent_tool_use_id: 'toolu_agent_parent',
          }),
        ),
        emit(
          notificationRecord('notification-root-owned', {
            taskId: 'root-owned-task',
            toolUseId: 'toolu_root_owned',
            sessionId: rootSessionId,
          }),
        ),
        emit(resultRecord('child attribution answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Child Attribution Task')

      expect(run.status).toBe('completed')
      const persisted = await readPersistedNotifications(rootProjectDir, rootSessionId)
      expect(persisted.map((entry) => entry.notification.taskId))
        .toEqual(['root-owned-task'])
      expect(await readPersistedNotifications(childInitProjectDir, childInitSessionId))
        .toHaveLength(0)
      expect(await readPersistedNotifications(childResultProjectDir, childResultSessionId))
        .toHaveLength(0)
    },
  )

  unixOnly(
    'holds a terminal state until the root confirms its session, and fails rather than guessing',
    async () => {
      // No root message ever names a session, so the claim is all the stream
      // offers. That is not enough to write to: the run fails and neither the
      // claimed session nor the child's own session is touched.
      const claimedSessionId = crypto.randomUUID()
      const childSessionId = crypto.randomUUID()
      const claimedProjectDir = '-tmp-cron-notification-unconfirmed'
      const childProjectDir = '-tmp-cron-notification-unconfirmed-child'
      await createTranscript(claimedProjectDir, claimedSessionId)
      await createTranscript(childProjectDir, childSessionId)

      const cliPath = await writeFakeCli('unconfirmed-session-sidecar', [
        emit(
          initRecord(childSessionId, {
            uuid: 'init-child-only',
            parent_tool_use_id: 'toolu_agent_parent',
          }),
        ),
        emit(
          notificationRecord('notification-unconfirmed', {
            taskId: 'unconfirmed-task',
            toolUseId: 'toolu_unconfirmed',
            sessionId: claimedSessionId,
          }),
        ),
      ])
      const run = await executeFakeCli(cliPath, 'Unconfirmed Session Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain(
        'could not attribute the task notification for unconfirmed-task',
      )
      expect(await readPersistedNotifications(claimedProjectDir, claimedSessionId))
        .toHaveLength(0)
      expect(await readPersistedNotifications(childProjectDir, childSessionId))
        .toHaveLength(0)
    },
  )

  unixOnly(
    'learns the run session from the root result when the stream carries no init, before and after that result',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDir = '-tmp-cron-notification-result-only'
      await createTranscript(projectDir, sessionId)

      const cliPath = await writeFakeCli('result-only-sidecar', [
        // Seen before the run knows its session: held until the root result
        // confirms the session it claims.
        emit(
          notificationRecord('notification-before-result', {
            taskId: 'before-result-task',
            toolUseId: 'toolu_before_result',
            sessionId,
          }),
        ),
        emit(resultRecord('result-only answer', { session_id: sessionId })),
        // The result ends the turn, not the stream.
        emit(
          notificationRecord('notification-after-result', {
            taskId: 'after-result-task',
            toolUseId: 'toolu_after_result',
          }),
        ),
      ])
      const run = await executeFakeCli(cliPath, 'Result Only Task')

      expect(run.status).toBe('completed')
      expect(run.output).toBe('result-only answer')
      const persisted = await readPersistedNotifications(projectDir, sessionId)
      expect(persisted).toHaveLength(2)
      expect(persisted.map((entry) => entry.notification.taskId))
        .toEqual(
          expect.arrayContaining(['before-result-task', 'after-result-task']),
        )
    },
  )

  unixOnly(
    'fails a manual run immediately when the root result reports a different session id',
    async () => {
      const requestedSessionId = crypto.randomUUID()
      const reportedSessionId = crypto.randomUUID()
      const requestedProjectDir = '-tmp-cron-notification-manual-result-mismatch'
      const reportedProjectDir = '-tmp-cron-notification-manual-result-reported'
      await createTranscript(requestedProjectDir, requestedSessionId)
      await createTranscript(reportedProjectDir, reportedSessionId)

      const cliPath = await writeFakeCli('manual-result-mismatch-sidecar', [
        // The init agrees with the requested session; the result does not.
        emit(initRecord(requestedSessionId)),
        emit(
          resultRecord('mismatch answer', { session_id: reportedSessionId }),
        ),
        // A terminal state observed after the contradiction is not accepted:
        // the stream is no longer trusted for attribution.
        emit(
          notificationRecord('notification-after-refutation', {
            taskId: 'after-refutation-task',
            toolUseId: 'toolu_after_refutation',
          }),
        ),
      ])
      const { cronService, scheduler } = await launchSchedulerWithCli(cliPath)
      const realSessionService = (
        scheduler as unknown as { sessionService: SessionService }
      ).sessionService
      spyOn(realSessionService, 'createSession').mockResolvedValue({
        sessionId: requestedSessionId,
      } as never)
      spyOn(realSessionService, 'deleteSessionFile').mockResolvedValue(undefined)
      spyOn(realSessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'manual result mismatch test',
        name: 'Manual Result Mismatch Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task, { createSession: true })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('instead of the requested')
      expect(await readPersistedNotifications(requestedProjectDir, requestedSessionId))
        .toHaveLength(0)
      expect(await readPersistedNotifications(reportedProjectDir, reportedSessionId))
        .toHaveLength(0)
    },
  )

  // ─── Terminal identity: task id plus owner and leaf tool id ────────────────

  unixOnly(
    'keeps one entry per task when several tasks report through one shared tool id',
    async () => {
      // A single Agent tool call can spawn several tasks that all report the
      // same leaf tool id. Each is its own terminal, so none of them may be
      // swallowed as a duplicate of the other.
      const sessionId = crypto.randomUUID()
      const projectDir = '-tmp-cron-notification-shared-tool'
      await createTranscript(projectDir, sessionId)

      const cliPath = await writeFakeCli('shared-tool-sidecar', [
        emit(initRecord(sessionId)),
        emit(
          notificationRecord('notification-shared-1', {
            taskId: 'shared-task-1',
            toolUseId: 'toolu_shared_parent_call',
            outputFile: '/tmp/tasks/shared-1.output',
          }),
        ),
        emit(
          notificationRecord('notification-shared-2', {
            taskId: 'shared-task-2',
            toolUseId: 'toolu_shared_parent_call',
            outputFile: '/tmp/tasks/shared-2.output',
          }),
        ),
        emit(resultRecord('shared tool answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Shared Tool Task')

      expect(run.status).toBe('completed')
      const persisted = await readPersistedNotifications(projectDir, sessionId)
      expect(persisted).toHaveLength(2)
      expect(persisted.map((entry) => entry.notification.taskId))
        .toEqual(
          expect.arrayContaining(['shared-task-1', 'shared-task-2']),
        )
    },
  )

  unixOnly(
    'fails a run when one task is re-reported with a conflicting output file',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDir = '-tmp-cron-notification-conflicting-payload'
      await createTranscript(projectDir, sessionId)

      const cliPath = await writeFakeCli('conflicting-payload-sidecar', [
        emit(initRecord(sessionId)),
        emit(
          notificationRecord('notification-conflict-a', {
            taskId: 'conflict-task',
            toolUseId: 'toolu_conflict',
            outputFile: '/tmp/tasks/conflict-first.output',
          }),
        ),
        // Same task, same owner, same leaf tool id and same status, but a
        // different output file: the transcript must not silently keep one and
        // drop the other.
        emit(
          notificationRecord('notification-conflict-b', {
            taskId: 'conflict-task',
            toolUseId: 'toolu_conflict',
            outputFile: '/tmp/tasks/conflict-second.output',
          }),
        ),
        emit(resultRecord('conflict answer')),
      ])
      const run = await executeFakeCli(cliPath, 'Conflicting Payload Task')

      expect(run.status).toBe('failed')
      expect(run.error).toContain('terminal data for conflict-task conflicts')
      const persisted = await readPersistedNotifications(projectDir, sessionId)
      expect(persisted.map((entry) => entry.notification.outputFile))
        .toEqual(['/tmp/tasks/conflict-first.output'])
    },
  )

  // ─── Drain timeout: sealing the stream instead of dropping its tail ─────────
  //
  // A descendant that inherits stdout keeps the pipe open past the drain window.
  // The run must then stop accepting events and still persist a complete record
  // it had already read, instead of finishing without it — and it must await
  // that append, whatever the append's outcome is.

  unixOnly(
    'persists a complete record the drain window cut off and awaits its slow append',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-drain-slow'
      await createTranscript(projectDirName, sessionId)

      const cliPath = await writeFakeCliWithInheritedStdout('drain-slow-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-drain-slow' })),
        emit(resultRecord('drain answer')),
        // The final record has no trailing newline, so it is still held in the
        // reader when the drain window runs out.
        emitWithoutNewline(
          notificationRecord('notification-drain-slow', {
            taskId: 'drain-slow-task',
            toolUseId: 'toolu_drain_slow',
          }),
        ),
      ])

      // An append that takes ~300 ms: the run must not report its terminal
      // record before the handed-over notification reached the transcript.
      const realOpen = fs.open
      spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args)
        if (typeof args[1] !== 'number' || (args[1] & constants.O_APPEND) === 0) return handle
        const realWriteFile = handle.writeFile.bind(handle)
        spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
          await Bun.sleep(300)
          return realWriteFile(...writeArgs as Parameters<typeof realWriteFile>)
        })
        return handle
      })

      const startedAt = Date.now()
      const run = await executeFakeCli(cliPath, 'Drain Slow Task')
      const elapsed = Date.now() - startedAt

      expect(run.status).toBe('completed')
      expect(run.output).toBe('drain answer')
      const persisted = await readPersistedNotifications(projectDirName, sessionId)
      expect(persisted.map((entry) => entry.notification)).toEqual([
        expect.objectContaining({
          taskId: 'drain-slow-task',
          toolUseId: 'toolu_drain_slow',
          status: 'completed',
        }),
      ])
      // The drain window and the append it handed over stayed bounded.
      expect(elapsed).toBeLessThan(2_500)
    },
  )

  unixOnly(
    'fails the run when the record the drain window handed over cannot be persisted',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-drain-reject'
      await createTranscript(projectDirName, sessionId)

      const cliPath = await writeFakeCliWithInheritedStdout('drain-reject-sidecar', [
        emit(initRecord(sessionId, { uuid: 'init-drain-reject' })),
        emit(resultRecord('drain reject answer')),
        emitWithoutNewline(
          notificationRecord('notification-drain-reject', {
            taskId: 'drain-reject-task',
            toolUseId: 'toolu_drain_reject',
          }),
        ),
      ])
      const realOpen = fs.open
      spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args)
        if (typeof args[1] !== 'number' || (args[1] & constants.O_APPEND) === 0) return handle
        spyOn(handle, 'writeFile').mockImplementation(() =>
          Promise.reject(new Error('notification disk full')),
        )
        return handle
      })

      const run = await executeFakeCli(cliPath, 'Drain Reject Task')

      // A terminal state that never reached the transcript is a failed run, not
      // a silent success.
      expect(run.status).toBe('failed')
      expect(run.error).toContain('Failed to persist scheduled task notification')
      expect(run.error).toContain('drain-reject-task')
      expect(await readPersistedNotifications(projectDirName, sessionId)).toHaveLength(0)
    },
  )

  unixOnly(
    'accepts no event from the stream after the drain window sealed it',
    async () => {
      const sessionId = crypto.randomUUID()
      const projectDirName = '-tmp-cron-notification-drain-late'
      await createTranscript(projectDirName, sessionId)

      // A descendant writes one more terminal state about a second after the run
      // loop is gone. The run already settled by then, so that event must not be
      // persisted: nothing may be written once the run stopped accepting events.
      const lateNotification = notificationRecord('notification-drain-late', {
        taskId: 'drain-late-task',
        toolUseId: 'toolu_drain_late',
        sessionId,
      })
      const cliPath = await writeFakeCliWithInheritedStdout(
        'drain-late-sidecar',
        [
          emit(initRecord(sessionId, { uuid: 'init-drain-late' })),
          emit(resultRecord('drain late answer')),
        ],
        [
          `( sleep 1.5; printf '%s\\n' '${JSON.stringify(lateNotification).replace(/'/g, "'\\''")}' ) &`,
        ],
      )

      const run = await executeFakeCli(cliPath, 'Drain Late Task')
      expect(run.status).toBe('completed')

      // Far enough past the descendant's write for it to have landed had the
      // stream still been accepted.
      await Bun.sleep(1_200)
      expect(await readPersistedNotifications(projectDirName, sessionId)).toHaveLength(0)
    },
  )
})
