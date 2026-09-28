import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ScheduledTasks } from './ScheduledTasks'
import { useTaskStore } from '../stores/taskStore'
import { useSettingsStore } from '../stores/settingsStore'

afterEach(() => {
  cleanup()
  useTaskStore.setState(useTaskStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('ScheduledTasks', () => {
  it('guides desktop conversations to local tasks rather than the cloud /schedule command', () => {
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({ fetchTasks: vi.fn().mockResolvedValue(undefined), tasks: [] })

    render(<ScheduledTasks />)

    expect(screen.getByText(/Describe the local task you want to create or manage/)).toBeInTheDocument()
    expect(screen.queryByText('/schedule')).not.toBeInTheDocument()
  })
})