import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  LOCAL_INDEX_DATABASE_FILENAMES,
  resolveActiveManagedDatabasePath,
} from './managedDatabasePath.js'
import {
  exclusivePublish,
  migrateSqliteDatabaseFamilies,
} from './sqliteFamilyMigration.js'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sqlite-family-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true }),
  ))
})

async function writeFamily(
  mainPath: string,
  contents: Partial<Record<'' | '-wal' | '-shm' | '-journal', string>> = {
    '': 'main-db',
    '-wal': 'wal',
    '-shm': 'shm',
    '-journal': 'journal',
  },
): Promise<void> {
  await fs.mkdir(path.dirname(mainPath), { recursive: true })
  for (const [suffix, body] of Object.entries(contents)) {
    if (body === undefined) continue
    await fs.writeFile(`${mainPath}${suffix}`, body)
  }
}

describe('sqlite family migration', () => {
  test('migrates only-old families with wal/shm/journal and keeps the legacy family', async () => {
    const configDir = await tempRoot('migrate-all')
    for (const filename of LOCAL_INDEX_DATABASE_FILENAMES) {
      await writeFamily(path.join(configDir, 'cc-haha', 'db', filename), {
        '': `main-${filename}`,
        '-wal': `wal-${filename}`,
        '-shm': `shm-${filename}`,
        '-journal': `journal-${filename}`,
      })
    }

    const report = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, report)

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toEqual(
      LOCAL_INDEX_DATABASE_FILENAMES.map(name => `db/${name}`),
    )

    for (const filename of LOCAL_INDEX_DATABASE_FILENAMES) {
      const primary = path.join(configDir, 'ccmax', 'db', filename)
      const legacy = path.join(configDir, 'cc-haha', 'db', filename)
      expect(await fs.readFile(primary, 'utf8')).toBe(`main-${filename}`)
      expect(await fs.readFile(`${primary}-wal`, 'utf8')).toBe(`wal-${filename}`)
      expect(await fs.readFile(`${primary}-shm`, 'utf8')).toBe(`shm-${filename}`)
      expect(await fs.readFile(`${primary}-journal`, 'utf8')).toBe(`journal-${filename}`)
      expect(await fs.readFile(legacy, 'utf8')).toBe(`main-${filename}`)
      expect(await fs.readFile(`${legacy}-wal`, 'utf8')).toBe(`wal-${filename}`)
    }
  })

  test('does not overwrite an existing primary main database', async () => {
    const configDir = await tempRoot('no-overwrite')
    const filename = 'index-v1.sqlite'
    await writeFamily(path.join(configDir, 'cc-haha', 'db', filename), {
      '': 'legacy-main',
    })
    await writeFamily(path.join(configDir, 'ccmax', 'db', filename), {
      '': 'primary-main',
    })

    const report = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, report)

    expect(report.migratedEntries).not.toContain(`db/${filename}`)
    expect(await fs.readFile(path.join(configDir, 'ccmax', 'db', filename), 'utf8'))
      .toBe('primary-main')
    expect(await fs.readFile(path.join(configDir, 'cc-haha', 'db', filename), 'utf8'))
      .toBe('legacy-main')
  })

  test('rejects mixed target family members without a primary main and keeps legacy', async () => {
    const configDir = await tempRoot('mixed-target')
    const filename = 'trace-index-v1.sqlite'
    await writeFamily(path.join(configDir, 'cc-haha', 'db', filename), {
      '': 'legacy-main',
      '-wal': 'legacy-wal',
    })
    await fs.mkdir(path.join(configDir, 'ccmax', 'db'), { recursive: true })
    await fs.writeFile(
      path.join(configDir, 'ccmax', 'db', `${filename}-wal`),
      'preexisting-wal',
    )

    const report = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, report)

    expect(report.migratedEntries).not.toContain(`db/${filename}`)
    expect(report.failures.some(failure => failure.startsWith(`db/${filename}:`))).toBe(true)
    expect(await fs.readFile(path.join(configDir, 'cc-haha', 'db', filename), 'utf8'))
      .toBe('legacy-main')
    expect(await fs.readFile(
      path.join(configDir, 'ccmax', 'db', `${filename}-wal`),
      'utf8',
    )).toBe('preexisting-wal')
    await expect(fs.stat(path.join(configDir, 'ccmax', 'db', filename)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects unsafe family members and remains retryable after reset', async () => {
    const configDir = await tempRoot('unsafe-retry')
    const filename = 'search-index-v1.sqlite'
    const legacyMain = path.join(configDir, 'cc-haha', 'db', filename)
    await fs.mkdir(path.dirname(legacyMain), { recursive: true })
    await fs.writeFile(legacyMain, 'safe-main')
    await fs.symlink(
      path.join(configDir, 'outside-wal'),
      `${legacyMain}-wal`,
    )
    await fs.writeFile(path.join(configDir, 'outside-wal'), 'outside')

    const first = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, first)
    expect(first.failures.some(failure => failure.startsWith(`db/${filename}:`))).toBe(true)
    await expect(fs.stat(path.join(configDir, 'ccmax', 'db', filename)))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await fs.rm(`${legacyMain}-wal`, { force: true })
    await fs.writeFile(`${legacyMain}-wal`, 'safe-wal')

    const second = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, second)
    expect(second.failures).toEqual([])
    expect(second.migratedEntries).toContain(`db/${filename}`)
    expect(await fs.readFile(path.join(configDir, 'ccmax', 'db', filename), 'utf8'))
      .toBe('safe-main')
  })

  test('path resolution prefers primary main, else legacy main, else primary default', async () => {
    const configDir = await tempRoot('resolve')
    const filename = 'scheduled-runs-v1.sqlite'
    const primary = path.join(configDir, 'ccmax', 'db', filename)
    const legacy = path.join(configDir, 'cc-haha', 'db', filename)

    expect(resolveActiveManagedDatabasePath(configDir, filename)).toBe(primary)

    await writeFamily(legacy, { '': 'legacy-only' })
    expect(resolveActiveManagedDatabasePath(configDir, filename)).toBe(legacy)

    await writeFamily(primary, { '': 'primary-now' })
    expect(resolveActiveManagedDatabasePath(configDir, filename)).toBe(primary)

    await fs.writeFile(`${primary}-wal`, 'sidecar-only-not-enough')
    await fs.rm(primary)
    // Only a primary sidecar remains — do not select primary.
    expect(resolveActiveManagedDatabasePath(configDir, filename)).toBe(legacy)
  })

  test('after sidecars publish, main publish failure rolls back only those sidecars', async () => {
    const configDir = await tempRoot('partial-commit')
    const filename = 'index-v1.sqlite'
    const legacyMain = path.join(configDir, 'cc-haha', 'db', filename)
    await writeFamily(legacyMain, {
      '': 'legacy-main',
      '-wal': 'legacy-wal',
      '-shm': 'legacy-shm',
      '-journal': 'legacy-journal',
    })

    const primaryDir = path.join(configDir, 'ccmax', 'db')
    await fs.mkdir(primaryDir, { recursive: true })
    const sentinel = path.join(primaryDir, 'keep-me.txt')
    await fs.writeFile(sentinel, 'preexisting')

    const primaryMain = path.join(primaryDir, filename)
    const report = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, report, {
      commitFile: async (tempPath, finalPath) => {
        if (finalPath === primaryMain) {
          throw new Error('injected main publish failure')
        }
        await exclusivePublish(tempPath, finalPath)
      },
    })

    expect(report.migratedEntries).not.toContain(`db/${filename}`)
    expect(report.failures.some(failure =>
      failure.includes('injected main publish failure'),
    )).toBe(true)

    await expect(fs.stat(primaryMain)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(`${primaryMain}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(`${primaryMain}-shm`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(`${primaryMain}-journal`)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await fs.readFile(legacyMain, 'utf8')).toBe('legacy-main')
    expect(await fs.readFile(`${legacyMain}-wal`, 'utf8')).toBe('legacy-wal')
    expect(await fs.readFile(`${legacyMain}-shm`, 'utf8')).toBe('legacy-shm')
    expect(await fs.readFile(`${legacyMain}-journal`, 'utf8')).toBe('legacy-journal')
    expect(await fs.readFile(sentinel, 'utf8')).toBe('preexisting')
  })

  test('exclusive main publish does not overwrite a racing primary main', async () => {
    const configDir = await tempRoot('race-main')
    const filename = 'trace-index-v1.sqlite'
    const legacyMain = path.join(configDir, 'cc-haha', 'db', filename)
    await writeFamily(legacyMain, {
      '': 'legacy-main',
      '-wal': 'legacy-wal',
    })

    const primaryMain = path.join(configDir, 'ccmax', 'db', filename)
    const report = { migratedEntries: [] as string[], failures: [] as string[] }
    await migrateSqliteDatabaseFamilies(configDir, report, {
      commitFile: async (tempPath, finalPath) => {
        if (finalPath === primaryMain) {
          await fs.mkdir(path.dirname(primaryMain), { recursive: true })
          await fs.writeFile(primaryMain, 'competing-primary')
        }
        await exclusivePublish(tempPath, finalPath)
      },
    })

    expect(report.migratedEntries).not.toContain(`db/${filename}`)
    expect(report.failures.some(failure => failure.startsWith(`db/${filename}:`))).toBe(true)
    expect(await fs.readFile(primaryMain, 'utf8')).toBe('competing-primary')
    expect(await fs.readFile(legacyMain, 'utf8')).toBe('legacy-main')
    expect(await fs.readFile(`${legacyMain}-wal`, 'utf8')).toBe('legacy-wal')
    // Sidecars published before main must be rolled back; competing main stays.
    await expect(fs.stat(`${primaryMain}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('exclusivePublish refuses to replace an existing final path', async () => {
    const root = await tempRoot('exclusive')
    const tempPath = path.join(root, 'temp.sqlite')
    const finalPath = path.join(root, 'final.sqlite')
    await fs.writeFile(tempPath, 'new-bytes')
    await fs.writeFile(finalPath, 'existing-bytes')

    await expect(exclusivePublish(tempPath, finalPath)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await fs.readFile(finalPath, 'utf8')).toBe('existing-bytes')
    expect(await fs.readFile(tempPath, 'utf8')).toBe('new-bytes')
  })
})