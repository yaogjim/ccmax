import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  editTelegramChannelMessage,
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

describe('editTelegramChannelMessage', () => {
  const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'TMPDIR'] as const
  const previous: Record<string, string | undefined> = {}
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-edit-'))
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

  test('edits with editMessageText, forwards reply_markup and omits parse_mode', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 42 } }))
    const markup = { inline_keyboard: [[{ text: 'Retry', callback_data: 'retry' }]] }
    const result = await editTelegramChannelMessage(
      'secret-bot-token',
      '111',
      42,
      'updated body',
      { fetch: fake.impl, replyMarkup: markup },
    )

    expect(result).toEqual({ outcome: 'delivered', messageId: 42 })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.url).toBe('https://api.telegram.org/botsecret-bot-token/editMessageText')
    expect(fake.calls[0]!.body).toEqual({
      chat_id: '111',
      message_id: 42,
      text: 'updated body',
      reply_markup: markup,
    })
    expect(fake.calls[0]!.body.parse_mode).toBeUndefined()
  })

  test('treats "message is not modified" as a delivered edit of the same message', async () => {
    const fake = createFakeFetch(() => Response.json(
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      },
      { status: 400 },
    ))
    const result = await editTelegramChannelMessage('secret-bot-token', '111', 77, 'same text', { fetch: fake.impl })
    expect(result).toEqual({ outcome: 'delivered', messageId: 77 })
    expect(fake.calls).toHaveLength(1)
  })

  test('a business error is failed, redacted and not retried', async () => {
    const fake = createFakeFetch(() => Response.json({
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found secret-bot-token',
    }, { status: 400 }))
    const result = await editTelegramChannelMessage('secret-bot-token', '111', 5, 'x', { fetch: fake.impl })
    expect(result.outcome).toBe('failed')
    expect(result.error).not.toContain('secret-bot-token')
    expect(result.error).toContain('[redacted]')
    expect(fake.calls).toHaveLength(1)
  })

  test('keeps a 4000-character body in full and rejects 4001 without a request', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 7 } }))
    const text = 'y'.repeat(4000)
    const delivered = await editTelegramChannelMessage('secret-bot-token', '111', 7, text, { fetch: fake.impl })
    expect(delivered.outcome).toBe('delivered')
    expect(fake.calls[0]!.body.text).toBe(text)

    const tooLong = await editTelegramChannelMessage('secret-bot-token', '111', 7, 'y'.repeat(4001), { fetch: fake.impl })
    expect(tooLong.outcome).toBe('failed')
    expect(tooLong.error).toContain('4000')
    expect(fake.calls).toHaveLength(1)
  })

  test('sends markdown-breaking characters as plain text without escaping failures', async () => {
    const body = '*bold* _it_ [link](x) `code` <b>tag</b>'
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 9 } }))
    const result = await editTelegramChannelMessage('secret-bot-token', '111', 9, body, { fetch: fake.impl })
    expect(result.outcome).toBe('delivered')
    expect(fake.calls[0]!.body.text).toBe(body)
    expect(fake.calls[0]!.body.parse_mode).toBeUndefined()
  })

  test('429 keeps retryAfterMs and is not retried', async () => {
    const fake = createFakeFetch(() => Response.json(
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 21', parameters: { retry_after: 21 } },
      { status: 429 },
    ))
    const result = await editTelegramChannelMessage('secret-bot-token', '111', 3, 'hi', { fetch: fake.impl })
    expect(result.outcome).toBe('failed')
    expect(result.retryAfterMs).toBe(21_000)
    expect(fake.calls).toHaveLength(1)
  })

  test('a missing message_id receipt is indeterminate and an invalid message_id is refused before sending', async () => {
    const fake = createFakeFetch(() => Response.json({ ok: true, result: {} }))
    const indeterminate = await editTelegramChannelMessage('secret-bot-token', '111', 4, 'hi', { fetch: fake.impl })
    expect(indeterminate.outcome).toBe('indeterminate')
    expect(indeterminate.error).toContain('回执')

    const invalid = await editTelegramChannelMessage('secret-bot-token', '111', 0, 'hi', { fetch: fake.impl })
    expect(invalid.outcome).toBe('failed')
    expect(fake.calls).toHaveLength(1)
  })
})