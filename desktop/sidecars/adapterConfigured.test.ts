import { describe, expect, it } from 'vitest'
import { isTelegramAdapterConfigured } from './adapterConfigured'

describe('isTelegramAdapterConfigured', () => {
  it('starts when only the dedicated token is present', () => {
    expect(isTelegramAdapterConfigured({
      telegram: { botToken: '111:dedicated-token', public: { enabled: false, botToken: '' } },
    })).toBe(true)
  })

  it('starts when only public is enabled with a token', () => {
    expect(isTelegramAdapterConfigured({
      telegram: { botToken: '', public: { enabled: true, botToken: '222:public-token' } },
    })).toBe(true)
  })

  it('skips when public is enabled without a token and dedicated is empty', () => {
    expect(isTelegramAdapterConfigured({
      telegram: { botToken: '', public: { enabled: true, botToken: '' } },
    })).toBe(false)
  })

  it('skips when public has a token but is disabled and dedicated is empty', () => {
    expect(isTelegramAdapterConfigured({
      telegram: { botToken: '', public: { enabled: false, botToken: '222:public-token' } },
    })).toBe(false)
  })
})