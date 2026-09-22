import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MarketDisclaimer } from './MarketDisclaimer'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY,
  MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY,
} from '../../lib/persistenceKeys'

const STORAGE_KEY = MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
})

describe('MarketDisclaimer', () => {
  it('renders the disclaimer with the AI-scan advice', () => {
    render(<MarketDisclaimer />)

    expect(screen.getByTestId('market-disclaimer')).toBeInTheDocument()
    expect(screen.getByText('Use third-party skills with care.')).toBeInTheDocument()
    expect(screen.getByText(/have AI scan them for safety first/)).toBeInTheDocument()
  })

  it('dismisses on click and persists the dismissal on the canonical key only', () => {
    localStorage.setItem(LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY, '0')
    render(<MarketDisclaimer />)

    fireEvent.click(screen.getByLabelText('Dismiss disclaimer'))

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
    expect(localStorage.getItem(LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY)).toBe('0')
  })

  it('stays hidden when previously dismissed on the canonical key', () => {
    localStorage.setItem(STORAGE_KEY, '1')

    render(<MarketDisclaimer />)

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
  })

  it('stays hidden when only the legacy key marks the disclaimer dismissed', () => {
    localStorage.setItem(LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY, '1')

    render(<MarketDisclaimer />)

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
  })

  it('prefers the canonical dismissal value over a conflicting legacy value', () => {
    localStorage.setItem(STORAGE_KEY, '1')
    localStorage.setItem(LEGACY_MARKET_DISCLAIMER_DISMISSED_STORAGE_KEY, '0')

    render(<MarketDisclaimer />)

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
  })
})