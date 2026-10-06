// Source: src/server/services/cronService.ts

/**
 * One explicit notification target. Mirrors
 * `NotificationRecipientSpec` in `src/server/services/notificationService.ts`
 * (the server resolves only against paired users, never against the
 * `allowedUsers` access allowlist).
 */
export type NotificationRecipientSpec =
  | string
  | number
  | { userId?: string | number; displayName?: string }

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop' | 'telegram' | 'feishu')[]
  /**
   * Which Telegram Bot(s) a task notification is delivered through. Absent
   * means `['dedicated']` — the original single-Bot behavior — so a file that
   * predates this field keeps working untouched. Only meaningful when
   * `telegram` is one of `channels`.
   */
  telegramEntrypoints?: TelegramEntrypoint[]
  /**
   * Explicit per-channel recipients. Optional so files written before this
   * field existed still load; the server refuses to broadcast when a channel
   * has no entry here.
   *
   * There is one `recipients.telegram` value regardless of entrypoint: the
   * dedicated Bot sends to that paired user, and the public Bot requires it to
   * be the public owner. A route therefore never carries its own recipient.
   */
  recipients?: Partial<Record<'telegram' | 'feishu', NotificationRecipientSpec[]>>
}

/** Telegram Bot an entry can be delivered through. */
export type TelegramEntrypoint = 'dedicated' | 'public'

export type CronTask = {
  id: string
  name: string
  description?: string
  cron: string
  prompt: string
  enabled: boolean
  recurring?: boolean
  permanent?: boolean
  createdAt: number
  lastRunAt?: number
  lastFiredAt?: string
  nextRunAt?: number
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
  /**
   * Per-task run timeout in positive integer milliseconds (server range
   * `1..2147483647`). Absent means the environment variable
   * `CC_HAHA_TASK_TIMEOUT_MS`, then the built-in 600s default, applies.
   */
  timeoutMs?: number
}

export type CreateTaskInput = {
  name: string
  description?: string
  cron: string
  prompt: string
  enabled?: boolean
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
  /** Per-task run timeout in milliseconds. Optional on create. */
  timeoutMs?: number
}

/**
 * Update payload for one task. `timeoutMs: null` is meaningful and must not be
 * folded into `Partial<CronTask>`: `number | null` intersected with the stored
 * `number` collapses to `number`, which would reject the clear operation
 * TypeScript-wise while the server accepts it.
 */
export type TaskUpdateInput = Omit<Partial<CronTask>, 'timeoutMs'> & {
  /** `null` clears the explicit value so the environment/default applies. */
  timeoutMs?: number | null
}

/** IM channel a task notification can be delivered to. */
export type NotificationDeliveryChannel = 'telegram' | 'feishu'

/**
 * Mirror of `NotificationDeliveryOutcome` in
 * `src/server/services/notificationDeliveryStore.ts`. `indeterminate` means the
 * send was attempted but the platform's receipt could not be confirmed.
 */
export type NotificationDeliveryOutcome = 'pending' | 'delivered' | 'failed' | 'indeterminate'

/** One persisted per-recipient delivery attempt for a run. */
export type NotificationDeliveryRecord = {
  deliveryId: string
  runId: string
  taskId: string
  channel: NotificationDeliveryChannel
  recipientId: string
  recipientDisplayName?: string
  /**
   * Which Telegram Bot this attempt went through. Absent means `dedicated`:
   * records written before the public Bot existed were all dedicated sends.
   * Only ever set for the `telegram` channel.
   */
  telegramEntrypoint?: TelegramEntrypoint
  outcome: NotificationDeliveryOutcome
  attempts: number
  error?: string
  errorCode?: string
  createdAt: string
}

/** Per-channel configuration problem the server recorded for a run. */
export type TaskRunNotificationIssue = {
  channel?: string
  code: string
  message: string
}

/** Compact server-side summary of a run's notification delivery. */
export type TaskRunNotificationReport = {
  ok: boolean
  delivered: number
  failed: number
  indeterminate: number
  issues: TaskRunNotificationIssue[]
  recordPath?: string
}

export type TaskRun = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  prompt: string
  output?: string
  error?: string
  outputPreview?: string
  errorPreview?: string
  hasOutput?: boolean
  hasError?: boolean
  exitCode?: number
  durationMs?: number
  sessionId?: string
  notificationReport?: TaskRunNotificationReport
}
