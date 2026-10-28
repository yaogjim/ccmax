import { afterEach, describe, expect, it, vi } from 'vitest'

const postMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({ api: { post: postMock } }))

import { teamsApi } from './teams'

describe('member message wire contract', () => {
  const identity = { incarnationId: 'incarnation-original', memberSessionId: 'member-original' }

  afterEach(() => postMock.mockReset())

  it('forwards the exact snapshot identity and stable send id without changing content or recipient', async () => {
    const accepted = { ok: true as const }
    postMock.mockResolvedValue(accepted)

    expect(await teamsApi.sendMemberMessage(
      'team / one',
      'reviewer@team / one',
      '  same text\n',
      identity,
      { messageId: 'client-first' },
    )).toBe(accepted)
    expect(postMock).toHaveBeenCalledWith(
      '/api/teams/team%20%2F%20one/members/reviewer%40team%20%2F%20one/messages',
      { content: '  same text\n', ...identity, messageId: 'client-first' },
    )
  })

  it('preserves caller-provided ids for repeated instructions', async () => {
    postMock.mockResolvedValue({ ok: true })
    await teamsApi.sendMemberMessage('team', 'worker', 'status?', identity, { messageId: 'client-first' })
    await teamsApi.sendMemberMessage('team', 'worker', 'status?', identity, { messageId: 'client-second' })

    expect(postMock.mock.calls.map(([, body]) => body)).toEqual([
      { content: 'status?', ...identity, messageId: 'client-first' },
      { content: 'status?', ...identity, messageId: 'client-second' },
    ])
  })

  it.each([undefined, {}, { messageId: '' }])('keeps identity mandatory when message id is omitted: %j', async options => {
    postMock.mockResolvedValue({ ok: true })
    await teamsApi.sendMemberMessage('team', 'worker', 'status?', identity, options)
    expect(postMock).toHaveBeenCalledWith('/api/teams/team/members/worker/messages', {
      content: 'status?',
      ...identity,
    })
  })

  it('propagates an identity conflict once without retrying or changing the identity', async () => {
    const failure = new Error('TEAM_MEMBER_IDENTITY_CONFLICT')
    postMock.mockRejectedValue(failure)
    await expect(teamsApi.sendMemberMessage('team', 'worker', 'status?', identity, {
      messageId: 'client-rejected',
    })).rejects.toBe(failure)
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(postMock.mock.calls[0]?.[1]).toEqual({
      content: 'status?',
      ...identity,
      messageId: 'client-rejected',
    })
  })
})

describe('task delivery review wire contract', () => {
  afterEach(() => postMock.mockReset())

  it('forwards the team identity and the exact version being reviewed', async () => {
    const accepted = { task: { id: '7' }, updated: true }
    postMock.mockResolvedValue(accepted)

    expect(await teamsApi.reviewTaskDelivery(
      'team / one',
      '7/9',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      { action: 'accept', requestId: 'review-1', expectedRevision: 3, version: 2 },
    )).toBe(accepted)
    expect(postMock).toHaveBeenCalledWith(
      '/api/teams/team%20%2F%20one/tasks/7%2F9/delivery',
      {
        leadSessionId: 'lead-session',
        incarnationId: 'incarnation-1',
        deliveryAction: {
          action: 'accept',
          requestId: 'review-1',
          expectedRevision: 3,
          version: 2,
        },
      },
    )
  })

  it('carries the return reason and never invents one for accept', async () => {
    postMock.mockResolvedValue({ task: { id: '7' }, updated: true })

    await teamsApi.reviewTaskDelivery(
      'team',
      '7',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      { action: 'return', requestId: 'review-2', expectedRevision: 4, version: 3, reason: 'Misses the empty state' },
    )
    expect(postMock.mock.calls[0]?.[1]).toEqual({
      leadSessionId: 'lead-session',
      incarnationId: 'incarnation-1',
      deliveryAction: {
        action: 'return',
        requestId: 'review-2',
        expectedRevision: 4,
        version: 3,
        reason: 'Misses the empty state',
      },
    })

    await teamsApi.reviewTaskDelivery(
      'team',
      '7',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      { action: 'accept', requestId: 'review-3', expectedRevision: 5, version: 3 },
    )
    expect(postMock.mock.calls[1]?.[1]).toEqual({
      leadSessionId: 'lead-session',
      incarnationId: 'incarnation-1',
      deliveryAction: {
        action: 'accept',
        requestId: 'review-3',
        expectedRevision: 5,
        version: 3,
      },
    })
  })

  it('propagates a rejected review instead of acknowledging it', async () => {
    const failure = new Error('Delivery changed; refresh before continuing')
    postMock.mockRejectedValue(failure)
    await expect(teamsApi.reviewTaskDelivery(
      'team',
      '7',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      { action: 'accept', requestId: 'review-4', expectedRevision: 6, version: 3 },
    )).rejects.toBe(failure)
  })
})
