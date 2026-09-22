import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const cliEntrypoint = path.join(repoRoot, 'src', 'entrypoints', 'cli.tsx')
const globals = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string }
}
const entrypointEnvKeys = [
  'CLAUDE_CODE_ABLATION_BASELINE',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_SIMPLE',
  'COREPACK_ENABLE_AUTO_PIN',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
  'DISABLE_INTERLEAVED_THINKING',
  'NODE_OPTIONS',
] as const

function restoreEntrypointEnv(originalEnv: Record<string, string | undefined>): void {
  for (const key of entrypointEnvKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function runEntrypoint(args: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const configDir = await mkdtemp(path.join(tmpdir(), 'ccmax-cli-identity-'))

  try {
    const child = Bun.spawn([
      process.execPath,
      '--feature=TRANSCRIPT_CLASSIFIER',
      '--no-env-file',
      cliEntrypoint,
      ...args,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CC_HAHA_SKIP_DOTENV: '1',
        CLAUDE_CONFIG_DIR: configDir,
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
    await rm(configDir, { recursive: true, force: true })
  }
}

async function captureEntrypointVersion(args: string[]): Promise<string[]> {
  const originalArgv = process.argv
  const originalEnv = Object.fromEntries(
    entrypointEnvKeys.map(key => [key, process.env[key]]),
  ) as Record<string, string | undefined>
  const originalMacro = globals.MACRO
  const originalConsoleLog = console.log
  const lines: string[] = []

  try {
    process.argv = [originalArgv[0]!, cliEntrypoint, ...args]
    delete process.env.CLAUDE_CODE_REMOTE
    delete process.env.CLAUDE_CODE_ABLATION_BASELINE
    globals.MACRO = { VERSION: '0.0.0-test' }
    console.log = (...values: unknown[]) => {
      lines.push(values.map(String).join(' '))
    }

    const { main } = await import('./cli')
    await main()
    return lines
  } finally {
    process.argv = originalArgv
    restoreEntrypointEnv(originalEnv)
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    console.log = originalConsoleLog
  }
}

test('in-process fast version path prints ccmax product identity', async () => {
  const lines = await captureEntrypointVersion(['--version'])

  expect(lines).toEqual(['0.0.0-test ccmax'])
  expect(lines.join('\n')).not.toContain('(Claude Code)')
})

test('fast version path prints ccmax product identity', async () => {
  const { stdout, stderr, exitCode } = await runEntrypoint(['--version'])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('ccmax')
  expect(stdout).not.toContain('(Claude Code)')
})

test('top-level help prints ccmax product identity', async () => {
  const { stdout, stderr, exitCode } = await runEntrypoint(['--help'])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Usage: ccmax')
  expect(stdout).toContain('ccmax - starts an interactive session')
  expect(stdout).not.toContain('Usage: claude')
  expect(stdout).not.toContain('Claude Code - starts')
}, 20000)