import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { updateSettingsNavigationPreferences, updateSkillMarketPreferences } = vi.hoisted(() => ({
  updateSettingsNavigationPreferences: vi.fn(),
  updateSkillMarketPreferences: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences: vi.fn(),
    updateSettingsNavigationPreferences,
    updateSkillMarketPreferences,
  },
}))

import { SystemSettings } from './SystemSettings'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  DEFAULT_SKILL_MARKET_PREFERENCES,
  useSettingsNavigationStore,
} from '../../stores/settingsNavigationStore'
import { resetSettingsNavigationStore } from '../../stores/settingsNavigationTestUtils'

describe('SystemSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    resetSettingsNavigationStore({ hydrated: true })
  })

  it('lists the optional settings menus and the sidebar market as off by default', () => {
    render(<SystemSettings />)

    expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'H5 Access' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Terminal' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'IM Adapters' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Pets' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Trace' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Diagnostics' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'About' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Skills Market' })).not.toBeChecked()
    expect(screen.getByLabelText('Skills Market URL')).toHaveValue('')
    expect(screen.queryByRole('switch', { name: 'System' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Skills' })).not.toBeInTheDocument()
  })

  it('turns a hidden menu back on and persists the change', async () => {
    updateSettingsNavigationPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        settingsNavigation: {
          ...DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
          trace: true,
        },
      },
    })

    render(<SystemSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Trace' }))

    await waitFor(() => {
      expect(updateSettingsNavigationPreferences).toHaveBeenCalledWith({ trace: true })
    })
    expect(useSettingsNavigationStore.getState().preferences.trace).toBe(true)
    expect(screen.getByRole('switch', { name: 'Trace' })).toBeChecked()
  })

  it('persists the sidebar market toggle and URL', async () => {
    updateSkillMarketPreferences
      .mockResolvedValueOnce({
        ok: true,
        preferences: {
          skillMarket: {
            ...DEFAULT_SKILL_MARKET_PREFERENCES,
            visible: true,
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        preferences: {
          skillMarket: {
            visible: true,
            url: 'https://market.example/skills',
          },
        },
      })

    render(<SystemSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Skills Market' }))

    await waitFor(() => {
      expect(updateSkillMarketPreferences).toHaveBeenCalledWith({ visible: true })
    })
    expect(useSettingsNavigationStore.getState().skillMarket.visible).toBe(true)

    const urlField = screen.getByLabelText('Skills Market URL')
    fireEvent.change(urlField, { target: { value: 'https://market.example/skills' } })
    fireEvent.blur(urlField)

    await waitFor(() => {
      expect(updateSkillMarketPreferences).toHaveBeenLastCalledWith({ url: 'https://market.example/skills' })
    })
    expect(useSettingsNavigationStore.getState().skillMarket.url).toBe('https://market.example/skills')
  })

  it('shows a URL error without saving an unsafe market address', async () => {
    render(<SystemSettings />)
    const urlField = screen.getByLabelText('Skills Market URL')
    fireEvent.change(urlField, { target: { value: 'javascript:alert(1)' } })
    fireEvent.blur(urlField)

    expect(await screen.findByText('Enter a valid http or https URL.')).toBeInTheDocument()
    expect(updateSkillMarketPreferences).not.toHaveBeenCalled()
    expect(useSettingsNavigationStore.getState().skillMarket.url).toBe('')
  })

  it('shows a save error and restores the previous switch state when persistence fails', async () => {
    updateSettingsNavigationPreferences.mockRejectedValue(new Error('write failed'))

    render(<SystemSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Diagnostics' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save these System settings.')
    expect(screen.getByRole('switch', { name: 'Diagnostics' })).not.toBeChecked()
    expect(useSettingsNavigationStore.getState().preferences.diagnostics).toBe(false)
  })
})