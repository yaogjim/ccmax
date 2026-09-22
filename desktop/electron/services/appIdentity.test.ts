import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { applyWindowsAppUserModelId, WINDOWS_APP_USER_MODEL_ID } from './appIdentity'

describe('applyWindowsAppUserModelId', () => {
  it('sets the unique primary AppUserModelID on Windows so toast notifications are attributed to the app', () => {
    const setAppUserModelId = vi.fn()
    const result = applyWindowsAppUserModelId({ setAppUserModelId }, 'win32')
    expect(WINDOWS_APP_USER_MODEL_ID).toBe('com.ccmax.desktop')
    expect(WINDOWS_APP_USER_MODEL_ID).not.toBe('com.yaogjim.ccmax.desktop')
    expect(result).toBe(true)
    expect(setAppUserModelId).toHaveBeenCalledWith('com.ccmax.desktop')
  })

  it('is a no-op on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const setAppUserModelId = vi.fn()
      expect(applyWindowsAppUserModelId({ setAppUserModelId }, platform)).toBe(false)
      expect(setAppUserModelId).not.toHaveBeenCalled()
    }
  })

  it('keeps the AppUserModelID in sync with the unique primary build.appId in package.json', () => {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { build?: { appId?: string } }
    expect(pkg.build?.appId).toBe('com.ccmax.desktop')
    expect(pkg.build?.appId).not.toBe('com.yaogjim.ccmax.desktop')
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(pkg.build?.appId)
    expect(WINDOWS_APP_USER_MODEL_ID).toBe('com.ccmax.desktop')
  })
})
