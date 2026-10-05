import { randomBytes } from 'node:crypto'
import * as path from 'node:path'
import type { TelegramInlineMarkup, TelegramPublicSessionSummary } from './telegramPublicService.js'
import type { TelegramPublicSubscription } from './telegramPublicStore.js'

export const SUBSCRIPTION_LIST_TTL_MS = 14 * 24 * 60 * 60 * 1000
const PAGE_SIZE = 20
const EXPIRED = '列表已失效，请重新发送 /sessions 或 /subscriptions。'

export type SubscriptionListActor = { botId: number; generation: number; userId: number; chatId: string }
type Action = { kind: 'toggle' | 'submit' | 'clear' | 'page' | 'cancel' | 'confirm' | 'back'; sessionId?: string; page?: number }
type Round = {
  actor: SubscriptionListActor
  kind: 'sessions' | 'subscriptions'
  expiresAt: number
  messageId?: number
  rows: TelegramPublicSessionSummary[]
  selected: Set<string>
  page: number
  revision: number
  tokens: Map<string, { action: Action; revision: number; result?: string }>
  confirmation?: { sessionId: string; revision: number }
}

type Deps = {
  now: () => number
  valid: (actor: SubscriptionListActor) => Promise<boolean>
  sessions: (query: string) => Promise<TelegramPublicSessionSummary[]>
  subscriptions: () => Promise<Record<string, TelegramPublicSubscription>>
  subscribe: (id: string, actor: SubscriptionListActor) => Promise<TelegramPublicSubscription>
  revision: (id: string) => number
  unsubscribe: (id: string, actor: SubscriptionListActor, revision: number) => Promise<void>
  deliveries: () => Promise<string>
  present: (actor: SubscriptionListActor, text: string, markup: TelegramInlineMarkup, messageId?: number) => Promise<number>
  notice: (actor: SubscriptionListActor, text: string) => Promise<void>
}

// 短暂选择不进入订阅持久化；服务重启、运行身份刷新和新同类命令均使旧按钮失效。
// 与审批 token 完全分开，唯一业务写入边界仍是 service 的 subscribe/unsubscribe。
export class TelegramSubscriptionLists {
  private rounds = new Map<string, Round>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private deps: Deps) {}

  reset(): void { this.rounds.clear() }

  private key(actor: SubscriptionListActor, kind: Round['kind']): string {
    return `${actor.botId}:${actor.generation}:${actor.userId}:${actor.chatId}:${kind}`
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => {
      for (const [key, round] of this.rounds) {
        if (round.expiresAt <= this.deps.now()) this.rounds.delete(key)
      }
      await work()
    })
    this.tail = result.catch(() => {})
    return result
  }

  open(actor: SubscriptionListActor, kind: Round['kind'], query = ''): Promise<void> {
    return this.serial(async () => {
      const key = this.key(actor, kind)
      this.rounds.delete(key)
      if (!await this.deps.valid(actor)) throw new Error(EXPIRED)
      const round: Round = {
        actor, kind, expiresAt: this.deps.now() + SUBSCRIPTION_LIST_TTL_MS,
        rows: kind === 'sessions' ? await this.deps.sessions(query) : [],
        selected: new Set(), page: 0, revision: 0, tokens: new Map(),
      }
      this.rounds.set(key, round)
      await this.render(round, query ? `搜索：${compact(query, 100)}` : '')
    })
  }

  handle(actor: SubscriptionListActor, data: string, messageId: number | undefined): Promise<void> {
    return this.serial(async () => {
      const token = data.slice('tgsub:'.length)
      const round = [...this.rounds.values()].find(item => item.tokens.has(token))
      if (!round || round.actor.botId !== actor.botId || round.actor.generation !== actor.generation
        || round.actor.userId !== actor.userId || round.actor.chatId !== actor.chatId
        || !messageId || round.messageId !== messageId || round.expiresAt <= this.deps.now()
        || !await this.deps.valid(actor)) {
        await this.deps.notice(actor, EXPIRED)
        return
      }
      const record = round.tokens.get(token)!
      if (record.result !== undefined) {
        await this.render(round, `此操作已处理：${record.result}`)
        return
      }
      if (record.revision !== round.revision) {
        await this.deps.notice(actor, '列表状态已更新，请使用最新按钮。')
        return
      }
      const subscriptions = await this.deps.subscriptions()
      const action = record.action
      let notice = ''
      if (action.kind === 'toggle') {
        const id = action.sessionId!
        if (subscriptions[id]) {
          round.selected.delete(id)
          notice = '已订阅；点击条目不会取消订阅。'
        } else if (round.selected.has(id)) {
          round.selected.delete(id)
          notice = '已取消本轮选择，真实订阅不变。'
        } else {
          round.selected.add(id)
          notice = '已加入本轮选择，确认前不会接收报告。'
        }
      } else if (action.kind === 'clear') {
        round.selected.clear()
        notice = '已清空本轮选择，真实订阅不变。'
      } else if (action.kind === 'page') {
        round.page = action.page!
      } else if (action.kind === 'cancel') {
        if (!subscriptions[action.sessionId!]) notice = '该会话已取消订阅。'
        else round.confirmation = { sessionId: action.sessionId!, revision: this.deps.revision(action.sessionId!) }
      } else if (action.kind === 'back') {
        round.confirmation = undefined
        notice = '已返回，订阅不变。'
      } else if (action.kind === 'confirm') {
        const id = action.sessionId!
        if (round.confirmation?.sessionId !== id) {
          await this.deps.notice(actor, '取消确认已失效，请重新打开订阅列表。')
          return
        }
        if (!subscriptions[id]) notice = '该会话已取消订阅。'
        else if (round.confirmation.revision !== this.deps.revision(id)) notice = '订阅状态已变化，取消确认已失效；请重新选择取消订阅。'
        else {
          try {
            await this.deps.unsubscribe(id, actor, round.confirmation.revision)
            notice = `已取消订阅「${compact(subscriptions[id]!.title || id, 80)}」。未发送报告、关联回复与按钮按既有规则失效。`
          } catch (error) {
            notice = `取消失败：${errorText(error)}`
          }
        }
        round.confirmation = undefined
      } else if (action.kind === 'submit') {
        if (round.selected.size === 0) notice = '尚未选择会话，未执行订阅。'
        else {
          const results: string[] = []
          for (const id of [...round.selected]) {
            const row = round.rows.find(item => item.id === id)
            const title = compact(row?.title || id, 80)
            try {
              // 即使已订阅也经过相同业务校验，不能用列表快照绕过删除或撤权。
              const before = (await this.deps.subscriptions())[id]
              const subscription = await this.deps.subscribe(id, actor)
              round.selected.delete(id)
              results.push(`${before ? '已订阅' : '成功'} · ${title} · ${subscription.shortId}`)
            } catch (error) {
              results.push(`失败 · ${title} · ${errorText(error)}`)
            }
          }
          notice = results.join('\n') + '\n仅接收订阅后的事件，不补发历史报告。失败项保留待选，可再次确认重试。'
          // 结果独立分片，不让跨页批量结果超过 Telegram 消息长度限制。
          for (const chunk of resultChunks(notice)) await this.deps.notice(actor, chunk)
          notice = '批量结果已逐项列出。成功项已移出待选，失败项可重试。'
        }
      }
      record.result = notice || '列表已更新'
      round.revision += 1
      await this.render(round, notice)
    })
  }

  private async render(round: Round, notice = ''): Promise<void> {
    if (!await this.deps.valid(round.actor) || ![...this.rounds.values()].includes(round)) throw new Error(EXPIRED)
    const subscriptions = await this.deps.subscriptions()
    const rows = round.kind === 'sessions' ? round.rows : Object.values(subscriptions).map(item => ({
      id: item.sessionId, title: item.title || '未命名会话', projectPath: item.project || '', workDir: item.project || null,
    }))
    const labels = rows.map(row => `${compact(row.title, 38)} · ${compact(path.basename(row.workDir || row.projectPath) || '未命名项目', 18)}`)
    const labelCounts = new Map<string, number>()
    for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
    const keyboard: TelegramInlineMarkup['inline_keyboard'] = []
    const button = (text: string, action: Action) => {
      const token = randomBytes(16).toString('hex')
      round.tokens.set(token, { action, revision: round.revision })
      return { text, callback_data: `tgsub:${token}` }
    }
    let text: string
    const confirmation = round.confirmation && subscriptions[round.confirmation.sessionId]
    if (confirmation) {
      text = `取消订阅「${compact(confirmation.title || confirmation.sessionId, 100)}」？\n取消后不再接收该会话的后续报告。`
      keyboard.push([button('确认取消', { kind: 'confirm', sessionId: confirmation.sessionId }), button('返回', { kind: 'back' })])
    } else {
      round.confirmation = undefined
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
      round.page = Math.max(0, Math.min(round.page, pages - 1))
      text = round.kind === 'sessions' ? '请选择要订阅的会话：' : '当前已订阅会话：'
      if (rows.length === 0) text += round.kind === 'sessions'
        ? '\n没有匹配且可访问的会话（请检查搜索条件或允许项目根目录）。'
        : '\n当前没有公共订阅。'
      for (const row of rows.slice(round.page * PAGE_SIZE, (round.page + 1) * PAGE_SIZE)) {
        const subscription = subscriptions[row.id]
        const index = rows.indexOf(row)
        const baseLabel = labels[index]!
        const label = (labelCounts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} · #${index + 1}` : baseLabel
        if (round.kind === 'sessions') {
          const marker = subscription ? '已订阅' : round.selected.has(row.id) ? '已选择' : '未选择'
          keyboard.push([button(`${marker} · ${label}`, { kind: 'toggle', sessionId: row.id })])
        } else {
          keyboard.push([button(`取消订阅 · ${label} · ${subscription!.shortId}`, { kind: 'cancel', sessionId: row.id })])
        }
      }
      text += `\n第 ${round.page + 1} / ${pages} 页，共 ${rows.length} 项。`
      const navigation = []
      if (round.page > 0) navigation.push(button('上一页', { kind: 'page', page: round.page - 1 }))
      if (round.page + 1 < pages) navigation.push(button('下一页', { kind: 'page', page: round.page + 1 }))
      if (navigation.length) keyboard.push(navigation)
      if (round.kind === 'sessions') {
        keyboard.push([button(`订阅所选（${round.selected.size}）`, { kind: 'submit' }), button('清空选择', { kind: 'clear' })])
        text += '\n选择跨页保留；新发 /sessions 开启新一轮。'
      }
    }
    if (round.kind === 'subscriptions' && !confirmation) text += await this.deps.deliveries()
    if (notice) text += `\n\n${notice}`
    // 失效凭据可删除，旧按钮仍会明确提示重开；保留最近操作供重放结果反馈。
    while (round.tokens.size > 1000) round.tokens.delete(round.tokens.keys().next().value!)
    round.messageId = await this.deps.present(round.actor, text, { inline_keyboard: keyboard }, round.messageId)
  }
}

function compact(value: string, limit: number): string {
  const text = value.replace(/[\r\n\t]+/g, ' ').trim() || '未命名会话'
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text
}

function errorText(error: unknown): string {
  return compact(error instanceof Error ? error.message : '操作失败', 180)
}

function resultChunks(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const line of text.split('\n')) {
    if (chunk.length + line.length + 1 > 3500) { chunks.push(chunk); chunk = '' }
    chunk += (chunk ? '\n' : '') + line
  }
  if (chunk) chunks.push(chunk)
  return chunks
}