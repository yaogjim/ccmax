import { randomBytes } from 'node:crypto'
import { createQuestionFlow, parseQuestionAnswer, type ImQuestionFlow } from '../common/ask-user-question.js'
import { splitMessage } from '../common/format.js'

const CALLBACK_PREFIX = 'tgq'
const TOMBSTONE_LIMIT = 128
const TELEGRAM_TEXT_LIMIT = 4000
const BUTTON_TEXT_LIMIT = 64
const CALLBACK_ACTIONS = new Set(['c', 'n', 's', 'e', 'b', 'o', 'd', 'f'])

const NON_ANSWER_COMMAND = /^\/(?!answer(?:@[A-Za-z0-9_]+)?(?:\s|$))(?:[A-Za-z0-9_]|[^\s/])/i

type InlineButton = { text: string; callback_data: string }
type InlineKeyboard = { inline_keyboard: Array<Array<InlineButton>> }
type SendOptions = { reply_markup?: InlineKeyboard }

export type TelegramQuestionControllerDeps = {
  api: {
    sendMessage: (
      chatId: number,
      text: string,
      options?: SendOptions,
    ) => Promise<{ message_id: number } | unknown>
    editMessageText?: (
      chatId: number,
      messageId: number,
      text: string,
      options?: SendOptions,
    ) => Promise<unknown>
    editMessageReplyMarkup?: (
      chatId: number,
      messageId: number,
      options: { reply_markup: InlineKeyboard },
    ) => Promise<unknown>
  }
  isAllowedUser: (userId: number) => boolean
  getSessionId: (chatId: string) => string | null
  submitAnswers: (
    chatId: string,
    requestId: string,
    answers: Record<string, string>,
  ) => boolean | Promise<boolean>
  deny: (chatId: string, requestId: string) => boolean | Promise<boolean>
  activity: (chatId: string, requestId: string) => boolean
}

export type TelegramQuestionCallbackContext = {
  from?: { id: number }
  chat?: { id: string | number; type?: string }
  callbackQuery?: {
    message?: {
      message_id: number
      chat: { id: string | number }
      text?: string
    }
  }
  answerCallbackQuery: (text?: string) => Promise<unknown>
}

type PendingQuestion = {
  chatId: string
  requestId: string
  input: unknown
  flow: ImQuestionFlow
  token: string
  version: number
  sessionId: string | null
  awaitingFreeText: boolean
  cardSent: boolean
  messageIds: number[]
  currentMessageId?: number
  lastText: string
}

type MessageBinding =
  | { requestId: string; version: number; text: string }
  | { tombstone: true }

type ParsedCallback = {
  token: string
  version: number
  action: string
  index?: number
}

type AnswerCommand = { requestId?: string; payload: string }

export function createTelegramQuestionController(deps: TelegramQuestionControllerDeps) {
  const chats = new Map<string, Map<string, PendingQuestion>>()
  const tokens = new Map<string, { chatId: string; requestId: string }>()
  const messages = new Map<string, MessageBinding>()
  const tombstoneKeys: string[] = []
  const focused = new Map<string, string>()

  function pendingMap(chatId: string): Map<string, PendingQuestion> {
    const existing = chats.get(chatId)
    if (existing) return existing
    const created = new Map<string, PendingQuestion>()
    chats.set(chatId, created)
    return created
  }

  function getPending(chatId: string, requestId: string): PendingQuestion | undefined {
    return chats.get(chatId)?.get(requestId)
  }

  function stillPending(pending: PendingQuestion): boolean {
    return getPending(pending.chatId, pending.requestId) === pending
  }

  function listPending(chatId: string): PendingQuestion[] {
    return [...(chats.get(chatId)?.values() ?? [])]
  }

  function messageKey(chatId: string, messageId: number): string {
    return `${chatId}:${messageId}`
  }

  function bindMessage(pending: PendingQuestion, messageId: number, text: string): void {
    pending.currentMessageId = messageId
    if (!pending.messageIds.includes(messageId)) pending.messageIds.push(messageId)
    messages.set(messageKey(pending.chatId, messageId), {
      requestId: pending.requestId,
      version: pending.version,
      text,
    })
  }

  function addTombstone(chatId: string, messageId: number): void {
    const key = messageKey(chatId, messageId)
    messages.set(key, { tombstone: true })
    tombstoneKeys.push(key)
    while (tombstoneKeys.length > TOMBSTONE_LIMIT) {
      const expired = tombstoneKeys.shift()
      if (!expired) break
      const binding = messages.get(expired)
      if (binding && 'tombstone' in binding) messages.delete(expired)
    }
  }

  function lookupMessage(chatId: string, messageId: number): MessageBinding | undefined {
    return messages.get(messageKey(chatId, messageId))
  }

  function allocToken(): string {
    let token = randomBytes(4).toString('hex')
    while (tokens.has(token)) token = randomBytes(4).toString('hex')
    return token
  }

  function callbackData(pending: PendingQuestion, action: string, index?: number): string {
    return index === undefined
      ? `${CALLBACK_PREFIX}:${pending.token}:${pending.version}:${action}`
      : `${CALLBACK_PREFIX}:${pending.token}:${pending.version}:${action}:${index}`
  }

  async function safeSend(
    chatId: string,
    text: string,
    options?: SendOptions,
  ): Promise<{ message_id: number } | unknown | undefined> {
    try {
      return await deps.api.sendMessage(Number(chatId), clipText(text), options)
    } catch {
      return undefined
    }
  }

  async function stripKeyboard(pending: PendingQuestion, messageId: number): Promise<void> {
    const binding = lookupMessage(pending.chatId, messageId)
    const original = binding && 'text' in binding ? binding.text : pending.lastText
    if (deps.api.editMessageReplyMarkup) {
      try {
        await deps.api.editMessageReplyMarkup(Number(pending.chatId), messageId, {
          reply_markup: { inline_keyboard: [] },
        })
      } catch { /* best-effort card invalidation */ }
      return
    }
    if (!deps.api.editMessageText || !original) return
    try {
      await deps.api.editMessageText(Number(pending.chatId), messageId, original, {
        reply_markup: { inline_keyboard: [] },
      })
    } catch { /* best-effort card invalidation */ }
  }

  function forget(pending: PendingQuestion): void {
    tokens.delete(pending.token)
    const map = chats.get(pending.chatId)
    if (map?.get(pending.requestId) === pending) map.delete(pending.requestId)
    if (map && map.size === 0) chats.delete(pending.chatId)
    if (focused.get(pending.chatId) === pending.requestId) focused.delete(pending.chatId)
    for (const messageId of pending.messageIds) {
      void stripKeyboard(pending, messageId)
    }
    for (const messageId of pending.messageIds) addTombstone(pending.chatId, messageId)
  }

  async function showSubmitRetry(pending: PendingQuestion): Promise<void> {
    if (!stillPending(pending)) return
    await sendCard(pending, {
      editMessageId: pending.currentMessageId,
      invalidatePrevious: true,
    })
  }

  async function trySubmit(
    pending: PendingQuestion,
    answers: Record<string, string> | null,
  ): Promise<void> {
    if (!answers) {
      await safeSend(pending.chatId, '❌ 答案不完整，请继续作答。')
      return
    }
    if (!stillPending(pending)) return
    let submitted = false
    try {
      submitted = await deps.submitAnswers(pending.chatId, pending.requestId, answers)
    } catch {
      // A transport error must keep the same draft available for retry.
    }
    if (!stillPending(pending)) return
    if (!submitted) {
      pending.flow.answers = { ...answers }
      pending.flow.index = pending.flow.questions.length
      await safeSend(pending.chatId, '⚠️ 答案发送失败，请稍后重试。请求仍保留。')
      await showSubmitRetry(pending)
      return
    }
    forget(pending)
    await safeSend(pending.chatId, '✅ 已提交答案，等待模型继续。')
  }

  function shouldAutoSubmit(pending: PendingQuestion): boolean {
    return pending.flow.questions.length === 1 && pending.flow.complete() !== null
  }

  function renderCard(pending: PendingQuestion): { text: string; reply_markup: InlineKeyboard } {
    const flow = pending.flow
    if (flow.isSummary) {
      const lines = ['📝 请确认全部答案', '']
      flow.questions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question.question}`)
        lines.push(`→ ${flow.answers[question.question] ?? '（未作答）'}`)
      })
      const rows: InlineButton[][] = [[{ text: '提交全部', callback_data: callbackData(pending, 's') }]]
      const edits: InlineButton[] = flow.questions.map((question, index) => ({
        text: clipButton(`修改 ${index + 1}`),
        callback_data: callbackData(pending, 'e', index),
      }))
      for (let offset = 0; offset < edits.length; offset += 2) {
        rows.push(edits.slice(offset, offset + 2))
      }
      rows.push([{ text: '上一题', callback_data: callbackData(pending, 'b') }])
      rows.push([{ text: '❌ 拒绝', callback_data: callbackData(pending, 'd') }])
      return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } }
    }

    const question = flow.questions[flow.index]
    const lines = [
      `📝 问题 ${flow.index + 1}/${flow.questions.length}`,
      question?.header ? `（${question.header}）` : '',
      question?.question ?? '请作答',
      '',
    ].filter((line, index, all) => line !== '' || index === all.length - 1)

    if (question?.options.length) {
      for (const option of question.options) {
        const suffix = option.description ? `：${option.description}` : ''
        lines.push(`- ${option.label}${suffix}`)
      }
    } else {
      lines.push('请直接发送文字作答。')
    }

    const rows: InlineButton[][] = []
    question?.options.forEach((option, index) => {
      const selected = flow.selectedIndices.has(index)
      rows.push([{
        text: clipButton(`${selected ? '✓ ' : ''}${option.label}`),
        callback_data: callbackData(pending, 'c', index),
      }])
    })
    rows.push([{ text: '其他', callback_data: callbackData(pending, 'o') }])
    if (question?.multiSelect) {
      const label = flow.questions.length === 1 || flow.index === flow.questions.length - 1
        ? '提交'
        : '下一题'
      rows.push([{ text: label, callback_data: callbackData(pending, 'n') }])
    }
    if (flow.index > 0 || Object.keys(flow.answers).length > 0) {
      rows.push([{ text: '上一题', callback_data: callbackData(pending, 'b') }])
    }
    rows.push([{ text: '❌ 拒绝', callback_data: callbackData(pending, 'd') }])
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } }
  }

  async function sendCard(
    pending: PendingQuestion,
    options?: { editMessageId?: number; invalidatePrevious?: boolean },
  ): Promise<void> {
    if (!stillPending(pending)) return
    const previousId = pending.currentMessageId
    pending.cardSent = false
    pending.version += 1
    const card = renderCard(pending)
    const chunks = splitMessage(card.text, TELEGRAM_TEXT_LIMIT)
    pending.lastText = card.text

    if (
      chunks.length === 1
      && options?.editMessageId !== undefined
      && deps.api.editMessageText
    ) {
      try {
        await deps.api.editMessageText(
          Number(pending.chatId),
          options.editMessageId,
          chunks[0]!,
          { reply_markup: card.reply_markup },
        )
        if (!stillPending(pending)) return
        pending.cardSent = true
        bindMessage(pending, options.editMessageId, chunks[0]!)
        return
      } catch {
        // Fall through to a fresh message.
      }
    }

    if (options?.invalidatePrevious && previousId !== undefined) {
      void stripKeyboard(pending, previousId)
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      const isLast = index === chunks.length - 1
      let sent: { message_id: number } | unknown | undefined
      try {
        sent = await deps.api.sendMessage(
          Number(pending.chatId),
          chunk,
          isLast ? { reply_markup: card.reply_markup } : undefined,
        )
      } catch {
        if (stillPending(pending)) pending.cardSent = false
        return
      }
      const messageId = extractMessageId(sent)
      if (!stillPending(pending)) {
        if (messageId !== undefined) addTombstone(pending.chatId, messageId)
        return
      }
      if (isLast) pending.cardSent = true
      if (messageId !== undefined) bindMessage(pending, messageId, chunk)
    }
  }

  async function afterFlowChange(
    pending: PendingQuestion,
    options?: { inPlace?: boolean; autoSubmit?: boolean },
  ): Promise<void> {
    if (!stillPending(pending)) return
    if (options?.autoSubmit && shouldAutoSubmit(pending)) {
      await trySubmit(pending, pending.flow.complete())
      return
    }
    const editMessageId = options?.inPlace ? pending.currentMessageId : undefined
    await sendCard(pending, {
      editMessageId,
      invalidatePrevious: editMessageId === undefined,
    })
  }

  function sessionIsValid(pending: PendingQuestion): boolean {
    const current = deps.getSessionId(pending.chatId)
    if (!current) return false
    if (pending.sessionId && pending.sessionId !== current) return false
    return true
  }

  function noteActivity(pending: PendingQuestion): boolean {
    return deps.activity(pending.chatId, pending.requestId)
  }

  async function warnActivityFailed(chatId: string): Promise<void> {
    await safeSend(chatId, '⚠️ 未能记录本次操作，请重试。问题仍有效，没有被取消。')
  }

  async function receive(chatId: string, requestId: string, input: unknown): Promise<void> {
    const existing = getPending(chatId, requestId)
    if (existing) {
      if (!existing.cardSent) await sendCard(existing)
      return
    }

    const flow = createQuestionFlow(input)
    if (!flow) {
      await safeSend(chatId, '无法解析该提问，请稍后重试。')
      return
    }

    const pending: PendingQuestion = {
      chatId,
      requestId,
      input,
      flow,
      token: allocToken(),
      version: 0,
      sessionId: deps.getSessionId(chatId),
      awaitingFreeText: false,
      cardSent: false,
      messageIds: [],
      lastText: '',
    }
    pendingMap(chatId).set(requestId, pending)
    tokens.set(pending.token, { chatId, requestId })
    await sendCard(pending)
  }

  function requestIds(chatId: string): string[] {
    return [...(chats.get(chatId)?.keys() ?? [])]
  }

  function hasPending(chatId: string): boolean {
    return (chats.get(chatId)?.size ?? 0) > 0
  }

  function remove(chatId: string, requestId: string): void {
    const pending = getPending(chatId, requestId)
    if (pending) forget(pending)
  }

  function clear(chatId: string): void {
    for (const pending of listPending(chatId)) forget(pending)
  }

  function prune(chatId: string, keep: Set<string>): void {
    for (const pending of listPending(chatId)) {
      if (!keep.has(pending.requestId)) forget(pending)
    }
  }

  function shouldHandleText(params: {
    chatId: string
    text: string
    replyToMessageId?: number
    hasOtherSelection: boolean
  }): boolean {
    const text = params.text.trim()
    if (isNonAnswerCommand(text)) return false
    if (parseAnswerCommand(text) !== null) return true
    if (params.replyToMessageId !== undefined) {
      const binding = lookupMessage(params.chatId, params.replyToMessageId)
      return Boolean(binding)
    }
    return hasPending(params.chatId)
  }

  async function handleText(params: {
    chatId: string
    text: string
    userId: number
    replyToMessageId?: number
    hasOtherSelection: boolean
  }): Promise<boolean> {
    const trimmed = params.text.trim()
    if (isNonAnswerCommand(trimmed)) return false
    if (!deps.isAllowedUser(params.userId)) return false

    const answerCommand = parseAnswerCommand(params.text)
    if (answerCommand === 'malformed') {
      const target = locatePending(params.chatId, {
        replyToMessageId: params.replyToMessageId,
        hasOtherSelection: params.hasOtherSelection,
      })
      if (target.kind === 'request' && !noteActivity(target.pending)) {
        await warnActivityFailed(params.chatId)
        return true
      }
      await safeSend(params.chatId, '用法：/answer <答案>；多题请回复 JSON。也可直接点选问题按钮。')
      return true
    }

    const located = locatePending(params.chatId, {
      replyToMessageId: params.replyToMessageId,
      requestId: answerCommand?.requestId,
      hasOtherSelection: params.hasOtherSelection,
      allowFocused: true,
    })

    if (located.kind === 'none') {
      if (answerCommand) {
        await safeSend(params.chatId, '当前没有待回答的问题。')
        return true
      }
      return false
    }
    if (located.kind === 'tombstone') {
      await safeSend(params.chatId, '该问题已失效，不能再作答。')
      return true
    }
    if (located.kind === 'expired') {
      await safeSend(params.chatId, '该问题已过期，请使用最新消息作答。')
      return true
    }
    if (located.kind === 'missing') {
      await safeSend(params.chatId, `未找到待回答的问题请求：${located.requestId}`)
      return true
    }
    if (located.kind === 'ambiguous') {
      await promptFocus(params.chatId, located.requests, params.hasOtherSelection)
      return true
    }

    const pending = located.pending
    if (!pending.cardSent) {
      await safeSend(params.chatId, '⚠️ 问题消息发送失败，本次文字未作为答案。正在重新发送，请看到题目后再作答。')
      await sendCard(pending)
      return true
    }
    if (!sessionIsValid(pending)) {
      await safeSend(params.chatId, '会话已失效，请稍后重试。问题草稿仍保留。')
      return true
    }
    if (!noteActivity(pending)) {
      await warnActivityFailed(params.chatId)
      return true
    }
    if (!stillPending(pending)) return true

    const payload = answerCommand ? answerCommand.payload : trimmed
    if (!payload) {
      await safeSend(params.chatId, '答案不能为空，请重新发送。草稿未清除。')
      return true
    }

    if (payload.startsWith('{')) {
      const parsed = parseQuestionAnswer(payload, pending.input)
      if (!parsed) {
        await safeSend(params.chatId, '❌ 无法识别答案：JSON 格式错误或不完整，请修正后重试。草稿未清除。')
        return true
      }
      await trySubmit(pending, parsed)
      return true
    }

    if (pending.flow.isSummary) {
      await safeSend(params.chatId, '请点选「提交全部」确认，或点选「修改」回到题目。')
      return true
    }

    if (!pending.flow.answer(payload)) {
      await safeSend(params.chatId, '❌ 无法识别该答案，请重试。草稿未清除。')
      return true
    }
    pending.awaitingFreeText = false
    await afterFlowChange(pending, { autoSubmit: true })
    return true
  }

  function locatePending(
    chatId: string,
    options: {
      replyToMessageId?: number
      requestId?: string
      hasOtherSelection: boolean
      allowFocused?: boolean
    },
  ):
    | { kind: 'request'; pending: PendingQuestion }
    | { kind: 'tombstone' }
    | { kind: 'expired' }
    | { kind: 'ambiguous'; requests: PendingQuestion[] }
    | { kind: 'missing'; requestId: string }
    | { kind: 'none' } {
    if (options.requestId) {
      const pending = getPending(chatId, options.requestId)
      if (pending) return { kind: 'request', pending }
      return { kind: 'missing', requestId: options.requestId }
    }

    if (options.replyToMessageId !== undefined) {
      const binding = lookupMessage(chatId, options.replyToMessageId)
      if (binding && 'tombstone' in binding) return { kind: 'tombstone' }
      if (binding) {
        const pending = getPending(chatId, binding.requestId)
        if (!pending) return { kind: 'tombstone' }
        if (binding.version !== pending.version) return { kind: 'expired' }
        return { kind: 'request', pending }
      }
      // An unrelated or forgotten reply must not fall back to a new request.
      return { kind: 'none' }
    }

    const requests = listPending(chatId)
    if (options.allowFocused) {
      const focusedId = focused.get(chatId)
      const focusedPending = focusedId ? getPending(chatId, focusedId) : undefined
      if (focusedPending) return { kind: 'request', pending: focusedPending }
    }
    if (requests.length === 1 && !options.hasOtherSelection) {
      return { kind: 'request', pending: requests[0]! }
    }
    if (requests.length > 0) return { kind: 'ambiguous', requests }
    return { kind: 'none' }
  }

  async function promptFocus(
    chatId: string,
    requests: PendingQuestion[],
    hasOtherSelection: boolean,
  ): Promise<void> {
    const reason = hasOtherSelection && requests.length === 1
      ? '当前还有其他待选择或待审批的事项，请点选要回答的问题，不要把普通文字当成最新请求。'
      : '当前有多个待回答的问题，请点选要回答的目标，不要直接发送文字。'
    const rows = requests.map((pending) => {
      const label = pending.flow.questions[0]?.question ?? pending.requestId
      return [{
        text: clipButton(label),
        callback_data: callbackData(pending, 'f'),
      }]
    })
    await safeSend(chatId, reason, { reply_markup: { inline_keyboard: rows } })
  }

  async function handleCallback(
    ctx: TelegramQuestionCallbackContext,
    data: string,
  ): Promise<boolean> {
    if (!data.startsWith(`${CALLBACK_PREFIX}:`)) return false
    const parsed = parseQuestionCallback(data)
    const answer = (text?: string) => ctx.answerCallbackQuery(text).catch(() => {})
    if (!parsed) {
      await answer('无效操作')
      return true
    }

    const located = tokens.get(parsed.token)
    const userId = ctx.from?.id
    if (userId === undefined || !deps.isAllowedUser(userId)) {
      await answer('未授权')
      return true
    }

    const callbackChatId = ctx.callbackQuery?.message?.chat.id ?? ctx.chat?.id
    if (callbackChatId === undefined || !located || String(callbackChatId) !== located.chatId) {
      await answer('该问题已失效')
      return true
    }
    if (ctx.chat?.id !== undefined && String(ctx.chat.id) !== located.chatId) {
      await answer('该问题已失效')
      return true
    }

    const pending = getPending(located.chatId, located.requestId)
    if (!pending) {
      await answer('该问题已失效')
      return true
    }
    if (!sessionIsValid(pending)) {
      await answer('会话已失效')
      return true
    }
    if (parsed.version !== pending.version) {
      await answer('该问题已失效，请使用最新消息')
      return true
    }

    const messageId = ctx.callbackQuery?.message?.message_id
    if (messageId !== undefined) {
      const binding = lookupMessage(pending.chatId, messageId)
      if (binding && 'tombstone' in binding) {
        await answer('该问题已失效')
        return true
      }
      if (binding && (binding.requestId !== pending.requestId || binding.version !== pending.version)) {
        await answer('该问题已失效，请使用最新消息')
        return true
      }
    }

    if (!noteActivity(pending)) {
      await answer('请重试')
      await warnActivityFailed(pending.chatId)
      return true
    }
    if (!stillPending(pending)) {
      await answer('该问题已失效')
      return true
    }

    switch (parsed.action) {
      case 'c': {
        if (parsed.index === undefined) {
          await answer('无效选项')
          return true
        }
        const indexBefore = pending.flow.index
        const changed = pending.flow.choose(parsed.index)
        if (!changed) {
          await answer('无法选择该项')
          return true
        }
        pending.awaitingFreeText = false
        await answer()
        await afterFlowChange(pending, {
          inPlace: pending.flow.index === indexBefore && !pending.flow.isSummary,
          autoSubmit: true,
        })
        return true
      }
      case 'n': {
        if (!pending.flow.next()) {
          await answer('请至少选择一项')
          return true
        }
        await answer()
        await afterFlowChange(pending, { autoSubmit: true })
        return true
      }
      case 's': {
        await answer()
        await trySubmit(pending, pending.flow.complete())
        return true
      }
      case 'e': {
        if (parsed.index === undefined || !pending.flow.edit(parsed.index)) {
          await answer('无法修改该题')
          return true
        }
        pending.awaitingFreeText = false
        await answer()
        await afterFlowChange(pending)
        return true
      }
      case 'b': {
        if (!pending.flow.back()) {
          await answer('没有上一题')
          return true
        }
        pending.awaitingFreeText = false
        await answer()
        await afterFlowChange(pending)
        return true
      }
      case 'o': {
        pending.awaitingFreeText = true
        focused.set(pending.chatId, pending.requestId)
        await answer('请发送文字')
        await safeSend(pending.chatId, '请发送文字作为本题的自由回答，也可回复问题消息。')
        return true
      }
      case 'd': {
        const denied = await Promise.resolve(deps.deny(pending.chatId, pending.requestId))
        if (!stillPending(pending)) {
          await answer()
          return true
        }
        if (!denied) {
          await answer('请重试')
          await safeSend(pending.chatId, '⚠️ 拒绝发送失败，请重试。问题仍保留。')
          return true
        }
        forget(pending)
        await answer('已拒绝')
        await safeSend(pending.chatId, '❌ 已拒绝该提问。')
        return true
      }
      case 'f': {
        focused.set(pending.chatId, pending.requestId)
        await answer()
        await afterFlowChange(pending)
        return true
      }
      default:
        await answer('无效操作')
        return true
    }
  }

  return {
    receive,
    requestIds,
    hasPending,
    remove,
    clear,
    prune,
    shouldHandleText,
    handleText,
    handleCallback,
  }
}

function parseNonNegativeInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseQuestionCallback(data: string): ParsedCallback | null {
  const parts = data.split(':')
  if (parts.length < 4 || parts.length > 5 || parts[0] !== CALLBACK_PREFIX) return null
  const token = parts[1]
  const action = parts[3]
  if (!token || !action || !CALLBACK_ACTIONS.has(action)) return null
  const version = parseNonNegativeInt(parts[2]!)
  if (version === null) return null
  if (parts.length === 4) return { token, version, action }
  const index = parseNonNegativeInt(parts[4]!)
  if (index === null) return null
  return { token, version, action, index }
}

function parseAnswerCommand(text: string): AnswerCommand | 'malformed' | null {
  const trimmed = text.trim()
  if (!/^\/answer(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(trimmed)) return null
  const match = /^\/answer(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(trimmed)
  const rest = match?.[1]?.trim() ?? ''
  if (!rest) return 'malformed'
  if (rest.startsWith('{')) return { payload: rest }
  const split = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest)
  if (!split) return 'malformed'
  const first = split[1]!
  const second = split[2]?.trim()
  if (second) return { requestId: first, payload: second }
  return { payload: first }
}

function isNonAnswerCommand(text: string): boolean {
  return NON_ANSWER_COMMAND.test(text.trim())
}

function extractMessageId(sent: unknown): number | undefined {
  if (!sent || typeof sent !== 'object') return undefined
  const value = (sent as { message_id?: unknown }).message_id
  return typeof value === 'number' ? value : undefined
}

function clipText(text: string, max = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function clipButton(text: string): string {
  return clipText(text, BUTTON_TEXT_LIMIT)
}