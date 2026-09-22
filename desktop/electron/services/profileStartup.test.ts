import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { runProfileStartup } from './profileStartup'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')

describe('profileStartup orchestration', () => {
  it('runs prepare → setPath → lock in exact order and returns the lock result', async () => {
    const order: string[] = []
    const result = await runProfileStartup({
      prepareProfile: async () => {
        order.push('prepare')
        return { activePath: '/tmp/ccmax-profile' }
      },
      setUserDataPath: activePath => {
        order.push(`setPath:${activePath}`)
      },
      acquireSingleInstanceLock: () => {
        order.push('lock')
        return true
      },
    })

    expect(order).toEqual([
      'prepare',
      'setPath:/tmp/ccmax-profile',
      'lock',
    ])
    expect(result).toEqual({
      activePath: '/tmp/ccmax-profile',
      hasLock: true,
    })
  })

  it('still calls setPath with the fallback path before lock when prepare reports legacy', async () => {
    const order: string[] = []
    const setUserDataPath = vi.fn((activePath: string) => {
      order.push(`setPath:${activePath}`)
    })
    const acquireSingleInstanceLock = vi.fn(() => {
      order.push('lock')
      return false
    })

    const result = await runProfileStartup({
      prepareProfile: async () => {
        order.push('prepare')
        return { activePath: '/tmp/Claude Code Haha' }
      },
      setUserDataPath,
      acquireSingleInstanceLock,
    })

    expect(order).toEqual([
      'prepare',
      'setPath:/tmp/Claude Code Haha',
      'lock',
    ])
    expect(setUserDataPath).toHaveBeenCalledWith('/tmp/Claude Code Haha')
    expect(acquireSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(result.hasLock).toBe(false)
    expect(result.activePath).toBe('/tmp/Claude Code Haha')
  })

  it('keeps main bootstrap ordered: prepare/setPath before lock, no top-level await', () => {
    const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')

    expect(mainSource).toContain('runProfileStartup')
    expect(mainSource).toContain('prepareUserDataProfile')
    expect(mainSource).toContain("app.setPath('userData'")
    expect(mainSource).toContain('if (!acquireSingleInstanceLock')
    expect(mainSource).not.toMatch(/^await /m)

    const bootstrapIdx = mainSource.indexOf('async function bootstrap()')
    const prepareIdx = mainSource.indexOf('prepareUserDataProfile(app)')
    const setPathIdx = mainSource.indexOf("app.setPath('userData'")
    const lockIdx = mainSource.indexOf('if (!acquireSingleInstanceLock')
    const registerIpcIdx = mainSource.indexOf('registerIpcHandlers()', bootstrapIdx)
    const whenReadyIdx = mainSource.indexOf('app.whenReady()', bootstrapIdx)
    const windowAllClosedIdx = mainSource.indexOf("app.on('window-all-closed'")
    const beforeQuitIdx = mainSource.indexOf("app.on('before-quit'")

    expect(bootstrapIdx).toBeGreaterThan(-1)
    expect(prepareIdx).toBeGreaterThan(bootstrapIdx)
    expect(setPathIdx).toBeGreaterThan(prepareIdx)
    expect(lockIdx).toBeGreaterThan(setPathIdx)
    expect(registerIpcIdx).toBeGreaterThan(lockIdx)
    expect(whenReadyIdx).toBeGreaterThan(registerIpcIdx)
    // Lifecycle listeners stay registered once, outside the async ready chain body.
    expect(windowAllClosedIdx).toBeGreaterThan(-1)
    expect(beforeQuitIdx).toBeGreaterThan(-1)
    expect(mainSource.split("app.on('window-all-closed'").length - 1).toBe(1)
    expect(mainSource.split("app.on('before-quit'").length - 1).toBe(1)
  })
})