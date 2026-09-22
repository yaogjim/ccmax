import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const mainEntrypoint = path.join(repoRoot, 'src', 'main.tsx')
const restoredEnvKeys = [
  'CC_HAHA_SKIP_DOTENV',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
] as const
const globals = globalThis as typeof globalThis & {
  MACRO?: {
    VERSION: string
    PACKAGE_URL: string
    NATIVE_PACKAGE_URL: string
    BUILD_TIME: string
    FEEDBACK_CHANNEL: string
    VERSION_CHANGELOG: string
    ISSUES_EXPLAINER: string
  }
}
const originalListeners = {
  exit: process.listeners('exit'),
  SIGINT: process.listeners('SIGINT'),
  warning: process.listeners('warning'),
}

class HelpExitSentinel extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super('main help requested process exit')
  }
}

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  for (const key of restoredEnvKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function restoreListeners(
  original: Record<'exit' | 'SIGINT' | 'warning', NodeJS.Listener[]>,
): void {
  for (const event of ['exit', 'SIGINT', 'warning'] as const) {
    const keep = new Set(original[event])
    for (const listener of process.listeners(event)) {
      if (!keep.has(listener)) {
        process.removeListener(event, listener)
      }
    }
  }
}

afterAll(() => {
  restoreListeners(originalListeners)
})

test('in-process main help prints ccmax product identity hermetically', async () => {
  const tempHome = await mkdtemp(path.join(tmpdir(), 'ccmax-main-identity-home-'))
  const tempConfigDir = await mkdtemp(path.join(tmpdir(), 'ccmax-main-identity-config-'))
  const originalArgv = process.argv
  const originalEnv = Object.fromEntries(
    restoredEnvKeys.map(key => [key, process.env[key]]),
  ) as Record<string, string | undefined>
  const originalMacro = globals.MACRO
  const originalProcessExit = process.exit
  const originalStdoutWrite = process.stdout.write
  const beforeTestListeners = {
    exit: process.listeners('exit'),
    SIGINT: process.listeners('SIGINT'),
    warning: process.listeners('warning'),
  }
  let stdout = ''

  try {
    process.argv = [originalArgv[0]!, mainEntrypoint, '--bare', '--help']
    process.env.CC_HAHA_SKIP_DOTENV = '1'
    process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH = '1'
    process.env.CLAUDE_CODE_SIMPLE = '1'
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    globals.MACRO = {
      VERSION: '0.0.0-test',
      PACKAGE_URL: 'ccmax-test-package',
      NATIVE_PACKAGE_URL: 'ccmax-test-package',
      BUILD_TIME: '2026-03-14T00:00:00.000Z',
      FEEDBACK_CHANNEL: 'test',
      VERSION_CHANGELOG: '',
      ISSUES_EXPLAINER: '',
    }
    process.exit = ((code?: number | string | null | undefined): never => {
      throw new HelpExitSentinel(code)
    }) as typeof process.exit
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function')
      callback?.()
      return true
    }) as typeof process.stdout.write

    const { main } = await import('./main.js')
    let exitCode: number | string | null | undefined
    try {
      await main()
    } catch (error) {
      if (!(error instanceof HelpExitSentinel)) throw error
      exitCode = error.code
    }

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage: ccmax')
    expect(stdout).toContain('ccmax - starts an interactive session')
    expect(stdout).toContain('-v, --version')
    expect(stdout).not.toContain('Usage: claude')
    expect(stdout).not.toContain('Claude Code - starts')
  } finally {
    process.argv = originalArgv
    restoreEnv(originalEnv)
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    process.exit = originalProcessExit
    process.stdout.write = originalStdoutWrite
    restoreListeners(beforeTestListeners)
    await rm(tempConfigDir, { recursive: true, force: true })
    await rm(tempHome, { recursive: true, force: true })
  }
}, 20_000)