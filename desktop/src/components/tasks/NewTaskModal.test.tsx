import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useAdapterStore } from '../../stores/adapterStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { CronTask } from '../../types/task'

const baseTask: CronTask = {
  id: 'task-1',
  name: 'daily-code-review',
  description: 'Review yesterday’s commits',
  cron: '0 9 * * *',
  prompt: 'Look at the commits',
  enabled: true,
  createdAt: Date.parse('2026-07-26T09:00:00.000Z'),
}

afterEach(() => {
  cleanup()
  useAdapterStore.setState(useAdapterStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('NewTaskModal', () => {
  it('creates scheduled tasks with a provider-scoped model selection', async () => {
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useAdapterStore.setState({
      fetchConfig: vi.fn(async () => {}),
      config: {},
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useSettingsStore.setState({
      locale: 'en',
      currentModel: {
        id: 'provider-main',
        name: 'provider-main',
        description: '',
        context: '',
      },
      availableModels: [
        { id: 'claude-sonnet-4-6', name: 'Sonnet', description: '', context: '' },
      ],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'provider cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise provider selection' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-main/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-fast/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'provider-fast',
      providerId: 'provider-a',
      permissionMode: 'bypassPermissions',
      enabled: true,
      recurring: true,
    }))
  })

  it('defaults the folder to the project root when the active session ran in an isolated worktree', async () => {
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useAdapterStore.setState({
      fetchConfig: vi.fn(async () => {}),
      config: {},
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [{
        id: 'wt-1',
        title: 'Worktree Session',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 3,
        projectPath: '/workspace/repo',
        projectRoot: '/workspace/repo',
        workDir: '/workspace/repo/.claude/worktrees/desktop-main-12345678',
        workDirExists: true,
      }],
      activeSessionId: 'wt-1',
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'worktree cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise worktree folder default' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      folderPath: '/workspace/repo',
    }))
  })

  describe('schedule controls', () => {
    function renderModal() {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {},
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} />)
    }

    it('gives the frequency select a name', () => {
      // All seven native selects in the app shipped without a label or an
      // `aria-label`, leaving them nameless in the accessibility tree.
      renderModal()
      expect(screen.getByLabelText('Frequency')).toHaveValue('daily')
    })

    it('names the time field even though it shares the frequency caption', () => {
      // One「频率」heading covers both controls, so the time input carries its
      // name on `aria-label` rather than a second visible label.
      renderModal()
      expect(screen.getByLabelText('Run time')).toHaveValue('09:00')
    })

    it('announces an invalid custom cron instead of only printing it', () => {
      renderModal()
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'customCron' } })

      const cronField = screen.getByLabelText('Custom cron expression')
      fireEvent.change(cronField, { target: { value: 'not a cron' } })

      expect(screen.getByRole('alert')).toHaveTextContent('Invalid cron expression')
      expect(cronField).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
    })
  })

  describe('notification recipients', () => {
    const pairedTelegram = {
      botToken: 'bot-token',
      pairedUsers: [
        { userId: '111', displayName: 'Alice', pairedAt: 1 },
        { userId: '222', displayName: 'Bob', pairedAt: 1 },
      ],
    }

    function renderModal(editTask?: CronTask, telegram: Record<string, unknown> = pairedTelegram) {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: { telegram },
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} editTask={editTask} />)
    }

    function fillRequiredFields() {
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'notify me' } })
      fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'desc' } })
      fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
        target: { value: 'prompt' },
      })
    }

    it('sends one explicitly chosen paired recipient instead of broadcasting', async () => {
      const createTask = vi.fn(async () => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal()

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))

      const recipient = screen.getByLabelText(/Notification recipient/)
      expect(within(recipient).getByRole('option', { name: /Alice/ })).toBeInTheDocument()
      expect(within(recipient).getByRole('option', { name: /Bob/ })).toBeInTheDocument()
      fireEvent.change(recipient, { target: { value: '222' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        notification: expect.objectContaining({
          enabled: true,
          channels: expect.arrayContaining(['telegram']),
          recipients: { telegram: [{ userId: '222', displayName: 'Bob' }] },
        }),
      }))
    })

    it('requires choosing one of several paired recipients before saving', async () => {
      const createTask = vi.fn(async () => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal()

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })

      expect(createTask).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(/recipient/i)
    })

    it('refuses to silently drop a legacy notification that has no recipients', async () => {
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal({
        ...baseTask,
        notification: { enabled: true, channels: ['telegram'] },
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      expect(updateTask).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(/recipient/i)
    })

    it('disables an IM channel when the platform has no paired recipient', () => {
      // `allowedUsers` is an access allowlist, not a notification target set —
      // the server only ever resolves recipients against `pairedUsers`.
      renderModal(undefined, { botToken: 'bot-token', allowedUsers: [111, 222], pairedUsers: [] })

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      expect(screen.getByLabelText(/Telegram/)).toBeDisabled()
    })
  })
})
