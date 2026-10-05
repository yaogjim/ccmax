import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TelegramPublicSettings } from './TelegramPublicSettings'
import { useAdapterStore } from '../stores/adapterStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { AdapterFileConfig } from '../types/adapter'
import { en } from '../i18n/locales/en'
import { zh } from '../i18n/locales/zh'
import { zh as zhTW } from '../i18n/locales/zh-TW'
import { jp } from '../i18n/locales/jp'
import { kr } from '../i18n/locales/kr'

const PUBLIC_I18N_KEYS = Object.keys(en).filter((key) =>
  key.startsWith('settings.adapters.telegramPublic.'),
)

const mocks = vi.hoisted(() => ({
  getTelegramPublicStatus: vi.fn(),
  generateTelegramPublicPairing: vi.fn(),
  resetTelegramPublicPairing: vi.fn(),
  addTelegramPublicSubscription: vi.fn(),
  removeTelegramPublicSubscription: vi.fn(),
}))

vi.mock('@/api/adapters', () => ({
  adaptersApi: mocks,
}))

function renderPublicSettings(
  config: AdapterFileConfig,
  overrides: Partial<ReturnType<typeof useAdapterStore.getState>> = {},
) {
  const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
  const fetchConfig = vi.fn(async () => {})
  const generatePairingCode = vi.fn(async () => 'LEGACY')
  useSettingsStore.setState({ locale: 'en' })
  useAdapterStore.setState({
    config,
    isLoading: false,
    fetchConfig,
    updateConfig,
    generatePairingCode,
    ...overrides,
  } as Partial<ReturnType<typeof useAdapterStore.getState>>)
  render(<TelegramPublicSettings />)
  return { updateConfig, fetchConfig, generatePairingCode }
}

beforeEach(() => {
  mocks.getTelegramPublicStatus.mockReset()
  mocks.generateTelegramPublicPairing.mockReset()
  mocks.resetTelegramPublicPairing.mockReset()
  mocks.addTelegramPublicSubscription.mockReset()
  mocks.removeTelegramPublicSubscription.mockReset()
  mocks.getTelegramPublicStatus.mockResolvedValue({
    generation: 1,
    running: false,
    subscriptions: [],
    deliveries: [],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAdapterStore.setState(useAdapterStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('TelegramPublicSettings', () => {
  it('defaults public Bot off with no owner and does not claim it is running', () => {
    renderPublicSettings({})

    expect(screen.getByRole('switch', { name: 'Enable public Bot' })).not.toBeChecked()
    expect(screen.getByText('No operator bound')).toBeInTheDocument()
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled()
    expect(mocks.getTelegramPublicStatus).not.toHaveBeenCalled()
  })

  it('does not treat a status botId as connected when no operator is bound', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 99,
      running: true,
      generation: 4,
      subscriptions: [{ sessionId: 'sess-1', shortId: 'S1', title: 'Hidden', project: '/tmp' }],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: { public: { enabled: true, botToken: '****oken' } },
    })

    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalled())
    expect(screen.getByText('No operator bound')).toBeInTheDocument()
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
    expect(screen.queryByText('Bot ID 99')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled()
  })

  it('does not show connected when a botId is present but running is false', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 7,
      running: false,
      generation: 2,
      subscriptions: [],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalled())
    expect(screen.getByText('Public Bot runtime is not confirmed')).toBeInTheDocument()
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
  })

  it('does not show connected when saved config has no generation', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 7,
      running: true,
      subscriptions: [],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42 },
      },
    })

    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalled())
    expect(screen.getByRole('status')).toHaveTextContent('Public Bot runtime is not confirmed')
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
  })

  it('does not treat an unsaved enable toggle as running', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 7,
      running: true,
      generation: 2,
      subscriptions: [],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: false, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    expect(mocks.getTelegramPublicStatus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable public Bot' }))
    expect(screen.getByRole('switch', { name: 'Enable public Bot' })).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Public Bot runtime is not confirmed')
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
    expect(mocks.getTelegramPublicStatus).not.toHaveBeenCalled()
  })

  it('does not show connected when runtime generation does not match config', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 7,
      running: true,
      generation: 9,
      subscriptions: [],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalled())
    expect(screen.getByText('Public Bot runtime is not confirmed')).toBeInTheDocument()
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
  })

  it('saves only public editable fields and keeps a masked dedicated token out of the payload', async () => {
    const { updateConfig } = renderPublicSettings({
      telegram: {
        botToken: '****eded',
        allowedUsers: [111],
        public: {
          enabled: true,
          botToken: '****oken',
          ownerUserId: 42,
          generation: 3,
          pairing: { code: '******', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
        },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save public Bot' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    const patch = updateConfig.mock.calls[0]![0]
    expect(patch).toEqual({
      telegram: {
        public: {
          enabled: true,
          botToken: '****oken',
        },
      },
    })
    expect(JSON.stringify(patch)).not.toContain('ownerUserId')
    expect(JSON.stringify(patch)).not.toContain('generation')
    expect(JSON.stringify(patch)).not.toContain('pairing')
    expect(patch.telegram).not.toHaveProperty('botToken')
    expect(patch.telegram).not.toHaveProperty('allowedUsers')
  })

  it('generates a public pairing code without the legacy pairing endpoint', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.generateTelegramPublicPairing.mockResolvedValue({
      code: 'ABC234',
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
    })
    const { updateConfig, fetchConfig, generatePairingCode } = renderPublicSettings({
      telegram: { public: { enabled: true, botToken: '****oken' } },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate public pairing code' }))

    await waitFor(() => expect(mocks.generateTelegramPublicPairing).toHaveBeenCalledTimes(1))
    expect(screen.getByText('ABC234')).toBeInTheDocument()
    expect(generatePairingCode).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(fetchConfig).toHaveBeenCalled()

    fetchConfig.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(fetchConfig.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('polls fetchConfig while public pairing is active and stops after an operator binds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fetchConfig = vi.fn(async () => {})
    renderPublicSettings(
      {
        telegram: {
          public: {
            enabled: true,
            botToken: '****oken',
            pairing: { code: '******', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
          },
        },
      },
      { fetchConfig },
    )

    fetchConfig.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(fetchConfig.mock.calls.length).toBeGreaterThanOrEqual(1)

    act(() => {
      useAdapterStore.setState({
        config: {
          telegram: {
            public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 1 },
          },
        },
      })
    })

    fetchConfig.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(fetchConfig).not.toHaveBeenCalled()
  })

  it('stops pairing poll on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fetchConfig = vi.fn(async () => {})
    renderPublicSettings(
      {
        telegram: {
          public: {
            enabled: true,
            botToken: '****oken',
            pairing: { code: '******', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
          },
        },
      },
      { fetchConfig },
    )

    cleanup()
    fetchConfig.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(fetchConfig).not.toHaveBeenCalled()
  })

  it('requires confirmation before reset and then refreshes config and status', async () => {
    const { fetchConfig } = renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })
    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Reset operator' }))
    expect(mocks.resetTelegramPublicPairing).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/does not clear the token/i)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset operator' }))

    await waitFor(() => expect(mocks.resetTelegramPublicPairing).toHaveBeenCalledTimes(1))
    expect(fetchConfig).toHaveBeenCalled()
    await waitFor(() => expect(mocks.getTelegramPublicStatus.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('keeps Subscribe disabled until an operator is bound', async () => {
    renderPublicSettings({
      telegram: { public: { enabled: true, botToken: '****oken' } },
    })

    await waitFor(() => expect(mocks.getTelegramPublicStatus).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Full sessionId'), { target: { value: 'sess-new' } })
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(mocks.addTelegramPublicSubscription).not.toHaveBeenCalled()
  })

  it('adds and removes subscriptions by full sessionId', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      botId: 7,
      running: true,
      generation: 2,
      subscriptions: [
        { sessionId: 'sess-1', shortId: 'S7K2', title: 'Fix login', project: '/tmp/app' },
      ],
      deliveries: [],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    await screen.findByText('Fix login')
    expect(screen.getByText('Public Bot is running')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Full sessionId'), { target: { value: 'sess-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    await waitFor(() => expect(mocks.addTelegramPublicSubscription).toHaveBeenCalledWith('sess-new'))

    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    await waitFor(() => expect(mocks.removeTelegramPublicSubscription).toHaveBeenCalledWith('sess-1'))
  })

  it('shows failed and indeterminate deliveries without inventing a connected state', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      running: false,
      generation: 2,
      subscriptions: [],
      deliveries: [
        { id: 'd-fail', status: 'failed', error: 'HTTP 400' },
        { id: 'd-unknown', status: 'indeterminate' },
        { id: 'd-ok', status: 'delivered' },
      ],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    await screen.findByText('HTTP 400')
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Indeterminate')).toBeInTheDocument()
    expect(screen.getByText('d-unknown')).toBeInTheDocument()
    expect(screen.queryByText('d-ok')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Bot is running')).not.toBeInTheDocument()
    expect(screen.getByText('Public Bot runtime is not confirmed')).toBeInTheDocument()
  })

  it('does not present queued or pending deliveries as delivered or as issues', async () => {
    mocks.getTelegramPublicStatus.mockResolvedValue({
      running: true,
      generation: 2,
      subscriptions: [],
      deliveries: [
        { id: 'd-queued', status: 'queued' },
        { id: 'd-pending', status: 'pending' },
        { id: 'd-ok', status: 'delivered' },
      ],
    })
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    await screen.findByText('Public Bot is running')
    expect(screen.getByText('No failed or indeterminate deliveries')).toBeInTheDocument()
    expect(screen.queryByText('d-queued')).not.toBeInTheDocument()
    expect(screen.queryByText('d-pending')).not.toBeInTheDocument()
    expect(screen.queryByText('d-ok')).not.toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('names controls and announces runtime status without duplicating it on the dot', () => {
    renderPublicSettings({})

    expect(screen.getByRole('region', { name: 'Public Bot' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Public Bot' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable public Bot' })).toBeInTheDocument()
    expect(screen.getByLabelText('Public Bot Token')).toBeInTheDocument()
    expect(screen.getByLabelText('Full sessionId')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save public Bot' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No operator bound')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('keeps public Bot copy in all five locales including interpolations', () => {
    const locales: Record<string, Record<string, string>> = { en, zh, 'zh-TW': zhTW, jp, kr }
    expect(PUBLIC_I18N_KEYS.length).toBeGreaterThan(0)
    for (const [name, locale] of Object.entries(locales)) {
      for (const key of PUBLIC_I18N_KEYS) {
        const value = locale[key]
        expect(value, `${name} missing ${key}`).toEqual(expect.any(String))
        expect(value, `${name} left ${key} untranslated`).not.toBe(key)
      }
      expect(locale['settings.adapters.telegramPublic.generation']).toContain('{generation}')
      expect(locale['settings.adapters.telegramPublic.botId']).toContain('{botId}')
      expect(locale['settings.adapters.telegramPublic.pairingActive']).toContain('{minutes}')
    }
  })

  it('surfaces pairing failures as an alert', async () => {
    mocks.generateTelegramPublicPairing.mockRejectedValue(new Error('pairing unavailable'))
    renderPublicSettings({
      telegram: { public: { enabled: true, botToken: '****oken' } },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate public pairing code' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('pairing unavailable')
  })

  it('surfaces save, subscribe, unsubscribe and reset failures as alerts', async () => {
    const updateConfig = vi.fn(async () => {
      throw new Error('disk full')
    })
    mocks.addTelegramPublicSubscription.mockRejectedValue(new Error('session missing'))
    mocks.removeTelegramPublicSubscription.mockRejectedValue(new Error('unsubscribe refused'))
    mocks.resetTelegramPublicPairing.mockRejectedValue(new Error('reset refused'))
    mocks.getTelegramPublicStatus.mockResolvedValue({
      running: true,
      generation: 2,
      subscriptions: [
        { sessionId: 'sess-1', shortId: 'S7K2', title: 'Fix login', project: '/tmp/app' },
      ],
      deliveries: [],
    })
    renderPublicSettings(
      {
        telegram: {
          public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
        },
      },
      { updateConfig },
    )
    await screen.findByText('Fix login')

    fireEvent.click(screen.getByRole('button', { name: 'Save public Bot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')

    fireEvent.change(screen.getByLabelText('Full sessionId'), { target: { value: 'sess-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('session missing')

    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unsubscribe refused')

    fireEvent.click(screen.getByRole('button', { name: 'Reset operator' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset operator' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('reset refused')
  })

  it('surfaces runtime status failures with retry', async () => {
    mocks.getTelegramPublicStatus.mockRejectedValue(new Error('status 503'))
    renderPublicSettings({
      telegram: {
        public: { enabled: true, botToken: '****oken', ownerUserId: 42, generation: 2 },
      },
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not read public Bot runtime status')
    expect(alert).toHaveTextContent('status 503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.getTelegramPublicStatus.mock.calls.length).toBeGreaterThanOrEqual(2))
  })
})