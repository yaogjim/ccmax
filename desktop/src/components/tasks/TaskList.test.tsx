import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TaskList } from './TaskList'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { CronTask } from '../../types/task'

const task: CronTask = {
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
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('TaskList', () => {
  it('counts a task with no enabled flag as active', () => {
    // The stats mirrored the row's truthiness check, so a legacy task with no
    // `enabled` field was counted as disabled while the backend treats it as on.
    useSettingsStore.setState({ locale: 'en' })
    render(<TaskList tasks={[{ ...task, enabled: undefined as unknown as boolean }]} />)

    expect(screen.getByText('Active').previousElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Disabled').previousElementSibling).toHaveTextContent('0')
  })
})