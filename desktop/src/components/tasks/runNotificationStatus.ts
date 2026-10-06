import type {
  NotificationDeliveryChannel,
  NotificationDeliveryRecord,
  TaskNotificationConfig,
  TelegramEntrypoint,
} from '../../types/task'

/**
 * One row in a run's notification status. Telegram is split into its two Bot
 * entries: the same channel can deliver through either, and "the dedicated Bot
 * failed" and "the public Bot failed" are different facts a reader needs told
 * apart. Feishu stays a single row.
 */
export type DeliveryChannelId = NotificationDeliveryChannel | 'telegram-public'

/** The IM rows a run can notify; desktop notifications are not persisted here. */
export const NOTIFICATION_CHANNEL_IDS: readonly DeliveryChannelId[] = [
  'telegram',
  'telegram-public',
  'feishu',
]

/** How a deliveries fetch is progressing for one run. */
export type DeliveriesLoadState = 'loading' | 'loaded' | 'error'

/**
 * The distinct states a channel's notifications can be in for one run.
 *
 * The vocabulary separates two things a single "failed" flag used to blur:
 * `notSent` (the channel is configured but nothing was queued for this run) and
 * `notConfigured` (the task never had a usable target for the channel, so the
 * server never attempted a send). Neither may be presented as success, and
 * `delivered` is reachable only when every recorded recipient succeeded.
 */
export type ChannelNotificationStatus =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'notConfigured'; reason: 'disabled' | 'channelInactive' | 'noRecipients' }
  | { kind: 'notSent' }
  | { kind: 'sending' }
  | { kind: 'delivered'; delivered: number }
  | { kind: 'partial'; delivered: number; failed: number; indeterminate: number }
  | { kind: 'failed'; failed: number; indeterminate: number }
  | { kind: 'indeterminate'; indeterminate: number }

/** The entry a Telegram row represents. */
function rowEntrypoint(row: DeliveryChannelId): TelegramEntrypoint {
  return row === 'telegram-public' ? 'public' : 'dedicated'
}

/** The platform channel a row belongs to. */
function rowChannel(row: DeliveryChannelId): NotificationDeliveryChannel {
  return row === 'feishu' ? 'feishu' : 'telegram'
}

/**
 * Which entry a record was delivered through. A record written before the
 * option existed was a dedicated send, so an absent field means dedicated and
 * never public.
 */
function recordEntrypoint(record: NotificationDeliveryRecord): TelegramEntrypoint {
  return record.telegramEntrypoint === 'public' ? 'public' : 'dedicated'
}

/**
 * The task's selected Telegram entries. Absent means the original
 * dedicated-only behavior, so a task stored before the option existed keeps
 * delivering through the dedicated Bot.
 */
function configuredEntrypoints(notification: TaskNotificationConfig): TelegramEntrypoint[] {
  return notification.telegramEntrypoints ?? ['dedicated']
}

function recipientsFor(
  notification: TaskNotificationConfig,
  row: DeliveryChannelId,
): unknown[] | undefined {
  // Both Telegram rows read the one `recipients.telegram` value: the public Bot
  // requires that recipient to be the public owner, it does not have its own.
  return notification.recipients?.[rowChannel(row)]
}

/**
 * Whether the task's own configuration means this row could never have sent
 * anything for the run. `recipients` is optional so files written before the
 * field existed still load, and the server refuses to broadcast when a channel
 * has no entry — that refusal is "not configured", not a delivery failure.
 */
function notConfiguredReason(
  row: DeliveryChannelId,
  notification: TaskNotificationConfig | undefined,
): ChannelNotificationStatus | null {
  if (!notification) return null
  if (!notification.enabled) return { kind: 'notConfigured', reason: 'disabled' }
  const channels = notification.channels ?? []
  if (!channels.includes(rowChannel(row))) {
    return { kind: 'notConfigured', reason: 'channelInactive' }
  }
  if (rowChannel(row) === 'telegram' && !configuredEntrypoints(notification).includes(rowEntrypoint(row))) {
    // The task uses Telegram, but not through this Bot: a public-only task was
    // never enqueued on the dedicated Bot, and vice versa.
    return { kind: 'notConfigured', reason: 'channelInactive' }
  }
  const recipients = recipientsFor(notification, row)
  if (!recipients || recipients.length === 0) return { kind: 'notConfigured', reason: 'noRecipients' }
  return null
}

/**
 * Aggregate one row's persisted delivery records. A single non-delivered
 * outcome keeps the row out of `delivered`, so a mixed result never reads as
 * success.
 */
function aggregateRecords(records: NotificationDeliveryRecord[]): ChannelNotificationStatus {
  const pending = records.filter((record) => record.outcome === 'pending').length
  if (pending > 0) return { kind: 'sending' }

  const delivered = records.filter((record) => record.outcome === 'delivered').length
  const failed = records.filter((record) => record.outcome === 'failed').length
  const indeterminate = records.filter((record) => record.outcome === 'indeterminate').length

  if (failed === 0 && indeterminate === 0) return { kind: 'delivered', delivered }
  if (delivered > 0) return { kind: 'partial', delivered, failed, indeterminate }
  if (failed > 0) return { kind: 'failed', failed, indeterminate }
  return { kind: 'indeterminate', indeterminate }
}

export function deriveChannelNotificationStatus(input: {
  channel: DeliveryChannelId
  /** All records for the run; the row filter is applied here. */
  records: NotificationDeliveryRecord[]
  notification: TaskNotificationConfig | undefined
  runStatus: string
  loadState: DeliveriesLoadState
}): ChannelNotificationStatus {
  const { channel, records, notification, runStatus, loadState } = input

  const mine = records.filter((record) => {
    if (rowChannel(channel) === 'feishu') return record.channel === 'feishu'
    if (record.channel !== 'telegram') return false
    return recordEntrypoint(record) === rowEntrypoint(channel)
  })
  // Real recorded attempts outrank the current task config: the task may have
  // been reconfigured after this run, but the record describes what happened.
  if (mine.length > 0) return aggregateRecords(mine)

  const notConfigured = notConfiguredReason(channel, notification)
  if (notConfigured) return notConfigured

  // A failed fetch is never "not sent": we do not know, and must say so.
  if (loadState === 'error') return { kind: 'unavailable' }
  if (runStatus === 'running') return { kind: 'notSent' }
  if (loadState === 'loading') return { kind: 'loading' }
  return { kind: 'notSent' }
}