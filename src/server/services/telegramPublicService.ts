/**
 * Telegram public channel — 服务端订阅、可靠报告与定向文本。
 *
 * 适配器把已核验的 Bot 身份和入站 update 交给本服务；本服务持有唯一 store，
 * 不写专属 SessionStore，不持久化 token。handler / notificationService 的
 * 人类输入与底层发送通过可注入依赖接入，测试全部使用 fake。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseQuestionAnswer, parseQuestions } from '../../../adapters/common/ask-user-question.js'
import { splitMessage } from '../../../adapters/common/format.js'
import { adapterService, type AdapterFileConfig } from './adapterService.js'
import { sessionService, type SessionListItem } from './sessionService.js'
import {
  getSessionPermissionOrigin,
  observeSessionTurns,
  type SessionTurnEvent,
  type SessionTurnOrigin,
} from './sessionTurnEvents.js'
import { TelegramSubscriptionLists, type SubscriptionListActor } from './telegramSubscriptionLists.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  TelegramPublicEventLog,
  type TelegramPublicEventLogRecord,
} from './telegramPublicEventLog.js'
import {
  TelegramPublicStore,
  TelegramPublicStoreError,
  emptyTelegramPublicStore,
  getTelegramPublicStorePath,
  inboundUpdateKey,
  inboundWatermarkKey,
  messageMapKey,
  outboxIdempotencyKey,
  type TelegramPublicCallbackToken,
  type TelegramPublicDeliveryStatus,
  type TelegramPublicInboundUpdate,
  type TelegramPublicMessageMap,
  type TelegramPublicOutboxRecord,
  type TelegramPublicRuntimeState,
  type TelegramPublicStoreFile,
  type TelegramPublicSubscription,
} from './telegramPublicStore.js'

export const TELEGRAM_PUBLIC_TEXT_LIMIT = 4000
export const TELEGRAM_PUBLIC_REPLY_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const TELEGRAM_PUBLIC_MAX_429_ATTEMPTS = 5
const SHORT_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export type TelegramPublicOrigin = SessionTurnOrigin
export type TelegramPublicTurnEvent = SessionTurnEvent

export type TelegramChannelSendResult = {
  outcome: 'delivered' | 'failed' | 'indeterminate'
  messageId?: number
  error?: string
  retryAfterMs?: number
}

export type TelegramInlineMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export type TelegramPublicHandlerDeps = {
  submitHumanSessionTurn: (
    sessionId: string,
    content: string,
    options: {
      serverHost: string
      serverPort: number
      inputId: string
      origin: TelegramPublicOrigin
    },
  ) => Promise<void>
  respondToSessionPermission: (
    sessionId: string,
    params: { requestId: string; allowed: boolean; updatedInput?: Record<string, unknown> },
  ) => Promise<boolean>
  respondToSessionComputerUsePermission: (
    sessionId: string,
    requestId: string,
    response: {
      granted: unknown[]
      denied: unknown[]
      flags: { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean }
      userConsented?: boolean
    },
  ) => Promise<boolean>
  isSessionPermissionPending: (sessionId: string, requestId: string) => boolean
  getSessionTurnState: (sessionId: string) => 'running' | 'blocked' | 'idle'
}

export type TelegramPublicSessionSummary = {
  id: string
  title: string
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  team?: string
  member?: string
}

export type TelegramPublicStatus = {
  botId?: number
  generation: number
  running: boolean
  ownerUserId: number | null
  error?: string
  subscriptions: Array<{ sessionId: string; shortId: string; title: string; project: string }>
  deliveries: Array<{ id: string; status: TelegramPublicDeliveryStatus; error?: string }>
}

export type TelegramPublicServiceDeps = {
  store: TelegramPublicStore
  now: () => number
  sleep: (ms: number) => Promise<void>
  serverHost: string
  serverPort: number
  getRawConfig: () => Promise<AdapterFileConfig>
  claimPairing: (code: string, userId: number) => Promise<{ ownerUserId: number; generation: number }>
  listSessions: (options?: { limit?: number; offset?: number }) => Promise<{ sessions: SessionListItem[]; total: number }>
  getSessionSummary: (sessionId: string) => Promise<TelegramPublicSessionSummary | null>
  searchSessionMetadata: (query: string, options?: { limit?: number; offset?: number }) => Promise<{ sessions: TelegramPublicSessionSummary[]; total?: number }>
  observeSessionTurns: (listener: (event: SessionTurnEvent) => void) => () => void
  getSessionPermissionOrigin: (sessionId: string, requestId: string) => SessionTurnOrigin | undefined
  sendTelegramChannelMessage: (
    botToken: string,
    chatId: string,
    text: string,
    options?: { replyMarkup?: TelegramInlineMarkup },
  ) => Promise<TelegramChannelSendResult>
  editTelegramChannelMessage: (
    botToken: string,
    chatId: string,
    messageId: number,
    text: string,
    options?: { replyMarkup?: TelegramInlineMarkup },
  ) => Promise<TelegramChannelSendResult>
  getDedicatedBinding: (chatId: string) => { sessionId: string } | null
  realpath: (target: string) => Promise<string>
  handler: TelegramPublicHandlerDeps
}

type PublicSnapshot = {
  present: boolean
  enabled: boolean
  botToken: string
  ownerUserId: number | null
  generation: number
  allowedProjectRoots: string[]
}

type EligibilityCache = {
  present: boolean
  enabled: boolean
  ownerUserId: number | null
  generation: number
  botId: number | null
  live: boolean
  subscriptions: Set<string>
}

type OwnerChat = {
  chatId: number
  userId: number
  messageId?: number
  text?: string
  replyToMessageId?: number
  forwarded: boolean
  replyForwarded: boolean
  hasMedia: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function botIdFromStoredToken(token: string): number | null {
  const match = /^(\d+):/.exec(token.trim())
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function hasMediaPayload(message: Record<string, unknown>): boolean {
  return [
    'photo', 'document', 'voice', 'audio', 'video', 'sticker',
    'animation', 'video_note', 'contact', 'location', 'venue',
    'poll', 'dice', 'game', 'invoice',
  ].some(key => key in message && message[key] != null)
}

function isForwarded(message: Record<string, unknown>): boolean {
  return [
    'forward_origin', 'forward_from', 'forward_from_chat',
    'forward_sender_name', 'forward_date', 'forward_from_message_id',
  ].some(key => key in message && message[key] != null)
}

function allocateShortId(used: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = randomBytes(4)
    let body = ''
    for (let index = 0; index < 4; index++) {
      body += SHORT_ID_ALPHABET[bytes[index]! % SHORT_ID_ALPHABET.length]
    }
    const shortId = `S${body}`
    if (!used.has(shortId) && !used.has(shortId.slice(1))) return shortId
  }
  throw new Error('Unable to allocate a unique public session short id')
}

function normalizeShortId(value: string): string {
  return value.trim().toUpperCase()
}

function lookupShortId(
  store: TelegramPublicStoreFile,
  raw: string,
): { sessionId: string } | { error: string } {
  const needle = normalizeShortId(raw)
  if (!needle) return { error: '缺少会话编号' }
  const matches = new Set<string>()
  const candidates = needle.startsWith('S') ? [needle, needle.slice(1)] : [needle, `S${needle}`]
  for (const candidate of candidates) {
    const sessionId = store.shortIds[candidate] ?? store.shortIds[normalizeShortId(candidate)]
    if (sessionId) matches.add(sessionId)
  }
  for (const subscription of Object.values(store.subscriptions)) {
    if (normalizeShortId(subscription.shortId) === needle
      || normalizeShortId(subscription.shortId) === (needle.startsWith('S') ? needle : `S${needle}`)) {
      matches.add(subscription.sessionId)
    }
  }
  if (matches.size > 1) return { error: `短编号 ${needle} 存在歧义，请使用完整会话 id` }
  const sessionId = [...matches][0]
  if (!sessionId) return { error: `未找到短编号 ${needle}` }
  return { sessionId }
}

function eventIdOf(event: TelegramPublicTurnEvent, message: Record<string, unknown> | undefined): string | undefined {
  if (typeof event.eventId === 'string' && event.eventId.length > 0) return event.eventId
  const uuid = message && typeof message.uuid === 'string' ? message.uuid : undefined
  return uuid && uuid.length > 0 ? uuid : undefined
}

function resultText(message: Record<string, unknown>): string {
  if (typeof message.result === 'string' && message.result.trim()) return message.result.trim()
  if (typeof message.error === 'string' && message.error.trim()) return message.error.trim()
  return message.is_error === true ? '执行失败' : '已完成'
}

function splitResultReport(text: string, shortId: string, category: string): string[] {
  const parts: string[] = []
  let offset = 0
  while (offset < text.length) {
    const prefix = parts.length === 0 ? '' : `[ccmax · 订阅会话 · ${shortId} · ${category} · 续 ${parts.length + 1}]：\n`
    let end = Math.min(text.length, offset + TELEGRAM_PUBLIC_TEXT_LIMIT - prefix.length)
    // 保留分片边界的空白，且不能拆开 UTF-16 代理对（例如 emoji）。
    if (end < text.length
      && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
      && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1
    parts.push(prefix + text.slice(offset, end))
    offset = end
  }
  return parts
}

function toolNameOf(message: Record<string, unknown>): string {
  const request = isRecord(message.request) ? message.request : {}
  return typeof request.tool_name === 'string' && request.tool_name.trim()
    ? request.tool_name.trim()
    : 'Unknown'
}

function requestIdOf(message: Record<string, unknown>): string | undefined {
  if (typeof message.request_id === 'string' && message.request_id.length > 0) return message.request_id
  const request = isRecord(message.request) ? message.request : {}
  return typeof request.request_id === 'string' ? request.request_id : undefined
}

function computerUseConsent(allowed: boolean) {
  return {
    granted: [],
    denied: [],
    flags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
    userConsented: allowed,
  }
}

function missingHandler(name: string): never {
  throw new Error(`telegram public channel requires ${name} (injected in tests; production wrapper is owned by ws/handler or notificationService)`)
}

async function loadDefaultHandler(): Promise<TelegramPublicHandlerDeps> {
  const handler = await import('../ws/handler.js') as Record<string, unknown>
  const asFn = <T>(name: string): T => {
    const value = handler[name]
    if (typeof value !== 'function') missingHandler(name)
    return value as T
  }
  return {
    submitHumanSessionTurn: asFn('submitHumanSessionTurn'),
    respondToSessionPermission: asFn('respondToSessionPermission'),
    respondToSessionComputerUsePermission: asFn('respondToSessionComputerUsePermission'),
    isSessionPermissionPending: asFn('isSessionPermissionPending'),
    getSessionTurnState: asFn('getSessionTurnState'),
  }
}

async function loadDefaultSender(): Promise<TelegramPublicServiceDeps['sendTelegramChannelMessage']> {
  const notifications = await import('./notificationService.js') as Record<string, unknown>
  const send = notifications.sendTelegramChannelMessage
  if (typeof send !== 'function') missingHandler('sendTelegramChannelMessage')
  return send as TelegramPublicServiceDeps['sendTelegramChannelMessage']
}

function snapshotFromConfig(config: AdapterFileConfig): PublicSnapshot {
  const telegram = config.telegram
  const present = !!telegram && Object.prototype.hasOwnProperty.call(telegram, 'public')
  const pub = telegram?.public
  const roots = Array.isArray(pub?.allowedProjectRoots)
    ? pub.allowedProjectRoots.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const top = Array.isArray(config.allowedProjectRoots)
    ? config.allowedProjectRoots.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    present,
    enabled: pub?.enabled === true,
    botToken: typeof pub?.botToken === 'string' ? pub.botToken : '',
    ownerUserId: positiveInteger(pub?.ownerUserId),
    generation: typeof pub?.generation === 'number' && Number.isSafeInteger(pub.generation) ? pub.generation : 0,
    allowedProjectRoots: roots.length > 0 ? roots : top,
  }
}

function parseOwnerChat(update: unknown, ownerUserId: number | null):
  | { ok: true; chat: OwnerChat }
  | { ok: false; reason: string } {
  if (!isRecord(update)) return { ok: false, reason: '无效的 Telegram update' }
  const message = isRecord(update.message) ? update.message : null
  if (!message) return { ok: false, reason: '缺少消息' }
  const chat = isRecord(message.chat) ? message.chat : null
  const from = isRecord(message.from) ? message.from : null
  if (chat?.type !== 'private') return { ok: false, reason: '公共入口只接受私聊' }
  const chatId = positiveInteger(chat?.id)
  const userId = positiveInteger(from?.id)
  if (chatId == null || userId == null) return { ok: false, reason: '只接受正整数私聊用户' }
  if (chatId !== userId) return { ok: false, reason: '公共入口只接受操作者本人的私聊' }
  if (ownerUserId != null && (chatId !== ownerUserId || userId !== ownerUserId)) {
    return { ok: false, reason: '公共入口只接受已配对操作者的私聊' }
  }
  const reply = isRecord(message.reply_to_message) ? message.reply_to_message : null
  const replyTo = reply ? positiveInteger(reply.message_id) : null
  return {
    ok: true,
    chat: {
      chatId,
      userId,
      messageId: positiveInteger(message.message_id) ?? undefined,
      text: typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : undefined,
      replyToMessageId: replyTo ?? undefined,
      forwarded: isForwarded(message),
      replyForwarded: reply ? isForwarded(reply) : false,
      hasMedia: hasMediaPayload(message),
    },
  }
}

function parseCallback(update: unknown, ownerUserId: number | null):
  | { ok: true; chatId: number; userId: number; data: string; messageId?: number }
  | { ok: false; reason: string } {
  if (!isRecord(update) || !isRecord(update.callback_query)) return { ok: false, reason: '缺少 callback' }
  const query = update.callback_query
  const from = isRecord(query.from) ? query.from : null
  const userId = positiveInteger(from?.id)
  if (typeof query.inline_message_id === 'string' && query.inline_message_id.length > 0 && !isRecord(query.message)) {
    return { ok: false, reason: '不接受 inline callback' }
  }
  const message = isRecord(query.message) ? query.message : null
  if (!message) return { ok: false, reason: 'callback 缺少消息，不接受 inline' }
  const chat = isRecord(message.chat) ? message.chat : null
  if (!chat) return { ok: false, reason: 'callback 缺少 chat' }
  if (chat.type !== 'private') return { ok: false, reason: '公共入口只接受私聊' }
  const chatId = positiveInteger(chat.id)
  if (userId == null || chatId == null) return { ok: false, reason: '只接受正整数私聊用户' }
  if (chatId !== userId) return { ok: false, reason: '公共入口只接受操作者本人的私聊' }
  if (ownerUserId != null && (chatId !== ownerUserId || userId !== ownerUserId)) {
    return { ok: false, reason: '公共入口只接受已配对操作者的私聊' }
  }
  if (typeof query.data !== 'string' || query.data.length === 0) return { ok: false, reason: '缺少 callback data' }
  return {
    ok: true,
    chatId,
    userId,
    data: query.data,
    messageId: positiveInteger(message.message_id) ?? undefined,
  }
}

function headerPrefix(
  project: string,
  title: string,
  shortId: string,
  category: string,
  extras?: { team?: string; member?: string },
): string {
  const trimmedProject = project.trim() || '未命名项目'
  const trimmedTitle = title.trim() || '未命名会话'
  const parts = ['ccmax', '订阅会话', trimmedProject, trimmedTitle]
  if (extras?.team?.trim()) parts.push(extras.team.trim())
  if (extras?.member?.trim()) parts.push(extras.member.trim())
  parts.push(shortId)
  return `[${parts.join(' · ')}] ${category}`
}

function headerExtras(subscription: TelegramPublicSubscription): { team?: string; member?: string } {
  return {
    ...(typeof subscription.team === 'string' && subscription.team.trim() ? { team: subscription.team } : {}),
    ...(typeof subscription.member === 'string' && subscription.member.trim() ? { member: subscription.member } : {}),
  }
}

function runtimeOwnerId(runtime: TelegramPublicRuntimeState | undefined): number | null {
  return positiveInteger(runtime?.ownerUserId)
}

function subscriptionProject(summary: TelegramPublicSessionSummary | null | undefined, fallback?: string): string {
  return summary?.workDir || summary?.projectRoot || summary?.projectPath || fallback || ''
}

export class TelegramPublicService {
  private readonly deps: Partial<TelegramPublicServiceDeps>
  private storeOverride: TelegramPublicStore | undefined
  private handlerOverride: TelegramPublicHandlerDeps | undefined
  private unobserve: (() => void) | undefined
  private started = false
  private runtimeEpoch = 0
  private liveRuntime: { botId: number; generation: number; ownerUserId: number | null } | null = null
  private eventTail: Promise<void> = Promise.resolve()
  private drainTail: Promise<void> = Promise.resolve()
  private inboundTail: Promise<void> = Promise.resolve()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private serverHost: string
  private serverPort: number
  private defaultStore: TelegramPublicStore | undefined
  private defaultEventLog: TelegramPublicEventLog | undefined
  private dedicatedStore: { get(chatId: string): { sessionId: string } | null } | undefined
  private eventLogError: string | undefined
  private readonly subscriptionRevisions = new Map<string, number>()
  private readonly subscriptionLists = new TelegramSubscriptionLists({
    now: () => this.now(),
    valid: actor => this.runtimeStillMatches(actor.botId, actor.generation, actor.userId),
    sessions: query => this.subscriptionListSessions(query),
    subscriptions: async () => (await this.readState()).subscriptions,
    subscribe: (id, actor) => this.subscribe(id, actor),
    revision: id => this.subscriptionRevisions.get(id) ?? 0,
    unsubscribe: (id, actor, revision) => this.unsubscribe(id, actor, revision),
    deliveries: async () => {
      const recent = (await this.getStatus()).deliveries.slice(0, 5)
      return recent.length ? '\n最近投递：\n' + recent.map(item => `  ${item.id}: ${item.status}${item.error ? ` (${item.error.slice(0, 180)})` : ''}`).join('\n') : ''
    },
    present: async (actor, text, replyMarkup, messageId) => {
      const snapshot = await this.snapshot()
      if (!await this.runtimeStillMatches(actor.botId, actor.generation, actor.userId)) throw new Error('列表已失效，请重新打开。')
      let result: TelegramChannelSendResult
      if (messageId) {
        const edit = this.deps.editTelegramChannelMessage
          ?? (await import('./notificationService.js')).editTelegramChannelMessage
        result = await edit(snapshot.botToken, actor.chatId, messageId, text, { replyMarkup })
      } else {
        result = await (await this.sender())(snapshot.botToken, actor.chatId, text, { replyMarkup })
      }
      if (result.outcome !== 'delivered' || !result.messageId) {
        throw new Error(`列表更新失败；订阅状态请用 /subscriptions 核对。${result.error || result.outcome}`)
      }
      return result.messageId
    },
    notice: async (actor, text) => {
      if (!await this.runtimeStillMatches(actor.botId, actor.generation, actor.userId)) throw new Error('列表已失效，请重新打开。')
      const result = await (await this.sender())((await this.snapshot()).botToken, actor.chatId, text)
      if (result.outcome !== 'delivered') throw new Error(`操作结果发送失败，请用 /subscriptions 核对。${result.error || result.outcome}`)
    },
  })
  private eligibility: EligibilityCache = {
    present: false,
    enabled: false,
    ownerUserId: null,
    generation: 0,
    botId: null,
    live: false,
    subscriptions: new Set(),
  }

  constructor(deps: Partial<TelegramPublicServiceDeps> = {}) {
    this.deps = deps
    this.storeOverride = deps.store
    this.handlerOverride = deps.handler
    this.serverHost = deps.serverHost ?? '127.0.0.1'
    this.serverPort = deps.serverPort ?? 0
  }

  configure(options: { serverHost: string; serverPort: number }): void {
    this.serverHost = options.serverHost
    this.serverPort = options.serverPort
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (!this.deps.getDedicatedBinding && !this.dedicatedStore) {
      void import('../../../adapters/common/session-store.js').then(module => {
        this.dedicatedStore ??= new module.SessionStore()
      }).catch(() => {})
    }
    const snapshot = await this.snapshot()
    await this.refreshEligibilityCache()
    const store = this.store()
    if (!snapshot.present && !(await store.exists())) {
      this.attachObserver()
      return
    }
    if (snapshot.present) {
      await this.recoverCrashedState()
      await this.recoverEventLog()
      await this.refreshEligibilityCache()
    }
    this.attachObserver()
    this.enqueueDrain()
  }

  stop(): void {
    this.started = false
    this.unobserve?.()
    this.unobserve = undefined
    this.liveRuntime = null
    this.eligibility.live = false
    this.eligibility.botId = null
    this.subscriptionLists.reset()
    this.runtimeEpoch += 1
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  async flushForTests(): Promise<void> {
    this.enqueueDrain()
    await this.eventTail
    await this.inboundTail
    await this.drainTail
    await this.eventTail
    await this.inboundTail
    await this.drainTail
  }

  async registerRuntime(input: { botId: number; generation: number }): Promise<TelegramPublicStatus> {
    const botId = positiveInteger(input.botId)
    const generation = typeof input.generation === 'number' && Number.isSafeInteger(input.generation)
      ? input.generation
      : null
    if (botId == null) throw ApiError.badRequest('botId must be a positive integer')
    if (generation == null || generation < 0) throw ApiError.badRequest('generation must be a non-negative integer')
    const snapshot = await this.requireEnabled()
    if (generation !== snapshot.generation) {
      throw ApiError.badRequest('generation does not match telegram.public.generation')
    }
    const tokenBotId = botIdFromStoredToken(snapshot.botToken)
    if (tokenBotId != null && tokenBotId !== botId) {
      throw ApiError.badRequest('botId does not match telegram.public.botToken identity')
    }
    const existing = await this.readState()
    if (existing.runtime && existing.runtime.generation === generation && existing.runtime.botId !== botId) {
      throw ApiError.badRequest('botId does not match registered runtime identity')
    }
    this.subscriptionLists.reset()
    this.runtimeEpoch += 1
    const now = this.isoNow()
    await this.mutate(current => {
      const previous = current.runtime
      if (previous && previous.generation === generation && previous.botId !== botId) {
        throw ApiError.badRequest('botId does not match registered runtime identity')
      }
      const previousOwner = runtimeOwnerId(previous)
      const nextOwner = snapshot.ownerUserId
      const identityChanged = !previous || previous.botId !== botId || previous.generation !== generation
      const ownerChanged = previousOwner != null && previousOwner !== nextOwner
      if (identityChanged || ownerChanged) {
        this.invalidateRuntime(current, previous, 'Bot 身份或代次已变更，旧待发不会改投新 Bot')
      }
      if (ownerChanged) {
        this.clearOwnerSubscriptions(current, '操作者已变更，订阅不继承')
      }
      current.runtime = {
        botId,
        generation,
        registeredAt: now,
        ownerUserId: nextOwner,
      }
    })
    this.liveRuntime = { botId, generation, ownerUserId: snapshot.ownerUserId }
    await this.refreshEligibilityCache()
    this.enqueueDrain()
    return this.getStatus()
  }

  async deregisterRuntime(input: { botId: number; generation: number }): Promise<TelegramPublicStatus> {
    const botId = positiveInteger(input.botId)
    const generation = typeof input.generation === 'number' && Number.isSafeInteger(input.generation)
      ? input.generation
      : null
    if (botId == null) throw ApiError.badRequest('botId must be a positive integer')
    if (generation == null || generation < 0) throw ApiError.badRequest('generation must be a non-negative integer')
    if (!this.liveRuntime || this.liveRuntime.botId !== botId || this.liveRuntime.generation !== generation) {
      throw ApiError.badRequest('runtime is not registered')
    }
    this.liveRuntime = null
    this.subscriptionLists.reset()
    this.runtimeEpoch += 1
    this.eligibility.live = false
    this.eligibility.botId = null
    return this.getStatus()
  }

  async handleUpdate(input: { botId: number; generation: number; update: unknown }): Promise<{ ok: true; duplicate?: boolean; accepted?: boolean } | { ok: false; error: string }> {
    const botId = positiveInteger(input.botId)
    const generation = typeof input.generation === 'number' && Number.isSafeInteger(input.generation)
      ? input.generation
      : null
    if (botId == null) throw ApiError.badRequest('botId must be a positive integer')
    if (generation == null || generation < 0) throw ApiError.badRequest('generation must be a non-negative integer')
    const snapshot = await this.requireEnabled()
    if (generation !== snapshot.generation) {
      return { ok: false, error: 'Bot 运行时身份与配置代次不一致' }
    }
    if (!this.liveRuntime || this.liveRuntime.botId !== botId || this.liveRuntime.generation !== generation) {
      return { ok: false, error: 'Bot 运行时未注册或已停止' }
    }
    if (this.liveRuntime.ownerUserId !== snapshot.ownerUserId) {
      return { ok: false, error: 'Bot 运行时身份与配置代次不一致' }
    }
    const state = await this.readState()
    if (!state.runtime || state.runtime.botId !== botId || state.runtime.generation !== generation) {
      return { ok: false, error: 'Bot 运行时身份与已注册代次不一致' }
    }
    if (!this.runtimeMatchesSnapshot(state.runtime, snapshot)) {
      return { ok: false, error: 'Bot 运行时身份与配置代次不一致' }
    }
    if (!isRecord(input.update) || typeof input.update.update_id !== 'number' || !Number.isSafeInteger(input.update.update_id)) {
      throw ApiError.badRequest('update.update_id must be an integer')
    }
    const updateId = input.update.update_id
    const key = inboundUpdateKey(generation, botId, updateId)
    const claimed = await this.claimInbound(key, {
      key,
      updateId,
      botId,
      generation,
      status: 'processing',
      createdAt: this.isoNow(),
    })
    if (claimed === 'duplicate') return { ok: true, duplicate: true }
    if (claimed === 'unknown') {
      return { ok: false, error: '该 update 在上次中断后状态未知，不会自动重放' }
    }

    try {
      if (!await this.runtimeStillMatches(botId, generation, snapshot.ownerUserId)) {
        await this.completeInbound(key, 'rejected')
        return { ok: false, error: 'Bot 运行时身份与配置代次不一致' }
      }
      let background = false
      if (isRecord(input.update.callback_query)) {
        await this.handleCallback(snapshot, state.runtime.botId, state.runtime.generation, input.update)
      } else if (isRecord(input.update.message)) {
        background = (await this.handleMessage(snapshot, state.runtime.botId, state.runtime.generation, input.update, key)) === 'background'
      }
      if (background) return { ok: true, accepted: true }
      await this.completeInbound(key, 'completed')
      return { ok: true }
    } catch (error) {
      await this.completeInbound(key, 'unknown')
      throw error
    }
  }

  async getStatus(): Promise<TelegramPublicStatus> {
    const snapshot = await this.snapshot()
    const state = snapshot.present || await this.store().exists()
      ? await this.readState()
      : emptyTelegramPublicStore()
    const deliveries = [...state.outbox]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, 50)
      .map(record => ({
        id: record.id,
        status: record.status,
        ...(record.error ? { error: record.error } : {}),
      }))
    return {
      ...(state.runtime?.botId ? { botId: state.runtime.botId } : {}),
      generation: state.runtime?.generation ?? snapshot.generation,
      running: this.isLive(snapshot),
      ownerUserId: snapshot.ownerUserId,
      ...(this.eventLogError ? { error: this.eventLogError } : {}),
      subscriptions: Object.values(state.subscriptions).map(entry => ({
        sessionId: entry.sessionId,
        shortId: entry.shortId,
        title: typeof entry.title === 'string' ? entry.title : '',
        project: typeof entry.project === 'string' ? entry.project : '',
      })),
      deliveries,
    }
  }

  async subscribe(sessionId: string, actor?: SubscriptionListActor): Promise<TelegramPublicSubscription> {
    const epoch = this.runtimeEpoch
    const id = sessionId.trim()
    if (!id) throw ApiError.badRequest('sessionId is required')
    const snapshot = await this.requireEnabled()
    if (snapshot.ownerUserId == null) {
      throw ApiError.badRequest('public owner is not paired')
    }
    const resolved = await this.resolveSessionRef(id)
    if ('error' in resolved) throw ApiError.badRequest(resolved.error)
    const summary = await this.sessionSummary(resolved.sessionId)
    if (!summary) throw ApiError.notFound('Session not found')
    if (!await this.sessionAllowed(summary, snapshot.allowedProjectRoots)) {
      throw ApiError.badRequest('Session is outside allowed project roots')
    }
    if (actor && !await this.runtimeStillMatches(actor.botId, actor.generation, actor.userId)) {
      throw ApiError.badRequest('列表已失效，请重新打开。')
    }
    const latest = await this.requireEnabled()
    if (latest.ownerUserId !== snapshot.ownerUserId || latest.generation !== snapshot.generation
      || latest.botToken !== snapshot.botToken
      || !await this.sessionAllowed(summary, latest.allowedProjectRoots)) {
      throw ApiError.badRequest('订阅权限已变化，请重新打开列表。')
    }
    const subscribedAt = this.isoNow()
    let created: TelegramPublicSubscription | undefined
    await this.mutate(current => {
      if (actor && (epoch !== this.runtimeEpoch || !this.liveRuntime
        || this.liveRuntime.botId !== actor.botId || this.liveRuntime.generation !== actor.generation
        || this.liveRuntime.ownerUserId !== actor.userId)) throw ApiError.badRequest('列表已失效，请重新打开。')
      const existing = current.subscriptions[resolved.sessionId]
      if (existing) {
        existing.title = summary.title
        existing.project = subscriptionProject(summary, existing.project)
        created = existing
        return
      }
      const used = new Set(Object.keys(current.shortIds))
      const reused = Object.entries(current.shortIds).find(([, value]) => value === resolved.sessionId)?.[0]
      const shortId = reused ?? allocateShortId(used)
      current.shortIds[shortId] = resolved.sessionId
      created = {
        sessionId: resolved.sessionId,
        shortId,
        subscribedAt,
        title: summary.title,
        project: subscriptionProject(summary),
      }
      current.subscriptions[resolved.sessionId] = created
      this.subscriptionRevisions.set(resolved.sessionId, (this.subscriptionRevisions.get(resolved.sessionId) ?? 0) + 1)
    })
    if (!created) throw ApiError.internal('Failed to persist subscription')
    this.eligibility.subscriptions.add(created.sessionId)
    return created
  }

  async sendSessionReport(sessionId: string, eventId: string, text: string): Promise<{ queued: true }> {
    const snapshot = await this.requireEnabled()
    if (snapshot.ownerUserId == null) throw ApiError.badRequest('public owner is not paired')
    const id = sessionId.trim()
    const stableId = eventId.trim()
    const body = text.trim()
    if (!id) throw ApiError.badRequest('sessionId is required')
    if (!stableId) throw ApiError.badRequest('eventId is required')
    if (!body) throw ApiError.badRequest('text is required')
    const state = await this.readState()
    if (!this.runtimeMatchesSnapshot(state.runtime, snapshot)) {
      throw ApiError.badRequest('Bot 运行时身份与配置代次不一致')
    }
    const subscription = state.subscriptions[id]
    if (!subscription) throw ApiError.badRequest('Session is not subscribed')
    const summary = await this.sessionSummary(id)
    if (!summary) throw ApiError.notFound('Session not found')
    if (!await this.sessionAllowed(summary, snapshot.allowedProjectRoots)) {
      throw ApiError.badRequest('Session is outside allowed project roots')
    }
    const header = headerPrefix(
      subscriptionProject(summary),
      summary.title,
      subscription.shortId,
      '通知',
      { team: summary.team, member: summary.member },
    )
    await this.enqueueReport({
      snapshot,
      runtime: state.runtime!,
      subscription: {
        ...subscription,
        title: summary.title,
        project: subscriptionProject(summary),
      },
      eventId: stableId,
      text: `${header}：\n${body}`,
      kind: 'report',
    })
    return { queued: true }
  }

  async unsubscribe(sessionId: string, actor?: SubscriptionListActor, expectedRevision?: number): Promise<void> {
    const epoch = this.runtimeEpoch
    const id = sessionId.trim()
    if (!id) throw ApiError.badRequest('sessionId is required')
    await this.requireEnabled()
    const resolved = await this.resolveSessionRef(id)
    const target = 'sessionId' in resolved ? resolved.sessionId : id
    if (actor && !await this.runtimeStillMatches(actor.botId, actor.generation, actor.userId)) throw ApiError.badRequest('列表已失效，请重新打开。')
    await this.mutate(current => {
      if (actor && (epoch !== this.runtimeEpoch || !this.liveRuntime
        || this.liveRuntime.botId !== actor.botId || this.liveRuntime.generation !== actor.generation
        || this.liveRuntime.ownerUserId !== actor.userId)) throw ApiError.badRequest('列表已失效，请重新打开。')
      if (expectedRevision !== undefined && expectedRevision !== (this.subscriptionRevisions.get(target) ?? 0)) {
        throw ApiError.badRequest('订阅状态已变化，取消确认已失效。')
      }
      const existing = current.subscriptions[target]
      if (!existing && !('sessionId' in resolved)) throw ApiError.notFound('Subscription not found')
      delete current.subscriptions[target]
      this.subscriptionRevisions.set(target, (this.subscriptionRevisions.get(target) ?? 0) + 1)
      this.revokeSessionInteraction(current, target, '已取消订阅')
    })
    this.eligibility.subscriptions.delete(target)
  }

  private store(): TelegramPublicStore {
    if (this.storeOverride) return this.storeOverride
    return this.defaultStore ??= new TelegramPublicStore(getTelegramPublicStorePath())
  }

  private eventLog(): TelegramPublicEventLog {
    return this.defaultEventLog ??= TelegramPublicEventLog.fromStorePath(this.store().filePath)
  }

  private attachObserver(): void {
    if (this.unobserve) return
    const observe = this.deps.observeSessionTurns ?? observeSessionTurns
    this.unobserve = observe(event => {
      this.journalEligibleEvent(event)
      this.eventTail = this.eventTail
        .then(() => this.onTurnEvent(event))
        .catch(error => {
          console.error('[TelegramPublic] turn event failed', error instanceof Error ? error.message : error)
        })
    })
  }

  private isLive(snapshot: PublicSnapshot): boolean {
    return this.liveRuntime != null
      && snapshot.present
      && snapshot.enabled
      && this.liveRuntime.generation === snapshot.generation
      && this.liveRuntime.ownerUserId === snapshot.ownerUserId
  }

  private async refreshEligibilityCache(): Promise<void> {
    const snapshot = await this.snapshot()
    let subscriptions = this.eligibility.subscriptions
    if (snapshot.present) {
      try {
        const state = await this.readState()
        subscriptions = new Set(Object.keys(state.subscriptions))
      } catch {
        subscriptions = new Set()
      }
    } else {
      subscriptions = new Set()
    }
    this.eligibility = {
      present: snapshot.present,
      enabled: snapshot.enabled,
      ownerUserId: snapshot.ownerUserId,
      generation: snapshot.generation,
      botId: this.liveRuntime?.botId ?? null,
      live: this.isLive(snapshot),
      subscriptions,
    }
  }

  private permissionOrigin(sessionId: string, requestId: string | undefined): SessionTurnOrigin | undefined {
    if (!requestId) return undefined
    const lookup = this.deps.getSessionPermissionOrigin ?? getSessionPermissionOrigin
    return lookup(sessionId, requestId)
  }

  private async handler(): Promise<TelegramPublicHandlerDeps> {
    if (this.handlerOverride) return this.handlerOverride
    this.handlerOverride = this.deps.handler ?? await loadDefaultHandler()
    return this.handlerOverride
  }

  private async sender() {
    if (this.deps.sendTelegramChannelMessage) return this.deps.sendTelegramChannelMessage
    return loadDefaultSender()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  private async snapshot(): Promise<PublicSnapshot> {
    const getRaw = this.deps.getRawConfig ?? (() => adapterService.getRawConfig())
    return snapshotFromConfig(await getRaw())
  }

  private async requirePresent(): Promise<PublicSnapshot> {
    const snapshot = await this.snapshot()
    if (!snapshot.present) throw ApiError.badRequest('telegram.public is not configured')
    return snapshot
  }

  private async requireEnabled(): Promise<PublicSnapshot> {
    const snapshot = await this.requirePresent()
    if (!snapshot.enabled) throw ApiError.badRequest('telegram.public is disabled')
    return snapshot
  }

  private async mutate(update: (current: TelegramPublicStoreFile) => void): Promise<TelegramPublicStoreFile> {
    const snapshot = await this.snapshot()
    if (!snapshot.present) {
      throw ApiError.badRequest('telegram.public is not configured')
    }
    try {
      return await this.store().mutate(current => {
        update(current)
        return current
      })
    } catch (error) {
      this.rethrowStoreError(error)
    }
  }

  private async readState(): Promise<TelegramPublicStoreFile> {
    try {
      return await this.store().read()
    } catch (error) {
      this.rethrowStoreError(error)
    }
  }

  private rethrowStoreError(error: unknown): never {
    if (error instanceof TelegramPublicStoreError) {
      throw ApiError.internal(error.message)
    }
    throw error
  }

  private runtimeMatchesSnapshot(
    runtime: TelegramPublicRuntimeState | undefined,
    snapshot: PublicSnapshot,
  ): runtime is TelegramPublicRuntimeState {
    if (!runtime) return false
    if (runtime.generation !== snapshot.generation) return false
    return runtimeOwnerId(runtime) === snapshot.ownerUserId
  }

  private async runtimeStillMatches(
    botId: number,
    generation: number,
    ownerUserId: number | null,
  ): Promise<boolean> {
    const snapshot = await this.snapshot()
    if (!snapshot.present || !snapshot.enabled) return false
    if (snapshot.generation !== generation) return false
    if (snapshot.ownerUserId !== ownerUserId) return false
    const tokenBotId = botIdFromStoredToken(snapshot.botToken)
    if (tokenBotId != null && tokenBotId !== botId) return false
    if (!this.liveRuntime) return false
    if (this.liveRuntime.botId !== botId || this.liveRuntime.generation !== generation) return false
    return this.liveRuntime.ownerUserId === ownerUserId
  }

  private async sessionSummary(sessionId: string): Promise<TelegramPublicSessionSummary | null> {
    if (this.deps.getSessionSummary) return this.deps.getSessionSummary(sessionId)
    const summary = await sessionService.getSessionSummary(sessionId)
    if (!summary) return null
    return {
      id: summary.id,
      title: summary.title,
      projectPath: summary.projectPath,
      projectRoot: summary.projectRoot,
      workDir: summary.workDir,
    }
  }

  private async resolveSessionRef(raw: string): Promise<{ sessionId: string } | { error: string }> {
    const trimmed = raw.trim()
    if (!trimmed) return { error: '缺少会话编号' }
    const state = await this.readState()
    if (state.subscriptions[trimmed]) return { sessionId: trimmed }
    const byShort = lookupShortId(state, trimmed)
    if ('sessionId' in byShort) return byShort
    const summary = await this.sessionSummary(trimmed)
    if (summary) return { sessionId: summary.id }
    return byShort
  }

  private async realpath(target: string): Promise<string | null> {
    const expanded = expandHome(target)
    try {
      if (this.deps.realpath) return await this.deps.realpath(expanded)
      return await fs.realpath(expanded)
    } catch {
      return null
    }
  }

  private async sessionAllowed(summary: TelegramPublicSessionSummary, roots: string[]): Promise<boolean> {
    if (roots.length === 0) return true
    const candidate = typeof summary.workDir === 'string' && summary.workDir.length > 0
      ? summary.workDir
      : typeof summary.projectRoot === 'string' && summary.projectRoot.length > 0
        ? summary.projectRoot
        : summary.projectPath
    if (!candidate) return false
    const real = await this.realpath(candidate)
    if (!real) return false
    for (const root of roots) {
      const realRoot = await this.realpath(root)
      if (realRoot && isPathInside(real, realRoot)) return true
    }
    return false
  }

  private async sessionStillOperable(
    sessionId: string,
    snapshot: PublicSnapshot,
  ): Promise<{ ok: true; summary: TelegramPublicSessionSummary } | { ok: false; reason: string }> {
    const summary = await this.sessionSummary(sessionId)
    if (!summary) return { ok: false, reason: '会话已删除，请重新选择。' }
    if (!await this.sessionAllowed(summary, snapshot.allowedProjectRoots)) {
      return { ok: false, reason: '该会话已不在允许的项目根目录内。' }
    }
    return { ok: true, summary }
  }

  private dedicatedBinding(chatId: string): { sessionId: string } | null {
    if (this.deps.getDedicatedBinding) return this.deps.getDedicatedBinding(chatId)
    return this.dedicatedStore?.get(chatId) ?? null
  }

  private invalidateRuntime(
    current: TelegramPublicStoreFile,
    previous: TelegramPublicStoreFile['runtime'],
    reason: string,
  ): void {
    if (!previous) {
      current.messageMaps = {}
      current.callbackTokens = {}
      return
    }
    current.outbox = current.outbox.map(record => {
      if (record.botId === previous.botId && record.generation === previous.generation
        && (record.status === 'queued' || record.status === 'sending')) {
        return {
          ...record,
          status: 'failed',
          error: reason,
          updatedAt: this.isoNow(),
        }
      }
      return record
    })
    const nextMaps: Record<string, TelegramPublicMessageMap> = {}
    for (const [key, entry] of Object.entries(current.messageMaps)) {
      if (entry.botId === previous.botId && entry.generation === previous.generation) continue
      nextMaps[key] = entry
    }
    current.messageMaps = nextMaps
    const nextTokens: Record<string, TelegramPublicCallbackToken> = {}
    for (const [token, entry] of Object.entries(current.callbackTokens)) {
      if (entry.botId === previous.botId && entry.generation === previous.generation) continue
      nextTokens[token] = entry
    }
    current.callbackTokens = nextTokens
  }

  private clearOwnerSubscriptions(current: TelegramPublicStoreFile, reason: string): void {
    for (const sessionId of Object.keys(current.subscriptions)) {
      this.revokeSessionInteraction(current, sessionId, reason)
    }
    current.subscriptions = {}
  }

  private revokeSessionInteraction(current: TelegramPublicStoreFile, sessionId: string, reason: string): void {
    current.outbox = current.outbox.map(record => {
      if (record.sessionId === sessionId && record.status === 'queued') {
        return { ...record, status: 'failed', error: reason, updatedAt: this.isoNow() }
      }
      return record
    })
    const nextMaps: Record<string, TelegramPublicMessageMap> = {}
    for (const [key, entry] of Object.entries(current.messageMaps)) {
      if (entry.sessionId === sessionId) continue
      nextMaps[key] = entry
    }
    current.messageMaps = nextMaps
    const nextTokens: Record<string, TelegramPublicCallbackToken> = {}
    for (const [token, entry] of Object.entries(current.callbackTokens)) {
      if (entry.sessionId === sessionId) continue
      nextTokens[token] = entry
    }
    current.callbackTokens = nextTokens
  }

  private async recoverCrashedState(): Promise<void> {
    if (!await this.store().exists()) return
    const current = await this.readState()
    const hasSending = current.outbox.some(record => record.status === 'sending')
    const hasProcessing = Object.values(current.inboundUpdates).some(entry => entry.status === 'processing')
    if (!hasSending && !hasProcessing) return
    await this.mutate(state => {
      state.outbox = state.outbox.map(record => {
        if (record.status !== 'sending') return record
        return {
          ...record,
          status: 'indeterminate',
          error: '投递在发送中进程退出，平台是否收到无法确证',
          updatedAt: this.isoNow(),
        }
      })
      for (const entry of Object.values(state.inboundUpdates)) {
        if (entry.status === 'processing') entry.status = 'unknown'
      }
    })
  }

  private async claimInbound(
    key: string,
    record: TelegramPublicInboundUpdate,
  ): Promise<'claimed' | 'duplicate' | 'unknown'> {
    let result: 'claimed' | 'duplicate' | 'unknown' = 'claimed'
    await this.mutate(current => {
      const existing = current.inboundUpdates[key]
      if (existing) {
        result = existing.status === 'unknown' ? 'unknown' : 'duplicate'
        return
      }
      const markKey = inboundWatermarkKey(record.generation, record.botId)
      current.inboundWatermarks ??= {}
      const watermark = current.inboundWatermarks[markKey]
      if (watermark && record.updateId <= watermark.lastUpdateId) {
        result = 'duplicate'
        return
      }
      current.inboundUpdates[key] = record
      current.inboundWatermarks[markKey] = {
        botId: record.botId,
        generation: record.generation,
        lastUpdateId: Math.max(watermark?.lastUpdateId ?? record.updateId, record.updateId),
        updatedAt: this.isoNow(),
      }
    })
    return result
  }

  private async completeInbound(key: string, status: TelegramPublicInboundUpdate['status']): Promise<void> {
    await this.mutate(current => {
      const existing = current.inboundUpdates[key]
      if (existing) existing.status = status
    })
  }

  private async handleMessage(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    update: Record<string, unknown>,
    inputId: string,
  ): Promise<'background' | void> {
    const parsed = parseOwnerChat(update, snapshot.ownerUserId)
    if (!parsed.ok) {
      if (snapshot.ownerUserId == null) {
        const unpaired = parseOwnerChat(update, null)
        if (unpaired.ok && unpaired.chat.text?.trim().startsWith('/pair')) {
          await this.handlePair(snapshot, unpaired.chat, botId)
          return
        }
      }
      return
    }
    const chat = parsed.chat
    if (snapshot.ownerUserId == null) {
      if (chat.text?.trim().startsWith('/pair')) {
        await this.handlePair(snapshot, chat, botId)
        return
      }
      await this.replyRaw(snapshot, String(chat.chatId), '尚未配对。请发送 /pair <配对码>。')
      return
    }
    if (chat.hasMedia) {
      await this.replyRaw(snapshot, String(chat.chatId), '公共入口暂不支持图片、语音或附件，未执行任何文本。')
      return
    }
    const text = (chat.text ?? '').trim()
    if (chat.forwarded || chat.replyForwarded) {
      await this.replyRaw(snapshot, String(chat.chatId), '不接受转发消息作为会话目标。请回复原始报告或使用 /to。')
      return
    }
    if (text.startsWith('/')) {
      return this.handleCommand(snapshot, botId, generation, chat, text, inputId)
    }
    return this.handlePlainText(snapshot, botId, generation, chat, text, inputId)
  }

  private async handlePair(snapshot: PublicSnapshot, chat: OwnerChat, botId: number): Promise<void> {
    const match = (chat.text ?? '').trim().match(/^\/pair(?:@\w+)?\s+(\S+)/i)
    if (!match) {
      await this.replyRaw(snapshot, String(chat.chatId), '用法：/pair <配对码>')
      return
    }
    const claim = this.deps.claimPairing ?? ((code, userId) => adapterService.claimTelegramPublicPairing(code, userId))
    try {
      const result = await claim(match[1]!, chat.userId)
      try {
        await this.registerRuntime({ botId, generation: result.generation })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await this.replyRaw(
          snapshot,
          String(chat.chatId),
          `已配对。操作者 ${result.ownerUserId}，代次 ${result.generation}。运行时未刷新：${detail}`,
        )
        return
      }
      await this.replyRaw(snapshot, String(chat.chatId), `已配对。操作者 ${result.ownerUserId}，代次 ${result.generation}。`)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '配对失败'
      await this.replyRaw(snapshot, String(chat.chatId), message)
    }
  }

  private async handleCommand(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    chat: OwnerChat,
    text: string,
    inputId: string,
  ): Promise<'background' | void> {
    const match = text.match(/^\/([A-Za-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
    const command = match?.[1]?.toLowerCase() ?? ''
    const arg = match?.[2]?.trim() ?? ''
    switch (command) {
      case 'pair':
        await this.handlePair(snapshot, chat, botId)
        return
      case 'sessions':
        await this.commandSessions(snapshot, chat, arg)
        return
      case 'subscribe':
        await this.commandSubscribe(snapshot, chat, arg)
        return
      case 'unsubscribe':
        await this.commandUnsubscribe(snapshot, chat, arg)
        return
      case 'subscriptions':
        await this.commandSubscriptions(snapshot, chat)
        return
      case 'to':
        return this.commandTo(snapshot, botId, generation, chat, arg, inputId)
      default:
        await this.replyRaw(
          snapshot,
          String(chat.chatId),
          '可用命令：/sessions、/subscribe、/unsubscribe、/subscriptions、/to <短编号> 文本',
        )
    }
  }

  private async subscriptionListSessions(query: string): Promise<TelegramPublicSessionSummary[]> {
    const snapshot = await this.requireEnabled()
    const rows: TelegramPublicSessionSummary[] = []
    const seen = new Set<string>()
    const search = this.deps.searchSessionMetadata
      ?? ((needle: string, options?: { limit?: number; offset?: number }) => sessionService.searchSessionMetadata(needle, options))
    const list = this.deps.listSessions ?? (options => sessionService.listSessions(options))
    for (let offset = 0; ; ) {
      const found = query ? await search(query, { limit: 100, offset }) : await list({ limit: 100, offset })
      if (found.sessions.length === 0) break
      let added = 0
      for (const row of found.sessions) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        added += 1
        if (await this.sessionAllowed(row, snapshot.allowedProjectRoots)) rows.push(row)
      }
      offset += found.sessions.length
      if (added === 0 || found.total === undefined || offset >= found.total) break
    }
    return rows
  }

  private async commandSessions(snapshot: PublicSnapshot, chat: OwnerChat, query: string): Promise<void> {
    const runtime = this.liveRuntime!
    await this.subscriptionLists.open({ botId: runtime.botId, generation: runtime.generation, userId: snapshot.ownerUserId!, chatId: String(chat.chatId) }, 'sessions', query)
  }

  private async commandSubscribe(snapshot: PublicSnapshot, chat: OwnerChat, arg: string): Promise<void> {
    if (!arg) {
      await this.replyRaw(snapshot, String(chat.chatId), '用法：/subscribe <完整会话 id 或短编号>')
      return
    }
    try {
      const created = await this.subscribe(arg)
      await this.replyRaw(snapshot, String(chat.chatId), `已订阅 ${created.shortId}（${created.title || created.sessionId}）。之后的事件才会报告。`)
    } catch (error) {
      await this.replyRaw(snapshot, String(chat.chatId), error instanceof Error ? error.message : '订阅失败')
    }
  }

  private async commandUnsubscribe(snapshot: PublicSnapshot, chat: OwnerChat, arg: string): Promise<void> {
    if (!arg) {
      await this.replyRaw(snapshot, String(chat.chatId), '用法：/unsubscribe <完整会话 id 或短编号>')
      return
    }
    try {
      await this.unsubscribe(arg)
      await this.replyRaw(snapshot, String(chat.chatId), '已取消订阅。未发送的报告不会再投递，回复与按钮已失效。')
    } catch (error) {
      await this.replyRaw(snapshot, String(chat.chatId), error instanceof Error ? error.message : '取消订阅失败')
    }
  }

  private async commandSubscriptions(snapshot: PublicSnapshot, chat: OwnerChat): Promise<void> {
    const runtime = this.liveRuntime!
    await this.subscriptionLists.open({ botId: runtime.botId, generation: runtime.generation, userId: snapshot.ownerUserId!, chatId: String(chat.chatId) }, 'subscriptions')
  }

  private async commandTo(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    chat: OwnerChat,
    arg: string,
    inputId: string,
  ): Promise<'background' | void> {
    const match = arg.match(/^(\S+)\s+([\s\S]+)$/)
    if (!match) {
      await this.replyRaw(snapshot, String(chat.chatId), '用法：/to <短编号> 文本')
      return
    }
    const state = await this.readState()
    const target = lookupShortId(state, match[1]!)
    if ('error' in target) {
      await this.replyRaw(snapshot, String(chat.chatId), target.error)
      return
    }
    if (chat.replyToMessageId) {
      const mapped = this.lookupReply(state, botId, generation, String(chat.chatId), chat.replyToMessageId)
      if (mapped && mapped.sessionId !== target.sessionId) {
        await this.replyRaw(snapshot, String(chat.chatId), '回复目标与 /to 指定的会话不一致，已拒绝。')
        return
      }
    }
    return this.submitToSession(snapshot, botId, generation, chat, target.sessionId, match[2]!, inputId, 'explicit')
  }

  private lookupReply(
    state: TelegramPublicStoreFile,
    botId: number,
    generation: number,
    chatId: string,
    messageId: number,
  ): TelegramPublicMessageMap | undefined {
    const key = messageMapKey(generation, botId, chatId, messageId)
    return state.messageMaps[key]
  }

  private async handlePlainText(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    chat: OwnerChat,
    text: string,
    inputId: string,
  ): Promise<'background' | void> {
    if (!chat.replyToMessageId) {
      await this.replyRaw(
        snapshot,
        String(chat.chatId),
        '请回复一条会话报告，或使用 /to <短编号> 发送。未指定目标的普通文本不会自动投递。',
      )
      return
    }
    const state = await this.readState()
    const mapped = this.lookupReply(state, botId, generation, String(chat.chatId), chat.replyToMessageId)
    if (!mapped) {
      await this.replyRaw(snapshot, String(chat.chatId), '找不到这条消息对应的会话，记录可能已过期。请重新选择目标。')
      return
    }
    if (mapped.expiresAt && Date.parse(mapped.expiresAt) < this.now()) {
      await this.replyRaw(snapshot, String(chat.chatId), '这条消息的回复映射已过期。请重新选择目标。')
      return
    }
    if (!state.subscriptions[mapped.sessionId]) {
      await this.replyRaw(snapshot, String(chat.chatId), '该会话已取消订阅，无法继续操作。')
      return
    }
    if (mapped.kind === 'question' && mapped.requestId) {
      await this.answerQuestion(snapshot, mapped, text)
      return
    }
    if (mapped.kind === 'permission' || mapped.kind === 'computer_use') {
      await this.replyRaw(snapshot, String(chat.chatId), '普通文本不会被当作批准。请使用按钮，或在桌面处理。')
      return
    }
    return this.submitToSession(snapshot, botId, generation, chat, mapped.sessionId, text, inputId, 'reply')
  }

  private async submitToSession(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    chat: OwnerChat,
    sessionId: string,
    content: string,
    inputId: string,
    via: 'reply' | 'explicit',
  ): Promise<'background' | void> {
    const state = await this.readState()
    if (!state.subscriptions[sessionId]) {
      await this.replyRaw(snapshot, String(chat.chatId), via === 'explicit'
        ? '/to 只能发给当前已订阅的会话。'
        : '该会话已取消订阅，无法继续操作。')
      return
    }
    const summary = await this.sessionSummary(sessionId)
    if (!summary) {
      await this.replyRaw(snapshot, String(chat.chatId), '会话已删除，请重新选择。')
      return
    }
    if (!await this.sessionAllowed(summary, snapshot.allowedProjectRoots)) {
      await this.replyRaw(snapshot, String(chat.chatId), '该会话已不在允许的项目根目录内。')
      return
    }
    if (!await this.runtimeStillMatches(botId, generation, snapshot.ownerUserId)) {
      await this.replyRaw(snapshot, String(chat.chatId), '未接收：Bot 身份或代次已变更。')
      return
    }
    const handler = await this.handler()
    const turnState = handler.getSessionTurnState(sessionId)
    if (turnState !== 'idle') {
      await this.replyRaw(snapshot, String(chat.chatId), `会话 ${state.subscriptions[sessionId]?.shortId ?? sessionId} 正在忙碌，消息未接收，请稍后再试。`)
      return
    }
    const origin: SessionTurnOrigin = {
      entrypoint: 'telegram-public',
      botId,
      generation,
      userId: chat.userId,
      chatId: String(chat.chatId),
      turnId: inputId,
    }
    const shortId = state.subscriptions[sessionId]?.shortId ?? sessionId
    this.enqueueInboundWork(async () => {
      try {
        if (!await this.runtimeStillMatches(botId, generation, snapshot.ownerUserId)) {
          await this.completeInbound(inputId, 'rejected')
          await this.replyRaw(snapshot, String(chat.chatId), '未接收：Bot 身份或代次已变更。')
          return
        }
        await handler.submitHumanSessionTurn(sessionId, content, {
          serverHost: this.serverHost,
          serverPort: this.serverPort,
          inputId,
          origin,
        })
        await this.completeInbound(inputId, 'completed')
        await this.replyRaw(snapshot, String(chat.chatId), `已接收，已提交到 ${shortId}。`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.completeInbound(inputId, 'completed')
        const notice = /active turn|busy|already/i.test(message)
          ? `会话忙碌，消息未接收：${message}`
          : `未接收：${message}`
        await this.replyRaw(snapshot, String(chat.chatId), notice)
      }
    })
    return 'background'
  }

  private enqueueInboundWork(work: () => Promise<void>): void {
    this.inboundTail = this.inboundTail.then(work).catch(error => {
      console.error('[TelegramPublic] inbound submit failed', error instanceof Error ? error.message : error)
    })
  }

  private async answerQuestion(
    snapshot: PublicSnapshot,
    mapped: TelegramPublicMessageMap,
    text: string,
  ): Promise<void> {
    const handler = await this.handler()
    if (!mapped.requestId || !handler.isSessionPermissionPending(mapped.sessionId, mapped.requestId)) {
      await this.replyRaw(snapshot, String(mapped.chatId), '这个问题已经失效，请在桌面查看。')
      return
    }
    const state = await this.readState()
    if (!state.subscriptions[mapped.sessionId]) {
      await this.replyRaw(snapshot, String(mapped.chatId), '该会话已取消订阅，无法继续操作。')
      return
    }
    const operableSession = await this.sessionStillOperable(mapped.sessionId, snapshot)
    if (!operableSession.ok) {
      await this.replyRaw(snapshot, String(mapped.chatId), operableSession.reason)
      return
    }
    if (!await this.runtimeStillMatches(mapped.botId, mapped.generation, snapshot.ownerUserId)) {
      await this.replyRaw(snapshot, String(mapped.chatId), '这个问题已经失效，请在桌面查看。')
      return
    }
    const operable = this.canOperate(mapped, snapshot)
    if (!operable.ok) {
      if (mapped.requestId) {
        await this.claimRequestTokens({ sessionId: mapped.sessionId, requestId: mapped.requestId })
      }
      await this.replyRaw(snapshot, String(mapped.chatId), operable.reason)
      return
    }
    const answers = parseQuestionAnswer(text, mapped.input)
    if (!answers) {
      await this.replyRaw(snapshot, String(mapped.chatId), '无法把这段文本解析为问题答案。请按选项回复，或使用按钮。')
      return
    }
    const claimed = await this.claimRequestTokens({
      sessionId: mapped.sessionId,
      requestId: mapped.requestId,
    })
    if (!claimed) {
      await this.replyRaw(snapshot, String(mapped.chatId), '这个问题已经处理过了。')
      return
    }
    if (!handler.isSessionPermissionPending(mapped.sessionId, mapped.requestId)) {
      await this.replyRaw(snapshot, String(mapped.chatId), '这个问题已经处理过了。')
      return
    }
    const ok = await handler.respondToSessionPermission(mapped.sessionId, {
      requestId: mapped.requestId,
      allowed: true,
      updatedInput: { ...(isRecord(mapped.input) ? mapped.input : {}), answers },
    })
    await this.replyRaw(snapshot, String(mapped.chatId), ok ? '已提交答案。' : '提交答案失败，请求可能已在其他入口处理。')
  }

  private canOperate(
    mapped: { sessionId: string; originEntrypoint?: string; requestId?: string },
    snapshot: PublicSnapshot,
  ): { ok: true } | { ok: false; reason: string } {
    const origin = mapped.originEntrypoint
      ?? this.permissionOrigin(mapped.sessionId, mapped.requestId)?.entrypoint
    if (origin === 'telegram-public') return { ok: true }
    if (!origin) {
      return { ok: false, reason: '该请求来源无法确认，公共入口只读。请在桌面处理。' }
    }
    const binding = snapshot.ownerUserId != null
      ? this.dedicatedBinding(String(snapshot.ownerUserId))
      : null
    if (origin === 'telegram-dedicated' || binding?.sessionId === mapped.sessionId) {
      return { ok: false, reason: '该审批由专属入口处理，公共入口仅可查看。请在专属 Bot 或桌面完成。' }
    }
    return { ok: true }
  }

  private async handleCallback(
    snapshot: PublicSnapshot,
    botId: number,
    generation: number,
    update: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseCallback(update, snapshot.ownerUserId)
    if (!parsed.ok || snapshot.ownerUserId == null) return
    if (parsed.data.startsWith('tgsub:')) {
      await this.subscriptionLists.handle({ botId, generation, userId: parsed.userId, chatId: String(parsed.chatId) }, parsed.data, parsed.messageId)
      return
    }
    if (!parsed.data.startsWith('tgp:')) return
    const token = parsed.data.slice(4)
    let record: TelegramPublicCallbackToken | undefined
    await this.mutate(current => {
      record = current.callbackTokens[token]
    })
    if (!record) {
      await this.replyRaw(snapshot, String(parsed.chatId), '按钮已失效。')
      return
    }
    if (record.botId !== botId || record.generation !== generation || record.ownerUserId !== parsed.userId) {
      await this.replyRaw(snapshot, String(parsed.chatId), '这个按钮不属于当前 Bot 或操作者。')
      return
    }
    const state = await this.readState()
    if (!state.subscriptions[record.sessionId]) {
      await this.replyRaw(snapshot, String(parsed.chatId), '该会话已取消订阅，按钮已失效。')
      return
    }
    const operableSession = await this.sessionStillOperable(record.sessionId, snapshot)
    if (!operableSession.ok) {
      await this.replyRaw(snapshot, String(parsed.chatId), operableSession.reason)
      return
    }
    if (!await this.runtimeStillMatches(botId, generation, snapshot.ownerUserId)) {
      await this.replyRaw(snapshot, String(parsed.chatId), '按钮已失效。')
      return
    }
    const handler = await this.handler()
    if (!handler.isSessionPermissionPending(record.sessionId, record.requestId)) {
      await this.claimRequestTokens({ sessionId: record.sessionId, requestId: record.requestId })
      await this.replyRaw(snapshot, String(parsed.chatId), '该请求已在桌面或其他入口处理。')
      return
    }
    const mapped: { sessionId: string; originEntrypoint?: string; requestId: string } = {
      sessionId: record.sessionId,
      originEntrypoint: asString(record.originEntrypoint)
        ?? this.originFromToken(state, record)
        ?? this.permissionOrigin(record.sessionId, record.requestId)?.entrypoint,
      requestId: record.requestId,
    }
    const operable = this.canOperate(mapped, snapshot)
    if (!operable.ok) {
      await this.claimRequestTokens({ sessionId: record.sessionId, requestId: record.requestId })
      await this.replyRaw(snapshot, String(parsed.chatId), operable.reason)
      return
    }
    if (record.kind === 'question' && record.action !== 'deny') {
      const mapEntry = Object.values(state.messageMaps).find(entry => entry.requestId === record.requestId && entry.sessionId === record.sessionId)
      const questions = parseQuestions(mapEntry?.input)
      const question = questions?.[0]
      const label = question && typeof record.optionIndex === 'number' ? question.options[record.optionIndex]?.label : undefined
      if (!label || !questions || questions.length !== 1) {
        await this.replyRaw(snapshot, String(parsed.chatId), '请回复这条消息提交答案，按钮无法覆盖全部问题。')
        return
      }
    }
    const consumed = await this.claimRequestTokens({
      sessionId: record.sessionId,
      requestId: record.requestId,
      token,
    })
    if (!consumed) {
      await this.replyRaw(snapshot, String(parsed.chatId), '这个按钮已经用过了。')
      return
    }
    if (!handler.isSessionPermissionPending(record.sessionId, record.requestId)) {
      await this.replyRaw(snapshot, String(parsed.chatId), '该请求已在桌面或其他入口处理。')
      return
    }
    if (record.kind === 'computer_use') {
      const allowed = record.action === 'allow'
      const ok = await handler.respondToSessionComputerUsePermission(
        record.sessionId,
        record.requestId,
        computerUseConsent(allowed),
      )
      await this.replyRaw(snapshot, String(parsed.chatId), ok ? (allowed ? '已允许计算机使用。' : '已拒绝计算机使用。') : '处理失败，请求可能已失效。')
      return
    }
    if (record.kind === 'question') {
      const mapEntry = Object.values(state.messageMaps).find(entry => entry.requestId === record!.requestId && entry.sessionId === record!.sessionId)
      if (record.action === 'deny') {
        const ok = await handler.respondToSessionPermission(record.sessionId, { requestId: record.requestId, allowed: false })
        await this.replyRaw(snapshot, String(parsed.chatId), ok ? '已拒绝提问。' : '处理失败，请求可能已失效。')
        return
      }
      const questions = parseQuestions(mapEntry?.input)
      const question = questions?.[0]
      const label = question && typeof record.optionIndex === 'number' ? question.options[record.optionIndex]?.label : undefined
      if (!label || !questions || questions.length !== 1) {
        await this.replyRaw(snapshot, String(parsed.chatId), '请回复这条消息提交答案，按钮无法覆盖全部问题。')
        return
      }
      const answers = parseQuestionAnswer(label, mapEntry?.input)
      if (!answers) {
        await this.replyRaw(snapshot, String(parsed.chatId), '无法提交该选项。')
        return
      }
      const ok = await handler.respondToSessionPermission(record.sessionId, {
        requestId: record.requestId,
        allowed: true,
        updatedInput: { ...(isRecord(mapEntry?.input) ? mapEntry.input : {}), answers },
      })
      await this.replyRaw(snapshot, String(parsed.chatId), ok ? `已选择：${label}` : '处理失败，请求可能已失效。')
      return
    }
    const allowed = record.action === 'allow'
    const ok = await handler.respondToSessionPermission(record.sessionId, { requestId: record.requestId, allowed })
    await this.replyRaw(snapshot, String(parsed.chatId), ok ? (allowed ? '已允许。' : '已拒绝。') : '处理失败，请求可能已失效。')
  }

  private originFromToken(state: TelegramPublicStoreFile, record: TelegramPublicCallbackToken): string | undefined {
    for (const entry of Object.values(state.messageMaps)) {
      if (entry.sessionId === record.sessionId && entry.requestId === record.requestId) return entry.originEntrypoint
    }
    return undefined
  }

  private async claimRequestTokens(match: {
    sessionId: string
    requestId: string
    token?: string
  }): Promise<boolean> {
    let claimed = false
    await this.mutate(current => {
      if (match.token && !current.callbackTokens[match.token]) return
      for (const [token, entry] of Object.entries(current.callbackTokens)) {
        if (entry.sessionId === match.sessionId && entry.requestId === match.requestId) {
          delete current.callbackTokens[token]
          claimed = true
        }
      }
    })
    return claimed
  }

  private async onTurnEvent(event: SessionTurnEvent): Promise<void> {
    const snapshot = await this.snapshot()
    if (!snapshot.present || !snapshot.enabled || snapshot.ownerUserId == null) return
    if (!this.isLive(snapshot)) return
    const state = await this.readState()
    if (!this.runtimeMatchesSnapshot(state.runtime, snapshot)) return
    if (!this.liveRuntime
      || this.liveRuntime.botId !== state.runtime.botId
      || this.liveRuntime.generation !== state.runtime.generation) {
      return
    }
    if (event.type !== 'output') return
    const message = event.message
    if (!isRecord(message)) return

    if (message.type === 'control_response'
      || message.type === 'control_cancel'
      || message.type === 'control_cancel_request') {
      const requestId = requestIdOf(message)
      if (requestId) await this.invalidateRequest(event.sessionId, requestId, snapshot)
      return
    }

    const subscription = state.subscriptions[event.sessionId]
    if (!subscription) {
      const eventId = eventIdOf(event, message)
      if (eventId) await this.eventLog().remove(eventId, state.runtime.generation)
      return
    }

    const requestId = requestIdOf(message)
    const origin = message.type === 'control_request' && requestId
      ? (this.permissionOrigin(event.sessionId, requestId) ?? event.origin)
      : event.origin
    if (origin?.entrypoint === 'telegram-public'
      && (origin.botId !== state.runtime.botId || origin.generation !== state.runtime.generation)) {
      await this.removeJournal(event, message, state.runtime.generation)
      return
    }

    const operable = await this.sessionStillOperable(event.sessionId, snapshot)
    if (!operable.ok) {
      await this.removeJournal(event, message, state.runtime.generation)
      return
    }
    const liveSubscription: TelegramPublicSubscription = {
      ...subscription,
      title: operable.summary.title,
      project: subscriptionProject(operable.summary),
      ...(operable.summary.team ? { team: operable.summary.team } : {}),
      ...(operable.summary.member ? { member: operable.summary.member } : {}),
    }

    if (message.type === 'result') {
      await this.enqueueResult(snapshot, state, liveSubscription, event, message, origin)
      await this.removeJournal(event, message, state.runtime.generation)
      return
    }
    if (message.type === 'control_request' && isRecord(message.request) && message.request.subtype === 'can_use_tool') {
      await this.enqueuePermission(snapshot, state, liveSubscription, event, message, origin)
      await this.removeJournal(event, message, state.runtime.generation)
    }
  }

  private async enqueueResult(
    snapshot: PublicSnapshot,
    state: TelegramPublicStoreFile,
    subscription: TelegramPublicSubscription,
    event: TelegramPublicTurnEvent,
    message: Record<string, unknown>,
    origin: TelegramPublicOrigin | undefined,
  ): Promise<void> {
    const eventId = eventIdOf(event, message)
    if (!eventId) {
      console.warn('[TelegramPublic] result missing uuid/eventId; delivery will not survive a crash exactly-once')
    }
    const stableId = eventId ?? `observed:${event.sessionId}:result:${this.now()}`
    const failed = message.is_error === true
    const body = resultText(message)
    const publicTurn = origin?.entrypoint === 'telegram-public'
      && origin.botId === state.runtime?.botId
      && origin.generation === state.runtime?.generation
    const category = failed ? '失败' : '已完成'
    const project = String(subscription.project ?? '')
    const title = String(subscription.title ?? '')
    const extras = headerExtras(subscription)
    const header = headerPrefix(project, title, subscription.shortId, category, extras)
    const text = `${header}：${publicTurn ? '\n' : ''}${body}`
    await this.enqueueReport({
      snapshot,
      runtime: state.runtime!,
      subscription,
      eventId: stableId,
      text,
      parts: splitResultReport(text, subscription.shortId, category),
      kind: 'report',
      turnId: origin?.turnId ?? event.turnId,
      originEntrypoint: origin?.entrypoint,
    })
  }

  private async enqueuePermission(
    snapshot: PublicSnapshot,
    state: TelegramPublicStoreFile,
    subscription: TelegramPublicSubscription,
    event: TelegramPublicTurnEvent,
    message: Record<string, unknown>,
    origin: TelegramPublicOrigin | undefined,
  ): Promise<void> {
    const requestId = requestIdOf(message)
    if (!requestId) return
    const toolName = toolNameOf(message)
    const isQuestion = toolName === 'AskUserQuestion'
    const isComputerUse = toolName === 'ComputerUse'
    const eventId = eventIdOf(event, message) ?? `observed:${event.sessionId}:permission:${requestId}`
    const resolvedOrigin = this.permissionOrigin(event.sessionId, requestId) ?? origin
    if (resolvedOrigin?.entrypoint === 'telegram-public'
      && (resolvedOrigin.botId !== state.runtime?.botId || resolvedOrigin.generation !== state.runtime?.generation)) {
      return
    }
    const originEntrypoint = resolvedOrigin?.entrypoint
    const mapped = {
      sessionId: event.sessionId,
      originEntrypoint,
      requestId,
    }
    const operable = this.canOperate(mapped, snapshot)
    const request = isRecord(message.request) ? message.request : {}
    const description = typeof request.description === 'string' ? request.description : ''
    const category = isQuestion ? '等待回答' : '等待审批'
    let text = `${headerPrefix(String(subscription.project ?? ''), String(subscription.title ?? ''), subscription.shortId, category, headerExtras(subscription))}：${toolName}`
    if (description) text += `\n${description}`
    if (isQuestion) {
      const questions = parseQuestions(request.input ?? request)
      if (questions) {
        text += `\n${questions.map((question, index) => `${index + 1}. ${question.question}`).join('\n')}`
      }
    }
    if (!operable.ok) text += `\n${operable.reason}`
    const tokens: TelegramPublicCallbackToken[] = []
    let replyMarkup: TelegramInlineMarkup | undefined
    if (operable.ok) {
      if (isComputerUse) {
        const allow = this.newToken(state, snapshot, event.sessionId, requestId, 'computer_use', 'allow', undefined, originEntrypoint)
        const deny = this.newToken(state, snapshot, event.sessionId, requestId, 'computer_use', 'deny', undefined, originEntrypoint)
        tokens.push(allow, deny)
        replyMarkup = { inline_keyboard: [[{ text: '允许', callback_data: `tgp:${allow.token}` }, { text: '拒绝', callback_data: `tgp:${deny.token}` }]] }
      } else if (isQuestion) {
        const questions = parseQuestions(request.input ?? request)
        const first = questions?.[0]
        const deny = this.newToken(state, snapshot, event.sessionId, requestId, 'question', 'deny', undefined, originEntrypoint)
        tokens.push(deny)
        const optionButtons = (first && questions?.length === 1 ? first.options.slice(0, 8) : []).map((option, index) => {
          const token = this.newToken(state, snapshot, event.sessionId, requestId, 'question', 'option', index, originEntrypoint)
          tokens.push(token)
          return { text: option.label.slice(0, 32), callback_data: `tgp:${token.token}` }
        })
        replyMarkup = {
          inline_keyboard: [
            ...optionButtons.map(button => [button]),
            [{ text: '拒绝', callback_data: `tgp:${deny.token}` }],
          ],
        }
      } else {
        const allow = this.newToken(state, snapshot, event.sessionId, requestId, 'permission', 'allow', undefined, originEntrypoint)
        const deny = this.newToken(state, snapshot, event.sessionId, requestId, 'permission', 'deny', undefined, originEntrypoint)
        tokens.push(allow, deny)
        replyMarkup = { inline_keyboard: [[{ text: '允许', callback_data: `tgp:${allow.token}` }, { text: '拒绝', callback_data: `tgp:${deny.token}` }]] }
      }
    }
    await this.enqueueReport({
      snapshot,
      runtime: state.runtime!,
      subscription,
      eventId,
      text,
      kind: isQuestion ? 'question' : isComputerUse ? 'computer_use' : 'permission',
      turnId: resolvedOrigin?.turnId ?? event.turnId,
      requestId,
      originEntrypoint,
      toolName,
      input: request.input ?? request,
      replyMarkup,
      tokens,
    })
  }

  private newToken(
    state: TelegramPublicStoreFile,
    snapshot: PublicSnapshot,
    sessionId: string,
    requestId: string,
    kind: TelegramPublicCallbackToken['kind'],
    action: string,
    optionIndex?: number,
    originEntrypoint?: string,
  ): TelegramPublicCallbackToken {
    void state
    return {
      token: randomBytes(8).toString('hex'),
      sessionId,
      generation: snapshot.generation,
      botId: 0,
      requestId,
      ownerUserId: snapshot.ownerUserId ?? 0,
      kind,
      action,
      createdAt: this.isoNow(),
      ...(optionIndex !== undefined ? { optionIndex } : {}),
      ...(originEntrypoint ? { originEntrypoint } : {}),
    }
  }

  private async enqueueReport(params: {
    snapshot: PublicSnapshot
    runtime: { botId: number; generation: number }
    subscription: TelegramPublicSubscription
    eventId: string
    text: string
    parts?: string[]
    kind: TelegramPublicMessageMap['kind']
    turnId?: string
    requestId?: string
    originEntrypoint?: string
    toolName?: string
    input?: unknown
    replyMarkup?: TelegramInlineMarkup
    tokens?: TelegramPublicCallbackToken[]
  }): Promise<void> {
    const chatId = String(params.snapshot.ownerUserId)
    const parts = params.parts ?? splitMessage(params.text, TELEGRAM_PUBLIC_TEXT_LIMIT)
    const createdAt = this.isoNow()
    const expiresAt = new Date(this.now() + TELEGRAM_PUBLIC_REPLY_TTL_MS).toISOString()
    await this.mutate(current => {
      if (!current.subscriptions[params.subscription.sessionId]) return
      if (!current.runtime || current.runtime.botId !== params.runtime.botId || current.runtime.generation !== params.runtime.generation) return
      if (runtimeOwnerId(current.runtime) !== params.snapshot.ownerUserId) return
      if (params.runtime.generation !== params.snapshot.generation) return
      const alreadyQueued = current.outbox.some(record =>
        record.eventId === params.eventId
        && record.sessionId === params.subscription.sessionId
        && record.generation === params.runtime.generation
        && record.botId === params.runtime.botId,
      )
      if (alreadyQueued) return
      if (params.requestId) {
        const seenRequest = current.outbox.some(record =>
          record.sessionId === params.subscription.sessionId
          && asString(record.requestId) === params.requestId,
        ) || Object.values(current.callbackTokens).some(entry =>
          entry.sessionId === params.subscription.sessionId && entry.requestId === params.requestId,
        ) || Object.values(current.messageMaps).some(entry =>
          entry.sessionId === params.subscription.sessionId && entry.requestId === params.requestId,
        )
        if (seenRequest) return
      }
      for (const token of params.tokens ?? []) {
        current.callbackTokens[token.token] = {
          ...token,
          botId: params.runtime.botId,
          generation: params.runtime.generation,
        }
      }
      for (let part = 0; part < parts.length; part++) {
        const idempotencyKey = outboxIdempotencyKey({
          eventId: params.eventId,
          generation: params.runtime.generation,
          botId: params.runtime.botId,
          chatId,
          sessionId: params.subscription.sessionId,
          part,
        })
        if (current.outbox.some(record => record.idempotencyKey === idempotencyKey)) continue
        const id = randomBytes(8).toString('hex')
        const last = part === parts.length - 1
        current.outbox.push({
          id,
          idempotencyKey,
          status: 'queued',
          generation: params.runtime.generation,
          botId: params.runtime.botId,
          chatId,
          sessionId: params.subscription.sessionId,
          eventId: params.eventId,
          part,
          text: parts[part]!,
          ...(last && params.replyMarkup ? { replyMarkup: params.replyMarkup } : {}),
          attempts: 0,
          createdAt,
          updatedAt: createdAt,
          kind: params.kind,
          shortId: params.subscription.shortId,
          turnId: params.turnId,
          requestId: params.requestId,
          originEntrypoint: params.originEntrypoint,
          toolName: params.toolName,
          input: params.input,
          expiresAt,
        } as TelegramPublicOutboxRecord)
      }
    })
    this.enqueueDrain()
  }

  private enqueueDrain(): void {
    this.drainTail = this.drainTail.then(() => this.drainOutbox()).catch(error => {
      console.error('[TelegramPublic] outbox drain failed', error instanceof Error ? error.message : error)
    })
  }

  private async drainOutbox(): Promise<void> {
    const epoch = this.runtimeEpoch
    let sweptMismatched = false
    while (this.started && epoch === this.runtimeEpoch) {
      const snapshot = await this.snapshot()
      if (!snapshot.present || !snapshot.enabled || !snapshot.botToken || snapshot.ownerUserId == null) return
      if (!this.isLive(snapshot)) return
      const state = await this.readState()
      const runtime = state.runtime
      if (!this.runtimeMatchesSnapshot(runtime, snapshot)) return
      if (!this.liveRuntime || this.liveRuntime.botId !== runtime.botId || this.liveRuntime.generation !== runtime.generation) {
        return
      }
      if (this.liveRuntime.ownerUserId !== snapshot.ownerUserId) return
      if (!sweptMismatched) {
        await this.failIdentityMismatchedQueued(runtime, snapshot)
        sweptMismatched = true
        continue
      }
      const now = this.now()
      const ownerChatId = String(snapshot.ownerUserId)
      const blocked = state.outbox.find(record => record.status === 'queued'
        && record.botId === runtime.botId
        && record.generation === runtime.generation
        && record.chatId === ownerChatId
        && state.outbox.some(previous => previous.eventId === record.eventId
          && previous.sessionId === record.sessionId
          && previous.botId === record.botId
          && previous.generation === record.generation
          && previous.chatId === record.chatId
          && previous.part < record.part
          && ['failed', 'indeterminate'].includes(previous.status)))
      if (blocked) {
        await this.failQueued(blocked.id, '前序分片投递失败或结果不确定，后续分片未发送')
        continue
      }
      const next = state.outbox.find(record => record.status === 'queued'
        && record.botId === runtime.botId
        && record.generation === runtime.generation
        && record.chatId === ownerChatId
        && (!record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= now)
        // A later fragment must not overtake an earlier failed, unknown, or
        // rate-limited fragment. Other events can still drain independently.
        && !state.outbox.some(previous => previous.eventId === record.eventId
          && previous.sessionId === record.sessionId
          && previous.botId === record.botId
          && previous.generation === record.generation
          && previous.chatId === record.chatId
          && previous.part < record.part
          && previous.status !== 'delivered'))
      if (!next) {
        this.scheduleRetryWake(state, runtime, now)
        return
      }
      if (!state.subscriptions[next.sessionId]) {
        await this.failQueued(next.id, '已取消订阅')
        continue
      }
      const operable = await this.sessionStillOperable(next.sessionId, snapshot)
      if (!operable.ok) {
        await this.failQueued(next.id, operable.reason)
        continue
      }
      const claimed = await this.claimSending(next.id, epoch, runtime)
      if (!claimed) continue
      let result: TelegramChannelSendResult
      try {
        const send = await this.sender()
        result = await send(
          snapshot.botToken,
          next.chatId,
          next.text,
          next.replyMarkup && this.isMarkup(next.replyMarkup) ? { replyMarkup: next.replyMarkup } : undefined,
        )
      } catch (error) {
        result = {
          outcome: 'indeterminate',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      await this.settleSend(next, result, runtime)
    }
  }

  private scheduleRetryWake(
    state: TelegramPublicStoreFile,
    runtime: TelegramPublicRuntimeState,
    now: number,
  ): void {
    const future = state.outbox
      .filter(record => record.status === 'queued'
        && record.botId === runtime.botId
        && record.generation === runtime.generation
        && typeof record.nextAttemptAt === 'string')
      .map(record => Date.parse(record.nextAttemptAt!))
      .filter(stamp => Number.isFinite(stamp) && stamp > now)
    if (future.length === 0) return
    const delay = Math.max(0, Math.min(...future) - now)
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.enqueueDrain()
    }, delay)
  }

  private async failIdentityMismatchedQueued(
    runtime: TelegramPublicRuntimeState,
    snapshot: PublicSnapshot,
  ): Promise<void> {
    const ownerChatId = String(snapshot.ownerUserId)
    await this.mutate(current => {
      for (const record of current.outbox) {
        if (record.status !== 'queued') continue
        if (record.botId !== runtime.botId
          || record.generation !== runtime.generation
          || record.chatId !== ownerChatId) {
          record.status = 'failed'
          record.error = 'Bot 身份、代次或操作者已变更，旧待发不会改投新 Bot'
          record.updatedAt = this.isoNow()
        }
      }
    })
  }

  private async failQueued(id: string, reason: string): Promise<void> {
    await this.mutate(current => {
      const record = current.outbox.find(item => item.id === id)
      if (record && record.status === 'queued') {
        record.status = 'failed'
        record.error = reason
        record.updatedAt = this.isoNow()
      }
    })
  }

  private isMarkup(value: unknown): value is TelegramInlineMarkup {
    return isRecord(value) && Array.isArray(value.inline_keyboard)
  }

  private async claimSending(
    id: string,
    epoch: number,
    runtime: { botId: number; generation: number },
  ): Promise<boolean> {
    let claimed = false
    await this.mutate(current => {
      if (epoch !== this.runtimeEpoch) return
      const record = current.outbox.find(item => item.id === id)
      if (!record || record.status !== 'queued') return
      if (record.botId !== runtime.botId || record.generation !== runtime.generation) {
        record.status = 'failed'
        record.error = 'Bot 身份或代次已变更，旧待发不会改投新 Bot'
        record.updatedAt = this.isoNow()
        return
      }
      record.status = 'sending'
      record.attempts += 1
      record.updatedAt = this.isoNow()
      claimed = true
    })
    return claimed
  }

  private async settleSend(
    item: TelegramPublicOutboxRecord,
    result: TelegramChannelSendResult,
    runtime: { botId: number; generation: number },
  ): Promise<void> {
    const validMessageId = typeof result.messageId === 'number'
      && Number.isSafeInteger(result.messageId)
      && result.messageId > 0
    await this.mutate(current => {
      const record = current.outbox.find(entry => entry.id === item.id)
      if (!record) return
      if (record.botId !== runtime.botId || record.generation !== runtime.generation) {
        record.status = 'failed'
        record.error = 'Bot 身份或代次已变更，旧待发不会改投新 Bot'
        record.updatedAt = this.isoNow()
        return
      }
      if (result.outcome === 'delivered' && validMessageId) {
        if (!current.runtime || current.runtime.botId !== record.botId || current.runtime.generation !== record.generation) {
          record.status = 'failed'
          record.error = 'Bot 身份或代次已变更，旧待发不会改投新 Bot'
          record.updatedAt = this.isoNow()
          return
        }
        record.status = 'delivered'
        record.messageId = result.messageId
        record.updatedAt = this.isoNow()
        delete record.error
        const key = messageMapKey(record.generation, record.botId, record.chatId, result.messageId!)
        current.messageMaps[key] = {
          generation: record.generation,
          botId: record.botId,
          chatId: record.chatId,
          messageId: result.messageId!,
          sessionId: record.sessionId,
          shortId: typeof record.shortId === 'string' ? record.shortId : current.subscriptions[record.sessionId]?.shortId ?? '',
          kind: (record.kind as TelegramPublicMessageMap['kind']) || 'report',
          turnId: asString(record.turnId),
          eventId: record.eventId,
          requestId: asString(record.requestId),
          originEntrypoint: asString(record.originEntrypoint),
          toolName: asString(record.toolName),
          input: record.input,
          createdAt: this.isoNow(),
          expiresAt: asString(record.expiresAt),
        }
        return
      }
      if (result.outcome === 'failed' && result.retryAfterMs && record.attempts < TELEGRAM_PUBLIC_MAX_429_ATTEMPTS) {
        record.status = 'queued'
        record.retryAfterMs = result.retryAfterMs
        record.nextAttemptAt = new Date(this.now() + result.retryAfterMs).toISOString()
        record.error = result.error ?? '429'
        record.updatedAt = this.isoNow()
        return
      }
      if (result.outcome === 'failed') {
        record.status = 'failed'
        record.error = result.error ?? '投递失败'
        record.updatedAt = this.isoNow()
        return
      }
      record.status = 'indeterminate'
      record.error = result.error ?? (result.outcome === 'delivered' ? '缺少有效回执' : '结果不确定')
      record.updatedAt = this.isoNow()
    })
  }

  private journalEligibleEvent(event: SessionTurnEvent): void {
    if (event.type !== 'output') return
    const message = event.message
    if (!isRecord(message)) return
    const kind = message.type === 'result'
      ? 'result'
      : message.type === 'control_request' && isRecord(message.request) && message.request.subtype === 'can_use_tool'
        ? 'control_request'
        : null
    if (!kind) return
    const cache = this.eligibility
    if (!cache.present || !cache.enabled || !cache.live || cache.ownerUserId == null || cache.botId == null) return
    if (!cache.subscriptions.has(event.sessionId)) return
    const requestId = kind === 'control_request' ? requestIdOf(message) : undefined
    const origin = kind === 'control_request'
      ? (this.permissionOrigin(event.sessionId, requestId) ?? event.origin)
      : event.origin
    if (origin?.entrypoint === 'telegram-public'
      && (origin.botId !== cache.botId || origin.generation !== cache.generation)) {
      return
    }
    const eventId = eventIdOf(event, message)
      ?? (kind === 'control_request' && requestIdOf(message)
        ? `observed:${event.sessionId}:permission:${requestIdOf(message)}`
        : undefined)
    if (!eventId) return
    try {
      this.eventLog().writeSync({
        schemaVersion: 1,
        eventId,
        botId: cache.botId,
        generation: cache.generation,
        ownerUserId: cache.ownerUserId,
        sessionId: event.sessionId,
        kind,
        observedAt: this.isoNow(),
        message,
        ...(origin ? { origin } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.eventLogError = detail
      console.error('[TelegramPublic] event journal write failed', detail)
    }
  }

  private async recoverEventLog(): Promise<void> {
    let entries
    try {
      entries = this.eventLog().inspectSync()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.eventLogError = detail
      console.error('[TelegramPublic] event journal inspect failed', detail)
      return
    }
    const fatal = entries.filter(entry => entry.error)
    if (fatal.length > 0) {
      this.eventLogError = fatal[0]!.error!.message
      console.error('[TelegramPublic] event journal fail-closed', this.eventLogError)
    }
    for (const entry of entries) {
      if (!entry.record) continue
      try {
        await this.materializeJournalRecord(entry.record)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.eventLogError = this.eventLogError ?? detail
        console.error('[TelegramPublic] event journal replay failed', detail)
      }
    }
  }

  private async materializeJournalRecord(record: TelegramPublicEventLogRecord): Promise<void> {
    const snapshot = await this.snapshot()
    if (!snapshot.present || !snapshot.enabled || snapshot.ownerUserId == null) return
    if (snapshot.ownerUserId !== record.ownerUserId) return
    const state = await this.readState()
    const runtime = state.runtime
    if (!runtime
      || runtime.botId !== record.botId
      || runtime.generation !== record.generation
      || runtimeOwnerId(runtime) !== record.ownerUserId) {
      return
    }
    if (!this.runtimeMatchesSnapshot(runtime, snapshot)) return
    const subscription = state.subscriptions[record.sessionId]
    if (!subscription) {
      await this.eventLog().remove(record.eventId, record.generation)
      return
    }
    const operable = await this.sessionStillOperable(record.sessionId, snapshot)
    if (!operable.ok) {
      await this.eventLog().remove(record.eventId, record.generation)
      return
    }
    const liveSubscription: TelegramPublicSubscription = {
      ...subscription,
      title: operable.summary.title,
      project: subscriptionProject(operable.summary),
      ...(operable.summary.team ? { team: operable.summary.team } : {}),
      ...(operable.summary.member ? { member: operable.summary.member } : {}),
    }
    const event: SessionTurnEvent = {
      type: 'output',
      sessionId: record.sessionId,
      eventId: record.eventId,
      turnId: record.turnId,
      origin: record.origin,
      message: record.message,
    }
    if (record.kind === 'result') {
      await this.enqueueResult(snapshot, state, liveSubscription, event, record.message, record.origin)
    } else {
      await this.enqueuePermission(snapshot, state, liveSubscription, event, record.message, record.origin)
    }
    await this.eventLog().remove(record.eventId, record.generation)
  }

  private async removeJournal(
    event: SessionTurnEvent,
    message: Record<string, unknown>,
    generation: number,
  ): Promise<void> {
    const eventId = eventIdOf(event, message)
      ?? (requestIdOf(message) ? `observed:${event.sessionId}:permission:${requestIdOf(message)}` : undefined)
    if (!eventId) return
    await this.eventLog().remove(eventId, generation)
  }

  private async invalidateRequest(
    sessionId: string,
    requestId: string,
    snapshot: PublicSnapshot,
  ): Promise<void> {
    let revoked = false
    await this.mutate(current => {
      for (const [token, entry] of Object.entries(current.callbackTokens)) {
        if (entry.sessionId === sessionId && entry.requestId === requestId) {
          delete current.callbackTokens[token]
          revoked = true
        }
      }
      for (const [key, entry] of Object.entries(current.messageMaps)) {
        if (entry.sessionId === sessionId && entry.requestId === requestId) {
          current.messageMaps[key] = {
            ...entry,
            kind: 'report',
            requestId: undefined,
          }
          revoked = true
        }
      }
    })
    if (!revoked) return
    try {
      await this.replyRaw(snapshot, String(snapshot.ownerUserId), '该请求已处理，按钮已失效。请在桌面查看。')
    } catch (error) {
      console.error(
        '[TelegramPublic] failed to send read-only notice after invalidating request',
        error instanceof Error ? error.message : error,
      )
    }
  }

  private async replyRaw(snapshot: PublicSnapshot, chatId: string, text: string): Promise<void> {
    if (!snapshot.botToken) return
    const send = await this.sender()
    await send(snapshot.botToken, chatId, text)
  }
}

let singleton: TelegramPublicService | undefined

export function getTelegramPublicService(): TelegramPublicService {
  return singleton ??= new TelegramPublicService()
}

export function setTelegramPublicServiceForTests(service: TelegramPublicService | null): void {
  singleton?.stop()
  singleton = service ?? undefined
}