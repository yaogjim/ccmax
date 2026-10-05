/**
 * TelegramPublicStore — 公共 Telegram 入口的服务端单一持久化边界。
 *
 * 文件位于 fork 自有配置目录：
 *   <CLAUDE_CONFIG_DIR>/ccmax/telegram-public.json
 *
 * 保存订阅、待发 outbox、Telegram message_id 映射、入站 update 去重和审批短凭据。
 * 不持久化 bot token。旧配置若没有 `telegram.public`，调用方不得写入本文件。
 *
 * schema：{ schemaVersion: 1, subscriptions, shortIds, outbox, messageMaps,
 *          inboundUpdates, inboundWatermarks, callbackTokens, runtime? }
 * 空对象 / 缺字段的旧 fixture 在读取时前向归一化，未识别字段一律保留。
 * 损坏或未来 schema 一律 fail closed：不自动改名清空、不覆盖写入。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as lockfile from '../../utils/lockfile.js'

export const TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION = 1
export const TELEGRAM_PUBLIC_OUTBOX_MAX_RECORDS = 1000
export const TELEGRAM_PUBLIC_INBOUND_MAX_RECORDS = 2000
export const TELEGRAM_PUBLIC_MESSAGE_MAP_MAX_RECORDS = 2000
export const TELEGRAM_PUBLIC_CALLBACK_MAX_RECORDS = 500

export type TelegramPublicDeliveryStatus =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'indeterminate'

export type TelegramPublicInboundStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'unknown'
  | 'rejected'

export type TelegramPublicRuntimeState = {
  botId: number
  generation: number
  registeredAt: string
  ownerUserId?: number | null
  [key: string]: unknown
}

export type TelegramPublicInboundWatermark = {
  botId: number
  generation: number
  lastUpdateId: number
  updatedAt: string
  [key: string]: unknown
}

export class TelegramPublicStoreError extends Error {
  readonly code: 'corrupt' | 'future_schema'

  constructor(message: string, code: 'corrupt' | 'future_schema' = 'corrupt') {
    super(message)
    this.name = 'TelegramPublicStoreError'
    this.code = code
  }
}

export type TelegramPublicSubscription = {
  sessionId: string
  shortId: string
  subscribedAt: string
  title?: string
  project?: string
  [key: string]: unknown
}

export type TelegramPublicOutboxRecord = {
  id: string
  idempotencyKey: string
  status: TelegramPublicDeliveryStatus
  generation: number
  botId: number
  chatId: string
  sessionId: string
  eventId: string
  part: number
  text: string
  replyMarkup?: unknown
  messageId?: number
  error?: string
  attempts: number
  createdAt: string
  updatedAt: string
  retryAfterMs?: number
  nextAttemptAt?: string
  [key: string]: unknown
}

export type TelegramPublicMessageMap = {
  generation: number
  botId: number
  chatId: string
  messageId: number
  sessionId: string
  shortId: string
  kind: 'report' | 'permission' | 'question' | 'prompt' | 'computer_use'
  turnId?: string
  eventId?: string
  requestId?: string
  originEntrypoint?: string
  toolName?: string
  input?: unknown
  createdAt: string
  expiresAt?: string
  [key: string]: unknown
}

export type TelegramPublicInboundUpdate = {
  key: string
  updateId: number
  botId: number
  generation: number
  status: TelegramPublicInboundStatus
  createdAt: string
  [key: string]: unknown
}

export type TelegramPublicCallbackToken = {
  token: string
  sessionId: string
  generation: number
  botId: number
  requestId: string
  ownerUserId: number
  kind: 'permission' | 'question' | 'computer_use'
  action: string
  optionIndex?: number
  originEntrypoint?: string
  createdAt: string
  [key: string]: unknown
}

export type TelegramPublicStoreFile = {
  schemaVersion: number
  runtime?: TelegramPublicRuntimeState
  subscriptions: Record<string, TelegramPublicSubscription>
  shortIds: Record<string, string>
  outbox: TelegramPublicOutboxRecord[]
  messageMaps: Record<string, TelegramPublicMessageMap>
  inboundUpdates: Record<string, TelegramPublicInboundUpdate>
  inboundWatermarks: Record<string, TelegramPublicInboundWatermark>
  callbackTokens: Record<string, TelegramPublicCallbackToken>
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function getTelegramPublicStorePath(configDir?: string): string {
  const baseDir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(baseDir, 'ccmax', 'telegram-public.json')
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function normalizeDeliveryStatus(value: unknown): TelegramPublicDeliveryStatus {
  return value === 'queued' || value === 'sending' || value === 'delivered'
    || value === 'failed' || value === 'indeterminate'
    ? value
    : 'failed'
}

function normalizeInboundStatus(value: unknown): TelegramPublicInboundStatus {
  return value === 'queued' || value === 'processing' || value === 'completed'
    || value === 'unknown' || value === 'rejected'
    ? value
    : 'unknown'
}

function normalizeSubscription(sessionId: string, value: unknown): TelegramPublicSubscription | null {
  if (!isRecord(value)) return null
  const shortId = value.shortId
  const subscribedAt = value.subscribedAt
  if (typeof shortId !== 'string' || shortId.length === 0) return null
  if (typeof subscribedAt !== 'string' || subscribedAt.length === 0) return null
  return {
    ...value,
    sessionId: typeof value.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : sessionId,
    shortId,
    subscribedAt,
    title: normalizeOptionalString(value.title),
    project: normalizeOptionalString(value.project),
  }
}

function normalizeOutboxRecord(value: unknown): TelegramPublicOutboxRecord | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length === 0) return null
  if (typeof value.chatId !== 'string' && typeof value.chatId !== 'number') return null
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null
  if (typeof value.eventId !== 'string' || value.eventId.length === 0) return null
  if (typeof value.text !== 'string') return null
  return {
    ...value,
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    status: normalizeDeliveryStatus(value.status),
    generation: normalizeInteger(value.generation, 0),
    botId: normalizeInteger(value.botId, 0),
    chatId: String(value.chatId),
    sessionId: value.sessionId,
    eventId: value.eventId,
    part: typeof value.part === 'number' && Number.isSafeInteger(value.part) && value.part >= 0 ? value.part : 0,
    text: value.text,
    attempts: typeof value.attempts === 'number' && Number.isSafeInteger(value.attempts) && value.attempts >= 0
      ? value.attempts
      : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    ...(typeof value.messageId === 'number' && Number.isSafeInteger(value.messageId) && value.messageId > 0
      ? { messageId: value.messageId }
      : {}),
    ...(typeof value.error === 'string' && value.error.length > 0 ? { error: value.error } : {}),
    ...(typeof value.retryAfterMs === 'number' && Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs > 0
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
    ...(typeof value.nextAttemptAt === 'string' && value.nextAttemptAt.length > 0
      ? { nextAttemptAt: value.nextAttemptAt }
      : {}),
  }
}

function normalizeMessageMap(value: unknown): TelegramPublicMessageMap | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null
  if (typeof value.shortId !== 'string' || value.shortId.length === 0) return null
  if (typeof value.chatId !== 'string' && typeof value.chatId !== 'number') return null
  if (typeof value.messageId !== 'number' || !Number.isSafeInteger(value.messageId) || value.messageId <= 0) return null
  const kind = value.kind
  const normalizedKind = kind === 'permission' || kind === 'question' || kind === 'prompt' || kind === 'computer_use'
    ? kind
    : 'report'
  return {
    ...value,
    generation: normalizeInteger(value.generation, 0),
    botId: normalizeInteger(value.botId, 0),
    chatId: String(value.chatId),
    messageId: value.messageId,
    sessionId: value.sessionId,
    shortId: value.shortId,
    kind: normalizedKind,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    turnId: normalizeOptionalString(value.turnId),
    eventId: normalizeOptionalString(value.eventId),
    requestId: normalizeOptionalString(value.requestId),
    originEntrypoint: normalizeOptionalString(value.originEntrypoint),
    toolName: normalizeOptionalString(value.toolName),
    expiresAt: normalizeOptionalString(value.expiresAt),
  }
}

function normalizeInbound(value: unknown, fallbackKey: string): TelegramPublicInboundUpdate | null {
  if (!isRecord(value)) return null
  if (typeof value.updateId !== 'number' || !Number.isSafeInteger(value.updateId)) return null
  return {
    ...value,
    key: typeof value.key === 'string' && value.key.length > 0 ? value.key : fallbackKey,
    updateId: value.updateId,
    botId: normalizeInteger(value.botId, 0),
    generation: normalizeInteger(value.generation, 0),
    status: normalizeInboundStatus(value.status),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  }
}

function normalizeCallback(value: unknown, token: string): TelegramPublicCallbackToken | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  if (typeof value.ownerUserId !== 'number' || !Number.isSafeInteger(value.ownerUserId) || value.ownerUserId <= 0) {
    return null
  }
  const kind = value.kind === 'question' || value.kind === 'computer_use' ? value.kind : 'permission'
  return {
    ...value,
    token: typeof value.token === 'string' && value.token.length > 0 ? value.token : token,
    sessionId: value.sessionId,
    generation: normalizeInteger(value.generation, 0),
    botId: normalizeInteger(value.botId, 0),
    requestId: value.requestId,
    ownerUserId: value.ownerUserId,
    kind,
    action: typeof value.action === 'string' ? value.action : '',
    originEntrypoint: normalizeOptionalString(value.originEntrypoint),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    ...(typeof value.optionIndex === 'number' && Number.isSafeInteger(value.optionIndex)
      ? { optionIndex: value.optionIndex }
      : {}),
  }
}

function boundRecordMap<T>(
  source: Record<string, T>,
  max: number,
  timestamp: (value: T) => string,
  protect?: (value: T) => boolean,
): Record<string, T> {
  const entries = Object.entries(source)
  if (entries.length <= max) return source
  const keep = protect ? entries.filter(([, value]) => protect(value)) : []
  const rest = protect ? entries.filter(([, value]) => !protect(value)) : entries
  rest.sort((left, right) => {
    const a = timestamp(left[1])
    const b = timestamp(right[1])
    return a < b ? -1 : a > b ? 1 : 0
  })
  const room = Math.max(0, max - keep.length)
  return Object.fromEntries([...keep, ...rest.slice(Math.max(0, rest.length - room))])
}

function preserveUnknown(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return {}
  const {
    schemaVersion: _schemaVersion,
    runtime: _runtime,
    subscriptions: _subscriptions,
    shortIds: _shortIds,
    outbox: _outbox,
    messageMaps: _messageMaps,
    inboundUpdates: _inboundUpdates,
    inboundWatermarks: _inboundWatermarks,
    callbackTokens: _callbackTokens,
    ...rest
  } = value
  return rest
}

export function emptyTelegramPublicStore(): TelegramPublicStoreFile {
  return {
    schemaVersion: TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION,
    subscriptions: {},
    shortIds: {},
    outbox: [],
    messageMaps: {},
    inboundUpdates: {},
    inboundWatermarks: {},
    callbackTokens: {},
  }
}

/**
 * Forward-migrate any previously written shape into the current versioned
 * store. Accepts an empty object (old fixture) and never throws on malformed
 * input. Unknown top-level and per-record fields survive the round trip.
 */
export function normalizeTelegramPublicStore(value: unknown): TelegramPublicStoreFile {
  const source = isRecord(value) ? value : {}
  const subscriptions: Record<string, TelegramPublicSubscription> = {}
  if (isRecord(source.subscriptions)) {
    for (const [sessionId, entry] of Object.entries(source.subscriptions)) {
      const normalized = normalizeSubscription(sessionId, entry)
      if (normalized) subscriptions[normalized.sessionId] = normalized
    }
  }

  const shortIds: Record<string, string> = {}
  if (isRecord(source.shortIds)) {
    for (const [shortId, sessionId] of Object.entries(source.shortIds)) {
      if (typeof sessionId === 'string' && sessionId.length > 0 && shortId.length > 0) {
        shortIds[shortId] = sessionId
      }
    }
  }
  for (const subscription of Object.values(subscriptions)) {
    if (!shortIds[subscription.shortId]) shortIds[subscription.shortId] = subscription.sessionId
  }

  const outbox: TelegramPublicOutboxRecord[] = []
  const outboxSource = Array.isArray(source.outbox) ? source.outbox : []
  for (const candidate of outboxSource) {
    const record = normalizeOutboxRecord(candidate)
    if (record) outbox.push(record)
  }

  const messageMaps: Record<string, TelegramPublicMessageMap> = {}
  if (isRecord(source.messageMaps)) {
    for (const [key, entry] of Object.entries(source.messageMaps)) {
      const normalized = normalizeMessageMap(entry)
      if (normalized) messageMaps[key] = normalized
    }
  }

  const inboundUpdates: Record<string, TelegramPublicInboundUpdate> = {}
  if (isRecord(source.inboundUpdates)) {
    for (const [key, entry] of Object.entries(source.inboundUpdates)) {
      const normalized = normalizeInbound(entry, key)
      if (normalized) inboundUpdates[normalized.key] = normalized
    }
  }

  const callbackTokens: Record<string, TelegramPublicCallbackToken> = {}
  if (isRecord(source.callbackTokens)) {
    for (const [token, entry] of Object.entries(source.callbackTokens)) {
      const normalized = normalizeCallback(entry, token)
      if (normalized) callbackTokens[normalized.token] = normalized
    }
  }

  const inboundWatermarks: Record<string, TelegramPublicInboundWatermark> = {}
  if (isRecord(source.inboundWatermarks)) {
    for (const [key, entry] of Object.entries(source.inboundWatermarks)) {
      if (!isRecord(entry)) continue
      if (typeof entry.botId !== 'number' || !Number.isSafeInteger(entry.botId) || entry.botId <= 0) continue
      if (typeof entry.generation !== 'number' || !Number.isSafeInteger(entry.generation)) continue
      if (typeof entry.lastUpdateId !== 'number' || !Number.isSafeInteger(entry.lastUpdateId)) continue
      inboundWatermarks[typeof entry.key === 'string' && entry.key.length > 0 ? entry.key : key] = {
        ...entry,
        botId: entry.botId,
        generation: entry.generation,
        lastUpdateId: entry.lastUpdateId,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      }
    }
  }

  let runtime: TelegramPublicRuntimeState | undefined
  if (isRecord(source.runtime)
    && typeof source.runtime.botId === 'number' && Number.isSafeInteger(source.runtime.botId) && source.runtime.botId > 0
    && typeof source.runtime.generation === 'number' && Number.isSafeInteger(source.runtime.generation)) {
    const ownerUserId = source.runtime.ownerUserId
    runtime = {
      ...source.runtime,
      botId: source.runtime.botId,
      generation: source.runtime.generation,
      registeredAt: typeof source.runtime.registeredAt === 'string' ? source.runtime.registeredAt : '',
      ...(typeof ownerUserId === 'number' && Number.isSafeInteger(ownerUserId) && ownerUserId > 0
        ? { ownerUserId }
        : ownerUserId === null
          ? { ownerUserId: null }
          : {}),
    }
  }

  const boundedOutbox = outbox.length > TELEGRAM_PUBLIC_OUTBOX_MAX_RECORDS
    ? retainOutbox(outbox)
    : outbox

  return {
    ...preserveUnknown(source),
    schemaVersion: TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION,
    ...(runtime ? { runtime } : {}),
    subscriptions,
    shortIds,
    outbox: boundedOutbox,
    messageMaps: boundRecordMap(
      messageMaps,
      TELEGRAM_PUBLIC_MESSAGE_MAP_MAX_RECORDS,
      value => value.createdAt,
      value => value.kind === 'permission' || value.kind === 'question' || value.kind === 'computer_use',
    ),
    inboundUpdates: boundRecordMap(
      inboundUpdates,
      TELEGRAM_PUBLIC_INBOUND_MAX_RECORDS,
      value => value.createdAt,
      value => value.status === 'unknown' || value.status === 'processing',
    ),
    inboundWatermarks,
    callbackTokens,
  }
}

function retainOutbox(records: TelegramPublicOutboxRecord[]): TelegramPublicOutboxRecord[] {
  const protectedStatuses = new Set<TelegramPublicDeliveryStatus>(['queued', 'sending', 'indeterminate'])
  const keep = records.filter(record => protectedStatuses.has(record.status))
  const rest = records.filter(record => !protectedStatuses.has(record.status))
  const room = Math.max(0, TELEGRAM_PUBLIC_OUTBOX_MAX_RECORDS - keep.length)
  const trimmed = rest.slice(Math.max(0, rest.length - room))
  return [...keep, ...trimmed]
}

type RawLoad = { missing: boolean; corrupt: boolean; value: unknown }

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function loadRaw(filePath: string): Promise<RawLoad> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { missing: true, corrupt: false, value: undefined }
    throw error
  }

  if (raw.trim() === '') return { missing: false, corrupt: false, value: {} }

  try {
    return { missing: false, corrupt: false, value: JSON.parse(raw) as unknown }
  } catch {
    return { missing: false, corrupt: true, value: undefined }
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

async function withStoreLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const release = await lockfile.lock(filePath, {
    realpath: false,
    retries: {
      retries: 60,
      minTimeout: 5,
      maxTimeout: 50,
      factor: 1.5,
    },
  })
  try {
    return await run()
  } finally {
    await release().catch(() => {})
  }
}

export function messageMapKey(generation: number, botId: number, chatId: string, messageId: number): string {
  return `${generation}:${botId}:${chatId}:${messageId}`
}

export function inboundUpdateKey(generation: number, botId: number, updateId: number): string {
  return `${generation}:${botId}:${updateId}`
}

export function inboundWatermarkKey(generation: number, botId: number): string {
  return `${generation}:${botId}`
}

export function outboxIdempotencyKey(params: {
  eventId: string
  generation: number
  botId: number
  chatId: string
  sessionId: string
  part: number
}): string {
  return `${params.eventId}:${params.generation}:${params.botId}:${params.chatId}:${params.sessionId}:${params.part}`
}

export class TelegramPublicStore {
  constructor(public readonly filePath: string) {}

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath)
      return true
    } catch {
      return false
    }
  }

  async read(): Promise<TelegramPublicStoreFile> {
    return withStoreLock(this.filePath, async () => {
      const current = await this.loadUnlocked()
      if (current.missing) return emptyTelegramPublicStore()
      if (serialize(current.value) !== serialize(current.raw)) {
        await this.writeUnlocked(current.value).catch(() => {})
      }
      return current.value
    })
  }

  async mutate(
    update: (current: TelegramPublicStoreFile) => TelegramPublicStoreFile | void,
  ): Promise<TelegramPublicStoreFile> {
    return withStoreLock(this.filePath, async () => {
      const loaded = await this.loadUnlocked()
      const current = loaded.missing ? emptyTelegramPublicStore() : loaded.value
      const next = update(current)
      const written = normalizeTelegramPublicStore(next ?? current)
      await this.writeUnlocked(written)
      return written
    })
  }

  private async loadUnlocked(): Promise<
    { missing: true; value: TelegramPublicStoreFile; raw: unknown } | { missing: false; value: TelegramPublicStoreFile; raw: unknown }
  > {
    const raw = await loadRaw(this.filePath)
    if (raw.missing) return { missing: true, value: emptyTelegramPublicStore(), raw: undefined }
    if (raw.corrupt) {
      throw new TelegramPublicStoreError(
        'telegram public store is corrupt; refusing to rebuild dedup state',
        'corrupt',
      )
    }
    if (isRecord(raw.value)
      && typeof raw.value.schemaVersion === 'number'
      && Number.isSafeInteger(raw.value.schemaVersion)
      && raw.value.schemaVersion > TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION) {
      throw new TelegramPublicStoreError(
        `telegram public store schemaVersion ${raw.value.schemaVersion} is newer than ${TELEGRAM_PUBLIC_STORE_SCHEMA_VERSION}`,
        'future_schema',
      )
    }
    return { missing: false, value: normalizeTelegramPublicStore(raw.value), raw: raw.value }
  }

  private async writeUnlocked(value: TelegramPublicStoreFile): Promise<void> {
    const directory = path.dirname(this.filePath)
    const tmpFile = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`
    await fs.mkdir(directory, { recursive: true })
    try {
      await fs.writeFile(tmpFile, serialize(value), 'utf-8')
      await fs.rename(tmpFile, this.filePath)
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => {})
      throw error
    }
  }
}