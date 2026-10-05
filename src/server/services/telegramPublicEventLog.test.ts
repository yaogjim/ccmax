import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
  TelegramPublicEventLog,
  TelegramPublicEventLogError,
  getTelegramPublicEventLogDir,
  telegramPublicEventLogFileName,
} from './telegramPublicEventLog.js'

describe('telegramPublicEventLog', () => {
  let tmpDir = ''
  let storePath = ''
  let log: TelegramPublicEventLog

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tg-public-events-'))
    storePath = path.join(tmpDir, 'ccmax', 'telegram-public.json')
    log = TelegramPublicEventLog.fromStorePath(storePath)
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('directory sits beside the store as telegram-public-events', () => {
    expect(getTelegramPublicEventLogDir(storePath)).toBe(path.join(tmpDir, 'ccmax', 'telegram-public-events'))
    expect(log.directory).toBe(path.join(tmpDir, 'ccmax', 'telegram-public-events'))
  })

  test('filename hash is stable for eventId+generation', () => {
    const first = telegramPublicEventLogFileName('sess-a:uuid-1', 3)
    const second = telegramPublicEventLogFileName('sess-a:uuid-1', 3)
    const other = telegramPublicEventLogFileName('sess-a:uuid-1', 4)
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(first).not.toBe(other)
  })

  test('writeSync uses temp+rename and round-trips', () => {
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'sess-a:uuid-1',
      botId: 99,
      generation: 3,
      ownerUserId: 4242,
      sessionId: 'sess-a',
      kind: 'result',
      observedAt: '2026-04-04T00:00:00.000Z',
      message: { type: 'result', result: 'ok', uuid: 'uuid-1' },
      origin: { entrypoint: 'desktop', turnId: 't1' },
      keep: true,
    })
    const names = fs.readdirSync(log.directory)
    expect(names.every(name => !name.includes('.tmp.'))).toBe(true)
    const read = log.readSync('sess-a:uuid-1', 3)
    expect(read?.eventId).toBe('sess-a:uuid-1')
    expect(read?.origin?.entrypoint).toBe('desktop')
    expect(read?.keep).toBe(true)
  })

  test('corrupt and unknown format stay on disk and are exposed', async () => {
    await fsp.mkdir(log.directory, { recursive: true })
    const committed = path.join(log.directory, telegramPublicEventLogFileName('evt', 1))
    await fsp.writeFile(committed, '{not json', 'utf-8')
    await fsp.writeFile(path.join(log.directory, 'notes.txt'), 'leave me', 'utf-8')
    const futureName = telegramPublicEventLogFileName('future', 1)
    await fsp.writeFile(
      path.join(log.directory, futureName),
      JSON.stringify({
        schemaVersion: 9,
        eventId: 'future',
        botId: 1,
        generation: 1,
        ownerUserId: 1,
        sessionId: 's',
        kind: 'result',
        observedAt: 't',
        message: { type: 'result' },
      }) + '\n',
      'utf-8',
    )

    const inspected = log.inspectSync()
    expect(inspected.some(entry => entry.error?.code === 'corrupt')).toBe(true)
    expect(inspected.some(entry => entry.error?.code === 'unknown_format' && entry.name === 'notes.txt')).toBe(true)
    expect(inspected.some(entry => entry.error?.code === 'future_schema')).toBe(true)
    expect(await fsp.readFile(committed, 'utf-8')).toBe('{not json')
    expect(await fsp.readFile(path.join(log.directory, 'notes.txt'), 'utf-8')).toBe('leave me')
    expect(TelegramPublicEventLogError).toBeDefined()
  })

  test('missing directory inspects empty and remove is idempotent', async () => {
    expect(log.inspectSync()).toEqual([])
    await log.remove('missing', 1)
    expect(log.readSync('missing', 1)).toBeNull()
  })
})