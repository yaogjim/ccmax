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
   * Explicit per-channel recipients. Optional so files written before this
   * field existed still load; the server refuses to broadcast when a channel
   * has no entry here.
   */
  recipients?: Partial<Record<'telegram' | 'feishu', NotificationRecipientSpec[]>>
}

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
