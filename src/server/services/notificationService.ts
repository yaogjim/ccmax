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
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'
import { adapterService, type AdapterFileConfig, type PairedUser } from './adapterService.js'
import type { TaskRun } from './cronScheduler.js'
import {
  NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART,
  NotificationDeliveryStore,
  getNotificationDeliveryStorePath,
  type NotificationChannel,
  type NotificationDeliveryOutcome,
  type PendingDeliveryInput,
} from './notificationDeliveryStore.js'

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
 */
export type TaskNotificationInput = {
  enabled: boolean
  channels: ('desktop' | NotificationChannel)[]
  recipients?: Partial<Record<NotificationChannel, NotificationRecipientSpec[]>>
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
  deliveryId: (parts: { runId: string; channel: NotificationChannel; recipientId: string; ordinal: number }) => string
  /** Register a credential so every later redact() call strips it. */
  registerSecret: (secret: string | undefined) => void
  /** Strip every registered credential and Telegram `/bot<token>` paths. */
  redact: (text: string) => string
}

function defaultDeliveryId(parts: { runId: string; channel: NotificationChannel; recipientId: string; ordinal: number }): string {
  // Stable across retries of the same run so a redelivery cannot duplicate the
  // log; a new run id or recipient produces a new key.
  return `${parts.runId}::${parts.channel}::${parts.recipientId}::${parts.ordinal}`
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
  }
}

/**
 * The store is shared by every caller in this process. A restart leaves
 * `pending` rows behind (the previous process never observed the platform's
 * answer), so the first delivery after startup reconciles them to
 * `indeterminate` exactly once per store file. Running the pass on every send
 * would race an in-flight send from another task and mislabel a delivery that
 * is still on the wire.
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
): NotificationRecipientDelivery {
  return {
    channel,
    recipientId: recipient.recipientId,
    recipientLabel: recipient.displayName,
    outcome,
    attempts,
    ...(errorCode ? { errorCode } : {}),
    ...(error ? { error } : {}),
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
): Promise<void> {
  const deliveryId = deps.deliveryId({
    runId: run.id,
    channel,
    recipientId: recipient.recipientId,
    ordinal,
  })
  const pending: PendingDeliveryInput = {
    deliveryId,
    runId: run.id,
    taskId: run.taskId,
    channel,
    recipientId: recipient.recipientId,
    recipientDisplayName: recipient.displayName,
    createdAt: deps.now().toISOString(),
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

  const entry = await attempt()

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

async function deliverTelegram(
  botToken: string,
  recipient: ResolvedRecipient,
  text: string,
  deps: ResolvedDeps,
): Promise<NotificationRecipientDelivery> {
  const result = await fetchWithBoundedRetry(
    `${TELEGRAM_API}/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No parse_mode: plain text survives any markdown-breaking character.
      body: JSON.stringify({ chat_id: recipient.chatId, text: trimTelegramText(text) }),
    },
    deps,
  )

  if (result.kind === 'aborted') {
    return deliveryEntry('telegram', recipient, 'indeterminate', result.attempts, 'timeout', deps.redact(`sendMessage timed out after ${deps.timeoutMs}ms: ${result.error}`))
  }
  if (result.kind === 'network') {
    return deliveryEntry('telegram', recipient, 'indeterminate', result.attempts, 'network_error', deps.redact(result.error))
  }

  const { response, attempts } = result
  if (!response.ok) {
    return deliveryEntry('telegram', recipient, 'failed', attempts, 'http_error', deps.redact(`sendMessage returned HTTP ${response.status}: ${await readResponseText(response)}`))
  }

  const payload = await readJson(response)
  if (payload && payload.ok === false) {
    return deliveryEntry('telegram', recipient, 'failed', attempts, 'business_error', deps.redact(String(payload.description ?? 'Telegram reported ok:false')))
  }

  const receipt = payload?.result
  const messageId = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>).message_id
    : undefined
  if (payload?.ok !== true || typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
    return deliveryEntry('telegram', recipient, 'indeterminate', attempts, 'invalid_receipt', 'Telegram 未返回可验证的消息回执，禁止据此认定送达')
  }

  return { ...deliveryEntry('telegram', recipient, 'delivered', attempts), messageId }
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

async function deliverTelegramChannel(
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
 * It shares the recipient resolution and the sender with task notifications, so
 * a destination is only ever a paired account and the same pending/settle log
 * records the attempt. `runId`/`taskId` are optional and only used to link the
 * record back to a conversation or run.
 */
export type ImmediateMessageInput = {
  channel: NotificationChannel
  recipient: NotificationRecipientSpec
  text: string
  /** Optional Feishu card header; Telegram ignores it. */
  title?: string
  runId?: string
  taskId?: string
}

export type ImmediateMessageResult = {
  ok: boolean
  delivery?: NotificationRecipientDelivery
  issues: NotificationDeliveryIssue[]
  recordPath: string
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