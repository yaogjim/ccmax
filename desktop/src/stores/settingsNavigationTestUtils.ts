import type {
  DesktopSettingsNavigationPreferences,
  DesktopSkillMarketPreferences,
} from '../api/desktopUiPreferences'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  DEFAULT_SKILL_MARKET_PREFERENCES,
  VISIBLE_SETTINGS_NAVIGATION_PREFERENCES,
  useSettingsNavigationStore,
} from './settingsNavigationStore'

export function resetSettingsNavigationStore(
  overrides: {
    preferences?: Partial<DesktopSettingsNavigationPreferences>
    skillMarket?: Partial<DesktopSkillMarketPreferences>
    hydrated?: boolean
    saveError?: string | null
  } = {},
) {
  useSettingsNavigationStore.setState({
    preferences: {
      ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
      ...overrides.preferences,
    },
    skillMarket: {
      ...DEFAULT_SKILL_MARKET_PREFERENCES,
      ...overrides.skillMarket,
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

export function showSkillMarket(
  skillMarket: Partial<DesktopSkillMarketPreferences> = { visible: true },
) {
  resetSettingsNavigationStore({
    skillMarket,
    hydrated: true,
  })
}