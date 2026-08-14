import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPreferences, updateSettingsNavigationPreferences, updateSkillMarketPreferences } = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updateSettingsNavigationPreferences: vi.fn(),
  updateSkillMarketPreferences: vi.fn(),
}))

vi.mock('../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences,
    updateSettingsNavigationPreferences,
    updateSkillMarketPreferences,
  },
}))

import { MARKET_TAB_ID, useTabStore } from './tabStore'
import { useUIStore } from './uiStore'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  DEFAULT_SKILL_MARKET_PREFERENCES,
  FALLBACK_SETTINGS_TAB,
  enforceHiddenSkillMarketTab,
  parseSkillMarketUrl,
  useSettingsNavigationStore,
} from './settingsNavigationStore'
import { resetSettingsNavigationStore } from './settingsNavigationTestUtils'

function preferencesResponse(
  settingsNavigation = DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  skillMarket = DEFAULT_SKILL_MARKET_PREFERENCES,
) {
  return {
    exists: true,
    preferences: {
      schemaVersion: 6,
      sidebar: {},
      profile: {},
      pet: {},
      settingsNavigation,
      skillMarket,
    },
  }
}

describe('settingsNavigationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSettingsNavigationStore()
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('keeps optional tabs hidden and does not rewrite the restored tab before hydrate', () => {
    useUIStore.setState({ activeSettingsTab: 'diagnostics' })

    expect(useSettingsNavigationStore.getState().isSettingsTabVisible('diagnostics')).toBe(false)
    expect(useSettingsNavigationStore.getState().isSettingsTabVisible('h5Access')).toBe(false)
    expect(useSettingsNavigationStore.getState().isSettingsTabVisible('system')).toBe(true)
    expect(useSettingsNavigationStore.getState().isSkillMarketVisible()).toBe(false)
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

  it('falls back a restored hidden H5 tab to System after hydrate', async () => {
    useUIStore.setState({ activeSettingsTab: 'h5Access' })
    getPreferences.mockResolvedValueOnce(preferencesResponse())

    await useSettingsNavigationStore.getState().hydrate()

    expect(useSettingsNavigationStore.getState().resolveVisibleSettingsTab('h5Access')).toBe(FALLBACK_SETTINGS_TAB)
    expect(useUIStore.getState().activeSettingsTab).toBe('system')
  })

  it('treats a missing or failed preference read as default-hidden', async () => {
    useUIStore.setState({ activeSettingsTab: 'trace' })
    getPreferences.mockRejectedValueOnce(new Error('unavailable'))

    await useSettingsNavigationStore.getState().hydrate()

    expect(useSettingsNavigationStore.getState().preferences).toEqual(DEFAULT_SETTINGS_NAVIGATION_PREFERENCES)
    expect(useSettingsNavigationStore.getState().skillMarket).toEqual(DEFAULT_SKILL_MARKET_PREFERENCES)
    expect(useSettingsNavigationStore.getState().hydrated).toBe(true)
    expect(useUIStore.getState().activeSettingsTab).toBe('system')
  })

  it('closes a restored market tab after hydrate when the sidebar entry is hidden', async () => {
    useTabStore.setState({
      tabs: [{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' }],
      activeTabId: MARKET_TAB_ID,
    })
    getPreferences.mockResolvedValueOnce(preferencesResponse())

    await useSettingsNavigationStore.getState().hydrate()

    expect(useTabStore.getState().tabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('closes a restored market tab after later restore when the sidebar entry is hidden', () => {
    resetSettingsNavigationStore({ hydrated: true })
    useTabStore.setState({
      tabs: [{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' }],
      activeTabId: MARKET_TAB_ID,
    })

    enforceHiddenSkillMarketTab()

    expect(useTabStore.getState().tabs).toEqual([])
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

  it('persists skill market visibility and URL, and closes the market tab when hidden', async () => {
    resetSettingsNavigationStore({
      skillMarket: { visible: true, url: '' },
      hydrated: true,
    })
    useTabStore.setState({
      tabs: [{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' }],
      activeTabId: MARKET_TAB_ID,
    })
    updateSkillMarketPreferences.mockResolvedValueOnce(preferencesResponse(
      DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      { visible: false, url: '' },
    ))

    await useSettingsNavigationStore.getState().setSkillMarketVisible(false)

    expect(updateSkillMarketPreferences).toHaveBeenCalledWith({ visible: false })
    expect(useSettingsNavigationStore.getState().skillMarket.visible).toBe(false)
    expect(useTabStore.getState().tabs).toEqual([])

    updateSkillMarketPreferences.mockResolvedValueOnce(preferencesResponse(
      DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      { visible: false, url: 'https://market.example/skills' },
    ))

    await expect(useSettingsNavigationStore.getState().setSkillMarketUrl('https://market.example/skills'))
      .resolves.toBe(true)
    expect(updateSkillMarketPreferences).toHaveBeenLastCalledWith({ url: 'https://market.example/skills' })
    expect(useSettingsNavigationStore.getState().skillMarket.url).toBe('https://market.example/skills')
  })

  it('rejects an unsafe skill market URL without calling the API', async () => {
    resetSettingsNavigationStore({ hydrated: true })

    await expect(useSettingsNavigationStore.getState().setSkillMarketUrl('javascript:alert(1)'))
      .resolves.toBe(false)
    expect(updateSkillMarketPreferences).not.toHaveBeenCalled()
    expect(parseSkillMarketUrl('javascript:alert(1)')).toBeNull()
    expect(parseSkillMarketUrl('')).toBe('')
    expect(parseSkillMarketUrl(' HTTPS://Market.Example/skills ')).toBe('https://market.example/skills')
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