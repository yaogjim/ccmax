/**
 * Regression: boot ordering around the fork-owned `<config>/ccmax` directory.
 *
 * The persistent-storage migration publishes `<config>/ccmax` by copying a
 * legacy `<config>/cc-haha` tree with `fs.rename`, and it refuses to touch a
 * primary that already exists. Any startup writer that creates
 * `<config>/ccmax` first therefore makes the whole-directory import silently
 * skip: a user upgrading from the legacy layout loses every provider, every
 * managed setting and every public-channel record without a single error.
 *
 * 1. The local index opens `<config>/ccmax/db`, so it must run after the
 *    migration — and an early API request must not read a provider config the
 *    import is still writing.
 * 2. The public telegram channel writes `<config>/ccmax/telegram-public.json`,
 *    so it must run after the migration too, and a migration-validation startup
 *    must not touch the fork-owned directory at all (it defers to `activate`).
 *
 * Both cases boot the real server with a temporary `CLAUDE_CONFIG_DIR`; no real
 * user state, model or platform network is involved.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'
import { resetNotificationRecoveryStateForTests } from '../services/notificationService.js'
import {
  CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
  resetPersistentStorageMigrationsForTests,
} from '../services/persistentStorageMigrations.js'
import { getTelegramPublicService } from '../services/telegramPublicService.js'

type RunningServer = ReturnType<typeof startServer>

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

describe('startup storage-upgrade ordering', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalValidation: string | undefined
  let originalToken: string | undefined
  const servers: RunningServer[] = []

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmax-startup-order-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalValidation = process.env.CC_HAHA_MIGRATION_VALIDATION
    originalToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    delete process.env.CC_HAHA_MIGRATION_VALIDATION
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    resetPersistentStorageMigrationsForTests()
    resetNotificationRecoveryStateForTests()
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop(true)
      await stopServerRuntimeForShutdown({ waitForCli: false })
    }
    mock.restore()
    resetPersistentStorageMigrationsForTests()
    resetNotificationRecoveryStateForTests()
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', originalConfigDir],
      ['CC_HAHA_MIGRATION_VALIDATION', originalValidation],
      ['CC_HAHA_LOCAL_ACCESS_TOKEN', originalToken],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('imports a legacy cc-haha-only tree before the local index opens its database', async () => {
    const legacyDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.writeFile(
      path.join(legacyDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: 'legacy-provider',
        providers: [{
          id: 'legacy-provider',
          presetId: 'custom',
          name: 'Legacy Provider',
          apiKey: 'legacy-token',
          baseUrl: 'https://legacy.example.test',
          models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
        }],
        providerOrder: ['legacy-provider', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )
    await fs.writeFile(
      path.join(legacyDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://legacy.example.test' } }, null, 2),
      'utf-8',
    )
    await fs.writeFile(
      path.join(legacyDir, 'telegram-public.json'),
      JSON.stringify({ subscriptions: { '42': [{ eventId: 'legacy-event' }] } }, null, 2),
      'utf-8',
    )
    // A file no service ever creates: only the directory import can publish it
    // under `ccmax`.
    await fs.writeFile(path.join(legacyDir, 'legacy-user-note.json'), '{"keep":true}\n', 'utf-8')

    const indexStartSawImportedTree: boolean[] = []
    const originalStart = localIndexCoordinator.start.bind(localIndexCoordinator)
    spyOn(localIndexCoordinator, 'start').mockImplementation(async () => {
      indexStartSawImportedTree.push(await exists(path.join(tmpDir, 'ccmax', 'providers.json')))
      return originalStart()
    })

    const server = startServer(0, '127.0.0.1')
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    // An early API request must not observe an empty provider list while the
    // import is still in flight.
    const response = await fetch(`${base}/api/providers`)
    expect(response.status).toBe(200)
    const body = await response.json() as { providers: Array<{ id: string }> }
    expect(body.providers.map(provider => provider.id)).toEqual(['legacy-provider'])

    // The first index start observed the imported provider config: the
    // migration published `ccmax` before anything opened a database under it.
    expect(indexStartSawImportedTree[0]).toBe(true)
    expect(await exists(path.join(tmpDir, 'ccmax', 'settings.json'))).toBe(true)
    expect(await exists(path.join(tmpDir, 'ccmax', 'telegram-public.json'))).toBe(true)
    expect(await exists(path.join(tmpDir, 'ccmax', 'legacy-user-note.json'))).toBe(true)

    // The legacy tree is never deleted or rewritten by the import.
    expect((await fs.readdir(legacyDir)).sort()).toContain('providers.json')
    expect((await fs.readdir(tmpDir)).filter(name => name.startsWith('ccmax.migrating-'))).toEqual([])
  })

  test('validation startup leaves the public telegram store untouched and activation resumes it', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), '{}\n', 'utf-8')
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({
        telegram: {
          public: {
            enabled: true,
            botToken: 'public-fixture-token',
            ownerUserId: 42,
            generation: 1,
          },
        },
      }, null, 2),
      'utf-8',
    )
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'telegram-public.json'),
      JSON.stringify({ subscriptions: { '42': [{ eventId: 'legacy-event' }] } }, null, 2),
      'utf-8',
    )

    process.env.CC_HAHA_MIGRATION_VALIDATION = '1'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'isolated-token'

    const telegramRequests: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (target.includes('api.telegram.org')) {
        telegramRequests.push(target)
        return Response.json({ ok: true, result: { message_id: 1 } })
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const startSpy = spyOn(getTelegramPublicService(), 'start')
    try {
      const server = startServer(0, '127.0.0.1')
      servers.push(server)
      const base = `http://127.0.0.1:${server.port}`
      const authorize = { Authorization: 'Bearer isolated-token' }

      expect((await fetch(`${base}/health`)).status).toBe(200)
      expect(await (await fetch(`${base}/api/runtime/migration/validate`, { headers: authorize })).json())
        .toEqual({ valid: true })

      // Nothing may start the public channel or contact the platform while the
      // source tree is only being validated.
      expect(startSpy).not.toHaveBeenCalled()
      expect(telegramRequests).toEqual([])
      expect(await exists(path.join(tmpDir, 'ccmax'))).toBe(false)
      expect((await fs.readdir(tmpDir)).sort()).toEqual(['adapters.json', 'cc-haha', 'settings.json'])

      expect(await (await fetch(`${base}/api/runtime/migration/activate`, {
        method: 'POST',
        headers: authorize,
      })).json()).toEqual({ activated: true })
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && !(await exists(path.join(tmpDir, 'ccmax', 'telegram-public.json')))) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(await exists(path.join(tmpDir, 'ccmax', 'telegram-public.json'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a normal boot still starts the index and the public channel after the upgrade', async () => {
    await seedLegacyTree()
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({ telegram: { public: { enabled: true, botToken: 'public-fixture-token', ownerUserId: 42, generation: 1 } } }, null, 2),
      'utf-8',
    )

    const indexStarts: string[] = []
    const counters = recordIndexStarts(() => false, indexStarts)
    const startSpy = spyOn(getTelegramPublicService(), 'start')
    const server = startServer(0, '127.0.0.1')
    servers.push(server)

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (counters.total === 0 || startSpy.mock.calls.length === 0)) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(counters.total).toBeGreaterThan(0)
    expect(indexStarts).toEqual([])
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  /**
   * A stop that lands before the deferred startup runs must not restart a
   * subsystem the stop already closed. The storage upgrade performs real
   * asynchronous filesystem work, so calling `server.stop(true)` in the
   * synchronous frame after `startServer` deterministically precedes it; the
   * premise assertion below keeps that from becoming a vacuous pass.
   */
  test('a stop while the storage upgrade is still running never restarts the index or the public channel', async () => {
    await seedLegacyTree()
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({ telegram: { public: { enabled: true, botToken: 'public-fixture-token', ownerUserId: 42, generation: 1 } } }, null, 2),
      'utf-8',
    )

    let stopped = false
    const starts: string[] = []
    const counters = recordIndexStarts(() => stopped, starts)
    const telegram = getTelegramPublicService()
    const originalTelegramStart = telegram.start.bind(telegram)
    spyOn(telegram, 'start').mockImplementation(async () => {
      if (stopped) starts.push('telegram-public')
      return originalTelegramStart()
    })

    const server = startServer(0, '127.0.0.1')
    try {
      // Premise: the upgrade has not settled yet, so every start observed from
      // here on is a restart after the stop.
      expect(counters.total).toBe(0)
      stopped = true
      server.stop(true)
      await stopServerRuntimeForShutdown({ waitForCli: false })
      await new Promise(resolve => setTimeout(resolve, 1_000))
      expect(starts).toEqual([])
    } finally {
      stopped = true
      await server.stop(true)
      await stopServerRuntimeForShutdown({ waitForCli: false })
    }
  })

  /**
   * The remote-browser API callback in `startServer` does not await the storage
   * upgrade itself (it only rejects while a migration is active), so this checks
   * the property that actually matters: the fork-owned reader underneath it
   * (`ProviderService.readIndex`) does await the same promise, so a remote
   * request issued while the import is still running already sees the imported
   * provider list instead of an empty one.
   */
  test('a remote-browser provider read during the upgrade sees the imported config', async () => {
    const origin = 'https://remote.example.test'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'isolated-token'
    await seedLegacyTree()
    await fs.writeFile(path.join(tmpDir, 'settings.json'), '{"env":{}}\n', 'utf-8')

    const counters = recordIndexStarts(() => false, [])
    const server = startServer(0, '127.0.0.1')
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const control = (route: string, body?: unknown) => fetch(`${base}/api/public-access${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer isolated-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const enabled = await (await control('/enable', { publicUrl: origin })).json() as { port: number }
    const remote = `http://127.0.0.1:${enabled.port}`
    const code = await (await control('/pairing', {})).json() as { secret: string }
    const post = (route: string, body: unknown) => fetch(`${remote}/api/public-access/${route}`, {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify(body),
    })
    const pending = await (await post('pair', { secret: code.secret, name: 'Fixture phone' })).json() as { id: string, claimSecret: string }
    await control('/approve', { id: pending.id })
    const cookie = (await post('claim', pending)).headers.get('set-cookie')!.split(';')[0]!

    // Premise: the deferred index startup has not run, so the upgrade is still
    // in flight when this remote request is issued.
    expect(counters.total).toBe(0)
    const response = await fetch(`${remote}/api/providers`, { headers: { Origin: origin, Cookie: cookie } })
    expect(response.status).toBe(200)
    const body = await response.json() as { providers: Array<{ id: string }> }
    expect(body.providers.map(provider => provider.id)).toEqual(['legacy-provider'])
  })

  /**
   * Records every `localIndexCoordinator.start()` and reports the ones that ran
   * once `isStopped()` flipped true.
   */
  function recordIndexStarts(isStopped: () => boolean, startsAfterStop: string[]) {
    const counters = { total: 0 }
    const coordinator = localIndexCoordinator
    const originalStart = coordinator.start.bind(coordinator)
    spyOn(coordinator, 'start').mockImplementation(async () => {
      counters.total += 1
      if (isStopped()) startsAfterStop.push('local-index')
      return originalStart()
    })
    return counters
  }

  /** A legacy-only tree big enough that its import spans several event-loop turns. */
  async function seedLegacyTree(): Promise<void> {
    const legacyDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(path.join(legacyDir, 'bulk'), { recursive: true })
    await fs.writeFile(
      path.join(legacyDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: 'legacy-provider',
        providers: [{
          id: 'legacy-provider',
          presetId: 'custom',
          name: 'Legacy Provider',
          apiKey: 'legacy-token',
          baseUrl: 'https://legacy.example.test',
          models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
        }],
        providerOrder: ['legacy-provider', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )
    await fs.writeFile(path.join(legacyDir, 'settings.json'), '{"env":{}}\n', 'utf-8')
    for (let index = 0; index < 300; index += 1) {
      await fs.writeFile(
        path.join(legacyDir, 'bulk', `entry-${index}.json`),
        `{"index":${index},"payload":"${'x'.repeat(2048)}"}\n`,
        'utf-8',
      )
    }
  }
})