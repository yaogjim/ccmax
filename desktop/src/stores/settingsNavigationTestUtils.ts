import type { DesktopSettingsNavigationPreferences } from '../api/desktopUiPreferences'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  VISIBLE_SETTINGS_NAVIGATION_PREFERENCES,
  useSettingsNavigationStore,
} from './settingsNavigationStore'

export function resetSettingsNavigationStore(
  overrides: {
    preferences?: Partial<DesktopSettingsNavigationPreferences>
    hydrated?: boolean
    saveError?: string | null
  } = {},
) {
  useSettingsNavigationStore.setState({
    preferences: {
      ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      ...overrides.preferences,
    },
    hydrated: overrides.hydrated ?? false,
    saveError: overrides.saveError ?? null,
  })
}

export function showOptionalSettingsMenus(
  preferences: Partial<DesktopSettingsNavigationPreferences> = VISIBLE_SETTINGS_NAVIGATION_PREFERENCES,
) {
  resetSettingsNavigationStore({
    preferences,
    hydrated: true,
  })
}