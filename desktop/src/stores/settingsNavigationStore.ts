import { create } from 'zustand'
import {
  desktopUiPreferencesApi,
  type DesktopSettingsNavigationPreferences,
  type DesktopSkillMarketPreferences,
} from '../api/desktopUiPreferences'
import { MARKET_TAB_ID, useTabStore } from './tabStore'
import { useUIStore, type SettingsTab } from './uiStore'

export const OPTIONAL_SETTINGS_TABS = [
  'h5Access',
  'terminal',
  'adapters',
  'pets',
  'trace',
  'diagnostics',
  'about',
] as const

export type OptionalSettingsTab = typeof OPTIONAL_SETTINGS_TABS[number]

export const DEFAULT_SETTINGS_NAVIGATION_PREFERENCES: DesktopSettingsNavigationPreferences = {
  terminal: false,
  adapters: false,
  pets: false,
  trace: false,
  diagnostics: false,
  about: false,
  h5Access: false,
}

export const VISIBLE_SETTINGS_NAVIGATION_PREFERENCES: DesktopSettingsNavigationPreferences = {
  terminal: true,
  adapters: true,
  pets: true,
  trace: true,
  diagnostics: true,
  about: true,
  h5Access: true,
}

export const DEFAULT_SKILL_MARKET_PREFERENCES: DesktopSkillMarketPreferences = {
  visible: false,
  url: '',
}

export const FALLBACK_SETTINGS_TAB: SettingsTab = 'system'

const MAX_SKILL_MARKET_URL_LENGTH = 2_048

type SettingsNavigationState = {
  preferences: DesktopSettingsNavigationPreferences
  skillMarket: DesktopSkillMarketPreferences
  saveError: string | null
  hydrated: boolean
  hydrate: () => Promise<void>
  applyLoadedPreferences: (
    preferences?: DesktopSettingsNavigationPreferences | null,
    skillMarket?: DesktopSkillMarketPreferences | null,
  ) => void
  setTabVisible: (tab: OptionalSettingsTab, visible: boolean) => Promise<void>
  setSkillMarketVisible: (visible: boolean) => Promise<void>
  setSkillMarketUrl: (url: string) => Promise<boolean>
  isSettingsTabVisible: (tab: SettingsTab) => boolean
  isSkillMarketVisible: () => boolean
  resolveVisibleSettingsTab: (tab: SettingsTab) => SettingsTab
}

function isOptionalSettingsTab(tab: SettingsTab): tab is OptionalSettingsTab {
  return (OPTIONAL_SETTINGS_TABS as readonly string[]).includes(tab)
}

function applyVisibleSettingsTab(tab: SettingsTab): SettingsTab {
  const visibleTab = useSettingsNavigationStore.getState().resolveVisibleSettingsTab(tab)
  if (visibleTab !== useUIStore.getState().activeSettingsTab) {
    useUIStore.getState().setActiveSettingsTab(visibleTab)
  }
  return visibleTab
}

function closeHiddenMarketTab() {
  const tabStore = useTabStore.getState()
  if (typeof tabStore.closeTab !== 'function') return
  const hasMarketTab = tabStore.tabs?.some((tab) => tab.sessionId === MARKET_TAB_ID || tab.type === 'market')
  if (hasMarketTab) tabStore.closeTab(MARKET_TAB_ID)
}

export function enforceHiddenSkillMarketTab() {
  const state = useSettingsNavigationStore.getState()
  if (!state.hydrated || state.skillMarket.visible) return
  closeHiddenMarketTab()
}

export function parseSkillMarketUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.length > MAX_SKILL_MARKET_URL_LENGTH) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export const useSettingsNavigationStore = create<SettingsNavigationState>((set, get) => ({
  preferences: { ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES },
  skillMarket: { ...DEFAULT_SKILL_MARKET_PREFERENCES },
  saveError: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const response = await desktopUiPreferencesApi.getPreferences()
      get().applyLoadedPreferences(
        response.preferences.settingsNavigation,
        response.preferences.skillMarket,
      )
    } catch {
      get().applyLoadedPreferences(null, null)
    }
  },

  applyLoadedPreferences: (preferences, skillMarket) => {
    const nextMarket = skillMarket ?? { ...DEFAULT_SKILL_MARKET_PREFERENCES }
    set({
      preferences: preferences ?? { ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES },
      skillMarket: nextMarket,
      saveError: null,
      hydrated: true,
    })
    applyVisibleSettingsTab(useUIStore.getState().activeSettingsTab)
    if (!nextMarket.visible) closeHiddenMarketTab()
  },

  setTabVisible: async (tab, visible) => {
    const current = get().preferences
    if (current[tab] === visible) return

    const next = { ...current, [tab]: visible }
    set({ preferences: next, saveError: null })
    applyVisibleSettingsTab(useUIStore.getState().activeSettingsTab)

    try {
      const result = await desktopUiPreferencesApi.updateSettingsNavigationPreferences({ [tab]: visible })
      set({
        preferences: result.preferences.settingsNavigation,
        saveError: null,
      })
      applyVisibleSettingsTab(useUIStore.getState().activeSettingsTab)
    } catch {
      set({
        preferences: current,
        saveError: 'settings.system.saveError',
      })
      applyVisibleSettingsTab(useUIStore.getState().activeSettingsTab)
    }
  },

  setSkillMarketVisible: async (visible) => {
    const current = get().skillMarket
    if (current.visible === visible) return

    const next = { ...current, visible }
    set({ skillMarket: next, saveError: null })
    if (!visible) closeHiddenMarketTab()

    try {
      const result = await desktopUiPreferencesApi.updateSkillMarketPreferences({ visible })
      set({
        skillMarket: result.preferences.skillMarket,
        saveError: null,
      })
      if (!result.preferences.skillMarket.visible) closeHiddenMarketTab()
    } catch {
      set({
        skillMarket: current,
        saveError: 'settings.system.saveError',
      })
    }
  },

  setSkillMarketUrl: async (url) => {
    const parsed = parseSkillMarketUrl(url)
    if (parsed === null) return false

    const current = get().skillMarket
    if (current.url === parsed) {
      set({ saveError: null })
      return true
    }

    const next = { ...current, url: parsed }
    set({ skillMarket: next, saveError: null })

    try {
      const result = await desktopUiPreferencesApi.updateSkillMarketPreferences({ url: parsed })
      set({
        skillMarket: result.preferences.skillMarket,
        saveError: null,
      })
      return true
    } catch {
      set({
        skillMarket: current,
        saveError: 'settings.system.saveError',
      })
      return false
    }
  },

  isSettingsTabVisible: (tab) => {
    if (!isOptionalSettingsTab(tab)) return true
    return get().preferences[tab]
  },

  isSkillMarketVisible: () => get().skillMarket.visible,

  resolveVisibleSettingsTab: (tab) => {
    if (!get().hydrated) return tab
    return get().isSettingsTabVisible(tab) ? tab : FALLBACK_SETTINGS_TAB
  },
}))