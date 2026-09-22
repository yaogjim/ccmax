import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initializeLocale,
  resolveSupportedLocale,
  subscribeLocaleChanges,
} from './locale'

function mockBrowserLanguages(languages: string[], language = languages[0] ?? '') {
  vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language)
}

describe('locale detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    document.documentElement.lang = 'en'
  })

  it('normalizes BCP 47 tags and selects the first supported language', () => {
    expect(resolveSupportedLocale(['fr-FR', 'zh_Hant_HK', 'en-US'])).toBe('zh-TW')
    expect(resolveSupportedLocale(['zh-Hans-HK'])).toBe('zh')
  })

  it('defaults new users to Simplified Chinese instead of the system language', async () => {
    mockBrowserLanguages(['en-US'])
    const host = {
      getLocalePreference: vi.fn().mockResolvedValue(null),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['fr-FR', 'ko-KR']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    }

    await expect(initializeLocale(host)).resolves.toBe('zh')

    expect(host.getPreferredSystemLanguages).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('defaults to Simplified Chinese when the native lookup fails', async () => {
    mockBrowserLanguages(['ja-JP'])

    await expect(initializeLocale({
      getLocalePreference: () => Promise.reject(new Error('IPC unavailable')),
      getPreferredSystemLanguages: () => Promise.reject(new Error('IPC unavailable')),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    })).resolves.toBe('zh')

    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('migrates a stored main-window choice without consulting the system again', async () => {
    window.localStorage.setItem('cc-haha-locale', 'zh-TW')
    const host = {
      getLocalePreference: vi.fn().mockResolvedValue(null),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['en-US']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    }

    await expect(initializeLocale(host)).resolves.toBe('zh-TW')

    expect(host.setLocalePreference).toHaveBeenCalledWith('zh-TW')
    expect(host.getLocalePreference).not.toHaveBeenCalled()
    expect(host.getPreferredSystemLanguages).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe('zh-TW')
  })

  it('prefers the canonical locale key when legacy also exists', async () => {
    window.localStorage.setItem('ccmax-locale', 'jp')
    window.localStorage.setItem('cc-haha-locale', 'zh-TW')
    const host = {
      getLocalePreference: vi.fn().mockResolvedValue(null),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['en-US']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    }

    await expect(initializeLocale(host)).resolves.toBe('jp')
  })

  it('keeps a legacy stored English preference instead of defaulting back to Chinese', async () => {
    // The legacy key stays readable when the canonical one is absent, so an
    // install that picked English before the ccmax key existed keeps it.
    window.localStorage.setItem('cc-haha-locale', 'en')
    const host = {
      getLocalePreference: vi.fn().mockResolvedValue(null),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['zh-CN']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    }

    await expect(initializeLocale(host)).resolves.toBe('en')

    expect(host.setLocalePreference).toHaveBeenCalledWith('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('uses the app-level manual preference in an isolated companion partition', async () => {
    mockBrowserLanguages(['zh-CN'])

    await expect(initializeLocale({
      getLocalePreference: vi.fn().mockResolvedValue('jp'),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['zh-CN']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    })).resolves.toBe('jp')

    expect(document.documentElement.lang).toBe('ja')
  })

  it('applies app-level locale changes to an already running companion window', async () => {
    let onLocaleChanged: ((locale: 'kr') => void) | undefined
    const listener = vi.fn()
    const unsubscribe = subscribeLocaleChanges(listener)

    await initializeLocale({
      getLocalePreference: vi.fn().mockResolvedValue('en'),
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['en-US']),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn(async (handler) => {
        onLocaleChanged = handler
        return () => {}
      }),
    })

    onLocaleChanged?.('kr')

    expect(listener).toHaveBeenLastCalledWith('kr')
    expect(document.documentElement.lang).toBe('ko')
    unsubscribe()
  })

  it('defaults to Simplified Chinese when browser language lookup is unavailable', async () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockImplementation(() => {
      throw new Error('languages unavailable')
    })
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ja-JP')

    await expect(initializeLocale({
      getLocalePreference: vi.fn().mockResolvedValue(null),
      getPreferredSystemLanguages: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      setLocalePreference: vi.fn().mockResolvedValue(undefined),
      onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    })).resolves.toBe('zh')
  })
})
