import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSha512Inspector,
  isAdhocSignedCodesignOutput,
  renderMacUpdateScript,
  resolveAppBundlePath,
  selectMacUpdateZip,
} from './macUpdate'

const releaseFiles = [
  { url: 'https://example.com/ccmax-1.2.0-mac-x64.zip', sha512: 'x64', size: 10 },
  { url: 'https://example.com/ccmax-1.2.0-mac-x64.zip.blockmap', sha512: 'x64-map', size: 1 },
  { url: 'https://example.com/ccmax-1.2.0-mac-x64.dmg', sha512: 'x64-dmg', size: 10 },
  { url: 'https://example.com/ccmax-1.2.0-mac-arm64.zip', sha512: 'arm64', size: 11 },
  { url: 'https://example.com/ccmax-1.2.0-mac-arm64.zip.blockmap', sha512: 'arm64-map', size: 1 },
  { url: 'https://example.com/ccmax-1.2.0-mac-arm64.dmg', sha512: 'arm64-dmg', size: 11 },
]

describe('macOS update asset selection', () => {
  it('picks the zip that matches the running architecture', () => {
    expect(selectMacUpdateZip(releaseFiles, 'arm64')?.url).toBe('https://example.com/ccmax-1.2.0-mac-arm64.zip')
    expect(selectMacUpdateZip(releaseFiles, 'x64')?.url).toBe('https://example.com/ccmax-1.2.0-mac-x64.zip')
  })

  it('falls back to an architecture-neutral zip when no arch-specific build exists', () => {
    const universal = [
      { url: 'https://example.com/ccmax-1.2.0-mac-universal.zip', sha512: 'universal', size: 20 },
      { url: 'https://example.com/ccmax-1.2.0-mac-universal.dmg', sha512: 'universal-dmg', size: 20 },
    ]
    expect(selectMacUpdateZip(universal, 'arm64')?.url).toBe('https://example.com/ccmax-1.2.0-mac-universal.zip')
  })

  it('rejects metadata without a zip payload', () => {
    const dmgOnly = [{ url: 'https://example.com/ccmax-1.2.0-mac-arm64.dmg', sha512: 'only-dmg', size: 11 }]
    expect(selectMacUpdateZip(dmgOnly, 'arm64')).toBeNull()
    expect(selectMacUpdateZip([], 'arm64')).toBeNull()
  })
})

describe('update checksum', () => {
  it('matches the base64 sha512 electron-builder publishes', () => {
    const payload = Buffer.from('ccmax mac update payload')
    const expected = createHash('sha512').update(payload).digest('base64')
    const inspector = createSha512Inspector()
    inspector.update(payload.subarray(0, 5))
    inspector.update(payload.subarray(5))
    expect(inspector.digestBase64()).toBe(expected)
  })
})

describe('macOS replace installer script', () => {
  const script = renderMacUpdateScript({
    appPath: '/Applications/ccmax.app',
    zipPath: '/tmp/ccmax update/ccmax-1.2.0-mac-arm64.zip',
    backupPath: '/tmp/ccmax update/ccmax.app.previous',
    logPath: '/tmp/ccmax update/update.log',
  })

  it('waits for the running app to exit before touching the bundle', () => {
    expect(script).toContain('while kill -0 "$target_pid" 2>/dev/null; do sleep 0.5; done')
  })

  it('extracts the zip and replaces the bundle with a restore path', () => {
    expect(script).toContain('ditto -x -k')
    expect(script).toContain('mv "$app_path" "$backup_path"')
    expect(script).toMatch(/rm -rf "\$app_path"/)
    expect(script).toContain('mv "$backup_path" "$app_path"')
  })

  it('clears quarantine and relaunches the replaced app', () => {
    expect(script).toContain('xattr -dr com.apple.quarantine "$app_path"')
    expect(script).toContain('open "$app_path"')
  })

  it('shell-quotes paths that contain spaces', () => {
    expect(script).toContain('app_path=\'/Applications/ccmax.app\'')
    expect(script).toContain("zip_path='/tmp/ccmax update/ccmax-1.2.0-mac-arm64.zip'")
  })

  // Runs the rendered script for real on macOS: a fake bundle is swapped for
  // the one inside a zip after the "running app" exits.
  it.skipIf(process.platform !== 'darwin').each([false, true])('replaces or restores the bundle after exit (launch fails: %s)', async (launchFails) => {
    const root = mkdtempSync(join(tmpdir(), 'ccmax-update-'))
    try {
      const bundle = join(root, 'ccmax.app')
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
      writeFileSync(join(bundle, 'Contents/MacOS/ccmax'), 'old build')

      const staged = join(root, 'staged/ccmax.app')
      mkdirSync(join(staged, 'Contents/MacOS'), { recursive: true })
      writeFileSync(join(staged, 'Contents/MacOS/ccmax'), 'new build')
      const zipPath = join(root, 'update.zip')
      expect(spawnSync('ditto', ['-c', '-k', '--keepParent', staged, zipPath]).status).toBe(0)

      // `open`/`pgrep` are stubbed so the script never launches a real app.
      const stubBin = join(root, 'bin')
      mkdirSync(stubBin, { recursive: true })
      for (const name of ['open', 'pgrep']) {
        const stub = join(stubBin, name)
        writeFileSync(stub, `#!/bin/bash\nexit ${name === 'open' && launchFails ? 1 : 0}\n`, { mode: 0o755 })
      }

      const logPath = join(root, 'update.log')
      const scriptPath = join(root, 'install-update.sh')
      writeFileSync(scriptPath, renderMacUpdateScript({
        appPath: bundle,
        zipPath,
        backupPath: join(root, 'ccmax.app.previous'),
        logPath,
      }), { mode: 0o755 })

      const running = spawn('sleep', ['0.3'])
      const installer = spawn('bash', [scriptPath, String(running.pid)], {
        env: { PATH: `${stubBin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, TMPDIR: root },
        stdio: 'ignore',
      })
      const status = await new Promise<number | null>((resolve, reject) => {
        installer.once('error', reject)
        installer.once('exit', resolve)
      })

      expect(status).toBe(launchFails ? 1 : 0)
      expect(readFileSync(join(bundle, 'Contents/MacOS/ccmax'), 'utf8')).toBe(launchFails ? 'old build' : 'new build')
      expect(existsSync(join(root, 'ccmax.app.previous'))).toBe(!launchFails)
      expect(readFileSync(logPath, 'utf8')).toContain(launchFails ? 'restoring previous app' : 'update installed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('bundle location', () => {
  it('walks up from the executable to the app bundle', () => {
    expect(resolveAppBundlePath('/Applications/ccmax.app/Contents/MacOS/ccmax')).toBe('/Applications/ccmax.app')
  })

  it('returns null when the executable is not inside an app bundle', () => {
    expect(resolveAppBundlePath('/usr/local/bin/ccmax')).toBeNull()
  })
})

describe('signing detection', () => {
  it('treats an ad-hoc signature as unsupported by Squirrel.Mac', () => {
    const adhoc = [
      'Executable=/Applications/ccmax.app/Contents/MacOS/ccmax',
      'Identifier=com.ccmax.desktop',
      'CodeDirectory v=20500 size=434 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded',
      'Signature=adhoc',
      'TeamIdentifier=not set',
    ].join('\n')
    expect(isAdhocSignedCodesignOutput(adhoc)).toBe(true)
  })

  it('uses replacement for an unsigned Intel bundle', () => {
    expect(isAdhocSignedCodesignOutput('code object is not signed at all')).toBe(true)
  })

  it('keeps Developer ID builds on the native Squirrel path', () => {
    const developerId = [
      'Executable=/Applications/ccmax.app/Contents/MacOS/ccmax',
      'Authority=Developer ID Application: Example Corp (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'TeamIdentifier=ABCDE12345',
    ].join('\n')
    expect(isAdhocSignedCodesignOutput(developerId)).toBe(false)
  })
})
