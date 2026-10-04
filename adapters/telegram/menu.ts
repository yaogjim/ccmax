export type TelegramBotCommand = {
  command: string
  description: string
}

export type TelegramSelectionKind =
  | 'provider'
  | 'model'
  | 'resume_project'
  | 'resume_session'
  | 'new_project'
  | 'skill'

export type TelegramSelectionItem = {
  label: string
  value: string
  description?: string
  meta?: Record<string, string>
}

export type TelegramSelectionButton = {
  text: string
  callbackData: string
}

export type TelegramSelectionPage = {
  page: number
  totalPages: number
  visibleItems: Array<TelegramSelectionItem & { index: number }>
  rows: TelegramSelectionButton[][]
}

export type TelegramSelectionCallback =
  | { kind: TelegramSelectionKind; token: string; action: 'pick'; index: number }
  | { kind: TelegramSelectionKind; token: string; action: 'page'; index: number }
  | { kind: TelegramSelectionKind; token: string; action: 'noop'; index: number }
  | { kind: TelegramSelectionKind; token: string; action: 'refresh'; index: number }
  | { kind: TelegramSelectionKind; token: string; action: 'cancel'; index: number }

export type TelegramHistoryViewItem = {
  label: string
  value: string
  description?: string
  index: number
}

export type TelegramHistoryView = {
  token: string
  kind: 'projects' | 'sessions'
  title: string
  page: number
  totalPages: number
  items: TelegramHistoryViewItem[]
  currentSessionId?: string
}

export type TelegramHistoryCallback = {
  token: string
  action: 'pick' | 'page' | 'projects' | 'refresh' | 'cancel'
  index?: number
}

type TelegramCommandApi = {
  deleteMyCommands?: () => Promise<unknown>
  setMyCommands: (commands: TelegramBotCommand[]) => Promise<unknown>
}

const TELEGRAM_SELECTION_PAGE_SIZE = 8
const TELEGRAM_BUTTON_LABEL_LIMIT = 32

export const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: 'start', description: '开始使用' },
  { command: 'help', description: '查看帮助' },
  { command: 'new', description: '新建会话或切换项目' },
  { command: 'projects', description: '查看最近项目' },
  { command: 'sessions', description: '查看项目历史会话' },
  { command: 'resume', description: '恢复历史会话' },
  { command: 'status', description: '查看当前状态' },
  { command: 'clear', description: '清空当前上下文' },
  { command: 'stop', description: '停止当前生成' },
  { command: 'provider', description: '切换 Provider' },
  { command: 'model', description: '切换模型' },
  { command: 'skills', description: '查看并调用 Skills' },
  { command: 'allow', description: '允许权限请求' },
  { command: 'always', description: '本会话永久允许' },
  { command: 'deny', description: '拒绝权限请求' },
  { command: 'cancel', description: '取消列表选择' },
  { command: 'answer', description: '可选：批量回答模型提问' },
]

export async function syncTelegramBotCommands(
  api: TelegramCommandApi,
  commands: TelegramBotCommand[] = TELEGRAM_BOT_COMMANDS,
): Promise<void> {
  if (api.deleteMyCommands) {
    await api.deleteMyCommands()
  }
  await api.setMyCommands(commands)
}

export function buildTelegramSelectionPage(params: {
  kind: TelegramSelectionKind
  token: string
  items: TelegramSelectionItem[]
  page: number
  pageSize?: number
}): TelegramSelectionPage {
  const pageSize = params.pageSize ?? TELEGRAM_SELECTION_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize))
  const page = clampPage(params.page, totalPages)
  const start = page * pageSize
  const visibleItems = params.items
    .slice(start, start + pageSize)
    .map((item, offset) => ({ ...item, index: start + offset }))

  const rows = visibleItems.map((item) => [
    {
      text: truncateButtonLabel(item.label),
      callbackData: `tgsel:${params.kind}:${params.token}:pick:${item.index}`,
    },
  ])

  if (totalPages > 1) {
    const nav: TelegramSelectionButton[] = []
    if (page > 0) {
      nav.push({
        text: 'Prev',
        callbackData: `tgsel:${params.kind}:${params.token}:page:${page - 1}`,
      })
    }
    nav.push({
      text: `${page + 1}/${totalPages}`,
      callbackData: `tgsel:${params.kind}:${params.token}:noop:${page}`,
    })
    if (page < totalPages - 1) {
      nav.push({
        text: 'Next',
        callbackData: `tgsel:${params.kind}:${params.token}:page:${page + 1}`,
      })
    }
    rows.push(nav)
  }

  if (params.kind === 'new_project') {
    rows.push([
      { text: '刷新', callbackData: `tgsel:${params.kind}:${params.token}:refresh:0` },
      { text: '取消', callbackData: `tgsel:${params.kind}:${params.token}:cancel:0` },
    ])
  }

  return {
    page,
    totalPages,
    visibleItems,
    rows,
  }
}

export function parseTelegramSelectionCallback(data: string): TelegramSelectionCallback | null {
  const tokenized = data.match(/^tgsel:([a-z_]+):([0-9a-f]+):(pick|page|noop|refresh|cancel):(\d+)$/)
  const legacy = tokenized ? null : data.match(/^tgsel:([a-z_]+):(pick|page|noop):(\d+)$/)
  const match = tokenized ?? legacy
  if (!match) return null
  const kind = match[1] as TelegramSelectionKind
  if (!isTelegramSelectionKind(kind)) return null
  const token = tokenized ? tokenized[2] : ''
  const action = (tokenized ? tokenized[3] : legacy![2]) as TelegramSelectionCallback['action']
  const index = Number(tokenized ? tokenized[4] : legacy![3])
  if (!Number.isSafeInteger(index) || index < 0) return null
  return { kind, token, action, index }
}

export function buildTelegramHistoryView(view: TelegramHistoryView): {
  text: string
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
} {
  const lines = view.items.map((item, offset) => {
    const current = Boolean(view.currentSessionId && item.value === view.currentSessionId && !item.label.includes('（当前）'))
    const label = current ? `${item.label}（当前）` : item.label
    return item.description
      ? `${offset + 1}. ${label}\n   ${item.description}`
      : `${offset + 1}. ${label}`
  })
  const pageSuffix = view.totalPages > 1 ? `\n\n第 ${view.page + 1}/${view.totalPages} 页` : ''
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = view.items.map((item) => [{
    text: truncateButtonLabel(item.label),
    callback_data: `tgh:${view.token}:pick:${item.index}`,
  }])

  if (view.totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = []
    if (view.page > 0) nav.push({ text: 'Prev', callback_data: `tgh:${view.token}:page:${view.page - 1}` })
    nav.push({ text: `${view.page + 1}/${view.totalPages}`, callback_data: `tgh:${view.token}:page:${view.page}` })
    if (view.page < view.totalPages - 1) nav.push({ text: 'Next', callback_data: `tgh:${view.token}:page:${view.page + 1}` })
    keyboard.push(nav)
  }

  const actions: Array<{ text: string; callback_data: string }> = []
  if (view.kind === 'sessions') actions.push({ text: '换项目', callback_data: `tgh:${view.token}:projects` })
  actions.push({ text: '刷新', callback_data: `tgh:${view.token}:refresh` })
  actions.push({ text: '取消', callback_data: `tgh:${view.token}:cancel` })
  keyboard.push(actions)

  return {
    text: `${view.title}\n\n${lines.join('\n\n')}${pageSuffix}`,
    reply_markup: { inline_keyboard: keyboard },
  }
}

export function parseTelegramHistoryCallback(data: string): TelegramHistoryCallback | null {
  const match = data.match(/^tgh:([0-9a-f]+):(pick|page|projects|refresh|cancel)(?::(\d+))?$/)
  if (!match) return null
  const action = match[2] as TelegramHistoryCallback['action']
  if ((action === 'pick' || action === 'page') && match[3] === undefined) return null
  if (action !== 'pick' && action !== 'page' && match[3] !== undefined) return null
  const index = match[3] === undefined ? undefined : Number(match[3])
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) return null
  return index === undefined ? { token: match[1], action } : { token: match[1], action, index }
}

function isTelegramSelectionKind(value: string): value is TelegramSelectionKind {
  return value === 'provider' ||
    value === 'model' ||
    value === 'resume_project' ||
    value === 'resume_session' ||
    value === 'new_project' ||
    value === 'skill'
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page) || page < 0) return 0
  if (page >= totalPages) return totalPages - 1
  return Math.floor(page)
}

function truncateButtonLabel(label: string): string {
  const chars = Array.from(label.trim() || '选择')
  if (chars.length <= TELEGRAM_BUTTON_LABEL_LIMIT) return chars.join('')
  return `${chars.slice(0, TELEGRAM_BUTTON_LABEL_LIMIT - 1).join('')}…`
}