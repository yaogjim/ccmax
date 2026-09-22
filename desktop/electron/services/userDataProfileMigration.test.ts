import { afterEach, describe, expect, it } from 'vitest'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LEGACY_USER_DATA_DIR_NAME,
  PRIMARY_MIGRATION_COMPLETION_MARKER,
  PRIMARY_MIGRATION_OWNERSHIP_MARKER,
  PRIMARY_USER_DATA_DIR_NAME,
  classifyPrimary,
  commitPrimary,
  copyProfileTree,
  prepareUserDataProfile,
  resolveUserDataProfilePaths,
  verifyCopiedTree,
} from './userDataProfileMigration'

const roots: string[] = []

async function tempAppData(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `userdata-profile-${label}-`))
  roots.push(root)
  return root
}

function appFor(appData: string) {
  return {
    getPath(name: 'appData') {
      if (name !== 'appData') throw new Error(`unexpected path ${name}`)
      return appData
    },
  }
}

async function writeFixture(
  profileRoot: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const fullPath = path.join(profileRoot, relativePath)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents)
}

async function listOwnArtifacts(appData: string): Promise<string[]> {
  const names = await readdir(appData)
  return names
    .filter(name =>
      name === 'ccmax.userData.migrating.lock'
      || name.startsWith('ccmax.userData.migrating-'),
    )
    .sort()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }),
  ))
})

describe('userData profile migration', () => {
  it('copies only-legacy profile to primary and keeps the legacy directory', async () => {
    const appData = await tempAppData('legacy-only')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'Preferences', '{"theme":"dark"}')
    await writeFixture(paths.legacyPath, 'nested/config.json', '{"ok":true}')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.primaryPath,
      source: 'migrated',
      reason: 'migrated-from-legacy',
    })
    expect(await readFile(path.join(paths.primaryPath, 'Preferences'), 'utf8'))
      .toBe('{"theme":"dark"}')
    expect(await readFile(path.join(paths.primaryPath, 'nested/config.json'), 'utf8'))
      .toBe('{"ok":true}')
    expect(await readFile(path.join(paths.legacyPath, 'Preferences'), 'utf8'))
      .toBe('{"theme":"dark"}')
    // Completion marker is committed; ownership is gone.
    expect(await lstat(path.join(paths.primaryPath, PRIMARY_MIGRATION_COMPLETION_MARKER)))
      .toBeTruthy()
    await expect(lstat(path.join(paths.primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('uses an existing non-empty primary without overwriting it', async () => {
    const appData = await tempAppData('primary-exists')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.primaryPath, { recursive: true })
    await writeFixture(paths.primaryPath, 'marker.txt', 'primary-original')
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'marker.txt', 'legacy-should-not-copy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.primaryPath,
      source: 'primary',
      reason: 'primary-exists',
    })
    expect(await readFile(path.join(paths.primaryPath, 'marker.txt'), 'utf8'))
      .toBe('primary-original')
    await expect(lstat(path.join(paths.primaryPath, 'legacy-should-not-copy')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('selects legacy when primary is an empty directory and leaves it untouched', async () => {
    const appData = await tempAppData('empty-primary')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')
    await mkdir(paths.primaryPath, { recursive: true })

    const before = await readdir(paths.primaryPath)
    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'primary-empty',
    })
    expect(await readdir(paths.primaryPath)).toEqual(before)
    expect(await readFile(path.join(paths.legacyPath, 'keep.txt'), 'utf8')).toBe('legacy')
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('selects legacy for in-progress primary and does not delete it', async () => {
    const appData = await tempAppData('in-progress-primary')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')
    await mkdir(paths.primaryPath, { recursive: true })
    await writeFile(
      path.join(paths.primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER),
      'foreign-or-stale-token',
    )
    await writeFixture(paths.primaryPath, 'partial.txt', 'partial-publish')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'primary-in-progress',
    })
    expect(await readFile(
      path.join(paths.primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER),
      'utf8',
    )).toBe('foreign-or-stale-token')
    expect(await readFile(path.join(paths.primaryPath, 'partial.txt'), 'utf8'))
      .toBe('partial-publish')
    expect(await classifyPrimary(paths.primaryPath)).toBe('in-progress')
  })

  it('uses primary when completion marker is present', async () => {
    const appData = await tempAppData('complete-marker')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'legacy-only.txt', 'legacy')
    await mkdir(paths.primaryPath, { recursive: true })
    await writeFixture(paths.primaryPath, 'Preferences', '{"ok":1}')
    await writeFile(
      path.join(paths.primaryPath, PRIMARY_MIGRATION_COMPLETION_MARKER),
      'done\n',
    )

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.primaryPath,
      source: 'primary',
      reason: 'primary-complete',
    })
    expect(await readFile(path.join(paths.primaryPath, 'Preferences'), 'utf8'))
      .toBe('{"ok":1}')
  })

  it('selects primary when neither profile directory exists and does not pre-create it', async () => {
    const appData = await tempAppData('neither')
    const paths = resolveUserDataProfilePaths(appData)

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.primaryPath,
      source: 'primary',
      reason: 'neither-exists',
    })
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(paths.legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies nested files and symlinks as links without following them outside the profile', async () => {
    const appData = await tempAppData('symlinks')
    const paths = resolveUserDataProfilePaths(appData)
    const outside = path.join(appData, 'outside-secret.txt')
    await writeFile(outside, 'outside-secret')
    await mkdir(path.join(paths.legacyPath, 'nested'), { recursive: true })
    await writeFile(path.join(paths.legacyPath, 'nested', 'inside.txt'), 'inside')
    await symlink('../outside-secret.txt', path.join(paths.legacyPath, 'nested', 'link-out'))
    await symlink('inside.txt', path.join(paths.legacyPath, 'nested', 'link-in'))

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result.source).toBe('migrated')
    expect(await readlink(path.join(paths.primaryPath, 'nested', 'link-out')))
      .toBe('../outside-secret.txt')
    expect(await readlink(path.join(paths.primaryPath, 'nested', 'link-in')))
      .toBe('inside.txt')
    expect(await readFile(path.join(paths.primaryPath, 'nested', 'inside.txt'), 'utf8'))
      .toBe('inside')
    await expect(lstat(path.join(paths.primaryPath, 'outside-secret.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to legacy and leaves no own temp/lock when copy fails', async () => {
    const appData = await tempAppData('copy-fail')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        copyProfileTree: async () => {
          throw new Error('injected copy failure')
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listOwnArtifacts(appData)).toEqual([])
    expect(await readFile(path.join(paths.legacyPath, 'keep.txt'), 'utf8')).toBe('legacy')
  })

  it('falls back to legacy and leaves no own temp/lock when verify fails', async () => {
    const appData = await tempAppData('verify-fail')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        verifyCopiedTree: async () => {
          throw new Error('injected verify failure')
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('falls back to legacy and leaves no own temp/lock when commit fails before claiming primary', async () => {
    const appData = await tempAppData('commit-fail')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        commitPrimary: async () => {
          throw new Error('injected commit failure')
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('does not overwrite a racing non-empty primary and selects primary safely', async () => {
    const appData = await tempAppData('race-primary-nonempty')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'from-legacy.txt', 'legacy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        commitPrimary: async (tempPath, primaryPath) => {
          await mkdir(primaryPath, { recursive: true })
          await writeFile(path.join(primaryPath, 'from-race.txt'), 'racing-primary')
          await commitPrimary(tempPath, primaryPath)
        },
      },
    })

    expect(result.activePath).toBe(paths.primaryPath)
    expect(result.source).toBe('primary')
    expect(await readFile(path.join(paths.primaryPath, 'from-race.txt'), 'utf8'))
      .toBe('racing-primary')
    await expect(lstat(path.join(paths.primaryPath, 'from-legacy.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(paths.legacyPath, 'from-legacy.txt'), 'utf8'))
      .toBe('legacy')
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('does not overwrite a racing empty primary and selects legacy', async () => {
    const appData = await tempAppData('race-primary-empty')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'from-legacy.txt', 'legacy')

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        commitPrimary: async (tempPath, primaryPath) => {
          await mkdir(primaryPath)
          await commitPrimary(tempPath, primaryPath)
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    // Empty primary left untouched — still empty, no migration content.
    expect(await readdir(paths.primaryPath)).toEqual([])
    expect(await readFile(path.join(paths.legacyPath, 'from-legacy.txt'), 'utf8'))
      .toBe('legacy')
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('cleans only owned primary when mid-publish fails without unknown entries', async () => {
    const appData = await tempAppData('mid-publish-owned-cleanup')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'a.txt', 'A')
    await writeFixture(paths.legacyPath, 'b.txt', 'B')

    let renameCalls = 0
    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        renamePath: async (from, to) => {
          renameCalls += 1
          if (renameCalls >= 2) {
            throw new Error('injected mid-publish failure')
          }
          await rename(from, to)
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    // Owned-only partial primary must be cleaned.
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(paths.legacyPath, 'a.txt'), 'utf8')).toBe('A')
    expect(await readFile(path.join(paths.legacyPath, 'b.txt'), 'utf8')).toBe('B')
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('keeps partial primary and falls back to legacy when an unknown racing entry appears', async () => {
    const appData = await tempAppData('mid-publish-unknown-entry')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'a.txt', 'A')
    await writeFixture(paths.legacyPath, 'b.txt', 'B')

    let renameCalls = 0
    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        renamePath: async (from, to) => {
          renameCalls += 1
          if (renameCalls === 1) {
            await rename(from, to)
            // Competitor drops an unknown entry into the owned primary.
            await writeFile(path.join(paths.primaryPath, 'race-unknown.txt'), 'competitor')
            return
          }
          throw new Error('injected failure after unknown entry')
        },
      },
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    // Must not delete partial primary once unknown entry is present.
    expect(await readFile(path.join(paths.primaryPath, 'race-unknown.txt'), 'utf8'))
      .toBe('competitor')
    expect(await readFile(
      path.join(paths.primaryPath, PRIMARY_MIGRATION_OWNERSHIP_MARKER),
      'utf8',
    )).toMatch(/^[0-9a-f]+$/)
    const primaryNames = await readdir(paths.primaryPath)
    expect(primaryNames).toEqual(expect.arrayContaining([
      PRIMARY_MIGRATION_OWNERSHIP_MARKER,
      'race-unknown.txt',
    ]))
    // Exactly one of the published top-level files was moved before the failure.
    expect(
      primaryNames.includes('a.txt') || primaryNames.includes('b.txt'),
    ).toBe(true)
    expect(await readFile(path.join(paths.legacyPath, 'a.txt'), 'utf8')).toBe('A')
    expect(await readFile(path.join(paths.legacyPath, 'b.txt'), 'utf8')).toBe('B')
    expect(await listOwnArtifacts(appData)).toEqual([])
  })

  it('uses legacy when the exclusive migration lock is already held and primary is absent', async () => {
    const appData = await tempAppData('lock-held')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(paths.legacyPath, 'keep.txt', 'legacy')
    await mkdir(paths.lockPath)

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-lock-held',
    })
    expect(await lstat(paths.lockPath)).toBeTruthy()
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses primary when lock is held but a usable primary is already present', async () => {
    const appData = await tempAppData('lock-with-primary')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await mkdir(paths.primaryPath, { recursive: true })
    await writeFixture(paths.primaryPath, 'ready.txt', 'primary')
    await mkdir(paths.lockPath)

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.primaryPath,
      source: 'primary',
      reason: 'primary-exists',
    })
    expect(await lstat(paths.lockPath)).toBeTruthy()
  })

  it('rejects unsupported special files by falling back to legacy', async () => {
    const appData = await tempAppData('special-file')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
      fs: {
        copyProfileTree: async () => {
          throw new Error('unsupported profile entry type at device-node')
        },
      },
    })

    expect(result.source).toBe('legacy')
    expect(result.activePath).toBe(paths.legacyPath)
  })

  it('fails closed when legacy already contains a reserved migration marker name', async () => {
    const appData = await tempAppData('legacy-reserved-marker')
    const paths = resolveUserDataProfilePaths(appData)
    await mkdir(paths.legacyPath, { recursive: true })
    await writeFixture(
      paths.legacyPath,
      PRIMARY_MIGRATION_COMPLETION_MARKER,
      'preexisting',
    )

    const result = await prepareUserDataProfile(appFor(appData), {
      log: () => undefined,
    })

    expect(result).toMatchObject({
      activePath: paths.legacyPath,
      source: 'legacy',
      reason: 'migration-failed',
    })
    await expect(lstat(paths.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies manifest kinds, sizes, and symlink targets for a real tree', async () => {
    const appData = await tempAppData('manifest')
    const source = path.join(appData, LEGACY_USER_DATA_DIR_NAME)
    const dest = path.join(appData, 'temp-copy')
    await mkdir(path.join(source, 'nested'), { recursive: true })
    await writeFile(path.join(source, 'nested', 'file.txt'), 'abc')
    await symlink('file.txt', path.join(source, 'nested', 'rel-link'))
    await mkdir(dest)

    const manifest = await copyProfileTree(source, dest)
    await verifyCopiedTree(source, dest, manifest)

    expect(manifest).toEqual(expect.arrayContaining([
      { relativePath: '', kind: 'directory' },
      { relativePath: 'nested', kind: 'directory' },
      { relativePath: path.join('nested', 'file.txt'), kind: 'file', size: 3 },
      { relativePath: path.join('nested', 'rel-link'), kind: 'symlink', target: 'file.txt' },
    ]))
    expect(PRIMARY_USER_DATA_DIR_NAME).toBe('ccmax')
    expect(LEGACY_USER_DATA_DIR_NAME).toBe('Claude Code Haha')
  })

  it('rejects extra entries in the copied temp tree against the manifest', async () => {
    const appData = await tempAppData('manifest-extra')
    const source = path.join(appData, 'src')
    const dest = path.join(appData, 'dest')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'a.txt'), 'a')
    await mkdir(dest)
    const manifest = await copyProfileTree(source, dest)
    await writeFile(path.join(dest, 'extra.txt'), 'sneak')

    await expect(verifyCopiedTree(source, dest, manifest))
      .rejects.toThrow(/unexpected entry|entry count/)
  })

  it('rejects missing entries in the copied temp tree against the manifest', async () => {
    const appData = await tempAppData('manifest-missing')
    const source = path.join(appData, 'src')
    const dest = path.join(appData, 'dest')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'a.txt'), 'a')
    await writeFile(path.join(source, 'b.txt'), 'b')
    await mkdir(dest)
    const manifest = await copyProfileTree(source, dest)
    await rm(path.join(dest, 'b.txt'))

    await expect(verifyCopiedTree(source, dest, manifest))
      .rejects.toThrow(/missing entry|entry count/)
  })

  it('detects source size drift after copy using the original manifest size', async () => {
    const appData = await tempAppData('manifest-source-drift')
    const source = path.join(appData, 'src')
    const dest = path.join(appData, 'dest')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'a.txt'), 'abc')
    await mkdir(dest)
    const manifest = await copyProfileTree(source, dest)
    await writeFile(path.join(source, 'a.txt'), 'abcdef')

    await expect(verifyCopiedTree(source, dest, manifest))
      .rejects.toThrow(/size mismatch/)
  })
})