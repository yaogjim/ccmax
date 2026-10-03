import { describe, expect, it } from 'bun:test'
import { isPaired, tryPair } from '../pairing.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('pairing platform support', () => {
  it('配对写入保留转写配置与根级、平台级未知字段', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairing-stt-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = directory
    const configPath = join(directory, 'adapters.json')
    const stt = { provider: 'whisper-local', whisperModel: '/fixture/model.bin', future: true }
    try {
      writeFileSync(configPath, JSON.stringify({
        pairing: { code: 'ABC234', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
        stt,
        futureRoot: { retained: true },
        telegram: { pairedUsers: [], futurePlatform: 'keep' },
      }))
      expect(tryPair('ABC234', { userId: 7002, displayName: 'Fixture' }, 'telegram')).toBe(true)
      const stored = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(stored.stt).toEqual(stt)
      expect(stored.futureRoot).toEqual({ retained: true })
      expect(stored.telegram.futurePlatform).toBe('keep')
      expect(stored.telegram.pairedUsers[0].userId).toBe(7002)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('checks DingTalk paired users with the same shared access rule', () => {
    expect(isPaired('dingtalk', 'staff-1', {
      dingtalk: {
        pairedUsers: [{ userId: 'staff-1', displayName: 'DingTalk User', pairedAt: Date.now() }],
        allowedUsers: [],
      },
    })).toBe(true)
  })

  it('keeps empty DingTalk allow and pair lists closed by default', () => {
    expect(isPaired('dingtalk', 'staff-1', {
      dingtalk: {
        pairedUsers: [],
        allowedUsers: [],
      },
    })).toBe(false)
  })

  it('checks WhatsApp paired users with the same shared access rule', () => {
    expect(isPaired('whatsapp', '15551234567@s.whatsapp.net', {
      whatsapp: {
        pairedUsers: [{ userId: '15551234567@s.whatsapp.net', displayName: 'WhatsApp User', pairedAt: Date.now() }],
        allowedUsers: [],
      },
    })).toBe(true)
  })
})
