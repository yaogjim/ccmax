import { beforeEach, describe, expect, test } from 'vitest'
import {
  APP_ZOOM_STORAGE_KEY,
  DESKTOP_PERSISTENCE_KEYS,
  LEGACY_APP_ZOOM_STORAGE_KEY,
  LEGACY_TAB_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  TAB_STORAGE_KEY,
  copyAppZoomLegacyIfCanonicalMissing,
  copyLegacyIfCanonicalMissing,
  copyStage18LegacyKeysIfMissing,
  readAppZoomRaw,
  readCanonicalFirst,
  writeCanonical,
} from './persistenceKeys'

describe('persistenceKeys registry helpers', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('reads canonical first and falls back to legacy', () => {
    window.localStorage.setItem(LEGACY_TAB_STORAGE_KEY, 'legacy-tabs')
    expect(readCanonicalFirst(window.localStorage, DESKTOP_PERSISTENCE_KEYS.openTabs)).toBe('legacy-tabs')

    window.localStorage.setItem(TAB_STORAGE_KEY, 'canonical-tabs')
    expect(readCanonicalFirst(window.localStorage, DESKTOP_PERSISTENCE_KEYS.openTabs)).toBe('canonical-tabs')
  })

  test('writes only the canonical key', () => {
    window.localStorage.setItem(LEGACY_TAB_STORAGE_KEY, 'legacy-tabs')
    writeCanonical(window.localStorage, DESKTOP_PERSISTENCE_KEYS.openTabs, 'next')

    expect(window.localStorage.getItem(TAB_STORAGE_KEY)).toBe('next')
    expect(window.localStorage.getItem(LEGACY_TAB_STORAGE_KEY)).toBe('legacy-tabs')
  })

  test('copies legacy only when canonical is missing and never overwrites', () => {
    window.localStorage.setItem(LEGACY_TAB_STORAGE_KEY, 'from-legacy')
    expect(copyLegacyIfCanonicalMissing(window.localStorage, DESKTOP_PERSISTENCE_KEYS.openTabs)).toBe(true)
    expect(window.localStorage.getItem(TAB_STORAGE_KEY)).toBe('from-legacy')
    expect(window.localStorage.getItem(LEGACY_TAB_STORAGE_KEY)).toBe('from-legacy')

    window.localStorage.setItem(TAB_STORAGE_KEY, 'keep-canonical')
    window.localStorage.setItem(LEGACY_TAB_STORAGE_KEY, 'different-legacy')
    expect(copyLegacyIfCanonicalMissing(window.localStorage, DESKTOP_PERSISTENCE_KEYS.openTabs)).toBe(false)
    expect(window.localStorage.getItem(TAB_STORAGE_KEY)).toBe('keep-canonical')
    expect(window.localStorage.getItem(LEGACY_TAB_STORAGE_KEY)).toBe('different-legacy')
  })

  test('app zoom read order is canonical → app-zoom legacy → ui-zoom', () => {
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.1')
    expect(readAppZoomRaw(window.localStorage)).toBe('1.1')

    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.2')
    expect(readAppZoomRaw(window.localStorage)).toBe('1.2')

    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, '1.3')
    expect(readAppZoomRaw(window.localStorage)).toBe('1.3')
  })

  test('app zoom copy prefers app-zoom legacy over ui-zoom and keeps both old keys', () => {
    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.25')
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.5')

    expect(copyAppZoomLegacyIfCanonicalMissing(window.localStorage)).toBe(true)
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.25')
    expect(window.localStorage.getItem(LEGACY_APP_ZOOM_STORAGE_KEY)).toBe('1.25')
    expect(window.localStorage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)).toBe('1.5')
  })

  test('app zoom copy falls back to ui-zoom when app-zoom legacy is absent', () => {
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.4')
    expect(copyAppZoomLegacyIfCanonicalMissing(window.localStorage)).toBe(true)
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.4')
    expect(window.localStorage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)).toBe('1.4')
  })

  test('stage-18 bulk copy is idempotent and preserves legacy keys', () => {
    window.localStorage.setItem(LEGACY_TAB_STORAGE_KEY, '{"openTabs":[]}')
    window.localStorage.setItem(DESKTOP_PERSISTENCE_KEYS.theme.legacy, 'dark')
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.1')

    const first = copyStage18LegacyKeysIfMissing(window.localStorage)
    expect(first).toEqual(expect.arrayContaining([
      TAB_STORAGE_KEY,
      DESKTOP_PERSISTENCE_KEYS.theme.canonical,
      APP_ZOOM_STORAGE_KEY,
    ]))

    const second = copyStage18LegacyKeysIfMissing(window.localStorage)
    expect(second).toEqual([])

    expect(window.localStorage.getItem(LEGACY_TAB_STORAGE_KEY)).toBe('{"openTabs":[]}')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.theme.legacy)).toBe('dark')
    expect(window.localStorage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)).toBe('1.1')
  })

  test('stage-19 remaining keys copy with legacy fallback and write canonical only', () => {
    const stage19Pairs = [
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder,
      DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects,
      DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects,
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization,
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort,
      DESKTOP_PERSISTENCE_KEYS.h5ServerUrl,
      DESKTOP_PERSISTENCE_KEYS.h5Token,
      DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion,
      DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed,
      DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns,
      DESKTOP_PERSISTENCE_KEYS.scheduledTaskNotificationScan,
    ] as const

    for (const pair of stage19Pairs) {
      window.localStorage.setItem(pair.legacy, `legacy:${pair.canonical}`)
    }

    const copied = copyStage18LegacyKeysIfMissing(window.localStorage)
    for (const pair of stage19Pairs) {
      expect(copied).toContain(pair.canonical)
      expect(readCanonicalFirst(window.localStorage, pair)).toBe(`legacy:${pair.canonical}`)
      expect(window.localStorage.getItem(pair.legacy)).toBe(`legacy:${pair.canonical}`)

      writeCanonical(window.localStorage, pair, `next:${pair.canonical}`)
      expect(window.localStorage.getItem(pair.canonical)).toBe(`next:${pair.canonical}`)
      expect(window.localStorage.getItem(pair.legacy)).toBe(`legacy:${pair.canonical}`)
      expect(readCanonicalFirst(window.localStorage, pair)).toBe(`next:${pair.canonical}`)
    }
  })
})