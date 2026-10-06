/**
 * CronService — 管理定时任务的增删改查
 *
 * 任务持久化到 ~/.claude/scheduled_tasks.json（JSON 文件）。
 * 文件格式: { "tasks": [ CronTask, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import * as lockfile from '../../utils/lockfile.js'
import { parseCronExpression } from '../../utils/cron.js'
import { adapterService, type PairedUser } from './adapterService.js'
import {
  resolveNotificationRecipient,
  type NotificationRecipientSpec,
  type TaskNotificationInput,
  type TelegramMessageEntrypoint,
} from './notificationService.js'

/** Recipient reference shared with the delivery service (single source of truth). */
export type TaskNotificationRecipientSpec = NotificationRecipientSpec

type TaskNotificationImChannel = 'telegram' | 'feishu'

/**
 * The persisted notification shape. `recipients` reuses
 * `TaskNotificationInput['recipients']` verbatim so the delivery service can
 * consume a stored task without any translation: a task that turns on a
 * non-desktop channel names exactly one explicit destination per channel.
 */
export type TaskNotificationConfig = {
  enabled: boolean
  channels: TaskNotificationInput['channels']
  recipients?: TaskNotificationInput['recipients']
  /**
   * Which Telegram entries deliver this task's notification. Reuses the shared
   * interface's field verbatim so a stored task is consumed without translation.
   * Absent means `['dedicated']`, the pre-existing behavior, and an absent field
   * is never written back onto an old record.
   */
  telegramEntrypoints?: TaskNotificationInput['telegramEntrypoints']
}

export type CronTask = {
  id: string
  name?: string
  description?: string
  cron: string // 5-field cron expression
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  /**
   * Per-task execution timeout override in milliseconds. Absent means "use the
   * fallback chain" (env `CC_HAHA_TASK_TIMEOUT_MS`, then the 600 s default).
   */
  timeoutMs?: number
  notification?: TaskNotificationConfig
}

/**
 * A task as returned by read APIs. `notificationNeedsRecipients` is derived at
 * read time and never written back: an old task whose notification is on for a
 * non-desktop channel but has no usable recipient is surfaced as needing setup,
 * and the delivery service refuses to broadcast it.
 */
export type CronTaskView = CronTask & {
  notificationNeedsRecipients?: boolean
}

type TasksFile = {
  tasks: CronTask[]
}

/** Inclusive bounds for a per-task execution timeout override (milliseconds). */
export const MIN_TASK_TIMEOUT_MS = 1
export const MAX_TASK_TIMEOUT_MS = 2_147_483_647

/**
 * Structural check for a per-task timeout value. Used both when validating a
 * create/update payload and when reading a value a hand-edited file may hold,
 * so an out-of-range record falls back instead of arming a nonsensical timer.
 */
export function isValidTaskTimeoutMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TASK_TIMEOUT_MS &&
    value <= MAX_TASK_TIMEOUT_MS
  )
}

const TASKS_FILE_WRITE_ATTEMPTS = 2
const NOTIFICATION_CHANNELS = ['desktop', 'telegram', 'feishu'] as const
const NOTIFICATION_IM_CHANNELS = ['telegram', 'feishu'] as const
const NOTIFICATION_TELEGRAM_ENTRYPOINTS = ['dedicated', 'public'] as const
const DEFAULT_TELEGRAM_ENTRYPOINTS: TelegramMessageEntrypoint[] = ['dedicated']

/**
 * The public Telegram entry the notification may deliver through. Present only
 * when the public config is enabled with a valid owner; the owner is synthesized
 * into a `PairedUser` so the existing recipient resolver can match on it. The
 * owner is read from `adapterService.getRawConfig`, never from the notification
 * payload, so a notification cannot declare its own owner.
 */
type TelegramPublicAccess = {
  enabled: true
  owner: PairedUser
}

type NotificationPairingIndex = Partial<Record<TaskNotificationImChannel, PairedUser[]>> & {
  telegramPublic?: TelegramPublicAccess
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotificationChannel(value: string): boolean {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
}

function isImChannel(value: string): value is TaskNotificationImChannel {
  return value === 'telegram' || value === 'feishu'
}

function isTelegramEntrypoint(value: string): value is TelegramMessageEntrypoint {
  return (NOTIFICATION_TELEGRAM_ENTRYPOINTS as readonly string[]).includes(value)
}

/**
 * Parse the optional `telegramEntrypoints` field. `undefined`/`null` means "not
 * set": the effective value is `['dedicated']` and nothing is persisted. Anything
 * else must be a non-empty array of the two legal entries with no duplicates.
 */
function parseTelegramEntrypoints(
  value: unknown,
): TelegramMessageEntrypoint[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw ApiError.badRequest('notification.telegramEntrypoints must be an array')
  }
  if (value.length === 0) {
    throw ApiError.badRequest(
      'notification.telegramEntrypoints must select at least one entrypoint',
    )
  }

  const seen = new Set<string>()
  const parsed: TelegramMessageEntrypoint[] = []
  for (const entrypoint of value) {
    if (typeof entrypoint !== 'string' || !isTelegramEntrypoint(entrypoint)) {
      throw ApiError.badRequest(
        `notification.telegramEntrypoints contains an unknown entrypoint: ${String(entrypoint)}`,
      )
    }
    if (seen.has(entrypoint)) {
      throw ApiError.badRequest(
        `notification.telegramEntrypoints contains a duplicate entrypoint: ${entrypoint}`,
      )
    }
    seen.add(entrypoint)
    parsed.push(entrypoint)
  }
  return parsed
}

/**
 * Resolve one explicit recipient against a candidate list and throw the
 * matching create/update error. `notVerifiedMessage` lets the public-owner check
 * say *why* a recipient is not acceptable instead of the generic pairing text.
 */
function assertNotificationRecipientResolves(
  spec: NotificationRecipientSpec,
  candidates: PairedUser[],
  channel: string,
  notVerifiedMessage?: string,
): void {
  const resolution = resolveNotificationRecipient(spec, candidates)
  if (resolution.kind === 'resolved') return
  if (resolution.kind === 'ambiguous') {
    throw ApiError.badRequest(
      `notification recipient for ${channel} matches multiple paired users; choose one unambiguously`,
    )
  }
  if (resolution.kind === 'not_verified') {
    throw ApiError.badRequest(
      notVerifiedMessage ??
        `notification recipient for ${channel} is not a paired user on this machine`,
    )
  }
  throw ApiError.badRequest(`notification recipient for ${channel} is invalid`)
}

/**
 * Structural validation of a single recipient reference. Unknown fields are
 * rejected rather than silently ignored so a confused payload cannot smuggle a
 * different target through.
 */
function assertValidRecipientSpec(spec: unknown, channel: string): void {
  if (typeof spec === 'string' || typeof spec === 'number') {
    if (typeof spec === 'number' && !Number.isFinite(spec)) {
      throw ApiError.badRequest(`notification.recipients.${channel} contains an invalid recipient`)
    }
    if (String(spec).trim().length === 0) {
      throw ApiError.badRequest(`notification.recipients.${channel} contains an empty recipient`)
    }
    return
  }

  if (!isPlainObject(spec)) {
    throw ApiError.badRequest(`notification.recipients.${channel} contains an invalid recipient`)
  }

  for (const key of Object.keys(spec)) {
    if (key !== 'userId' && key !== 'displayName') {
      throw ApiError.badRequest(
        `notification.recipients.${channel} contains an unrecognized recipient field: ${key}`,
      )
    }
  }

  const hasUserId = spec.userId !== undefined
  const hasDisplayName = spec.displayName !== undefined
  if (!hasUserId && !hasDisplayName) {
    throw ApiError.badRequest(
      `notification.recipients.${channel} contains a recipient without a userId or displayName`,
    )
  }
  if (hasUserId && typeof spec.userId !== 'string' && typeof spec.userId !== 'number') {
    throw ApiError.badRequest(
      `notification.recipients.${channel} contains a recipient with an invalid userId`,
    )
  }
  if (hasUserId && String(spec.userId).trim().length === 0) {
    throw ApiError.badRequest(`notification.recipients.${channel} contains an empty recipient`)
  }
  if (
    hasDisplayName &&
    (typeof spec.displayName !== 'string' || spec.displayName.trim().length === 0)
  ) {
    throw ApiError.badRequest(
      `notification.recipients.${channel} contains an empty displayName`,
    )
  }
}

/**
 * Validate a create/update notification payload. Returns the normalized config,
 * or undefined when the caller is clearing it.
 *
 * A non-desktop channel that is on must name exactly one explicit recipient,
 * and that recipient must resolve to exactly one paired account
 * (`pairedUsers`). Arbitrary ids, duplicates, ambiguous display names, and
 * recipients for channels that are not enabled are rejected. `allowedUsers` is
 * an access allowlist and is never consulted here.
 *
 * `telegramEntrypoints` (default `['dedicated']`) selects which Telegram
 * entries deliver: `dedicated` resolves the recipient against `pairedUsers`,
 * `public` against the current public owner supplied by adapter config. When
 * both are selected, that single recipient must satisfy both. A public-only
 * recipient may legitimately be absent from the dedicated pairing list.
 */
export function validateTaskNotification(
  notification: unknown,
  pairing: NotificationPairingIndex = {},
): TaskNotificationConfig | undefined {
  if (notification === undefined || notification === null) return undefined

  if (!isPlainObject(notification)) {
    throw ApiError.badRequest('notification must be an object')
  }

  const enabled = notification.enabled
  if (typeof enabled !== 'boolean') {
    throw ApiError.badRequest('notification.enabled must be a boolean')
  }

  const rawChannels = notification.channels
  if (!Array.isArray(rawChannels)) {
    throw ApiError.badRequest('notification.channels must be an array')
  }

  const seenChannels = new Set<string>()
  for (const channel of rawChannels) {
    if (typeof channel !== 'string' || !isNotificationChannel(channel)) {
      throw ApiError.badRequest(
        `notification.channels contains an unknown channel: ${String(channel)}`,
      )
    }
    if (seenChannels.has(channel)) {
      throw ApiError.badRequest(
        `notification.channels contains a duplicate channel: ${channel}`,
      )
    }
    seenChannels.add(channel)
  }
  if (enabled && seenChannels.size === 0) {
    throw ApiError.badRequest(
      'notification.channels must select at least one channel when notifications are enabled',
    )
  }

  // The entrypoint selection only means something for the telegram channel.
  // Its shape is validated even when notifications are off, so a malformed
  // stored payload cannot slip through a later enable.
  const telegramEntrypoints = parseTelegramEntrypoints(notification.telegramEntrypoints)
  if (telegramEntrypoints !== undefined && !seenChannels.has('telegram')) {
    throw ApiError.badRequest(
      'notification.telegramEntrypoints is set but the telegram channel is not enabled',
    )
  }

  const recipients: Partial<Record<TaskNotificationImChannel, NotificationRecipientSpec[]>> = {}
  const rawRecipients = notification.recipients
  if (rawRecipients !== undefined && rawRecipients !== null) {
    if (!isPlainObject(rawRecipients)) {
      throw ApiError.badRequest('notification.recipients must be an object')
    }
    for (const [channel, value] of Object.entries(rawRecipients)) {
      if (!isImChannel(channel)) {
        throw ApiError.badRequest(
          `notification.recipients has an unknown channel: ${channel}`,
        )
      }
      if (!Array.isArray(value)) {
        throw ApiError.badRequest(`notification.recipients.${channel} must be an array`)
      }
      for (const spec of value) {
        assertValidRecipientSpec(spec, channel)
      }
      recipients[channel] = value as NotificationRecipientSpec[]
    }
  }

  for (const channel of Object.keys(recipients) as TaskNotificationImChannel[]) {
    if (!seenChannels.has(channel)) {
      throw ApiError.badRequest(
        `notification.recipients.${channel} is set but the ${channel} channel is not enabled`,
      )
    }
  }

  if (enabled) {
    for (const channel of NOTIFICATION_IM_CHANNELS) {
      if (!seenChannels.has(channel)) continue
      const specs = recipients[channel] ?? []
      if (specs.length === 0) {
        throw ApiError.badRequest(
          `notification channel ${channel} needs exactly one explicit recipient`,
        )
      }
      if (specs.length > 1) {
        throw ApiError.badRequest(
          `notification channel ${channel} must have exactly one recipient, got ${specs.length}`,
        )
      }

      if (channel === 'telegram') {
        // The same explicit recipient must satisfy every selected entrypoint:
        // a dedicated paired user, and/or the current public owner. `public`
        // is only meaningful when the public config is enabled with a valid
        // owner; the owner comes from adapter config, never from the payload.
        for (const entrypoint of telegramEntrypoints ?? DEFAULT_TELEGRAM_ENTRYPOINTS) {
          if (entrypoint === 'dedicated') {
            assertNotificationRecipientResolves(specs[0]!, pairing.telegram ?? [], 'telegram')
            continue
          }
          const publicAccess = pairing.telegramPublic
          if (!publicAccess) {
            throw ApiError.badRequest(
              'notification.telegramEntrypoints includes public, but the public Telegram entrypoint is not enabled with a valid owner',
            )
          }
          assertNotificationRecipientResolves(
            specs[0]!,
            [publicAccess.owner],
            'telegram',
            'notification recipient for telegram is not the current public Telegram owner',
          )
        }
        continue
      }

      assertNotificationRecipientResolves(specs[0]!, pairing[channel] ?? [], channel)
    }
  }

  return {
    enabled,
    channels: rawChannels as TaskNotificationInput['channels'],
    ...(Object.keys(recipients).length > 0 ? { recipients } : {}),
    ...(telegramEntrypoints !== undefined ? { telegramEntrypoints } : {}),
  }
}

/**
 * True when an enabled notification targets a non-desktop channel that has no
 * usable recipient. Read-time marker only — the delivery service will not
 * broadcast, so the app must ask the user to choose a destination.
 */
export function taskNotificationNeedsRecipients(
  notification: TaskNotificationConfig | undefined,
): boolean {
  if (!notification || notification.enabled !== true) return false
  // A record persisted by an older build predates recipient validation (the old
  // API stored the notification payload unvalidated), so `channels` can be
  // missing or not an array. Loading must not throw: `listTasks()` maps every
  // task, so one malformed record would otherwise fail the whole list and stop
  // the scheduler tick. Surface it as needing repair instead.
  if (!Array.isArray(notification.channels)) return true
  return notification.channels.some(
    (channel) =>
      channel !== 'desktop' &&
      (notification.recipients?.[channel]?.length ?? 0) === 0,
  )
}

/**
 * Read the paired-account records needed to verify recipients. Only consulted
 * when an enabled channel actually needs a target; a desktop-only or disabled
 * notification never touches adapter config.
 */
async function loadNotificationPairingIndex(
  notification: unknown,
): Promise<NotificationPairingIndex> {
  if (!isPlainObject(notification)) return {}
  const channels = Array.isArray(notification.channels) ? notification.channels : []
  const needsIm =
    notification.enabled === true &&
    channels.some(
      (channel) => typeof channel === 'string' && isImChannel(channel),
    )
  if (!needsIm) return {}

  const config = await adapterService.getRawConfig()
  const index: NotificationPairingIndex = {
    telegram: config.telegram?.pairedUsers ?? [],
    feishu: config.feishu?.pairedUsers ?? [],
  }

  // Synthesize the public owner as a pairing candidate so the existing
  // recipient resolver can match against it. Only the minimal facts are read:
  // the entry must be enabled and own a positive integer owner. `allowedUsers`
  // is an access allowlist and is never consulted.
  const publicConfig = config.telegram?.public
  const ownerUserId = publicConfig?.ownerUserId
  if (
    publicConfig?.enabled === true &&
    typeof ownerUserId === 'number' &&
    Number.isSafeInteger(ownerUserId) &&
    ownerUserId > 0
  ) {
    index.telegramPublic = {
      enabled: true,
      owner: { userId: ownerUserId, displayName: String(ownerUserId), pairedAt: 0 },
    }
  }

  return index
}

/**
 * A task is enabled unless it says otherwise. Older files predate the
 * `enabled` field entirely, and the desktop UI counts `task.enabled` with a
 * plain truthiness check, so a missing flag must read back as enabled rather
 * than as "off".
 */
function normalizeEnabled(enabled: boolean | undefined): boolean {
  return enabled !== false
}

/**
 * Validate a create/update `timeoutMs` payload. `null` and omission both mean
 * "clear / fall back", so they normalize to undefined; anything else must be an
 * in-range integer and is rejected rather than silently coerced.
 */
function normalizeTaskTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isValidTaskTimeoutMs(value)) {
    throw ApiError.badRequest(
      `timeoutMs must be an integer between ${MIN_TASK_TIMEOUT_MS} and ${MAX_TASK_TIMEOUT_MS}`,
    )
  }
  return value
}

function normalizeTask(task: CronTask): CronTask {
  return { ...task, enabled: normalizeEnabled(task.enabled) }
}

function assertValidCron(cron: string): void {
  if (!parseCronExpression(cron)) {
    throw ApiError.badRequest(`Invalid cron expression: "${cron}"`)
  }
}

/**
 * Serialize a read-modify-write against the task file. `realpath: false`
 * because the file may not exist yet; the caller's directory is created first.
 * Cross-instance safe: two CronService objects sharing one config dir take the
 * same on-disk lock.
 */
async function withTasksFileLock<T>(
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

/**
 * 每个任务文件一条互斥队列（模块级，跨实例共享）。
 * 调度器会在同一分钟并发启动多个任务（各自调用 updateLastFired），
 * API 的增删改也可能与调度器写入交错；无互斥时后完成的写回会覆盖
 * 先完成的修改（执行时间丢失、创建不落盘、已删除任务复活）。
 * 注意 API 层（scheduled-tasks.ts）与调度器（cronScheduler.ts）持有
 * 不同的 CronService 实例，因此队列必须按文件路径共享而非挂在实例上。
 */
const mutationQueues = new Map<string, Promise<unknown>>()

/** 在指定文件的互斥队列中执行变更操作，保留其原始结果/错误。 */
function runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve()
  const result = previous.then(operation)
  mutationQueues.set(
    filePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

/**
 * Serialize a task-file read-modify-write for both layers:
 *  - `runExclusive` orders same-process callers (the API handler and the
 *    scheduler hold different `CronService` instances but share this
 *    module-level queue, keyed by file path);
 *  - `withTasksFileLock` excludes another server process pointed at the same
 *    config dir.
 * Queue first, then lock, so same-process writers never spin on the on-disk
 * lock and the lock is held only for the mutation itself.
 */
function withTasksFileMutation<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return runExclusive(filePath, () => withTasksFileLock(filePath, run))
}

export class CronService {
  /** 任务文件路径 */
  private getTasksFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'scheduled_tasks.json')
  }

  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTaskView[]> {
    const data = await this.readTasksFile()
    return data.tasks.map((task) => ({
      ...task,
      permissionMode: 'bypassPermissions',
      ...(taskNotificationNeedsRecipients(task.notification)
        ? { notificationNeedsRecipients: true }
        : {}),
    }))
  }

  /**
   * Validate a notification payload and resolve its own paired-account view.
   * Returns undefined when the caller is clearing the notification.
   */
  private async resolveNotification(
    notification: unknown,
  ): Promise<TaskNotificationConfig | undefined> {
    if (notification === undefined || notification === null) return undefined
    const pairing = await loadNotificationPairingIndex(notification)
    return validateTaskNotification(notification, pairing)
  }

  /** 创建新任务 */
  async createTask(
    task: Omit<CronTask, 'id' | 'createdAt'>,
  ): Promise<CronTask> {
    if (!task.cron || !task.prompt) {
      throw ApiError.badRequest('Fields "cron" and "prompt" are required')
    }
    assertValidCron(task.cron)

    const notification = await this.resolveNotification(task.notification)
    const timeoutMs = normalizeTaskTimeoutMs(task.timeoutMs)

    return withTasksFileMutation(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const {
        notification: _rawNotification,
        timeoutMs: _rawTimeoutMs,
        ...rest
      } = task
      const newTask: CronTask = {
        ...rest,
        ...(notification === undefined ? {} : { notification }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        // New tasks default to enabled — matches the desktop UI, which always
        // sends `enabled: true` on create.
        enabled: normalizeEnabled(task.enabled),
        permissionMode: 'bypassPermissions',
        id: crypto.randomBytes(4).toString('hex'),
        createdAt: Date.now(),
      }
      data.tasks.push(newTask)
      await this.writeTasksFile(data)
      return newTask
    })
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>): Promise<CronTask> {
    const requestedNotification = updates.notification as unknown
    const hasNotificationUpdate = requestedNotification !== undefined
    // Validate before taking the task file lock; the recipient check only
    // depends on the requested payload and the adapter config.
    const notification = hasNotificationUpdate
      ? await this.resolveNotification(requestedNotification)
      : undefined
    // `null` clears the override; a missing key leaves the stored value alone.
    const requestedTimeout = (updates as { timeoutMs?: unknown }).timeoutMs
    const hasTimeoutUpdate = requestedTimeout !== undefined
    const timeoutMs = hasTimeoutUpdate
      ? normalizeTaskTimeoutMs(requestedTimeout)
      : undefined

    return withTasksFileMutation(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }

      // 不允许修改 id 和 createdAt
      const { id: _id, createdAt: _ca, ...safeUpdates } = updates
      if (safeUpdates.cron !== undefined) {
        assertValidCron(safeUpdates.cron)
      }
      if (safeUpdates.enabled !== undefined) {
        safeUpdates.enabled = normalizeEnabled(safeUpdates.enabled)
      }
      if (hasNotificationUpdate) {
        safeUpdates.notification = notification
      }
      if (hasTimeoutUpdate) {
        safeUpdates.timeoutMs = timeoutMs
      }
      data.tasks[index] = {
        ...data.tasks[index],
        ...safeUpdates,
        permissionMode: 'bypassPermissions',
      }
      await this.writeTasksFile(data)
      return data.tasks[index]
    })
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    await withTasksFileMutation(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }
      data.tasks.splice(index, 1)
      await this.writeTasksFile(data)
    })
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string): Promise<void> {
    await withTasksFileMutation(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === taskId)
      if (index === -1) {
        return // Task may have been deleted; silently ignore
      }
      data.tasks[index].lastFiredAt = timestamp
      await this.writeTasksFile(data)
    })
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写
  // ---------------------------------------------------------------------------

  /** 读取任务 JSON 文件。文件不存在时返回空列表。 */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = await fs.readFile(this.getTasksFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as TasksFile
      // 兼容异常格式
      if (!Array.isArray(parsed.tasks)) {
        return { tasks: [] }
      }
      return { tasks: parsed.tasks.map(normalizeTask) }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tasks: [] }
      }
      throw ApiError.internal(
        `Failed to read scheduled tasks: ${(err as Error).message}`,
      )
    }
  }

  /** 原子写入任务 JSON 文件 */
  private async writeTasksFile(data: TasksFile): Promise<void> {
    const filePath = this.getTasksFilePath()
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(data, null, 2) + '\n'
    let lastError: Error | undefined

    for (let attempt = 0; attempt < TASKS_FILE_WRITE_ATTEMPTS; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`

      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
        return
      } catch (err) {
        lastError = err as Error
        await fs.unlink(tmpFile).catch(() => {})

        // EPERM: Windows 上与其他进程同时 rename 到同一目标可能瞬时失败，
        // 与 ENOENT 一样属于可重试的瞬时错误。
        const code = (err as NodeJS.ErrnoException).code
        const retryable = code === 'ENOENT' || code === 'EPERM'
        if (!retryable || attempt === TASKS_FILE_WRITE_ATTEMPTS - 1) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write scheduled tasks: ${lastError?.message ?? 'unknown error'}`,
    )
  }
}