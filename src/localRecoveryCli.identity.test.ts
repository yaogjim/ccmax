import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const recoveryEntrypoint = path.join(repoRoot, 'src', 'localRecoveryCli.ts')

async function runRecovery(args: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const configDir = await mkdtemp(path.join(tmpdir(), 'ccmax-recovery-identity-'))
  const homeDir = await mkdtemp(path.join(tmpdir(), 'ccmax-recovery-home-'))

  try {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', recoveryEntrypoint, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          CLAUDE_CONFIG_DIR: configDir,
          CC_HAHA_SKIP_DOTENV: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    return { stdout, stderr, exitCode }
  } finally {
    await rm(configDir, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
  }
}

test('recovery --help uses ccmax local identity', async () => {
  const { stdout, stderr, exitCode } = await runRecovery(['--help'])

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toContain('Usage: ccmax [options] [prompt]')
  expect(stdout).not.toContain('claude-haha')
  expect(stdout).not.toMatch(/Usage:\s+claude\b/)
})

test('recovery --version uses ccmax local recovery identity', async () => {
  const { stdout, stderr, exitCode } = await runRecovery(['--version'])

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toContain('ccmax local recovery')
  expect(stdout).not.toContain('claude-haha')
  expect(stdout).not.toContain('Claude Code')
  expect(stdout).not.toContain('Claude Haha')
})