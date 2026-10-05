import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  sendTelegramChannelMessage,
  type TelegramChannelMessageResult,
} from './notificationService.js'

type FetchCall = {
  url: string
  body: Record<string, unknown>
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function createFakeFetch(handler: (call: FetchCall) => Response | Promise<Response> | never): {
  calls: FetchCall[]
  impl: typeof fetch
} {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { calls, impl }
}

describe('sendTelegramChannelMessage', () => {
  const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'TMPDIR'] as const
  const previous: Record<string, string | undefined> = {}
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-channel-'))
    for (const key of envKeys) {
      previous[key] = process.env[key]
    }
    process.env.HOME = tmpDir
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'claude')
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg')
    process.env.TMPDIR = path.join(tmpDir, 'tmp')
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    await fs.mkdir(process.env.XDG_CONFIG_HOME, { recursive: true })
    await fs.mkdir(process.env.TMPDIR, { recursive: true })
  })

  afterEach(async () => {
    for (const key of envKeys) restoreEnv(key, previous[key])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('delivers only with a valid message_id receipt and forwards reply_markup', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 42 } }))
    const markup = { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]] }
    const result = await sendTelegramChannelMessage(
      'secret-bot-token',
      '111',
      'hello public',
      { fetch: fake.impl, replyMarkup: markup },
    )

    expect(result).toEqual({ outcome: 'delivered', messageId: 42 })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.url).toBe('https://api.telegram.org/botsecret-bot-token/sendMessage')
    expect(fake.calls[0]!.body).toEqual({
      chat_id: '111',
      text: 'hello public',
      reply_markup: markup,
    })
    expect(fake.calls[0]!.body.parse_mode).toBeUndefined()
  })

  test('rejects text over 4000 instead of silently truncating', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 1 } }))
    const result = await sendTelegramChannelMessage(
      'secret-bot-token',
      '111',
      'x'.repeat(4001),
      { fetch: fake.impl },
    )
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('4000')
    expect(fake.calls).toHaveLength(0)
  })

  test('sends a 4000-character body in full', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 7 } }))
    const text = 'y'.repeat(4000)
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', text, { fetch: fake.impl })
    expect(result.outcome).toBe('delivered')
    expect(fake.calls[0]!.body.text).toBe(text)
  })

  test('timeout is indeterminate and is not retried', async () => {
    const fake = createFakeFetch(() => {
      throw abortError()
    })
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
    expect(result).toMatchObject({ outcome: 'indeterminate' })
    expect(result.error).toMatch(/timed out/i)
    expect(fake.calls).toHaveLength(1)
  })

  test('network failure is indeterminate and is not retried', async () => {
    const fake = createFakeFetch(() => {
      throw new Error('ECONNRESET botsecret-bot-token')
    })
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
    expect(result.outcome).toBe('indeterminate')
    expect(result.error).not.toContain('secret-bot-token')
    expect(result.error).toContain('[redacted]')
    expect(fake.calls).toHaveLength(1)
  })

  test('429 returns retryAfterMs from Telegram retry_after seconds without capping', async () => {
    const fake = createFakeFetch(() => Response.json(
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 42',
        parameters: { retry_after: 42 },
      },
      { status: 429 },
    ))
    const result: TelegramChannelMessageResult = await sendTelegramChannelMessage(
      'secret-bot-token',
      '111',
      'hi',
      { fetch: fake.impl },
    )
    expect(result.outcome).toBe('failed')
    expect(result.retryAfterMs).toBe(42_000)
    expect(fake.calls).toHaveLength(1)
  })

  test('missing message_id receipt is indeterminate, not delivered', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: {} }))
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
    expect(result).toEqual({
      outcome: 'indeterminate',
      error: 'Telegram 未返回可验证的消息回执，禁止据此认定送达',
    })
  })

  test.each([0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1])(
    'invalid message_id %s is indeterminate and is not retried',
    async (messageId) => {
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: messageId } }))
      const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
      expect(result.outcome).toBe('indeterminate')
      expect(result.error).toContain('回执')
      expect(fake.calls).toHaveLength(1)
    },
  )

  test('HTTP 500 is failed and is not retried', async () => {
    const fake = createFakeFetch(() => new Response('nope', { status: 500 }))
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
    expect(result.outcome).toBe('failed')
    expect(fake.calls).toHaveLength(1)
  })

  test('redacts the bot token when a transport error embeds the request path', async () => {
    const fake = createFakeFetch(() => {
      throw new Error('connect ECONNREFUSED https://api.telegram.org/botsecret-bot-token/sendMessage')
    })
    const result = await sendTelegramChannelMessage('secret-bot-token', '111', 'hi', { fetch: fake.impl })
    expect(result.outcome).toBe('indeterminate')
    expect(result.error).not.toContain('secret-bot-token')
    expect(result.error).toContain('[redacted]')
  })
})