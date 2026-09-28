import type {
  NotificationDeliveryChannel,
  NotificationDeliveryRecord,
  TaskNotificationConfig,
} from '../../types/task'

/** The IM channels a run can notify; desktop notifications are not persisted here. */
export const NOTIFICATION_CHANNEL_IDS: readonly NotificationDeliveryChannel[] = ['telegram', 'feishu']

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

function recipientsFor(
  notification: TaskNotificationConfig,
  channel: NotificationDeliveryChannel,
): unknown[] | undefined {
  return notification.recipients?.[channel]
}

/**
 * Whether the task's own configuration means this channel could never have sent
 * anything for the run. `recipients` is optional so files written before the
 * field existed still load, and the server refuses to broadcast when a channel
 * has no entry — that refusal is "not configured", not a delivery failure.
 */
function notConfiguredReason(
  channel: NotificationDeliveryChannel,
  notification: TaskNotificationConfig | undefined,
): ChannelNotificationStatus | null {
  if (!notification) return null
  if (!notification.enabled) return { kind: 'notConfigured', reason: 'disabled' }
  const channels = notification.channels ?? []
  if (!channels.includes(channel)) return { kind: 'notConfigured', reason: 'channelInactive' }
  const recipients = recipientsFor(notification, channel)
  if (!recipients || recipients.length === 0) return { kind: 'notConfigured', reason: 'noRecipients' }
  return null
}

/**
 * Aggregate one channel's persisted delivery records. A single non-delivered
 * outcome keeps the channel out of `delivered`, so a mixed result never reads
 * as success.
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
  channel: NotificationDeliveryChannel
  /** All records for the run; the channel filter is applied here. */
  records: NotificationDeliveryRecord[]
  notification: TaskNotificationConfig | undefined
  runStatus: string
  loadState: DeliveriesLoadState
}): ChannelNotificationStatus {
  const { channel, records, notification, runStatus, loadState } = input

  const mine = records.filter((record) => record.channel === channel)
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