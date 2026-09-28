import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TaskRow } from './TaskRow'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { CronTask } from '../../types/task'

const task: CronTask = {
  id: 'task-1',
  name: 'daily-code-review',
  description: 'Review yesterday’s commits',
  cron: '*/20 * * * *',
  prompt: 'Look at the commits',
  enabled: true,
  createdAt: Date.parse('2026-07-26T09:00:00.000Z'),
  lastFiredAt: '2026-07-26T09:20:00.000Z',
}

function renderRow(props: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  useSettingsStore.setState({ locale: 'en' })
  return render(
    <TaskRow task={task} showLogs={false} onToggleLogs={vi.fn()} {...props} />,
  )
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('TaskRow', () => {
  it('exposes the logs toggle as a pressed state rather than a background class', () => {
    // The open state used to be a bare `bg-[…]` override, which is invisible to
    // assistive tech and could lose to the tone's own hover fill depending on
    // stylesheet order.
    const { rerender } = renderRow()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'false')

    rerender(<TaskRow task={task} showLogs onToggleLogs={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reads the schedule out as one caption line with the raw cron on hover', () => {
    renderRow()
    expect(screen.getByTitle('*/20 * * * *')).toHaveTextContent('Runs every 20 minutes')
    // Created / last run / description used to be two stacked lines; the handoff
    // folds them into a single caption separated by middots.
    expect(screen.getByText(/Review yesterday/)).toHaveTextContent(/Created: .+ · Last run: .+ · Review/)
  })

  it('keeps the run button unavailable while the task is disabled', () => {
    renderRow({ task: { ...task, enabled: false } })
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
  })

  it('names the menu items by their label alone, not by the icon ligature', () => {
    // The material-symbols spans render their glyph name as text, so without
    // `aria-hidden` every menu item was announced as "edit Edit".
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('treats a task with no enabled flag as enabled', () => {
    // Older `scheduled_tasks.json` files predate the `enabled` field. The row
    // read `task.enabled` directly, so every legacy task rendered as disabled
    // and its Run button was unavailable.
    renderRow({ task: { ...task, enabled: undefined as unknown as boolean } })
    expect(screen.getByRole('status', { name: 'Active' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).not.toBeDisabled()
  })

  it('awaits the enable/disable update, surfaces failures, and ignores duplicate confirms', async () => {
    // Toggle used to fire `updateTask` without awaiting or catching: a failure
    // was an unhandled rejection with nothing on screen, and a second click on
    // the confirm button started a second write.
    let rejectUpdate!: (error: unknown) => void
    const updateTask = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject
    }))
    useTaskStore.setState({
      updateTask,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

    const confirm = screen.getByRole('button', { name: 'Disable' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith('task-1', { enabled: false })

    await act(async () => {
      rejectUpdate(new Error('network down'))
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('network down')
    expect(updateTask).toHaveBeenCalledTimes(1)
  })

  it('awaits the run, surfaces failures, and ignores duplicate confirms', async () => {
    // Run used to `console.error` a rejection with nothing on screen, and the
    // confirm popover closed before the request settled, so a second submit was
    // only blocked by the disabled trigger.
    let rejectRun!: (error: unknown) => void
    const runTask = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRun = reject
    }))
    useTaskStore.setState({
      runTask,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    const runConfirms = screen.getAllByRole('button', { name: 'Run now' })
    const confirm = runConfirms[runConfirms.length - 1]!
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(runTask).toHaveBeenCalledWith('task-1')

    await act(async () => {
      rejectRun(new Error('run failed'))
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('run failed')
    expect(runTask).toHaveBeenCalledTimes(1)
  })

  it('awaits the delete, surfaces failures, and ignores duplicate confirms', async () => {
    // Delete fired `deleteTask` as a floating promise: a rejection was an
    // unhandled rejection with nothing on screen, and every confirm click
    // started another delete.
    let rejectDelete!: (error: unknown) => void
    const deleteTask = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectDelete = reject
    }))
    useTaskStore.setState({
      deleteTask,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const confirm = screen.getByRole('button', { name: 'Delete' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(deleteTask).toHaveBeenCalledTimes(1)
    expect(deleteTask).toHaveBeenCalledWith('task-1')

    await act(async () => {
      rejectDelete(new Error('delete failed'))
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('delete failed')
    expect(deleteTask).toHaveBeenCalledTimes(1)
  })
})
