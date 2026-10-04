import { randomBytes } from 'node:crypto'
import { formatImHelp } from '../common/format.js'
import { listProjectSessionHistory, restoreSelectedSession } from '../common/session-selection.js'
import { SESSION_RECONNECT_NOTICE, type SessionRestoreResult } from '../common/session-recovery.js'
import type { SessionEntry } from '../common/session-store.js'
import type { ServerMessage } from '../common/ws-bridge.js'
import {
  formatPermissionDecisionStatus,
  type PermissionDecision,
} from '../common/permission.js'
import type {
  AdapterHttpClient,
  ProviderSummary,
  SessionListItem,
  SkillSummary,
} from '../common/http-client.js'
import {
  buildTelegramSelectionPage,
  parseTelegramSelectionCallback,
  type TelegramSelectionCallback,
  type TelegramSelectionItem,
  type TelegramSelectionKind,
} from './menu.js'

export const TELEGRAM_SELECTION_TTL_MS = 15 * 60 * 1000
export const OFFICIAL_PROVIDER_VALUE = 'official'
export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-8'
export const OPENAI_OFFICIAL_DEFAULT_MODEL_ID = 'gpt-5.3-codex'

/**
 * Picker kinds whose numbered rows are also accepted as a numeric *text*
 * reply. Only the session-restore lists: switching provider/model/skill with a
 * stray digit would be a silent, unrelated side effect of typing a number.
 */
export const TELEGRAM_NUMERIC_PICK_KINDS: TelegramSelectionKind[] = [
  'resume_project',
  'resume_session',
  'new_project',
]

type TelegramSendApi = {
  sendMessage: (chatId: number, text: string, options?: TelegramSendOptions) => Promise<unknown>
}

type TelegramSendOptions = {
  reply_markup?: TelegramInlineKeyboardMarkup
}

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export type TelegramCommandContext = {
  chat?: { id: string | number; type?: string }
  from?: { id: number }
  match?: string | RegExpMatchArray
  callbackQuery?: {
    message?: {
      chat: { id: string | number }
      text?: string
    }
  }
  reply: (text: string) => Promise<unknown>
  editMessageText: (text: string, options?: TelegramSendOptions) => Promise<unknown>
  answerCallbackQuery: (text?: string) => Promise<unknown>
}

type PendingTelegramSelection = {
  kind: TelegramSelectionKind
  title: string
  items: TelegramSelectionItem[]
  page: number
  token: string
  expiresAt: number
}

type NewSelection = Omit<PendingTelegramSelection, 'expiresAt' | 'token'>

type RuntimeModelSetter = (chatId: string, modelId: string) => void

export type TelegramCommandControllerDeps = {
  api: TelegramSendApi
  httpClient: AdapterHttpClient
  defaultWorkDir: string
  isAllowedUser: (userId: number) => boolean
  ensureExistingSession: (chatId: string) => Promise<SessionRestoreResult>
  clearTransientChatState: (chatId: string) => void
  clearOtherSelections: (chatId: string) => void
  isBusy: (chatId: string) => boolean
  getStoredSession: (chatId: string) => SessionEntry | null
  setStoredSession: (chatId: string, sessionId: string, workDir: string) => void
  deleteStoredSession: (chatId: string) => void
  resetBridgeSession: (chatId: string) => void
  connectBridgeSession: (chatId: string, sessionId: string) => boolean
  onBridgeServerMessage: (chatId: string, handler: (msg: ServerMessage) => void | Promise<void>) => void
  handleServerMessage: (chatId: string, msg: ServerMessage) => void | Promise<void>
  waitForBridgeOpen: (chatId: string) => Promise<boolean>
  sendUserMessage: (chatId: string, content: string) => boolean
  setRuntimeModel: RuntimeModelSetter
  /** Cancel inbound work still in flight for this chat (voice download or
   *  transcription). Called before a session switch so a late transcript
   *  cannot land in the newly selected session. */
  cancelPendingInput?: (chatId: string) => void
  startNewProject?: (chatId: string, path: string) => Promise<boolean | void>
}

export type TelegramCommandController = ReturnType<typeof createTelegramCommandController>
export type TelegramRuntimeCommandController = TelegramCommandController & {
  handlePermissionCallback: (
    ctx: TelegramCommandContext,
    decision: PermissionDecision,
    pendingPermissions: Map<string, Set<string>>,
    onResolved: (chatId: string) => void,
    pendingQuestionRequestIds?: Set<string>,
  ) => Promise<TelegramPermissionCallbackResult>
}
export type TelegramPermissionCallbackResult =
  | 'sent'
  | 'unauthorized'
  | 'not_pending'
  | 'send_failed'
  | 'question_answer_required'

export function telegramMessageDedupKey(chatId: string, messageId: number): string {
  return `telegram:${chatId}:${messageId}`
}

export function shouldProcessTelegramMessage(
  dedup: { tryRecord: (key: string) => boolean },
  chatId: string,
  messageId: number | undefined,
): boolean {
  return messageId !== undefined &&
    dedup.tryRecord(telegramMessageDedupKey(chatId, messageId))
}

export type TelegramCommandRegistrar = {
  command: (command: string, handler: (ctx: TelegramCommandContext) => unknown) => unknown
}

export async function ensureAuthorizedTelegramPrivateChat(
  ctx: TelegramCommandContext,
  isAllowedUser: (userId: number) => boolean,
): Promise<boolean> {
  if (!ctx.from || ctx.chat?.type !== 'private') return false
  if (isAllowedUser(ctx.from.id)) return true
  await ctx.reply('🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
  return false
}

export function registerAuthorizedTelegramCommand(
  bot: TelegramCommandRegistrar,
  command: string,
  isAllowedUser: (userId: number) => boolean,
  handler: (ctx: TelegramCommandContext) => unknown | Promise<unknown>,
): void {
  bot.command(command, (ctx) => void (async () => {
    if (!await ensureAuthorizedTelegramPrivateChat(ctx, isAllowedUser)) return
    await handler(ctx)
  })())
}

export function resolveTelegramPermissionCallback(params: {
  chatId: string
  userId: number
  decision: PermissionDecision
  pendingRequestIds?: Set<string>
  pendingQuestionRequestIds?: Set<string>
  isAllowedUser: (userId: number) => boolean
  sendPermissionResponse: (
    chatId: string,
    requestId: string,
    allowed: boolean,
    rule?: string,
  ) => boolean
}): TelegramPermissionCallbackResult {
  if (!params.isAllowedUser(params.userId)) return 'unauthorized'
  if (!params.pendingRequestIds?.has(params.decision.requestId)) return 'not_pending'
  // AskUserQuestion approvals must carry collected answers through /answer;
  // a bare allow button would submit an empty answer. Deny stays available.
  if (params.decision.allowed && params.pendingQuestionRequestIds?.has(params.decision.requestId)) {
    return 'question_answer_required'
  }

  const sent = params.sendPermissionResponse(
    params.chatId,
    params.decision.requestId,
    params.decision.allowed,
    params.decision.rule,
  )
  if (!sent) return 'send_failed'

  params.pendingRequestIds.delete(params.decision.requestId)
  return 'sent'
}

async function handleTelegramPermissionCallback(
  ctx: TelegramCommandContext,
  decision: PermissionDecision,
  deps: Pick<TelegramRuntimeCommandControllerDeps, 'isAllowedUser'> & {
    pendingPermissions: Map<string, Set<string>>
    pendingQuestionRequestIds?: Set<string>
    sendPermissionResponse: (
      chatId: string,
      requestId: string,
      allowed: boolean,
      rule?: string,
    ) => boolean
    onResolved: (chatId: string) => void
  },
): Promise<TelegramPermissionCallbackResult> {
  const callbackChatId = ctx.callbackQuery?.message?.chat.id
  const callbackUserId = ctx.from?.id
  if (callbackChatId === undefined || callbackUserId === undefined) {
    await ctx.answerCallbackQuery('未授权').catch(() => {})
    return 'unauthorized'
  }

  const chatId = String(callbackChatId)
  const result = resolveTelegramPermissionCallback({
    chatId,
    userId: callbackUserId,
    decision,
    pendingRequestIds: deps.pendingPermissions.get(chatId),
    pendingQuestionRequestIds: deps.pendingQuestionRequestIds,
    isAllowedUser: deps.isAllowedUser,
    sendPermissionResponse: deps.sendPermissionResponse,
  })
  if (result !== 'sent') {
    const message = result === 'unauthorized'
      ? '未授权'
      : result === 'not_pending'
        ? '权限请求已失效'
        : result === 'question_answer_required'
          ? '请使用 /answer 提交答案'
          : '权限响应发送失败'
    await ctx.answerCallbackQuery(message).catch(() => {})
    return result
  }

  deps.onResolved(chatId)
  const statusText = formatPermissionDecisionStatus(decision)
  await ctx.editMessageText(
    `${ctx.callbackQuery?.message?.text ?? ''}\n\n${statusText}`,
  ).catch(() => {})
  await ctx.answerCallbackQuery(statusText)
  return 'sent'
}

export type TelegramRuntimeCommandControllerDeps = {
  botApi: TelegramSendApi
  httpClient: AdapterHttpClient
  defaultWorkDir: string
  bridge: {
    resetSession: (chatId: string) => void
    connectSession: (chatId: string, sessionId: string) => boolean
    onServerMessage: (chatId: string, handler: (msg: unknown) => void | Promise<void>) => void
    waitForOpen: (chatId: string) => Promise<boolean>
    sendUserMessage: (chatId: string, content: string) => boolean
    sendPermissionResponse: (
      chatId: string,
      requestId: string,
      allowed: boolean,
      rule?: string,
    ) => boolean
  }
  sessionStore: {
    get: (chatId: string) => SessionEntry | null
    set: (chatId: string, sessionId: string, workDir: string) => void
    delete: (chatId: string) => void
  }
  isAllowedUser: (userId: number) => boolean
  ensureExistingSession: (chatId: string) => Promise<SessionRestoreResult>
  clearTransientChatState: (chatId: string) => void
  clearOtherSelections: (chatId: string) => void
  isBusy: (chatId: string) => boolean
  handleServerMessage: (chatId: string, msg: unknown) => void | Promise<void>
  setRuntimeModel: (chatId: string, modelId: string) => void
  setRuntimeBusy: (chatId: string) => void
  /** Abort a chat's in-flight inbound work before a session switch. */
  cancelPendingInput?: (chatId: string) => void
  startNewProject?: (chatId: string, path: string) => Promise<boolean | void>
}

export function createTelegramRuntimeCommandController(
  deps: TelegramRuntimeCommandControllerDeps,
): TelegramRuntimeCommandController {
  const controller = createTelegramCommandController({
    api: deps.botApi,
    httpClient: deps.httpClient,
    defaultWorkDir: deps.defaultWorkDir,
    isAllowedUser: deps.isAllowedUser,
    ensureExistingSession: deps.ensureExistingSession,
    clearTransientChatState: deps.clearTransientChatState,
    clearOtherSelections: deps.clearOtherSelections,
    isBusy: deps.isBusy,
    getStoredSession: (chatId) => deps.sessionStore.get(chatId),
    setStoredSession: (chatId, sessionId, workDir) => deps.sessionStore.set(chatId, sessionId, workDir),
    deleteStoredSession: (chatId) => deps.sessionStore.delete(chatId),
    resetBridgeSession: (chatId) => deps.bridge.resetSession(chatId),
    connectBridgeSession: (chatId, sessionId) => deps.bridge.connectSession(chatId, sessionId),
    onBridgeServerMessage: (chatId, handler) => deps.bridge.onServerMessage(
      chatId,
      (msg) => handler(msg as ServerMessage),
    ),
    handleServerMessage: deps.handleServerMessage,
    waitForBridgeOpen: (chatId) => deps.bridge.waitForOpen(chatId),
    cancelPendingInput: deps.cancelPendingInput,
    startNewProject: deps.startNewProject,
    sendUserMessage: (chatId, content) => {
      const sent = deps.bridge.sendUserMessage(chatId, content)
      if (sent) deps.setRuntimeBusy(chatId)
      return sent
    },
    setRuntimeModel: deps.setRuntimeModel,
  })
  return {
    ...controller,
    handlePermissionCallback: (ctx, decision, pendingPermissions, onResolved, pendingQuestionRequestIds) => handleTelegramPermissionCallback(
      ctx,
      decision,
      {
        isAllowedUser: deps.isAllowedUser,
        pendingPermissions,
        pendingQuestionRequestIds,
        sendPermissionResponse: (chatId, requestId, allowed, rule) =>
          deps.bridge.sendPermissionResponse(chatId, requestId, allowed, rule),
        onResolved,
      },
    ),
  }
}

export function registerTelegramExtendedCommands(
  bot: TelegramCommandRegistrar,
  controller: TelegramCommandController,
): void {
  bot.command('start', (ctx) => void controller.sendHelp(ctx))
  bot.command('help', (ctx) => void controller.sendHelp(ctx))
  bot.command('provider', (ctx) => void controller.handleProviderCommand(ctx))
  bot.command('model', (ctx) => void controller.handleModelCommand(ctx))
  bot.command('skills', (ctx) => void controller.handleSkillsCommand(ctx))
}

/** Session commands use the same authorization, deduplication and queue as messages. */
export function registerTelegramSessionCommands(
  bot: TelegramCommandRegistrar,
  routeInput: (ctx: TelegramCommandContext, text: string) => Promise<void>,
): void {
  for (const command of ['new', 'projects', 'sessions', 'resume']) {
    bot.command(command, (ctx) => {
      const query = getCommandMatchText(ctx)
      return routeInput(ctx, `/${command}${query ? ` ${query}` : ''}`)
    })
  }
}

export async function tryHandleTelegramSessionInput(
  chatId: string,
  text: string,
  hasAttachments: boolean,
  deps: {
    startNewSession: (chatId: string, query?: string) => Promise<void>
    showProjectPicker: (chatId: string) => Promise<void>
    showResumeProjectPicker: (chatId: string) => Promise<void>
    handleSessionInput: (chatId: string, text: string) => Promise<boolean>
    showSessions?: (chatId: string) => Promise<void>
  },
): Promise<boolean> {
  if (hasAttachments) return false
  const trimmed = text.trim()
  const newCommand = /^\/new(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (newCommand) {
    await deps.startNewSession(chatId, newCommand[1])
    return true
  }
  if (trimmed === '/projects') {
    await deps.showProjectPicker(chatId)
    return true
  }
  if (trimmed === '/resume') {
    await deps.showResumeProjectPicker(chatId)
    return true
  }
  if (trimmed === '/sessions' && deps.showSessions) {
    await deps.showSessions(chatId)
    return true
  }
  return await deps.handleSessionInput(chatId, text)
}

export async function tryHandleTelegramSelectionCallback(
  data: string,
  ctx: TelegramCommandContext,
  controller: TelegramCommandController,
): Promise<boolean> {
  const callback = parseTelegramSelectionCallback(data)
  if (!callback) return false
  await controller.handleSelectionCallback(ctx, callback)
  return true
}

export function createTelegramCommandController(deps: TelegramCommandControllerDeps) {
  const pendingSelections = new Map<string, PendingTelegramSelection>()

  const sendSelection = async (chatId: string, selection: NewSelection): Promise<void> => {
    const next = setPendingSelection(pendingSelections, chatId, selection)
    const view = renderSelectionView(next)
    await deps.api.sendMessage(Number(chatId), view.text, { reply_markup: view.replyMarkup })
  }

  const editSelection = async (ctx: TelegramCommandContext, selection: NewSelection): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    const next = setPendingSelection(pendingSelections, chatId, selection)
    const view = renderSelectionView(next)
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
    } catch {
      await deps.api.sendMessage(Number(chatId), view.text, { reply_markup: view.replyMarkup })
    }
  }

  const showProviderPicker = async (chatId: string): Promise<void> => {
    try {
      const { providers, activeId } = await deps.httpClient.listProviders()
      await sendSelection(chatId, {
        kind: 'provider',
        title: '选择 Provider：',
        items: buildProviderSelectionItems(providers, activeId),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取 Provider 列表', err)
    }
  }

  const applyProviderByValue = async (
    chatId: string,
    providerValue: string,
    label?: string,
  ): Promise<{ label: string; defaultModel?: string }> => {
    if (providerValue === OFFICIAL_PROVIDER_VALUE || providerValue === 'claude') {
      await deps.httpClient.activateOfficialProvider()
      await deps.httpClient.setCurrentModel(OFFICIAL_DEFAULT_MODEL_ID)
      deps.setRuntimeModel(chatId, OFFICIAL_DEFAULT_MODEL_ID)
      return { label: 'Claude 官方', defaultModel: OFFICIAL_DEFAULT_MODEL_ID }
    }

    const isOpenAiOfficial = providerValue === OPENAI_OFFICIAL_PROVIDER_ID || providerValue === 'openai'
    const providerId = isOpenAiOfficial ? OPENAI_OFFICIAL_PROVIDER_ID : providerValue
    await deps.httpClient.activateProvider(providerId)

    let defaultModel = isOpenAiOfficial ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID : undefined
    if (!defaultModel) {
      const { providers } = await deps.httpClient.listProviders()
      defaultModel = providers.find((provider) => provider.id === providerId)?.models?.main?.trim() || undefined
    }
    if (defaultModel) {
      await deps.httpClient.setCurrentModel(defaultModel)
      deps.setRuntimeModel(chatId, defaultModel)
    }

    return {
      label: label ? stripSelectedPrefix(label) : isOpenAiOfficial ? 'ChatGPT Official' : providerId,
      defaultModel,
    }
  }

  const handleProviderCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedTelegramPrivateChat(ctx, deps.isAllowedUser)) return
    const chatId = String(ctx.chat!.id)
    const query = getCommandMatchText(ctx)
    if (!query) {
      await showProviderPicker(chatId)
      return
    }

    try {
      const result = await applyProviderByValue(chatId, query)
      await ctx.reply(formatProviderChangedMessage(result.label, result.defaultModel, '发送 /new 后新配置会用于新会话。'))
    } catch (err) {
      await ctx.reply(`❌ Provider 切换失败：${toErrorMessage(err)}`)
    }
  }

  const applyProviderSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      const result = await applyProviderByValue(chatId, item.value, item.label)
      pendingSelections.delete(chatId)
      await ctx.editMessageText(formatProviderChangedMessage(
        result.label,
        result.defaultModel,
        '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新配置启动。',
      ))
    } catch (err) {
      await ctx.editMessageText(`❌ Provider 切换失败：${toErrorMessage(err)}`)
    }
  }

  const showModelPicker = async (chatId: string): Promise<void> => {
    try {
      const [modelsResult, currentResult] = await Promise.all([
        deps.httpClient.listModels(),
        deps.httpClient.getCurrentModel().catch(() => null),
      ])
      if (modelsResult.models.length === 0) {
        await deps.api.sendMessage(Number(chatId), '没有可用模型。请先在桌面端配置 Provider。')
        return
      }

      await sendSelection(chatId, {
        kind: 'model',
        title: `选择模型（${modelsResult.provider?.name ?? 'Claude 官方'}）：`,
        items: buildModelSelectionItems(modelsResult.models, currentResult?.model.id),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取模型列表', err)
    }
  }

  const setModelFromCommand = async (chatId: string, modelId: string): Promise<void> => {
    try {
      await deps.httpClient.setCurrentModel(modelId)
      deps.setRuntimeModel(chatId, modelId)
      await deps.api.sendMessage(Number(chatId), formatModelChangedMessage(modelId))
    } catch (err) {
      await deps.api.sendMessage(Number(chatId), `❌ 模型切换失败：${toErrorMessage(err)}`)
    }
  }

  const handleModelCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedTelegramPrivateChat(ctx, deps.isAllowedUser)) return
    const chatId = String(ctx.chat!.id)
    const modelId = getCommandMatchText(ctx)
    if (modelId) {
      await setModelFromCommand(chatId, modelId)
      return
    }
    await showModelPicker(chatId)
  }

  const applyModelSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      await deps.httpClient.setCurrentModel(item.value)
      deps.setRuntimeModel(chatId, item.value)
      pendingSelections.delete(chatId)
      await ctx.editMessageText([
        `✅ 已切换模型：${stripSelectedPrefix(item.label)}`,
        item.value,
        '',
        '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新模型启动。',
      ].join('\n'))
    } catch (err) {
      await ctx.editMessageText(`❌ 模型切换失败：${toErrorMessage(err)}`)
    }
  }

  const showSkills = async (chatId: string): Promise<void> => {
    const restored = await deps.ensureExistingSession(chatId)
    if (restored.status === 'unavailable') {
      await deps.api.sendMessage(Number(chatId), SESSION_RECONNECT_NOTICE)
      return
    }
    const cwd = restored.status === 'restored' ? restored.session.workDir : deps.defaultWorkDir
    if (!cwd) {
      await deps.api.sendMessage(Number(chatId), '请先发送 /new 选择项目，再查看 Skills。')
      return
    }

    try {
      const { skills } = await deps.httpClient.listSkills(cwd)
      const visibleSkills = skills.filter((skill) => skill.userInvocable)
      if (visibleSkills.length === 0) {
        await deps.api.sendMessage(Number(chatId), `当前项目没有可用 Skills：${cwd}`)
        return
      }

      await sendSelection(chatId, {
        kind: 'skill',
        title: `当前项目可用 Skills：\n${cwd}`,
        items: visibleSkills.map(skillToSelectionItem),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取 Skills', err)
    }
  }

  const handleSkillsCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedTelegramPrivateChat(ctx, deps.isAllowedUser)) return
    await showSkills(String(ctx.chat!.id))
  }

  const applySkillSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return

    const restored = await deps.ensureExistingSession(chatId)
    if (restored.status === 'unavailable') {
      await deps.api.sendMessage(Number(chatId), SESSION_RECONNECT_NOTICE)
      return
    }
    if (restored.status === 'missing') {
      pendingSelections.delete(chatId)
      await ctx.editMessageText('⚠️ 会话已失效，请发送 /new 重新选择项目后再调用 Skill。')
      return
    }

    const invocation = `/${item.value}`
    if (!deps.sendUserMessage(chatId, invocation)) {
      await ctx.editMessageText(`⚠️ Skill 发送失败。${SESSION_RECONNECT_NOTICE}`)
      return
    }

    pendingSelections.delete(chatId)
    await ctx.editMessageText([
      `✅ 已调用 Skill：${item.label}`,
      invocation,
      item.description,
      '',
      '任务已发送给当前 Agent，会继续使用这条会话的上下文、工具和权限设置。',
    ].filter(Boolean).join('\n'))
  }

  const showNewProjectPicker = async (chatId: string): Promise<void> => {
    deps.clearOtherSelections(chatId)
    pendingSelections.delete(chatId)
    try {
      const projects = await deps.httpClient.listRecentProjects()
      if (projects.length === 0) {
        await deps.api.sendMessage(Number(chatId), '没有找到最近项目。请先发送 /new 创建会话。')
        return
      }

      await sendSelection(chatId, {
        kind: 'new_project',
        title: '选择要新建会话的项目：',
        items: projects.map((project) => ({
          label: `${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
          value: project.realPath,
          description: project.realPath,
        })),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取项目列表', err)
    }
  }

  const applyNewProjectSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    if (!deps.startNewProject) {
      await ctx.editMessageText('无法创建新会话。')
      return
    }
    if (deps.isBusy(chatId)) {
      await ctx.editMessageText('当前会话正在运行或等待审批，请先处理审批或发送 /stop，等停止后再切换。')
      return
    }
    deps.cancelPendingInput?.(chatId)
    try {
      const ok = await deps.startNewProject(chatId, item.value)
      if (ok === false) {
        await ctx.editMessageText(`无法在该项目创建会话：${item.value}`)
        return
      }
    } catch (err) {
      await ctx.editMessageText(`❌ 无法创建会话：${toErrorMessage(err)}`)
      return
    }
    pendingSelections.delete(chatId)
    await ctx.editMessageText(`已选择项目：${stripSelectedPrefix(item.label)}\n${item.value}`)
  }

  const showResumeProjectPicker = async (chatId: string): Promise<void> => {
    deps.clearOtherSelections(chatId)
    pendingSelections.delete(chatId)
    try {
      const projects = await deps.httpClient.listRecentProjects()
      if (projects.length === 0) {
        await deps.api.sendMessage(Number(chatId), '没有找到最近项目。请先发送 /new 创建会话。')
        return
      }

      await sendSelection(chatId, {
        kind: 'resume_project',
        title: '选择要恢复的项目：',
        items: projects.map((project) => ({
          label: `${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
          value: project.realPath,
          description: `${project.realPath} · ${project.sessionCount} 个会话`,
        })),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取项目列表', err)
    }
  }

  const handleResumeCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedTelegramPrivateChat(ctx, deps.isAllowedUser)) return
    await showResumeProjectPicker(String(ctx.chat!.id))
  }

  const showResumeSessionPicker = async (
    ctx: TelegramCommandContext,
    project: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      const resumableSessions = await listProjectSessionHistory(deps.httpClient, project.value)
      if (resumableSessions.length === 0) {
        pendingSelections.delete(chatId)
        await ctx.editMessageText(`没有可恢复会话：${project.label}`)
        return
      }

      await editSelection(ctx, {
        kind: 'resume_session',
        title: `选择要恢复的会话：\n${project.label}`,
        items: resumableSessions.map(sessionToSelectionItem),
        page: 0,
      })
    } catch (err) {
      await ctx.editMessageText(`❌ 无法获取会话列表：${toErrorMessage(err)}`)
    }
  }

  const resumeSessionForChat = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    const workDir = item.meta?.workDir
    if (!workDir) {
      await ctx.editMessageText('❌ 这个会话缺少工作目录，无法恢复。')
      return
    }

    // Invalidate input still being transcribed before switching bindings.
    deps.cancelPendingInput?.(chatId)

    const result = await restoreSelectedSession({
      httpClient: deps.httpClient,
      bridge: {
        resetSession: deps.resetBridgeSession,
        connectSession: deps.connectBridgeSession,
        onServerMessage: deps.onBridgeServerMessage,
        waitForOpen: deps.waitForBridgeOpen,
      },
      sessionStore: {
        get: deps.getStoredSession,
        set: deps.setStoredSession,
        delete: deps.deleteStoredSession,
      },
      onServerMessage: deps.handleServerMessage,
      clearTransientState: deps.clearTransientChatState,
      isBusy: deps.isBusy,
    }, chatId, { id: item.value, workDir, title: item.label })
    if (result.ok) pendingSelections.delete(chatId)
    await ctx.editMessageText(result.message)
  }

  /** Apply one picked item. Shared by the inline buttons and by a numeric text
   *  reply, so both routes behave identically. */
  const applySelection = async (
    ctx: TelegramCommandContext,
    kind: TelegramSelectionKind,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    switch (kind) {
      case 'provider':
        await applyProviderSelection(ctx, item)
        break
      case 'model':
        await applyModelSelection(ctx, item)
        break
      case 'resume_project':
        await showResumeSessionPicker(ctx, item)
        break
      case 'resume_session':
        await resumeSessionForChat(ctx, item)
        break
      case 'new_project':
        await applyNewProjectSelection(ctx, item)
        break
      case 'skill':
        await applySkillSelection(ctx, item)
        break
    }
  }

  /**
   * Context for a pick that arrived as a *text* reply instead of a button
   * press. It keeps the chat identity the handlers key on, but sends a new
   * message instead of editing the original prompt.
   */
  const textReplyContext = (chatId: string, userId: number): TelegramCommandContext => ({
    chat: { id: chatId, type: 'private' },
    from: { id: userId },
    callbackQuery: { message: { chat: { id: chatId } } },
    reply: (text: string) => deps.api.sendMessage(Number(chatId), text),
    editMessageText: (text: string, options?: TelegramSendOptions) =>
      deps.api.sendMessage(Number(chatId), text, options),
    answerCallbackQuery: async () => {},
  })

  /**
   * Resolve a numeric text reply against this chat's pending session picker.
   *
   * The number is mapped through the picker's *current page* — the numbers the
   * user can see — and applied with the same handler the inline buttons use.
   * Nothing is guessed: without a pending session list this returns false, and
   * a digit that is not on the visible page is reported instead of being
   * silently swallowed. Provider/model/skill menus stay button-only.
   */
  const selectPendingByNumber = async (
    chatId: string,
    value: number,
    userId: number,
  ): Promise<boolean> => {
    if (!deps.isAllowedUser(userId)) return false
    const selection = peekPendingSelection(pendingSelections, chatId)
    if (!selection || !TELEGRAM_NUMERIC_PICK_KINDS.includes(selection.kind)) return false
    const page = buildTelegramSelectionPage({
      kind: selection.kind,
      token: selection.token,
      items: selection.items,
      page: selection.page,
    })
    const item = page.visibleItems[value - 1]
    if (!item) {
      await deps.api.sendMessage(
        Number(chatId),
        '编号无效，请使用当前页显示的编号，或重新发送 /resume 刷新列表。',
      )
      return true
    }
    await applySelection(textReplyContext(chatId, userId), selection.kind, item)
    return true
  }

  const handleSelectionCallback = async (
    ctx: TelegramCommandContext,
    callback: TelegramSelectionCallback,
  ): Promise<boolean> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId || !ctx.from || !deps.isAllowedUser(ctx.from.id)) {
      await ctx.answerCallbackQuery('未授权').catch(() => {})
      return true
    }

    const selection = getPendingSelection(pendingSelections, chatId, callback.kind)
    if (!selection || !callback.token || callback.token !== selection.token) {
      await ctx.answerCallbackQuery('选择已过期，请重新发送命令').catch(() => {})
      return true
    }

    if (callback.action === 'noop') {
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (callback.action === 'cancel') {
      pendingSelections.delete(chatId)
      deps.clearOtherSelections(chatId)
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageText('已取消选择，当前会话未改变。')
      return true
    }

    if (callback.action === 'refresh') {
      await ctx.answerCallbackQuery().catch(() => {})
      if (selection.kind === 'new_project') {
        try {
          const projects = await deps.httpClient.listRecentProjects()
          if (projects.length === 0) {
            pendingSelections.delete(chatId)
            await ctx.editMessageText('没有找到最近项目。请先发送 /new 创建会话。')
            return true
          }
          await editSelection(ctx, {
            kind: 'new_project',
            title: '选择要新建会话的项目：',
            items: projects.map((project) => ({
              label: `${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
              value: project.realPath,
              description: project.realPath,
            })),
            page: 0,
          })
        } catch (err) {
          await ctx.editMessageText(`❌ 无法获取项目列表：${toErrorMessage(err)}`)
        }
      }
      return true
    }

    if (callback.action === 'page') {
      await ctx.answerCallbackQuery().catch(() => {})
      await editSelection(ctx, {
        ...selection,
        page: callback.index,
      })
      return true
    }

    const item = selection.items[callback.index]
    if (!item) {
      await ctx.answerCallbackQuery('选项不存在，请重新发送命令').catch(() => {})
      return true
    }

    await ctx.answerCallbackQuery('处理中...').catch(() => {})
    await applySelection(ctx, callback.kind, item)
    return true
  }

  return {
    sendHelp: (ctx: TelegramCommandContext) => ctx.reply(buildTelegramHelpText()),
    handleProviderCommand,
    handleModelCommand,
    handleSkillsCommand,
    handleResumeCommand,
    handleSelectionCallback,
    clearPendingSelections: (chatId: string) => pendingSelections.delete(chatId),
    /** Which list this chat is currently answering, or null. Read-only pending
     *  getter for the entrypoint's receive-time routing. */
    pendingSelectionKind: (chatId: string): TelegramSelectionKind | null =>
      peekPendingSelection(pendingSelections, chatId)?.kind ?? null,
    selectPendingByNumber,
    showProviderPicker,
    showModelPicker,
    showSkills,
    showResumeProjectPicker,
    showNewProjectPicker,
    setModelFromCommand,
  }
}

export function buildTelegramHelpText(): string {
  return [
    '👋 Claude Code Bot 已就绪。',
    '',
    formatImHelp(),
    '',
    'Telegram 扩展命令：',
    '/projects — 按钮选择项目并新建会话',
    '/sessions / /resume — 按钮选择历史会话',
    '/cancel — 取消列表选择，保留当前会话',
    '/provider — 切换 Provider',
    '/model [model] — 查看或切换模型',
    '/skills — 查看当前项目可用 Skills',
    '模型提问：直接点选或回复问题消息，多题逐题填写后确认提交。',
    '/answer <JSON> — 可选批量作答，键可用题号，无需请求 ID',
    '/answer <id> <答案> — 保留原命令作答方式',
    '',
    '语音消息：默认关闭转写。只有显式配置后，语音便签才会在本机转写成文字再交给模型。',
    '未配置或转写失败时，已下载的语音会作为文件送达，并提示没有识别出内容——这不代表已经听懂。',
    '转写需要本机安装 FFmpeg（解码音频）与 whisper.cpp 兼容 CLI（whisper-cli 或 whisper-cpp；不支持 Python 的 whisper 命令），',
    '并在 ~/.claude/adapters.json 配置 stt.provider = "whisper-local"，',
    '可选 stt.whisperPath / stt.whisperModel 指定可执行文件与模型，stt.ffmpegPath 指定 FFmpeg，',
    '或用环境变量 CC_STT_PROVIDER / CC_STT_WHISPER_PATH / CC_STT_WHISPER_MODEL / CC_STT_FFMPEG_PATH。',
  ].join('\n')
}

export function buildProviderSelectionItems(
  providers: ProviderSummary[],
  activeId: string | null,
): TelegramSelectionItem[] {
  return [
    {
      label: `${activeId === null ? '✓ ' : ''}Claude 官方`,
      value: OFFICIAL_PROVIDER_VALUE,
      description: '使用 Claude 官方或环境变量配置',
      meta: { defaultModel: OFFICIAL_DEFAULT_MODEL_ID },
    },
    {
      label: `${activeId === OPENAI_OFFICIAL_PROVIDER_ID ? '✓ ' : ''}ChatGPT Official`,
      value: OPENAI_OFFICIAL_PROVIDER_ID,
      description: '使用 ChatGPT 登录的 Codex 模型',
      meta: { defaultModel: OPENAI_OFFICIAL_DEFAULT_MODEL_ID },
    },
    ...providers.map((provider) => providerToSelectionItem(provider, activeId)),
  ]
}

export function providerToSelectionItem(
  provider: ProviderSummary,
  activeId: string | null,
): TelegramSelectionItem {
  const mainModel = provider.models?.main?.trim()
  return {
    label: `${activeId === provider.id ? '✓ ' : ''}${provider.name}`,
    value: provider.id,
    description: mainModel ? `默认模型：${mainModel}` : provider.id,
    ...(mainModel ? { meta: { defaultModel: mainModel } } : {}),
  }
}

export function buildModelSelectionItems(
  models: Array<{ id: string; name?: string; context?: string; description?: string }>,
  currentModelId?: string,
): TelegramSelectionItem[] {
  return models.map((model) => ({
    label: `${model.id === currentModelId ? '✓ ' : ''}${model.name || model.id}`,
    value: model.id,
    description: [model.id, model.context, model.description].filter(Boolean).join(' · '),
  }))
}

export function skillToSelectionItem(skill: SkillSummary): TelegramSelectionItem {
  const source = skill.pluginName ? `${skill.source}:${skill.pluginName}` : skill.source
  return {
    label: skill.displayName || skill.name,
    value: skill.name,
    description: `${source} · ${skill.description}`,
  }
}

export function sessionToSelectionItem(session: SessionListItem): TelegramSelectionItem {
  const title = session.title || `会话 ${compactId(session.id)}`
  return {
    label: title,
    value: session.id,
    description: `${formatDateTime(session.modifiedAt)} · ${session.messageCount} 条消息 · ${session.workDir}`,
    ...(session.workDir ? { meta: { workDir: session.workDir } } : {}),
  }
}

export function renderSelectionView(selection: PendingTelegramSelection): {
  text: string
  replyMarkup: TelegramInlineKeyboardMarkup
} {
  const page = buildTelegramSelectionPage({
    kind: selection.kind,
    token: selection.token,
    items: selection.items,
    page: selection.page,
  })
  const lines = page.visibleItems.map((item, offset) => {
    const number = offset + 1
    return item.description
      ? `${number}. ${item.label}\n   ${item.description}`
      : `${number}. ${item.label}`
  })
  const pageSuffix = page.totalPages > 1 ? `\n\n第 ${page.page + 1}/${page.totalPages} 页` : ''
  return {
    text: `${selection.title}\n\n${lines.join('\n\n')}${pageSuffix}`,
    replyMarkup: {
      inline_keyboard: page.rows.map((row) => row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      }))),
    },
  }
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function compactId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8)
}

function setPendingSelection(
  pendingSelections: Map<string, PendingTelegramSelection>,
  chatId: string,
  selection: NewSelection,
): PendingTelegramSelection {
  const next = {
    ...selection,
    token: randomBytes(4).toString('hex'),
    expiresAt: Date.now() + TELEGRAM_SELECTION_TTL_MS,
  }
  pendingSelections.set(chatId, next)
  return next
}

function getPendingSelection(
  pendingSelections: Map<string, PendingTelegramSelection>,
  chatId: string,
  kind: TelegramSelectionKind,
): PendingTelegramSelection | null {
  const selection = pendingSelections.get(chatId)
  if (!selection || selection.kind !== kind) return null
  if (selection.expiresAt < Date.now()) {
    pendingSelections.delete(chatId)
    return null
  }
  return selection
}

/**
 * The chat's pending picker regardless of kind, or null. Expired pickers are
 * pruned on read. Read-only: unlike `getPendingSelection` it answers no
 * callback and mutates nothing else, so an entrypoint can ask "is a list
 * waiting for this chat?" before deciding that a bare number is list input.
 */
function peekPendingSelection(
  pendingSelections: Map<string, PendingTelegramSelection>,
  chatId: string,
): PendingTelegramSelection | null {
  const selection = pendingSelections.get(chatId)
  if (!selection) return null
  if (selection.expiresAt < Date.now()) {
    pendingSelections.delete(chatId)
    return null
  }
  return selection
}

function getCallbackChatId(ctx: TelegramCommandContext): string | null {
  const chatId = ctx.callbackQuery?.message?.chat.id
  return chatId === undefined || chatId === null ? null : String(chatId)
}

function getCommandMatchText(ctx: TelegramCommandContext): string | undefined {
  if (typeof ctx.match !== 'string') return undefined
  return ctx.match.trim() || undefined
}

function formatProviderChangedMessage(label: string, defaultModel: string | undefined, suffix: string): string {
  return [
    `✅ 已切换 Provider：${stripSelectedPrefix(label)}`,
    defaultModel ? `默认模型：${defaultModel}` : undefined,
    '',
    suffix,
  ].filter(Boolean).join('\n')
}

function formatModelChangedMessage(modelId: string): string {
  return [
    `✅ 已切换模型：${modelId}`,
    '',
    '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新模型启动。',
  ].join('\n')
}

function stripSelectedPrefix(value: string): string {
  return value.replace(/^✓\s*/, '')
}

async function sendError(api: TelegramSendApi, chatId: string, label: string, err: unknown): Promise<void> {
  await api.sendMessage(Number(chatId), `❌ ${label}：${toErrorMessage(err)}`)
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
