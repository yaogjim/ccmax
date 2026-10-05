import { describe, expect, it } from 'bun:test'
import { sanitizeTelegramError } from '../sanitize-error.js'

describe('sanitizeTelegramError', () => {
  it('redacts bot tokens from messages and api paths', () => {
    const token = '123456:AAHsecret-token-value'
    const sanitized = sanitizeTelegramError(new Error(
      `Failed to fetch https://api.telegram.org/bot${token}/getMe for ${token}`,
    ))
    expect(sanitized).not.toContain(token)
    expect(sanitized).not.toContain('AAHsecret-token-value')
    expect(sanitized).toContain('[redacted]')
  })

  it('redacts nested grammY error payloads', () => {
    const token = '999111:public-secret-token'
    const sanitized = sanitizeTelegramError({
      error: new Error(`Call to /bot${token}/getUpdates failed`),
      message: token,
    })
    expect(sanitized).not.toContain(token)
    expect(sanitized).not.toContain('public-secret-token')
  })

  it('redacts bearer and access-token query values', () => {
    const sanitized = sanitizeTelegramError(new Error(
      'Authorization Bearer fixture-local-token failed for ?access_token=abc&token=zzz',
    ))
    expect(sanitized).not.toContain('fixture-local-token')
    expect(sanitized).not.toContain('access_token=abc')
    expect(sanitized).toContain('Bearer [redacted]')
  })
})