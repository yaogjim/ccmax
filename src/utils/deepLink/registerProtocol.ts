/**
 * Protocol Handler Registration
 *
 * Registers the current `ccmax://` scheme and the legacy `claude-cli://`
 * scheme with the OS, so that clicking either link invokes
 * `ccmax --handle-uri <url>` through the same handler artifact.
 *
 * Platform details:
 *   macOS  — Creates a minimal .app trampoline in ~/Applications with
 *            CFBundleURLTypes in its Info.plist
 *   Linux  — Creates a .desktop file in $XDG_DATA_HOME/applications
 *            (default ~/.local/share/applications) and registers it with xdg-mime
 *   Windows — Writes registry keys under HKEY_CURRENT_USER\Software\Classes
 */

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getInitialSettings } from '../settings/settings.js'
import { which } from '../which.js'
import { getUserBinDir, getXDGDataHome } from '../xdg.js'
import {
  DEEP_LINK_PROTOCOL,
  LEGACY_DEEP_LINK_PROTOCOL,
  SUPPORTED_DEEP_LINK_PROTOCOLS,
} from './parseDeepLink.js'

export const MACOS_BUNDLE_ID = 'com.anthropic.claude-code-url-handler'
const APP_NAME = 'ccmax URL Handler'
const DESKTOP_FILE_NAME = 'claude-code-url-handler.desktop'
const MACOS_APP_NAME = 'Claude Code URL Handler.app'

// Shared between register* (writes these paths/values) and
// isProtocolHandlerCurrent (reads them back). Keep the writer and reader
// in lockstep — drift here means the check returns a perpetual false.
function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir()
}

function macosAppDir(): string {
  return path.join(resolveHomeDir(), 'Applications', MACOS_APP_NAME)
}

function macosSymlinkPath(): string {
  return path.join(macosAppDir(), 'Contents', 'MacOS', 'claude')
}

function linuxDesktopPath(): string {
  return path.join(getXDGDataHome(), 'applications', DESKTOP_FILE_NAME)
}

function windowsRegKey(protocol: string): string {
  return `HKEY_CURRENT_USER\\Software\\Classes\\${protocol}`
}

function windowsCommandKey(protocol: string): string {
  return `${windowsRegKey(protocol)}\\shell\\open\\command`
}

const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000

function linuxExecLine(executablePath: string): string {
  return `Exec="${executablePath}" --handle-uri %u`
}
function windowsCommandValue(executablePath: string): string {
  return `"${executablePath}" --handle-uri "%1"`
}

function linuxMimeTypes(): string {
  return SUPPORTED_DEEP_LINK_PROTOCOLS.map(
    protocol => `x-scheme-handler/${protocol}`,
  ).join(';')
}

function macosSchemeEntries(): string {
  return SUPPORTED_DEEP_LINK_PROTOCOLS.map(
    protocol => `        <string>${protocol}</string>`,
  ).join('\n')
}

/**
 * Register the protocol handler on macOS.
 *
 * Creates a .app bundle where the CFBundleExecutable is a symlink to the
 * already-installed (and signed) current product binary. When macOS opens a
 * `ccmax://` or legacy `claude-cli://` URL, it launches that binary through
 * this app bundle. The binary then uses the url-handler NAPI module to read
 * the URL from the Apple Event and handles it normally.
 *
 * This approach avoids shipping a separate executable (which would need
 * to be signed and allowlisted by endpoint security tools like Santa).
 */
async function registerMacos(executablePath: string): Promise<void> {
  const appDir = macosAppDir()
  const contentsDir = path.join(appDir, 'Contents')
  const symlinkPath = macosSymlinkPath()

  // Remove any existing app bundle to start clean
  try {
    await fs.rm(appDir, { recursive: true })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  await fs.mkdir(path.dirname(symlinkPath), { recursive: true })

  // Info.plist — registers both URL schemes with the current binary as the executable
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${MACOS_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>claude</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>ccmax Deep Link</string>
      <key>CFBundleURLSchemes</key>
      <array>
${macosSchemeEntries()}
      </array>
    </dict>
  </array>
</dict>
</plist>`

  await fs.writeFile(path.join(contentsDir, 'Info.plist'), infoPlist)

  // Symlink to the already-signed current binary — avoids a new executable
  // that would need signing and endpoint-security allowlisting.
  // Written LAST among the throwing fs calls: isProtocolHandlerCurrent reads
  // this symlink, so it acts as the commit marker. If Info.plist write
  // failed above, no symlink → next session retries.
  await fs.symlink(executablePath, symlinkPath)

  // Re-register the app with LaunchServices so macOS picks up the URL scheme.
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  await execFileNoThrow(lsregister, ['-R', appDir], { useCwd: false })

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler at ${appDir}`,
  )
}

/**
 * Register the protocol handler on Linux.
 * Creates a .desktop file and registers it with xdg-mime.
 */
async function registerLinux(executablePath: string): Promise<void> {
  await fs.mkdir(path.dirname(linuxDesktopPath()), { recursive: true })

  const desktopEntry = `[Desktop Entry]
Name=${APP_NAME}
Comment=Handle ${DEEP_LINK_PROTOCOL}:// and ${LEGACY_DEEP_LINK_PROTOCOL}:// deep links for ccmax
${linuxExecLine(executablePath)}
Type=Application
NoDisplay=true
MimeType=${linuxMimeTypes()};
`

  await fs.writeFile(linuxDesktopPath(), desktopEntry)

  // Register as the default handler for each scheme. On headless boxes
  // (WSL, Docker, CI) xdg-utils isn't installed — not a failure: there's
  // no desktop to click links from, and some apps read the .desktop
  // MimeType line directly. The artifact check still short-circuits
  // next session since the .desktop file is present.
  const xdgMime = await which('xdg-mime')
  if (xdgMime) {
    for (const protocol of SUPPORTED_DEEP_LINK_PROTOCOLS) {
      const { code } = await execFileNoThrow(
        xdgMime,
        ['default', DESKTOP_FILE_NAME, `x-scheme-handler/${protocol}`],
        { useCwd: false },
      )
      if (code !== 0) {
        throw Object.assign(new Error(`xdg-mime exited with code ${code}`), {
          code: 'XDG_MIME_FAILED',
        })
      }
    }
  }

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler at ${linuxDesktopPath()}`,
  )
}

/**
 * Register the protocol handler on Windows via the registry.
 */
async function registerWindows(executablePath: string): Promise<void> {
  for (const protocol of SUPPORTED_DEEP_LINK_PROTOCOLS) {
    for (const args of [
      ['add', windowsRegKey(protocol), '/ve', '/d', `URL:${APP_NAME}`, '/f'],
      ['add', windowsRegKey(protocol), '/v', 'URL Protocol', '/d', '', '/f'],
      [
        'add',
        windowsCommandKey(protocol),
        '/ve',
        '/d',
        windowsCommandValue(executablePath),
        '/f',
      ],
    ]) {
      const { code } = await execFileNoThrow('reg', args, { useCwd: false })
      if (code !== 0) {
        throw Object.assign(new Error(`reg add exited with code ${code}`), {
          code: 'REG_FAILED',
        })
      }
    }
  }

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler in Windows registry`,
  )
}

/**
 * Register the `ccmax://` and legacy `claude-cli://` protocol handlers
 * with the operating system. After registration, clicking either link
 * will invoke the current ccmax executable.
 */
export async function registerProtocolHandler(
  executablePath?: string,
): Promise<void> {
  const resolved = executablePath ?? (await resolveCurrentExecutable())

  switch (process.platform) {
    case 'darwin':
      await registerMacos(resolved)
      break
    case 'linux':
      await registerLinux(resolved)
      break
    case 'win32':
      await registerWindows(resolved)
      break
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function stableExecutableCandidates(): string[] {
  const binDir = getUserBinDir()
  if (process.platform === 'win32') {
    return [
      path.join(binDir, 'ccmax.exe'),
      path.join(binDir, 'ccmax.cmd'),
      path.join(binDir, 'ccmax'),
    ]
  }
  return [path.join(binDir, 'ccmax')]
}

/**
 * Resolve the current product binary path for protocol registration.
 * Prefers the stable `ccmax` install entry (~/.local/bin/ccmax, with
 * Windows .exe/.cmd variants) then PATH `ccmax`; falls back to
 * process.execPath. Never prefers upstream `claude` or writes `claude-haha`.
 */
async function resolveCurrentExecutable(): Promise<string> {
  for (const stablePath of stableExecutableCandidates()) {
    try {
      await fs.realpath(stablePath)
      return stablePath
    } catch {
      // try next candidate
    }
  }

  const fromPath = await which('ccmax')
  if (fromPath) {
    return fromPath
  }

  return process.execPath
}

function artifactHasBothSchemes(content: string): boolean {
  return SUPPORTED_DEEP_LINK_PROTOCOLS.every(protocol =>
    content.includes(protocol),
  )
}

/**
 * Check whether the OS-level protocol handler is already registered AND
 * points at the expected current binary for both schemes. Reads the
 * registration artifact directly (symlink target, .desktop Exec line,
 * registry value) rather than a cached flag in ~/.claude.json, so:
 *   - the check is per-machine (config can sync across machines; OS state can't)
 *   - stale paths self-heal (install-method change → re-register next session)
 *   - deleted artifacts self-heal
 *   - a legacy single-scheme install is treated as stale and upgraded in place
 *
 * Any read error (ENOENT, EACCES, reg nonzero) → false → re-register.
 */
export async function isProtocolHandlerCurrent(
  executablePath: string,
): Promise<boolean> {
  try {
    switch (process.platform) {
      case 'darwin': {
        const target = await fs.readlink(macosSymlinkPath())
        if (target !== executablePath) {
          return false
        }
        const plist = await fs.readFile(
          path.join(macosAppDir(), 'Contents', 'Info.plist'),
          'utf8',
        )
        return artifactHasBothSchemes(plist)
      }
      case 'linux': {
        const content = await fs.readFile(linuxDesktopPath(), 'utf8')
        return (
          content.includes(linuxExecLine(executablePath)) &&
          SUPPORTED_DEEP_LINK_PROTOCOLS.every(protocol =>
            content.includes(`x-scheme-handler/${protocol}`),
          )
        )
      }
      case 'win32': {
        for (const protocol of SUPPORTED_DEEP_LINK_PROTOCOLS) {
          const { stdout, code } = await execFileNoThrow(
            'reg',
            ['query', windowsCommandKey(protocol), '/ve'],
            { useCwd: false },
          )
          if (
            code !== 0 ||
            !stdout.includes(windowsCommandValue(executablePath))
          ) {
            return false
          }
        }
        return true
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

/**
 * Auto-register the ccmax:// (and legacy claude-cli://) deep link protocol
 * handler when missing or stale. Runs every session from backgroundHousekeeping
 * (fire-and-forget), but the artifact check makes it a no-op after the first
 * successful run unless the install path moves, a scheme is missing, or the
 * OS artifact is deleted.
 */
export async function ensureDeepLinkProtocolRegistered(): Promise<void> {
  if (getInitialSettings().disableDeepLinkRegistration === 'disable') {
    return
  }

  const executablePath = await resolveCurrentExecutable()
  if (await isProtocolHandlerCurrent(executablePath)) {
    return
  }

  // EACCES/ENOSPC are deterministic — retrying next session won't help.
  // Throttle to once per 24h so a read-only ~/.local/share/applications
  // doesn't generate a failure event on every startup. Marker lives in
  // ~/.claude (per-machine, not synced) rather than ~/.claude.json (can sync).
  const failureMarkerPath = path.join(
    getClaudeConfigHomeDir(),
    '.deep-link-register-failed',
  )
  try {
    const stat = await fs.stat(failureMarkerPath)
    if (Date.now() - stat.mtimeMs < FAILURE_BACKOFF_MS) {
      return
    }
  } catch {
    // Marker absent — proceed.
  }

  try {
    await registerProtocolHandler(executablePath)
    logEvent('tengu_deep_link_registered', { success: true })
    logForDebugging(
      'Auto-registered ccmax:// deep link protocol handler',
    )
    await fs.rm(failureMarkerPath, { force: true }).catch(() => {})
  } catch (error) {
    const code = getErrnoCode(error)
    logEvent('tengu_deep_link_registered', {
      success: false,
      error_code:
        code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logForDebugging(
      `Failed to auto-register deep link protocol handler: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    if (code === 'EACCES' || code === 'ENOSPC') {
      await fs.writeFile(failureMarkerPath, '').catch(() => {})
    }
  }
}