import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useAdapterStore } from '../../stores/adapterStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { CreateTaskInput, CronTask, TaskUpdateInput } from '../../types/task'

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

    it('keeps the original name resolution for a stored Feishu recipient', () => {
      // Feishu is untouched by the Telegram entrypoint work: a stored spec that
      // carries only a name is still matched against the current pairings, and
      // the edit form still fills the select in as soon as they have loaded.
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {
          feishu: {
            appId: 'app-id',
            appSecret: 'app-secret',
            pairedUsers: [{ userId: 'ou_1', displayName: 'Fei', pairedAt: 1 }],
          },
        },
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)

      render(
        <NewTaskModal
          open
          onClose={vi.fn()}
          editTask={{
            ...baseTask,
            notification: {
              enabled: true,
              channels: ['feishu'],
              recipients: { feishu: [{ displayName: 'Fei' }] },
            },
          }}
        />,
      )

      const recipient = screen.getByLabelText(/^Feishu · Notification recipient/)
      expect(recipient).toHaveValue('ou_1')
      expect(within(recipient).getByRole('option', { name: 'Fei (ou_1)' })).toBeInTheDocument()
    })
  })

  // The run timeout belongs to the individual task: there is no global settings
  // endpoint to fall back on, so every create/edit must carry its own value.
  describe('per-task timeout', () => {
    function renderModal(editTask?: CronTask) {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {},
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} editTask={editTask} />)
    }

    function fillRequiredFields() {
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'timeout task' } })
      fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'desc' } })
      fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
        target: { value: 'prompt' },
      })
    }

    it('sends the entered seconds to the server as milliseconds on create', async () => {
      const createTask = vi.fn(async () => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal()
      fillRequiredFields()

      fireEvent.change(screen.getByLabelText(/Timeout per run/), { target: { value: '90' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90_000 }))
    })

    it('omits the field on create when blank so the server default applies', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal()
      fillRequiredFields()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      // A `timeoutMs: undefined` key would serialize away too, but asserting the
      // absent property keeps the contract explicit.
      expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty('timeoutMs')
    })

    it('reloads the persisted value into the field when editing', () => {
      renderModal({ ...baseTask, timeoutMs: 120_000 })
      expect(screen.getByLabelText(/Timeout per run/)).toHaveValue('120')
    })

    it('clears a saved timeout by sending null when the field is emptied', async () => {
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal({ ...baseTask, timeoutMs: 120_000 })

      fireEvent.change(screen.getByLabelText(/Timeout per run/), { target: { value: '' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ timeoutMs: null }))
    })

    it('treats a task stored before the field existed as empty', () => {
      renderModal(baseTask)
      expect(screen.getByLabelText(/Timeout per run/)).toHaveValue('')
    })

    it('sends an edited seconds value to the server as milliseconds', async () => {
      // 1800s is a normal in-range edit: 30 minutes as 1_800_000 ms, not the
      // previous 120_000 and not the raw seconds value.
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal({ ...baseTask, timeoutMs: 120_000 })

      fireEvent.change(screen.getByLabelText(/Timeout per run/), { target: { value: '1800' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ timeoutMs: 1_800_000 }))
    })

    it('blocks the save instead of accepting a value past the ceiling', async () => {
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal({ ...baseTask, timeoutMs: 120_000 })

      // 2147483.648s is one millisecond past 2_147_483_647 ms, the largest
      // delay `setTimeout` accepts; storing it would arm a timer that fires
      // immediately.
      fireEvent.change(screen.getByLabelText(/Timeout per run/), { target: { value: '2147483.648' } })

      expect(screen.getByRole('alert')).toHaveTextContent(/up to/)
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })
      expect(updateTask).not.toHaveBeenCalled()
    })

    it('blocks the save instead of accepting zero', async () => {
      const createTask = vi.fn(async () => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal()
      fillRequiredFields()

      fireEvent.change(screen.getByLabelText(/Timeout per run/), { target: { value: '0' } })

      expect(screen.getByRole('alert')).toHaveTextContent(/greater than 0/)
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })
      expect(createTask).not.toHaveBeenCalled()
    })
  })

  // Telegram can deliver through the dedicated Bot, the public Bot, or both.
  // The choice is stored as `notification.telegramEntrypoints`, but the sender
  // identity stays the single explicit Telegram recipient the task already has.
  describe('telegram delivery route', () => {
    const DEDICATED_PAIRED = {
      botToken: 'bot-token',
      pairedUsers: [
        { userId: '111', displayName: 'Alice', pairedAt: 1 },
        { userId: '222', displayName: 'Bob', pairedAt: 1 },
      ],
    }

    const PUBLIC_OWNER = {
      botToken: 'bot-token',
      pairedUsers: [{ userId: '111', displayName: 'Alice', pairedAt: 1 }],
      public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
    }

    // Truly public-only: no dedicated token and no dedicated pairings. A public
    // task must still be creatable here, because the public Bot reaches its own
    // owner without the dedicated Bot being configured at all.
    const PUBLIC_ONLY = {
      public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
    }

    function renderModal(editTask?: CronTask, telegram: Record<string, unknown> = DEDICATED_PAIRED) {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: { telegram },
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} editTask={editTask} />)
    }

    function fillRequiredFields() {
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'route task' } })
      fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'desc' } })
      fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
        target: { value: 'prompt' },
      })
    }

    async function clickCreate() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
        await Promise.resolve()
      })
    }

    it('defaults to the dedicated Bot and omits the field on create', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(undefined, DEDICATED_PAIRED)

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      expect(screen.getByLabelText('Delivery route')).toHaveValue('dedicated')
      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '222' } })

      await clickCreate()

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      const input = createTask.mock.calls[0]?.[0] as CreateTaskInput
      // The default must not be written: an absent field means dedicated, so a
      // file that predates the option still loads and behaves identically.
      expect(input.notification).not.toHaveProperty('telegramEntrypoints')
      expect(input.notification).toMatchObject({
        enabled: true,
        recipients: { telegram: [{ userId: '222', displayName: 'Bob' }] },
      })
    })

    it('reads a task stored before the field as dedicated and keeps its recipient', async () => {
      renderModal({
        ...baseTask,
        notification: {
          enabled: true,
          channels: ['telegram'],
          recipients: { telegram: [{ userId: '222', displayName: 'Bob' }] },
        },
      })

      const route = await screen.findByLabelText('Delivery route')
      expect(route).toHaveValue('dedicated')
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('222')
    })

    it('offers the public owner when only the public route is selected', () => {
      renderModal(undefined, PUBLIC_OWNER)

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      const recipient = screen.getByLabelText(/Notification recipient/)
      expect(within(recipient).getByRole('option', { name: '999' })).toBeInTheDocument()
      expect(within(recipient).queryByRole('option', { name: /Alice/ })).toBeNull()
    })

    it('warns instead of switching the route when the public Bot is disabled', () => {
      renderModal(undefined, {
        botToken: 'bot-token',
        pairedUsers: [{ userId: '111', displayName: 'Alice', pairedAt: 1 }],
        public: { enabled: false, ownerUserId: 999 },
      })

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      expect(screen.getByRole('alert')).toHaveTextContent(/public Bot is off/i)
      expect(screen.getByLabelText('Delivery route')).toHaveValue('public')
    })

    it('warns when the public Bot has no paired owner', () => {
      renderModal(undefined, {
        botToken: 'bot-token',
        pairedUsers: [{ userId: '111', displayName: 'Alice', pairedAt: 1 }],
        public: { enabled: true, botToken: 'public-bot-token' },
      })

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      expect(screen.getByRole('alert')).toHaveTextContent(/no paired owner/i)
    })

    it('keeps Telegram unavailable when the public Bot has no usable owner id', () => {
      // The public route only counts as configured with a token, the enabled
      // flag, and a positive safe-integer owner id. `0` is not a Telegram user
      // id, so this config cannot deliver and must not offer the channel.
      renderModal(undefined, {
        public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 0 },
      })

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      const telegramChannel = screen.getByLabelText(/Telegram/)
      expect(telegramChannel).toBeDisabled()
      expect(telegramChannel.closest('label')).toHaveTextContent('Not configured')
    })

    it('saves the public route with the owner as the explicit recipient', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(undefined, PUBLIC_OWNER)

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      // The public route does not pre-select the owner: choosing the recipient
      // is the authorization act, so it has to be explicit.
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('')
      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '999' } })

      await clickCreate()

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      const input = createTask.mock.calls[0]?.[0] as CreateTaskInput
      expect(input.notification).toMatchObject({
        enabled: true,
        telegramEntrypoints: ['public'],
      })
      // A public-only owner is synthesized from the config, so there is no
      // dedicated `displayName` to write and the spec is id-only.
      expect(input.notification?.recipients).toEqual({ telegram: [{ userId: 999 }] })
    })

    it('saves a public-only task when no dedicated Bot token or pairing exists', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(undefined, PUBLIC_ONLY)

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))

      const telegram = screen.getByLabelText(/Telegram/)
      expect(telegram).not.toBeDisabled()
      fireEvent.click(telegram)
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      const recipient = screen.getByLabelText(/Notification recipient/)
      expect(within(recipient).getByRole('option', { name: '999' })).toBeInTheDocument()
      fireEvent.change(recipient, { target: { value: '999' } })

      await clickCreate()

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      const input = createTask.mock.calls[0]?.[0] as CreateTaskInput
      expect(input.notification).toMatchObject({
        enabled: true,
        telegramEntrypoints: ['public'],
      })
      // The whole spec, not just the id: the synthesized public owner has no
      // dedicated name, and the server rejects a recipient whose `displayName`
      // is empty, so the field must be absent entirely.
      expect(input.notification?.recipients).toEqual({ telegram: [{ userId: 999 }] })
    })

    it('saves both routes when the recipient is owner and dedicated-paired', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(undefined, {
        botToken: 'bot-token',
        pairedUsers: [{ userId: '999', displayName: 'Owner', pairedAt: 1 }],
        public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
      })

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'both' } })
      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '999' } })

      await clickCreate()

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      const input = createTask.mock.calls[0]?.[0] as CreateTaskInput
      expect(input.notification).toMatchObject({
        telegramEntrypoints: ['dedicated', 'public'],
        recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
      })
    })

    it('lists only the owner for the both routes, never a dedicated-only user', () => {
      // One explicit recipient has to satisfy both entries, so a user who is
      // only dedicated-paired (Alice) cannot be the both-routes target.
      renderModal(undefined, {
        botToken: 'bot-token',
        pairedUsers: [
          { userId: '111', displayName: 'Alice', pairedAt: 1 },
          { userId: '999', displayName: 'Owner', pairedAt: 1 },
        ],
        public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
      })

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'both' } })

      const recipient = screen.getByLabelText(/Notification recipient/)
      expect(within(recipient).queryByRole('option', { name: /Alice/ })).toBeNull()
      expect(within(recipient).getByRole('option', { name: 'Owner (999)' })).toBeInTheDocument()
    })

    it('keeps the saved both-routes selection when editing', () => {
      renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            telegramEntrypoints: ['dedicated', 'public'],
            recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
          },
        },
        {
          botToken: 'bot-token',
          pairedUsers: [{ userId: '999', displayName: 'Owner', pairedAt: 1 }],
          public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
        },
      )

      expect(screen.getByLabelText('Delivery route')).toHaveValue('both')
    })

    it('keeps a stored public recipient instead of silently swapping it to the current owner', async () => {
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            telegramEntrypoints: ['public'],
            recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
          },
        },
        {
          botToken: 'bot-token',
          pairedUsers: [{ userId: '888', displayName: 'New Owner', pairedAt: 1 }],
          public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 888 },
        },
      )

      // The owner changed since this task was saved. The edit form must not
      // retarget the send on its own: the stored recipient stays put, kept
      // visible as an unavailable option, and saving is blocked until the user
      // explicitly picks the current owner.
      expect(screen.getByLabelText('Delivery route')).toHaveValue('public')
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('999')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })
      expect(updateTask).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(/recipient/i)

      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '888' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        notification: expect.objectContaining({
          telegramEntrypoints: ['public'],
          recipients: { telegram: [{ userId: 888, displayName: 'New Owner' }] },
        }),
      }))
    })

    it('preserves a stored public recipient that is still the current owner', async () => {
      const updateTask = vi.fn(async (_id: string, _updates: TaskUpdateInput) => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            telegramEntrypoints: ['public'],
            recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
          },
        },
        {
          botToken: 'bot-token',
          pairedUsers: [],
          public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
        },
      )

      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('999')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      const payload = updateTask.mock.calls[0]?.[1] as { notification?: unknown }
      expect(payload.notification).toMatchObject({
        telegramEntrypoints: ['public'],
        recipients: { telegram: [{ userId: 999 }] },
      })
    })

    it('keeps the original name resolution on the dedicated route', async () => {
      // Baseline for the pre-existing behavior: on the dedicated route a stored
      // spec that carries only a name is still matched against the current
      // pairings by name, and saving keeps that resolved recipient. The new
      // public/both routes are the only ones with the stricter id-only rule, so
      // they must not tighten this path.
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            recipients: { telegram: [{ displayName: 'Bob' }] },
          },
        },
        DEDICATED_PAIRED,
      )

      // The stored name still resolves against the current pairings, so the
      // select is filled in without the user touching it.
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('222')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        notification: expect.objectContaining({
          recipients: { telegram: [{ userId: '222', displayName: 'Bob' }] },
        }),
      }))
    })

    it('does not adopt the current owner for a stored public recipient that carries no id', async () => {
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            telegramEntrypoints: ['public'],
            recipients: { telegram: [{ displayName: 'Owner' }] },
          },
        },
        {
          botToken: 'bot-token',
          pairedUsers: [{ userId: '888', displayName: 'Owner', pairedAt: 1 }],
          public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 888 },
        },
      )

      // The stored target has no id, so the name match against the current owner
      // must not be treated as the stored target coming back.
      expect(screen.getByLabelText('Delivery route')).toHaveValue('public')
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })
      expect(updateTask).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(/recipient/i)

      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '888' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
        await Promise.resolve()
      })

      await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        notification: expect.objectContaining({
          telegramEntrypoints: ['public'],
          recipients: { telegram: [{ userId: 888, displayName: 'Owner' }] },
        }),
      }))
    })

    it('does not re-apply the stored recipient after the user clears the select', async () => {
      const { rerender } = renderModal(
        {
          ...baseTask,
          notification: {
            enabled: true,
            channels: ['telegram'],
            telegramEntrypoints: ['public'],
            recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
          },
        },
        PUBLIC_OWNER,
      )

      const recipient = screen.getByLabelText(/Notification recipient/)
      expect(recipient).toHaveValue('999')

      // Clearing the select is an explicit choice, not an empty form.
      fireEvent.change(recipient, { target: { value: '' } })
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('')

      // The owner record changes while the form is open; the clear must hold.
      await act(async () => {
        useAdapterStore.setState({
          config: {
            telegram: {
              botToken: 'bot-token',
              pairedUsers: [{ userId: '111', displayName: 'Alice', pairedAt: 2 }],
              public: { enabled: true, botToken: 'public-bot-token', ownerUserId: 999 },
            },
          },
        } as Partial<ReturnType<typeof useAdapterStore.getState>>)
        await Promise.resolve()
      })
      rerender(<NewTaskModal open onClose={vi.fn()} editTask={{
        ...baseTask,
        notification: {
          enabled: true,
          channels: ['telegram'],
          telegramEntrypoints: ['public'],
          recipients: { telegram: [{ userId: '999', displayName: 'Owner' }] },
        },
      }} />)

      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('')
    })

    it('does not retarget the recipient when only the route is switched', () => {
      renderModal(undefined, PUBLIC_OWNER)

      fireEvent.click(screen.getByLabelText(/Push notification on completion/))
      fireEvent.click(screen.getByLabelText(/Telegram/))
      // Dedicated is the default; pick a dedicated user there...
      fireEvent.change(screen.getByLabelText(/Notification recipient/), { target: { value: '111' } })
      // ...then switch to the public route without touching the recipient.
      fireEvent.change(screen.getByLabelText('Delivery route'), { target: { value: 'public' } })

      // Switching routes must not quietly re-target the send.
      expect(screen.getByLabelText(/Notification recipient/)).toHaveValue('111')
    })

    it('omits the route field when Telegram is not one of the channels', async () => {
      const createTask = vi.fn(async (_input: CreateTaskInput) => {})
      useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      renderModal(undefined, DEDICATED_PAIRED)

      fillRequiredFields()
      fireEvent.click(screen.getByLabelText(/Push notification on completion/))

      // Enabling notifications defaults to the Desktop channel, which is not
      // Telegram, so the route control must not be rendered at all.
      expect(screen.queryByLabelText('Delivery route')).toBeNull()

      await clickCreate()

      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
      const input = createTask.mock.calls[0]?.[0] as CreateTaskInput
      expect(input.notification).toBeDefined()
      expect(input.notification).not.toHaveProperty('telegramEntrypoints')
    })
  })
})
