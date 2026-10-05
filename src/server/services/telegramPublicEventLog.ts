/**
 * Telegram public channel event spool — 仅本功能的观察→outbox 窗口日志。
 *
 * 每个已订阅 result / control_request 写成独立 JSON（temp+rename）。
 * 文件名是 eventId+generation 的稳定 hash。损坏或未知格式 fail-closed：
 * 不删除、不改投、由调用方暴露。不是通用日志框架。
 */

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { SessionTurnOrigin } from './sessionTurnEvents.js'

export const TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION = 1

export type TelegramPublicEventLogKind = 'result' | 'control_request'

export type TelegramPublicEventLogRecord = {
  schemaVersion: number
  eventId: string
  botId: number
  generation: number
  ownerUserId: number
  sessionId: string
  kind: TelegramPublicEventLogKind
  observedAt: string
  message: Record<string, unknown>
  origin?: SessionTurnOrigin
  turnId?: string
  [key: string]: unknown
}

export class TelegramPublicEventLogError extends Error {
  readonly code: 'corrupt' | 'future_schema' | 'unknown_format'

  constructor(
    message: string,
    code: 'corrupt' | 'future_schema' | 'unknown_format' = 'corrupt',
  ) {
    super(message)
    this.name = 'TelegramPublicEventLogError'
    this.code = code
  }
}

const COMMITTED_NAME = /^[a-f0-9]{64}\.json$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function getTelegramPublicEventLogDir(storePath: string): string {
  return path.join(path.dirname(storePath), 'telegram-public-events')
}

export function telegramPublicEventLogFileName(eventId: string, generation: number): string {
  return createHash('sha256').update(`${eventId}:${generation}`).digest('hex') + '.json'
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function parseKind(value: unknown): TelegramPublicEventLogKind | null {
  return value === 'result' || value === 'control_request' ? value : null
}

export function normalizeTelegramPublicEventLogRecord(
  value: unknown,
): TelegramPublicEventLogRecord {
  if (!isRecord(value)) {
    throw new TelegramPublicEventLogError('telegram public event log is not an object', 'corrupt')
  }
  if (typeof value.schemaVersion === 'number'
    && Number.isSafeInteger(value.schemaVersion)
    && value.schemaVersion > TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION) {
    throw new TelegramPublicEventLogError(
      `telegram public event log schemaVersion ${value.schemaVersion} is newer than ${TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION}`,
      'future_schema',
    )
  }
  const kind = parseKind(value.kind)
  if (typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion)) {
    throw new TelegramPublicEventLogError('telegram public event log missing schemaVersion', 'corrupt')
  }
  if (typeof value.eventId !== 'string' || value.eventId.length === 0) {
    throw new TelegramPublicEventLogError('telegram public event log missing eventId', 'corrupt')
  }
  if (typeof value.botId !== 'number' || !Number.isSafeInteger(value.botId) || value.botId <= 0) {
    throw new TelegramPublicEventLogError('telegram public event log missing botId', 'corrupt')
  }
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)) {
    throw new TelegramPublicEventLogError('telegram public event log missing generation', 'corrupt')
  }
  if (typeof value.ownerUserId !== 'number' || !Number.isSafeInteger(value.ownerUserId) || value.ownerUserId <= 0) {
    throw new TelegramPublicEventLogError('telegram public event log missing ownerUserId', 'corrupt')
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new TelegramPublicEventLogError('telegram public event log missing sessionId', 'corrupt')
  }
  if (!kind) {
    throw new TelegramPublicEventLogError('telegram public event log missing kind', 'corrupt')
  }
  if (typeof value.observedAt !== 'string' || value.observedAt.length === 0) {
    throw new TelegramPublicEventLogError('telegram public event log missing observedAt', 'corrupt')
  }
  if (!isRecord(value.message)) {
    throw new TelegramPublicEventLogError('telegram public event log missing message', 'corrupt')
  }
  const origin = isRecord(value.origin) ? value.origin as SessionTurnOrigin : undefined
  return {
    ...value,
    schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
    eventId: value.eventId,
    botId: value.botId,
    generation: value.generation,
    ownerUserId: value.ownerUserId,
    sessionId: value.sessionId,
    kind,
    observedAt: value.observedAt,
    message: value.message,
    ...(origin ? { origin } : {}),
    ...(typeof value.turnId === 'string' && value.turnId.length > 0 ? { turnId: value.turnId } : {}),
  }
}

export type TelegramPublicEventLogEntry = {
  name: string
  filePath: string
  record?: TelegramPublicEventLogRecord
  error?: TelegramPublicEventLogError
}

export class TelegramPublicEventLog {
  constructor(public readonly directory: string) {}

  static fromStorePath(storePath: string): TelegramPublicEventLog {
    return new TelegramPublicEventLog(getTelegramPublicEventLogDir(storePath))
  }

  fileName(eventId: string, generation: number): string {
    return telegramPublicEventLogFileName(eventId, generation)
  }

  filePath(eventId: string, generation: number): string {
    return path.join(this.directory, this.fileName(eventId, generation))
  }

  writeSync(record: TelegramPublicEventLogRecord): void {
    const normalized = normalizeTelegramPublicEventLogRecord(record)
    fs.mkdirSync(this.directory, { recursive: true })
    const target = this.filePath(normalized.eventId, normalized.generation)
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`
    try {
      fs.writeFileSync(tmp, serialize(normalized), 'utf-8')
      fs.renameSync(tmp, target)
    } catch (error) {
      try { fs.unlinkSync(tmp) } catch { /* ignore tmp cleanup */ }
      throw error
    }
  }

  readSync(eventId: string, generation: number): TelegramPublicEventLogRecord | null {
    const filePath = this.filePath(eventId, generation)
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch (error) {
      if (isEnoent(error)) return null
      throw error
    }
    try {
      return normalizeTelegramPublicEventLogRecord(JSON.parse(raw) as unknown)
    } catch (error) {
      if (error instanceof TelegramPublicEventLogError) throw error
      throw new TelegramPublicEventLogError(
        `telegram public event log ${path.basename(filePath)} is corrupt`,
        'corrupt',
      )
    }
  }

  async remove(eventId: string, generation: number): Promise<void> {
    try {
      await fsp.unlink(this.filePath(eventId, generation))
    } catch (error) {
      if (isEnoent(error)) return
      throw error
    }
  }

  inspectSync(): TelegramPublicEventLogEntry[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.directory)
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    const entries: TelegramPublicEventLogEntry[] = []
    for (const name of names) {
      if (name.includes('.tmp.')) continue
      const filePath = path.join(this.directory, name)
      if (!COMMITTED_NAME.test(name)) {
        entries.push({
          name,
          filePath,
          error: new TelegramPublicEventLogError(
            `telegram public event log unknown format: ${name}`,
            'unknown_format',
          ),
        })
        continue
      }
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        entries.push({
          name,
          filePath,
          record: normalizeTelegramPublicEventLogRecord(JSON.parse(raw) as unknown),
        })
      } catch (error) {
        entries.push({
          name,
          filePath,
          error: error instanceof TelegramPublicEventLogError
            ? error
            : new TelegramPublicEventLogError(
              `telegram public event log ${name} is corrupt`,
              'corrupt',
            ),
        })
      }
    }
    return entries
  }
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}