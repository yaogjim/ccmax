/**
 * NotificationService — 定时任务完成后通过 IM 渠道推送通知
 *
 * 直接调用 Telegram Bot API / 飞书 Open API（HTTP），不依赖 adapter sidecar
 * 或第三方 SDK，确保即使 adapter 进程未运行也能推送。
 *
 * 投递规则（与旧实现的差异，均为「可见失败」而非静默成功）：
 * - 收件人必须由任务通知配置显式给出，绝不默认广播全部 pairedUsers；
 *   allowedUsers 只是访问白名单，不构成通知对象。
 * - 显式收件人必须能且仅能在服务端配对记录（pairedUsers）里唯一命中；
 *   未命中 / 命中多个都记失败。
 * - HTTP 失败与飞书业务码非 0 都记失败，绝不吞掉。
 * - Telegram 用纯文本发送（不带 parse_mode），避免 Markdown 解析错误。
 * - 每个请求都有超时与有界重试；超时/网络不可达落为 indeterminate
 *   （可能已送达）。
 *
 * 投递记录（`NotificationDeliveryStore`）的写入顺序：
 * - 发送网络请求之前先写 `pending`（`enqueuePending`，deliveryId 即幂等键，
 *   同一 run/channel/收件人重复触发只会入队一次）。
 * - 结果只能通过 `settle` 落成 `delivered` / `failed` / `indeterminate`。
 * - 写 `pending` 失败时**不发送**（宁可记为未投递，也不产生无法追踪的发送）。
 * - 进程启动后第一次投递前用 `recoverPending` 把上一进程遗留的 `pending`
 *   结算成 `indeterminate`，绝不自动重发。
 *
 * 凭据脱敏：Bot Token / App Secret / tenant token 在写入日志与投递记录前
 * 统一替换为 `[redacted]`，Telegram 请求路径里的 `/bot<token>` 也会被抹掉。
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionStore } from '../../../adapters/common/session-store.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'
import { adapterService, type AdapterFileConfig, type PairedUser } from './adapterService.js'
import type { CronTask } from './cronService.js'
import type { TaskRun } from './cronScheduler.js'
import {
  NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART,
  NotificationDeliveryStore,
  getNotificationDeliveryStorePath,
  type NotificationChannel,
  type NotificationDeliveryOutcome,
  type PendingDeliveryInput,
} from './notificationDeliveryStore.js'
import { getTelegramPublicStorePath } from './telegramPublicStore.js'

export type { NotificationChannel, NotificationDeliveryOutcome } from './notificationDeliveryStore.js'

// ─── Public types ─────────────────────────────────────────────────────────────

/** 一个显式收件人：平台用户 id，或服务端配对记录里的显示名。 */
export type NotificationRecipientSpec =
  | string
  | number
  | { userId?: string | number; displayName?: string }

/**
 * 本服务消费的通知配置。与 `TaskNotificationConfig` 结构兼容（recipients 可选），
 * `task.notification` 的正式类型扩展由主控负责。
 *
 * Telegram 渠道可选专属 / 公共入口：
 * - 仅当 `telegramEntrypoints` 字段**未设置**（`undefined`）或为规范化的 `null`
 *   时才是合法缺省，等价于 `['dedicated']`，保持旧专属 Bot 与旧投递键不变。
 *   空数组、非数组、未知取值、重复取值都是持久化坏字段，**不是**缺省，必须
 *   可见失败，绝不静默退化为专属入口。
 * - `public` 只用于定时任务完成链路，不做订阅校验：授权来自服务端可信任务
 *   上下文（登记的已结算真实 run + 当前公共 owner + 允许项目根），调用者传入的
 *   run/task 字段不能作为授权。公共收件人始终与当前公共 owner 合成候选比对，
 *   与 `cronService` 的公共校验一致；公共 owner 允许不在专属 pairedUsers 中。
 * - 同时选择两端时，同一显式 recipient 必须同时满足两个入口；两端分别
 *   独立投递，一端失败（含抛异常）不抑制另一端，也不回退到另一入口。
 *
 * desktop / feishu 渠道行为不变。
 */
export type TaskNotificationInput = {
  enabled: boolean
  channels: ('desktop' | NotificationChannel)[]
  recipients?: Partial<Record<NotificationChannel, NotificationRecipientSpec[]>>
  /**
   * Telegram 投递入口。字段缺失或 `null` 才表示缺省专属；空/非数组/未知/重复
   * 均为坏字段。两端同时选中时要求同一个显式 recipient 同时满足两个入口。
   */
  telegramEntrypoints?: TelegramMessageEntrypoint[]
}

export type NotificationDeliveryFailureCode =
  | 'no_recipients_configured'
  | 'credentials_missing'
  | 'adapter_config_unreadable'
  | 'recipient_not_verified'
  | 'recipient_ambiguous'
  | 'invalid_recipient'
  | 'http_error'
  | 'business_error'
  | 'invalid_receipt'
  | 'network_error'
  | 'timeout'
  | 'delivery_record_failed'
  | 'source_session_required'
  | 'dedicated_binding_mismatch'
  | 'public_route_rejected'
  | 'invalid_telegram_entrypoints'
  | 'task_context_unavailable'

export type TelegramMessageEntrypoint = 'dedicated' | 'public'

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export type TelegramChannelMessageResult = {
  outcome: 'delivered' | 'failed' | 'indeterminate'
  messageId?: number
  error?: string
  retryAfterMs?: number
}

/** `sendSessionReport` 的真实回执：只表示已写入公共 outbox，不是平台送达。 */
export type PublicSessionReportEnqueue = { queued: true }

export type NotificationDeliveryIssue = {
  channel?: NotificationChannel
  code: NotificationDeliveryFailureCode
  message: string
}

export type NotificationRecipientDelivery = {
  channel: NotificationChannel
  recipientId: string
  recipientLabel: string
  outcome: NotificationDeliveryOutcome
  attempts: number
  error?: string
  errorCode?: NotificationDeliveryFailureCode
  messageId?: number
  /** 追踪用：该记录走的是哪个 Telegram 入口；旧记录/其他渠道缺省为专属。 */
  telegramEntrypoint?: TelegramMessageEntrypoint
}

export type NotificationDeliveryReport = {
  /** 全部投递成功且投递记录写盘成功时才为 true。 */
  ok: boolean
  delivered: NotificationRecipientDelivery[]
  failed: NotificationRecipientDelivery[]
  indeterminate: NotificationRecipientDelivery[]
  issues: NotificationDeliveryIssue[]
  recordPath: string
}

export type NotificationLogger = {
  error: (message: string, details?: unknown) => void
  warn: (message: string, details?: unknown) => void
}

export type NotificationDeliveryOptions = {
  fetchImpl?: typeof fetch
  store?: NotificationDeliveryStore
  storePath?: string
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  logger?: NotificationLogger
  now?: () => Date
  /**
   * Override the idempotency key for every delivery. The default is derived
   * from run/channel/recipient/ordinal and is stable across retries; tests use
   * this only to force a specific key.
   */
  generateId?: () => string
  /**
   * Dedicated Telegram SessionStore lookup. Production reads the adapter
   * session file; tests inject a fake so they never touch the developer's
   * real bindings.
   */
  getDedicatedBinding?: (chatId: string) => { sessionId: string } | null
  /**
   * Public-channel report. Production delegates to
   * `getTelegramPublicService().sendSessionReport`, which returns `{ queued: true }`
   * after owner / subscription / roots checks. The public service owns outbox
   * routing. Focused tests may inject this seam; at least one integration must
   * use the real service.
   */
  sendPublicSessionReport?: (
    sessionId: string,
    eventId: string,
    text: string,
  ) => Promise<PublicSessionReportEnqueue>
  /**
   * 定时任务公共通知的可信任务上下文（内部注入缝）。生产由
   * `CronScheduler.finalizeTaskRun` 提供闭包：从 `cronService.listTasks()` 过滤
   * 登记的 taskId，并从当前 runLogTarget 对应的 `scheduled_tasks_log.json`
   * （真源，非 SQLite 派生）匹配 id/taskId/已结算 run；workDir 来自调度器已可信
   * 解析的 canonicalWorkDir/workDir。
   *
   * 没有这个回调时，`telegramEntrypoints: ['public']` 一律拒绝——调用者传入的
   * run/task 字段永远不能当作授权。上下文为 `null`（未登记、已删除、run 未结算、
   * workDir 解析不出）同样拒绝。每次网络尝试前都会重新调用并逐项复核。
   */
  getTaskNotificationContext?: (
    run: Pick<TaskRun, 'id' | 'taskId'>,
  ) => Promise<{ task: CronTask; run: TaskRun; workDir: string } | null>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org'
const FEISHU_API = 'https://open.feishu.cn/open-apis'
const TELEGRAM_TEXT_LIMIT = 4_000
const TELEGRAM_OUTPUT_LIMIT = 3_000
const TELEGRAM_ERROR_LIMIT = 500
const FEISHU_OUTPUT_LIMIT = 3_000
const FEISHU_ERROR_LIMIT = 500
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 500

const DEFAULT_LOGGER: NotificationLogger = {
  error: (message, details) => console.error(message, details ?? ''),
  warn: (message, details) => console.warn(message, details ?? ''),
}

const REDACTED = '[redacted]'

/**
 * Replace known credentials with a placeholder. Two layers, because a token can
 * reach a log or a delivery record by two routes:
 *
 * - Explicit secrets: the caller registers each Bot Token / App Secret / tenant
 *   token as it is read, so an error string that embeds the value is scrubbed.
 * - Telegram's URL shape: the Bot Token is part of the request path
 *   (`/bot<token>/sendMessage`), so a fetch error or a persisted `error` field
 *   can leak it without ever naming it as a value.
 */
function redactText(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    output = output.split(secret).join(REDACTED)
  }
  return output.replace(/\/bot[^/\s]+/g, `/bot${REDACTED}`)
}

// ─── Message formatting ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function statusEmoji(status: TaskRun['status']): string {
  switch (status) {
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'timeout': return '⏰'
    default: return 'ℹ️'
  }
}

function statusText(status: TaskRun['status']): string {
  switch (status) {
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'timeout': return 'Timeout'
    default: return status
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/**
 * Telegram is sent without `parse_mode`, so the body must be plain text: an
 * unescaped `*`, `_`, `[` or backtick in a task name or model output would
 * otherwise make Telegram reject the whole message.
 */
export function buildTelegramPlainText(run: TaskRun): string {
  const lines: string[] = []
  lines.push(`${statusEmoji(run.status)} ${run.taskName}`)
  lines.push('')
  lines.push(`Status: ${statusText(run.status)}`)
  if (run.durationMs != null) {
    lines.push(`Duration: ${formatDuration(run.durationMs)}`)
  }
  if (run.status === 'failed' && run.error) {
    lines.push('')
    lines.push('Error:')
    lines.push(truncate(run.error, TELEGRAM_ERROR_LIMIT))
  }
  if (run.output) {
    lines.push('')
    lines.push('Result:')
    lines.push(truncate(run.output, TELEGRAM_OUTPUT_LIMIT))
  }
  return lines.join('\n')
}

export function buildFeishuCard(run: TaskRun): Record<string, unknown> {
  const metaLine = [
    `**Status**: ${statusText(run.status)}`,
    run.durationMs != null ? `**Duration**: ${formatDuration(run.durationMs)}` : '',
  ].filter(Boolean).join('　　')

  const bodyParts: string[] = []
  if (run.status === 'failed' && run.error) {
    bodyParts.push(`**Error**:\n${truncate(run.error, FEISHU_ERROR_LIMIT)}`)
  }
  if (run.output) {
    bodyParts.push(truncate(run.output, FEISHU_OUTPUT_LIMIT))
  }

  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: metaLine, text_align: 'left' },
  ]
  if (bodyParts.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: bodyParts.join('\n\n'), text_align: 'left' })
  }

  return {
    schema: '2.0',
    header: {
      template: run.status === 'completed' ? 'green' : 'red',
      title: { tag: 'plain_text', content: `${statusEmoji(run.status)} ${run.taskName}` },
    },
    body: { elements },
  }
}

// ─── Dependency resolution ────────────────────────────────────────────────────

type ResolvedDeps = {
  fetch: typeof fetch
  store: NotificationDeliveryStore
  timeoutMs: number
  maxAttempts: number
  retryDelayMs: number
  sleep: (ms: number) => Promise<void>
  logger: NotificationLogger
  now: () => Date
  /** Mint (or derive) the idempotency key for one logical delivery. */
  deliveryId: (parts: DeliveryIdParts) => string
  /** Register a credential so every later redact() call strips it. */
  registerSecret: (secret: string | undefined) => void
  /** Strip every registered credential and Telegram `/bot<token>` paths. */
  redact: (text: string) => string
  getDedicatedBinding: (chatId: string) => { sessionId: string } | null
  sendPublicSessionReport: (
    sessionId: string,
    eventId: string,
    text: string,
  ) => Promise<PublicSessionReportEnqueue>
  getTaskNotificationContext: (
    run: Pick<TaskRun, 'id' | 'taskId'>,
  ) => Promise<{ task: CronTask; run: TaskRun; workDir: string } | null>
}

type DeliveryIdParts = {
  runId: string
  channel: NotificationChannel
  recipientId: string
  ordinal: number
  /** 公共入口用独立幂等键；缺省（专属/飞书/旧调用）保持旧键不变。 */
  telegramEntrypoint?: TelegramMessageEntrypoint
}

function defaultDeliveryId(parts: DeliveryIdParts): string {
  // Stable across retries of the same run so a redelivery cannot duplicate the
  // log; a new run id or recipient produces a new key.
  const base = `${parts.runId}::${parts.channel}::${parts.recipientId}::${parts.ordinal}`
  // The public entrypoint must not share an idempotency key with the dedicated
  // one: the same run to the same chat delivered through both entrypoints are
  // two independent deliveries and must both be journalled.
  return parts.telegramEntrypoint === 'public' ? `${base}::public` : base
}

function resolveDeps(options: NotificationDeliveryOptions): ResolvedDeps {
  const store = options.store
    ?? new NotificationDeliveryStore(options.storePath ?? getNotificationDeliveryStorePath())
  const secrets: string[] = []
  const explicitId = options.generateId
  return {
    fetch: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)) as typeof fetch,
    store,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    logger: options.logger ?? DEFAULT_LOGGER,
    now: options.now ?? (() => new Date()),
    deliveryId: explicitId ? () => explicitId() : defaultDeliveryId,
    registerSecret: (secret) => {
      if (typeof secret === 'string' && secret.length >= 4 && !secrets.includes(secret)) {
        secrets.push(secret)
      }
    },
    redact: (text) => redactText(text, secrets),
    getDedicatedBinding: options.getDedicatedBinding ?? defaultGetDedicatedBinding,
    sendPublicSessionReport: options.sendPublicSessionReport ?? sendPublicSessionReport,
    getTaskNotificationContext: options.getTaskNotificationContext ?? (async () => null),
  }
}

const DEDICATED_SOURCE_REQUIRED =
  '专属 Telegram 通知缺少来源会话；公共入口已启用，请改用公共入口并订阅该会话，或把任务绑定到当前专属会话'
const DEDICATED_BINDING_MISMATCH =
  '来源会话不是该收件人当前专属绑定；公共入口已启用，请改用公共入口并订阅，不能经专属通知绕过隔离'
const PUBLIC_SOURCE_REQUIRED =
  '公共入口发送需要来源会话（sourceSessionId）；模型自报来源不能作为授权'
const PUBLIC_ENTRYPOINT_TELEGRAM_ONLY = 'entrypoint public 仅支持 telegram，不能用于其他渠道'
const PUBLIC_REPORT_UNAVAILABLE = '公共入口不可用：缺少 sendSessionReport，无法验证启用、owner 与订阅路由'

export function defaultGetDedicatedBinding(chatId: string): { sessionId: string } | null {
  try {
    const entry = new SessionStore().get(chatId)
    if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId.trim().length === 0) {
      return null
    }
    return { sessionId: entry.sessionId }
  } catch {
    return null
  }
}

/**
 * Production seam for public reports. Outbox, subscription, owner and roots
 * checks stay in `sendSessionReport`; this module must not send with the
 * public token and must not coerce `{ queued: true }` into a delivered receipt.
 */
export async function sendPublicSessionReport(
  sessionId: string,
  eventId: string,
  text: string,
): Promise<PublicSessionReportEnqueue> {
  if (publicSessionReportForTests) {
    return publicSessionReportForTests(sessionId, eventId, text)
  }
  const { getTelegramPublicService } = await import('./telegramPublicService.js')
  const service = getTelegramPublicService()
  if (typeof service.sendSessionReport !== 'function') {
    throw new Error(PUBLIC_REPORT_UNAVAILABLE)
  }
  return service.sendSessionReport(sessionId, eventId, text)
}

let publicSessionReportForTests:
  | ((sessionId: string, eventId: string, text: string) => Promise<PublicSessionReportEnqueue>)
  | undefined

/** Test seam: intercept public reports without constructing TelegramPublicService. */
export function setSendPublicSessionReportForTests(
  send: ((sessionId: string, eventId: string, text: string) => Promise<PublicSessionReportEnqueue>) | null,
): void {
  publicSessionReportForTests = send ?? undefined
}

function isTelegramPublicEnabled(config: AdapterFileConfig): boolean {
  return config.telegram?.public?.enabled === true
}

function dedicatedTelegramGate(
  config: AdapterFileConfig,
  sourceSessionId: string | undefined,
  recipient: ResolvedRecipient,
  getBinding: (chatId: string) => { sessionId: string } | null,
): { errorCode: NotificationDeliveryFailureCode; error: string } | null {
  if (!isTelegramPublicEnabled(config)) return null
  const source = sourceSessionId?.trim()
  if (!source) {
    return { errorCode: 'source_session_required', error: DEDICATED_SOURCE_REQUIRED }
  }
  const binding = getBinding(String(recipient.chatId))
  if (!binding || binding.sessionId !== source) {
    return { errorCode: 'dedicated_binding_mismatch', error: DEDICATED_BINDING_MISMATCH }
  }
  return null
}

function validTelegramMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function telegramRetryAfterMs(payload: Record<string, unknown> | null): number | undefined {
  const parameters = payload?.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined
  const raw = (parameters as Record<string, unknown>).retry_after
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * The store is shared by every caller in this process. A restart leaves
 * `pending` rows behind (the previous process never observed the platform's
 * answer), so the first delivery after startup reconciles them to
 * `indeterminate` exactly once per store file. Running the pass on every send
 * would race an in-flight send from another task and mislabel a delivery that
 * is still on the wire.
 *
 * Recovery never calls `deliverTelegram`. Leftover dedicated rows cannot bypass
 * `dedicatedTelegramGate` by being retried; the gate only runs on live send
 * paths (`deliverTelegramChannel` / `sendImmediateMessage`).
 */
const recoveredStorePaths = new Set<string>()

/**
 * In-flight startup reconciliation, shared by every caller in this process.
 * `recoverPendingOnce` awaits it so a send that arrives while the startup pass
 * is still running cannot open a new pending row that the pass would then
 * mislabel as indeterminate.
 */
let startupRecovery: Promise<void> | undefined

async function recoverPendingOnce(
  deps: ResolvedDeps,
  options: { skipStartupWait?: boolean } = {},
): Promise<void> {
  // A startup pass (which itself may be waiting for the storage migration to
  // settle) must finish first: otherwise a send could open a new pending row
  // that the pass would then mislabel, or race the un-locked migration rewrite.
  if (!options.skipStartupWait && startupRecovery) await startupRecovery
  const path = deps.store.filePath
  if (recoveredStorePaths.has(path)) return
  recoveredStorePaths.add(path)
  try {
    const recovered = await deps.store.recoverPending()
    for (const record of recovered) {
      deps.logger.warn(
        `[Notification] 上一进程遗留的投递结算为不确定 (${record.channel}/${record.recipientId})`,
        deps.redact(record.error ?? NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART),
      )
    }
  } catch (error) {
    // Recovery is best-effort: a read-only or unreadable store must not block
    // a fresh delivery, and the leftover row stays pending for the next start.
    recoveredStorePaths.delete(path)
    deps.logger.warn('[Notification] 遗留投递恢复失败', deps.redact(describeError(error)))
  }
}

/** Test seam: forget which store files were already reconciled in this process. */
export function resetNotificationRecoveryStateForTests(): void {
  recoveredStorePaths.clear()
  startupRecovery = undefined
  publicSessionReportForTests = undefined
}

/**
 * Kick off the one-time reconciliation of `pending` deliveries left by a
 * previous process, at service startup and before the scheduler or request
 * handlers can open a new pending row.
 *
 * The lazy call-site recovery only fires when something is about to send, so a
 * restart with no further send left a stale `pending` row in the delivery log
 * (and a permanent "sending" entry in the desktop panel). Starting the pass
 * here settles those rows without a first send to race; `recoverPendingOnce`
 * awaits this promise, so no send can open a row while the pass is still
 * running. Kept synchronous (it returns the in-flight promise) so the server
 * boot path stays synchronous.
 *
 * `after` is an optional barrier the pass must wait for. The server passes the
 * persistent-storage migration: it rewrites `notification-deliveries.json`
 * without the delivery store's lock, so a pass that ran first could be
 * clobbered back to `pending` by a migration snapshot read before it. Failures
 * are logged by `recoverPendingOnce` and never rejected: an unreadable delivery
 * log must not block startup.
 */
export function startPendingDeliveryRecovery(
  delivery: NotificationDeliveryOptions = {},
  options: { after?: Promise<unknown> } = {},
): Promise<void> {
  if (!startupRecovery) {
    const barrier = options.after ? options.after.catch(() => undefined) : Promise.resolve()
    startupRecovery = barrier.then(() =>
      recoverPendingOnce(resolveDeps(delivery), { skipStartupWait: true }),
    )
  }
  return startupRecovery
}


function isImChannel(channel: 'desktop' | NotificationChannel): channel is NotificationChannel {
  return channel === 'telegram' || channel === 'feishu'
}

// ─── Recipient resolution ─────────────────────────────────────────────────────

type ResolvedRecipient = {
  /** 保留配对记录里的原始类型：Telegram chat_id 需要数字。 */
  chatId: string | number
  recipientId: string
  displayName: string
}

type RecipientResolution =
  | { kind: 'resolved'; recipient: ResolvedRecipient }
  | { kind: 'invalid'; label: string }
  | { kind: 'not_verified'; label: string }
  | { kind: 'ambiguous'; label: string }

type RecipientResolutionResult = {
  resolved: ResolvedRecipient[]
  failures: NotificationRecipientDelivery[]
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function labelFor(spec: NotificationRecipientSpec): string {
  if (typeof spec === 'string' || typeof spec === 'number') return String(spec)
  if (typeof spec?.userId === 'string' || typeof spec?.userId === 'number') return String(spec.userId)
  if (typeof spec?.displayName === 'string') return spec.displayName
  return '<empty>'
}

/**
 * A recipient reference is trusted only when it resolves to exactly one record
 * in the server-side pairing list (`pairedUsers`). `allowedUsers` is an access
 * allowlist and intentionally never consulted here.
 */
export function resolveNotificationRecipient(
  spec: NotificationRecipientSpec,
  pairedUsers: PairedUser[],
): RecipientResolution {
  const label = labelFor(spec)

  if (typeof spec === 'string' || typeof spec === 'number') {
    const normalizedId = String(spec)
    if (normalizedId.trim().length === 0) return { kind: 'invalid', label }
    return matchBy((user) => String(user.userId) === normalizedId, pairedUsers, label)
  }

  if (typeof spec?.userId === 'string' || typeof spec?.userId === 'number') {
    const normalizedId = String(spec.userId)
    if (normalizedId.trim().length === 0) return { kind: 'invalid', label }
    return matchBy((user) => String(user.userId) === normalizedId, pairedUsers, label)
  }

  if (typeof spec?.displayName === 'string' && normalizeName(spec.displayName).length > 0) {
    const wanted = normalizeName(spec.displayName)
    return matchBy((user) => normalizeName(user.displayName) === wanted, pairedUsers, label)
  }

  return { kind: 'invalid', label }
}

function matchBy(
  predicate: (user: PairedUser) => boolean,
  pairedUsers: PairedUser[],
  label: string,
): RecipientResolution {
  const matches = pairedUsers.filter(predicate)
  if (matches.length === 0) return { kind: 'not_verified', label }
  if (matches.length > 1) return { kind: 'ambiguous', label }
  const match = matches[0]!
  return {
    kind: 'resolved',
    recipient: {
      chatId: match.userId,
      recipientId: String(match.userId),
      displayName: match.displayName,
    },
  }
}

// ─── HTTP with timeout + bounded retry ────────────────────────────────────────

type RetryResult =
  | { kind: 'response'; response: Response; attempts: number }
  | { kind: 'aborted'; error: string; attempts: number }
  | { kind: 'network'; error: string; attempts: number }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function fetchWithBoundedRetry(
  url: string,
  init: RequestInit,
  deps: ResolvedDeps,
): Promise<RetryResult> {
  let attempts = 0
  let lastNetworkError = ''

  while (attempts < deps.maxAttempts) {
    attempts += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
    try {
      // The server does not inherit the adapter's proxy environment. Resolve
      // the request-local route for this URL so the desktop system bridge and
      // NO_PROXY apply without changing process-wide fetch behavior.
      const proxyOptions = getNetworkProxyFetchOptions(await loadNetworkSettings(), url)
      const response = await deps.fetch(url, { ...init, ...proxyOptions, signal: controller.signal })
      clearTimeout(timer)
      if (isRetryableStatus(response.status) && attempts < deps.maxAttempts) {
        await deps.sleep(deps.retryDelayMs * attempts)
        continue
      }
      return { kind: 'response', response, attempts }
    } catch (error) {
      clearTimeout(timer)
      if (isAbortError(error) || controller.signal.aborted) {
        // The platform may still have received the request: never claim a clean failure.
        return { kind: 'aborted', error: describeError(error), attempts }
      }
      lastNetworkError = describeError(error)
      if (attempts < deps.maxAttempts) {
        await deps.sleep(deps.retryDelayMs * attempts)
        continue
      }
    }
  }

  return { kind: 'network', error: lastNetworkError || 'request failed', attempts }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return truncate(await response.text(), 300)
  } catch {
    return ''
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json() as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

// ─── Delivery entries ─────────────────────────────────────────────────────────

function deliveryEntry(
  channel: NotificationChannel,
  recipient: ResolvedRecipient,
  outcome: NotificationDeliveryOutcome,
  attempts: number,
  errorCode?: NotificationDeliveryFailureCode,
  error?: string,
  extra?: { telegramEntrypoint?: TelegramMessageEntrypoint; messageId?: number },
): NotificationRecipientDelivery {
  return {
    channel,
    recipientId: recipient.recipientId,
    recipientLabel: recipient.displayName,
    outcome,
    attempts,
    ...(errorCode ? { errorCode } : {}),
    ...(error ? { error } : {}),
    ...(extra?.messageId !== undefined ? { messageId: extra.messageId } : {}),
    ...(extra?.telegramEntrypoint ? { telegramEntrypoint: extra.telegramEntrypoint } : {}),
  }
}

/**
 * Run one delivery attempt, converting any unexpected throw into a visible
 * `failed` entry. The pending row is written before this runs, so a throw must
 * settle to a terminal outcome — never leave the journal at `pending` and never
 * suppress a sibling entrypoint's delivery.
 */
async function attemptSettled(
  channel: NotificationChannel,
  recipient: ResolvedRecipient,
  deps: ResolvedDeps,
  attempt: () => Promise<NotificationRecipientDelivery>,
  options?: { telegramEntrypoint?: TelegramMessageEntrypoint },
): Promise<NotificationRecipientDelivery> {
  try {
    return await attempt()
  } catch (error) {
    return deliveryEntry(
      channel,
      recipient,
      'failed',
      0,
      'http_error',
      deps.redact(`${channel} 投递未预期失败：${describeError(error)}`),
      options?.telegramEntrypoint ? { telegramEntrypoint: options.telegramEntrypoint } : undefined,
    )
  }
}

/**
 * Persist one delivery around its network attempt.
 *
 * The `pending` row is written *before* `attempt()` runs, so a process that
 * dies mid-send leaves a visible unresolved row instead of a silent gap. When
 * that pre-write fails we do not send at all: a delivery the store cannot
 * describe is worse than a visible `delivery_record_failed`. Every entry is
 * then settled to its observed terminal outcome.
 */
async function deliverWithRecord(
  run: TaskRun,
  channel: NotificationChannel,
  recipient: ResolvedRecipient,
  ordinal: number,
  deps: ResolvedDeps,
  report: NotificationDeliveryReport,
  attempt: () => Promise<NotificationRecipientDelivery>,
  options?: { telegramEntrypoint?: TelegramMessageEntrypoint },
): Promise<void> {
  const deliveryId = deps.deliveryId({
    runId: run.id,
    channel,
    recipientId: recipient.recipientId,
    ordinal,
    ...(options?.telegramEntrypoint ? { telegramEntrypoint: options.telegramEntrypoint } : {}),
  })
  const pending: PendingDeliveryInput = {
    deliveryId,
    runId: run.id,
    taskId: run.taskId,
    channel,
    recipientId: recipient.recipientId,
    recipientDisplayName: recipient.displayName,
    createdAt: deps.now().toISOString(),
    ...(options?.telegramEntrypoint ? { telegramEntrypoint: options.telegramEntrypoint } : {}),
  }

  try {
    const { enqueued } = await deps.store.enqueuePending([pending])
    if (!enqueued.includes(deliveryId)) {
      const message = '投递记录已存在，拒绝重复发送'
      report.issues.push({ channel, code: 'delivery_record_failed', message })
      pushEntry(report, deliveryEntry(channel, recipient, 'failed', 0, 'delivery_record_failed', message))
      return
    }
  } catch (error) {
    report.issues.push({
      channel,
      code: 'delivery_record_failed',
      message: deps.redact(`投递记录写入失败，已放弃发送：${describeError(error)}`),
    })
    pushEntry(
      report,
      deliveryEntry(channel, recipient, 'failed', 0, 'delivery_record_failed', '投递记录无法写入，未发送'),
    )
    return
  }

  const entry = await attemptSettled(channel, recipient, deps, attempt, options)

  try {
    const settled = await deps.store.settle(deliveryId, {
      outcome: entry.outcome === 'delivered' ? 'delivered' : entry.outcome === 'indeterminate' ? 'indeterminate' : 'failed',
      attempts: entry.attempts,
      ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
      ...(entry.error !== undefined ? { error: deps.redact(entry.error) } : {}),
      ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
    })
    if (!settled) {
      report.issues.push({
        channel,
        code: 'delivery_record_failed',
        message: `投递记录 ${deliveryId} 未能结算，可能是并发清理导致`,
      })
    }
  } catch (error) {
    report.issues.push({
      channel,
      code: 'delivery_record_failed',
      message: deps.redact(`投递记录结算失败：${describeError(error)}`),
    })
  }

  pushEntry(report, entry)
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function trimTelegramText(text: string): string {
  return text.length > TELEGRAM_TEXT_LIMIT ? text.slice(0, TELEGRAM_TEXT_LIMIT) + '…' : text
}

type TelegramSendExecution = TelegramChannelMessageResult & {
  attempts: number
  errorCode?: NotificationDeliveryFailureCode
  /** Present when the platform answered with an HTTP status (used for retry policy). */
  status?: number
}

/**
 * Telegram answers `editMessageText` with HTTP 400 / `ok:false` and a
 * "message is not modified" description when the new text equals the current
 * text. The requested state already holds, so it must not be classified as a
 * failed edit.
 */
function isNotModifiedResponse(
  response: Response,
  payload: Record<string, unknown> | null,
): boolean {
  if (response.status !== 400 && payload?.error_code !== 400) return false
  const description = typeof payload?.description === 'string' ? payload.description : ''
  return /message is not modified/i.test(description)
}

async function executeTelegramSendMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  deps: ResolvedDeps,
  options?: {
    replyMarkup?: TelegramInlineKeyboardMarkup
    method?: 'sendMessage' | 'editMessageText'
    messageId?: number
  },
): Promise<TelegramSendExecution> {
  const method = options?.method ?? 'sendMessage'
  const body: Record<string, unknown> = { chat_id: chatId, text }
  if (method === 'editMessageText' && options?.messageId !== undefined) {
    body.message_id = options.messageId
  }
  if (options?.replyMarkup) body.reply_markup = options.replyMarkup

  const result = await fetchWithBoundedRetry(
    `${TELEGRAM_API}/bot${botToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No parse_mode: plain text survives any markdown-breaking character.
      body: JSON.stringify(body),
    },
    deps,
  )

  if (result.kind === 'aborted') {
    return {
      outcome: 'indeterminate',
      attempts: result.attempts,
      errorCode: 'timeout',
      error: deps.redact(`${method} timed out after ${deps.timeoutMs}ms: ${result.error}`),
    }
  }
  if (result.kind === 'network') {
    return {
      outcome: 'indeterminate',
      attempts: result.attempts,
      errorCode: 'network_error',
      error: deps.redact(result.error),
    }
  }

  const { response, attempts } = result
  const payload = await readJson(response)
  const retryAfterMs = telegramRetryAfterMs(payload)
  const retryFields = retryAfterMs !== undefined ? { retryAfterMs } : {}

  // Telegram reports "message is not modified" as HTTP 400 / ok:false when an
  // edit resends identical text. The requested state already holds, so this is
  // a delivered edit of the message being edited, never a failure.
  if (method === 'editMessageText' && options?.messageId !== undefined && isNotModifiedResponse(response, payload)) {
    return { outcome: 'delivered', attempts, messageId: options.messageId }
  }

  if (response.status === 429 || payload?.error_code === 429) {
    return {
      outcome: 'failed',
      attempts,
      errorCode: 'http_error',
      status: response.status,
      error: deps.redact(
        `${method} returned HTTP ${response.status}: ${String(payload?.description ?? 'Too Many Requests')}`,
      ),
      ...retryFields,
    }
  }

  if (!response.ok) {
    return {
      outcome: 'failed',
      attempts,
      errorCode: 'http_error',
      status: response.status,
      error: deps.redact(
        `${method} returned HTTP ${response.status}: ${String(payload?.description ?? payload?.ok ?? response.status)}`,
      ),
    }
  }

  if (payload && payload.ok === false) {
    return {
      outcome: 'failed',
      attempts,
      errorCode: 'business_error',
      status: response.status,
      error: deps.redact(String(payload.description ?? 'Telegram reported ok:false')),
      ...retryFields,
    }
  }

  const receipt = payload?.result
  const messageId = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>).message_id
    : undefined
  if (payload?.ok !== true || !validTelegramMessageId(messageId)) {
    return {
      outcome: 'indeterminate',
      attempts,
      errorCode: 'invalid_receipt',
      error: 'Telegram 未返回可验证的消息回执，禁止据此认定送达',
    }
  }

  return { outcome: 'delivered', attempts, messageId }
}

/**
 * One Telegram sendMessage attempt for the public channel (and any other
 * caller that already owns outbox). Does not write the task-notification
 * delivery store, does not retry timeout/network/429, and does not silently
 * truncate the body — the public service shards, so this primitive refuses
 * anything over 4000 characters. `delivered` requires a positive integer
 * `message_id`.
 */
export async function sendTelegramChannelMessage(
  botToken: string,
  chatId: string,
  text: string,
  options?: {
    fetch?: typeof fetch
    replyMarkup?: TelegramInlineKeyboardMarkup
  },
): Promise<TelegramChannelMessageResult> {
  const deps = resolveDeps({
    fetchImpl: options?.fetch,
    maxAttempts: 1,
  })
  deps.registerSecret(botToken)

  if (typeof text !== 'string' || text.length === 0) {
    return { outcome: 'failed', error: '消息内容为空，未发送' }
  }
  if (text.length > TELEGRAM_TEXT_LIMIT) {
    return {
      outcome: 'failed',
      error: `Telegram 消息超过 ${TELEGRAM_TEXT_LIMIT} 字符，拒绝截断发送`,
    }
  }

  const sent = await executeTelegramSendMessage(
    botToken,
    chatId,
    text,
    deps,
    options?.replyMarkup ? { replyMarkup: options.replyMarkup } : undefined,
  )
  return {
    outcome: sent.outcome,
    ...(sent.messageId !== undefined ? { messageId: sent.messageId } : {}),
    ...(sent.error !== undefined ? { error: sent.error } : {}),
    ...(sent.retryAfterMs !== undefined ? { retryAfterMs: sent.retryAfterMs } : {}),
  }
}

/**
 * One `editMessageText` attempt for a Telegram chat message. Shares
 * `executeTelegramSendMessage` so timeout / 429 / redaction / positive-receipt
 * semantics stay identical to a send. Plain text only (no `parse_mode`), and
 * anything over 4000 characters is refused rather than truncated. Telegram's
 * "message is not modified" 400 is treated as `delivered` for the edited
 * `message_id`, because the requested state already holds.
 */
export async function editTelegramChannelMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  options?: {
    fetch?: typeof fetch
    replyMarkup?: TelegramInlineKeyboardMarkup
  },
): Promise<TelegramChannelMessageResult> {
  const deps = resolveDeps({
    fetchImpl: options?.fetch,
    maxAttempts: 1,
  })
  deps.registerSecret(botToken)

  if (!validTelegramMessageId(messageId)) {
    return { outcome: 'failed', error: 'Telegram message_id 无效，未编辑' }
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { outcome: 'failed', error: '消息内容为空，未编辑' }
  }
  if (text.length > TELEGRAM_TEXT_LIMIT) {
    return {
      outcome: 'failed',
      error: `Telegram 消息超过 ${TELEGRAM_TEXT_LIMIT} 字符，拒绝截断发送`,
    }
  }

  const edited = await executeTelegramSendMessage(botToken, chatId, text, deps, {
    method: 'editMessageText',
    messageId,
    ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
  })
  return {
    outcome: edited.outcome,
    ...(edited.messageId !== undefined ? { messageId: edited.messageId } : {}),
    ...(edited.error !== undefined ? { error: edited.error } : {}),
    ...(edited.retryAfterMs !== undefined ? { retryAfterMs: edited.retryAfterMs } : {}),
  }
}

async function deliverTelegram(
  botToken: string,
  recipient: ResolvedRecipient,
  text: string,
  deps: ResolvedDeps,
): Promise<NotificationRecipientDelivery> {
  // HTTP send only. Dedicated isolation (`dedicatedTelegramGate`) is the
  // caller's job; startup recovery must not reach this function.
  const sent = await executeTelegramSendMessage(
    botToken,
    recipient.chatId,
    trimTelegramText(text),
    deps,
  )
  if (sent.outcome === 'delivered') {
    return { ...deliveryEntry('telegram', recipient, 'delivered', sent.attempts), messageId: sent.messageId }
  }
  return deliveryEntry(
    'telegram',
    recipient,
    sent.outcome,
    sent.attempts,
    sent.errorCode,
    sent.error,
  )
}

// ─── Feishu ───────────────────────────────────────────────────────────────────

async function getFeishuTenantToken(
  appId: string,
  appSecret: string,
  deps: ResolvedDeps,
): Promise<{ token?: string; issue?: NotificationDeliveryIssue }> {
  const result = await fetchWithBoundedRetry(
    `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    deps,
  )

  if (result.kind === 'aborted') {
    return { issue: { channel: 'feishu', code: 'timeout', message: deps.redact(`tenant_access_token timed out after ${deps.timeoutMs}ms: ${result.error}`) } }
  }
  if (result.kind === 'network') {
    return { issue: { channel: 'feishu', code: 'network_error', message: deps.redact(`tenant_access_token unreachable: ${result.error}`) } }
  }
  if (!result.response.ok) {
    return { issue: { channel: 'feishu', code: 'http_error', message: deps.redact(`tenant_access_token returned HTTP ${result.response.status}: ${await readResponseText(result.response)}`) } }
  }

  const payload = await readJson(result.response)
  const code = payload?.code
  const token = payload?.tenant_access_token
  if (code !== 0 || typeof token !== 'string' || token.length === 0) {
    return { issue: { channel: 'feishu', code: 'business_error', message: deps.redact(`tenant_access_token rejected (code ${String(code)}, msg ${String(payload?.msg ?? '')})`) } }
  }
  deps.registerSecret(token)
  return { token }
}

async function deliverFeishu(
  token: string,
  recipient: ResolvedRecipient,
  card: Record<string, unknown>,
  deps: ResolvedDeps,
): Promise<NotificationRecipientDelivery> {
  const result = await fetchWithBoundedRetry(
    `${FEISHU_API}/im/v1/messages?receive_id_type=open_id`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: recipient.recipientId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    },
    deps,
  )

  if (result.kind === 'aborted') {
    return deliveryEntry('feishu', recipient, 'indeterminate', result.attempts, 'timeout', deps.redact(`send message timed out after ${deps.timeoutMs}ms: ${result.error}`))
  }
  if (result.kind === 'network') {
    return deliveryEntry('feishu', recipient, 'indeterminate', result.attempts, 'network_error', deps.redact(result.error))
  }

  const { response, attempts } = result
  if (!response.ok) {
    return deliveryEntry('feishu', recipient, 'failed', attempts, 'http_error', deps.redact(`send message returned HTTP ${response.status}: ${await readResponseText(response)}`))
  }

  const payload = await readJson(response)
  const code = payload?.code
  if (code !== 0) {
    return deliveryEntry('feishu', recipient, 'failed', attempts, 'business_error', deps.redact(`send message rejected (code ${String(code)}, msg ${String(payload?.msg ?? '')})`))
  }

  return deliveryEntry('feishu', recipient, 'delivered', attempts)
}

// ─── Channel orchestration ────────────────────────────────────────────────────

/**
 * Resolve the explicitly configured recipients for one channel.
 *
 * A recipient is only ever a record that resolves to exactly one entry in the
 * server-side pairing list. `allowedUsers` is an access allowlist and is never
 * consulted. Anything else becomes a visible failure entry rather than a
 * silently skipped one.
 */
function resolveRecipients(
  channel: NotificationChannel,
  specs: NotificationRecipientSpec[] | undefined,
  pairedUsers: PairedUser[],
): RecipientResolutionResult {
  if (!specs || specs.length === 0) {
    return { resolved: [], failures: [] }
  }

  const resolved: ResolvedRecipient[] = []
  const failures: NotificationRecipientDelivery[] = []
  const seen = new Set<string>()

  for (const spec of specs) {
    const result = resolveNotificationRecipient(spec, pairedUsers)
    if (result.kind === 'resolved') {
      // The same user listed twice is one delivery, not a reason to fail.
      if (seen.has(result.recipient.recipientId)) continue
      seen.add(result.recipient.recipientId)
      resolved.push(result.recipient)
      continue
    }
    if (result.kind === 'ambiguous') {
      failures.push({
        channel,
        recipientId: result.label,
        recipientLabel: result.label,
        outcome: 'failed',
        attempts: 0,
        errorCode: 'recipient_ambiguous',
        error: `${channel} 收件人「${result.label}」在服务端配对记录中命中多个用户，拒绝投递`,
      })
      continue
    }
    failures.push({
      channel,
      recipientId: result.label,
      recipientLabel: result.label,
      outcome: 'failed',
      attempts: 0,
      errorCode: result.kind === 'invalid' ? 'invalid_recipient' : 'recipient_not_verified',
      error: result.kind === 'invalid'
        ? `${channel} 收件人标识为空或无效`
        : `${channel} 收件人「${result.label}」未在服务端配对记录（pairedUsers）中登记，拒绝投递`,
    })
  }

  return { resolved, failures }
}

// ─── Public-entrypoint task notification authorization ────────────────────────

const PUBLIC_TASK_CONTEXT_MISSING =
  '公共任务通知缺少服务端可信任务上下文（getTaskNotificationContext）；调用者自报的 run/task 不能作为授权'
const PUBLIC_TASK_NOT_SELECTED = '任务通知配置未选择公共入口，拒绝公共投递'
const PUBLIC_TASK_DISABLED = '公共入口未启用；任务通知不能经公共 Bot 投递'
const PUBLIC_TASK_OWNER_UNPAIRED = '公共入口尚未绑定操作者，任务通知不能投递'
const PUBLIC_TASK_BOT_TOKEN_MISSING = 'telegram.public.botToken 未配置，公共任务通知无法送出'
const PUBLIC_TASK_RUN_MISMATCH = '公共任务上下文与请求的 run/task 不一致，拒绝投递'
const PUBLIC_TASK_RUN_UNSETTLED = '任务运行尚未结算，拒绝公共通知'
const PUBLIC_TASK_CONFIG_CHANGED = '任务的公共通知选择/Bot 身份已变更，旧通知不会改投新身份'
const PUBLIC_TASK_ROOTS_DENIED = '任务运行目录不在公共允许项目根目录内，拒绝投递'
const PUBLIC_TASK_RECIPIENT_NOT_OWNER = '公共任务通知的收件人不是当前公共 owner，拒绝投递'
const PUBLIC_TASK_RECIPIENT_REQUIRED = '公共任务通知需要恰好一个显式 telegram recipient'

type PublicTaskConfigSnapshot = {
  enabled: boolean
  botToken: string
  ownerUserId: number | null
  generation: number
  allowedProjectRoots: string[]
}

type PublicTaskSnapshot = {
  botToken: string
  ownerUserId: number
  generation: number
  recipient: ResolvedRecipient
}

type PublicTaskAuth =
  | { ok: true; snapshot: PublicTaskSnapshot; text: string }
  | { ok: false; code: NotificationDeliveryFailureCode; error: string }

/** Telegram 入口选择的解析结果：合法入口集合，或不可用的坏字段说明。 */
export type TelegramEntrypointResolution =
  | { ok: true; entrypoints: TelegramMessageEntrypoint[] }
  | { ok: false; error: string }

/**
 * 解析 Telegram 入口选择。
 *
 * 只有「字段未设置」（`undefined`）或「规范化的 `null`」表示缺省，等价于
 * `['dedicated']`，保持旧专属行为。空数组、非数组、未知取值、重复取值都是
 * 持久化坏字段，**不是**合法缺省：返回 `ok: false`，由调用方可见失败，绝不
 * 过滤后兜底退化为专属入口。
 */
export function resolveTelegramEntrypoints(
  notification: TaskNotificationInput,
): TelegramEntrypointResolution {
  const raw: unknown = notification.telegramEntrypoints
  if (raw === undefined || raw === null) return { ok: true, entrypoints: ['dedicated'] }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: '任务通知的 telegramEntrypoints 不是数组，拒绝投递（不会退化为专属入口）',
    }
  }
  if (raw.length === 0) {
    return {
      ok: false,
      error: '任务通知的 telegramEntrypoints 为空数组，拒绝投递（不会退化为专属入口）',
    }
  }
  const seen = new Set<TelegramMessageEntrypoint>()
  for (const value of raw) {
    if (value !== 'dedicated' && value !== 'public') {
      return {
        ok: false,
        error: `任务通知的 telegramEntrypoints 含未知入口「${String(value)}」，拒绝投递`,
      }
    }
    if (seen.has(value)) {
      return {
        ok: false,
        error: `任务通知的 telegramEntrypoints 含重复入口「${value}」，拒绝投递`,
      }
    }
    seen.add(value)
  }
  return { ok: true, entrypoints: [...seen] }
}

function readPublicTaskConfig(config: AdapterFileConfig): PublicTaskConfigSnapshot {
  const pub = config.telegram?.public
  const filterRoots = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  const roots = filterRoots(pub?.allowedProjectRoots)
  const top = filterRoots(config.allowedProjectRoots)
  const owner = pub?.ownerUserId
  return {
    enabled: pub?.enabled === true,
    botToken: typeof pub?.botToken === 'string' ? pub.botToken.trim() : '',
    ownerUserId:
      typeof owner === 'number' && Number.isSafeInteger(owner) && owner > 0 ? owner : null,
    generation:
      typeof pub?.generation === 'number' && Number.isSafeInteger(pub.generation)
        ? pub.generation
        : 0,
    allowedProjectRoots: roots.length > 0 ? roots : top,
  }
}

/**
 * Synthesize the current public owner as a pairing candidate so the shared
 * recipient resolver can match against it — the same shape `cronService` uses
 * for its public validation. The owner is read from adapter config, never from
 * the notification payload, and a public-only owner need not appear in the
 * dedicated `pairedUsers`.
 */
function telegramPublicOwnerCandidate(ownerUserId: number): PairedUser {
  return { userId: ownerUserId, displayName: String(ownerUserId), pairedAt: 0 }
}

function expandHomePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(expandHomePath(target))
  } catch {
    return null
  }
}

/** 允许项目根（fallback 顶层）的 realpath 包含校验；根为空时不限制。 */
async function publicWorkDirAllowed(workDir: string, roots: string[]): Promise<boolean> {
  if (roots.length === 0) return true
  const real = await safeRealpath(workDir)
  if (!real) return false
  for (const root of roots) {
    const realRoot = await safeRealpath(root)
    if (realRoot && isPathInside(real, realRoot)) return true
  }
  return false
}

function isTerminalRunStatus(status: TaskRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'timeout'
}

function publicTaskStatusLabel(status: TaskRun['status']): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'timeout': return '超时'
    default: return '状态更新'
  }
}

/**
 * 公共任务通知正文。头部按要求带上可信定位（项目 / 任务名称 / 完整 taskId），
 * 正文沿用既有任务摘要规则（3000 / 500），不是会话全文；`Run:` 用真源 run id。
 */
export function buildPublicTaskPlainText(
  task: CronTask,
  run: TaskRun,
  projectLabel: string,
): string {
  const name = truncate(task.name?.trim() || task.prompt.slice(0, 60) || run.taskName || '未命名任务', 60)
  const lines: string[] = [
    `[ccmax · 定时任务 · ${projectLabel} · ${name} · T${task.id}] ${publicTaskStatusLabel(run.status)}：`,
    `Run: ${run.id}`,
  ]
  const sessionId = typeof run.sessionId === 'string' ? run.sessionId.trim() : ''
  if (sessionId.length > 0) lines.push(`会话: ${sessionId}`)
  if (run.durationMs != null) lines.push(`Duration: ${formatDuration(run.durationMs)}`)
  lines.push('')
  if (run.status === 'failed' && run.error) {
    lines.push('Error:')
    lines.push(truncate(run.error, TELEGRAM_ERROR_LIMIT))
    lines.push('')
  }
  lines.push('Result:')
  lines.push(truncate(run.output ?? '', TELEGRAM_OUTPUT_LIMIT))
  return lines.join('\n')
}

/**
 * 授权一次公共任务投递。**每次网络尝试前调用**，逐项复核：
 * - 入口字段合法且当前仍选择公共入口；
 * - 公共启用状态 / Bot token / 代次 / owner 与 `sendTaskNotification` 初次读取的
 *   快照一致（写 pending 期间换 Bot、换 owner 或 bump 代次都拒绝，旧任务不会改投
 *   新身份）；
 * - 公共入口启用、已绑定 owner、公共 Bot token 存在；
 * - 唯一显式 recipient 仍解析为当前公共 owner（用 owner 合成候选，与
 *   `cronService` 公共校验一致；公共 owner 不必在专属 pairedUsers 里）；
 * - 服务端可信上下文（调度器闭包）匹配登记的 run/task 且 run 已结算；
 * - 任务真源仍选择 telegram + public，且收件人未改；
 * - 可信执行目录落在允许项目根内（realpath 包含）。
 *
 * 调用者传入的 `run.output` 等字段从不参与——正文永远用真源 run 重新格式化。
 */
async function authorizePublicTaskAttempt(
  notification: TaskNotificationInput,
  run: TaskRun,
  spec: NotificationRecipientSpec,
  deps: ResolvedDeps,
  pin: PublicTaskConfigSnapshot,
): Promise<PublicTaskAuth> {
  const fail = (code: NotificationDeliveryFailureCode, error: string): PublicTaskAuth =>
    ({ ok: false, code, error })

  const entrypoints = resolveTelegramEntrypoints(notification)
  if (!entrypoints.ok) {
    return fail('invalid_telegram_entrypoints', entrypoints.error)
  }
  if (!entrypoints.entrypoints.includes('public')) {
    return fail('public_route_rejected', PUBLIC_TASK_NOT_SELECTED)
  }

  // Re-read the adapter config on every attempt: a token rotation, owner
  // change, generation bump, public disablement or roots change between
  // attempts must invalidate the send instead of silently reusing a stale
  // snapshot.
  let config: AdapterFileConfig
  try {
    config = await adapterService.getRawConfig()
  } catch (error) {
    return fail(
      'adapter_config_unreadable',
      deps.redact(`读取 adapter 配置失败：${describeError(error)}`),
    )
  }

  const snapshot = readPublicTaskConfig(config)
  // The pinned identity comes from the config read at the *start* of
  // `sendTaskNotification`, not from this (possibly much later) attempt. Any
  // drift — including a token rotated after the pending row was written — fails
  // visibly rather than re-targeting the old task to a new Bot/owner.
  if (
    snapshot.enabled !== pin.enabled
    || snapshot.botToken !== pin.botToken
    || snapshot.ownerUserId !== pin.ownerUserId
    || snapshot.generation !== pin.generation
  ) {
    return fail('public_route_rejected', PUBLIC_TASK_CONFIG_CHANGED)
  }
  if (!snapshot.enabled) return fail('public_route_rejected', PUBLIC_TASK_DISABLED)
  if (snapshot.botToken.length === 0) {
    return fail('credentials_missing', PUBLIC_TASK_BOT_TOKEN_MISSING)
  }
  if (snapshot.ownerUserId === null) {
    return fail('public_route_rejected', PUBLIC_TASK_OWNER_UNPAIRED)
  }

  // The public entrypoint resolves the recipient against the *synthesized*
  // current owner, exactly as `cronService` validates a public task. A
  // public-only owner is legitimately absent from the dedicated `pairedUsers`.
  const ownerCandidate = telegramPublicOwnerCandidate(snapshot.ownerUserId)
  const resolution = resolveNotificationRecipient(spec, [ownerCandidate])
  if (resolution.kind === 'invalid') {
    return fail('invalid_recipient', `telegram 公共任务通知收件人「${resolution.label}」标识无效，拒绝投递`)
  }
  if (
    resolution.kind !== 'resolved'
    || String(resolution.recipient.recipientId) !== String(snapshot.ownerUserId)
  ) {
    return fail('public_route_rejected', PUBLIC_TASK_RECIPIENT_NOT_OWNER)
  }

  let context: { task: CronTask; run: TaskRun; workDir: string } | null
  try {
    context = await deps.getTaskNotificationContext({ id: run.id, taskId: run.taskId })
  } catch (error) {
    return fail(
      'task_context_unavailable',
      deps.redact(`读取可信任务上下文失败：${describeError(error)}`),
    )
  }
  if (!context) return fail('task_context_unavailable', PUBLIC_TASK_CONTEXT_MISSING)

  const trustedRun = context.run
  const task = context.task
  if (trustedRun.id !== run.id || trustedRun.taskId !== run.taskId || task.id !== run.taskId) {
    return fail('task_context_unavailable', PUBLIC_TASK_RUN_MISMATCH)
  }
  if (!isTerminalRunStatus(trustedRun.status)) {
    return fail('task_context_unavailable', PUBLIC_TASK_RUN_UNSETTLED)
  }

  // 真源任务配置仍须选择 telegram + public，且收件人未被改投。真源里的坏入口
  // 字段同样 fail-closed，不能静默按专属处理。
  const taskNotification = task.notification as TaskNotificationInput | undefined
  const taskEntrypoints = taskNotification
    ? resolveTelegramEntrypoints(taskNotification)
    : null
  if (
    !taskNotification
    || taskNotification.enabled !== true
    || !Array.isArray(taskNotification.channels)
    || !taskNotification.channels.includes('telegram')
    || !taskEntrypoints?.ok
    || !taskEntrypoints.entrypoints.includes('public')
  ) {
    return fail('task_context_unavailable', PUBLIC_TASK_CONFIG_CHANGED)
  }
  const taskSpecs = taskNotification.recipients?.telegram
  if (!Array.isArray(taskSpecs) || taskSpecs.length !== 1) {
    return fail('public_route_rejected', PUBLIC_TASK_RECIPIENT_REQUIRED)
  }
  const taskResolution = resolveNotificationRecipient(taskSpecs[0]!, [ownerCandidate])
  if (
    taskResolution.kind !== 'resolved'
    || String(taskResolution.recipient.recipientId) !== String(resolution.recipient.recipientId)
  ) {
    return fail('public_route_rejected', PUBLIC_TASK_RECIPIENT_NOT_OWNER)
  }

  if (!await publicWorkDirAllowed(context.workDir, snapshot.allowedProjectRoots)) {
    return fail('public_route_rejected', PUBLIC_TASK_ROOTS_DENIED)
  }

  const projectLabel = path.basename(expandHomePath(context.workDir)) || '未知项目'
  return {
    ok: true,
    snapshot: {
      botToken: snapshot.botToken,
      ownerUserId: snapshot.ownerUserId,
      generation: snapshot.generation,
      recipient: resolution.recipient,
    },
    text: buildPublicTaskPlainText(task, trustedRun, projectLabel),
  }
}

/**
 * 公共入口任务通知。不做订阅校验，也不再写公共会话 outbox/回复映射：
 * 只调公共纯 HTTP transport（`executeTelegramSendMessage`），凭服务端可信任务
 * 上下文与公共 owner 授权；无可信回调、伪造/删除/不登记/未结算/nonowner/篡改
 * 收件人一律明确失败。每轮重试前重新读 adapter 配置与可信上下文，5xx/429 有界
 * 重试，超时/不确定绝不盲目重发。
 *
 * `pin` 是 `sendTaskNotification` 初次读取 config 得到的公共快照（token / 代次 /
 * owner / enabled）。投递身份、幂等键与失败日志都以它为准，避免写 pending 期间换
 * Bot 或换 owner 后旧任务改投新身份；每次 attempt 由 `authorizePublicTaskAttempt`
 * 与最新 config 比对，任何漂移都可见失败。
 */
async function deliverPublicTelegramChannel(
  pin: PublicTaskConfigSnapshot,
  notification: TaskNotificationInput,
  run: TaskRun,
  report: NotificationDeliveryReport,
  deps: ResolvedDeps,
): Promise<void> {
  const rawSpecs = notification.recipients?.telegram

  if (!Array.isArray(rawSpecs) || rawSpecs.length !== 1) {
    const label = Array.isArray(rawSpecs) && rawSpecs.length > 0 ? labelFor(rawSpecs[0]!) : '<empty>'
    const recipient = publicJournalRecipient(pin, label)
    await deliverWithRecord(
      run, 'telegram', recipient, 0, deps, report,
      async () => deliveryEntry(
        'telegram', recipient, 'failed', 0, 'public_route_rejected',
        PUBLIC_TASK_RECIPIENT_REQUIRED, { telegramEntrypoint: 'public' },
      ),
      { telegramEntrypoint: 'public' },
    )
    return
  }

  const spec = rawSpecs[0]!
  // Journal and logs carry the real owner id, never a display name; a
  // public-only owner has no dedicated pairing record to borrow a label from.
  const recipient = publicJournalRecipient(pin, labelFor(spec))

  const maxRounds = Math.max(1, deps.maxAttempts)
  const attempt = async (): Promise<NotificationRecipientDelivery> => {
    let attempts = 0
    let lastCode: NotificationDeliveryFailureCode = 'http_error'
    let lastError = 'telegram 公共投递失败'

    try {
      for (let round = 1; round <= maxRounds; round += 1) {
        // Re-read the adapter config and the trusted task context before every
        // network attempt: a revoked owner, changed token/generation, re-targeted
        // recipient, deleted task or unresolved run must stop the send. The read
        // config is compared against the initial snapshot (`pin`), so a change
        // made after the pending row was written can never re-target this task.
        const auth = await authorizePublicTaskAttempt(notification, run, spec, deps, pin)
        if (!auth.ok) {
          return deliveryEntry(
            'telegram', recipient, 'failed', attempts, auth.code, auth.error,
            { telegramEntrypoint: 'public' },
          )
        }

        attempts += 1
        deps.registerSecret(auth.snapshot.botToken)
        const sent = await executeTelegramSendMessage(
          auth.snapshot.botToken,
          auth.snapshot.recipient.chatId,
          trimTelegramText(auth.text),
          { ...deps, maxAttempts: 1 },
        )
        if (sent.outcome === 'delivered') {
          return deliveryEntry(
            'telegram', recipient, 'delivered', attempts, undefined, undefined,
            { telegramEntrypoint: 'public', messageId: sent.messageId },
          )
        }
        if (sent.outcome === 'indeterminate') {
          // Timeout / network uncertainty: the platform may have received it, so
          // never blindly resend.
          return deliveryEntry(
            'telegram', recipient, 'indeterminate', attempts, sent.errorCode, sent.error,
            { telegramEntrypoint: 'public' },
          )
        }

        lastCode = sent.errorCode ?? 'http_error'
        lastError = sent.error ?? lastError
        const retryAfterMs = sent.retryAfterMs
        const retryable = retryAfterMs !== undefined || sent.status === 429 || (sent.status !== undefined && sent.status >= 500)
        if (!retryable || round >= maxRounds) break
        await deps.sleep(retryAfterMs !== undefined ? retryAfterMs : deps.retryDelayMs * round)
      }
    } catch (error) {
      // Never let a public-route safety throw leave the row pending: convert any
      // unexpected error into a visible failed settlement.
      return deliveryEntry(
        'telegram', recipient, 'failed', attempts, 'http_error',
        deps.redact(`公共任务通知未预期失败：${describeError(error)}`),
        { telegramEntrypoint: 'public' },
      )
    }

    return deliveryEntry(
      'telegram', recipient, 'failed', attempts, lastCode, lastError,
      { telegramEntrypoint: 'public' },
    )
  }

  await deliverWithRecord(run, 'telegram', recipient, 0, deps, report, attempt, {
    telegramEntrypoint: 'public',
  })
}

/**
 * The journal identity for a public delivery: the real owner id when the public
 * config names one, otherwise the raw recipient label. Never a paired
 * display name — the delivery key and failure log must survive a public-only
 * install that has no dedicated pairing record.
 */
function publicJournalRecipient(pin: PublicTaskConfigSnapshot, label: string): ResolvedRecipient {
  if (pin.ownerUserId === null) {
    return { chatId: label, recipientId: label, displayName: label }
  }
  const ownerId = String(pin.ownerUserId)
  return { chatId: pin.ownerUserId, recipientId: ownerId, displayName: ownerId }
}

async function deliverTelegramChannel(
  config: AdapterFileConfig,
  notification: TaskNotificationInput,
  run: TaskRun,
  report: NotificationDeliveryReport,
  deps: ResolvedDeps,
): Promise<void> {
  // 仅缺省的 `telegramEntrypoints` 才退化为专属；坏字段可见失败，绝不静默发往
  // 任一端。
  const entrypoints = resolveTelegramEntrypoints(notification)
  if (!entrypoints.ok) {
    report.issues.push({
      channel: 'telegram',
      code: 'invalid_telegram_entrypoints',
      message: entrypoints.error,
    })
    return
  }

  // Pin the public identity from the config read at the start of
  // `sendTaskNotification`, so a token/owner/generation change made while the
  // pending row is being written can never re-target this delivery.
  const publicPin = readPublicTaskConfig(config)

  // 两端可同时选中：同一显式 recipient 分别独立投递。每端单独 catch，一端抛异常
  // 不抑制另一端，也不从一端回退到另一端。缺省只有专属入口。
  if (entrypoints.entrypoints.includes('dedicated')) {
    try {
      await deliverDedicatedTelegramChannel(config, notification, run, report, deps)
    } catch (error) {
      report.issues.push({
        channel: 'telegram',
        code: 'http_error',
        message: deps.redact(`专属 Telegram 通知未预期失败：${describeError(error)}`),
      })
    }
  }
  if (entrypoints.entrypoints.includes('public')) {
    try {
      await deliverPublicTelegramChannel(publicPin, notification, run, report, deps)
    } catch (error) {
      report.issues.push({
        channel: 'telegram',
        code: 'http_error',
        message: deps.redact(`公共 Telegram 通知未预期失败：${describeError(error)}`),
      })
    }
  }
}

async function deliverDedicatedTelegramChannel(
  config: AdapterFileConfig,
  notification: TaskNotificationInput,
  run: TaskRun,
  report: NotificationDeliveryReport,
  deps: ResolvedDeps,
): Promise<void> {
  const botToken = config.telegram?.botToken
  if (!botToken) {
    report.issues.push({ channel: 'telegram', code: 'credentials_missing', message: 'telegram.botToken 未配置，通知无法送出' })
    return
  }
  deps.registerSecret(botToken)

  const { resolved, failures } = resolveRecipients('telegram', notification.recipients?.telegram, config.telegram?.pairedUsers ?? [])
  if (resolved.length === 0 && failures.length === 0) {
    report.issues.push({
      channel: 'telegram',
      code: 'no_recipients_configured',
      message: 'telegram 通知未配置显式收件人；拒绝向全部 pairedUsers 广播',
    })
    return
  }

  const text = buildTelegramPlainText(run)
  let ordinal = 0
  for (const failure of failures) {
    const recipient: ResolvedRecipient = {
      chatId: failure.recipientId,
      recipientId: failure.recipientId,
      displayName: failure.recipientLabel,
    }
    await deliverWithRecord(run, 'telegram', recipient, ordinal++, deps, report, async () => failure)
  }
  for (const recipient of resolved) {
    const gate = dedicatedTelegramGate(config, run.sessionId, recipient, deps.getDedicatedBinding)
    if (gate) {
      await deliverWithRecord(run, 'telegram', recipient, ordinal++, deps, report, async () =>
        deliveryEntry('telegram', recipient, 'failed', 0, gate.errorCode, gate.error),
      )
      continue
    }
    await deliverWithRecord(run, 'telegram', recipient, ordinal++, deps, report, () =>
      deliverTelegram(botToken, recipient, text, deps),
    )
  }
}

async function deliverFeishuChannel(
  config: AdapterFileConfig,
  notification: TaskNotificationInput,
  run: TaskRun,
  report: NotificationDeliveryReport,
  deps: ResolvedDeps,
): Promise<void> {
  const appId = config.feishu?.appId
  const appSecret = config.feishu?.appSecret
  if (!appId || !appSecret) {
    report.issues.push({ channel: 'feishu', code: 'credentials_missing', message: 'feishu.appId/appSecret 未配置，通知无法送出' })
    return
  }
  deps.registerSecret(appSecret)

  const { resolved, failures } = resolveRecipients('feishu', notification.recipients?.feishu, config.feishu?.pairedUsers ?? [])
  if (resolved.length === 0 && failures.length === 0) {
    report.issues.push({
      channel: 'feishu',
      code: 'no_recipients_configured',
      message: 'feishu 通知未配置显式收件人；拒绝向全部 pairedUsers 广播',
    })
    return
  }

  let ordinal = 0
  for (const failure of failures) {
    const recipient: ResolvedRecipient = {
      chatId: failure.recipientId,
      recipientId: failure.recipientId,
      displayName: failure.recipientLabel,
    }
    await deliverWithRecord(run, 'feishu', recipient, ordinal++, deps, report, async () => failure)
  }
  if (resolved.length === 0) return

  const tokenResult = await getFeishuTenantToken(appId, appSecret, deps)
  if (tokenResult.issue) {
    const issue = tokenResult.issue
    report.issues.push(issue)
    // The recipients were named but never attempted: record them as failed so
    // the delivery log does not silently lose them.
    for (const recipient of resolved) {
      await deliverWithRecord(
        run,
        'feishu',
        recipient,
        ordinal++,
        deps,
        report,
        async () => deliveryEntry('feishu', recipient, 'failed', 0, issue.code, `未发送：${issue.message}`),
      )
    }
    return
  }

  const card = buildFeishuCard(run)
  const token = tokenResult.token!
  for (const recipient of resolved) {
    await deliverWithRecord(run, 'feishu', recipient, ordinal++, deps, report, () =>
      deliverFeishu(token, recipient, card, deps),
    )
  }
}

function pushEntry(report: NotificationDeliveryReport, entry: NotificationRecipientDelivery): void {
  if (entry.outcome === 'delivered') report.delivered.push(entry)
  else if (entry.outcome === 'indeterminate') report.indeterminate.push(entry)
  else report.failed.push(entry)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 定时任务 IM 通知。telegram 渠道按 `notification.telegramEntrypoints` 选择专属、
 * 公共或两端：缺省/规范 null 走旧专属 Bot 与旧投递日志；`public` 走公共 Bot 的
 * 纯 HTTP 传输，凭服务端可信任务上下文与当前公共 owner 授权，不写公共会话
 * outbox/回复映射、不改 subscriptions。两端各自独立投递与结算，一端失败不抑制
 * 另一端。desktop / feishu 行为不变。
 *
 * 已订阅公共入口的任务会话完成报告走另一条路径（session_turn →
 * telegramPublicService），不经本函数。
 */
export async function sendTaskNotification(
  run: TaskRun,
  notification: TaskNotificationInput,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationDeliveryReport> {
  const deps = resolveDeps(options)
  const report: NotificationDeliveryReport = {
    ok: true,
    delivered: [],
    failed: [],
    indeterminate: [],
    issues: [],
    recordPath: deps.store.filePath,
  }

  // A stored config whose channel list is missing or is not an array can only
  // come from an older writer that skipped validation. Returning the empty
  // report here would record "nothing to deliver" for a task that asked for a
  // notification, so the unusable config itself becomes a visible issue.
  const rawChannels = Array.isArray(notification.channels) ? notification.channels : null
  const imChannels = (rawChannels ?? []).filter(isImChannel)
  if (!notification.enabled) return report

  if (rawChannels === null) {
    report.issues.push({
      code: 'no_recipients_configured',
      message: '任务的通知配置缺少可用的渠道列表（channels），已拒绝投递；请在任务页面重新保存通知设置。',
    })
    return finalizeReport(report, deps)
  }

  if (imChannels.length === 0) return report

  // Reconcile leftovers from a previous process before opening new pending rows.
  await recoverPendingOnce(deps)

  let config: AdapterFileConfig
  try {
    config = await adapterService.getRawConfig()
  } catch (error) {
    for (const channel of imChannels) {
      report.issues.push({
        channel,
        code: 'adapter_config_unreadable',
        message: `读取 adapter 配置失败：${describeError(error)}`,
      })
    }
    return finalizeReport(report, deps)
  }

  for (const channel of imChannels) {
    try {
      if (channel === 'telegram') {
        await deliverTelegramChannel(config, notification, run, report, deps)
      } else {
        await deliverFeishuChannel(config, notification, run, report, deps)
      }
    } catch (error) {
      report.issues.push({ channel, code: 'http_error', message: deps.redact(`${channel} 通知未预期失败：${describeError(error)}`) })
    }
  }

  return finalizeReport(report, deps)
}

/**
 * Send one message immediately, outside a task run.
 *
 * This is the service behind the local-only "send a message" API the tool uses.
 * Dedicated Telegram / Feishu still share recipient resolution and the
 * pending/settle log with task notifications. Public Telegram is a separate
 * entry: it requires a real source session and delegates to
 * `sendSessionReport`, which owns outbox and subscription routing. The public
 * bot token is never used here, and a public send never falls back to the
 * dedicated bot or the old delivery store.
 *
 * `sourceSessionId` is a claimed source for verification, not an authorization
 * grant — a model-supplied value cannot bypass subscription or dedicated
 * binding checks, and the message body is never parsed as a source.
 */
export type ImmediateMessageInput = {
  channel: NotificationChannel
  recipient?: NotificationRecipientSpec
  text: string
  /** Optional Feishu card header; Telegram ignores it. */
  title?: string
  runId?: string
  taskId?: string
  /** Telegram only. Default `dedicated`. */
  entrypoint?: TelegramMessageEntrypoint
  /**
   * Trusted source session from the tool/runtime context (e.g. `getSessionId()`
   * or `run.sessionId`). Not treated as authorization by itself.
   */
  sourceSessionId?: string
}

export type ImmediateMessageResult = {
  ok: boolean
  /** 公共入口入队成功。不是平台送达；此时 `delivery.outcome` 为 `pending`。 */
  queued?: true
  delivery?: NotificationRecipientDelivery
  issues: NotificationDeliveryIssue[]
  recordPath: string
}

function publicRecordPath(): string {
  return getTelegramPublicStorePath()
}

function publicImmediateQueued(sourceSessionId: string): ImmediateMessageResult {
  return {
    ok: true,
    queued: true,
    delivery: {
      channel: 'telegram',
      recipientId: sourceSessionId,
      recipientLabel: 'public',
      outcome: 'pending',
      attempts: 0,
    },
    issues: [],
    recordPath: publicRecordPath(),
  }
}

function publicImmediateFailure(
  code: NotificationDeliveryFailureCode,
  message: string,
  channel: NotificationChannel = 'telegram',
): ImmediateMessageResult {
  return {
    ok: false,
    issues: [{ channel, code, message }],
    recordPath: publicRecordPath(),
  }
}

async function sendImmediatePublic(
  input: ImmediateMessageInput,
  text: string,
  deps: ResolvedDeps,
): Promise<ImmediateMessageResult> {
  if (input.channel !== 'telegram') {
    return publicImmediateFailure('public_route_rejected', PUBLIC_ENTRYPOINT_TELEGRAM_ONLY, input.channel)
  }
  const sourceSessionId = input.sourceSessionId?.trim()
  if (!sourceSessionId) {
    return publicImmediateFailure('source_session_required', PUBLIC_SOURCE_REQUIRED)
  }

  const eventId = (input.runId?.trim() || randomUUID())
  try {
    const enqueued = await deps.sendPublicSessionReport(sourceSessionId, eventId, text)
    if (enqueued?.queued !== true) {
      return publicImmediateFailure('public_route_rejected', '公共入口未确认入队，禁止据此认定送达')
    }
    return publicImmediateQueued(sourceSessionId)
  } catch (error) {
    return publicImmediateFailure(
      'public_route_rejected',
      deps.redact(`公共入口发送失败：${describeError(error)}`),
    )
  }
}

export async function sendImmediateMessage(
  input: ImmediateMessageInput,
  options: NotificationDeliveryOptions = {},
): Promise<ImmediateMessageResult> {
  const deps = resolveDeps(options)
  const issues: NotificationDeliveryIssue[] = []
  const text = input.text.trim()
  if (text.length === 0) {
    return {
      ok: false,
      issues: [{ channel: input.channel, code: 'invalid_recipient', message: '消息内容为空，未发送' }],
      recordPath: deps.store.filePath,
    }
  }

  if (input.entrypoint === 'public') {
    return sendImmediatePublic(input, text, deps)
  }

  await recoverPendingOnce(deps)

  let config: AdapterFileConfig
  try {
    config = await adapterService.getRawConfig()
  } catch (error) {
    return {
      ok: false,
      issues: [{ channel: input.channel, code: 'adapter_config_unreadable', message: `读取 adapter 配置失败：${describeError(error)}` }],
      recordPath: deps.store.filePath,
    }
  }

  if (input.recipient === undefined) {
    return {
      ok: false,
      issues: [{ channel: input.channel, code: 'invalid_recipient', message: '收件人不能为空，未发送' }],
      recordPath: deps.store.filePath,
    }
  }

  const pairedUsers = input.channel === 'telegram'
    ? config.telegram?.pairedUsers ?? []
    : config.feishu?.pairedUsers ?? []

  // Reuse the exact task-notification pairing check: a unique match in the
  // server-side pairing records, never the access allowlist.
  const resolution = resolveNotificationRecipient(input.recipient, pairedUsers)
  const label = resolution.kind === 'resolved' ? resolution.recipient.displayName : resolution.label
  const recipient: ResolvedRecipient = resolution.kind === 'resolved'
    ? resolution.recipient
    : { chatId: label, recipientId: label, displayName: label }

  const run: TaskRun = {
    // A conversation send has no task run id. Give each call its own journal
    // identity so later messages to the same recipient cannot settle old rows.
    id: input.runId || randomUUID(),
    taskId: input.taskId ?? '',
    taskName: input.title ?? '',
    startedAt: deps.now().toISOString(),
    status: 'completed',
    prompt: '',
    ...(input.sourceSessionId?.trim() ? { sessionId: input.sourceSessionId.trim() } : {}),
  }

  const report: NotificationDeliveryReport = {
    ok: true,
    delivered: [],
    failed: [],
    indeterminate: [],
    issues,
    recordPath: deps.store.filePath,
  }

  if (resolution.kind !== 'resolved') {
    const code: NotificationDeliveryFailureCode =
      resolution.kind === 'ambiguous' ? 'recipient_ambiguous'
        : resolution.kind === 'invalid' ? 'invalid_recipient'
          : 'recipient_not_verified'
    const entry = deliveryEntry(
      input.channel,
      recipient,
      'failed',
      0,
      code,
      `${input.channel} 收件人「${label}」无法唯一命中服务端配对记录，拒绝投递`,
    )
    await deliverWithRecord(run, input.channel, recipient, 0, deps, report, async () => entry)
    return finalizeImmediate(report, deps)
  }

  if (input.channel === 'telegram') {
    const botToken = config.telegram?.botToken
    if (!botToken) {
      issues.push({ channel: 'telegram', code: 'credentials_missing', message: 'telegram.botToken 未配置，消息无法送出' })
      return finalizeImmediate(report, deps)
    }
    const gate = dedicatedTelegramGate(config, input.sourceSessionId, recipient, deps.getDedicatedBinding)
    if (gate) {
      await deliverWithRecord(run, 'telegram', recipient, 0, deps, report, async () =>
        deliveryEntry('telegram', recipient, 'failed', 0, gate.errorCode, gate.error),
      )
      return finalizeImmediate(report, deps)
    }
    deps.registerSecret(botToken)
    await deliverWithRecord(run, 'telegram', recipient, 0, deps, report, () =>
      deliverTelegram(botToken, recipient, text, deps),
    )
    return finalizeImmediate(report, deps)
  }

  const appId = config.feishu?.appId
  const appSecret = config.feishu?.appSecret
  if (!appId || !appSecret) {
    issues.push({ channel: 'feishu', code: 'credentials_missing', message: 'feishu.appId/appSecret 未配置，消息无法送出' })
    return finalizeImmediate(report, deps)
  }
  deps.registerSecret(appSecret)

  const tokenResult = await getFeishuTenantToken(appId, appSecret, deps)
  if (tokenResult.issue) {
    const issue = tokenResult.issue
    issues.push(issue)
    await deliverWithRecord(run, 'feishu', recipient, 0, deps, report, async () =>
      deliveryEntry('feishu', recipient, 'failed', 0, issue.code, `未发送：${issue.message}`),
    )
    return finalizeImmediate(report, deps)
  }

  const card = buildFeishuTextCard(text, input.title)
  const token = tokenResult.token!
  await deliverWithRecord(run, 'feishu', recipient, 0, deps, report, () =>
    deliverFeishu(token, recipient, card, deps),
  )
  return finalizeImmediate(report, deps)
}

function finalizeImmediate(report: NotificationDeliveryReport, deps: ResolvedDeps): ImmediateMessageResult {
  finalizeReportReport(report, deps)
  const delivery = report.delivered[0] ?? report.failed[0] ?? report.indeterminate[0]
  return {
    ok: report.ok,
    ...(delivery ? { delivery } : {}),
    issues: report.issues,
    recordPath: report.recordPath,
  }
}

/** A Feishu `interactive` card carrying plain text, for immediate messages. */
export function buildFeishuTextCard(text: string, title?: string): Record<string, unknown> {
  const trimmedTitle = title?.trim()
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'ccmax' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: truncate(text, FEISHU_OUTPUT_LIMIT), text_align: 'left' },
      ],
    },
  }
}

function finalizeReport(
  report: NotificationDeliveryReport,
  deps: ResolvedDeps,
): NotificationDeliveryReport {
  finalizeReportReport(report, deps)
  return report
}

function finalizeReportReport(report: NotificationDeliveryReport, deps: ResolvedDeps): void {
  for (const entry of report.failed) {
    deps.logger.error(`[Notification] ${entry.channel} 投递失败 (${entry.recipientLabel})`, deps.redact(entry.error ?? ''))
  }
  for (const entry of report.indeterminate) {
    deps.logger.error(`[Notification] ${entry.channel} 投递状态不确定 (${entry.recipientLabel})`, deps.redact(entry.error ?? ''))
  }
  for (const issue of report.issues) {
    deps.logger.error(`[Notification] ${issue.channel ?? 'delivery'} ${issue.code}`, deps.redact(issue.message))
  }

  report.ok = report.failed.length === 0 && report.indeterminate.length === 0 && report.issues.length === 0
}