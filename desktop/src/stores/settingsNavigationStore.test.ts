import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPreferences, updateSettingsNavigationPreferences } = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updateSettingsNavigationPreferences: vi.fn(),
}))

vi.mock('../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences,
    updateSettingsNavigationPreferences,
  },
}))

import { useUIStore } from './uiStore'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  FALLBACK_SETTINGS_TAB,
  useSettingsNavigationStore,
} from './settingsNavigationStore'
import { resetSettingsNavigationStore } from './settingsNavigationTestUtils'

function preferencesResponse(
  settingsNavigation = DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
) {
  return {
    exists: true,
    preferences: {
      schemaVersion: 5,
      sidebar: {},
      profile: {},
      pet: {},
      settingsNavigation,
    },
  }
}

describe('settingsNavigationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSettingsNavigationStore()
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  it('keeps optional tabs hidden and does not rewrite the restored tab before hydrate', () => {
    useUIStore.setState({ activeSettingsTab: 'diagnostics' })

    expect(useSettingsNavigationStore.getState().isSettingsTabVisible('diagnostics')).toBe(false)
    expect(useSettingsNavigationStore.getState().isSettingsTabVisible('system')).toBe(true)
    expect(useSettingsNavigationStore.getState().resolveVisibleSettingsTab('diagnostics')).toBe('diagnostics')
    expect(useUIStore.getState().activeSettingsTab).toBe('diagnostics')
  })

  it('hydrates saved visibility and keeps an enabled restored tab', async () => {
    useUIStore.setState({ activeSettingsTab: 'diagnostics' })
    getPreferences.mockResolvedValueOnce(preferencesResponse({
      ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      diagnostics: true,
    }))

    await useSettingsNavigationStore.getState().hydrate()

    expect(useSettingsNavigationStore.getState().hydrated).toBe(true)
    expect(useSettingsNavigationStore.getState().preferences.diagnostics).toBe(true)
    expect(useUIStore.getState().activeSettingsTab).toBe('diagnostics')
  })

  it('falls back a restored hidden tab to System after hydrate', async () => {
    useUIStore.setState({ activeSettingsTab: 'pets' })
    getPreferences.mockResolvedValueOnce(preferencesResponse())

    await useSettingsNavigationStore.getState().hydrate()

    expect(useSettingsNavigationStore.getState().resolveVisibleSettingsTab('pets')).toBe(FALLBACK_SETTINGS_TAB)
    expect(useUIStore.getState().activeSettingsTab).toBe('system')
  })

  it('treats a missing or failed preference read as default-hidden', async () => {
    useUIStore.setState({ activeSettingsTab: 'trace' })
    getPreferences.mockRejectedValueOnce(new Error('unavailable'))

    await useSettingsNavigationStore.getState().hydrate()

    expect(useSettingsNavigationStore.getState().preferences).toEqual(DEFAULT_SETTINGS_NAVIGATION_PREFERENCES)
    expect(useSettingsNavigationStore.getState().hydrated).toBe(true)
    expect(useUIStore.getState().activeSettingsTab).toBe('system')
  })

  it('persists a visibility toggle and rolls back when the save fails', async () => {
    resetSettingsNavigationStore({ hydrated: true })
    updateSettingsNavigationPreferences.mockRejectedValueOnce(new Error('write failed'))

    await useSettingsNavigationStore.getState().setTabVisible('trace', true)

    expect(useSettingsNavigationStore.getState().preferences.trace).toBe(false)
    expect(useSettingsNavigationStore.getState().saveError).toBe('settings.system.saveError')

    updateSettingsNavigationPreferences.mockResolvedValueOnce(preferencesResponse({
      ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      trace: true,
    }))

    await useSettingsNavigationStore.getState().setTabVisible('trace', true)

    expect(updateSettingsNavigationPreferences).toHaveBeenLastCalledWith({ trace: true })
    expect(useSettingsNavigationStore.getState().preferences.trace).toBe(true)
    expect(useSettingsNavigationStore.getState().saveError).toBeNull()
  })

  it('leaves the current page when the active optional tab is hidden', async () => {
    resetSettingsNavigationStore({
      preferences: { diagnostics: true },
      hydrated: true,
    })
    useUIStore.setState({ activeSettingsTab: 'diagnostics' })
    updateSettingsNavigationPreferences.mockResolvedValueOnce(preferencesResponse())

    await useSettingsNavigationStore.getState().setTabVisible('diagnostics', false)

    expect(useUIStore.getState().activeSettingsTab).toBe('system')
  })
})