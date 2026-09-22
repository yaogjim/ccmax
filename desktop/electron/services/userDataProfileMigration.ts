import { randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

/** Published Electron productName before the ccmax rebrand. */
export const LEGACY_USER_DATA_DIR_NAME = 'Claude Code Haha'
/** Current Electron productName / userData directory. */
export const PRIMARY_USER_DATA_DIR_NAME = 'ccmax'

const MIGRATION_LOCK_DIR_NAME = 'ccmax.userData.migrating.lock'
const TEMP_DIR_PREFIX = 'ccmax.userData.migrating-'

/**
 * Fork-owned internal markers (not UI). Top-level only.
 * Must not silently collide with legacy entries of the same name.
 */
export const PRIMARY_MIGRATION_OWNERSHIP_MARKER = '.ccmax.userData.migration.ownership'
export const PRIMARY_MIGRATION_COMPLETION_MARKER = '.ccmax.userData.migration.complete'

const RESERVED_MARKER_NAMES = new Set([
  PRIMARY_MIGRATION_OWNERSHIP_MARKER,
  PRIMARY_MIGRATION_COMPLETION_MARKER,
])

export type UserDataProfilePaths = {
  appData: string
  legacyPath: string
  primaryPath: string
  lockPath: string
}

export type UserDataProfileSource = 'primary' | 'legacy' | 'migrated'

export type PrepareUserDataProfileResult = {
  activePath: string
  source: UserDataProfileSource
  reason: string
}

export type ManifestEntry =
  | { relativePath: string, kind: 'directory' }
  | { relativePath: string, kind: 'file', size: number }
  | { relativePath: string, kind: 'symlink', target: string }

/** Classification of the primary profile directory before / after publish. */
export type PrimaryProfileClass =
  | 'absent'
  | 'empty'
  | 'in-progress'
  | 'existing-user-state'
  | 'complete-by-migration'

export type UserDataProfileFs = {
  pathExists: (target: string) => Promise<boolean>
  isPresentDirectory: (target: string) => Promise<boolean>
  classifyPrimary: (primaryPath: string) => Promise<PrimaryProfileClass>
  acquireLock: (lockPath: string) => Promise<boolean>
  releaseLock: (lockPath: string) => Promise<void>
  createTempDir: (appData: string) => Promise<string>
  copyProfileTree: (sourceRoot: string, destRoot: string) => Promise<ManifestEntry[]>
  verifyCopiedTree: (
    sourceRoot: string,
    destRoot: string,
    manifest: ManifestEntry[],
  ) => Promise<void>
  commitPrimary: (tempPath: string, primaryPath: string) => Promise<void>
  removePath: (target: string) => Promise<void>
  /** Narrow seam: exclusive create of the primary root (no recursive). */
  mkdirExclusive: (target: string) => Promise<void>
  /** Narrow seam: rename one path (used while publishing top-level entries). */
  renamePath: (from: string, to: string) => Promise<void>
}

export type PrepareUserDataProfileOptions = {
  fs?: Partial<UserDataProfileFs>
  log?: (message: string) => void
}

export type UserDataProfileAppLike = {
  getPath(name: 'appData'): string
}

function defaultLog(message: string): void {
  console.error(message)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isPresentDirectory(target: string): Promise<boolean> {
  try {
    const snapshot = await lstat(target)
    return snapshot.isDirectory() && !snapshot.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Classify primary without treating empty / in-progress dirs as ready.
 * Existing non-empty user state = any non-empty tree that is not solely
 * migration ownership, and is not marked complete by this migrator.
 */
export async function classifyPrimary(primaryPath: string): Promise<PrimaryProfileClass> {
  try {
    const snapshot = await lstat(primaryPath)
    if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
      // Non-directory primary must never be overwritten by migration.
      return 'existing-user-state'
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }

  const names = await readdir(primaryPath)
  if (names.length === 0) return 'empty'

  const hasOwnership = names.includes(PRIMARY_MIGRATION_OWNERSHIP_MARKER)
  const hasCompletion = names.includes(PRIMARY_MIGRATION_COMPLETION_MARKER)

  // Incomplete publish owns the root until completion marker is committed.
  if (hasOwnership) return 'in-progress'
  if (hasCompletion) return 'complete-by-migration'

  // Non-empty and not only our markers → user / Electron state.
  return 'existing-user-state'
}

export function isUsablePrimary(classification: PrimaryProfileClass): boolean {
  return (
    classification === 'existing-user-state'
    || classification === 'complete-by-migration'
  )
}

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    await mkdir(lockPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true })
}

async function createTempDir(appData: string): Promise<string> {
  const tempPath = path.join(
    appData,
    `${TEMP_DIR_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  await mkdir(tempPath)
  return tempPath
}

async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
}

async function mkdirExclusive(target: string): Promise<void> {
  // No recursive: exclusive claim of the primary root only.
  await mkdir(target)
}

async function renamePath(from: string, to: string): Promise<void> {
  await rename(from, to)
}

function assertNotReservedTopLevelName(name: string, context: string): void {
  if (RESERVED_MARKER_NAMES.has(name)) {
    throw new Error(`reserved migration marker present in ${context}: ${name}`)
  }
}

/**
 * Walk a profile tree without following symlinks. Special files are rejected so
 * the migrator falls back to the legacy profile instead of shipping an unverifiable copy.
 */
export async function copyProfileTree(
  sourceRoot: string,
  destRoot: string,
): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [{ relativePath: '', kind: 'directory' }]
  const queue: string[] = ['']

  while (queue.length > 0) {
    const relativeDir = queue.shift()!
    const sourceDir = relativeDir ? path.join(sourceRoot, relativeDir) : sourceRoot
    const destDir = relativeDir ? path.join(destRoot, relativeDir) : destRoot
    if (relativeDir) {
      await mkdir(destDir)
    }

    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name
      // Reserved markers are only written by this migrator at the primary root.
      // A legacy tree that already contains them must fail closed.
      if (!relativeDir) {
        assertNotReservedTopLevelName(entry.name, 'legacy profile')
      }

      const sourcePath = path.join(sourceRoot, relativePath)
      const destPath = path.join(destRoot, relativePath)
      const snapshot = await lstat(sourcePath)

      if (snapshot.isSymbolicLink()) {
        const target = await readlink(sourcePath)
        await symlink(target, destPath)
        manifest.push({ relativePath, kind: 'symlink', target })
        continue
      }

      if (snapshot.isDirectory()) {
        manifest.push({ relativePath, kind: 'directory' })
        queue.push(relativePath)
        continue
      }

      if (snapshot.isFile()) {
        await copyFile(sourcePath, destPath)
        manifest.push({ relativePath, kind: 'file', size: snapshot.size })
        continue
      }

      throw new Error(`unsupported profile entry type at ${relativePath}`)
    }
  }

  return manifest
}

/** Recursively list every relative path in a tree (root as ''). Does not follow symlinks. */
export async function listTreeRelativePaths(root: string): Promise<Set<string>> {
  const found = new Set<string>([''])
  const queue: string[] = ['']

  while (queue.length > 0) {
    const relativeDir = queue.shift()!
    const dirPath = relativeDir ? path.join(root, relativeDir) : root
    const entries = await readdir(dirPath)

    for (const name of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, name) : name
      found.add(relativePath)
      const snapshot = await lstat(path.join(root, relativePath))
      if (snapshot.isDirectory() && !snapshot.isSymbolicLink()) {
        queue.push(relativePath)
      }
    }
  }

  return found
}

export async function verifyCopiedTree(
  sourceRoot: string,
  destRoot: string,
  manifest: ManifestEntry[],
): Promise<void> {
  const expectedPaths = new Set(manifest.map(entry => entry.relativePath))
  if (expectedPaths.size !== manifest.length) {
    throw new Error('manifest contains duplicate relative paths')
  }

  const actualDestPaths = await listTreeRelativePaths(destRoot)
  for (const relativePath of actualDestPaths) {
    if (!expectedPaths.has(relativePath)) {
      throw new Error(`copied tree has unexpected entry ${relativePath || '.'}`)
    }
  }
  for (const relativePath of expectedPaths) {
    if (!actualDestPaths.has(relativePath)) {
      throw new Error(`copied tree missing entry for ${relativePath || '.'}`)
    }
  }

  for (const entry of manifest) {
    const sourcePath = entry.relativePath
      ? path.join(sourceRoot, entry.relativePath)
      : sourceRoot
    const destPath = entry.relativePath
      ? path.join(destRoot, entry.relativePath)
      : destRoot

    const sourceSnapshot = await lstat(sourcePath)
    const destSnapshot = await lstat(destPath)

    if (entry.kind === 'directory') {
      if (!sourceSnapshot.isDirectory() || sourceSnapshot.isSymbolicLink()) {
        throw new Error(`source directory missing for ${entry.relativePath || '.'}`)
      }
      if (!destSnapshot.isDirectory() || destSnapshot.isSymbolicLink()) {
        throw new Error(`copied directory missing for ${entry.relativePath || '.'}`)
      }
      continue
    }

    if (entry.kind === 'file') {
      if (!sourceSnapshot.isFile() || sourceSnapshot.isSymbolicLink()) {
        throw new Error(`source file missing for ${entry.relativePath}`)
      }
      if (!destSnapshot.isFile() || destSnapshot.isSymbolicLink()) {
        throw new Error(`copied file missing for ${entry.relativePath}`)
      }
      if (sourceSnapshot.size !== entry.size || destSnapshot.size !== entry.size) {
        throw new Error(`file size mismatch for ${entry.relativePath}`)
      }
      continue
    }

    if (!sourceSnapshot.isSymbolicLink() || !destSnapshot.isSymbolicLink()) {
      throw new Error(`symlink missing for ${entry.relativePath}`)
    }
    const sourceTarget = await readlink(sourcePath)
    const destTarget = await readlink(destPath)
    if (sourceTarget !== entry.target || destTarget !== entry.target) {
      throw new Error(`symlink target mismatch for ${entry.relativePath}`)
    }
  }
}

/**
 * Attempt owned-primary cleanup after a failed publish.
 * Only deletes when ownership token matches and every entry is accounted for.
 * Unknown / racing entries: leave the tree and keep the in-progress marker.
 */
async function tryCleanupOwnedPrimary(
  primaryPath: string,
  ownershipToken: string,
  knownEntries: Set<string>,
): Promise<'cleaned' | 'left-in-progress' | 'skipped'> {
  const ownershipPath = path.join(primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER)

  try {
    const tokenOnDisk = await readFile(ownershipPath, 'utf8')
    if (tokenOnDisk !== ownershipToken) {
      return 'skipped'
    }

    const names = await readdir(primaryPath)
    for (const name of names) {
      if (!knownEntries.has(name)) {
        // Unknown competitor entry — never delete primary.
        return 'left-in-progress'
      }
    }

    await rm(primaryPath, { recursive: true, force: true })
    return 'cleaned'
  } catch {
    return 'skipped'
  }
}

export type CommitPrimaryDeps = {
  mkdirExclusive?: (target: string) => Promise<void>
  renamePath?: (from: string, to: string) => Promise<void>
  pathExists?: (target: string) => Promise<boolean>
}

/**
 * Publish verified temp → primary without directory-rename replacement.
 *
 * Under the migration lock:
 * 1. exclusive mkdir(primary)
 * 2. write random ownership / in-progress marker
 * 3. rename each verified temp top-level entry into owned primary
 * 4. write completion marker last, then remove ownership marker
 *
 * Failure cleanup only when ownership token matches and no unknown entries exist.
 */
export async function commitPrimary(
  tempPath: string,
  primaryPath: string,
  deps: CommitPrimaryDeps = {},
): Promise<void> {
  const mkdirRoot = deps.mkdirExclusive ?? mkdirExclusive
  const move = deps.renamePath ?? renamePath
  const exists = deps.pathExists ?? pathExists

  let claimedRoot = false
  let ownershipToken: string | null = null
  const knownEntries = new Set<string>()

  try {
    try {
      await mkdirRoot(primaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('primary profile already exists')
      }
      throw error
    }
    claimedRoot = true

    ownershipToken = randomBytes(16).toString('hex')
    const ownershipPath = path.join(primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER)
    await writeFile(ownershipPath, ownershipToken, { flag: 'wx' })
    knownEntries.add(PRIMARY_MIGRATION_OWNERSHIP_MARKER)

    const topEntries = await readdir(tempPath)
    for (const name of topEntries) {
      assertNotReservedTopLevelName(name, 'temp profile')
      const from = path.join(tempPath, name)
      const to = path.join(primaryPath, name)
      if (await exists(to)) {
        throw new Error(`primary entry already exists: ${name}`)
      }
      await move(from, to)
      knownEntries.add(name)
    }

    const completionPath = path.join(primaryPath, PRIMARY_MIGRATION_COMPLETION_MARKER)
    await writeFile(completionPath, `${Date.now()}\n`, { flag: 'wx' })
    knownEntries.add(PRIMARY_MIGRATION_COMPLETION_MARKER)

    await rm(ownershipPath)
    knownEntries.delete(PRIMARY_MIGRATION_OWNERSHIP_MARKER)

    // Temp should now be empty (or only leftover empty dirs if any); remove it.
    await rm(tempPath, { recursive: true, force: true })
  } catch (error) {
    if (claimedRoot && ownershipToken) {
      await tryCleanupOwnedPrimary(primaryPath, ownershipToken, knownEntries)
    }
    throw error
  }
}

function resolveFs(overrides?: Partial<UserDataProfileFs>): UserDataProfileFs {
  const mkdirExclusiveImpl = overrides?.mkdirExclusive ?? mkdirExclusive
  const renamePathImpl = overrides?.renamePath ?? renamePath

  const base: UserDataProfileFs = {
    pathExists,
    isPresentDirectory,
    classifyPrimary,
    acquireLock,
    releaseLock,
    createTempDir,
    copyProfileTree,
    verifyCopiedTree,
    removePath,
    mkdirExclusive: mkdirExclusiveImpl,
    renamePath: renamePathImpl,
    commitPrimary: async (tempPath, primaryPath) =>
      commitPrimary(tempPath, primaryPath, {
        mkdirExclusive: mkdirExclusiveImpl,
        renamePath: renamePathImpl,
        pathExists,
      }),
  }

  return {
    ...base,
    ...overrides,
    // Keep commit wired to any injected mkdir/rename seams unless fully overridden.
    commitPrimary: overrides?.commitPrimary
      ?? (async (tempPath, primaryPath) =>
        commitPrimary(tempPath, primaryPath, {
          mkdirExclusive: overrides?.mkdirExclusive ?? mkdirExclusiveImpl,
          renamePath: overrides?.renamePath ?? renamePathImpl,
          pathExists: overrides?.pathExists ?? pathExists,
        })),
  }
}

export function resolveUserDataProfilePaths(appData: string): UserDataProfilePaths {
  return {
    appData,
    legacyPath: path.join(appData, LEGACY_USER_DATA_DIR_NAME),
    primaryPath: path.join(appData, PRIMARY_USER_DATA_DIR_NAME),
    lockPath: path.join(appData, MIGRATION_LOCK_DIR_NAME),
  }
}

function primaryResult(
  primaryPath: string,
  reason: string,
): PrepareUserDataProfileResult {
  return {
    activePath: primaryPath,
    source: 'primary',
    reason,
  }
}

function legacyResult(
  legacyPath: string,
  reason: string,
): PrepareUserDataProfileResult {
  return {
    activePath: legacyPath,
    source: 'legacy',
    reason,
  }
}

/**
 * Choose the active Electron userData path before single-instance lock.
 * Never deletes the legacy profile and never overwrites an existing primary.
 * Empty / in-progress primary is not treated as ready when legacy data exists.
 * Any migration failure returns the legacy path so startup never continues on
 * an empty new profile when old data is present.
 */
export async function prepareUserDataProfile(
  app: UserDataProfileAppLike,
  options: PrepareUserDataProfileOptions = {},
): Promise<PrepareUserDataProfileResult> {
  const log = options.log ?? defaultLog
  const fsApi = resolveFs(options.fs)
  const paths = resolveUserDataProfilePaths(app.getPath('appData'))

  try {
    const initialPrimary = await fsApi.classifyPrimary(paths.primaryPath)
    if (isUsablePrimary(initialPrimary)) {
      return primaryResult(
        paths.primaryPath,
        initialPrimary === 'complete-by-migration'
          ? 'primary-complete'
          : 'primary-exists',
      )
    }

    const legacyPresent = await fsApi.isPresentDirectory(paths.legacyPath)
    if (!legacyPresent) {
      // No legacy: empty / in-progress / absent all resolve to primary path
      // (Electron creates userData as needed). Do not invent a migration.
      return primaryResult(paths.primaryPath, 'neither-exists')
    }

    // Legacy exists: empty or in-progress primary must not become active.
    if (initialPrimary === 'empty' || initialPrimary === 'in-progress') {
      return legacyResult(
        paths.legacyPath,
        initialPrimary === 'empty' ? 'primary-empty' : 'primary-in-progress',
      )
    }

    const locked = await fsApi.acquireLock(paths.lockPath)
    if (!locked) {
      const afterContention = await fsApi.classifyPrimary(paths.primaryPath)
      if (isUsablePrimary(afterContention)) {
        return primaryResult(paths.primaryPath, 'primary-ready-after-contention')
      }
      log('[desktop] userData migration lock held; using legacy profile')
      return legacyResult(paths.legacyPath, 'migration-lock-held')
    }

    let tempPath: string | null = null
    try {
      const afterLock = await fsApi.classifyPrimary(paths.primaryPath)
      if (isUsablePrimary(afterLock)) {
        return primaryResult(paths.primaryPath, 'primary-ready-after-lock')
      }
      if (afterLock === 'empty' || afterLock === 'in-progress') {
        // Pre-existing empty/incomplete primary: never modify or replace it.
        return legacyResult(
          paths.legacyPath,
          afterLock === 'empty' ? 'primary-empty' : 'primary-in-progress',
        )
      }

      tempPath = await fsApi.createTempDir(paths.appData)
      const manifest = await fsApi.copyProfileTree(paths.legacyPath, tempPath)
      await fsApi.verifyCopiedTree(paths.legacyPath, tempPath, manifest)

      const beforeCommit = await fsApi.classifyPrimary(paths.primaryPath)
      if (isUsablePrimary(beforeCommit)) {
        await fsApi.removePath(tempPath)
        tempPath = null
        return primaryResult(paths.primaryPath, 'primary-ready-before-commit')
      }
      if (beforeCommit === 'empty' || beforeCommit === 'in-progress') {
        await fsApi.removePath(tempPath)
        tempPath = null
        return legacyResult(
          paths.legacyPath,
          beforeCommit === 'empty' ? 'primary-empty' : 'primary-in-progress',
        )
      }

      await fsApi.commitPrimary(tempPath, paths.primaryPath)
      tempPath = null
      return {
        activePath: paths.primaryPath,
        source: 'migrated',
        reason: 'migrated-from-legacy',
      }
    } catch (error) {
      if (tempPath) {
        await fsApi.removePath(tempPath).catch(() => undefined)
      }
      const afterFailure = await fsApi.classifyPrimary(paths.primaryPath)
      if (isUsablePrimary(afterFailure)) {
        log(
          `[desktop] userData migration aborted with usable primary present: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return primaryResult(paths.primaryPath, 'primary-ready-after-failure')
      }
      log(
        `[desktop] userData migration failed; using legacy profile: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return legacyResult(paths.legacyPath, 'migration-failed')
    } finally {
      await fsApi.releaseLock(paths.lockPath).catch(() => undefined)
    }
  } catch (error) {
    // Last-resort fallback: never throw into startup when legacy data may exist.
    log(
      `[desktop] userData profile prepare failed; attempting safe fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    try {
      const primaryClass = await fsApi.classifyPrimary(paths.primaryPath)
      if (isUsablePrimary(primaryClass)) {
        return primaryResult(paths.primaryPath, 'primary-after-outer-failure')
      }
      if (await fsApi.isPresentDirectory(paths.legacyPath)) {
        return legacyResult(paths.legacyPath, 'legacy-after-outer-failure')
      }
    } catch {
      // ignore secondary probe failures
    }
    return primaryResult(paths.primaryPath, 'fallback-primary')
  }
}