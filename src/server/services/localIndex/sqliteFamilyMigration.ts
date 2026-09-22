import { randomBytes } from 'node:crypto'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  LOCAL_INDEX_DATABASE_FILENAMES,
  getLegacyManagedDatabasePath,
  getPrimaryManagedDatabasePath,
} from './managedDatabasePath.js'

export type SqliteFamilyMigrationSink = {
  migratedEntries: string[]
  failures: string[]
}

export type SqliteFamilyMigrationOptions = {
  /**
   * Atomically publish a temp regular file to its final path.
   * Defaults to exclusive hard-link publish (EEXIST if final already exists).
   * Injected only for tests that need partial-commit / race simulation.
   */
  commitFile?: (tempPath: string, finalPath: string) => Promise<void>
}

const FAMILY_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

type IdentitySnapshot = {
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: number
  ino: number
}

function toIdentity(snapshot: Awaited<ReturnType<typeof lstat>>): IdentitySnapshot {
  return {
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
    ctimeMs: snapshot.ctimeMs,
    dev: snapshot.dev,
    ino: snapshot.ino,
  }
}

function identityMatches(before: IdentitySnapshot, after: IdentitySnapshot): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.dev === after.dev &&
    before.ino === after.ino
  )
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertSafeFamilyMember(path: string): Promise<IdentitySnapshot> {
  const snapshot = await lstat(path)
  if (snapshot.isSymbolicLink() || !snapshot.isFile() || snapshot.nlink !== 1) {
    throw new Error(`unsafe family member at ${path}`)
  }
  return toIdentity(snapshot)
}

async function assertSafeManagedDirectory(path: string): Promise<void> {
  const snapshot = await lstatIfPresent(path)
  if (!snapshot) return
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new Error(`unsafe managed directory at ${path}`)
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const snapshot = await lstat(path)
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new Error(`unsafe managed directory at ${path}`)
  }
}

async function ensurePrimaryDatabaseDir(configDir: string): Promise<string> {
  const primaryRoot = join(configDir, 'ccmax')
  const databaseDir = join(primaryRoot, 'db')
  await ensureRealDirectory(primaryRoot)
  await ensureRealDirectory(databaseDir)
  return databaseDir
}

function familyPaths(mainPath: string): string[] {
  return [
    mainPath,
    ...FAMILY_SIDECAR_SUFFIXES.map(suffix => `${mainPath}${suffix}`),
  ]
}

/**
 * Same-filesystem exclusive publish: hard-link temp → final, then unlink temp.
 * If final already exists, `link` fails with EEXIST and never overwrites.
 */
export async function exclusivePublish(
  tempPath: string,
  finalPath: string,
): Promise<void> {
  await link(tempPath, finalPath)
  await unlink(tempPath)
}

/**
 * Copy known local-index SQLite families from legacy `cc-haha/db` into
 * `ccmax/db` when the primary main file is absent. Sidecars commit first;
 * the main file is published last so readers never open a partial primary family.
 */
export async function migrateSqliteDatabaseFamilies(
  configDir: string,
  report: SqliteFamilyMigrationSink,
  options?: SqliteFamilyMigrationOptions,
): Promise<void> {
  const normalizedConfigDir = resolve(configDir)
  for (const filename of LOCAL_INDEX_DATABASE_FILENAMES) {
    await migrateOneFamily(normalizedConfigDir, filename, report, options)
  }
}

async function migrateOneFamily(
  configDir: string,
  filename: string,
  report: SqliteFamilyMigrationSink,
  options?: SqliteFamilyMigrationOptions,
): Promise<void> {
  const legacyMain = getLegacyManagedDatabasePath(configDir, filename)
  const primaryMain = getPrimaryManagedDatabasePath(configDir, filename)
  const entryName = `db/${filename}`
  const commitFile = options?.commitFile ?? exclusivePublish

  const legacyMainSnapshot = await lstatIfPresent(legacyMain)
  if (!legacyMainSnapshot) return

  if (await lstatIfPresent(primaryMain)) {
    // Never overwrite an existing primary main database.
    return
  }

  for (const path of familyPaths(primaryMain).slice(1)) {
    if (await lstatIfPresent(path)) {
      report.failures.push(
        `${entryName}: target family partially exists without primary main`,
      )
      return
    }
  }

  const tmpDir = join(
    configDir,
    `ccmax.db-migrating-${Date.now()}-${randomBytes(3).toString('hex')}`,
  )
  const committedSidecars: string[] = []

  try {
    await assertSafeManagedDirectory(join(configDir, 'cc-haha'))
    await assertSafeManagedDirectory(dirname(legacyMain))
    await assertSafeManagedDirectory(join(configDir, 'ccmax'))
    await assertSafeManagedDirectory(dirname(primaryMain))

    const present: Array<{
      source: string
      relativeName: string
      before: IdentitySnapshot
      isMain: boolean
    }> = []

    for (const source of familyPaths(legacyMain)) {
      const snapshot = await lstatIfPresent(source)
      if (!snapshot) continue
      const before = await assertSafeFamilyMember(source)
      present.push({
        source,
        relativeName: source.slice(dirname(legacyMain).length + 1),
        before,
        isMain: source === legacyMain,
      })
    }

    if (!present.some(member => member.isMain)) {
      report.failures.push(`${entryName}: legacy main is not a safe regular file`)
      return
    }

    await mkdir(tmpDir)

    // Copy every present member first, then re-check all sources and temps.
    for (const member of present) {
      const destination = join(tmpDir, member.relativeName)
      await copyFile(member.source, destination)
    }

    for (const member of present) {
      const afterSource = await assertSafeFamilyMember(member.source)
      if (!identityMatches(member.before, afterSource)) {
        throw new Error(`source changed during copy: ${member.source}`)
      }
      const copied = await stat(join(tmpDir, member.relativeName))
      if (copied.size !== member.before.size) {
        throw new Error(`copy size mismatch: ${member.source}`)
      }
    }

    await ensurePrimaryDatabaseDir(configDir)

    if (await lstatIfPresent(primaryMain)) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      return
    }
    for (const path of familyPaths(primaryMain).slice(1)) {
      if (await lstatIfPresent(path)) {
        throw new Error('target family partially exists without primary main')
      }
    }

    const sidecars = present.filter(member => !member.isMain)
    const main = present.find(member => member.isMain)!

    for (const member of sidecars) {
      const from = join(tmpDir, member.relativeName)
      const to = join(dirname(primaryMain), member.relativeName)
      await commitFile(from, to)
      committedSidecars.push(to)
    }

    await commitFile(join(tmpDir, main.relativeName), primaryMain)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    report.migratedEntries.push(entryName)
  } catch (error) {
    for (const path of committedSidecars) {
      await unlink(path).catch(() => undefined)
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    report.failures.push(
      `${entryName}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}