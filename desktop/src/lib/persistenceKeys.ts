/**
 * Renderer localStorage key registry for branded UI persistence (Stage 18–19).
 *
 * Pure helpers only: no store/UI imports. Consumers read canonical-first with
 * legacy fallback; normal writes touch only the canonical key. Startup
 * migration copies legacy → canonical when the new key is absent and never
 * overwrites an existing canonical value. Legacy keys are never deleted here.
 */

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type PersistenceKeyPair = {
  canonical: string
  legacy: string
}

export const DESKTOP_PERSISTENCE_KEYS = {
  schemaVersion: {
    canonical: 'ccmax.persistence.schemaVersion',
    legacy: 'cc-haha.persistence.schemaVersion',
  },
  openTabs: {
    canonical: 'ccmax-open-tabs',
    legacy: 'cc-haha-open-tabs',
  },
  sessionRuntime: {
    canonical: 'ccmax-session-runtime',
    legacy: 'cc-haha-session-runtime',
  },
  theme: {
    canonical: 'ccmax-theme',
    legacy: 'cc-haha-theme',
  },
  followSystemTheme: {
    canonical: 'ccmax-follow-system-theme',
    legacy: 'cc-haha-follow-system-theme',
  },
  lightTheme: {
    canonical: 'ccmax-light-theme',
    legacy: 'cc-haha-light-theme',
  },
  darkTheme: {
    canonical: 'ccmax-dark-theme',
    legacy: 'cc-haha-dark-theme',
  },
  locale: {
    canonical: 'ccmax-locale',
    legacy: 'cc-haha-locale',
  },
  appZoom: {
    canonical: 'ccmax-app-zoom',
    legacy: 'cc-haha-app-zoom',
  },
  sidebarWidth: {
    canonical: 'ccmax-sidebar-width',
    legacy: 'cc-haha-sidebar-width',
  },
  activeSettingsTab: {
    canonical: 'ccmax-active-settings-tab',
    legacy: 'cc-haha-active-settings-tab',
  },
  // Stage-19 remaining renderer keys
  sidebarProjectOrder: {
    canonical: 'ccmax-sidebar-project-order',
    legacy: 'cc-haha-sidebar-project-order',
  },
  sidebarPinnedProjects: {
    canonical: 'ccmax-sidebar-pinned-projects',
    legacy: 'cc-haha-sidebar-pinned-projects',
  },
  sidebarHiddenProjects: {
    canonical: 'ccmax-sidebar-hidden-projects',
    legacy: 'cc-haha-sidebar-hidden-projects',
  },
  sidebarProjectOrganization: {
    canonical: 'ccmax-sidebar-project-organization',
    legacy: 'cc-haha-sidebar-project-organization',
  },
  sidebarProjectSort: {
    canonical: 'ccmax-sidebar-project-sort',
    legacy: 'cc-haha-sidebar-project-sort',
  },
  h5ServerUrl: {
    canonical: 'ccmax-h5-server-url',
    legacy: 'cc-haha-h5-server-url',
  },
  h5Token: {
    canonical: 'ccmax-h5-token',
    legacy: 'cc-haha-h5-token',
  },
  dismissedUpdateVersion: {
    canonical: 'ccmax-dismissed-update-version',
    legacy: 'cc-haha-dismissed-update-version',
  },
  marketDisclaimerDismissed: {
    canonical: 'ccmax-market-disclaimer-dismissed',
    legacy: 'cc-haha-market-disclaimer-dismissed',
  },
  notifiedDesktopTaskRuns: {
    canonical: 'ccmax.notifiedDesktopTaskRuns.v1',
    legacy: 'cc-haha.notifiedDesktopTaskRuns.v1',
  },
  scheduledTaskNotificationScan: {
    canonical: 'ccmax.scheduledTaskNotificationScan.v1',
    legacy: 'cc-haha.scheduledTaskNotificationScan.v1',
  },
} as const satisfies Record<string, PersistenceKeyPair>

/** Older zoom key kept only as a tertiary read fallback. */
export const LEGACY_UI_ZOOM_STORAGE_KEY = 'cc-haha-ui-zoom'

export const DESKTOP_PERSISTENCE_VERSION_KEY = DESKTOP_PERSISTENCE_KEYS.schemaVersion.canonical
export const LEGACY_DESKTOP_PERSISTENCE_VERSION_KEY = DESKTOP_PERSISTENCE_KEYS.schemaVersion.legacy

export const TAB_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.openTabs.canonical
export const LEGACY_TAB_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.openTabs.legacy

export const SESSION_RUNTIME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sessionRuntime.canonical
export const LEGACY_SESSION_RUNTIME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sessionRuntime.legacy

export const THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.theme.canonical
export const LEGACY_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.theme.legacy
export const FOLLOW_SYSTEM_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.followSystemTheme.canonical
export const LEGACY_FOLLOW_SYSTEM_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.followSystemTheme.legacy
export const LIGHT_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical
export const LEGACY_LIGHT_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.lightTheme.legacy
export const DARK_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.darkTheme.canonical
export const LEGACY_DARK_THEME_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.darkTheme.legacy

export const LOCALE_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.locale.canonical
export const LEGACY_LOCALE_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.locale.legacy

export const APP_ZOOM_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.appZoom.canonical
export const LEGACY_APP_ZOOM_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.appZoom.legacy

export const SIDEBAR_WIDTH_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarWidth.canonical
export const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarWidth.legacy

export const ACTIVE_SETTINGS_TAB_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.activeSettingsTab.canonical
export const LEGACY_ACTIVE_SETTINGS_TAB_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.activeSettingsTab.legacy

export const SIDEBAR_PROJECT_ORDER_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder.canonical
export const LEGACY_SIDEBAR_PROJECT_ORDER_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder.legacy
export const SIDEBAR_PINNED_PROJECTS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects.canonical
export const LEGACY_SIDEBAR_PINNED_PROJECTS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects.legacy
export const SIDEBAR_HIDDEN_PROJECTS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects.canonical
export const LEGACY_SIDEBAR_HIDDEN_PROJECTS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects.legacy
export const SIDEBAR_PROJECT_ORGANIZATION_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization.canonical
export const LEGACY_SIDEBAR_PROJECT_ORGANIZATION_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization.legacy
export const SIDEBAR_PROJECT_SORT_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort.canonical
export const LEGACY_SIDEBAR_PROJECT_SORT_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort.legacy

export const H5_SERVER_URL_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.h5ServerUrl.canonical
export const LEGACY_H5_SERVER_URL_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.h5ServerUrl.legacy
export const H5_TOKEN_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.h5Token.canonical
export const LEGACY_H5_TOKEN_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.h5Token.legacy

export const DISMISSED_UPDATE_VERSION_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.canonical
export const LEGACY_DISMISSED_UPDATE_VERSION_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.legacy

export const MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed.canonical
export const LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed.legacy

export const NOTIFIED_DESKTOP_TASK_RUNS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns.canonical
export const LEGACY_NOTIFIED_DESKTOP_TASK_RUNS_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns.legacy
export const SCHEDULED_TASK_NOTIFICATION_SCAN_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.scheduledTaskNotificationScan.canonical
export const LEGACY_SCHEDULED_TASK_NOTIFICATION_SCAN_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.scheduledTaskNotificationScan.legacy

/** Key pairs copied at startup (schema version is written, not copied). */
export const STARTUP_COPY_KEY_PAIRS: readonly PersistenceKeyPair[] = [
  DESKTOP_PERSISTENCE_KEYS.openTabs,
  DESKTOP_PERSISTENCE_KEYS.sessionRuntime,
  DESKTOP_PERSISTENCE_KEYS.theme,
  DESKTOP_PERSISTENCE_KEYS.followSystemTheme,
  DESKTOP_PERSISTENCE_KEYS.lightTheme,
  DESKTOP_PERSISTENCE_KEYS.darkTheme,
  DESKTOP_PERSISTENCE_KEYS.locale,
  DESKTOP_PERSISTENCE_KEYS.sidebarWidth,
  DESKTOP_PERSISTENCE_KEYS.activeSettingsTab,
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
]

export function safeGetItem(storage: StorageLike | null | undefined, key: string): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(
  storage: StorageLike | null | undefined,
  key: string,
  value: string,
): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveItem(storage: StorageLike | null | undefined, key: string): boolean {
  if (!storage) return false
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/** Canonical first; on conflict the new key wins. Falls back to legacy when absent. */
export function readCanonicalFirst(
  storage: StorageLike | null | undefined,
  pair: PersistenceKeyPair,
): string | null {
  const canonical = safeGetItem(storage, pair.canonical)
  if (canonical !== null) return canonical
  return safeGetItem(storage, pair.legacy)
}

/** Normal writes only touch the canonical key. */
export function writeCanonical(
  storage: StorageLike | null | undefined,
  pair: PersistenceKeyPair,
  value: string,
): boolean {
  return safeSetItem(storage, pair.canonical, value)
}

/**
 * Copy legacy → canonical only when the canonical key is missing.
 * Never overwrites an existing canonical value. Leaves the legacy key in place.
 */
export function copyLegacyIfCanonicalMissing(
  storage: StorageLike | null | undefined,
  pair: PersistenceKeyPair,
): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(pair.canonical) !== null) return false
    const legacy = storage.getItem(pair.legacy)
    if (legacy === null) return false
    storage.setItem(pair.canonical, legacy)
    return true
  } catch {
    return false
  }
}

/**
 * App zoom read order: ccmax-app-zoom → cc-haha-app-zoom → cc-haha-ui-zoom.
 */
export function readAppZoomRaw(storage: StorageLike | null | undefined): string | null {
  const canonical = safeGetItem(storage, DESKTOP_PERSISTENCE_KEYS.appZoom.canonical)
  if (canonical !== null) return canonical
  const legacy = safeGetItem(storage, DESKTOP_PERSISTENCE_KEYS.appZoom.legacy)
  if (legacy !== null) return legacy
  return safeGetItem(storage, LEGACY_UI_ZOOM_STORAGE_KEY)
}

/**
 * Copy into ccmax-app-zoom from the first available older zoom key.
 * Never overwrites canonical. Never deletes either legacy zoom key.
 */
export function copyAppZoomLegacyIfCanonicalMissing(
  storage: StorageLike | null | undefined,
): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(DESKTOP_PERSISTENCE_KEYS.appZoom.canonical) !== null) return false
    const legacyApp = storage.getItem(DESKTOP_PERSISTENCE_KEYS.appZoom.legacy)
    if (legacyApp !== null) {
      storage.setItem(DESKTOP_PERSISTENCE_KEYS.appZoom.canonical, legacyApp)
      return true
    }
    const older = storage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)
    if (older !== null) {
      storage.setItem(DESKTOP_PERSISTENCE_KEYS.appZoom.canonical, older)
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Run canonical-first copy for every startup pair (plus app-zoom tertiary). */
export function copyStage18LegacyKeysIfMissing(
  storage: StorageLike | null | undefined,
): string[] {
  const copied: string[] = []
  if (!storage) return copied

  for (const pair of STARTUP_COPY_KEY_PAIRS) {
    if (copyLegacyIfCanonicalMissing(storage, pair)) {
      copied.push(pair.canonical)
    }
  }
  if (copyAppZoomLegacyIfCanonicalMissing(storage)) {
    copied.push(DESKTOP_PERSISTENCE_KEYS.appZoom.canonical)
  }
  return copied
}