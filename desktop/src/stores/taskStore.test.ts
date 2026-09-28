import { afterEach, describe, expect, it, vi } from 'vitest'
import { tasksApi } from '../api/tasks'
import type { CronTask } from '../types/task'
import { useTaskStore } from './taskStore'

vi.mock('../api/tasks', () => ({
  tasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runTask: vi.fn(),
    getRecentRuns: vi.fn(),
    getTaskRuns: vi.fn(),
    getRunDetail: vi.fn(),
  },
}))

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    name: 'daily-code-review',
    description: 'Review yesterday’s commits',
    cron: '0 9 * * *',
    prompt: 'Look at the commits',
    enabled: true,
    createdAt: Date.parse('2026-07-26T09:00:00.000Z'),
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('taskStore', () => {
  it('replaces the task with the server response on a successful update', async () => {
    const updated = makeTask({ enabled: false })
    vi.mocked(tasksApi.update).mockResolvedValue({ task: updated })
    useTaskStore.setState({ tasks: [makeTask()] })

    await useTaskStore.getState().updateTask('task-1', { enabled: false })

    expect(tasksApi.update).toHaveBeenCalledWith('task-1', { enabled: false })
    expect(useTaskStore.getState().tasks).toEqual([updated])
  })

  it('propagates update failures and leaves the cached task untouched', async () => {
    // The row awaits this promise and renders the rejection; if the store
    // swallowed it the toggle would look like it succeeded while the server
    // state stayed the same.
    vi.mocked(tasksApi.update).mockRejectedValue(new Error('network down'))
    useTaskStore.setState({ tasks: [makeTask()] })

    await expect(
      useTaskStore.getState().updateTask('task-1', { enabled: false }),
    ).rejects.toThrow('network down')

    expect(useTaskStore.getState().tasks).toEqual([makeTask()])
  })
})