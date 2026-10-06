import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TelegramPublicSubscriptions } from '@/pages/TelegramPublicSubscriptions'
import { useSettingsStore } from '@/stores/settingsStore'
import type { TelegramPublicSubscription } from '@/api/adapters'
import type { SessionListItem } from '@/types/session'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listProjectHistory: vi.fn(),
  addTelegramPublicSubscription: vi.fn(),
  removeTelegramPublicSubscription: vi.fn(),
}))
vi.mock('@/api/sessions', () => ({ sessionsApi: mocks }))
vi.mock('@/api/adapters', () => ({ adaptersApi: mocks }))

function subscription(index: number): TelegramPublicSubscription {
  return { sessionId: `session-${index}`, shortId: `S${index}`, title: `Report ${index}`, project: index < 11 ? '/fixture/app' : '/fixture/docs' }
}
function session(id: string, projectRoot = '/fixture/app'): SessionListItem {
  return { id, title: `Candidate ${id}`, projectRoot, projectPath: '-fixture-app', workDir: projectRoot,
    workDirExists: true, messageCount: 2, createdAt: '2026-10-01', modifiedAt: '2026-10-02' }
}
function setup(subscriptions: TelegramPublicSubscription[] = [], overrides = {}) {
  const props = { subscriptions, canManage: true, loading: false, statusError: '', onChanged: vi.fn(async () => {}), onError: vi.fn(), ...overrides }
  const result = render(<TelegramPublicSubscriptions {...props} />)
  return { ...result, props }
}
async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose sessions to subscribe' }))
  const picker = within(screen.getByRole('region', { name: 'Choose sessions to subscribe' }))
  await waitFor(() => expect(picker.getByRole('combobox', { name: 'Project' })).not.toBeDisabled())
  return picker
}

beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  mocks.list.mockImplementation(async (params: { view?: string }) => params.view
    ? { sessions: [], total: 12, projects: [{ projectRoot: '/fixture/app', total: 11 }, { projectRoot: '/fixture/docs', total: 1 }] }
    : { sessions: [session('new')], total: 1 })
  mocks.listProjectHistory.mockResolvedValue({ sessions: [session('project')], nextCursor: null })
  mocks.addTelegramPublicSubscription.mockResolvedValue({})
  mocks.removeTelegramPublicSubscription.mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('TelegramPublicSubscriptions', () => {
  it('paginates subscriptions and searches the whole list, not just the visible page', () => {
    setup(Array.from({ length: 23 }, (_, index) => subscription(index)))
    expect(screen.getAllByRole('button', { name: 'Unsubscribe' })).toHaveLength(10)
    expect(screen.queryByText('Report 10')).not.toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('Report 10')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SESSION-22' } })
    expect(screen.getByText('Report 22')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Unsubscribe' })).toHaveLength(1)
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing' } })
    expect(screen.getByText('No matching subscriptions')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('23 subscriptions')).toBeInTheDocument()
  })

  it('filters subscribed sessions by project, resets the page, and searches short IDs', () => {
    setup(Array.from({ length: 23 }, (_, index) => subscription(index)))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: '/fixture/docs' } })
    expect(screen.getByText('12 subscriptions')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(screen.queryByText('Report 10')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'S22' } })
    expect(screen.getByText('Report 22')).toBeInTheDocument()
  })

  it('returns to a valid page when the last subscription on a page is removed', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => subscription(index))
    const result = setup(rows)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    await waitFor(() => expect(result.props.onChanged).toHaveBeenCalledTimes(1))
    expect(mocks.removeTelegramPublicSubscription).toHaveBeenCalledWith('session-10')
    result.rerender(<TelegramPublicSubscriptions {...result.props} subscriptions={rows.slice(0, 10)} />)
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument()
    expect(screen.getByText('Report 0')).toBeInTheDocument()
  })

  it('loads candidates only on opening and paginates all sessions on the server', async () => {
    mocks.list.mockImplementation(async (params: { view?: string; offset?: number }) => params.view
      ? { sessions: [], total: 11, projects: [] }
      : { sessions: [session(params.offset ? 'last' : 'first')], total: 11 })
    setup()
    expect(mocks.list).not.toHaveBeenCalled()
    const picker = await openPicker()
    await picker.findByText('Candidate first')
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await picker.findByText('Candidate last')
    expect(mocks.list).toHaveBeenCalledWith({ limit: 10, offset: 10 }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(picker.getByRole('button', { name: 'Next page' })).toBeDisabled()
    fireEvent.click(picker.getByRole('button', { name: 'Previous page' }))
    await picker.findByText('Candidate first')
  })

  it('selects a project and preserves cursor history for next and previous pages', async () => {
    mocks.listProjectHistory.mockImplementation(async (params: { projectRoot: string; cursor?: string }) => ({
      sessions: [session(params.cursor ? 'project-last' : params.projectRoot)], nextCursor: params.cursor ? null : 'cursor-2',
    }))
    setup()
    const picker = await openPicker()
    fireEvent.change(picker.getByRole('combobox', { name: 'Project' }), { target: { value: '/fixture/app' } })
    await picker.findByText('Candidate /fixture/app')
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await picker.findByText('Candidate project-last')
    expect(mocks.listProjectHistory).toHaveBeenLastCalledWith({ projectRoot: '/fixture/app', limit: 10, cursor: 'cursor-2' }, expect.any(Object))
    fireEvent.click(picker.getByRole('button', { name: 'Previous page' }))
    await picker.findByText('Candidate /fixture/app')
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await picker.findByText('Candidate project-last')
    fireEvent.change(picker.getByRole('combobox', { name: 'Project' }), { target: { value: '/fixture/docs' } })
    await picker.findByText('Candidate /fixture/docs')
    expect(mocks.listProjectHistory).toHaveBeenLastCalledWith({ projectRoot: '/fixture/docs', limit: 10, cursor: undefined }, expect.any(Object))
    expect(picker.getByText('Page 1')).toBeInTheDocument()
  })

  it('restarts project history from the first page when retrying an expired cursor', async () => {
    // 服务端快照过期后继续重发旧游标，且分页按钮禁用，导致无法恢复。
    mocks.listProjectHistory.mockImplementation(async (params: { cursor?: string }) => {
      if (params.cursor) throw new Error('Project history cursor expired; retry from the first page')
      return { sessions: [session('project-first')], nextCursor: 'expired-cursor' }
    })
    setup()
    const picker = await openPicker()
    fireEvent.change(picker.getByRole('combobox'), { target: { value: '/fixture/app' } })
    await picker.findByText('Candidate project-first')
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await picker.findByRole('alert')
    fireEvent.click(picker.getByRole('button', { name: 'Retry' }))
    await picker.findByText('Candidate project-first')
    expect(mocks.listProjectHistory).toHaveBeenLastCalledWith({ projectRoot: '/fixture/app', limit: 10, cursor: undefined }, expect.any(Object))
    expect(picker.getByText('Page 1')).toBeInTheDocument()
  })

  it('returns to the last valid candidate page when the total shrinks', async () => {
    // 候选列表在末页刷新时可能总数减少，旧页码不能显示为 Page 3 of 2。
    mocks.list.mockImplementation(async (params: { view?: string; offset?: number }) => params.view
      ? { sessions: [], total: 25, projects: [] }
      : params.offset === 20
        ? { sessions: [], total: 15 }
        : { sessions: [session(params.offset ? 'second-page' : 'first-page')], total: params.offset ? 15 : 25 })
    setup()
    const picker = await openPicker()
    await picker.findByText('Candidate first-page')
    // 第二页读取后仍显示三页；第三页读取才发现会话已被删除。
    mocks.list.mockImplementationOnce(async () => ({ sessions: [session('second-page')], total: 25 }))
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await picker.findByText('Candidate second-page')
    fireEvent.click(picker.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(picker.getByText('Page 2 of 2')).toBeInTheDocument())
    expect(await picker.findByText('Candidate second-page')).toBeInTheDocument()
    expect(picker.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('ignores a stale project response after the user changes the filter', async () => {
    let resolveOld!: (value: { sessions: SessionListItem[]; nextCursor: null }) => void
    mocks.listProjectHistory.mockImplementation((params: { projectRoot: string }) => params.projectRoot === '/fixture/app'
      ? new Promise((resolve) => { resolveOld = resolve })
      : Promise.resolve({ sessions: [session('docs')], nextCursor: null }))
    setup()
    const picker = await openPicker()
    fireEvent.change(picker.getByRole('combobox'), { target: { value: '/fixture/app' } })
    fireEvent.change(picker.getByRole('combobox'), { target: { value: '/fixture/docs' } })
    await picker.findByText('Candidate docs')
    await act(async () => resolveOld({ sessions: [session('stale')], nextCursor: null }))
    expect(picker.queryByText('Candidate stale')).not.toBeInTheDocument()
    expect(picker.getByText('Candidate docs')).toBeInTheDocument()
  })

  it('marks existing subscriptions and adds the selected full ID, then refreshes', async () => {
    mocks.list.mockImplementation(async (params: { view?: string }) => params.view
      ? { sessions: [], projects: [], total: 2 }
      : { sessions: [session('session-0'), session('new')], total: 2 })
    const result = setup([subscription(0)])
    const picker = await openPicker()
    await picker.findByText('Candidate new')
    expect(picker.getByText('Subscribed')).toBeInTheDocument()
    expect(picker.getAllByRole('button', { name: 'Subscribe' })).toHaveLength(1)
    fireEvent.click(picker.getByRole('button', { name: 'Subscribe' }))
    await waitFor(() => expect(result.props.onChanged).toHaveBeenCalledTimes(1))
    expect(mocks.addTelegramPublicSubscription).toHaveBeenCalledWith('new')
    result.rerender(<TelegramPublicSubscriptions {...result.props} subscriptions={[subscription(0), { ...subscription(1), sessionId: 'new' }]} />)
    expect(picker.getAllByText('Subscribed')).toHaveLength(2)
    expect(picker.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()
  })

  it('keeps translated row actions on one line on a narrow screen', async () => {
    // 窄屏下操作按钮被长 sessionId 挤窄，中文换行后超出了固定按钮高度。
    setup([subscription(0)])
    const picker = await openPicker()
    await picker.findByText('Candidate new')
    expect(picker.getByRole('button', { name: 'Subscribe' })).toHaveClass('shrink-0', 'whitespace-nowrap')
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toHaveClass('shrink-0', 'whitespace-nowrap')
  })

  it('locks mutations while an add is pending and preserves the manual input on failure', async () => {
    let reject!: (error: Error) => void
    mocks.addTelegramPublicSubscription.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const result = setup([subscription(0)])
    fireEvent.change(screen.getByLabelText('Full sessionId'), { target: { value: '  new  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeDisabled()
    await act(async () => reject(new Error('Session is outside allowed project roots')))
    expect(result.props.onError).toHaveBeenLastCalledWith('Session is outside allowed project roots')
    expect(screen.getByLabelText('Full sessionId')).toHaveValue('  new  ')
    expect(result.props.onChanged).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).not.toBeDisabled()
  })

  it('shows candidate errors with retry instead of an empty list', async () => {
    mocks.listProjectHistory.mockRejectedValueOnce(new Error('history unavailable'))
    setup()
    const picker = await openPicker()
    fireEvent.change(picker.getByRole('combobox'), { target: { value: '/fixture/app' } })
    expect(await picker.findByRole('alert')).toHaveTextContent('history unavailable')
    expect(picker.queryByText('No sessions to display')).not.toBeInTheDocument()
    fireEvent.click(picker.getByRole('button', { name: 'Retry' }))
    await picker.findByText('Candidate project')
  })

  it('does not claim an empty subscription list during loading or a status failure', () => {
    const result = setup([], { loading: true })
    expect(screen.queryByText('No subscribed sessions yet')).not.toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    result.rerender(<TelegramPublicSubscriptions {...result.props} loading={false} statusError="status unavailable" />)
    expect(screen.queryByText('No subscribed sessions yet')).not.toBeInTheDocument()
  })

  it('disables subscription mutations and candidate loading before enablement and pairing', () => {
    setup([subscription(0)], { canManage: false })
    expect(screen.getByRole('button', { name: 'Choose sessions to subscribe' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Full sessionId'), { target: { value: 'new' } })
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.listProjectHistory).not.toHaveBeenCalled()
  })
})