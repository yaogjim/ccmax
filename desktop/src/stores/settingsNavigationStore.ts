import { create } from 'zustand'
import {
  desktopUiPreferencesApi,
  type DesktopSettingsNavigationPreferences,
} from '../api/desktopUiPreferences'
import { useUIStore, type SettingsTab } from './uiStore'

export const OPTIONAL_SETTINGS_TABS = [
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
}

export const VISIBLE_SETTINGS_NAVIGATION_PREFERENCES: DesktopSettingsNavigationPreferences = {
  terminal: true,
  adapters: true,
  pets: true,
  trace: true,
  diagnostics: true,
  about: true,
}

export const FALLBACK_SETTINGS_TAB: SettingsTab = 'system'

type SettingsNavigationState = {
  preferences: DesktopSettingsNavigationPreferences
  saveError: string | null
  hydrated: boolean
  hydrate: () => Promise<void>
  applyLoadedPreferences: (preferences?: DesktopSettingsNavigationPreferences | null) => void
  setTabVisible: (tab: OptionalSettingsTab, visible: boolean) => Promise<void>
  isSettingsTabVisible: (tab: SettingsTab) => boolean
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

export const useSettingsNavigationStore = create<SettingsNavigationState>((set, get) => ({
  preferences: { ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES },
  saveError: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const response = await desktopUiPreferencesApi.getPreferences()
      get().applyLoadedPreferences(response.preferences.settingsNavigation)
    } catch {
      get().applyLoadedPreferences(null)
    }
  },

  applyLoadedPreferences: (preferences) => {
    set({
      preferences: preferences ?? { ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES },
      saveError: null,
      hydrated: true,
    })
    applyVisibleSettingsTab(useUIStore.getState().activeSettingsTab)
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

  isSettingsTabVisible: (tab) => {
    if (!isOptionalSettingsTab(tab)) return true
    return get().preferences[tab]
  },

  resolveVisibleSettingsTab: (tab) => {
    if (!get().hydrated) return tab
    return get().isSettingsTabVisible(tab) ? tab : FALLBACK_SETTINGS_TAB
  },
}))