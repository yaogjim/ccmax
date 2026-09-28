import { describe, expect, it } from 'vitest'

import {
  deriveChannelNotificationStatus,
  type ChannelNotificationStatus,
} from './runNotificationStatus'
import type {
  NotificationDeliveryRecord,
  TaskNotificationConfig,
} from '../../types/task'

function record(
  channel: 'telegram' | 'feishu',
  outcome: NotificationDeliveryRecord['outcome'],
  overrides: Partial<NotificationDeliveryRecord> = {},
): NotificationDeliveryRecord {
  return {
    deliveryId: `${channel}-${outcome}-${Math.random().toString(36).slice(2)}`,
    runId: 'run-1',
    taskId: 'task-1',
    channel,
    recipientId: 'user-1',
    outcome,
    attempts: 1,
    createdAt: '2026-05-08T12:00:00.000Z',
    ...overrides,
  }
}

const enabledConfig: TaskNotificationConfig = {
  enabled: true,
  channels: ['telegram', 'feishu'],
  recipients: { telegram: ['111'], feishu: ['ou_1'] },
}

function derive(input: {
  channel?: 'telegram' | 'feishu'
  records?: NotificationDeliveryRecord[]
  notification?: TaskNotificationConfig | undefined
  runStatus?: string
  loadState?: 'loading' | 'loaded' | 'error'
}): ChannelNotificationStatus {
  return deriveChannelNotificationStatus({
    channel: input.channel ?? 'telegram',
    records: input.records ?? [],
    notification: input.notification,
    runStatus: input.runStatus ?? 'completed',
    loadState: input.loadState ?? 'loaded',
  })
}

describe('deriveChannelNotificationStatus', () => {
  it('reports delivered only when every recorded delivery reached the platform', () => {
    expect(derive({
      records: [record('telegram', 'delivered'), record('telegram', 'delivered', { recipientId: 'user-2' })],
    })).toEqual({ kind: 'delivered', delivered: 2 })
  })

  it('never calls a mixed result delivered: one failure keeps it partial', () => {
    // The whole point of the panel is that a channel which reached one recipient
    // and failed another must not read as success.
    expect(derive({
      records: [record('telegram', 'delivered'), record('telegram', 'failed')],
    })).toEqual({ kind: 'partial', delivered: 1, failed: 1, indeterminate: 0 })
  })

  it('treats delivered plus indeterminate as partial, not success', () => {
    expect(derive({
      records: [record('telegram', 'delivered'), record('telegram', 'indeterminate')],
    })).toEqual({ kind: 'partial', delivered: 1, failed: 0, indeterminate: 1 })
  })

  it('reports failed when nothing was delivered and at least one send failed', () => {
    expect(derive({
      records: [record('telegram', 'failed'), record('telegram', 'failed', { recipientId: 'user-2' })],
    })).toEqual({ kind: 'failed', failed: 2, indeterminate: 0 })
  })

  it('reports indeterminate when sends may or may not have landed', () => {
    expect(derive({
      records: [record('feishu', 'indeterminate')],
      channel: 'feishu',
    })).toEqual({ kind: 'indeterminate', indeterminate: 1 })
  })

  it('reports sending while a delivery is still pending', () => {
    expect(derive({
      records: [record('telegram', 'pending'), record('telegram', 'delivered')],
    })).toEqual({ kind: 'sending' })
  })

  it('ignores deliveries belonging to the other channel', () => {
    expect(derive({
      channel: 'feishu',
      records: [record('telegram', 'delivered')],
    })).toEqual({ kind: 'notSent' })
  })

  it('reports not configured when notifications are disabled for the task', () => {
    expect(derive({
      notification: { enabled: false, channels: ['telegram'] },
    })).toEqual({ kind: 'notConfigured', reason: 'disabled' })
  })

  it('reports not configured when the channel is not one the task notifies', () => {
    expect(derive({
      notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
      channel: 'feishu',
    })).toEqual({ kind: 'notConfigured', reason: 'channelInactive' })
  })

  it('reports not configured when the channel has no explicit recipients', () => {
    // The server refuses to broadcast to every paired user; with no recipients
    // nothing is ever queued, which is "not configured", not "not sent".
    expect(derive({
      notification: { enabled: true, channels: ['telegram', 'feishu'], recipients: { feishu: ['ou_1'] } },
      channel: 'telegram',
    })).toEqual({ kind: 'notConfigured', reason: 'noRecipients' })
  })

  it('reports not sent when the channel is configured but nothing was queued', () => {
    expect(derive({ notification: enabledConfig, runStatus: 'completed' }))
      .toEqual({ kind: 'notSent' })
  })

  it('reports not sent while the run is still executing', () => {
    expect(derive({ notification: enabledConfig, runStatus: 'running', loadState: 'loading' }))
      .toEqual({ kind: 'notSent' })
  })

  it('never claims not sent when the deliveries request failed', () => {
    expect(derive({ notification: enabledConfig, loadState: 'error' }))
      .toEqual({ kind: 'unavailable' })
  })

  it('reports loading while the deliveries request is in flight', () => {
    expect(derive({ notification: enabledConfig, loadState: 'loading' }))
      .toEqual({ kind: 'loading' })
  })

  it('lets recorded deliveries win over a later config change', () => {
    // The run did send before the task was disabled; the record is the truth.
    expect(derive({
      records: [record('telegram', 'delivered')],
      notification: { enabled: false, channels: [] },
    })).toEqual({ kind: 'delivered', delivered: 1 })
  })

  it('falls back to not sent when the task config is unknown, never to success', () => {
    expect(derive({ notification: undefined, runStatus: 'completed', loadState: 'loaded' }))
      .toEqual({ kind: 'notSent' })
  })
})