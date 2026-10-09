/**
 * Storage identity for the unified workspace, kept free of store imports.
 *
 * `persistenceMigrations` runs before anything else at startup and must be able
 * to normalize this key without pulling the workspace store — and every module
 * the store reaches — into the migration path. Canonical writes use ccmax;
 * the cc-haha key remains a legacy copy source.
 */
import { DESKTOP_PERSISTENCE_KEYS } from '../persistenceKeys'

export const WORKSPACE_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.workspace.canonical
export const LEGACY_WORKSPACE_STORAGE_KEY = DESKTOP_PERSISTENCE_KEYS.workspace.legacy
export const WORKSPACE_STORAGE_VERSION = 2