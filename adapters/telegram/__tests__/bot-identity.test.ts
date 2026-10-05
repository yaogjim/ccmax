import { describe, expect, it } from 'bun:test'
import {
  publicSharesDedicatedIdentity,
  resolveDedicatedIdentity,
  telegramBotIdFromToken,
} from '../bot-identity.js'

describe('telegramBotIdFromToken', () => {
  it('reads the numeric prefix and ignores the secret', () => {
    expect(telegramBotIdFromToken('111111:dedicated-secret-token')).toBe(111111)
    expect(telegramBotIdFromToken(' 222222:public-secret-token ')).toBe(222222)
  })

  it('does not invent an id for a malformed token', () => {
    expect(telegramBotIdFromToken('')).toBeUndefined()
    expect(telegramBotIdFromToken('not-a-token')).toBeUndefined()
    expect(telegramBotIdFromToken('0:secret')).toBeUndefined()
  })
})

describe('resolveDedicatedIdentity', () => {
  it('is absent when no dedicated token is configured', async () => {
    expect(await resolveDedicatedIdentity({
      token: '',
      getMe: async () => ({ id: 1 }),
    })).toEqual({ status: 'absent' })
  })

  it('prefers getMe when it succeeds', async () => {
    expect(await resolveDedicatedIdentity({
      token: '111111:dedicated-secret-token',
      getMe: async () => ({ id: 999001 }),
    })).toEqual({ status: 'known', botId: 999001 })
  })

  it('uses the token prefix when getMe fails instead of pretending dedicated is absent', async () => {
    expect(await resolveDedicatedIdentity({
      token: '111111:dedicated-secret-token',
      getMe: async () => {
        throw new Error('getMe failed for 111111:dedicated-secret-token')
      },
    })).toEqual({ status: 'known', botId: 111111 })
  })

  it('blocks public when dedicated cannot be verified', async () => {
    expect(await resolveDedicatedIdentity({
      token: 'not-a-telegram-token',
      getMe: async () => {
        throw new Error('getMe failed')
      },
    })).toEqual({ status: 'blocked' })
  })
})

describe('publicSharesDedicatedIdentity', () => {
  it('detects the same bot id', () => {
    expect(publicSharesDedicatedIdentity({ status: 'known', botId: 7 }, 7)).toBe(true)
    expect(publicSharesDedicatedIdentity({ status: 'known', botId: 7 }, 8)).toBe(false)
    expect(publicSharesDedicatedIdentity({ status: 'absent' }, 7)).toBe(false)
    expect(publicSharesDedicatedIdentity({ status: 'blocked' }, 7)).toBe(false)
  })
})