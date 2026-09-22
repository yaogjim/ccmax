import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

export const LOCAL_INDEX_UNSAFE_PATH = 'LOCAL_INDEX_UNSAFE_PATH' as const
export const LOCAL_INDEX_BUSY_TIMEOUT_MS = 100

export const MANAGED_DATABASE_NAMESPACES = ['ccmax', 'cc-haha'] as const
export type ManagedDatabaseNamespace = (typeof MANAGED_DATABASE_NAMESPACES)[number]

export const LOCAL_INDEX_DATABASE_FILENAMES = [
  'index-v1.sqlite',
  'trace-index-v1.sqlite',
  'search-index-v1.sqlite',
  'scheduled-runs-v1.sqlite',
] as const

export type LocalIndexDatabaseFilename =
  (typeof LOCAL_INDEX_DATABASE_FILENAMES)[number]

export class UnsafeLocalIndexPathError extends Error {
  readonly code = LOCAL_INDEX_UNSAFE_PATH

  constructor() {
    super(LOCAL_INDEX_UNSAFE_PATH)
    this.name = 'UnsafeLocalIndexPathError'
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !child.startsWith(sep)
  )
}

function ensureRealManagedDirectory(path: string, trustRoot: string): void {
  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const snapshot = lstatSync(path)
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  if (!isContained(trustRoot, realpathSync(path))) {
    throw new UnsafeLocalIndexPathError()
  }
}

function assertDatabaseFamilySafe(databasePath: string): void {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ]) {
    const snapshot = lstatIfPresent(path)
    if (!snapshot) continue
    if (
      !snapshot.isFile() ||
      snapshot.isSymbolicLink() ||
      snapshot.nlink !== 1
    ) {
      throw new UnsafeLocalIndexPathError()
    }
  }
}

export function getPrimaryManagedDatabasePath(
  scope: string,
  filename: string,
): string {
  return join(resolve(scope), 'ccmax', 'db', filename)
}

export function getLegacyManagedDatabasePath(
  scope: string,
  filename: string,
): string {
  return join(resolve(scope), 'cc-haha', 'db', filename)
}

/**
 * Synchronous active-database selection:
 * primary main exists → primary; else legacy main exists → legacy; else primary.
 * Sidecar-only presence never selects a path.
 */
export function resolveActiveManagedDatabasePath(
  scope: string,
  filename: string,
): string {
  const primary = getPrimaryManagedDatabasePath(scope, filename)
  if (existsSync(primary)) return primary
  const legacy = getLegacyManagedDatabasePath(scope, filename)
  if (existsSync(legacy)) return legacy
  return primary
}

export function isAllowedManagedDatabasePath(
  scope: string,
  databasePath: string,
  filename: string,
): boolean {
  const resolved = resolve(databasePath)
  return (
    resolved === getPrimaryManagedDatabasePath(scope, filename) ||
    resolved === getLegacyManagedDatabasePath(scope, filename)
  )
}

/**
 * Prepares the disposable database directory without following any managed
 * descendant symlink. The configured scope itself is the trust boundary and
 * may intentionally be a symlink (for example, a relocated user config).
 * Only the managed `ccmax` and `cc-haha` namespaces are accepted.
 */
export function prepareManagedDatabasePath(options: {
  databasePath: string
  filename: string
  scope?: string
}): void {
  const databasePath = resolve(options.databasePath)
  if (!options.scope) {
    mkdirSync(dirname(databasePath), { recursive: true })
    assertDatabaseFamilySafe(databasePath)
    return
  }

  const lexicalScope = resolve(options.scope)
  const expectedPrimary = getPrimaryManagedDatabasePath(lexicalScope, options.filename)
  const expectedLegacy = getLegacyManagedDatabasePath(lexicalScope, options.filename)
  if (databasePath !== expectedPrimary && databasePath !== expectedLegacy) {
    throw new UnsafeLocalIndexPathError()
  }

  const namespace: ManagedDatabaseNamespace =
    databasePath === expectedPrimary ? 'ccmax' : 'cc-haha'

  // Recursive creation is restricted to the caller-owned trust root. Every
  // managed descendant is created one component at a time and lstat-verified.
  mkdirSync(lexicalScope, { recursive: true })
  const trustRoot = realpathSync(lexicalScope)
  const scopeSnapshot = lstatSync(lexicalScope)
  if (!scopeSnapshot.isDirectory() && !scopeSnapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  const namespaceDir = join(lexicalScope, namespace)
  const databaseDir = join(namespaceDir, 'db')
  ensureRealManagedDirectory(namespaceDir, trustRoot)
  ensureRealManagedDirectory(databaseDir, trustRoot)
  assertDatabaseFamilySafe(databasePath)
}