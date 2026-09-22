import { beforeEach, describe, expect, it, vi } from 'vitest'

const doctorApiMock = vi.hoisted(() => ({
  report: vi.fn(),
}))

vi.mock('../api/doctor', () => ({
  doctorApi: doctorApiMock,
}))

import {
  APP_ZOOM_STORAGE_KEY,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  LEGACY_APP_ZOOM_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from './persistenceKeys'
import { SAFE_DOCTOR_STORAGE_KEYS, runDoctorCheck, runLocalDoctorRepair } from './doctorRepair'

describe('doctorRepair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears only the safe desktop UI storage keys (canonical and legacy)', () => {
    window.localStorage.clear()
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      window.localStorage.setItem(key, `${key}-value`)
    }
    window.localStorage.setItem('cc-haha-chat-history', 'preserve')
    window.localStorage.setItem('cc-haha-provider-config', 'preserve')

    const result = runLocalDoctorRepair(window.localStorage)

    expect(result.removedKeys).toEqual(expect.arrayContaining([...SAFE_DOCTOR_STORAGE_KEYS]))
    expect(result.failedKeys).toEqual([])
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull()
    }
    expect(window.localStorage.getItem('cc-haha-chat-history')).toBe('preserve')
    expect(window.localStorage.getItem('cc-haha-provider-config')).toBe('preserve')
  })

  it('resets the appearance completely, including dark theme keys', () => {
    // The theme is four keys. Clearing only the applied one leaves the
    // follow-the-system switch and ground preferences behind, so the reset
    // would not restore the out-of-the-box appearance.
    expect(SAFE_DOCTOR_STORAGE_KEYS).toEqual(expect.arrayContaining([
      THEME_STORAGE_KEY,
      LEGACY_THEME_STORAGE_KEY,
      'ccmax-follow-system-theme',
      'cc-haha-follow-system-theme',
      'ccmax-light-theme',
      'cc-haha-light-theme',
      'ccmax-dark-theme',
      'cc-haha-dark-theme',
      APP_ZOOM_STORAGE_KEY,
      LEGACY_APP_ZOOM_STORAGE_KEY,
      DESKTOP_PERSISTENCE_VERSION_KEY,
    ]))
  })

  it('keeps local repair non-throwing when storage access is blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
    }

    const result = runLocalDoctorRepair(storage)

    expect(result.removedKeys).toEqual([])
    expect(result.failedKeys).toEqual(expect.arrayContaining([...SAFE_DOCTOR_STORAGE_KEYS]))
  })

  it('checks the server report for the active cwd without clearing desktop state', async () => {
    window.localStorage.clear()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'dark')
    doctorApiMock.report.mockResolvedValueOnce({
      report: {
        generatedAt: '2026-07-11T00:00:00.000Z',
        items: [],
        protectedSkips: [],
        summary: { total: 0, protectedCount: 0, missingCount: 0, invalidCount: 0 },
      },
    })

    const report = await runDoctorCheck({ cwd: '/workspace/project' })

    expect(doctorApiMock.report).toHaveBeenCalledWith('/workspace/project')
    expect(report.summary.total).toBe(0)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
  })
})