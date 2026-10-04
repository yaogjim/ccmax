/**
 * Telegram Adapter for Claude Code Desktop
 *
 * 基于 grammY 的轻量 Telegram Bot，直连服务端 /ws/:sessionId。
 * 启动：TELEGRAM_BOT_TOKEN=xxx bun run telegram/index.ts
 */

import { Bot, InlineKeyboard, type Context } from 'grammy'
import * as path from 'node:path'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import {
  formatImStatus,
  formatPermissionRequest,
  splitMessage,
} from '../common/format.js'
import {
  buildTelegramThinkingUpdate,
} from './format.js'
import { TelegramStreamDelivery } from './stream-delivery.js'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  parsePermissionCommand,
  parsePermitCallbackData,
  type PermissionDecision,
} from '../common/permission.js'
import { SessionStore } from '../common/session-store.js'
import { createAdapterClient } from '../common/adapter-client.js'
import { restoreStoredSessionBinding, SESSION_RECONNECT_NOTICE, type SessionRestoreResult } from '../common/session-recovery.js'
import { SessionSelectionController } from '../common/session-selection.js'
import { syncImPermissionState } from '../common/permission-sync.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'
import { TelegramMediaService } from './media.js'
import {
  collectTelegramLocalAttachments,
  assembleTelegramMessage,
  isTelegramTranscriptionEnabled,
  planTelegramOutbound,
  setTelegramTranscriber,
  setTelegramLanguageHint,
  splitTelegramNotices,
  type TelegramFileDownloader,
} from './inbound.js'
import type { EnrichedMessage } from '../common/attachment/pipeline.js'
import { resolveConfiguredTranscriber, sttLanguageHint } from '../common/stt.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import { ImageBlockWatcher } from '../common/attachment/image-block-watcher.js'
import type { PendingUpload } from '../common/attachment/attachment-types.js'
import { sendSafeOutboundImage } from '../common/attachment/outbound-image.js'
import { syncTelegramBotCommands, buildTelegramHistoryView, parseTelegramHistoryCallback } from './menu.js'
import { createTelegramQuestionController } from './question-controller.js'
import { createTelegramRuntimeCommandController, registerAuthorizedTelegramCommand, registerTelegramExtendedCommands, registerTelegramSessionCommands, shouldProcessTelegramMessage, tryHandleTelegramSelectionCallback, tryHandleTelegramSessionInput } from './commands.js'

// ---------- init ----------

const config = loadConfig()
if (!config.telegram.botToken) {
  console.error('[Telegram] Missing TELEGRAM_BOT_TOKEN. Set env or ~/.claude/adapters.json')
  process.exit(1)
}

// End-to-end STT wiring: construct the configured provider and hand it to the
// inbound pipeline's module-level slot. No STT config → no provider → voice
// degrades to a file reference with a notice (unchanged).
const telegramTranscriber = resolveConfiguredTranscriber(config)
setTelegramTranscriber(telegramTranscriber)
setTelegramLanguageHint(sttLanguageHint(config))
if (telegramTranscriber) {
  console.log('[Telegram] Voice transcription enabled: stt.provider =', config.stt.provider)
}

export const bot = new Bot(config.telegram.botToken)
const bridge = new WsBridge(config.serverUrl, 'tg')
const streamDelivery = new TelegramStreamDelivery(bot.api)
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir } = createAdapterClient(config, config.telegram)
const attachmentStore = new AttachmentStore()
const media = new TelegramMediaService(bot, attachmentStore)

const accumulatedThinkingText = new Map<string, string>()
const runtimeStates = new Map<string, ChatRuntimeState>()
const pendingPermissions = new Map<string, Set<string>>()
/** Per-chat AskUserQuestion requests awaiting an /answer payload: requestId → tool input. */
const pendingQuestions = new Map<string, Map<string, unknown>>()
/** Telegram caps a text message at 4096 chars; leave the same headroom as streaming. */
const TELEGRAM_TEXT_LIMIT = 4000

/**
 * Global transcription admission control. Local Whisper loads a model per
 * run, so at most `MAX_CONCURRENT_TRANSCRIPTIONS` voices transcribe at once
 * across all chats; extras wait in a bounded FIFO. Past the bound the voice
 * is explicitly refused instead of buffering unbounded audio bytes.
 */
const MAX_CONCURRENT_TRANSCRIPTIONS = 2
const MAX_QUEUED_TRANSCRIPTIONS = 8

type LimiterTicket = { release: () => void }

class TranscriptionLimiter {
  private active = 0
  private readonly waiters: Array<{ start: () => void; cancel: () => void }> = []

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
  ) {}

  /** Acquire a slot, waiting in the bounded FIFO when all are busy.
   *  Returns 'over_capacity' when the wait queue is full, or 'cancelled'
   *  when `signal` aborts before a slot is granted. */
  async acquire(signal: AbortSignal): Promise<LimiterTicket | 'over_capacity' | 'cancelled'> {
    if (signal.aborted) return 'cancelled'
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return this.makeTicket()
    }
    if (this.waiters.length >= this.maxQueue) return 'over_capacity'

    return await new Promise<LimiterTicket | 'cancelled'>((resolve) => {
      const waiter = {
        start: () => {
          signal.removeEventListener('abort', onAbort)
          this.active += 1
          resolve(this.makeTicket())
        },
        cancel: () => {
          signal.removeEventListener('abort', onAbort)
          resolve('cancelled')
        },
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.cancel()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Drain every queued waiter (shutdown); active tickets release themselves. */
  clearQueue(): void {
    for (const waiter of this.waiters.splice(0)) waiter.cancel()
  }

  private makeTicket(): LimiterTicket {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.waiters.shift()?.start()
      },
    }
  }
}

const transcriptionLimiter = new TranscriptionLimiter(
  MAX_CONCURRENT_TRANSCRIPTIONS,
  MAX_QUEUED_TRANSCRIPTIONS,
)

/**
 * Per-chat ceiling on inbound inputs that are received but not finished.
 *
 * The cap is counted from *receive* time, so input waiting for its queue slot
 * still counts: it holds audio bytes in memory and a slot in the chat's
 * queue. Past the cap the input is refused with a visible notice instead of
 * buffering without bound.
 */
export const MAX_PENDING_INPUTS_PER_CHAT = 8

/**
 * One inbound user input, registered *before* it enters the chat's serial
 * queue.
 *
 * Registering at receive time — rather than inside the queued task, which is
 * where the download used to start — is what lets `/stop`, `/clear`, `/new`, a
 * session switch, stale-session recovery and shutdown cancel work that is
 * queued but has not started yet. `generation` is the chat's invalidation
 * counter observed at receive time; it catches the window where an
 * invalidation lands after the last abort check but before the send.
 *
 * The session this input delivers into is deliberately *not* captured here:
 * input that arrives while a `/new` (or a session switch) is still creating its
 * binding has to be delivered into the new one, so the task observes the
 * binding itself, after that command finished.
 */
type PendingInput = {
  controller: AbortController
  generation: number
  /**
   * Settles when the task that owns this input has finished — including any
   * transcription provider's abort cleanup (killing a detached child and
   * removing its temp files). `stopTelegramAdapter` awaits these so the
   * process cannot exit before that cleanup completed.
   */
  completion: Promise<void>
  resolveCompletion: () => void
}

const pendingInputs = new Map<string, PendingInput[]>()
const inputGenerations = new Map<string, number>()

function pendingInputGeneration(chatId: string): number {
  return inputGenerations.get(chatId) ?? 0
}

function countPendingInputs(chatId: string): number {
  return pendingInputs.get(chatId)?.length ?? 0
}

function registerChatInput(chatId: string): PendingInput {
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
  const input: PendingInput = {
    controller: new AbortController(),
    generation: pendingInputGeneration(chatId),
    completion,
    resolveCompletion,
  }
  const list = pendingInputs.get(chatId)
  if (list) list.push(input)
  else pendingInputs.set(chatId, [input])
  return input
}

function releaseChatInput(chatId: string, input: PendingInput): void {
  const list = pendingInputs.get(chatId)
  if (list) {
    const index = list.indexOf(input)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) pendingInputs.delete(chatId)
  }
  // Always resolve, even if the input was already dropped from the map: the
  // shutdown path awaits every registered completion.
  input.resolveCompletion()
}

/**
 * Invalidate every input received for this chat so far — queued, downloading,
 * transcribing, or already past `ensureSession` — and advance the chat's
 * generation so a task that already cleared its last abort check still refuses
 * to send. Called by `/stop`, `/clear`, `/new`, a session switch, stale-session
 * recovery and adapter shutdown.
 *
 * A binding change made by the input's own task (creating its session on
 * first use) must NOT invalidate that task, so session creation deliberately
 * does not call this.
 */
function invalidateChatInputs(chatId: string): void {
  inputGenerations.set(chatId, pendingInputGeneration(chatId) + 1)
  const list = pendingInputs.get(chatId)
  if (!list) return
  for (const input of list) input.controller.abort()
}

/** Shutdown: invalidate every chat's pending input, active or queued. */
function invalidateAllChatInputs(): void {
  for (const chatId of [...pendingInputs.keys()]) invalidateChatInputs(chatId)
  transcriptionLimiter.clearQueue()
}

/** Set by {@link stopTelegramAdapter}; every send path refuses while true. */
let shuttingDown = false

/** Per-chat outbound image watcher for Agent-produced markdown images. */
const tgImageWatchers = new Map<string, ImageBlockWatcher>()

function getTgWatcher(chatId: string): ImageBlockWatcher {
  let w = tgImageWatchers.get(chatId)
  if (!w) {
    w = new ImageBlockWatcher()
    tgImageWatchers.set(chatId, w)
  }
  return w
}

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

const questionController = createTelegramQuestionController({
  api: bot.api,
  isAllowedUser: (userId) => isAllowedUser('telegram', userId),
  getSessionId: (chatId) => sessionStore.get(chatId)?.sessionId ?? null,
  submitAnswers: submitQuestionAnswers,
  deny: (chatId, requestId) => {
    if (!pendingQuestions.get(chatId)?.has(requestId)) return false
    const sent = bridge.sendPermissionResponse(chatId, requestId, false)
    if (sent) resolveQuestionRequest(chatId, requestId)
    return sent
  },
  activity: (chatId, requestId) => bridge.sendQuestionActivity(chatId, requestId),
})
const isChatBusy = (chatId: string) => getRuntimeState(chatId).state !== 'idle' || Boolean(pendingPermissions.get(chatId)?.size)
const commandController = createTelegramRuntimeCommandController({
  botApi: bot.api, httpClient, defaultWorkDir, bridge, sessionStore,
  ensureExistingSession, clearTransientChatState,
  clearOtherSelections: (chatId) => { sessionSelection.clear(chatId) },
  startNewProject: async (chatId, workDir) => {
    if (isChatBusy(chatId)) return false
    const created = await createSessionForChat(chatId, workDir)
    if (created) clearTransientChatState(chatId)
    return created
  },
  isBusy: isChatBusy,
  isAllowedUser: (userId) => isAllowedUser('telegram', userId),
  handleServerMessage: (chatId, msg) => handleServerMessage(chatId, msg as ServerMessage),
  setRuntimeModel: (chatId, modelId) => { getRuntimeState(chatId).model = modelId },
  setRuntimeBusy: (chatId) => { getRuntimeState(chatId).state = 'thinking' },
  cancelPendingInput: (chatId) => { invalidateChatInputs(chatId) },
})
const sessionSelection = new SessionSelectionController({
  httpClient, bridge, sessionStore,
  sendNotice: async (chatId, text) => { await bot.api.sendMessage(Number(chatId), text) },
  presentSelection: async (chatId, view) => {
    const rendered = buildTelegramHistoryView(view)
    await bot.api.sendMessage(Number(chatId), rendered.text, { reply_markup: rendered.reply_markup })
  },
  onServerMessage: handleServerMessage,
  clearTransientState: clearTransientChatState,
  beforeSessionSwitch: invalidateChatInputs,
  clearProjectSelection: (chatId) => { commandController.clearPendingSelections(chatId) },
  isBusy: isChatBusy,
})

// ---------- helpers ----------

function getRuntimeState(chatId: string): ChatRuntimeState {
  let state = runtimeStates.get(chatId)
  if (!state) {
    state = { state: 'idle', pendingPermissionCount: 0 }
    runtimeStates.set(chatId, state)
  }
  return state
}

function clearTransientChatState(chatId: string): void {
  streamDelivery.clear(chatId)
  accumulatedThinkingText.delete(chatId)
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
  pendingPermissions.delete(chatId)
  pendingQuestions.delete(chatId)
  questionController.clear(chatId)
  tgImageWatchers.delete(chatId)
}

/** Drop a single answered/expired question and prune an emptied chat entry. */
function deletePendingQuestion(chatId: string, requestId: string): void {
  questionController.remove(chatId, requestId)
  const questions = pendingQuestions.get(chatId)
  if (!questions) return
  questions.delete(requestId)
  if (questions.size === 0) pendingQuestions.delete(chatId)
}

/** Keep only questions the server still reports as pending (snapshot reconcile). */
function prunePendingQuestions(chatId: string, keep: Set<string>): void {
  questionController.prune(chatId, keep)
  const questions = pendingQuestions.get(chatId)
  if (!questions) return
  for (const requestId of questions.keys()) {
    if (!keep.has(requestId)) questions.delete(requestId)
  }
  if (questions.size === 0) pendingQuestions.delete(chatId)
}

async function handlePermissionDecision(chatId: string, decision: PermissionDecision): Promise<void> {
  const pending = pendingPermissions.get(chatId)
  if (!pending?.has(decision.requestId)) {
    await bot.api.sendMessage(Number(chatId), `未找到待确认的权限请求：${decision.requestId}`)
    return
  }

  const sent = bridge.sendPermissionResponse(chatId, decision.requestId, decision.allowed, decision.rule)
  if (sent) {
    pending.delete(decision.requestId)
    if (pending.size === 0) pendingPermissions.delete(chatId)
    const runtime = getRuntimeState(chatId)
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    deletePendingQuestion(chatId, decision.requestId)
  }
  await bot.api.sendMessage(
    Number(chatId),
    sent ? `${formatPermissionDecisionStatus(decision)}。` : '权限响应发送失败，请检查会话状态。',
  )
}

/** Update transport state after a successful response; the controller owns UI disposal. */
function resolveQuestionRequest(chatId: string, requestId: string): void {
  const questions = pendingQuestions.get(chatId)
  questions?.delete(requestId)
  if (questions?.size === 0) pendingQuestions.delete(chatId)
  const pending = pendingPermissions.get(chatId)
  pending?.delete(requestId)
  if (pending?.size === 0) pendingPermissions.delete(chatId)
  getRuntimeState(chatId).pendingPermissionCount = pendingPermissions.get(chatId)?.size ?? 0
}

function submitQuestionAnswers(chatId: string, requestId: string, answers: Record<string, string>): boolean {
  const input = pendingQuestions.get(chatId)?.get(requestId)
  if (!input || typeof input !== 'object' || Array.isArray(input) || !pendingPermissions.get(chatId)?.has(requestId)) return false
  const sent = bridge.sendPermissionResponse(chatId, requestId, true, undefined, { ...input, answers })
  if (sent) resolveQuestionRequest(chatId, requestId)
  return sent
}

async function ensureExistingSession(chatId: string): Promise<SessionRestoreResult> {
  return await restoreStoredSessionBinding({
    chatId,
    bridge,
    sessionStore,
    httpClient,
    onServerMessage: (msg) => handleServerMessage(chatId, msg),
    logPrefix: '[Telegram]',
    clearTransientState: () => clearTransientChatState(chatId),
  })
}

async function buildStatusText(chatId: string): Promise<string> {
  const result = await ensureExistingSession(chatId)
  if (result.status === 'unavailable') return SESSION_RECONNECT_NOTICE
  if (result.status === 'missing') return formatImStatus(null)
  const stored = result.session

  const runtime = getRuntimeState(chatId)
  let projectName = path.basename(stored.workDir) || stored.workDir
  let branch: string | null = null

  try {
    const gitInfo = await httpClient.getGitInfo(stored.sessionId)
    projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
    branch = gitInfo.branch
  } catch {
    // Ignore git lookup failures and fall back to stored workDir
  }

  let taskCounts:
    | {
        total: number
        pending: number
        inProgress: number
        completed: number
      }
    | undefined

  try {
    const tasks = await httpClient.getTasksForSession(stored.sessionId)
    if (tasks.length > 0) {
      taskCounts = {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === 'pending').length,
        inProgress: tasks.filter((task) => task.status === 'in_progress').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
      }
    }
  } catch {
    // Ignore task lookup failures in IM status summary
  }

  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
    taskCounts,
  })
}

// ---------- session management ----------

async function ensureSession(chatId: string): Promise<boolean> {
  const result = await ensureExistingSession(chatId)
  if (result.status === 'restored') return true
  if (result.status === 'unavailable') {
    await bot.api.sendMessage(Number(chatId), SESSION_RECONNECT_NOTICE)
    return false
  }

  const workDir = defaultWorkDir
  if (workDir) {
    return await createSessionForChat(chatId, workDir)
  }

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  const numericChatId = Number(chatId)
  // Deliberately no pending-input invalidation here: this is also the path a
  // message task takes to create its own session on first use, and cancelling
  // itself would drop the message it is trying to deliver. The callers that
  // really replace a binding (`/new`, session restore, stale-session recovery)
  // invalidate explicitly.
  try {
    // Always tear down any stale WS connection before creating a new session.
    // Without this, bridge.connectSession() below would short-circuit when an
    // old OPEN connection still exists, leaving messages routed to the old session.
    bridge.resetSession(chatId)

    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await bot.api.sendMessage(numericChatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await bot.api.sendMessage(numericChatId,
      `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  await commandController.showNewProjectPicker(chatId)
}

// ---------- outbound media dispatch ----------

/** Upload a PendingUpload found in streaming output and send it via
 *  bot.api.sendPhoto as an independent message. Runs fire-and-forget
 *  from the stream handler so streaming text isn't blocked. */
async function dispatchOutboundMedia(chatId: string, pending: PendingUpload): Promise<void> {
  const numericChatId = Number(chatId)
  try {
    const loaded = await sendSafeOutboundImage(pending, sessionStore.get(chatId)?.workDir, (buffer) => media.sendPhoto(numericChatId, buffer, pending.alt))
    if (!loaded.ok) console.warn('[Telegram] Outbound image rejected:', loaded.reason)
  } catch (err) {
    console.error(
      '[Telegram] dispatchOutboundMedia failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const numericChatId = Number(chatId)
  const runtime = getRuntimeState(chatId)

  // Reconcile pending questions against approvals handled in Desktop or while
  // this IM was offline, so a stale /answer cannot leak into the next turn.
  if (msg.type === 'permission_resolved' && typeof msg.requestId === 'string') {
    deletePendingQuestion(chatId, msg.requestId)
  } else if (msg.type === 'permission_requests_snapshot' && Array.isArray(msg.toolRequestIds)) {
    prunePendingQuestions(chatId, new Set<string>(msg.toolRequestIds.filter(
      (id: unknown): id is string => typeof id === 'string' && id.length > 0,
    )))
  }

  if (syncImPermissionState(chatId, msg, runtime, pendingPermissions)) return
  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      if (msg.state === 'thinking' && !streamDelivery.hasState(chatId)) {
        await streamDelivery.ensurePlaceholder(chatId, '💭 思考中...')
        accumulatedThinkingText.set(chatId, '')
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        accumulatedThinkingText.delete(chatId)
        await streamDelivery.handleEvent(chatId, { type: 'content_start', blockType: msg.blockType })
      } else if (msg.blockType === 'tool_use') {
        // Finalize current text placeholder before tool calls,
        // so text after tools gets a fresh message
        await streamDelivery.complete(chatId)
      }
      break

    case 'content_delta':
      if (msg.text) {
        accumulatedThinkingText.delete(chatId)
        await streamDelivery.handleEvent(chatId, { type: 'content_delta', text: msg.text })
        const newUploads = getTgWatcher(chatId).feed(msg.text)
        for (const pending of newUploads) {
          void dispatchOutboundMedia(chatId, pending)
        }
      }
      break

    case 'thinking':
      if (streamDelivery.getPlaceholderMessageId(chatId) !== undefined) {
        const update = buildTelegramThinkingUpdate(
          accumulatedThinkingText.get(chatId) ?? '',
          msg.text,
        )
        accumulatedThinkingText.set(chatId, update.fullText)
        try {
          await bot.api.editMessageText(
            numericChatId,
            streamDelivery.getPlaceholderMessageId(chatId)!,
            update.messageText,
          )
        } catch { /* ignore */ }
      }
      break

    case 'tool_use_complete':
      // Tool details are noise for IM users; visible in Desktop if needed.
      break

    case 'tool_result':
      // Tool errors are handled internally by the AI (retries etc.)
      // No need to notify the user for every failed attempt.
      break

    case 'permission_request': {
      const pending = pendingPermissions.get(chatId) ?? new Set<string>()
      if (!pending.has(msg.requestId)) {
        pending.add(msg.requestId)
        pendingPermissions.set(chatId, pending)
      }
      // Derive the count from the set so a replayed request cannot double-count.
      runtime.pendingPermissionCount = pendingPermissions.get(chatId)?.size ?? 0
      runtime.state = 'permission_pending'

      if (msg.toolName === 'AskUserQuestion') {
        const questions = pendingQuestions.get(chatId) ?? new Map<string, unknown>()
        questions.set(msg.requestId, msg.input)
        pendingQuestions.set(chatId, questions)
        await questionController.receive(chatId, msg.requestId, msg.input)
        break
      }

      const text = `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n${formatPermissionInstructions(msg.requestId)}`
      const keyboard = new InlineKeyboard()
        .text('✅ 允许', `permit:${msg.requestId}:yes`)
        .text('♾️ 永久允许', `permit:${msg.requestId}:always`)
        .row()
        .text('❌ 拒绝', `permit:${msg.requestId}:no`)
      await bot.api.sendMessage(numericChatId, text, { reply_markup: keyboard })
      break
    }

    case 'message_complete':
      runtime.state = 'idle'
      runtime.verb = undefined
      // Clear both maps before awaiting delivery: otherwise an old question id
      // could still be approved without answers. The server replays any pending
      // independent worker requests after this leader-turn boundary.
      pendingQuestions.delete(chatId)
      questionController.clear(chatId)
      pendingPermissions.delete(chatId)
      runtime.pendingPermissionCount = 0
      await streamDelivery.handleEvent(chatId, { type: 'message_complete' })
      accumulatedThinkingText.delete(chatId)
      break

    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      accumulatedThinkingText.delete(chatId)
      // Auto-recover from stale thinking block signatures by creating a fresh session.
      // This happens when the API key or provider changed since the session was created.
      if (msg.message && /Invalid.*signature.*thinking/i.test(msg.message)) {
        const stored = sessionStore.get(chatId)
        const workDir = stored?.workDir || defaultWorkDir
        if (workDir) {
          await bot.api.sendMessage(numericChatId, '⚠️ 会话上下文已失效，正在自动重建...')
          invalidateChatInputs(chatId)
          clearTransientChatState(chatId)
          bridge.resetSession(chatId)
          sessionStore.delete(chatId)
          const ok = await createSessionForChat(chatId, workDir)
          if (ok) {
            await bot.api.sendMessage(numericChatId, '✅ 已重建会话，请重新发送消息。')
          } else {
            await bot.api.sendMessage(numericChatId, '❌ 重建会话失败，请发送 /new 手动新建。')
          }
        } else {
          await bot.api.sendMessage(numericChatId, '⚠️ 会话上下文已失效，请发送 /new 新建会话。')
        }
      } else {
        await bot.api.sendMessage(numericChatId, `❌ ${msg.message}`)
      }
      break

    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) {
          runtime.model = model
        }
      }
      break
  }
}

// ---------- bot handlers ----------

registerTelegramExtendedCommands(bot, commandController)
registerTelegramSessionCommands(bot, (ctx, text) => routeUserMessage(ctx as Context, text))

/** Reset session state and start a new session for chatId.
 *  If `query` is provided, match a project by index or name;
 *  otherwise use the configured/default work directory. */
async function startNewSession(chatId: string, query?: string): Promise<void> {
  const numericChatId = Number(chatId)

  // No pending-input invalidation here: a `/new` arrives through
  // `routeSessionInput`, which invalidates input received *before* the command
  // at receive time. Invalidating again from inside this task would also kill
  // input that arrived while the new session was still being created.
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  streamDelivery.clear(chatId)
  sessionSelection.clear(chatId)
  commandController.clearPendingSelections(chatId)
  pendingPermissions.delete(chatId)
  pendingQuestions.delete(chatId)
  questionController.clear(chatId)
  runtimeStates.delete(chatId)
  tgImageWatchers.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) {
          await bot.api.sendMessage(numericChatId,
            `✅ 已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} — ${p.realPath}`).join('\n')
        await bot.api.sendMessage(numericChatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await bot.api.sendMessage(numericChatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await bot.api.sendMessage(numericChatId,
        `❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const workDir = defaultWorkDir
    if (workDir) {
      const ok = await createSessionForChat(chatId, workDir)
      if (ok) {
        await bot.api.sendMessage(numericChatId, '✅ 已新建会话，可以开始对话了。')
      }
    } else {
      await showProjectPicker(chatId)
    }
  }
}

const isAuthorizedTelegramUser = (userId: number) => isAllowedUser('telegram', userId)

registerAuthorizedTelegramCommand(bot, 'stop', isAuthorizedTelegramUser, (ctx) => {
  const chatId = String(ctx.chat!.id)
  // Cancel input still queued, downloading or transcribing: /stop must not
  // wait for a long local transcription, and a cancelled transcript is never
  // sent. Runs outside the chat queue, so it is prompt.
  invalidateChatInputs(chatId)
  questionController.clear(chatId)
  void (async () => {
    const result = await ensureExistingSession(chatId)
    if (result.status !== 'restored') {
      await ctx.reply(result.status === 'unavailable' ? SESSION_RECONNECT_NOTICE : formatImStatus(null))
      return
    }
    bridge.sendStopGeneration(chatId)
    await ctx.reply('⏹ 已发送停止信号。')
  })()
})

registerAuthorizedTelegramCommand(bot, 'status', isAuthorizedTelegramUser, async (ctx) => {
  const chatId = String(ctx.chat!.id)
  await ctx.reply(await buildStatusText(chatId))
})

registerAuthorizedTelegramCommand(bot, 'clear', isAuthorizedTelegramUser, (ctx) => {
  const chatId = String(ctx.chat!.id)
  // Invalidate input that has not reached the Agent yet: a late transcript must
  // not be written into the freshly cleared context.
  invalidateChatInputs(chatId)
  questionController.clear(chatId)
  void (async () => {
    const result = await ensureExistingSession(chatId)
    if (result.status !== 'restored') {
      await ctx.reply(result.status === 'unavailable' ? SESSION_RECONNECT_NOTICE : formatImStatus(null))
      return
    }
    clearTransientChatState(chatId)
    const sent = bridge.sendUserMessage(chatId, '/clear')
    if (!sent) {
      await ctx.reply('⚠️ 无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }
    getRuntimeState(chatId).state = 'thinking'
    await ctx.reply('🧹 已清空当前会话上下文。')
  })()
})

for (const command of ['allow', 'always', 'allow-always', 'deny'] as const) {
  bot.command(command, async (ctx) => {
    await routeUserMessage(ctx, `/${command}${ctx.match ? ` ${ctx.match}` : ''}`)
  })
}

// /answer rides the same authorized, deduplicated, queued pipeline as text.
bot.command('answer', async (ctx) => {
  await routeUserMessage(ctx, `/answer${ctx.match ? ` ${ctx.match}` : ''}`)
})

/** Lazy media collector: runs after authorization and dedup, and inside the
 *  chat's serial queue, so a slow download/transcription cannot be overtaken
 *  by a later text. */
type TelegramMediaCollector = (
  signal: AbortSignal,
) => Promise<{ locals: LocalAttachment[]; rejections: string[] }>

/**
 * Session commands in flight, keyed by chat.
 *
 * Session commands run on the short control queue so a local transcription
 * cannot hold them behind it. Normal input still runs on the chat's serial
 * queue, which keeps its receive order, so it must wait for a session command
 * that was received *before* it — otherwise a `/new` and the text after it
 * could race and the text would land in the old session.
 */
const sessionCommandBarriers = new Map<string, Promise<void>>()

async function awaitSessionCommandBarrier(chatId: string): Promise<void> {
  const barrier = sessionCommandBarriers.get(chatId)
  if (!barrier) return
  await barrier.catch(() => {})
}

/**
 * Receive-time classification of session input, mirroring
 * `tryHandleTelegramSessionInput`.
 *
 * `switchesBinding` marks input that will replace the chat's session binding;
 * it invalidates everything received before it. A command that only shows
 * options leaves pending input alone, so browsing `/projects` never cancels a
 * voice that is already transcribing.
 */
type SessionInputRoute = {
  /** `command`: `/new`, `/projects`, `/resume`, `/sessions`, picker replies.
   *  `pick`: a number answering a list that is actually on screen. */
  kind: 'none' | 'command' | 'pick'
  switchesBinding: boolean
}

const NO_SESSION_INPUT: SessionInputRoute = { kind: 'none', switchesBinding: false }

/**
 * A bare number is *only* list input while a list is waiting for this chat, and
 * which list decides whether answering it replaces the binding. The pending
 * state of the owning controller is the evidence — the digits are never
 * guessed — so ordinary chat text that happens to be a number stays a chat
 * message.
 */
function classifyNumericPick(chatId: string, trimmed: string): SessionInputRoute {
  if (!/^\d+$/.test(trimmed)) return NO_SESSION_INPUT
  const telegramKind = commandController.pendingSelectionKind(chatId)
  if (telegramKind === 'new_project' || telegramKind === 'resume_session') return { kind: 'pick', switchesBinding: true }
  if (telegramKind === 'resume_project') return { kind: 'pick', switchesBinding: false }
  const sharedKind = sessionSelection.pendingKind(chatId)
  if (sharedKind === 'sessions') return { kind: 'pick', switchesBinding: true }
  if (sharedKind === 'projects') return { kind: 'pick', switchesBinding: false }
  return NO_SESSION_INPUT
}

function classifySessionInput(chatId: string, text: string, hasAttachments: boolean): SessionInputRoute {
  if (hasAttachments) return NO_SESSION_INPUT
  const trimmed = text.trim()
  if (!trimmed) return NO_SESSION_INPUT
  const command = /^\/(new|projects|sessions|resume)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (command) {
    const [, name, args] = command
    if (name === 'new') return { kind: 'command', switchesBinding: true }
    if (name === 'projects') return { kind: 'command', switchesBinding: false }
    const argument = (args ?? '').trim()
    if (!argument || argument === 'next' || argument === 'prev' || argument === 'projects') {
      return { kind: 'command', switchesBinding: false }
    }
    return { kind: 'command', switchesBinding: true }
  }
  if (trimmed === '/cancel') return { kind: 'command', switchesBinding: false }
  return classifyNumericPick(chatId, trimmed)
}

/**
 * Resolve the number of a list that is on screen. The controllers own the
 * pending state, so a reply that raced the list's expiry is reported instead of
 * disappearing into the void.
 */
async function resolveNumericPick(chatId: string, text: string, userId: number): Promise<void> {
  if (await commandController.selectPendingByNumber(chatId, Number(text.trim()), userId)) return
  await bot.api.sendMessage(
    Number(chatId),
    '选择列表不存在或已过期，请重新发送 /resume 或 /sessions。',
  )
}

/**
 * Run one session command on the short control queue.
 *
 * A command that replaces the binding invalidates the chat's pending input at
 * *receive* time, before it queues: input received earlier must not be
 * delivered, while input that arrives later — including input that arrives
 * while the switch is still creating its session — must be. Invalidating inside
 * the queued task instead would drop that later input for no reason.
 */
async function routeSessionInput(
  chatId: string,
  text: string,
  route: SessionInputRoute,
  userId: number,
): Promise<void> {
  if (route.switchesBinding) invalidateChatInputs(chatId)
  const task = enqueue(`control:${chatId}`, async () => {
    if (shuttingDown) return
    const handled = await tryHandleTelegramSessionInput(chatId, text, false, {
      startNewSession,
      showProjectPicker,
      showResumeProjectPicker: async (id) => { await sessionSelection.handleInput(id, '/sessions') },
      handleSessionInput: (id, input) => sessionSelection.handleInput(id, input),
    })
    if (handled) return
    if (route.kind === 'pick') {
      await resolveNumericPick(chatId, text, userId)
      return
    }
  })
  sessionCommandBarriers.set(chatId, task)
  try {
    await task
  } finally {
    if (sessionCommandBarriers.get(chatId) === task) sessionCommandBarriers.delete(chatId)
  }
}

/**
 * Final gate before `bridge.sendUserMessage`. Every entry is a way the send
 * could become wrong: work dropped on purpose, a `/stop`/`/clear`/`/new` or
 * switch that landed after the last check, adapter shutdown, or a binding that
 * moved away from the one this task started delivering into (`ownerAtStart`,
 * observed after any earlier session command finished).
 */
function canDeliverInput(
  chatId: string,
  input: PendingInput,
  ownerAtStart: string | null,
): boolean {
  if (shuttingDown) return false
  if (input.controller.signal.aborted) return false
  if (input.generation !== pendingInputGeneration(chatId)) return false
  const ownerNow = sessionStore.get(chatId)?.sessionId ?? null
  if (ownerNow === null) return false
  // A null baseline is the "this input creates its own session" case; anything
  // else must still be bound to the session it started delivering into.
  if (ownerAtStart !== null && ownerNow !== ownerAtStart) return false
  return true
}

/** Tell the user that local transcription is running; returns the notice id
 *  so the caller can remove it once the outcome is known. */
async function sendTranscriptionProgress(chatId: string): Promise<number | undefined> {
  try {
    const message = await bot.api.sendMessage(Number(chatId), '🎧 正在本机转写语音…')
    return message.message_id
  } catch {
    return undefined
  }
}

/** Remove the progress notice; the real outcome (echo or degrade notice) is
 *  what the user should be left with. */
async function clearTranscriptionProgress(chatId: string, messageId?: number): Promise<void> {
  if (messageId === undefined) return
  await bot.api.deleteMessage(Number(chatId), messageId).catch(() => {})
}

/** Shared per-user-message pipeline: dedup, pairing check, capacity admission,
 *  session-command routing, per-chat queueing, media collection, transcription,
 *  ensureSession, sendUserMessage and transcript echo. */
async function routeUserMessage(
  ctx: Context,
  text: string,
  media?: TelegramMediaCollector,
): Promise<void> {
  if (!ctx.from || ctx.chat?.type !== 'private') return
  const chatId = String(ctx.chat.id)
  if (!shouldProcessTelegramMessage(dedup, chatId, ctx.message?.message_id)) return

  const userId = ctx.from.id

  if (!isAllowedUser('telegram', userId)) {
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    const success = tryPair(text.trim(), { userId, displayName }, 'telegram')
    if (success) {
      await ctx.reply('✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
    } else {
      await ctx.reply('🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
    }
    return
  }
  if (shuttingDown) return

  // Media is only *collected* after the private-chat/authorization/dedup gates
  // above: an unauthorized sender's bytes never reach the local stage dir.
  const hasAttachments = media !== undefined

  // Permission replies and AskUserQuestion answers are short operations that
  // must not wait behind a long voice transcription (docs §"顺序、控制命令与
  // 会话归属"). They ride the per-chat control queue.
  const replyToMessageId = ctx.message?.reply_to_message?.message_id
  if (isPermissionReply(text, hasAttachments, chatId, replyToMessageId)) {
    await enqueue(`control:${chatId}`, () => handlePermissionReply(chatId, text, userId, replyToMessageId))
    return
  }

  // Session commands are short and binding-scoped: same short control queue,
  // and a command that replaces the binding invalidates older input first.
  const sessionInput = classifySessionInput(chatId, text, hasAttachments)
  if (sessionInput.kind !== 'none') {
    await routeSessionInput(chatId, text, sessionInput, userId)
    return
  }

  // Admission control, counted from receive time: input waiting for its queue
  // slot already holds staged bytes and a queue slot.
  if (countPendingInputs(chatId) >= MAX_PENDING_INPUTS_PER_CHAT) {
    await bot.api.sendMessage(
      Number(chatId),
      `⚠️ 待处理消息过多（本次上限 ${MAX_PENDING_INPUTS_PER_CHAT} 条），请等待当前任务完成后再发送。`,
    ).catch(() => {})
    return
  }

  // Registered *before* the queue slot: `/stop`, `/clear`, `/new`, a session
  // switch or shutdown must cancel input that is queued but not yet started.
  const input = registerChatInput(chatId)

  await enqueue(chatId, async () => {
    let ticket: LimiterTicket | undefined
    let progressMessageId: number | undefined
    try {
      if (!canStartInput(chatId, input)) return
      // Deliver in receive order relative to session commands: a switch that
      // was received earlier must have landed before this message is sent.
      await awaitSessionCommandBarrier(chatId)
      if (!canStartInput(chatId, input)) return
      // The binding this input delivers into, observed *after* any session
      // command received earlier finished: a message that arrives while a
      // `/new` is still creating its session is a message for that new session,
      // so the binding is not captured at receive time.
      const ownerAtStart = sessionStore.get(chatId)?.sessionId ?? null

      if (await tryHandleTelegramSessionInput(chatId, text, hasAttachments, {
        startNewSession,
        showProjectPicker,
        showResumeProjectPicker: async (id) => { await sessionSelection.handleInput(id, '/sessions') },
        handleSessionInput: (id, inputText) => sessionSelection.handleInput(id, inputText),
      })) return

      let locals: LocalAttachment[] = []
      if (media) {
        const collected = await media(input.controller.signal)
        if (input.controller.signal.aborted) return
        for (const rejection of collected.rejections) {
          await ctx.reply(rejection).catch(() => {})
        }
        locals = collected.locals
        // A media message with no surviving attachment and no caption is a no-op.
        if (locals.length === 0 && !text.trim()) return
      }

      // Local transcription is globally concurrency-limited; over capacity is
      // an explicit refusal that still delivers the voice as a file.
      const hasVoice = locals.some((local) => local.mediaKind === 'voice')
      let pipelineLocals = locals
      if (hasVoice && isTelegramTranscriptionEnabled()) {
        progressMessageId = await sendTranscriptionProgress(chatId)
      }
      if (hasVoice && isTelegramTranscriptionEnabled()) {
        const acquired = await transcriptionLimiter.acquire(input.controller.signal)
        // Own the granted ticket before checking cancellation: abort can land
        // while acquire resolves, and the outer finally must release that slot.
        if (typeof acquired === 'object') ticket = acquired
        if (acquired === 'cancelled' || input.controller.signal.aborted) return
        if (acquired === 'over_capacity') {
          await bot.api.sendMessage(
            Number(chatId),
            '🎧 语音转写队列已满，本语音将作为文件转交，请稍后再试。',
          )
          // Deliver the voice as a plain file rather than holding its bytes.
          pipelineLocals = locals.map((local) =>
            local.mediaKind === 'voice' ? { ...local, mediaKind: undefined } : local)
        } else {
          ticket = acquired
        }
      }

      let enriched: EnrichedMessage
      try {
        enriched = await assembleTelegramMessage(pipelineLocals, text, input.controller.signal)
      } finally {
        // Release the global transcription slot as soon as transcription is
        // finished (or failed): restoring a session and echoing the result
        // back must not occupy a slot other chats are waiting for.
        ticket?.release()
        ticket = undefined
      }
      if (enriched.cancelled || input.controller.signal.aborted) return

      const ready = await ensureSession(chatId)
      if (!ready) return
      // `ensureSession` awaited across a window in which /stop, /clear, /new, a
      // session switch or shutdown could land; re-validate before announcing
      // anything about this input.
      if (!canDeliverInput(chatId, input, ownerAtStart)) return

      // What happened to the voice, but not the handover claim: the
      // `bridge.sendUserMessage` below is what actually hands the file over, so
      // 「已作为文件转交」 is only asserted after that send succeeded — and never
      // when this input was cancelled instead.
      const { degrade, claims } = splitTelegramNotices(enriched.notices)
      for (const notice of degrade) {
        await ctx.reply(notice).catch(() => {})
      }

      const { content, attachments: refs } = planTelegramOutbound(enriched)
      if (!content && !refs) return
      // Re-check authorization before the send.
      if (!isAllowedUser('telegram', userId)) {
        await bot.api.sendMessage(Number(chatId), '🔒 当前账号已不再被授权，消息未发送。').catch(() => {})
        return
      }
      // Last gate before the send: the notice replies above awaited, so /stop,
      // /clear, /new, a session switch or shutdown may have landed in between.
      // Authorization alone cannot see any of those, so the abort flag,
      // generation and binding are re-checked here with no await in between.
      if (!canDeliverInput(chatId, input, ownerAtStart)) return

      const sent = bridge.sendUserMessage(chatId, content, refs)
      if (!sent) {
        await bot.api.sendMessage(Number(chatId), '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
        return
      }
      getRuntimeState(chatId).state = 'thinking'
      // The file rode this message: only now is the handover claim true.
      for (const claim of claims) {
        await ctx.reply(claim).catch(() => {})
      }
      // Echo the exact outbound content as plain text after a successful send
      // so a mistranscription is visible. Replaces the filename-only receipt.
      if (enriched.transcripts.length > 0) {
        await echoPlainText(chatId, content)
      }
    } finally {
      ticket?.release()
      // Shutdown awaits the completion signal below, and that must represent
      // the provider cleanup (already finished by now), never a best-effort
      // Telegram delete that may be uncancellable. Skipping the progress
      // cleanup during shutdown keeps stopTelegramAdapter() from hanging on a
      // notification round-trip while the process is trying to exit.
      if (!shuttingDown) await clearTranscriptionProgress(chatId, progressMessageId)
      releaseChatInput(chatId, input)
    }
  })
}

/** A queued input that has already been invalidated must not run at all. */
function canStartInput(chatId: string, input: PendingInput): boolean {
  if (shuttingDown) return false
  if (input.controller.signal.aborted) return false
  if (input.generation !== pendingInputGeneration(chatId)) return false
  return true
}

/** Echo content verbatim as plain text (no parse_mode) so a transcript cannot
 *  trigger Telegram Markdown/HTML formatting, chunked for the message limit. */
async function echoPlainText(chatId: string, content: string): Promise<void> {
  if (!content.trim()) return
  const numericChatId = Number(chatId)
  for (const chunk of splitMessage(content, TELEGRAM_TEXT_LIMIT)) {
    await bot.api.sendMessage(numericChatId, chunk).catch(() => {})
  }
}

/** True when the text is a permission reply or an AskUserQuestion answer, i.e.
 *  a short control operation that must bypass the transcription-blocked queue.
 *  Captions on media messages are never treated as permission input. */
function hasOtherQuestionInteraction(chatId: string): boolean {
  return Boolean(sessionSelection.pendingKind(chatId) || commandController.pendingSelectionKind(chatId))
    || [...(pendingPermissions.get(chatId) ?? [])].some((id) => !pendingQuestions.get(chatId)?.has(id))
}

function isPermissionReply(text: string, hasAttachments: boolean, chatId: string, replyToMessageId?: number): boolean {
  if (hasAttachments) return false
  if (questionController.shouldHandleText({ chatId, text, replyToMessageId, hasOtherSelection: hasOtherQuestionInteraction(chatId) })) return true
  return parsePermissionCommand(text, pendingPermissions.get(chatId)) !== null
}

async function handlePermissionReply(chatId: string, text: string, userId: number, replyToMessageId?: number): Promise<void> {
  if (await questionController.handleText({
    chatId, text, userId, replyToMessageId, hasOtherSelection: hasOtherQuestionInteraction(chatId),
  })) return

  const permissionDecision = parsePermissionCommand(text, pendingPermissions.get(chatId))
  if (!permissionDecision) return
  // Question answers never use the ordinary tool approval shortcut.
  if (pendingQuestions.get(chatId)?.has(permissionDecision.requestId) &&
    (permissionDecision.allowed || !text.trim().startsWith('/'))) {
    await bot.api.sendMessage(Number(chatId), '该请求需要回答，请点选问题选项或回复问题消息；不能直接允许。')
    return
  }
  await handlePermissionDecision(chatId, permissionDecision)
}

/** Materialize ctx.message media into staged LocalAttachments (download +
 *  size/mime gates). Ref assembly — and voice transcription — is owned by the
 *  shared pipeline from here on. `signal` cancels an in-flight download. */
async function collectAttachmentsFromCtx(
  ctx: Context,
  signal?: AbortSignal,
): Promise<{ locals: LocalAttachment[]; rejections: string[] }> {
  if (!ctx.message || !ctx.chat) return { locals: [], rejections: [] }
  const sessionId = sessionStore.get(String(ctx.chat.id))?.sessionId ?? String(ctx.chat.id)
  const download: TelegramFileDownloader = (fileId, hint, limits) =>
    media.downloadFile(fileId, sessionId, hint, limits)
  return collectTelegramLocalAttachments(ctx.message, { download, signal })
}

bot.on('message:text', async (ctx) => {
  await routeUserMessage(ctx, ctx.message.text)
})

bot.on(
  ['message:photo', 'message:document', 'message:video', 'message:audio', 'message:voice'],
  async (ctx) => {
    const caption = ctx.message.caption ?? ''
    // Downloads run lazily inside routeUserMessage, after the authorization and
    // dedup gates and in the chat's serial queue.
    await routeUserMessage(ctx, caption, (signal) => collectAttachmentsFromCtx(ctx, signal))
  },
)

bot.on('callback_query:data', async (ctx) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return
  if (!dedup.tryRecord(`telegram:callback:${ctx.callbackQuery.id}`)) return
  const data = ctx.callbackQuery.data
  const chatId = String(ctx.chat.id)
  // Menu and permission callbacks both ride the short control queue: neither
  // may wait behind a local transcription. Landing a session switch also
  // invalidates the binding's pending input inside the selection handler, so a
  // transcript still in flight cannot be delivered into the session the user
  // just left.
  await enqueue(`control:${chatId}`, async () => {
    if (!isAllowedUser('telegram', ctx.from!.id)) {
      await ctx.answerCallbackQuery('未授权').catch(() => {})
      return
    }
    if (await questionController.handleCallback(ctx, data)) return
    const history = parseTelegramHistoryCallback(data)
    if (history) {
      await ctx.answerCallbackQuery().catch(() => {})
      await sessionSelection.handleSelectionAction(chatId, history.token, history.action, history.index)
      return
    }
    if (await tryHandleTelegramSelectionCallback(data, ctx, commandController)) return

    if (!data.startsWith('permit:')) return

    const decision = parsePermitCallbackData(data)
    if (!decision) return
    const questionInputs = pendingQuestions.get(chatId)
    const result = await commandController.handlePermissionCallback(
      ctx,
      decision,
      pendingPermissions,
      (id) => {
        const runtime = getRuntimeState(id)
        runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
      },
      questionInputs ? new Set(questionInputs.keys()) : undefined,
    )
    if (result === 'sent' && questionInputs) {
      questionInputs.delete(decision.requestId)
      if (questionInputs.size === 0) pendingQuestions.delete(chatId)
    }
  })
})

// ---------- start ----------

export async function stopTelegramAdapter(): Promise<void> {
  // Shutdown: refuse every later send, cancel pending downloads and
  // transcriptions (queued or active) and drain the wait queue so no child
  // process survives and no late message is sent.
  shuttingDown = true
  invalidateAllChatInputs()
  // Snapshot every input still in flight. Each completion settles once its
  // task has finished, which for an aborted transcription is after the
  // provider has killed its (detached) child process and removed its temp
  // files. Awaiting them is what keeps process.exit() from cutting that
  // cleanup short.
  const inFlight = [...pendingInputs.values()]
    .flatMap((inputs) => inputs.map((input) => input.completion))
  if (bot.isRunning()) void bot.stop()
  bridge.destroy()
  dedup.destroy()
  await Promise.all(inFlight)
}

export function startTelegramAdapter(): void {
  shuttingDown = false
  console.log('[Telegram] Starting bot...')
  console.log(`[Telegram] Server: ${config.serverUrl}`)
  console.log(`[Telegram] Allowed users: ${config.telegram.allowedUsers.length === 0 ? 'paired users only' : config.telegram.allowedUsers.join(', ')}`)
  void attachmentStore.gc().catch((err) => {
    console.warn('[Telegram] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
  })
  void syncTelegramBotCommands(bot.api).then(() => console.log('[Telegram] Command menu synced')).catch((err) => console.warn('[Telegram] Command menu sync failed:', err instanceof Error ? err.message : err))
  void bot.start({ onStart: () => console.log('[Telegram] Bot is running!') })
  // SIGTERM is what the desktop host sends first (with a graceful window) when
  // it stops the sidecar, so both signals must run the same asynchronous
  // shutdown and only exit once provider cleanup has finished.
  const shutdown = (): void => {
    console.log('[Telegram] Shutting down...')
    void stopTelegramAdapter().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// Desktop's shared sidecar imports this module with its explicit adapter flag.
if (import.meta.main || process.argv.includes('--telegram')) startTelegramAdapter()
