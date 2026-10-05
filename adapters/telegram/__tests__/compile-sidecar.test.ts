import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function isolatedEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    TMPDIR: join(home, 'tmp'),
    CC_TG_COMPILE_HOME: home,
    USER: 'tgtest',
    LANG: 'C',
  }
}

async function assertPacked(binary: string, needle: string): Promise<void> {
  // Quiet grep: a binary "line" can be huge, and filling stdout would deadlock
  // the test while it waits on `exited`.
  const packed = Bun.spawn(['grep', '-a', '-q', '-F', needle, binary], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [code, error] = await Promise.all([packed.exited, new Response(packed.stderr).text()])
  expect({ needle, code, error: code ? error : '' }).toEqual({ needle, code: 0, error: '' })
}

describe('Telegram sidecar compile graph', () => {
  it('keeps a literal dedicated import for bun compile / scan-missing-imports', () => {
    expect(indexSource).toMatch(/import\(\s*['"]\.\/dedicated\.js['"]\s*\)/)
    expect(indexSource).toMatch(/from ['"]\.\/public\.js['"]/)
    expect(indexSource).not.toContain('siblingSpecifier')
    expect(indexSource).not.toMatch(/import\.meta\.url\)\.search/)
    expect(indexSource).not.toMatch(/dedicated\.js\?/)
  })

  it('packs dedicated and public into a compiled public-only run without evaluating missing token', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-compile-')))
    directories.push(root)
    const home = join(root, 'home')
    mkdirSync(join(home, 'repo'), { recursive: true })
    mkdirSync(join(home, 'xdg'), { recursive: true })
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, 'adapters.json'), JSON.stringify({
      telegram: {
        public: { enabled: true, botToken: '222222:compile-public-token', generation: 1 },
      },
    }))

    const binary = join(root, 'telegram-public-only')
    const entry = fileURLToPath(new URL('./fixtures/compile-public-only-entry.ts', import.meta.url))
    const adaptersRoot = fileURLToPath(new URL('../../', import.meta.url))
    const env = isolatedEnv(home)
    const build = Bun.spawn(
      [process.execPath, 'build', '--compile', entry, '--outfile', binary],
      { cwd: adaptersRoot, stdout: 'pipe', stderr: 'pipe', env },
    )
    const [buildCode, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()])
    expect({ code: buildCode, error: buildCode ? buildError : '' }).toEqual({ code: 0, error: '' })

    if (process.platform === 'darwin') {
      for (const args of [['--remove-signature', binary], ['--sign', '-', '--force', binary]]) {
        const sign = Bun.spawn(['codesign', ...args], { stdout: 'pipe', stderr: 'pipe', env })
        const [code, error] = await Promise.all([sign.exited, new Response(sign.stderr).text()])
        expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' })
      }
    }

    await assertPacked(binary, '[Telegram] Starting bot...')
    await assertPacked(binary, '[Telegram public] Bot is running')

    const run = Bun.spawn([binary], {
      cwd: adaptersRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('compiled-public-only-ok')
    expect(stdout + stderr).not.toContain('Missing TELEGRAM_BOT_TOKEN')
    expect(stdout + stderr).not.toContain('compile-public-token')
  }, 90_000)
})