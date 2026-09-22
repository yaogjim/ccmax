import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const CLI_SCRIPTS = ['ccmax', 'claude-haha', 'cc-haha'] as const
const PHYSICAL_WRAPPERS = ['bin/ccmax', 'bin/claude-haha'] as const

async function runCli(args: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'ccmax-cli-launcher-'))
  const configDir = path.join(tempRoot, 'config')
  const homeDir = path.join(tempRoot, 'home')
  const pathDir = path.join(tempRoot, 'bin')
  await mkdir(configDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(pathDir, { recursive: true })

  try {
    const child = Bun.spawn(args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        CC_HAHA_SKIP_DOTENV: '1',
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir,
        XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(homeDir, '.config'),
        XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
        PATH: [pathDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    return { stdout, stderr, exitCode }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function expectCcmaxVersionIdentity(stdout: string): void {
  expect(stdout).toContain('ccmax')
  expect(stdout).not.toContain('(Claude Code)')
}

function expectCcmaxHelpIdentity(stdout: string): void {
  expect(stdout).toContain('Usage: ccmax')
  expect(stdout).toContain('ccmax - starts an interactive session')
  expect(stdout).not.toContain('Usage: claude')
  expect(stdout).not.toContain('Claude Code - starts')
}

for (const script of CLI_SCRIPTS) {
  test(`public CLI script "${script}" prints ccmax version identity`, async () => {
    const { stdout, stderr, exitCode } = await runCli([
      process.execPath,
      '--no-env-file',
      'run',
      script,
      '--version',
    ])

    expect(exitCode, stderr).toBe(0)
    expectCcmaxVersionIdentity(stdout)
  })
}

for (const wrapper of PHYSICAL_WRAPPERS) {
  test(`physical CLI wrapper "${wrapper}" prints ccmax version identity`, async () => {
    const { stdout, stderr, exitCode } = await runCli([
      process.execPath,
      '--no-env-file',
      path.join(repoRoot, wrapper),
      '--version',
    ])

    expect(exitCode, stderr).toBe(0)
    expectCcmaxVersionIdentity(stdout)
  })

  test(`physical CLI wrapper "${wrapper}" prints ccmax help identity`, async () => {
    const { stdout, stderr, exitCode } = await runCli([
      process.execPath,
      '--no-env-file',
      path.join(repoRoot, wrapper),
      '--help',
    ])

    expect(exitCode, stderr).toBe(0)
    expectCcmaxHelpIdentity(stdout)
  }, 20000)

  test(`physical CLI wrapper "${wrapper}" rejects an unknown deep-link action without launching a terminal`, async () => {
    const startedAt = Date.now()
    const { stdout, stderr, exitCode } = await runCli([
      process.execPath,
      '--no-env-file',
      path.join(repoRoot, wrapper),
      '--handle-uri',
      'ccmax://not-open?q=hello',
    ])

    expect(exitCode, `${stdout}\n${stderr}`).toBe(1)
    expect(`${stdout}\n${stderr}`).toMatch(/Deep link error: Unknown deep link action/)
    expect(`${stdout}\n${stderr}`).not.toMatch(/Failed to open a terminal/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 20000)
}
