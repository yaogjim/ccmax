import type { SidebarProjectPreferences } from '../../api/desktopUiPreferences'
import {
  DESKTOP_PERSISTENCE_KEYS,
  readCanonicalFirst,
  writeCanonical,
  type PersistenceKeyPair,
} from '../../lib/persistenceKeys'

/**
 * The sidebar's project preferences (order, pins, hidden projects, grouping,
 * sort) as cached in this browser. The server copy in desktop UI preferences is
 * the source of truth; this cache is what a list shows before that answer
 * arrives. The desktop sidebar writes it, and the phone's session list reads
 * the hidden projects from it so a project hidden on the desktop stays hidden
 * on the phone.
 *
 * Keys go through the ccmax canonical registry: new writes never touch the
 * cc-haha names, but a leftover upstream install is still readable.
 */

export type SidebarProjectOrganization = 'project' | 'recentProject' | 'time'
export type SidebarProjectSortBy = 'createdAt' | 'updatedAt'

function readJsonList(pair: PersistenceKeyPair): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(readCanonicalFirst(localStorage, pair) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeJsonList(pair: PersistenceKeyPair, values: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    writeCanonical(localStorage, pair, JSON.stringify(values))
  } catch {
    // Sidebar ordering is a UI preference; ignore storage failures.
  }
}

export function readStoredProjectOrder(): string[] {
  return readJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder)
}

export function writeStoredProjectOrder(projectOrder: string[]): void {
  writeJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder, projectOrder)
}

export function readStoredProjectPins(): Set<string> {
  return new Set(readJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects))
}

export function writeStoredProjectPins(projectKeys: Set<string>): void {
  writeJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects, [...projectKeys])
}

export function readStoredProjectHidden(): Set<string> {
  return new Set(readJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects))
}

export function writeStoredProjectHidden(projectKeys: Set<string>): void {
  writeJsonList(DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects, [...projectKeys])
}

export function readStoredProjectOrganization(): SidebarProjectOrganization {
  if (typeof localStorage === 'undefined') return 'recentProject'
  return normalizeProjectOrganization(
    readCanonicalFirst(localStorage, DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization),
  )
}

export function writeStoredProjectOrganization(organization: SidebarProjectOrganization): void {
  if (typeof localStorage === 'undefined') return
  try {
    writeCanonical(localStorage, DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization, organization)
  } catch {
    // Sidebar organization is a UI preference; ignore storage failures.
  }
}

export function readStoredProjectSortBy(): SidebarProjectSortBy {
  if (typeof localStorage === 'undefined') return 'updatedAt'
  return normalizeProjectSortBy(
    readCanonicalFirst(localStorage, DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort),
  )
}

export function writeStoredProjectSortBy(sortBy: SidebarProjectSortBy): void {
  if (typeof localStorage === 'undefined') return
  try {
    writeCanonical(localStorage, DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort, sortBy)
  } catch {
    // Sidebar sorting is a UI preference; ignore storage failures.
  }
}

export function buildSidebarProjectPreferences(
  projectOrder: string[],
  pinnedProjectKeys: Set<string>,
  hiddenProjectKeys: Set<string>,
  projectOrganization: SidebarProjectOrganization,
  projectSortBy: SidebarProjectSortBy,
): SidebarProjectPreferences {
  return normalizeSidebarProjectPreferences({
    projectOrder,
    pinnedProjects: [...pinnedProjectKeys],
    hiddenProjects: [...hiddenProjectKeys],
    projectOrganization,
    projectSortBy,
  })
}

export function readCachedSidebarProjectPreferences(): SidebarProjectPreferences {
  return {
    projectOrder: readStoredProjectOrder(),
    pinnedProjects: [...readStoredProjectPins()],
    hiddenProjects: [...readStoredProjectHidden()],
    projectOrganization: readStoredProjectOrganization(),
    projectSortBy: readStoredProjectSortBy(),
  }
}

export function writeCachedSidebarProjectPreferences(preferences: SidebarProjectPreferences): void {
  const normalized = normalizeSidebarProjectPreferences(preferences)
  writeStoredProjectOrder(normalized.projectOrder)
  writeStoredProjectPins(new Set(normalized.pinnedProjects))
  writeStoredProjectHidden(new Set(normalized.hiddenProjects))
  writeStoredProjectOrganization(normalized.projectOrganization)
  writeStoredProjectSortBy(normalized.projectSortBy)
}

export function normalizeSidebarProjectPreferences(preferences: Partial<SidebarProjectPreferences> | undefined): SidebarProjectPreferences {
  return {
    projectOrder: normalizeProjectKeyList(preferences?.projectOrder),
    pinnedProjects: normalizeProjectKeyList(preferences?.pinnedProjects),
    hiddenProjects: normalizeProjectKeyList(preferences?.hiddenProjects),
    projectOrganization: normalizeProjectOrganization(preferences?.projectOrganization),
    projectSortBy: normalizeProjectSortBy(preferences?.projectSortBy),
  }
}

export function normalizeProjectKeyList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  return normalized
}

export function hasSidebarProjectPreferences(preferences: SidebarProjectPreferences): boolean {
  return preferences.projectOrder.length > 0
    || preferences.pinnedProjects.length > 0
    || preferences.hiddenProjects.length > 0
    || preferences.projectOrganization !== 'recentProject'
    || preferences.projectSortBy !== 'updatedAt'
}

export function normalizeProjectOrganization(value: unknown): SidebarProjectOrganization {
  return value === 'project' || value === 'recentProject' || value === 'time' ? value : 'recentProject'
}

export function normalizeProjectSortBy(value: unknown): SidebarProjectSortBy {
  return value === 'createdAt' || value === 'updatedAt' ? value : 'updatedAt'
}
