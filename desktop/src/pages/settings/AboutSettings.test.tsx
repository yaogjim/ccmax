import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { AboutSettings } from './AboutSettings'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'

const getVersionMock = vi.fn()

vi.mock('../../lib/desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopHost')>()
  return {
    ...actual,
    getDesktopHost: () => ({
      ...actual.getDesktopHost(),
      app: {
        ...actual.getDesktopHost().app,
        getVersion: getVersionMock,
      },
    }),
  }
})

describe('AboutSettings product identity', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
    getVersionMock.mockResolvedValue('0.5.3')
    useSettingsStore.setState({ locale: 'en' })
    useUpdateStore.setState({
      status: 'idle',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      checkForUpdates: vi.fn(),
      installUpdate: vi.fn(),
      initialize: vi.fn(),
    })
  })

  it('renders the app name, version and update card without legacy author or social entries', async () => {
    render(<AboutSettings />)

    expect(screen.getByRole('heading', { name: 'ccmax' })).toBeInTheDocument()
    expect(screen.getByText('App Updates')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Version 0.5.3')).toBeInTheDocument()
    })

    expect(screen.queryByText('程序员阿江-Relakkes')).not.toBeInTheDocument()
    expect(screen.queryByText('NanmiCoder')).not.toBeInTheDocument()
    expect(screen.queryByText('Bilibili')).not.toBeInTheDocument()
    expect(screen.queryByText('Douyin')).not.toBeInTheDocument()
    expect(screen.queryByText('Xiaohongshu')).not.toBeInTheDocument()
    expect(screen.queryByText('Social Media')).not.toBeInTheDocument()
    expect(screen.queryByText('Author')).not.toBeInTheDocument()
  })

  // The repository, release-notes and feedback rows were removed from this
  // panel. A test that only asserted the surviving copy would not notice them
  // being wired back in, so assert their absence directly.
  it('keeps the removed repository, release-notes and feedback entries out', async () => {
    render(<AboutSettings />)

    await waitFor(() => {
      expect(screen.getByText('App Updates')).toBeInTheDocument()
    })

    expect(screen.queryByText('yaogjim/ccmax')).not.toBeInTheDocument()
    expect(screen.queryByText('Release Notes')).not.toBeInTheDocument()
    expect(screen.queryByText('Report an Issue')).not.toBeInTheDocument()
    expect(screen.queryByText('If this project helps you, consider giving it a Star')).not.toBeInTheDocument()
    expect(screen.queryByText('Open a GitHub Issue for bugs or usage questions')).not.toBeInTheDocument()
  })
})