import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanMigrationFiles, skipMigrationEntry } from './dataMigrationFiles'

const roots: string[] = []

const regenerableNames = [
  'index-v1.sqlite',
  'trace-index-v1.sqlite',
  'search-index-v1.sqlite',
  'scheduled-runs-v1.sqlite',
] as const
const sidecarSuffixes = ['', '-wal', '-shm', '-journal'] as const
const managedPrefixes = ['ccmax/db', 'cc-haha/db'] as const

function posix(relative: string): string {
  return relative.split(path.sep).join('/')
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('skipMigrationEntry managed databases', () => {
  it.each(managedPrefixes.flatMap(prefix =>
    regenerableNames.flatMap(name =>
      sidecarSuffixes.map(suffix => `${prefix}/${name}${suffix}`),
    ),
  ))('skips regenerable %s', relative => {
    expect(skipMigrationEntry(relative)).toBe(true)
    expect(skipMigrationEntry(relative.split('/').join(path.sep))).toBe(true)
  })

  it.each([
    'ccmax/db/unknown.sqlite',
    'ccmax/db/unknown.sqlite-wal',
    'cc-haha/db/unknown.sqlite',
    'cc-haha/db/unknown.sqlite-journal',
    'other/db/index-v1.sqlite',
    'other/db/index-v1.sqlite-wal',
    'projects/ccmax/db/index-v1.sqlite',
    'ccmax/other/index-v1.sqlite',
    'cc-haha/tasks/index-v1.sqlite',
    'ccmax/db/nested/index-v1.sqlite',
    'index-v1.sqlite',
  ])('keeps user or off-namespace %s', relative => {
    expect(skipMigrationEntry(relative)).toBe(false)
  })
})

describe('scanMigrationFiles managed sqlite families', () => {
  it('omits primary and legacy regenerable sqlite+WAL while keeping unknown and off-namespace files', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haha-migration-db-')))
    roots.push(root)

    const put = async (relative: string, value: string) => {
      const file = path.join(root, relative)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, value)
    }

    for (const prefix of managedPrefixes) {
      for (const name of regenerableNames) {
        for (const suffix of sidecarSuffixes) {
          await put(`${prefix}/${name}${suffix}`, `regenerable:${prefix}/${name}${suffix}`)
        }
      }
      await put(`${prefix}/unknown.sqlite`, `unknown:${prefix}`)
      await put(`${prefix}/unknown.sqlite-wal`, `unknown-wal:${prefix}`)
    }
    await put('other/db/index-v1.sqlite', 'off-namespace-main')
    await put('other/db/index-v1.sqlite-wal', 'off-namespace-wal')
    await put('ccmax/db/nested/index-v1.sqlite', 'nested-same-name')
    await put('projects/ccmax/db/index-v1.sqlite', 'projects-same-name')
    await put('settings.json', '{"keep":true}')

    const files = await scanMigrationFiles(root)
    const relatives = new Set(files.filter(file => file.kind === 'file').map(file => posix(file.relative)))

    for (const prefix of managedPrefixes) {
      for (const name of regenerableNames) {
        for (const suffix of sidecarSuffixes) {
          expect(relatives.has(`${prefix}/${name}${suffix}`)).toBe(false)
        }
      }
      expect(relatives.has(`${prefix}/unknown.sqlite`)).toBe(true)
      expect(relatives.has(`${prefix}/unknown.sqlite-wal`)).toBe(true)
    }
    expect(relatives.has('other/db/index-v1.sqlite')).toBe(true)
    expect(relatives.has('other/db/index-v1.sqlite-wal')).toBe(true)
    expect(relatives.has('ccmax/db/nested/index-v1.sqlite')).toBe(true)
    expect(relatives.has('projects/ccmax/db/index-v1.sqlite')).toBe(true)
    expect(relatives.has('settings.json')).toBe(true)
  })
})