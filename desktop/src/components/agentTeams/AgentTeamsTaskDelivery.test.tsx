import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settingsStore'
import type { TeamWorkbenchSnapshot, TeamWorkbenchTask } from '@/types/team'

import { AgentTeamsTaskDelivery } from './AgentTeamsTaskDelivery'

const { reviewTaskDeliveryMock } = vi.hoisted(() => ({
  reviewTaskDeliveryMock: vi.fn(),
}))

vi.mock('@/api/teams', () => ({
  teamsApi: {
    reviewTaskDelivery: reviewTaskDeliveryMock,
  },
}))

type Submission = NonNullable<TeamWorkbenchTask['delivery']>['submissions'][number]

function submission(version: number, overrides: Partial<Submission> = {}): Submission {
  return {
    version,
    artifact: `Artifact for v${version}`,
    criteria: `Criteria for v${version}`,
    owner: 'builder',
    submittedAt: Date.UTC(2026, 9, 25, 10, version),
    ...overrides,
  }
}

function taskWithDelivery(submissions: Submission[], revision = 2): TeamWorkbenchTask {
  return {
    id: '7',
    subject: 'Ship the review panel',
    description: 'Review each artifact version independently.',
    status: 'in_progress',
    owner: 'builder',
    blocks: [],
    blockedBy: [],
    taskListId: 'team-a',
    delivery: {
      schemaVersion: 1,
      revision,
      submissions,
      receipts: [],
      notices: [],
    },
  }
}

/**
 * What the server sends for a history written by a newer version: an empty
 * protocol history plus the reason it could not be interpreted. The raw record
 * is deliberately absent — it never leaves the server.
 */
function unsupportedTask(overrides: Partial<TeamWorkbenchTask> = {}): TeamWorkbenchTask {
  return {
    ...taskWithDelivery([]),
    deliveryError: 'Task delivery history is unsupported or damaged; this task is read-only',
    ...overrides,
  }
}

function snapshot(overrides: Partial<TeamWorkbenchSnapshot['team']> = {}, deletedAt?: string): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt: '2026-10-25T00:00:00.000Z',
    ...(deletedAt ? { deletedAt } : {}),
    team: {
      name: 'team-a',
      leadAgentId: 'lead@team-a',
      leadSessionId: 'lead-session',
      incarnationId: 'incarnation-1',
      members: [],
      ...overrides,
    },
    tasks: [],
    messages: [],
  }
}

function renderDelivery(options: {
  task?: TeamWorkbenchTask
  snapshot?: TeamWorkbenchSnapshot
  onReviewed?: () => void | Promise<void>
} = {}) {
  return render(
    <AgentTeamsTaskDelivery
      task={options.task ?? taskWithDelivery([submission(1)])}
      snapshot={options.snapshot ?? snapshot()}
      onReviewed={options.onReviewed ?? vi.fn()}
    />,
  )
}

describe('AgentTeamsTaskDelivery', () => {
  beforeEach(() => {
    reviewTaskDeliveryMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders every version with its artifact, criteria, owner and review record', () => {
    const task = taskWithDelivery([
      submission(1, {
        review: {
          decision: 'return',
          reviewer: 'team-lead',
          reason: 'The empty state is missing.',
          reviewedAt: Date.UTC(2026, 9, 25, 11, 0),
        },
      }),
      submission(2),
    ])

    renderDelivery({ task })

    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('Version 1')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('Artifact for v1')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('Criteria for v1')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('builder')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('team-lead')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain('Returned')
    expect(screen.getByTestId('agent-teams-delivery-version-1').textContent).toContain(
      'The empty state is missing.',
    )

    expect(screen.getByTestId('agent-teams-delivery-version-2').textContent).toContain('Version 2')
    expect(screen.getByTestId('agent-teams-delivery-version-2').textContent).toContain('Awaiting review')
  })

  it('only offers review actions for the latest unreviewed version, and never calls on mount', () => {
    renderDelivery({
      task: taskWithDelivery([
        submission(1, {
          review: {
            decision: 'accept',
            reviewer: 'team-lead',
            reviewedAt: Date.UTC(2026, 9, 25, 11, 0),
          },
        }),
      ]),
    })

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return' })).toBeNull()
    expect(reviewTaskDeliveryMock).not.toHaveBeenCalled()
  })

  it('accepts the latest version with the current revision and reloads after the mutation', async () => {
    const onReviewed = vi.fn()
    reviewTaskDeliveryMock.mockResolvedValue({ task: { id: '7' }, updated: true })
    renderDelivery({ onReviewed })

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(reviewTaskDeliveryMock).toHaveBeenCalledTimes(1))
    expect(reviewTaskDeliveryMock).toHaveBeenCalledWith(
      'team-a',
      '7',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      {
        action: 'accept',
        requestId: expect.any(String),
        expectedRevision: 2,
        version: 1,
      },
    )
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1))
    // Accepting is a protocol receipt: no member message or model turn follows.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('requires a reason before returning and sends exactly that reason', async () => {
    reviewTaskDeliveryMock.mockResolvedValue({ task: { id: '7' }, updated: true })
    renderDelivery()

    fireEvent.click(screen.getByRole('button', { name: 'Return' }))
    fireEvent.click(screen.getByRole('button', { name: 'Return this version' }))

    expect(reviewTaskDeliveryMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(
      'A reason is required to return this version.',
    )

    fireEvent.change(screen.getByLabelText(/Reason for returning/), {
      target: { value: 'Add the empty state and retry copy.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Return this version' }))

    await waitFor(() => expect(reviewTaskDeliveryMock).toHaveBeenCalledTimes(1))
    expect(reviewTaskDeliveryMock).toHaveBeenCalledWith(
      'team-a',
      '7',
      { leadSessionId: 'lead-session', incarnationId: 'incarnation-1' },
      {
        action: 'return',
        requestId: expect.any(String),
        expectedRevision: 2,
        version: 1,
        reason: 'Add the empty state and retry copy.',
      },
    )
  })

  it('keeps the request id for a retry so the server can dedupe the commit', async () => {
    reviewTaskDeliveryMock
      .mockRejectedValueOnce(new Error('Delivery changed; refresh before continuing'))
      .mockResolvedValueOnce({ task: { id: '7' }, updated: true })
    renderDelivery()

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(
      'Delivery changed; refresh before continuing',
    ))
    const firstRequestId = reviewTaskDeliveryMock.mock.calls[0]?.[3]?.requestId
    expect(firstRequestId).toEqual(expect.any(String))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(reviewTaskDeliveryMock).toHaveBeenCalledTimes(2))
    expect(reviewTaskDeliveryMock.mock.calls[1]?.[3]?.requestId).toBe(firstRequestId)
  })

  it('prevents a second review while the first request is in flight', async () => {
    let settle!: (value: unknown) => void
    reviewTaskDeliveryMock.mockReturnValue(new Promise((resolve) => {
      settle = resolve
    }))
    renderDelivery()

    const accept = screen.getByRole('button', { name: 'Accept' })
    fireEvent.click(accept)
    fireEvent.click(accept)

    expect(reviewTaskDeliveryMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle({ task: { id: '7' }, updated: true })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy())
  })

  it('disables review on an archived snapshot and says why', () => {
    renderDelivery({
      task: taskWithDelivery([submission(1)]),
      snapshot: snapshot({}, '2026-10-25T12:00:00.000Z'),
    })

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return' })).toBeNull()
    expect(screen.getByTestId('agent-teams-delivery-disabled').getAttribute('data-disabled-reason')).toBe('archived')
  })

  it('disables review when the snapshot has no team identity', () => {
    renderDelivery({
      task: taskWithDelivery([submission(1)]),
      snapshot: snapshot({ leadSessionId: undefined, incarnationId: undefined }),
    })

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.getByTestId('agent-teams-delivery-disabled').getAttribute('data-disabled-reason')).toBe(
      'missing-identity',
    )
  })

  it('says when no artifact has been submitted yet', () => {
    renderDelivery({ task: taskWithDelivery([]) })

    expect(screen.getByTestId('agent-teams-task-delivery').textContent).toContain(
      'No artifact has been submitted for review.',
    )
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('states an unreadable history as read-only instead of an empty, reviewable one', () => {
    renderDelivery({ task: unsupportedTask() })

    const panel = screen.getByTestId('agent-teams-task-delivery')
    expect(screen.getByTestId('agent-teams-delivery-unsupported').textContent).toContain(
      'Delivery history is unsupported or damaged; this task is read-only.',
    )
    // The server's empty placeholder is not an invitation to accept anything.
    expect(panel.textContent).not.toContain('No artifact has been submitted for review.')
    expect(screen.queryByTestId('agent-teams-delivery-version-1')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return' })).toBeNull()
    expect(screen.queryByTestId('agent-teams-delivery-disabled')).toBeNull()
    expect(reviewTaskDeliveryMock).not.toHaveBeenCalled()
  })

  it('never offers review when a read-only reason arrives beside a stale history', () => {
    renderDelivery({
      task: unsupportedTask({
        delivery: {
          schemaVersion: 1,
          revision: 4,
          submissions: [submission(1)],
          receipts: [],
          notices: [],
        },
      }),
    })

    expect(screen.getByTestId('agent-teams-delivery-unsupported')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return' })).toBeNull()
    expect(screen.queryByTestId('agent-teams-delivery-version-1')).toBeNull()
    expect(reviewTaskDeliveryMock).not.toHaveBeenCalled()
  })

  it('localizes the read-only reason', () => {
    useSettingsStore.setState({ locale: 'zh' })
    renderDelivery({ task: unsupportedTask() })

    expect(screen.getByTestId('agent-teams-delivery-unsupported').textContent).toContain(
      '交付历史不兼容或损坏，任务只读。',
    )
    expect(screen.queryByRole('button', { name: '接受' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退回' })).toBeNull()
  })
})