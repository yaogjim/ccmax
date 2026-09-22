import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { AboutSettings } from './AboutSettings'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'

const openMock = vi.fn()
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
      shell: {
        ...actual.getDesktopHost().shell,
        open: openMock,
      },
    }),
  }
})

describe('AboutSettings product identity', () => {
  beforeEach(() => {
    openMock.mockReset()
    openMock.mockResolvedValue(undefined)
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

  it('renders product identity without legacy author or social entries', async () => {
    render(<AboutSettings />)

    expect(screen.getByRole('heading', { name: 'ccmax' })).toBeInTheDocument()
    expect(screen.getByText('yaogjim/ccmax')).toBeInTheDocument()
    expect(screen.getByText('Report an Issue')).toBeInTheDocument()

    expect(screen.queryByText('程序员阿江-Relakkes')).not.toBeInTheDocument()
    expect(screen.queryByText('NanmiCoder')).not.toBeInTheDocument()
    expect(screen.queryByText('Bilibili')).not.toBeInTheDocument()
    expect(screen.queryByText('Douyin')).not.toBeInTheDocument()
    expect(screen.queryByText('Xiaohongshu')).not.toBeInTheDocument()
    expect(screen.queryByText('Social Media')).not.toBeInTheDocument()
    expect(screen.queryByText('Author')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Release Notes')).toBeInTheDocument()
    })
  })

  it('opens only product repository, releases, and issues links', async () => {
    render(<AboutSettings />)

    fireEvent.click(screen.getByText('yaogjim/ccmax').closest('button')!)
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith('https://github.com/yaogjim/ccmax')
    })

    openMock.mockClear()
    await waitFor(() => {
      expect(screen.getByText('Release Notes')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Release Notes'))
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith('https://github.com/yaogjim/ccmax/releases')
    })

    openMock.mockClear()
    fireEvent.click(screen.getByText('Report an Issue').closest('button')!)
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith('https://github.com/yaogjim/ccmax/issues')
    })

    expect(openMock).toHaveBeenCalledTimes(1)
    expect(openMock.mock.calls.every(([url]) => String(url).startsWith('https://github.com/yaogjim/ccmax'))).toBe(true)
  })
})