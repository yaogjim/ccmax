import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ProviderService } from '../services/providerService.js'
import { SettingsService } from '../services/settingsService.js'
import {
  CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
  ensurePersistentStorageUpgraded,
  resetPersistentStorageMigrationsForTests,
} from '../services/persistentStorageMigrations.js'

let tempDir: string

async function listFiles(dir: string) {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

describe('persistent storage upgrade migrations', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-persistence-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    resetPersistentStorageMigrationsForTests()
  })

  afterEach(async () => {
    resetPersistentStorageMigrationsForTests()
    delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('upgrades legacy team preferences on read and preserves the original settings on save', async () => {
    const userPath = path.join(tempDir, 'settings.json')
    const managedDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(managedDir, { recursive: true })
    const legacy = {
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', LEGACY_OTHER_ENV: 'preserved' },
      unknownFuturePreference: { keep: true },
    }
    const original = JSON.stringify(legacy)
    await fs.writeFile(userPath, original)
    await fs.writeFile(path.join(managedDir, 'settings.json'), JSON.stringify({
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' },
    }))
    const service = new SettingsService()
    expect(await service.getAgentTeamsEnabled()).toBe(false)
    expect(await fs.readFile(userPath, 'utf-8')).toBe(original)
    await service.updateUserSettings({ agentTeamsEnabled: true })
    expect(await new SettingsService().getAgentTeamsEnabled()).toBe(true)
    expect(JSON.parse(await fs.readFile(userPath, 'utf-8'))).toEqual({ ...legacy, agentTeamsEnabled: true })
    await service.updateUserSettings({ agentTeamsEnabled: false })
    expect(await new SettingsService().getAgentTeamsEnabled()).toBe(false)
  })

  test('migrates legacy providers index and writes a backup before changing it', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        activeProviderId: 'provider-1',
        rootFutureField: { keep: true },
        providers: [{
          id: 'provider-1',
          presetId: 'custom',
          name: 'Legacy Provider',
          apiKey: 'token',
          baseUrl: 'https://example.test',
          models: { main: 'model-main', haiku: '', sonnet: '', opus: '' },
          extraFutureField: 'keep-me',
        }],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha/providers.json')

    const migrated = JSON.parse(await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8')) as {
      schemaVersion?: number
      activeId?: string | null
      activeProviderId?: string
      providerOrder?: string[]
      rootFutureField?: unknown
      providers?: Array<Record<string, unknown>>
    }
    expect(migrated.schemaVersion).toBe(CURRENT_PROVIDER_INDEX_SCHEMA_VERSION)
    expect(migrated.activeId).toBe('provider-1')
    expect(migrated.providerOrder).toEqual(['provider-1', 'claude-official', 'openai-official', 'grok-official'])
    expect(migrated.activeProviderId).toBeUndefined()
    expect(migrated.rootFutureField).toEqual({ keep: true })
    expect(migrated.providers?.[0]?.extraFutureField).toBe('keep-me')

    const backups = (await listFiles(ccHahaDir)).filter((file) => file.startsWith('providers.json.bak-before-migration-'))
    expect(backups.length).toBe(1)

    const service = new ProviderService()
    const { providers, activeId } = await service.listProviders()
    expect(providers).toHaveLength(1)
    expect(activeId).toBe('provider-1')

    await service.updateProvider('provider-1', { name: 'Renamed Provider' })
    // After copy, resolveForkOwnedDir prefers ccmax for writes.
    const rewritten = JSON.parse(await fs.readFile(path.join(tempDir, 'ccmax', 'providers.json'), 'utf-8')) as {
      rootFutureField?: unknown
      providers?: Array<Record<string, unknown>>
    }
    expect(rewritten.rootFutureField).toEqual({ keep: true })
    expect(rewritten.providers?.[0]?.extraFutureField).toBe('keep-me')
  })

  test('upgrades a version 2 provider fixture without inventing image credentials', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeId: 'provider-v2',
        providers: [{
          id: 'provider-v2',
          presetId: 'custom',
          name: 'Version 2 Provider',
          apiKey: 'chat-token',
          baseUrl: 'https://v2.example.test',
          apiFormat: 'anthropic',
          models: {
            main: 'chat-model',
            haiku: 'chat-model',
            sonnet: 'chat-model',
            opus: 'chat-model',
          },
          futureField: { preserved: true },
        }],
        providerOrder: ['provider-v2', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    const migrated = JSON.parse(
      await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8'),
    ) as { schemaVersion: number; providers: Array<Record<string, unknown>> }
    expect(migrated.schemaVersion).toBe(CURRENT_PROVIDER_INDEX_SCHEMA_VERSION)
    expect(migrated.providers[0]?.imageGeneration).toBeUndefined()
    expect(migrated.providers[0]?.futureField).toEqual({ preserved: true })
  })

  test('turns legacy default Tool Search on into a safe opt-out during upgrade', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: 3,
        activeId: 'provider-v3',
        providers: [{
          id: 'provider-v3',
          presetId: 'custom',
          name: 'Version 3 Provider',
          apiKey: 'chat-token',
          baseUrl: 'https://v3.example.test',
          apiFormat: 'anthropic',
          toolSearchEnabled: true,
          models: {
            main: 'chat-model',
            haiku: 'chat-model',
            sonnet: 'chat-model',
            opus: 'chat-model',
          },
          futureField: { preserved: true },
        }],
        providerOrder: ['provider-v3', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha/providers.json')
    const migrated = JSON.parse(
      await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8'),
    ) as { schemaVersion: number; providers: Array<Record<string, unknown>> }
    expect(migrated.schemaVersion).toBe(CURRENT_PROVIDER_INDEX_SCHEMA_VERSION)
    expect(migrated.providers[0]?.toolSearchEnabled).toBe(false)
    expect(migrated.providers[0]?.futureField).toEqual({ preserved: true })
  })

  test('preserves Tool Search after explicit opt-in on the current provider schema', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: 'provider-current',
        providers: [{
          id: 'provider-current',
          presetId: 'custom',
          name: 'Current Provider',
          apiKey: 'chat-token',
          baseUrl: 'https://current.example.test',
          apiFormat: 'anthropic',
          toolSearchEnabled: true,
          models: {
            main: 'chat-model',
            haiku: 'chat-model',
            sonnet: 'chat-model',
            opus: 'chat-model',
          },
        }],
        providerOrder: ['provider-current', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).not.toContain('cc-haha/providers.json')
    const current = JSON.parse(
      await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8'),
    ) as { providers: Array<Record<string, unknown>> }
    expect(current.providers[0]?.toolSearchEnabled).toBe(true)
  })

  test('imports legacy root providers config into cc-haha storage without deleting the source', async () => {
    await fs.writeFile(
      path.join(tempDir, 'providers.json'),
      JSON.stringify({
        version: 1,
        activeModel: 'legacy-sonnet',
        providers: [{
          id: 'legacy-provider',
          name: 'Legacy Root Provider',
          baseUrl: 'https://legacy.example.test',
          apiKey: 'legacy-token',
          models: [
            { id: 'legacy-haiku', name: 'Legacy Haiku' },
            { id: 'legacy-sonnet', name: 'Legacy Sonnet' },
          ],
          isActive: true,
          createdAt: 1,
          updatedAt: 2,
          notes: 'keep note',
        }],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('providers.json -> cc-haha/providers.json')
    expect(report.migratedEntries).toContain('providers.json -> cc-haha/settings.json')
    expect(JSON.parse(await fs.readFile(path.join(tempDir, 'providers.json'), 'utf-8'))).toMatchObject({
      version: 1,
      activeModel: 'legacy-sonnet',
    })

    const migrated = JSON.parse(await fs.readFile(path.join(tempDir, 'cc-haha', 'providers.json'), 'utf-8')) as {
      activeId?: string | null
      providerOrder?: string[]
      providers?: Array<{
        id?: string
        presetId?: string
        apiFormat?: string
        models?: Record<string, string>
        notes?: string
      }>
    }
    expect(migrated.activeId).toBe('legacy-provider')
    expect(migrated.providerOrder).toEqual(['legacy-provider', 'claude-official', 'openai-official', 'grok-official'])
    expect(migrated.providers?.[0]).toMatchObject({
      id: 'legacy-provider',
      presetId: 'custom',
      apiFormat: 'anthropic',
      notes: 'keep note',
      models: {
        main: 'legacy-sonnet',
        haiku: 'legacy-sonnet',
        sonnet: 'legacy-sonnet',
        opus: 'legacy-sonnet',
      },
    })

    const managedSettings = JSON.parse(await fs.readFile(path.join(tempDir, 'cc-haha', 'settings.json'), 'utf-8')) as {
      env?: Record<string, string>
    }
    expect(managedSettings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://legacy.example.test',
      ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      ANTHROPIC_MODEL: 'legacy-sonnet',
    })

    const service = new ProviderService()
    const { providers, activeId } = await service.listProviders()
    expect(activeId).toBe('legacy-provider')
    expect(providers[0]?.models.main).toBe('legacy-sonnet')
  })

  test('does not overwrite current cc-haha provider storage with a legacy root config', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(tempDir, 'providers.json'),
      JSON.stringify({
        version: 1,
        activeModel: 'legacy-model',
        providers: [{
          id: 'legacy-provider',
          name: 'Legacy Root Provider',
          baseUrl: 'https://legacy.example.test',
          apiKey: 'legacy-token',
          models: [{ id: 'legacy-model' }],
          isActive: true,
        }],
      }, null, 2),
      'utf-8',
    )
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: null,
        providers: [],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).not.toContain('providers.json -> cc-haha/providers.json')
    const current = JSON.parse(await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8')) as {
      activeId?: string | null
      providerOrder?: string[]
      providers?: unknown[]
    }
    expect(current.activeId).toBeNull()
    expect(current.providerOrder).toEqual(['claude-official', 'openai-official', 'grok-official'])
    expect(current.providers).toEqual([])
  })

  test('does not write repo-owned schema metadata into shared user settings', async () => {
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      JSON.stringify({
        defaultMode: 'acceptEdits',
        userOwnedFutureField: { nested: true },
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    const settings = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')) as Record<string, unknown>
    expect(settings.schemaVersion).toBeUndefined()
    expect(settings.userOwnedFutureField).toEqual({ nested: true })
  })

  test('quarantines malformed managed settings instead of blocking startup', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(path.join(ccHahaDir, 'settings.json'), '{"env":', 'utf-8')

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha/settings.json')
    expect(JSON.parse(await fs.readFile(path.join(ccHahaDir, 'settings.json'), 'utf-8'))).toEqual({})
    const quarantined = (await listFiles(ccHahaDir)).filter((file) => file.startsWith('settings.json.invalid-'))
    expect(quarantined.length).toBe(1)
  })

  test('upgrades existing DeepSeek managed env to follow global thinking settings', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'test-token',
          ANTHROPIC_MODEL: 'deepseek-v4-pro',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
          CC_HAHA_SEND_DISABLED_THINKING: '1',
          USER_CUSTOM_ENV: 'keep-me',
        },
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha/settings.json')

    const migrated = JSON.parse(await fs.readFile(path.join(ccHahaDir, 'settings.json'), 'utf-8')) as {
      env?: Record<string, string>
    }
    expect(migrated.env?.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
    expect(migrated.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
    expect(migrated.env?.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
    expect(migrated.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
    expect(migrated.env?.USER_CUSTOM_ENV).toBe('keep-me')

    const backups = (await listFiles(ccHahaDir)).filter((file) => file.startsWith('settings.json.bak-before-migration-'))
    expect(backups.length).toBe(1)
  })
  test('upgrades v4 providers to automatic defaults with a backup and preserves unknown fields', async () => {
    const dir = path.join(tempDir, 'cc-haha')
    const file = path.join(dir, 'providers.json')
    await fs.mkdir(dir, { recursive: true })
    const fixture = {
      presetId: 'custom', name: 'Fixture provider', apiKey: 'fake-test-token',
      baseUrl: 'https://provider.example.test/v1', apiFormat: 'openai_chat',
      models: { main: 'fixture-model', haiku: '', sonnet: '', opus: '' },
    }
    const compatibility = { maxOutputTokens: 96_000, outputTokenLimit: 128_000 }
    const legacy = {
      schemaVersion: 4,
      activeId: 'old',
      futureRoot: { keep: true },
      providers: [
        { ...fixture, id: 'old', toolSearchEnabled: true, futureProvider: 'keep' },
        { ...fixture, id: 'future', requestCompatibility: { ...compatibility, futureParameter: 'keep' } },
      ],
    }
    await fs.writeFile(file, JSON.stringify(legacy))
    const report = await ensurePersistentStorageUpgraded()
    expect(report.failures).toEqual([])
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(migrated.schemaVersion).toBeGreaterThan(4)
    expect(migrated.schemaVersion).toBe(CURRENT_PROVIDER_INDEX_SCHEMA_VERSION)
    expect(migrated.providers[0].requestCompatibility).toBeUndefined()
    expect(migrated.providers[0].toolSearchEnabled).toBe(true)
    expect(migrated.providers[0].futureProvider).toBe('keep')
    expect(migrated.futureRoot).toEqual({ keep: true })
    expect(migrated.providers[1].requestCompatibility.futureParameter).toBe('keep')
    const backups = (await fs.readdir(dir)).filter(name => name.startsWith('providers.json.bak-before-migration-'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(dir, backups[0]!), 'utf8'))).toEqual(legacy)
    resetPersistentStorageMigrationsForTests()
    expect((await ensurePersistentStorageUpgraded()).migratedEntries).toEqual([])
    const service = new ProviderService()
    await service.updateProvider('old', { name: 'Renamed fixture' })
    const rewritten = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(rewritten.providers[1].requestCompatibility.futureParameter).toBe('keep')
    expect(rewritten.providers[0].futureProvider).toBe('keep')
  })

  test('copies legacy cc-haha fork dir into ccmax when primary is missing', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    const ccmaxDir = path.join(tempDir, 'ccmax')
    await fs.mkdir(ccHahaDir, { recursive: true })
    const providers = {
      schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
      activeId: 'copied-provider',
      providers: [{
        id: 'copied-provider',
        presetId: 'custom',
        name: 'Copied Provider',
        apiKey: 'copied-token',
        baseUrl: 'https://copied.example.test',
        models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
      }],
      providerOrder: ['copied-provider', 'claude-official', 'openai-official', 'grok-official'],
    }
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: 'https://copied.example.test',
        ANTHROPIC_AUTH_TOKEN: 'copied-token',
      },
    }
    await fs.writeFile(path.join(ccHahaDir, 'providers.json'), JSON.stringify(providers, null, 2), 'utf-8')
    await fs.writeFile(path.join(ccHahaDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha -> ccmax')
    expect(await pathExists(ccHahaDir)).toBe(true)
    expect(await pathExists(ccmaxDir)).toBe(true)

    const legacyProviders = JSON.parse(await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8'))
    const primaryProviders = JSON.parse(await fs.readFile(path.join(ccmaxDir, 'providers.json'), 'utf-8'))
    expect(legacyProviders).toMatchObject({ activeId: 'copied-provider' })
    expect(primaryProviders).toMatchObject({ activeId: 'copied-provider' })

    const service = new ProviderService()
    const listed = await service.listProviders()
    expect(listed.activeId).toBe('copied-provider')
    expect(listed.providers[0]?.name).toBe('Copied Provider')
  })

  test('does not overwrite an existing ccmax dir when legacy cc-haha is also present', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    const ccmaxDir = path.join(tempDir, 'ccmax')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.mkdir(ccmaxDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: 'legacy-only',
        providers: [{
          id: 'legacy-only',
          presetId: 'custom',
          name: 'Legacy Only',
          apiKey: 'legacy',
          baseUrl: 'https://legacy.example.test',
          models: { main: 'l', haiku: 'l', sonnet: 'l', opus: 'l' },
        }],
        providerOrder: ['legacy-only', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )
    await fs.writeFile(
      path.join(ccmaxDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: 'primary-only',
        providers: [{
          id: 'primary-only',
          presetId: 'custom',
          name: 'Primary Only',
          apiKey: 'primary',
          baseUrl: 'https://primary.example.test',
          models: { main: 'p', haiku: 'p', sonnet: 'p', opus: 'p' },
        }],
        providerOrder: ['primary-only', 'claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).not.toContain('cc-haha -> ccmax')
    const primary = JSON.parse(await fs.readFile(path.join(ccmaxDir, 'providers.json'), 'utf-8')) as {
      activeId?: string
    }
    expect(primary.activeId).toBe('primary-only')
    expect(await pathExists(ccHahaDir)).toBe(true)
  })

  test('keeps the legacy cc-haha dir when verified copy into ccmax fails', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: null,
        providers: [],
        providerOrder: ['claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )

    // Make the config dir non-writable so the temp copy cannot be created.
    await fs.chmod(tempDir, 0o555)
    let report: { migratedEntries: string[]; failures: string[] }
    try {
      report = await ensurePersistentStorageUpgraded()
    } finally {
      await fs.chmod(tempDir, 0o755)
    }

    expect(report.migratedEntries).not.toContain('cc-haha -> ccmax')
    expect(report.failures.some((failure) => failure.startsWith('cc-haha -> ccmax:'))).toBe(true)
    expect(await pathExists(ccHahaDir)).toBe(true)
    expect(await pathExists(path.join(tempDir, 'ccmax'))).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(ccHahaDir, 'providers.json'), 'utf-8'))).toMatchObject({
      activeId: null,
      providers: [],
    })
  })

  test('migrates known sqlite families after json dir copy without removing legacy dbs', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    const dbDir = path.join(ccHahaDir, 'db')
    await fs.mkdir(dbDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: null,
        providers: [],
        providerOrder: ['claude-official', 'openai-official', 'grok-official'],
      }, null, 2),
      'utf-8',
    )
    for (const filename of [
      'index-v1.sqlite',
      'trace-index-v1.sqlite',
      'search-index-v1.sqlite',
      'scheduled-runs-v1.sqlite',
    ]) {
      await fs.writeFile(path.join(dbDir, filename), `legacy-${filename}`)
      await fs.writeFile(path.join(dbDir, `${filename}-wal`), `wal-${filename}`)
    }

    const report = await ensurePersistentStorageUpgraded()

    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('cc-haha -> ccmax')
    for (const filename of [
      'index-v1.sqlite',
      'trace-index-v1.sqlite',
      'search-index-v1.sqlite',
      'scheduled-runs-v1.sqlite',
    ]) {
      expect(report.migratedEntries).toContain(`db/${filename}`)
      expect(await fs.readFile(path.join(tempDir, 'ccmax', 'db', filename), 'utf-8'))
        .toBe(`legacy-${filename}`)
      expect(await fs.readFile(path.join(tempDir, 'ccmax', 'db', `${filename}-wal`), 'utf-8'))
        .toBe(`wal-${filename}`)
      // Stage 14 directory copy must not have been the only path for DB files —
      // legacy family remains for retry/fallback.
      expect(await fs.readFile(path.join(dbDir, filename), 'utf-8'))
        .toBe(`legacy-${filename}`)
    }
    // providers.json is copied by dir migration; db files are not present under
    // a partial primary that only got JSON (family migration writes them).
    expect(await pathExists(path.join(tempDir, 'ccmax', 'providers.json'))).toBe(true)
  })

  test('does not overwrite an existing primary sqlite main during storage upgrade', async () => {
    const ccHahaDir = path.join(tempDir, 'cc-haha')
    const ccmaxDir = path.join(tempDir, 'ccmax')
    await fs.mkdir(path.join(ccHahaDir, 'db'), { recursive: true })
    await fs.mkdir(path.join(ccmaxDir, 'db'), { recursive: true })
    await fs.writeFile(path.join(ccHahaDir, 'db', 'index-v1.sqlite'), 'legacy-main')
    await fs.writeFile(path.join(ccmaxDir, 'db', 'index-v1.sqlite'), 'primary-main')

    const report = await ensurePersistentStorageUpgraded()

    expect(report.migratedEntries).not.toContain('db/index-v1.sqlite')
    expect(await fs.readFile(path.join(ccmaxDir, 'db', 'index-v1.sqlite'), 'utf-8'))
      .toBe('primary-main')
    expect(await fs.readFile(path.join(ccHahaDir, 'db', 'index-v1.sqlite'), 'utf-8'))
      .toBe('legacy-main')
  })
})

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}
