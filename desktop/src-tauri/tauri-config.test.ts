import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const currentDir = dirname(fileURLToPath(import.meta.url))

describe('tauri security config', () => {
  it('allows desktop sidecar image URLs for opener icons', () => {
    const config = JSON.parse(
      readFileSync(join(currentDir, 'tauri.conf.json'), 'utf8'),
    ) as {
      app?: {
        security?: {
          csp?: string
        }
      }
    }

    const csp = config.app?.security?.csp ?? ''
    expect(csp).toContain('img-src')
    expect(csp).toContain('http://127.0.0.1:*')
    expect(csp).toContain('http://localhost:*')
  })

  it('disables the unpublished Tauri updater wiring completely', () => {
    const config = JSON.parse(
      readFileSync(join(currentDir, 'tauri.conf.json'), 'utf8'),
    ) as {
      plugins?: {
        updater?: unknown
      }
      bundle?: {
        createUpdaterArtifacts?: unknown
      }
    }
    const capabilities = JSON.parse(
      readFileSync(join(currentDir, 'capabilities/default.json'), 'utf8'),
    ) as { permissions?: unknown[] }
    const cargoToml = readFileSync(join(currentDir, 'Cargo.toml'), 'utf8')
    const cargoLock = readFileSync(join(currentDir, 'Cargo.lock'), 'utf8')
    const libRs = readFileSync(join(currentDir, 'src/lib.rs'), 'utf8')

    expect(config.plugins).toBeUndefined()
    expect(config.bundle?.createUpdaterArtifacts).toBeUndefined()
    expect(existsSync(join(currentDir, 'tauri.release-ci.json'))).toBe(false)
    expect(capabilities.permissions).not.toContain('updater:default')
    expect(cargoToml).not.toContain('tauri-plugin-updater')
    expect(cargoToml).not.toMatch(/^reqwest\b/m)
    expect(cargoLock).not.toContain('name = "tauri-plugin-updater"')
    expect(libRs).not.toContain('tauri_plugin_updater')
  })

  it('disables automatic main window creation on all platform configs', () => {
    const configFiles = [
      'tauri.conf.json',
      'tauri.macos.conf.json',
      'tauri.windows.conf.json',
    ]

    for (const name of configFiles) {
      const config = JSON.parse(
        readFileSync(join(currentDir, name), 'utf8'),
      ) as {
        app?: {
          windows?: Array<{ create?: boolean; dataDirectory?: unknown }>
        }
      }
      const windows = config.app?.windows ?? []
      expect(windows.length).toBeGreaterThan(0)
      for (const window of windows) {
        expect(window.create).toBe(false)
        expect(window.dataDirectory).toBeUndefined()
      }
    }
  })

  it('uses the primary Tauri identifier and rejects the provisional identity', () => {
    const config = JSON.parse(
      readFileSync(join(currentDir, 'tauri.conf.json'), 'utf8'),
    ) as { identifier?: string; productName?: string }

    expect(config.identifier).toBe('com.ccmax.desktop')
    expect(config.identifier).not.toBe('com.yaogjim.ccmax.desktop')
    expect(config.productName).toBe('ccmax')
  })

  it('uses ccmax productName and window titles on all platform configs', () => {
    const configFiles = [
      'tauri.conf.json',
      'tauri.macos.conf.json',
      'tauri.windows.conf.json',
    ]

    for (const name of configFiles) {
      const config = JSON.parse(
        readFileSync(join(currentDir, name), 'utf8'),
      ) as {
        productName?: string
        bundle?: { mainBinaryName?: unknown }
        app?: { windows?: Array<{ title?: string }> }
      }
      if (name === 'tauri.conf.json') {
        expect(config.productName).toBe('ccmax')
        expect(config.bundle?.mainBinaryName).toBeUndefined()
      }
      const titles = (config.app?.windows ?? []).map((window) => window.title)
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.every((title) => title === 'ccmax')).toBe(true)
    }
  })

  it('uses Cargo package ccmax, lib ccmax_lib, and the default unique bin', () => {
    const cargoToml = readFileSync(join(currentDir, 'Cargo.toml'), 'utf8')
    const cargoLock = readFileSync(join(currentDir, 'Cargo.lock'), 'utf8')
    const packageName = cargoToml.match(/^name = "([^"]+)"/m)?.[1]
    const libName = cargoToml.match(/\[lib\][\s\S]*?^name = "([^"]+)"/m)?.[1]

    expect(packageName).toBe('ccmax')
    expect(libName).toBe('ccmax_lib')
    expect(cargoToml).not.toContain('[[bin]]')
    expect(cargoToml).not.toContain('default-run')
    expect(cargoLock).toMatch(/^name = "ccmax"$/m)
    expect(cargoLock).not.toContain('name = "claude-code-desktop"')
  })

  it('rewrites main crate refs to ccmax_lib and current tray copy to ccmax', () => {
    const mainRs = readFileSync(join(currentDir, 'src/main.rs'), 'utf8')
    const libRs = readFileSync(join(currentDir, 'src/lib.rs'), 'utf8')

    expect(mainRs).toContain('ccmax_lib::')
    expect(mainRs).not.toContain('claude_code_desktop_lib')
    expect(libRs).toContain('.text(TRAY_SHOW_ID, "Show ccmax")')
    expect(libRs).toContain('.text(TRAY_QUIT_ID, "Quit ccmax")')
    expect(libRs).toContain('.tooltip("ccmax")')
    expect(libRs).not.toContain('Show Claude Code Haha')
    expect(libRs).not.toContain('Quit Claude Code Haha')
    expect(libRs).not.toContain('.tooltip("Claude Code Haha")')
  })

  it('uninstall hook stops current and legacy Tauri bins while install still stops only sidecars', () => {
    const hooks = readFileSync(join(currentDir, 'windows-installer-hooks.nsh'), 'utf8')
    const preinstall = hooks.slice(
      hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'),
      hooks.indexOf('!macroend'),
    )
    const preuninstall = hooks.slice(
      hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL'),
    )
    const sidecarNames = [
      'claude-sidecar-x86_64-pc-windows-msvc.exe',
      'claude-sidecar-aarch64-pc-windows-msvc.exe',
      'claude-sidecar.exe',
    ]

    expect(preinstall).toContain('Stopping running ccmax sidecars...')
    expect(preinstall).not.toContain('ccmax.exe')
    expect(preinstall).not.toContain('claude-code-desktop.exe')
    expect(preinstall).not.toContain('Claude Code Haha.exe')
    for (const sidecar of sidecarNames) {
      expect(preinstall).toContain(`/IM ${sidecar}`)
    }

    expect(preuninstall).toContain('Stopping running ccmax processes...')
    expect(preuninstall).toContain('/IM ccmax.exe')
    expect(preuninstall).toContain('/IM claude-code-desktop.exe')
    expect(preuninstall).not.toContain('Claude Code Haha.exe')
    expect(preuninstall.indexOf('/IM ccmax.exe')).toBeLessThan(
      preuninstall.indexOf('/IM claude-code-desktop.exe'),
    )
    for (const sidecar of sidecarNames) {
      expect(preuninstall).toContain(`/IM ${sidecar}`)
      expect(preuninstall.indexOf('/IM claude-code-desktop.exe')).toBeLessThan(
        preuninstall.indexOf(`/IM ${sidecar}`),
      )
    }
  })

  it('keeps local update-install teardown commands after disabling the unpublished updater', () => {
    const libRs = readFileSync(join(currentDir, 'src/lib.rs'), 'utf8')

    expect(libRs).toContain('fn prepare_for_update_install')
    expect(libRs).toContain('fn cancel_update_install')
    expect(libRs).toContain('prepare_for_update_install,')
    expect(libRs).toContain('cancel_update_install,')
    expect(libRs).toContain('stop_server_sidecar')
    expect(libRs).toContain('stop_adapters_sidecar')
  })

  it('brands the native menu copy with the ccmax product name', () => {
    const libRs = readFileSync(join(currentDir, 'src/lib.rs'), 'utf8')

    expect(libRs).toContain('MenuItemBuilder::with_id("nav_about", "关于 ccmax")')
    expect(libRs).toContain('SubmenuBuilder::new(app, "ccmax")')
    expect(libRs).not.toContain('关于 Claude Code Haha')
    expect(libRs).not.toContain('SubmenuBuilder::new(app, "Claude Code Haha")')
  })

  it('keeps local update-install teardown commands after disabling the unpublished updater', () => {
    const libRs = readFileSync(join(currentDir, 'src/lib.rs'), 'utf8')

    expect(libRs).toContain('fn prepare_for_update_install')
    expect(libRs).toContain('fn cancel_update_install')
    expect(libRs).toContain('prepare_for_update_install,')
    expect(libRs).toContain('cancel_update_install,')
    expect(libRs).toContain('stop_server_sidecar')
    expect(libRs).toContain('stop_adapters_sidecar')
  })
})
