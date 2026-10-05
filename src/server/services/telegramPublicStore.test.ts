import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION,
  TelegramPublicStore,
  TelegramPublicStoreError,
  getTelegramPublicStorePath,
  inboundUpdateKey,
  messageMapKey,
  normalizeTelegramPublicStore,
  outboxIdempotencyKey,
} from './telegramPublicStore.js'

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const EMPTY_FIXTURE = {}

const LEGACY_FIXTURE = {
  futureField: { keep: true },
  subscriptions: {
    'sess-a': {
      sessionId: 'sess-a',
      shortId: 'S7K2',
      subscribedAt: '2026-01-01T00:00:00.000Z',
      title: '修复登录',
      extra: 1,
    },
  },
  shortIds: { S7K2: 'sess-a' },
  outbox: [
    {
      id: 'out-1',
      idempotencyKey: 'evt:1:9:42:sess-a:0',
      status: 'queued',
      generation: 1,
      botId: 9,
      chatId: '42',
      sessionId: 'sess-a',
      eventId: 'evt',
      part: 0,
      text: 'hello',
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      unknownOutbox: true,
    },
  ],
}

describe('telegramPublicStore path', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', original)
  })

  test('resolves inside the fork-owned config directory', () => {
    process.env.CLAUDE_CONFIG_DIR = '/temporary/config-dir'
    expect(getTelegramPublicStorePath()).toBe(
      path.join('/temporary/config-dir', 'ccmax', 'telegram-public.json'),
    )
  })
})

describe('telegramPublicStore migration', () => {
  test('upgrades an empty old fixture and keeps unknown fields', () => {
    const migrated = normalizeTelegramPublicStore(EMPTY_FIXTURE)
    expect(migrated.schemaVersion).toBe(TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION)
    expect(migrated.subscriptions).toEqual({})
    expect(migrated.outbox).toEqual([])
    expect(migrated.inboundWatermarks).toEqual({})
  })

  test('preserves unknown top-level and record fields from a legacy object', () => {
    const migrated = normalizeTelegramPublicStore(LEGACY_FIXTURE)
    expect(migrated.schemaVersion).toBe(TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION)
    expect(migrated.futureField).toEqual({ keep: true })
    expect(migrated.subscriptions['sess-a']?.extra).toBe(1)
    expect(migrated.outbox[0]?.unknownOutbox).toBe(true)
    expect(migrated.shortIds.S7K2).toBe('sess-a')
  })
})

describe('telegramPublicStore persistence', () => {
  let tmpDir = ''
  let storePath = ''

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-public-store-'))
    storePath = path.join(tmpDir, 'ccmax', 'telegram-public.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('missing file reads as empty and does not create the path', async () => {
    const store = new TelegramPublicStore(storePath)
    const read = await store.read()
    expect(read.subscriptions).toEqual({})
    expect(await store.exists()).toBe(false)
  })

  test('reopen keeps subscriptions and unknown fields; never stores a token', async () => {
    const store = new TelegramPublicStore(storePath)
    await store.mutate(current => {
      current.futureTop = { keep: true }
      current.subscriptions['sess-a'] = {
        sessionId: 'sess-a',
        shortId: 'SABCD',
        subscribedAt: '2026-01-01T00:00:00.000Z',
        title: 'A',
        custom: 'yes',
      }
      current.shortIds.SABCD = 'sess-a'
    })
    const reopened = new TelegramPublicStore(storePath)
    const again = await reopened.read()
    expect(again.subscriptions['sess-a']?.shortId).toBe('SABCD')
    expect(again.subscriptions['sess-a']?.custom).toBe('yes')
    expect(again.futureTop).toEqual({ keep: true })
    const raw = await fs.readFile(storePath, 'utf-8')
    expect(raw).not.toMatch(/botToken|123:ABC/)
  })

  test('atomic mutate serializes two writers', async () => {
    const store = new TelegramPublicStore(storePath)
    await Promise.all([
      store.mutate(current => {
        current.subscriptions.a = {
          sessionId: 'a',
          shortId: 'SAAAA',
          subscribedAt: '1',
        }
        current.shortIds.SAAAA = 'a'
      }),
      store.mutate(current => {
        current.subscriptions.b = {
          sessionId: 'b',
          shortId: 'SBBBB',
          subscribedAt: '1',
        }
        current.shortIds.SBBBB = 'b'
      }),
    ])
    const read = await store.read()
    expect(read.subscriptions.a?.sessionId).toBe('a')
    expect(read.subscriptions.b?.sessionId).toBe('b')
  })

  test('corrupt file fail closed and does not rename-rebuild', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(storePath, '{not json', 'utf-8')
    const store = new TelegramPublicStore(storePath)
    await expect(store.read()).rejects.toMatchObject({ name: 'TelegramPublicStoreError', code: 'corrupt' })
    await expect(store.mutate(current => current)).rejects.toMatchObject({ name: 'TelegramPublicStoreError', code: 'corrupt' })
    expect(await fs.readFile(storePath, 'utf-8')).toBe('{not json')
    const leftovers = await fs.readdir(path.dirname(storePath))
    expect(leftovers.some(name => name.includes('.invalid-'))).toBe(false)
    expect(TelegramPublicStoreError).toBeDefined()
  })

  test('future schema refuses overwrite', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const future = `${JSON.stringify({ schemaVersion: 2, keep: true, subscriptions: {}, shortIds: {}, outbox: [], messageMaps: {}, inboundUpdates: {}, callbackTokens: {} }, null, 2)}\n`
    await fs.writeFile(storePath, future, 'utf-8')
    const store = new TelegramPublicStore(storePath)
    await expect(store.read()).rejects.toMatchObject({ name: 'TelegramPublicStoreError', code: 'future_schema' })
    await expect(store.mutate(current => {
      current.subscriptions.x = { sessionId: 'x', shortId: 'SXXXX', subscribedAt: '1' }
    })).rejects.toMatchObject({ name: 'TelegramPublicStoreError', code: 'future_schema' })
    expect(await fs.readFile(storePath, 'utf-8')).toBe(future)
  })

  test('unknown inbound and unresolved approvals survive ordinary bounds', () => {
    const inboundUpdates: Record<string, unknown> = {}
    for (let index = 0; index < 2005; index++) {
      inboundUpdates[`1:9:${index}`] = {
        key: `1:9:${index}`,
        updateId: index,
        botId: 9,
        generation: 1,
        status: index < 3 ? 'unknown' : 'completed',
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }
    }
    const messageMaps: Record<string, unknown> = {}
    for (let index = 0; index < 2005; index++) {
      messageMaps[`1:9:42:${index + 1}`] = {
        generation: 1,
        botId: 9,
        chatId: '42',
        messageId: index + 1,
        sessionId: 'sess-a',
        shortId: 'S7K2',
        kind: index === 0 ? 'permission' : 'report',
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }
    }
    const normalized = normalizeTelegramPublicStore({
      schemaVersion: 1,
      subscriptions: {},
      shortIds: {},
      outbox: [],
      messageMaps,
      inboundUpdates,
      callbackTokens: {
        tok: {
          token: 'tok',
          sessionId: 'sess-a',
          generation: 1,
          botId: 9,
          requestId: 'req',
          ownerUserId: 42,
          kind: 'permission',
          action: 'allow',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    const unknown = Object.values(normalized.inboundUpdates).filter(item => item.status === 'unknown')
    expect(unknown).toHaveLength(3)
    expect(Object.values(normalized.messageMaps).some(item => item.kind === 'permission')).toBe(true)
    expect(normalized.callbackTokens.tok?.requestId).toBe('req')
  })

  test('message map / inbound / outbox keys isolate botId from chatId', () => {
    const chatId = '4242'
    const messageId = 10
    expect(messageMapKey(3, 99, chatId, messageId)).not.toBe(messageMapKey(3, 1, chatId, messageId))
    expect(inboundUpdateKey(3, 99, 7)).not.toBe(inboundUpdateKey(3, 1, 7))
    expect(outboxIdempotencyKey({
      eventId: 'evt', generation: 3, botId: 99, chatId, sessionId: 'sess-a', part: 0,
    })).not.toBe(outboxIdempotencyKey({
      eventId: 'evt', generation: 3, botId: 1, chatId, sessionId: 'sess-a', part: 0,
    }))
  })
})
