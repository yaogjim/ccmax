import { beforeEach, describe, expect, test } from 'vitest'
import {
  APP_ZOOM_STORAGE_KEY,
  DESKTOP_PERSISTENCE_KEYS,
  LEGACY_APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  SESSION_RUNTIME_STORAGE_KEY,
  TAB_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from './persistenceKeys'
import {
  CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  runDesktopPersistenceMigrations,
} from './persistenceMigrations'
import { WORKSPACE_STORAGE_VERSION } from './workspace/storageKey'
import { CHAT_APPEARANCE_STORAGE_KEY, DEFAULT_CHAT_APPEARANCE, LEGACY_CHAT_APPEARANCE_STORAGE_KEY } from './chatAppearance'

const LEGACY_TAB = DESKTOP_PERSISTENCE_KEYS.openTabs.legacy
const LEGACY_RUNTIME = DESKTOP_PERSISTENCE_KEYS.sessionRuntime.legacy
const LEGACY_THEME = DESKTOP_PERSISTENCE_KEYS.theme.legacy
const LEGACY_FOLLOW = DESKTOP_PERSISTENCE_KEYS.followSystemTheme.legacy
const LEGACY_LIGHT = DESKTOP_PERSISTENCE_KEYS.lightTheme.legacy
const LEGACY_DARK = DESKTOP_PERSISTENCE_KEYS.darkTheme.legacy
const LEGACY_LOCALE = DESKTOP_PERSISTENCE_KEYS.locale.legacy

describe('desktop persistence migrations', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('upgrades a frozen schema-4 install with reading defaults without changing zoom or theme', () => {
    localStorage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, '4')
    localStorage.setItem('cc-haha-app-zoom', '1.25')
    localStorage.setItem('cc-haha-theme', 'ink-blue')
    localStorage.setItem('unrelated-user-key', 'keep')
    runDesktopPersistenceMigrations()
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toEqual({ version: 1, ...DEFAULT_CHAT_APPEARANCE })
    expect(localStorage.getItem('cc-haha-app-zoom')).toBe('1.25')
    expect(localStorage.getItem('cc-haha-theme')).toBe('ink-blue')
    expect(localStorage.getItem('unrelated-user-key')).toBe('keep')
    expect(runDesktopPersistenceMigrations().migratedKeys).not.toContain(CHAT_APPEARANCE_STORAGE_KEY)
  })

  test('normalizes unversioned reading preferences and preserves a future schema', () => {
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ font: 'serif', fontSize: 80, extra: true }))
    runDesktopPersistenceMigrations()
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toEqual({ version: 1, font: 'serif', fontSize: 24, width: 'standard', extra: true })
    const future = '{"version":2,"font":"future","extra":true}'
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, future)
    runDesktopPersistenceMigrations()
    expect(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)).toBe(future)
  })

  test('copies a legacy chat-appearance install into the canonical ccmax key and normalizes it', () => {
    // A cc-haha install carries the legacy key only. Startup must move it to
    // the ccmax canonical key without dropping the legacy copy.
    localStorage.setItem(LEGACY_CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ font: 'mono', fontSize: 80 }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toEqual({
      version: 1,
      font: 'mono',
      fontSize: 24,
      width: 'standard',
    })
    expect(localStorage.getItem(LEGACY_CHAT_APPEARANCE_STORAGE_KEY)).not.toBeNull()
  })

  test('prefers the canonical chat-appearance key when the legacy key also exists', () => {
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, font: 'serif', fontSize: 16, width: 'wide' }))
    localStorage.setItem(LEGACY_CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, font: 'mono', fontSize: 20, width: 'full' }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toEqual({
      version: 1,
      font: 'serif',
      fontSize: 16,
      width: 'wide',
    })
  })

  test('old fixture: copies legacy open-tabs into canonical shape without removing legacy', () => {
    window.localStorage.setItem(LEGACY_TAB, JSON.stringify([
      { sessionId: 'session-1', title: 'Old tab' },
      { sessionId: '__terminal__legacy', title: 'Terminal 1', type: 'terminal' },
      { sessionId: 123, title: 'bad' },
    ]))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(TAB_STORAGE_KEY)
    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY) || '{}')).toEqual({
      openTabs: [{ sessionId: 'session-1', title: 'Old tab', type: 'session' }],
      activeTabId: 'session-1',
    })
    // Legacy key retains the pre-migration payload.
    expect(JSON.parse(window.localStorage.getItem(LEGACY_TAB) || 'null')).toEqual([
      { sessionId: 'session-1', title: 'Old tab' },
      { sessionId: '__terminal__legacy', title: 'Terminal 1', type: 'terminal' },
      { sessionId: 123, title: 'bad' },
    ])
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
    expect(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION).toBe(5)
  })

  test('does not overwrite an existing canonical key when legacy also exists', () => {
    window.localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({
      openTabs: [{ sessionId: 'canonical', title: 'Keep me', type: 'session' }],
      activeTabId: 'canonical',
    }))
    window.localStorage.setItem(LEGACY_TAB, JSON.stringify({
      openTabs: [{ sessionId: 'legacy', title: 'Ignore me', type: 'session' }],
      activeTabId: 'legacy',
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY) || '{}')).toEqual({
      openTabs: [{ sessionId: 'canonical', title: 'Keep me', type: 'session' }],
      activeTabId: 'canonical',
    })
    expect(JSON.parse(window.localStorage.getItem(LEGACY_TAB) || '{}')).toEqual({
      openTabs: [{ sessionId: 'legacy', title: 'Ignore me', type: 'session' }],
      activeTabId: 'legacy',
    })
  })

  test('second migration run is idempotent for a legacy-only fixture', () => {
    window.localStorage.setItem(LEGACY_THEME, 'dark')
    runDesktopPersistenceMigrations()
    const afterFirst = {
      theme: window.localStorage.getItem(THEME_STORAGE_KEY),
      legacy: window.localStorage.getItem(LEGACY_THEME),
      schema: window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY),
    }

    const second = runDesktopPersistenceMigrations()

    expect(afterFirst.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(afterFirst.theme)
    expect(window.localStorage.getItem(LEGACY_THEME)).toBe(afterFirst.legacy)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(afterFirst.schema)
    expect(second.migratedKeys).not.toContain(THEME_STORAGE_KEY)
  })

  test.each([undefined, 'session', 'connectors'])('preserves connector identities from legacy startup fixtures with type %s', (type) => {
    window.localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: 'session-1', title: 'Task' },
        { sessionId: '__connectors__', title: 'Connectors', ...(type ? { type } : {}) },
      ],
      activeTabId: '__connectors__',
    }))
    runDesktopPersistenceMigrations()
    const expected = {
      openTabs: [
        { sessionId: 'session-1', title: 'Task', type: 'session' },
        { sessionId: '__market__', title: 'Connectors', type: 'market' },
      ],
      activeTabId: '__market__',
    }
    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY)!)).toEqual(expected)
    runDesktopPersistenceMigrations()
    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY)!)).toEqual(expected)
  })

  test('preserves persisted market tabs during startup migration', () => {
    window.localStorage.setItem(LEGACY_TAB, JSON.stringify({
      openTabs: [
        { sessionId: '__market__', title: 'Market', type: 'market' },
        { sessionId: '__traces__', title: 'Traces', type: 'traces' },
      ],
      activeTabId: '__market__',
    }))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(TAB_STORAGE_KEY)
    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY) || '{}')).toEqual({
      openTabs: [
        { sessionId: '__market__', title: 'Market', type: 'market' },
        { sessionId: '__traces__', title: 'Traces', type: 'traces' },
      ],
      activeTabId: '__market__',
    })
    expect(window.localStorage.getItem(LEGACY_TAB)).not.toBeNull()
  })

  test('canonicalizes mismatched persisted special tab ids and types during startup migration', () => {
    window.localStorage.setItem(LEGACY_TAB, JSON.stringify({
      openTabs: [
        { sessionId: '__settings__', title: 'Settings', type: 'market' },
        { sessionId: '__market__', title: 'Skills', type: 'settings' },
      ],
      activeTabId: '__settings__',
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem(TAB_STORAGE_KEY) || '{}')).toEqual({
      openTabs: [
        { sessionId: '__settings__', title: 'Settings', type: 'settings' },
        { sessionId: '__market__', title: 'Skills', type: 'market' },
      ],
      activeTabId: '__settings__',
    })
  })

  test('filters stale session runtime selections without clearing unrelated keys', () => {
    window.localStorage.setItem('unrelated-user-key', 'keep')
    window.localStorage.setItem(LEGACY_RUNTIME, JSON.stringify({
      good: { providerId: null, modelId: 'claude-sonnet' },
      alsoGood: { providerId: 'openai-official', modelId: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      bad: { providerId: 'provider-2' },
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem(SESSION_RUNTIME_STORAGE_KEY) || '{}')).toEqual({
      alsoGood: { providerId: 'openai-official', modelId: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      good: { providerId: null, modelId: 'claude-sonnet' },
    })
    expect(window.localStorage.getItem(LEGACY_RUNTIME)).not.toBeNull()
    expect(window.localStorage.getItem('unrelated-user-key')).toBe('keep')
  })

  test('removes malformed known keys without throwing during startup', () => {
    window.localStorage.setItem(LEGACY_TAB, '{"openTabs":')
    window.localStorage.setItem(LEGACY_THEME, 'sepia')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(TAB_STORAGE_KEY)
    expect(report.migratedKeys).toContain(THEME_STORAGE_KEY)
    expect(window.localStorage.getItem(TAB_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    // Legacy keys are retained even when their values are invalid.
    expect(window.localStorage.getItem(LEGACY_TAB)).toBe('{"openTabs":')
    expect(window.localStorage.getItem(LEGACY_THEME)).toBe('sepia')
  })

  test('preserves the pure white theme as a valid persisted theme', () => {
    window.localStorage.setItem(LEGACY_THEME, 'white')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).not.toContain(THEME_STORAGE_KEY)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('white')
    expect(window.localStorage.getItem(LEGACY_THEME)).toBe('white')
  })

  test('renames the retired light theme to warm-classic instead of resetting it', () => {
    // `light` was the warm workspace, labelled 经典暖色 in the picker. Falling
    // through to the enum check would drop it and silently reset those
    // installs to pure white, which reads as the app forgetting the setting.
    window.localStorage.setItem(LEGACY_THEME, 'light')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(THEME_STORAGE_KEY)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('warm-classic')
    expect(window.localStorage.getItem(LEGACY_THEME)).toBe('light')
  })

  test('applies the same rename to the light half of follow-the-system', () => {
    // The preference holds a theme name too, so a rename that only reached the
    // applied theme would silently reset which palette daytime returns to.
    window.localStorage.setItem(LEGACY_LIGHT, 'light')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)).toBe('warm-classic')
    expect(window.localStorage.getItem(LEGACY_LIGHT)).toBe('light')
  })

  test('preserves every palette introduced by the redesign', () => {
    for (const theme of ['white', 'paper', 'warm-classic', 'celadon', 'dark', 'ink-blue']) {
      window.localStorage.clear()
      window.localStorage.setItem(LEGACY_THEME, theme)

      const report = runDesktopPersistenceMigrations()

      expect(report.migratedKeys, `${theme} should survive startup migration`).not.toContain(THEME_STORAGE_KEY)
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme)
      expect(window.localStorage.getItem(LEGACY_THEME)).toBe(theme)
    }
  })

  test('drops a malformed follow-the-system flag rather than reading it as opted in', () => {
    // Anything but 0/1 has to go: an unset flag is how a fresh install is
    // recognised, and a junk value would make that inference unpredictable.
    window.localStorage.setItem(LEGACY_FOLLOW, 'yes')
    // A dark palette is not a valid light half, and vice versa.
    window.localStorage.setItem(LEGACY_LIGHT, 'ink-blue')
    window.localStorage.setItem(LEGACY_DARK, 'celadon')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain(DESKTOP_PERSISTENCE_KEYS.followSystemTheme.canonical)
    expect(report.migratedKeys).toContain(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)
    expect(report.migratedKeys).toContain(DESKTOP_PERSISTENCE_KEYS.darkTheme.canonical)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.followSystemTheme.canonical)).toBeNull()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)).toBeNull()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.darkTheme.canonical)).toBeNull()
    expect(window.localStorage.getItem(LEGACY_FOLLOW)).toBe('yes')
    expect(window.localStorage.getItem(LEGACY_LIGHT)).toBe('ink-blue')
    expect(window.localStorage.getItem(LEGACY_DARK)).toBe('celadon')
  })

  test('preserves a valid follow-the-system flag and both ground preferences', () => {
    window.localStorage.setItem(LEGACY_FOLLOW, '1')
    window.localStorage.setItem(LEGACY_LIGHT, 'celadon')
    window.localStorage.setItem(LEGACY_DARK, 'ink-blue')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).not.toContain(DESKTOP_PERSISTENCE_KEYS.followSystemTheme.canonical)
    expect(report.migratedKeys).not.toContain(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)
    expect(report.migratedKeys).not.toContain(DESKTOP_PERSISTENCE_KEYS.darkTheme.canonical)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.followSystemTheme.canonical)).toBe('1')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.lightTheme.canonical)).toBe('celadon')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.darkTheme.canonical)).toBe('ink-blue')
  })

  test('preserves every supported locale during startup migration', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr']) {
      window.localStorage.clear()
      window.localStorage.setItem(LEGACY_LOCALE, locale)

      const report = runDesktopPersistenceMigrations()

      expect(report.migratedKeys).not.toContain(LOCALE_STORAGE_KEY)
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(locale)
      expect(window.localStorage.getItem(LEGACY_LOCALE)).toBe(locale)
    }
  })

  test('preserves valid app zoom and removes invalid app zoom values only on canonical', () => {
    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.2')

    const validReport = runDesktopPersistenceMigrations()

    expect(validReport.migratedKeys).not.toContain(APP_ZOOM_STORAGE_KEY)
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.2')
    expect(window.localStorage.getItem(LEGACY_APP_ZOOM_STORAGE_KEY)).toBe('1.2')

    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, '4')

    const invalidReport = runDesktopPersistenceMigrations()

    expect(invalidReport.migratedKeys).toContain(APP_ZOOM_STORAGE_KEY)
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBeNull()
    // Legacy zoom keys are never deleted by migration.
    expect(window.localStorage.getItem(LEGACY_APP_ZOOM_STORAGE_KEY)).toBe('1.2')
  })

  test('migrates the legacy UI zoom key into app zoom storage without deleting either old key', () => {
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.25')

    runDesktopPersistenceMigrations()

    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.25')
    expect(window.localStorage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)).toBe('1.25')
    expect(window.localStorage.getItem(LEGACY_APP_ZOOM_STORAGE_KEY)).toBeNull()
  })

  test('does not throw if schema version persistence is blocked', () => {
    const storage = {
      getItem: window.localStorage.getItem.bind(window.localStorage),
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: (key: string, value: string) => {
        if (key === DESKTOP_PERSISTENCE_VERSION_KEY) {
          throw new Error('storage blocked')
        }
        window.localStorage.setItem(key, value)
      },
    }

    expect(() => runDesktopPersistenceMigrations(storage)).not.toThrow()
    expect(runDesktopPersistenceMigrations(storage).migratedKeys).toContain(DESKTOP_PERSISTENCE_VERSION_KEY)
  })

  test('does not throw if storage reads and writes are blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      },
    }

    const report = runDesktopPersistenceMigrations(storage)

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      TAB_STORAGE_KEY,
      SESSION_RUNTIME_STORAGE_KEY,
      THEME_STORAGE_KEY,
      LOCALE_STORAGE_KEY,
      APP_ZOOM_STORAGE_KEY,
      DESKTOP_PERSISTENCE_VERSION_KEY,
    ]))
  })
  test('keeps a schema-1 install usable: no workspace key means nothing to migrate', () => {
    window.localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: 'session-1', title: 'Chat', type: 'session' }],
      activeTabId: 'session-1',
    }))
    window.localStorage.setItem('cc-haha-theme', 'ink-blue')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).not.toContain('cc-haha.workspace')
    expect(window.localStorage.getItem('cc-haha.workspace')).toBeNull()
    // The schema-1 keys a v0.6.2 install carries must survive untouched.
    expect(window.localStorage.getItem('cc-haha-theme')).toBe('ink-blue')
    expect(JSON.parse(window.localStorage.getItem('cc-haha-open-tabs')!).openTabs).toHaveLength(1)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('leaves a workspace entry written by a newer schema untouched', () => {
    const future = JSON.stringify({
      version: WORKSPACE_STORAGE_VERSION + 1,
      sessions: { s1: { tabs: [{ kind: 'file', id: 'f1', path: 'a.ts' }] } },
    })
    window.localStorage.setItem('cc-haha.workspace', future)

    const report = runDesktopPersistenceMigrations()

    // The hydrator already refuses an unknown version. Deleting it here would
    // mean a single downgrade launch permanently discards the workspace the
    // newer build is still using.
    expect(report.migratedKeys).not.toContain('cc-haha.workspace')
    expect(window.localStorage.getItem('cc-haha.workspace')).toBe(future)
  })

  test('upgrades workspace v1 without losing the Files launcher, turns, or unknown metadata', () => {
    window.localStorage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, '2')
    window.localStorage.setItem('cc-haha.workspace', JSON.stringify({
      version: 1,
      futureMetadata: { keep: true },
      sessions: {
        s1: {
          layout: 'full',
          activeSideTabId: 'files',
          futureSetting: 42,
          tabs: [
            { kind: 'file', id: 'files', path: '', preview: true },
            { kind: 'review', id: 'review', source: { kind: 'turn', turnKey: 'message-1' }, selectedPath: 'a.ts' },
          ],
        },
      },
    }))

    runDesktopPersistenceMigrations()
    const stored = JSON.parse(window.localStorage.getItem('cc-haha.workspace')!)
    expect(stored).toMatchObject({
      version: WORKSPACE_STORAGE_VERSION,
      futureMetadata: { keep: true },
      sessions: {
        s1: {
          layout: 'full',
          activeSideTabId: 'files',
          futureSetting: 42,
          tabs: [
            { id: 'files', path: '', preview: true },
            { id: 'review', source: { kind: 'turn', turnKey: 'message-1' }, viewedPaths: [] },
          ],
        },
      },
    })
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY))
      .toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
    const once = window.localStorage.getItem('cc-haha.workspace')
    runDesktopPersistenceMigrations()
    expect(window.localStorage.getItem('cc-haha.workspace')).toBe(once)
  })

  test('strips tab entries that name a host resource the previous run owned', () => {
    window.localStorage.setItem('cc-haha.workspace', JSON.stringify({
      version: 1,
      sideWidth: 860,
      bottomHeight: 420,
      sessions: {
        s1: {
          layout: 'split',
          bottomOpen: false,
          activeSideTabId: 'f1',
          activeBottomTabId: null,
          nextTerminalOrdinal: 2,
          tabs: [
            { kind: 'file', id: 'f1', preview: false, path: 'a.ts' },
            { kind: 'terminal', id: 't1', dock: 'side', cwd: '/repo', ordinal: 1, runtimeId: 'stale-pty' },
            { kind: 'browser', id: 'b1', preview: false, storageId: 'p1', restoreUrl: null, title: null, browserTabId: 'stale-view' },
          ],
        },
      },
    }))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('cc-haha.workspace')
    const stored = JSON.parse(window.localStorage.getItem('cc-haha.workspace')!)
    expect(stored.sessions.s1.tabs.map((tab: { id: string }) => tab.id)).toEqual(['f1'])
  })

  test('removes a corrupt workspace entry rather than throwing at startup', () => {
    window.localStorage.setItem('cc-haha.workspace', '{not json')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('cc-haha.workspace')
    expect(window.localStorage.getItem('cc-haha.workspace')).toBeNull()
  })

  test('merges legacy connector and skill market tabs while preserving the active market and unrelated user state', () => {
  localStorage.clear()
  localStorage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, '3')
  localStorage.setItem('custom-user-state', JSON.stringify({ selectedSkill: 'my-skill' }))
  localStorage.setItem('cc-haha-open-tabs', JSON.stringify({ openTabs: [
    { sessionId: 'session-1', title: 'Work', type: 'session' },
    { sessionId: '__market__', title: 'Skills', type: 'market' },
    { sessionId: '__connectors__', title: 'Connectors', type: 'connectors' },
  ], activeTabId: '__connectors__' }))
  runDesktopPersistenceMigrations()
  expect(JSON.parse(localStorage.getItem(TAB_STORAGE_KEY)!)).toEqual({ openTabs: [
    { sessionId: 'session-1', title: 'Work', type: 'session' },
    { sessionId: '__market__', title: 'Skills', type: 'market' },
  ], activeTabId: '__market__' })
  expect(JSON.parse(localStorage.getItem('custom-user-state')!)).toEqual({ selectedSkill: 'my-skill' })
})

  test('a single-key failure does not block remaining migration steps', () => {
    window.localStorage.setItem(LEGACY_THEME, 'dark')
    window.localStorage.setItem(LEGACY_LOCALE, 'jp')
    window.localStorage.setItem(LEGACY_TAB, JSON.stringify({
      openTabs: [{ sessionId: 's1', title: 'T', type: 'session' }],
      activeTabId: 's1',
    }))

    const storage = {
      getItem: (key: string) => {
        if (key === TAB_STORAGE_KEY) {
          throw new Error('tabs read blocked')
        }
        return window.localStorage.getItem(key)
      },
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: window.localStorage.setItem.bind(window.localStorage),
    }

    const report = runDesktopPersistenceMigrations(storage)

    expect(report.migratedKeys).toContain(TAB_STORAGE_KEY)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('jp')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('stage-19 remaining keys: copy missing, keep legacy, prefer canonical on conflict', () => {
    const stage19 = [
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrder,
      DESKTOP_PERSISTENCE_KEYS.sidebarPinnedProjects,
      DESKTOP_PERSISTENCE_KEYS.sidebarHiddenProjects,
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectOrganization,
      DESKTOP_PERSISTENCE_KEYS.sidebarProjectSort,
      DESKTOP_PERSISTENCE_KEYS.h5ServerUrl,
      DESKTOP_PERSISTENCE_KEYS.h5Token,
      DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion,
      DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed,
      DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns,
      DESKTOP_PERSISTENCE_KEYS.scheduledTaskNotificationScan,
    ] as const

    for (const pair of stage19) {
      window.localStorage.setItem(pair.legacy, `from-legacy:${pair.canonical}`)
    }
    // Conflict pair: canonical already present must win and not be overwritten.
    window.localStorage.setItem(DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed.canonical, '1')
    window.localStorage.setItem(DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed.legacy, '0')

    runDesktopPersistenceMigrations()

    for (const pair of stage19) {
      if (pair.canonical === DESKTOP_PERSISTENCE_KEYS.marketDisclaimerDismissed.canonical) {
        expect(window.localStorage.getItem(pair.canonical)).toBe('1')
        expect(window.localStorage.getItem(pair.legacy)).toBe('0')
        continue
      }
      expect(window.localStorage.getItem(pair.canonical)).toBe(`from-legacy:${pair.canonical}`)
      expect(window.localStorage.getItem(pair.legacy)).toBe(`from-legacy:${pair.canonical}`)
    }
    expect(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION).toBe(5)
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('stage-19 single-key copy failure is isolated from other remaining keys', () => {
    window.localStorage.setItem(DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.legacy, '1.2.3')
    window.localStorage.setItem(DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns.legacy, '["run-1"]')

    const storage = {
      getItem: (key: string) => {
        if (key === DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.canonical) {
          throw new Error('dismissed blocked')
        }
        return window.localStorage.getItem(key)
      },
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: (key: string, value: string) => {
        if (key === DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.canonical) {
          throw new Error('dismissed write blocked')
        }
        window.localStorage.setItem(key, value)
      },
    }

    expect(() => runDesktopPersistenceMigrations(storage)).not.toThrow()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.notifiedDesktopTaskRuns.canonical)).toBe('["run-1"]')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_KEYS.dismissedUpdateVersion.legacy)).toBe('1.2.3')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })
})
