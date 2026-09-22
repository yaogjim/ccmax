import { doctorApi, type DoctorReport } from '../api/doctor'
import {
  ACTIVE_SETTINGS_TAB_STORAGE_KEY,
  APP_ZOOM_STORAGE_KEY,
  DARK_THEME_STORAGE_KEY,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  FOLLOW_SYSTEM_THEME_STORAGE_KEY,
  LEGACY_ACTIVE_SETTINGS_TAB_STORAGE_KEY,
  LEGACY_APP_ZOOM_STORAGE_KEY,
  LEGACY_DARK_THEME_STORAGE_KEY,
  LEGACY_DESKTOP_PERSISTENCE_VERSION_KEY,
  LEGACY_FOLLOW_SYSTEM_THEME_STORAGE_KEY,
  LEGACY_LIGHT_THEME_STORAGE_KEY,
  LEGACY_LOCALE_STORAGE_KEY,
  LEGACY_SESSION_RUNTIME_STORAGE_KEY,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  LEGACY_TAB_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  LIGHT_THEME_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  SESSION_RUNTIME_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  TAB_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from './persistenceKeys'
import { WORKSPACE_STORAGE_KEY } from './workspace/storageKey'

/**
 * Explicit user reset may clear both canonical and legacy safe UI keys.
 * Protected / unknown keys (chat history, provider config, …) are never listed.
 */
export const SAFE_DOCTOR_STORAGE_KEYS = [
  TAB_STORAGE_KEY,
  LEGACY_TAB_STORAGE_KEY,
  SESSION_RUNTIME_STORAGE_KEY,
  LEGACY_SESSION_RUNTIME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  // The theme is four keys, not one: dropping only the applied theme would
  // leave the switch and either half behind, so a reset would not actually
  // return the appearance to its out-of-the-box state.
  FOLLOW_SYSTEM_THEME_STORAGE_KEY,
  LEGACY_FOLLOW_SYSTEM_THEME_STORAGE_KEY,
  LIGHT_THEME_STORAGE_KEY,
  LEGACY_LIGHT_THEME_STORAGE_KEY,
  DARK_THEME_STORAGE_KEY,
  LEGACY_DARK_THEME_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  LEGACY_LOCALE_STORAGE_KEY,
  APP_ZOOM_STORAGE_KEY,
  LEGACY_APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  ACTIVE_SETTINGS_TAB_STORAGE_KEY,
  LEGACY_ACTIVE_SETTINGS_TAB_STORAGE_KEY,
  // Regenerable by the same standard as the open-tab list: it holds panel
  // layout and tab descriptors, never content. Leaving it out would mean a
  // corrupt entry has no documented way to be cleared.
  WORKSPACE_STORAGE_KEY,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  LEGACY_DESKTOP_PERSISTENCE_VERSION_KEY,
] as const

type DoctorStorage = Pick<Storage, 'getItem' | 'removeItem'>

export type LocalDoctorRepairResult = {
  removedKeys: string[]
  missingKeys: string[]
  failedKeys: string[]
}

function getDefaultDoctorStorage(): DoctorStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function runLocalDoctorRepair(storage: DoctorStorage | null = getDefaultDoctorStorage()): LocalDoctorRepairResult {
  if (!storage) {
    return {
      removedKeys: [],
      missingKeys: [...SAFE_DOCTOR_STORAGE_KEYS],
      failedKeys: [],
    }
  }

  const removedKeys: string[] = []
  const missingKeys: string[] = []
  const failedKeys: string[] = []

  for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
    try {
      if (storage.getItem(key) === null) {
        missingKeys.push(key)
        continue
      }
      storage.removeItem(key)
      removedKeys.push(key)
    } catch {
      failedKeys.push(key)
    }
  }

  return { removedKeys, missingKeys, failedKeys }
}

export async function runDoctorCheck(options: { cwd?: string } = {}): Promise<DoctorReport> {
  const { report } = await doctorApi.report(options.cwd)
  return report
}
