import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TaskRunsPanel } from './TaskRunsPanel'
import { tasksApi } from '../../api/tasks'
import { translate } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { NotificationDeliveryRecord, TaskRun } from '../../types/task'

beforeEach(() => {
  // The deliveries endpoint is the backend contract this panel is built
  // against; every test stubs it so none reaches the network.
  vi.spyOn(tasksApi, 'getRunDeliveries').mockResolvedValue({ deliveries: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

type StoreTask = ReturnType<typeof useTaskStore.getState>['tasks'][number]

const configuredTask: StoreTask = {
  id: 'task-1',
  name: 'Daily summary',
  cron: '0 9 * * *',
  prompt: 'Summarize',
  enabled: true,
  createdAt: 0,
  notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
}

/**
 * Settle the promise chains a render kicks off while fake timers are installed.
 * React effects and the mocked fetch promises resolve in microtasks; advancing
 * the fake clock by 0 flushes them without letting the poll interval fire.
 */
async function flushFakeTimers() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
}

function delivery(
  channel: 'telegram' | 'feishu',
  outcome: NotificationDeliveryRecord['outcome'],
  overrides: Partial<NotificationDeliveryRecord> = {},
): NotificationDeliveryRecord {
  return {
    deliveryId: `${channel}-${outcome}`,
    runId: 'run-1',
    taskId: 'task-1',
    channel,
    recipientId: 'user-1',
    outcome,
    attempts: 1,
    createdAt: '2026-05-08T12:05:37.000Z',
    ...overrides,
  }
}

const terminalRun: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  taskName: 'Daily summary',
  startedAt: '2026-05-08T12:05:37.000Z',
  status: 'completed',
  prompt: 'Summarize',
  output: 'task output',
}

describe('TaskRunsPanel notifications', () => {
  it('resolves every notification status string in all five locales', () => {
    // A key added to only en/zh renders the raw key (or English) for the other
    // three locales; this pins the whole set.
    const keys = [
      'tasks.delivery.title',
      'tasks.delivery.loading',
      'tasks.delivery.unavailable',
      'tasks.delivery.notConfigured',
      'tasks.delivery.channelInactive',
      'tasks.delivery.noRecipients',
      'tasks.delivery.notSent',
      'tasks.delivery.sending',
      'tasks.delivery.delivered',
      'tasks.delivery.partial',
      'tasks.delivery.failed',
      'tasks.delivery.indeterminate',
    ] as const
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      for (const key of keys) {
        expect(translate(locale, key), `${locale} is missing ${key}`).not.toBe(key)
      }
      // Counts must substitute, not render a bare placeholder.
      for (const key of [
        'tasks.delivery.countDelivered',
        'tasks.delivery.countFailed',
        'tasks.delivery.countIndeterminate',
      ] as const) {
        expect(translate(locale, key, { count: 2 }), `${locale} drops the count for ${key}`).toContain('2')
      }
    }
  })

  it('shows Telegram and Feishu delivery outcomes separately from the run status', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: {
          enabled: true,
          channels: ['telegram', 'feishu'],
          recipients: { telegram: ['111'], feishu: ['ou_1'] },
        },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries).mockResolvedValue({
      deliveries: [delivery('telegram', 'delivered'), delivery('feishu', 'failed', { error: 'HTTP 400' })],
    })

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'))
    expect(screen.getByTestId('run-delivery-feishu')).toHaveTextContent('Delivery failed')
  })

  it('never reads a partial delivery as success', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: ['111', '222'] },
        },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries).mockResolvedValue({
      deliveries: [
        delivery('telegram', 'delivered'),
        delivery('telegram', 'indeterminate', { recipientId: 'user-2' }),
      ],
    })

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Partially delivered'))
    expect(screen.getByTestId('run-delivery-telegram')).not.toHaveTextContent('Delivered')
  })

  it('reports not sent, not success, for a configured channel with no records', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: {
          enabled: true,
          channels: ['telegram', 'feishu'],
          recipients: { telegram: ['111'], feishu: ['ou_1'] },
        },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent'))
    expect(screen.getByTestId('run-delivery-feishu')).toHaveTextContent('Not sent')
  })

  it('reports a missing recipient list as not configured rather than not sent', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        // Feishu has a target, Telegram does not; the server refuses to
        // broadcast, so Telegram was never sent and never failed.
        notification: {
          enabled: true,
          channels: ['telegram', 'feishu'],
          recipients: { feishu: ['ou_1'] },
        },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('No recipients configured'))
    expect(screen.getByTestId('run-delivery-feishu')).toHaveTextContent('Not sent')
  })

  it('reports unknown, never not sent, when the deliveries request fails', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: ['111'] },
        },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries).mockRejectedValue(new Error('endpoint missing'))

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Status unknown'))
    expect(screen.getByTestId('run-delivery-telegram')).not.toHaveTextContent('Not sent')
  })

  it('loads deliveries for the expanded run and aborts the request on collapse', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    let signal: AbortSignal | undefined
    vi.mocked(tasksApi.getRunDeliveries).mockImplementation((_runId, options) => {
      signal = options?.signal
      return new Promise(() => {})
    })

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(tasksApi.getRunDeliveries).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(signal?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(signal?.aborted).toBe(true)
  })

  it('re-checks a still-pending delivery after a later refresh instead of caching it', async () => {
    // The `pending` row is written just before the send, so the first fetch for
    // a terminal run can legitimately see `pending`. Caching that pins
    // "Sending" on the row even after the platform accepted the message, so a
    // later list refresh has to be able to replace it.
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries)
      .mockResolvedValueOnce({ deliveries: [delivery('telegram', 'pending')] })
      .mockResolvedValue({ deliveries: [delivery('telegram', 'delivered')] })

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Sending'))

    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'))
  })

  it('re-checks a terminal run whose delivery record had not been written yet', async () => {
    // The server writes nothing until the run's notification is queued, so an
    // empty first answer is provisional rather than "not sent".
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries)
      .mockResolvedValueOnce({ deliveries: [] })
      .mockResolvedValue({ deliveries: [delivery('telegram', 'delivered')] })

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent'))

    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'))
  })

  it('stops re-checking once the recorded outcomes are settled', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fetchRuns = vi.fn(async () => [terminalRun])
    useTaskStore.setState({
      tasks: [{
        id: 'task-1',
        name: 'Daily summary',
        cron: '0 9 * * *',
        prompt: 'Summarize',
        enabled: true,
        createdAt: 0,
        notification: { enabled: true, channels: ['telegram'], recipients: { telegram: ['111'] } },
      }],
      fetchTaskRuns: fetchRuns,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const getDeliveries = vi.mocked(tasksApi.getRunDeliveries).mockResolvedValue({
      deliveries: [delivery('telegram', 'delivered')],
    })

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'))
    expect(getDeliveries).toHaveBeenCalledTimes(1)

    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchRuns.mock.calls.length).toBeGreaterThanOrEqual(2))
    // A delivered/failed/indeterminate set is final for the run; re-asking would
    // only ever repeat the answer.
    expect(getDeliveries).toHaveBeenCalledTimes(1)
  })

  it('auto re-checks a pending delivery without an external refreshKey change', async () => {
    // `pending` is written just before the send, so a run that flipped to
    // terminal moments ago legitimately shows "Sending". Nothing external
    // re-triggers the panel here, so its own poll must replace the provisional
    // answer once the platform settles it.
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [configuredTask],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const getDeliveries = vi.mocked(tasksApi.getRunDeliveries)
      .mockResolvedValueOnce({ deliveries: [delivery('telegram', 'pending')] })
      .mockResolvedValue({ deliveries: [delivery('telegram', 'delivered')] })

    render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Sending'))

    await waitFor(
      () => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'),
      { timeout: 4000 },
    )
    expect(getDeliveries.mock.calls.length).toBeGreaterThan(1)
  })

  it('auto re-checks an empty record on a task that expects an IM notification', async () => {
    // The run row can flip to terminal before the server has enqueued the send,
    // so an empty answer on a configured task is a race, not "not sent".
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [configuredTask],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    vi.mocked(tasksApi.getRunDeliveries)
      .mockResolvedValueOnce({ deliveries: [] })
      .mockResolvedValue({ deliveries: [delivery('telegram', 'delivered')] })

    render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent'))

    await waitFor(
      () => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Delivered'),
      { timeout: 4000 },
    )
  })

  it('stops re-checking an empty record once the bounded window has passed', async () => {
    // The empty answer is a race only inside the initial window; a task that
    // records nothing by then must not be polled forever.
    vi.useFakeTimers()
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [configuredTask],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)
    const getDeliveries = vi.mocked(tasksApi.getRunDeliveries).mockResolvedValue({ deliveries: [] })

    render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    await flushFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    await flushFakeTimers()
    expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent')

    await act(async () => { await vi.advanceTimersByTimeAsync(11000) })
    const withinWindow = getDeliveries.mock.calls.length
    // The empty answer is re-checked on the fast poll inside the window ...
    expect(withinWindow).toBeGreaterThan(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(getDeliveries).toHaveBeenCalledTimes(withinWindow)
  })

  it('leaves an empty record alone when the task has no IM notification configured', async () => {
    // With notifications off nothing will ever be written, so "not configured"
    // is final and the panel must not poll for it.
    vi.useFakeTimers()
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      tasks: [{
        ...configuredTask,
        notification: { enabled: false, channels: ['telegram'], recipients: { telegram: ['111'] } },
      }],
      fetchTaskRuns: vi.fn(async () => [terminalRun]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)
    const getDeliveries = vi.mocked(tasksApi.getRunDeliveries).mockResolvedValue({ deliveries: [] })

    render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    await flushFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    await flushFakeTimers()
    expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Notifications not configured')

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getDeliveries).toHaveBeenCalledTimes(1)
  })
})

describe('TaskRunsPanel', () => {
  it('renders scheduled task summaries as markdown', async () => {
    const run: TaskRun = {
      id: 'run-1',
      taskId: 'task-1',
      taskName: 'Daily summary',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'Summarize recent commits',
      output: '最近7天有3个commit，主要改动：\n\n**1. 2865d50 - UI无障碍改进**\n- 添加 theme-color meta 标签\n- 修复 select 标签问题',
      durationMs: 12000,
      sessionId: 'session-1',
    }
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [run]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const { container } = render(
      <TaskRunsPanel taskId="task-1" onClose={vi.fn()} />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Summary' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))

    expect(screen.getByText('1. 2865d50 - UI无障碍改进')).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('1. 2865d50 - UI无障碍改进')
    expect(screen.getByText('添加 theme-color meta 标签')).toBeInTheDocument()
    expect(container.querySelector('li')).toHaveTextContent('添加 theme-color meta 标签')
    expect(container.textContent).not.toContain('**1. 2865d50')
    // Flush the notification-status load so its state update lands inside act.
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent'))
  })

  it('keeps large output out of the list response and loads detail only when expanded', async () => {
    const summary: TaskRun = {
      id: 'run-summary',
      taskId: 'task-1',
      taskName: 'Daily summary',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'Summarize',
      hasOutput: true,
      outputPreview: 'preview only',
    }
    let resolveDetail: (run: TaskRun) => void = () => {}
    const detail = new Promise<TaskRun>((resolve) => { resolveDetail = resolve })
    const fetchDetail = vi.fn(() => detail)
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)

    const summaryButton = await screen.findByRole('button', { name: 'Summary' })
    expect(screen.queryByText('full detail loaded lazily')).not.toBeInTheDocument()
    expect(fetchDetail).not.toHaveBeenCalled()
    fireEvent.click(summaryButton)
    await waitFor(() => expect(fetchDetail).toHaveBeenCalledWith(
      'run-summary',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No output')).not.toBeInTheDocument()
    resolveDetail({
      ...summary,
      output: '**full detail loaded lazily**',
    })
    expect(await screen.findByText('full detail loaded lazily')).toBeInTheDocument()
  })

  it('aborts an in-flight detail request on collapse', async () => {
    const summary: TaskRun = {
      id: 'run-abort',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let detailSignal: AbortSignal | undefined
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: vi.fn((_runId: string, options?: { signal?: AbortSignal }) => {
        detailSignal = options?.signal
        return new Promise<TaskRun>(() => {})
      }),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(detailSignal).toBeDefined())
    expect(detailSignal?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(detailSignal?.aborted).toBe(true)
  })

  it('shows a detail failure and retries without requiring collapse', async () => {
    const summary: TaskRun = {
      id: 'run-retry',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    const fetchDetail = vi.fn()
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValueOnce({ ...summary, output: 'detail after retry' })
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    expect(await screen.findByText('Error')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('detail after retry')).toBeInTheDocument()
    expect(fetchDetail).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale list response after the selected task changes', async () => {
    let resolveOld: (runs: TaskRun[]) => void = () => {}
    const oldRequest = new Promise<TaskRun[]>((resolve) => { resolveOld = resolve })
    const fetchRuns = vi.fn((taskId: string) => taskId === 'old-task'
      ? oldRequest
      : Promise.resolve([{
        id: 'new-run',
        taskId: 'new-task',
        taskName: 'New',
        startedAt: '2026-05-08T12:05:37.000Z',
        status: 'failed' as const,
        prompt: 'new',
      }]))
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({ fetchTaskRuns: fetchRuns } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="old-task" onClose={vi.fn()} />)
    view.rerender(<TaskRunsPanel taskId="new-task" onClose={vi.fn()} />)
    await screen.findByText('Failed')
    resolveOld([{
      id: 'old-run',
      taskId: 'old-task',
      taskName: 'Old',
      startedAt: '2025-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'old',
    }])
    await Promise.resolve()

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('Completed')).not.toBeInTheDocument()
  })

  it('does not let a slow detail response overwrite a newer list generation', async () => {
    const summary: TaskRun = {
      id: 'same-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let resolveDetail: (run: TaskRun) => void = () => {}
    const detailRequest = new Promise<TaskRun>((resolve) => { resolveDetail = resolve })
    let listCalls = 0
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => {
        listCalls += 1
        return listCalls === 1 ? [summary] : [{ ...summary, output: 'newer list output' }]
      }),
      fetchTaskRunDetail: vi.fn(() => detailRequest),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)
    expect(await screen.findByText('newer list output')).toBeInTheDocument()

    await act(async () => {
      resolveDetail({ ...summary, output: 'stale detail output' })
      await detailRequest
    })

    await waitFor(() => expect(screen.getByText('newer list output')).toBeInTheDocument())
    expect(screen.queryByText('stale detail output')).not.toBeInTheDocument()
  })

  it('keeps loaded detail visible across later summary-only polls', async () => {
    const summary: TaskRun = {
      id: 'run-cached-detail',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    const fetchRuns = vi.fn(async () => [summary])
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: fetchRuns,
      fetchTaskRunDetail: vi.fn(async () => ({
        ...summary,
        output: 'cached detail output',
      })),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    expect(await screen.findByText('cached detail output')).toBeInTheDocument()

    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchRuns).toHaveBeenCalledTimes(2))
    expect(screen.getByText('cached detail output')).toBeInTheDocument()
  })

  it('discards a slow detail response after collapse and retries on the next expansion', async () => {
    const summary: TaskRun = {
      id: 'run-collapse',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let resolveFirst: (run: TaskRun) => void = () => {}
    const firstDetail = new Promise<TaskRun>((resolve) => { resolveFirst = resolve })
    const fetchDetail = vi.fn()
      .mockReturnValueOnce(firstDetail)
      .mockReturnValue(new Promise<TaskRun>(() => {}))
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await act(async () => {
      resolveFirst({ ...summary, output: 'discarded detail' })
      await firstDetail
    })

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    expect(fetchDetail).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('discarded detail')).not.toBeInTheDocument()
    // Flush the re-fetched notification status so its update lands inside act.
    await waitFor(() => expect(screen.getByTestId('run-delivery-telegram')).toHaveTextContent('Not sent'))
  })

  it('resets selection and rejects old detail after the selected task changes', async () => {
    const summary = (taskId: string): TaskRun => ({
      id: 'shared-run-id',
      taskId,
      taskName: taskId,
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: taskId,
      hasOutput: true,
    })
    let resolveOldDetail: (run: TaskRun) => void = () => {}
    const oldDetail = new Promise<TaskRun>((resolve) => { resolveOldDetail = resolve })
    const fetchDetail = vi.fn(() => oldDetail)
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async (taskId: string) => [summary(taskId)]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="old-task" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    view.rerender(<TaskRunsPanel taskId="new-task" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Summary' })).toBeInTheDocument())
    await act(async () => {
      resolveOldDetail({ ...summary('old-task'), output: 'old task detail' })
      await oldDetail
    })

    expect(screen.queryByText('old task detail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument()
  })

  it('keeps lazy detail functional through the StrictMode effect lifecycle', async () => {
    const summary: TaskRun = {
      id: 'strict-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: vi.fn(async () => ({ ...summary, output: 'strict detail' })),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(
      <StrictMode>
        <TaskRunsPanel taskId="task-1" onClose={vi.fn()} />
      </StrictMode>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    expect(await screen.findByText('strict detail')).toBeInTheDocument()
  })
})
