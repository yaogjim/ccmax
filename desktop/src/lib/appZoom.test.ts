import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  applyAppZoomLevel,
  getAppZoomKeyboardAction,
  initializeAppZoom,
  nextAppZoomLevel,
  normalizeAppZoomLevel,
} from './appZoom'
import { LEGACY_APP_ZOOM_STORAGE_KEY } from './persistenceKeys'
import { browserHost } from './desktopHost/browserHost'

describe('appZoom', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-mode')
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('normalizes, clamps, and steps app zoom levels', () => {
    expect(normalizeAppZoomLevel('1.25')).toBe(1.25)
    expect(normalizeAppZoomLevel('bad')).toBe(1)
    expect(normalizeAppZoomLevel(4)).toBe(2)
    expect(normalizeAppZoomLevel(0.1)).toBe(0.5)

    expect(nextAppZoomLevel(1, 'in')).toBe(1.1)
    expect(nextAppZoomLevel(1, 'out')).toBe(0.9)
    expect(nextAppZoomLevel(1.7, 'reset')).toBe(1)
  })

  it('applies browser fallback zoom and preserves valid persisted zoom', async () => {
    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, '1.2')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-mode')).toBe('css')
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('120')
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe('1.2')
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.2')
  })

  it('reads the legacy app-zoom key when the canonical key is absent', async () => {
    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.35')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('135')
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBeNull()
  })

  it('reads the legacy UI zoom key when both newer keys are absent', async () => {
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.25')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('125')
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBeNull()
  })

  it('prefers the canonical key when legacy zoom keys also exist', async () => {
    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, '1.1')
    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.5')
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.8')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('110')
  })

  it('persists app zoom changes only to the canonical key', async () => {
    window.localStorage.setItem(LEGACY_APP_ZOOM_STORAGE_KEY, '1.0')
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.0')

    await applyAppZoomLevel(1.3)

    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.3')
    expect(window.localStorage.getItem(LEGACY_APP_ZOOM_STORAGE_KEY)).toBe('1.0')
    expect(window.localStorage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)).toBe('1.0')
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe('1.3')
  })

  it('uses injected desktop host native zoom when available', async () => {
    const setZoom = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        zoom: true,
      },
      zoom: {
        set: setZoom,
      },
    }

    await applyAppZoomLevel(1.4)

    expect(setZoom).toHaveBeenCalledWith(1.4)
    expect(document.documentElement.getAttribute('data-app-zoom-mode')).toBe('native')
    expect(document.body.style.zoom).toBe('')
  })

  it('maps IDE-style zoom shortcuts by platform', () => {
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Equal',
      ctrlKey: false,
      key: '=',
      metaKey: true,
    } as KeyboardEvent, 'MacIntel')).toBe('in')
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Minus',
      ctrlKey: true,
      key: '-',
      metaKey: false,
    } as KeyboardEvent, 'Win32')).toBe('out')
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Numpad0',
      ctrlKey: true,
      key: '0',
      metaKey: false,
    } as KeyboardEvent, 'Linux x86_64')).toBe('reset')
    expect(getAppZoomKeyboardAction({
      altKey: true,
      code: 'Equal',
      ctrlKey: true,
      key: '=',
      metaKey: false,
    } as KeyboardEvent, 'Win32')).toBeNull()
  })
})