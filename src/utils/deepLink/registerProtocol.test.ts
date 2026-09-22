import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SettingsJson } from '../settings/types.js'

const execFileNoThrow = mock(
  async (
    _file: string,
    _args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> => ({
    stdout: '',
    stderr: '',
    code: 0,
  }),
)
const whichImpl = mock(async (_command: string): Promise<string | null> => null)
const getInitialSettings = mock((): SettingsJson => ({}))

const execFileNoThrowModule = await import('../execFileNoThrow.js')
const whichModule = await import('../which.js')
const settingsModule = await import('../settings/settings.js')

mock.module('../execFileNoThrow.js', () => ({
  ...execFileNoThrowModule,
  execFileNoThrow,
}))
mock.module('../which.js', () => ({
  ...whichModule,
  which: whichImpl,
}))
mock.module('../settings/settings.js', () => ({
  ...settingsModule,
  getInitialSettings,
}))
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

const {
  ensureDeepLinkProtocolRegistered,
  isProtocolHandlerCurrent,
  MACOS_BUNDLE_ID,
  registerProtocolHandler,
} = await import('./registerProtocol.js')

const originalPlatform = process.platform
const originalHome = process.env.HOME
const originalPath = process.env.PATH
const originalXdg = process.env.XDG_DATA_HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

let tempRoot = ''
let homeDir = ''
let configDir = ''
let disableRegistration = false
const windowsRegistry = new Map<string, string>()

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: originalPlatform,
  })
}

function macosAppDir(): string {
  return path.join(homeDir, 'Applications', 'Claude Code URL Handler.app')
}

function macosPlistPath(): string {
  return path.join(macosAppDir(), 'Contents', 'Info.plist')
}

function macosSymlinkPath(): string {
  return path.join(macosAppDir(), 'Contents', 'MacOS', 'claude')
}

function linuxDesktopPath(): string {
  return path.join(homeDir, '.local', 'share', 'applications', 'claude-code-url-handler.desktop')
}

function windowsCommandKey(scheme: string): string {
  return `HKEY_CURRENT_USER\\Software\\Classes\\${scheme}\\shell\\open\\command`
}

function windowsRegistryValue(key: string, valueName = '(Default)'): string | undefined {
  return windowsRegistry.get(`${key}::${valueName}`)
}

async function writeStableCcmax(name = 'ccmax'): Promise<string> {
  const filePath = path.join(homeDir, '.local', 'bin', name)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, '#!/bin/sh\n')
  return filePath
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'ccmax-deep-link-reg-'))
  homeDir = path.join(tempRoot, 'home')
  configDir = path.join(tempRoot, 'config')
  await mkdir(homeDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  await mkdir(path.join(homeDir, '.local', 'bin'), { recursive: true })

  process.env.HOME = homeDir
  process.env.XDG_DATA_HOME = path.join(homeDir, '.local', 'share')
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.PATH = path.join(homeDir, '.local', 'bin')

  disableRegistration = false
  windowsRegistry.clear()
  execFileNoThrow.mockReset()
  whichImpl.mockReset()
  getInitialSettings.mockReset()

  getInitialSettings.mockImplementation(
    () =>
      (disableRegistration
        ? { disableDeepLinkRegistration: 'disable' }
        : {}) as SettingsJson,
  )
  whichImpl.mockImplementation(async command => {
    if (command === 'xdg-mime') {
      return '/usr/bin/xdg-mime'
    }
    return null
  })
  execFileNoThrow.mockImplementation(async (file, args) => {
    if (path.basename(file) === 'lsregister' || file.endsWith('lsregister')) {
      return { stdout: '', stderr: '', code: 0 }
    }
    if (file === '/usr/bin/xdg-mime' || path.basename(file) === 'xdg-mime') {
      return { stdout: '', stderr: '', code: 0 }
    }
    if (file === 'reg') {
      if (args[0] === 'add') {
        const key = args[1] ?? ''
        const named = args.indexOf('/v')
        const valueName = named === -1 ? '(Default)' : (args[named + 1] ?? '')
        const valueIndex = args.indexOf('/d')
        windowsRegistry.set(
          `${key}::${valueName}`,
          valueIndex === -1 ? '' : (args[valueIndex + 1] ?? ''),
        )
        return { stdout: '', stderr: '', code: 0 }
      }
      if (args[0] === 'query') {
        const key = args[1] ?? ''
        const named = args.indexOf('/v')
        const valueName = named === -1 ? '(Default)' : (args[named + 1] ?? '')
        const value = windowsRegistry.get(`${key}::${valueName}`)
        if (value === undefined) {
          return { stdout: '', stderr: 'not found', code: 1 }
        }
        return { stdout: value, stderr: '', code: 0 }
      }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  })
})

afterEach(async () => {
  restorePlatform()
  await rm(tempRoot, { recursive: true, force: true })
})

afterAll(() => {
  restorePlatform()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdg
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  mock.restore()
})

describe('registerProtocolHandler', () => {
  test('registers both schemes in the legacy macOS handler bundle and prefers ccmax', async () => {
    setPlatform('darwin')
    const executable = await writeStableCcmax()

    await registerProtocolHandler()

    const plist = await readFile(macosPlistPath(), 'utf8')
    expect(plist).toContain(MACOS_BUNDLE_ID)
    expect(plist).toContain('ccmax URL Handler')
    expect(plist).toContain('ccmax Deep Link')
    expect(plist).toContain('<string>ccmax</string>')
    expect(plist).toContain('<string>claude-cli</string>')
    expect(plist).toContain('<string>claude</string>')
    expect(await readlink(macosSymlinkPath())).toBe(executable)
    expect(macosAppDir().startsWith(homeDir)).toBe(true)
    expect(execFileNoThrow.mock.calls.some(([file]) => String(file).includes('lsregister'))).toBe(
      true,
    )
    expect(whichImpl.mock.calls.every(([command]) => command !== 'claude')).toBe(true)
    expect(whichImpl.mock.calls.every(([command]) => command !== 'claude-haha')).toBe(true)
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)
  })

  test('treats a legacy single-scheme macOS artifact as stale and upgrades in place', async () => {
    setPlatform('darwin')
    const executable = await writeStableCcmax()
    await mkdir(path.dirname(macosSymlinkPath()), { recursive: true })
    await writeFile(
      macosPlistPath(),
      '<plist><string>claude-cli</string></plist>',
    )
    await symlink(executable, macosSymlinkPath())

    expect(await isProtocolHandlerCurrent(executable)).toBe(false)

    await registerProtocolHandler(executable)
    const plist = await readFile(macosPlistPath(), 'utf8')
    expect(plist).toContain('<string>ccmax</string>')
    expect(plist).toContain('<string>claude-cli</string>')
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)
  })

  test('registers both Linux MimeTypes on the legacy desktop filename', async () => {
    setPlatform('linux')
    const executable = await writeStableCcmax()

    await registerProtocolHandler()

    const desktop = await readFile(linuxDesktopPath(), 'utf8')
    expect(desktop).toContain('Name=ccmax URL Handler')
    expect(desktop).toContain('ccmax://')
    expect(desktop).toContain('claude-cli://')
    expect(desktop).toContain(`Exec="${executable}" --handle-uri %u`)
    expect(desktop).toContain('x-scheme-handler/ccmax')
    expect(desktop).toContain('x-scheme-handler/claude-cli')
    expect(path.basename(linuxDesktopPath())).toBe('claude-code-url-handler.desktop')
    expect(
      execFileNoThrow.mock.calls.filter(([file]) => String(file).includes('xdg-mime')),
    ).toHaveLength(2)
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)
  })

  test('treats a Linux desktop file missing ccmax as stale', async () => {
    setPlatform('linux')
    const executable = '/opt/ccmax'
    await mkdir(path.dirname(linuxDesktopPath()), { recursive: true })
    await writeFile(
      linuxDesktopPath(),
      `[Desktop Entry]\nExec="${executable}" --handle-uri %u\nMimeType=x-scheme-handler/claude-cli;\n`,
    )

    expect(await isProtocolHandlerCurrent(executable)).toBe(false)
  })

  test('writes the same Windows command for both scheme slots', async () => {
    setPlatform('win32')
    const executable = 'C:\\Users\\me\\.local\\bin\\ccmax.exe'

    await registerProtocolHandler(executable)

    const expected = `"${executable}" --handle-uri "%1"`
    expect(windowsRegistryValue(windowsCommandKey('ccmax'))).toBe(expected)
    expect(windowsRegistryValue(windowsCommandKey('claude-cli'))).toBe(expected)
    expect(
      windowsRegistryValue('HKEY_CURRENT_USER\\Software\\Classes\\ccmax'),
    ).toBe('URL:ccmax URL Handler')
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)
  })

  test('treats a Windows install with only the legacy scheme as stale', async () => {
    setPlatform('win32')
    const executable = 'C:\\ccmax.exe'
    windowsRegistry.set(
      `${windowsCommandKey('claude-cli')}::(Default)`,
      `"${executable}" --handle-uri "%1"`,
    )

    expect(await isProtocolHandlerCurrent(executable)).toBe(false)
  })

  test('resolves PATH ccmax after the stable entry and never prefers upstream claude', async () => {
    setPlatform('darwin')
    const pathCcmax = path.join(homeDir, 'path-bin', 'ccmax')
    await mkdir(path.dirname(pathCcmax), { recursive: true })
    await writeFile(pathCcmax, '#!/bin/sh\n')
    whichImpl.mockImplementation(async command => {
      if (command === 'ccmax') return pathCcmax
      if (command === 'claude') return '/usr/local/bin/claude'
      return null
    })

    await registerProtocolHandler()

    expect(await readlink(macosSymlinkPath())).toBe(pathCcmax)
    expect(whichImpl.mock.calls.some(([command]) => command === 'ccmax')).toBe(true)
    expect(whichImpl.mock.calls.some(([command]) => command === 'claude')).toBe(false)
  })

  test('falls back to process.execPath when no ccmax entry exists', async () => {
    setPlatform('darwin')
    whichImpl.mockImplementation(async () => null)

    await registerProtocolHandler()

    expect(await readlink(macosSymlinkPath())).toBe(process.execPath)
  })

  test('prefers Windows stable ccmax.exe over PATH or execPath', async () => {
    setPlatform('win32')
    const stable = await writeStableCcmax('ccmax.exe')
    whichImpl.mockImplementation(async command =>
      command === 'ccmax' ? 'C:\\elsewhere\\ccmax.exe' : null,
    )

    await registerProtocolHandler()

    expect(windowsRegistryValue(windowsCommandKey('ccmax'))).toBe(
      `"${stable}" --handle-uri "%1"`,
    )
  })
})

describe('ensureDeepLinkProtocolRegistered', () => {
  test('registers by default and skips when the user disabled registration', async () => {
    setPlatform('darwin')
    const executable = await writeStableCcmax()

    await ensureDeepLinkProtocolRegistered()
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)

    await rm(macosAppDir(), { recursive: true, force: true })
    disableRegistration = true
    await ensureDeepLinkProtocolRegistered()
    await expect(readFile(macosPlistPath(), 'utf8')).rejects.toThrow()
  })

  test('does not re-register a current dual-scheme artifact', async () => {
    setPlatform('linux')
    const executable = await writeStableCcmax()
    await registerProtocolHandler(executable)
    execFileNoThrow.mockClear()

    await ensureDeepLinkProtocolRegistered()

    expect(execFileNoThrow.mock.calls.length).toBe(0)
    expect(await isProtocolHandlerCurrent(executable)).toBe(true)
  })
})
