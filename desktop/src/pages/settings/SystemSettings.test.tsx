import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { updateSettingsNavigationPreferences } = vi.hoisted(() => ({
  updateSettingsNavigationPreferences: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences: vi.fn(),
    updateSettingsNavigationPreferences,
  },
}))

import { SystemSettings } from './SystemSettings'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  DEFAULT_SETTINGS_NAVIGATION_PREFERENCES,
  useSettingsNavigationStore,
} from '../../stores/settingsNavigationStore'
import { resetSettingsNavigationStore } from '../../stores/settingsNavigationTestUtils'

describe('SystemSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    resetSettingsNavigationStore({ hydrated: true })
  })

  it('lists the six optional menus as off by default and keeps System itself off that list', () => {
    render(<SystemSettings />)

    expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Terminal' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'IM Adapters' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Pets' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Trace' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Diagnostics' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'About' })).not.toBeChecked()
    expect(screen.queryByRole('switch', { name: 'System' })).not.toBeInTheDocument()
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

  it('shows a save error and restores the previous switch state when persistence fails', async () => {
    updateSettingsNavigationPreferences.mockRejectedValue(new Error('write failed'))

    render(<SystemSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Diagnostics' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the Settings menu visibility.')
    expect(screen.getByRole('switch', { name: 'Diagnostics' })).not.toBeChecked()
    expect(useSettingsNavigationStore.getState().preferences.diagnostics).toBe(false)
  })
})