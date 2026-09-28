/**
 * NotificationDeliveryStore — 持久化任务通知的投递状态。
 *
 * 文件位于 fork 自有配置目录：
 *   <CLAUDE_CONFIG_DIR>/ccmax/notification-deliveries.json
 *
 * schema：{ schemaVersion: 1, records: NotificationDeliveryRecord[] }
 * 旧形态（无 schemaVersion 的裸数组 / 缺字段的记录）在读取时前向归一化，
 * 未识别字段一律保留，便于后续版本继续演进。
 *
 * 投递语义（有意不做「恰好一次」承诺）：
 * - 发送网络请求前先写入 `pending`（`enqueuePending`），因此进程在发送中途
 *   崩溃后，磁盘上仍留有未结算记录，而不是静默丢失。
 * - 结果只能通过 `settle` 落定，写入明确的 `delivered` / `failed` /
 *   `indeterminate`。
 * - 重启后 `recoverPending` 把遗留的 `pending` 结算为 `indeterminate`
 *   （平台是否收到无法确证），绝不自动重发，避免重复投递。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as lockfile from '../../utils/lockfile.js'

export const NOTIFICATION_DELIVERY_SCHEMA_VERSION = 1
export const NOTIFICATION_DELIVERY_MAX_RECORDS = 500

export type NotificationChannel = 'telegram' | 'feishu'

export type NotificationDeliveryOutcome = 'pending' | 'delivered' | 'failed' | 'indeterminate'

/** 重启后仍未结算的 pending 记录被归因为该错误码，区别于发送时的 timeout。 */
export const NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART = 'unconfirmed_after_restart'

export type NotificationDeliveryRecord = {
  schemaVersion: number
  deliveryId: string
  runId: string
  taskId: string
  channel: NotificationChannel
  recipientId: string
  recipientDisplayName?: string
  outcome: NotificationDeliveryOutcome
  attempts: number
  error?: string
  errorCode?: string
  messageId?: number
  createdAt: string
  [key: string]: unknown
}

/** `enqueuePending` 的入参：投递身份 + 目标，不含结果字段。 */
export type PendingDeliveryInput = {
  deliveryId: string
  runId: string
  taskId: string
  channel: NotificationChannel
  recipientId: string
  recipientDisplayName?: string
  createdAt: string
  [key: string]: unknown
}

/** 结算一个待发送记录时允许写入的结果字段。 */
export type DeliverySettlement = {
  outcome: Exclude<NotificationDeliveryOutcome, 'pending'>
  attempts: number
  error?: string
  errorCode?: string
  messageId?: number
}

export type EnqueueResult = {
  enqueued: string[]
  /** 已存在同 deliveryId（含已结算）而被幂等跳过的 id。 */
  skipped: string[]
}

export type NotificationDeliveryQuery = {
  deliveryId?: string
  runId?: string
  taskId?: string
  channel?: NotificationChannel
  outcome?: NotificationDeliveryOutcome
  /** 返回的最大条数；缺省为全部。结果按 createdAt 由新到旧。 */
  limit?: number
}

export type NotificationDeliveryStoreFile = {
  schemaVersion: number
  records: NotificationDeliveryRecord[]
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function getNotificationDeliveryStorePath(configDir?: string): string {
  const baseDir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(baseDir, 'ccmax', 'notification-deliveries.json')
}

function normalizeChannel(value: unknown): NotificationChannel | null {
  return value === 'telegram' || value === 'feishu' ? value : null
}

function normalizeOutcome(value: unknown): NotificationDeliveryOutcome {
  return value === 'delivered' || value === 'indeterminate' || value === 'pending'
    ? value
    : 'failed'
}

function normalizeAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 1
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeRecord(value: unknown): NotificationDeliveryRecord | null {
  if (!isRecord(value)) return null
  const deliveryId = value.deliveryId
  const channel = normalizeChannel(value.channel)
  const recipientId = value.recipientId
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) return null
  if (!channel) return null
  if (typeof recipientId !== 'string' && typeof recipientId !== 'number') return null

  return {
    // Unknown fields from a newer build survive the round trip.
    ...value,
    schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    deliveryId,
    runId: typeof value.runId === 'string' ? value.runId : '',
    taskId: typeof value.taskId === 'string' ? value.taskId : '',
    channel,
    recipientId: String(recipientId),
    outcome: normalizeOutcome(value.outcome),
    attempts: normalizeAttempts(value.attempts),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    recipientDisplayName: normalizeOptionalString(value.recipientDisplayName),
    error: normalizeOptionalString(value.error),
    errorCode: normalizeOptionalString(value.errorCode),
  }
}

/**
 * Forward-migrate any previously written shape into the current versioned
 * store. Accepts the pre-versioned bare array (old fixture) as well as objects
 * with a stale `schemaVersion`, and never throws on malformed input.
 */
export function normalizeNotificationDeliveryStore(
  value: unknown,
  maxRecords: number = NOTIFICATION_DELIVERY_MAX_RECORDS,
): NotificationDeliveryStoreFile {
  const source: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.records)
      ? value.records
      : []

  const records: NotificationDeliveryRecord[] = []
  for (const candidate of source) {
    const record = normalizeRecord(candidate)
    if (record) records.push(record)
  }

  const bounded = maxRecords > 0 ? records.slice(-maxRecords) : records

  if (isRecord(value) && !Array.isArray(value)) {
    const { records: _legacyRecords, ...rest } = value
    return {
      ...rest,
      schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
      records: bounded,
    }
  }

  return {
    schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    records: bounded,
  }
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

  try {
    return { missing: false, corrupt: false, value: JSON.parse(raw) as unknown }
  } catch {
    return { missing: false, corrupt: true, value: undefined }
  }
}

function emptyStore(): NotificationDeliveryStoreFile {
  return { schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION, records: [] }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/**
 * Serialize a read-modify-write against the delivery file. Uses the same
 * on-disk `proper-lockfile` lock as `CronService` so two concurrent calls on
 * one instance, and two instances sharing a config dir, cannot interleave a
 * read with another writer's rename and lose a row. `realpath: false` because
 * the file may not exist yet; the directory is created first.
 */
async function withDeliveryFileLock<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
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

export class NotificationDeliveryStore {
  private readonly maxRecords: number

  constructor(
    public readonly filePath: string,
    options: { maxRecords?: number } = {},
  ) {
    this.maxRecords = options.maxRecords ?? NOTIFICATION_DELIVERY_MAX_RECORDS
  }

  async read(): Promise<NotificationDeliveryStoreFile> {
    return withDeliveryFileLock(this.filePath, async () => {
      const raw = await loadRaw(this.filePath)
      if (raw.missing || raw.corrupt) return emptyStore()

      const normalized = normalizeNotificationDeliveryStore(raw.value, this.maxRecords)
      // Persist the upgrade so the file converges on the versioned shape. The
      // migration write takes the same lock as `mutate`, so it cannot clobber a
      // concurrent append.
      if (serialize(normalized) !== serialize(raw.value)) {
        await this.write(normalized).catch(() => {})
      }
      return normalized
    })
  }

  async append(records: NotificationDeliveryRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.mutate((current) => {
      const appended = records
        .map((record) => normalizeRecord(record))
        .filter((record): record is NotificationDeliveryRecord => record !== null)
      return { ...current, records: [...current.records, ...appended].slice(-this.maxRecords) }
    })
  }

  /**
   * Write `pending` markers for deliveries about to be attempted. The delivery
   * id doubles as the idempotency key: a record that already exists in any
   * state is never enqueued twice, so a redelivery cannot duplicate the log.
   */
  async enqueuePending(inputs: PendingDeliveryInput[]): Promise<EnqueueResult> {
    if (inputs.length === 0) return { enqueued: [], skipped: [] }

    let enqueued: string[] = []
    let skipped: string[] = []
    await this.mutate((current) => {
      const known = new Set(current.records.map((record) => record.deliveryId))
      const pending: NotificationDeliveryRecord[] = []
      for (const input of inputs) {
        if (known.has(input.deliveryId)) {
          skipped.push(input.deliveryId)
          continue
        }
        const record = normalizeRecord({
          ...input,
          schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
          outcome: 'pending',
          attempts: 0,
        })
        if (!record) continue
        known.add(input.deliveryId)
        enqueued.push(input.deliveryId)
        pending.push(record)
      }
      return { ...current, records: [...current.records, ...pending].slice(-this.maxRecords) }
    })

    return { enqueued, skipped }
  }

  /**
   * Settle a previously enqueued pending record with its observed outcome.
   * Returns `false` when no record carries that delivery id, so a caller never
   * mistakes a no-op for a persisted result.
   */
  async settle(deliveryId: string, settlement: DeliverySettlement): Promise<boolean> {
    if (deliveryId.length === 0) return false
    let settled = false
    await this.mutate((current) => {
      const records = current.records.map((record) => {
        if (record.deliveryId !== deliveryId) return record
        settled = true
        return normalizeRecord({
          ...record,
          outcome: settlement.outcome,
          attempts: normalizeAttempts(settlement.attempts),
          ...(settlement.messageId !== undefined ? { messageId: settlement.messageId } : {}),
          ...(settlement.errorCode !== undefined ? { errorCode: settlement.errorCode } : {}),
          ...(settlement.error !== undefined ? { error: settlement.error } : {}),
        }) as NotificationDeliveryRecord
      })
      return { ...current, records }
    })
    return settled
  }

  /**
   * A process that restarted never observed whether an in-flight send reached
   * the platform. Reclassify such pending records as `indeterminate` so the UI
   * shows the truth instead of a stale "sending" state; never auto-resend.
   */
  async recoverPending(): Promise<NotificationDeliveryRecord[]> {
    const recovered: NotificationDeliveryRecord[] = []
    await this.mutate((current) => {
      const records = current.records.map((record) => {
        if (record.outcome !== 'pending') return record
        const next = normalizeRecord({
          ...record,
          outcome: 'indeterminate',
          errorCode: NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART,
          error: '投递在完成前进程退出，平台是否收到无法确证',
        }) as NotificationDeliveryRecord
        recovered.push(next)
        return next
      })
      return { ...current, records }
    })
    return recovered
  }

  /** Pending records only; the set a recovery pass must reconcile. */
  async listPending(): Promise<NotificationDeliveryRecord[]> {
    return (await this.read()).records.filter((record) => record.outcome === 'pending')
  }

  /** Query delivery status for the desktop panel; newest record first. */
  async list(query: NotificationDeliveryQuery = {}): Promise<NotificationDeliveryRecord[]> {
    const { records } = await this.read()
    const filtered = records.filter((record) => {
      if (query.deliveryId !== undefined && record.deliveryId !== query.deliveryId) return false
      if (query.runId !== undefined && record.runId !== query.runId) return false
      if (query.taskId !== undefined && record.taskId !== query.taskId) return false
      if (query.channel !== undefined && record.channel !== query.channel) return false
      if (query.outcome !== undefined && record.outcome !== query.outcome) return false
      return true
    })
    const newestFirst = [...filtered].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    )
    if (query.limit !== undefined && query.limit >= 0) return newestFirst.slice(0, query.limit)
    return newestFirst
  }

  /**
   * Shared read-modify-write. Keeps normalization, corrupt-file quarantine and
   * the record bound in one place so every mutation converges on the versioned
   * shape and unknown fields survive.
   */
  private async mutate(
    update: (current: NotificationDeliveryStoreFile) => NotificationDeliveryStoreFile,
  ): Promise<void> {
    await withDeliveryFileLock(this.filePath, async () => {
      const raw = await loadRaw(this.filePath)
      if (raw.corrupt) {
        // Keep the unparsable log for forensics instead of silently overwriting it.
        await fs
          .rename(this.filePath, `${this.filePath}.invalid-${Date.now()}-${randomBytes(3).toString('hex')}`)
          .catch(() => {})
      }

      const current = raw.missing || raw.corrupt
        ? emptyStore()
        : normalizeNotificationDeliveryStore(raw.value, this.maxRecords)

      await this.write(update(current))
    })
  }

  private async write(value: NotificationDeliveryStoreFile): Promise<void> {
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