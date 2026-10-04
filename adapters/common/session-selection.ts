import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AdapterHttpClient, RecentProject, SessionListItem } from './http-client.js'
import type { SessionStore } from './session-store.js'
import type { ServerMessage, WsBridge } from './ws-bridge.js'

export type SessionRestoreDeps = {
  httpClient: Pick<AdapterHttpClient, 'sessionExists'>
  bridge: Pick<WsBridge, 'resetSession' | 'connectSession' | 'onServerMessage' | 'waitForOpen'>
  sessionStore: Pick<SessionStore, 'get' | 'set' | 'delete'>
  onServerMessage: (chatId: string, message: ServerMessage) => void | Promise<void>
  clearTransientState: (chatId: string) => void
  /** Called after preflight succeeds, immediately before changing the binding. */
  beforeSessionSwitch?: (chatId: string) => void
  isBusy?: (chatId: string) => boolean
}

export type SessionSelectionViewItem = {
  label: string
  value: string
  description?: string
  index: number
}

export type SessionSelectionView = {
  token: string
  kind: 'projects' | 'sessions'
  title: string
  page: number
  totalPages: number
  items: SessionSelectionViewItem[]
  currentSessionId?: string
}

export type SessionSelectionAction = 'pick' | 'page' | 'projects' | 'refresh' | 'cancel'

export type SessionSelectionDeps = SessionRestoreDeps & {
  httpClient: Pick<AdapterHttpClient, 'sessionExists' | 'listRecentProjects' | 'matchProject' | 'listSessions'>
  sendNotice: (chatId: string, text: string) => Promise<void>
  clearProjectSelection: (chatId: string) => void
  now?: () => number
  presentSelection?: (chatId: string, view: SessionSelectionView) => Promise<void>
}

/** Attaching an IM is a binding change, never a new transcript or a prompt. */
export async function restoreSelectedSession(
  deps: SessionRestoreDeps,
  chatId: string,
  session: Pick<SessionListItem, 'id' | 'workDir' | 'title'>,
): Promise<{ ok: boolean; message: string }> {
  const busy = () => deps.isBusy?.(chatId) ?? false
  if (busy()) return { ok: false, message: '当前会话正在运行或等待审批，请先处理审批或发送 /stop，等停止后再切换。' }
  try {
    if (!session.workDir || !await deps.httpClient.sessionExists(session.id)) {
      return { ok: false, message: '该会话已不存在、目录不可用或不允许通过 IM 访问。请发送 /sessions 刷新列表。' }
    }
  } catch (err) {
    return { ok: false, message: `无法检查会话，当前绑定未改变：${err instanceof Error ? err.message : String(err)}。请重试。` }
  }
  // A server event may have started a turn while the preflight was in flight.
  if (busy()) return { ok: false, message: '当前会话正在运行，请先发送 /stop，等停止后再切换。' }

  const previous = deps.sessionStore.get(chatId)
  const buffered: ServerMessage[] = []
  deps.beforeSessionSwitch?.(chatId)
  deps.bridge.resetSession(chatId)
  try {
    deps.bridge.connectSession(chatId, session.id)
    deps.bridge.onServerMessage(chatId, (message) => { buffered.push(message) })
    if (!await deps.bridge.waitForOpen(chatId)) throw new Error('连接服务器超时')
    deps.sessionStore.set(chatId, session.id, session.workDir)
  } catch (err) {
    deps.bridge.resetSession(chatId)
    if (previous) {
      try {
        deps.bridge.connectSession(chatId, previous.sessionId)
        deps.bridge.onServerMessage(chatId, (message) => deps.onServerMessage(chatId, message))
      } catch {
        // The persisted binding is still intact; normal message recovery retries.
      }
    }
    return { ok: false, message: `恢复失败，已保留原会话绑定：${err instanceof Error ? err.message : String(err)}。请重试。` }
  }
  deps.clearTransientState(chatId)
  deps.bridge.onServerMessage(chatId, (message) => deps.onServerMessage(chatId, message))
  for (const message of buffered) {
    try {
      await deps.onServerMessage(chatId, message)
    } catch (err) {
      console.warn('[SessionSelection] Failed to present restored state:', err)
    }
  }
  return { ok: true, message: `已恢复会话：${oneLine(session.title || '未命名会话', 80)}\n${session.workDir}\n会话 ID：${session.id}\n可以继续发送消息。` }
}

const PAGE_SIZE = 8
const FETCH_SIZE = 100
export const SESSION_SELECTION_TTL_MS = 15 * 60 * 1000
type Picker = {
  expiresAt: number
  page: number
  token: string
} & (
  | { kind: 'projects'; projects: RecentProject[] }
  | { kind: 'sessions'; project: string; sessions: SessionListItem[] }
)

function newSelectionToken(): string {
  return randomBytes(4).toString('hex')
}

function oneLine(value: string, length = 100): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, length)
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** The API's project filter addresses one transcript directory, while recent
 * projects group worktrees. Filter logical roots after reading all summary pages. */
export async function listProjectSessionHistory(
  httpClient: Pick<AdapterHttpClient, 'listSessions'>,
  project: string,
  all?: SessionListItem[],
): Promise<SessionListItem[]> {
  const root = canonicalPath(project)
  return (all ?? await loadSessionHistory(httpClient)).filter((session) =>
    session.workDir && session.workDirExists !== false && (
      canonicalPath(session.projectRoot || session.workDir) === root || canonicalPath(session.workDir) === root
    ),
  ).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
}

async function loadSessionHistory(httpClient: Pick<AdapterHttpClient, 'listSessions'>): Promise<SessionListItem[]> {
  const sessions = new Map<string, SessionListItem>()
  let offset = 0
  let total: number
  do {
    const result = await httpClient.listSessions({ limit: FETCH_SIZE, offset })
    for (const session of result.sessions) sessions.set(session.id, session)
    total = result.total
    offset += FETCH_SIZE
  } while (offset < total)
  return [...sessions.values()]
}

/** Text-first picker shared by every IM, with a stable, chat-local snapshot. */
export class SessionSelectionController {
  private readonly pickers = new Map<string, Picker>()
  private readonly now: () => number

  constructor(private readonly deps: SessionSelectionDeps) {
    this.now = deps.now ?? Date.now
  }

  clear(chatId: string): void {
    this.pickers.delete(chatId)
  }

  /**
   * Which list is waiting for this chat, or null when none is.
   *
   * Read-only pending getter for platform entrypoints: a bare number is only a
   * list answer while a list is actually open, so the caller has to ask instead
   * of guessing from the digits. An expired picker is pruned on read, exactly
   * like `requirePicker` would.
   */
  pendingKind(chatId: string): Picker['kind'] | null {
    const picker = this.pickers.get(chatId)
    if (!picker) return null
    if (picker.expiresAt <= this.now()) {
      this.clear(chatId)
      return null
    }
    return picker.kind
  }

  async handleSelectionAction(
    chatId: string,
    token: string,
    action: SessionSelectionAction,
    index?: number,
  ): Promise<boolean> {
    const picker = this.activePicker(chatId)
    if (!picker || !token || picker.token !== token) {
      await this.deps.sendNotice(chatId, '选择列表不存在或已过期，请发送 /sessions 重新选择。')
      return true
    }

    try {
      if (action === 'cancel') {
        this.clear(chatId)
        this.deps.clearProjectSelection(chatId)
        await this.deps.sendNotice(chatId, '已取消选择，当前会话未改变。')
        return true
      }
      if (action === 'projects') {
        await this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
        return true
      }
      if (action === 'refresh') {
        if (picker.kind === 'projects') await this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
        else await this.openProject(chatId, picker.project)
        return true
      }
      if (action === 'page') {
        const count = picker.kind === 'projects' ? picker.projects.length : picker.sessions.length
        const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))
        const nextPage = Math.max(0, Math.min(totalPages - 1, index ?? picker.page))
        if (nextPage === picker.page) return true
        picker.page = nextPage
        await this.show(chatId, picker)
        return true
      }
      if (action === 'pick') {
        await this.selectByIndex(chatId, picker, index ?? -1)
        return true
      }
    } catch (err) {
      await this.deps.sendNotice(chatId, `无法恢复会话：${err instanceof Error ? err.message : String(err)}。请重试 /sessions。`)
      return true
    }
    return false
  }

  async handleInput(chatId: string, input: string): Promise<boolean> {
    const text = input.trim()
    const list = /^(?:\/sessions|会话列表)(?:\s+(.*))?$/.exec(text)
    const resume = /^(?:\/resume|继续会话)(?:\s+(.*))?$/.exec(text)
    const cancel = text === '/cancel' || text === '取消选择'
    const picker = this.pickers.get(chatId)
    const numberReply = /^\d+$/.test(text) && Boolean(picker)
    if (!list && !resume && !cancel && !numberReply) {
      // Normal chat is never a fuzzy session query. Other commands (especially
      // permission approval) retain their original routing and pending picker.
      if (text && !text.startsWith('/') && !['帮助', '状态', '停止', '清空'].includes(text)) this.clear(chatId)
      return false
    }

    try {
      if (cancel) {
        this.clear(chatId)
        this.deps.clearProjectSelection(chatId)
        await this.deps.sendNotice(chatId, '已取消选择，当前会话未改变。')
      } else if (list && ['next', 'prev'].includes(list[1] ?? '')) {
        const active = await this.requirePicker(chatId, picker)
        if (!active) return true
        const count = active.kind === 'projects' ? active.projects.length : active.sessions.length
        const nextPage = active.page + (list[1] === 'next' ? 1 : -1)
        active.page = Math.max(0, Math.min(Math.ceil(count / PAGE_SIZE) - 1, nextPage))
        await this.show(chatId, active)
      } else if (list || (resume && !resume[1])) {
        this.clear(chatId)
        this.deps.clearProjectSelection(chatId)
        await this.open(chatId, list?.[1])
      } else {
        const active = await this.requirePicker(chatId, picker)
        if (!active) return true
        const pageLocal = Boolean(this.deps.presentSelection)
        await this.select(chatId, active, resume?.[1] ?? text, pageLocal)
      }
    } catch (err) {
      await this.deps.sendNotice(chatId, `无法恢复会话：${err instanceof Error ? err.message : String(err)}。请重试 /sessions。`)
    }
    return true
  }

  private activePicker(chatId: string): Picker | null {
    const picker = this.pickers.get(chatId)
    if (!picker) return null
    if (picker.expiresAt <= this.now()) {
      this.clear(chatId)
      return null
    }
    return picker
  }

  private async requirePicker(chatId: string, picker: Picker | undefined): Promise<Picker | null> {
    const active = picker && picker.expiresAt > this.now() ? picker : this.activePicker(chatId)
    if (active) return active
    this.clear(chatId)
    await this.deps.sendNotice(chatId, '选择列表不存在或已过期，请发送 /sessions 重新选择。')
    return null
  }

  private async open(chatId: string, query?: string): Promise<void> {
    if (query === 'projects') return this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
    if (query) {
      const { project, ambiguous } = await this.deps.httpClient.matchProject(query)
      if (project) return this.openProject(chatId, project.realPath)
      if (ambiguous?.length) return this.openProjects(chatId, ambiguous)
      await this.deps.sendNotice(chatId, `未找到项目“${oneLine(query)}”。发送 /sessions projects 选择项目，或 /sessions <绝对路径>。`)
      return
    }
    const current = this.deps.sessionStore.get(chatId)
    if (current) {
      // Recent projects collapse worktrees into their root. Find the stored
      // session's logical root before choosing the default history list.
      const sessions = await loadSessionHistory(this.deps.httpClient)
      const active = sessions.find((session) => session.id === current.sessionId)
      return this.openProject(chatId, active?.projectRoot || current.workDir, sessions)
    }
    await this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
  }

  private async openProjects(chatId: string, projects: RecentProject[]): Promise<void> {
    if (!projects.length) {
      await this.deps.sendNotice(chatId, '没有可访问的历史项目。发送 /new 新建会话，或 /sessions <项目绝对路径> 查找旧会话。')
      return
    }
    const picker: Picker = { kind: 'projects', projects, page: 0, token: '', expiresAt: this.now() + SESSION_SELECTION_TTL_MS }
    this.pickers.set(chatId, picker)
    await this.show(chatId, picker)
  }

  private async openProject(chatId: string, project: string, all?: SessionListItem[]): Promise<void> {
    const sessions = await listProjectSessionHistory(this.deps.httpClient, project, all)
    if (!sessions.length) {
      this.clear(chatId)
      await this.deps.sendNotice(chatId, `该项目没有可恢复会话：${project}\n发送 /sessions projects 选择其他项目，或 /new <项目> 新建会话。`)
      return
    }
    const picker: Picker = { kind: 'sessions', project, sessions, page: 0, token: '', expiresAt: this.now() + SESSION_SELECTION_TTL_MS }
    this.pickers.set(chatId, picker)
    await this.show(chatId, picker)
  }

  private async select(chatId: string, picker: Picker, query: string, pageLocal = false): Promise<void> {
    const parsed = /^\d+$/.test(query) ? Number(query) - 1 : -1
    const start = picker.page * PAGE_SIZE
    const index = pageLocal ? start + parsed : parsed
    if (pageLocal && (parsed < 0 || parsed >= PAGE_SIZE)) {
      await this.deps.sendNotice(chatId, '编号无效，请使用当前页显示的编号，或发送 /sessions 刷新列表。')
      return
    }
    await this.selectByIndex(chatId, picker, index)
  }

  private async selectByIndex(chatId: string, picker: Picker, index: number): Promise<void> {
    const start = picker.page * PAGE_SIZE
    const visible = index >= start && index < start + PAGE_SIZE
    if (picker.kind === 'projects') {
      const project = visible ? picker.projects[index] : undefined
      if (project) return this.openProject(chatId, project.realPath)
    } else {
      const session = visible ? picker.sessions[index] : undefined
      if (session) {
        const result = await restoreSelectedSession(this.deps, chatId, session)
        if (result.ok) this.clear(chatId)
        await this.deps.sendNotice(chatId, result.message)
        return
      }
    }
    await this.deps.sendNotice(chatId, '编号无效，请使用当前页显示的编号，或发送 /sessions 刷新列表。')
  }

  private toView(chatId: string, picker: Picker): SessionSelectionView {
    const start = picker.page * PAGE_SIZE
    const currentSessionId = this.deps.sessionStore.get(chatId)?.sessionId
    const items = picker.kind === 'projects' ? picker.projects : picker.sessions
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
    const visible = picker.kind === 'projects'
      ? picker.projects.slice(start, start + PAGE_SIZE).map((project, i) => ({
        index: start + i,
        label: oneLine(project.projectName, 60),
        value: project.realPath,
        description: oneLine(project.realPath, 180),
      }))
      : picker.sessions.slice(start, start + PAGE_SIZE).map((session, i) => ({
        index: start + i,
        label: `${oneLine(session.title || '未命名会话', 60)}${session.id === currentSessionId ? '（当前）' : ''}`,
        value: session.id,
        description: `${session.modifiedAt.slice(0, 16).replace('T', ' ')} · ${session.messageCount} 条消息 · ${session.id.slice(0, 8)}`,
      }))
    return {
      token: picker.token,
      kind: picker.kind,
      title: picker.kind === 'projects' ? '选择历史会话所在的项目：' : `历史会话：${picker.project}`,
      page: picker.page,
      totalPages,
      items: visible,
      currentSessionId,
    }
  }

  private async show(chatId: string, picker: Picker): Promise<void> {
    picker.token = newSelectionToken()
    if (this.deps.presentSelection) {
      await this.deps.presentSelection(chatId, this.toView(chatId, picker))
      return
    }
    const start = picker.page * PAGE_SIZE
    const currentId = this.deps.sessionStore.get(chatId)?.sessionId
    const items = picker.kind === 'projects' ? picker.projects : picker.sessions
    const lines = picker.kind === 'projects'
      ? picker.projects.slice(start, start + PAGE_SIZE).map((project, i) => `${start + i + 1}. ${oneLine(project.projectName, 60)}\n${oneLine(project.realPath, 180)}`)
      : picker.sessions.slice(start, start + PAGE_SIZE).map((session, i) => `${start + i + 1}. ${oneLine(session.title || '未命名会话', 60)}${session.id === currentId ? '（当前）' : ''}\n${session.modifiedAt.slice(0, 16).replace('T', ' ')} · ${session.messageCount} 条消息 · ${session.id.slice(0, 8)}`)
    await this.deps.sendNotice(chatId, [
      picker.kind === 'projects' ? '选择历史会话所在的项目：' : `历史会话：${picker.project}`,
      `第 ${picker.page + 1}/${Math.ceil(items.length / PAGE_SIZE)} 页`,
      '', ...lines, '',
      picker.kind === 'projects' ? '回复编号查看会话。' : '回复编号或 /resume <编号> 继续旧会话。',
      '翻页：/sessions next、/sessions prev',
      '/cancel 取消；列表 15 分钟内有效。',
    ].join('\n'))
  }
}
