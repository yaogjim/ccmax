import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Market } from './Market'
import { useSettingsStore } from '../stores/settingsStore'
import { resetSettingsNavigationStore } from '../stores/settingsNavigationTestUtils'

vi.mock('../components/market/MarketHome', () => ({
  MarketHome: () => <div data-testid="built-in-market" />,
}))

vi.mock('../components/market/MarketSkillDetail', () => ({
  MarketSkillDetail: () => <div data-testid="market-detail" />,
}))

describe('Market', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    resetSettingsNavigationStore({ hydrated: true })
  })

  it('renders the built-in market when no custom URL is configured', () => {
    render(<Market />)

    expect(screen.getByTestId('built-in-market')).toBeInTheDocument()
    expect(screen.queryByTitle('Skills Market')).not.toBeInTheDocument()
  })

  it('renders the configured market URL instead of the built-in catalog', () => {
    resetSettingsNavigationStore({
      skillMarket: { visible: true, url: 'https://market.example/skills' },
      hydrated: true,
    })

    render(<Market />)

    const frame = screen.getByTitle('Skills Market')
    expect(frame).toHaveAttribute('src', 'https://market.example/skills')
    expect(screen.queryByTestId('built-in-market')).not.toBeInTheDocument()
  })
})