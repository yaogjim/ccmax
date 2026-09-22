import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildManagedPathBlock,
  buildWindowsLauncherWrapper,
  ensureDesktopCliLauncherInstalled,
  getDesktopCliCommandName,
  getDesktopCliLegacyCommandName,
  upsertManagedPathBlock,
} from '../services/desktopCliLauncherService.js'

const isWindows = process.platform === 'win32'
const unixOnly = isWindows ? it.skip : it

const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_USERPROFILE = process.env.USERPROFILE
const ORIGINAL_SHELL = process.env.SHELL
const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

describe('ensureDesktopCliLauncherInstalled', () => {
  let tempHome = ''
  let tempSourceDir = ''

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'desktop-cli-home-'))
    tempSourceDir = await mkdtemp(join(tmpdir(), 'desktop-cli-source-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = ''
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = ORIGINAL_HOME
    }

    if (ORIGINAL_USERPROFILE === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = ORIGINAL_USERPROFILE
    }

    if (ORIGINAL_SHELL === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = ORIGINAL_SHELL
    }

    if (ORIGINAL_PATH === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = ORIGINAL_PATH
    }

    if (ORIGINAL_CLAUDE_CLI_PATH === undefined) {
      delete process.env.CLAUDE_CLI_PATH
    } else {
      process.env.CLAUDE_CLI_PATH = ORIGINAL_CLAUDE_CLI_PATH
    }

    if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
    }

    await rm(tempHome, { recursive: true, force: true })
    await rm(tempSourceDir, { recursive: true, force: true })
  })

  unixOnly('installs primary and legacy launcher wrappers and configures PATH', async () => {
    const sourcePath = join(tempSourceDir, 'claude-sidecar')
    await writeFile(sourcePath, '#!/bin/sh\necho desktop-sidecar\n', 'utf8')
    await chmod(sourcePath, 0o755)
    process.env.CLAUDE_CLI_PATH = sourcePath

    const status = await ensureDesktopCliLauncherInstalled()
    const launcherPath = join(tempHome, '.local', 'bin', 'ccmax')
    const legacyLauncherPath = join(tempHome, '.local', 'bin', 'claude-haha')
    const shellConfigPath = join(tempHome, '.zshrc')

    expect(status.supported).toBe(true)
    expect(status.installed).toBe(true)
    expect(status.command).toBe('ccmax')
    expect(status.launcherPath).toBe(launcherPath)
    expect(status.availableInNewTerminals).toBe(true)
    expect(status.needsTerminalRestart).toBe(true)
    expect(status.configTarget).toBe(shellConfigPath)

    const launcher = await readFile(launcherPath, 'utf8')
    const legacyLauncher = await readFile(legacyLauncherPath, 'utf8')
    expect(launcher).toContain(`SIDECAR='${sourcePath}'`)
    expect(launcher).toContain('cli --app-root "$APP_ROOT" "$@"')
    expect(launcher).toContain('/usr/bin/script -q /dev/null')
    expect(launcher).toContain('ccmax launcher could not find bundled sidecar')
    expect(legacyLauncher).toBe(launcher)
    expect(await readFile(shellConfigPath, 'utf8')).toContain(
      'export PATH="$HOME/.local/bin:$PATH"',
    )
  })

  unixOnly('pins portable config dir in both installed launcher wrappers', async () => {
    const sourcePath = join(tempSourceDir, 'claude-sidecar')
    const portableDir = join(tempHome, 'portable-config')
    await writeFile(sourcePath, '#!/bin/sh\necho desktop-sidecar\n', 'utf8')
    await chmod(sourcePath, 0o755)
    process.env.CLAUDE_CLI_PATH = sourcePath
    process.env.CLAUDE_CONFIG_DIR = portableDir

    await ensureDesktopCliLauncherInstalled()

    const primary = await readFile(join(tempHome, '.local', 'bin', 'ccmax'), 'utf8')
    const legacy = await readFile(join(tempHome, '.local', 'bin', 'claude-haha'), 'utf8')
    expect(primary).toContain(`export CLAUDE_CONFIG_DIR='${portableDir}'`)
    expect(legacy).toBe(primary)
  })

  unixOnly('writes a new managed PATH block with the ccmax marker', async () => {
    const sourcePath = join(tempSourceDir, 'claude-sidecar')
    await writeFile(sourcePath, '#!/bin/sh\necho desktop-sidecar\n', 'utf8')
    await chmod(sourcePath, 0o755)
    process.env.CLAUDE_CLI_PATH = sourcePath

    await ensureDesktopCliLauncherInstalled()

    const shellConfig = await readFile(join(tempHome, '.zshrc'), 'utf8')
    expect(shellConfig).toContain('# >>> ccmax PATH >>>')
    expect(shellConfig).toContain('# <<< ccmax PATH <<<')
    expect(shellConfig).not.toContain('Claude Code Haha PATH')
    expect(shellConfig).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  unixOnly('updates an existing managed PATH block in place without duplicating it', async () => {
    const binDir = join(tempHome, '.local', 'bin')
    const existingBlock = buildManagedPathBlock('zsh', binDir, tempHome)
    const existing = [
      '# user config',
      existingBlock,
      '# more config',
      '',
    ].join('\n')

    const nextBlock = buildManagedPathBlock('zsh', join(tempHome, 'custom', 'bin'), tempHome)
    const next = upsertManagedPathBlock(existing, nextBlock)
    const startMarker = '# >>> ccmax PATH >>>'
    const endMarker = '# <<< ccmax PATH <<<'

    expect(next).toContain(startMarker)
    expect(next).toContain(endMarker)
    expect(next.indexOf(startMarker)).toBe(next.lastIndexOf(startMarker))
    expect(next.indexOf(endMarker)).toBe(next.lastIndexOf(endMarker))
    expect(next).toContain('# user config')
    expect(next).toContain('# more config')
    expect(next).toContain(`export PATH="${join(tempHome, 'custom', 'bin')}:$PATH"`)
  })

  unixOnly('migrates a legacy Claude Code Haha PATH block in place without duplicating it', async () => {
    const binDir = join(tempHome, '.local', 'bin')
    const legacyBlock = [
      '# >>> Claude Code Haha PATH >>>',
      `export PATH="${binDir}:$PATH"`,
      '# <<< Claude Code Haha PATH <<<',
    ].join('\n')
    const existing = [
      '# user config',
      legacyBlock,
      '# more config',
      '',
    ].join('\n')

    const nextBlock = buildManagedPathBlock('zsh', binDir, tempHome)
    const next = upsertManagedPathBlock(existing, nextBlock)

    expect(next).toContain('# >>> ccmax PATH >>>')
    expect(next).toContain('# <<< ccmax PATH <<<')
    expect(next).not.toContain('Claude Code Haha PATH')
    expect(next.indexOf('# >>> ccmax PATH >>>')).toBe(
      next.lastIndexOf('# >>> ccmax PATH >>>'),
    )
    expect(next).toContain('# user config')
    expect(next).toContain('# more config')
    expect(next).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  it('uses a Windows cmd launcher so portable env can be injected', () => {
    expect(getDesktopCliCommandName('win32')).toBe('ccmax.cmd')
    expect(getDesktopCliLegacyCommandName('win32')).toBe('claude-haha.cmd')
    expect(getDesktopCliCommandName('darwin')).toBe('ccmax')
    expect(getDesktopCliLegacyCommandName('darwin')).toBe('claude-haha')

    process.env.CLAUDE_CONFIG_DIR = 'C:\\Portable\\ClaudeConfig'
    const wrapper = buildWindowsLauncherWrapper('C:\\Apps\\cc-haha\\claude-sidecar.exe')

    expect(wrapper).toContain('set "CLAUDE_CONFIG_DIR=C:\\Portable\\ClaudeConfig"')
    expect(wrapper).toContain(
      '"%SIDECAR%" cli --app-root "%APP_ROOT%" %*',
    )
    expect(wrapper).toContain('ccmax launcher could not find bundled sidecar')
  })

  it('reports unsupported status when the current launcher is not a bundled sidecar', async () => {
    const sourcePath = join(tempSourceDir, 'claude')
    await writeFile(sourcePath, '#!/bin/sh\necho plain-cli\n', 'utf8')
    process.env.CLAUDE_CLI_PATH = sourcePath

    const status = await ensureDesktopCliLauncherInstalled()

    expect(status.supported).toBe(false)
    expect(status.installed).toBe(false)
    expect(status.command).toBe('ccmax')
  })
})