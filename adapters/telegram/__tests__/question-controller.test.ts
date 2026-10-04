import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramQuestionController } from '../question-controller.js'

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR'] as const

const singleQuestionInput = {
  questions: [
    {
      question: '选哪个库？',
      header: 'Library',
      options: [
        { label: 'Axios', description: '成熟稳定' },
        { label: 'Fetch', description: '浏览器内置' },
      ],
      multiSelect: false,
    },
  ],
}

const multiQuestionInput = {
  questions: [
    {
      question: '前端框架？',
      header: 'Framework',
      options: [{ label: 'React' }, { label: 'Vue' }],
      multiSelect: false,
    },
    {
      question: '数据库？',
      header: 'Database',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      multiSelect: false,
    },
  ],
}

const multiSelectInput = {
  questions: [
    {
      question: '启用哪些能力？',
      header: 'Features',
      options: [
        { label: '缓存', description: '加速读取' },
        { label: '日志', description: '排查问题' },
        { label: '监控', description: '观察运行' },
      ],
      multiSelect: true,
    },
  ],
}

type SentMessage = {
  chatId: number
  text: string
  messageId?: number
  options?: {
    reply_markup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
  }
}

type Button = { text: string; callback_data: string }

function buttonsOf(messages: SentMessage[]): Button[] {
  const buttons: Button[] = []
  for (const message of messages) {
    for (const row of message.options?.reply_markup?.inline_keyboard ?? []) {
      buttons.push(...row)
    }
  }
  return buttons
}

function findButton(messages: SentMessage[], pattern: string | RegExp): Button & { messageId?: number } {
  const match = (item: Button): boolean =>
    typeof pattern === 'string' ? item.text.includes(pattern) : pattern.test(item.text)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const found = [...buttonsOf([message])].reverse().find(match)
    if (found) return { ...found, messageId: message.messageId }
  }
  throw new Error(`button not found: ${String(pattern)}`)
}

function extractSentMessageId(sent: unknown): number | undefined {
  if (!sent || typeof sent !== 'object') return undefined
  const value = (sent as { message_id?: unknown }).message_id
  return typeof value === 'number' ? value : undefined
}

describe('createTelegramQuestionController', () => {
  const previousEnv = new Map<string, string | undefined>()
  let directory: string

  beforeEach(() => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key])
    directory = mkdtempSync(join(tmpdir(), 'tg-question-'))
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  })

  function createHarness(options?: {
    allowed?: boolean
    sessionId?: string | null
    submit?: boolean | Promise<boolean> | (() => boolean | Promise<boolean>)
    deny?: boolean | Promise<boolean> | (() => boolean | Promise<boolean>)
    activity?: boolean | (() => boolean)
    sendImpl?: (chatId: number, text: string, extra?: SentMessage['options']) => Promise<{ message_id: number } | unknown>
    editImpl?: (chatId: number, messageId: number, text: string) => Promise<unknown>
    withReplyMarkup?: boolean
  }) {
    const chatId = '1001'
    const numericChatId = 1001
    const userId = 7
    const sent: SentMessage[] = []
    const edited: Array<{ chatId: number; messageId: number; text: string }> = []
    const markupEdits: Array<{ chatId: number; messageId: number }> = []
    const submitted: Array<{ chatId: string; requestId: string; answers: Record<string, string> }> = []
    const denied: Array<{ chatId: string; requestId: string }> = []
    const activities: Array<{ chatId: string; requestId: string }> = []
    const callbackAnswers: Array<string | undefined> = []
    let nextMessageId = 10
    let sessionId: string | null = options?.sessionId === undefined ? 'session-1' : options.sessionId
    const allowed = options?.allowed ?? true

    const sendMessage = mock(async (id: number, text: string, extra?: SentMessage['options']) => {
      const entry: SentMessage = { chatId: id, text, options: extra }
      sent.push(entry)
      if (options?.sendImpl) {
        const result = await options.sendImpl(id, text, extra)
        const messageId = extractSentMessageId(result)
        if (messageId !== undefined) entry.messageId = messageId
        return result
      }
      const messageId = nextMessageId++
      entry.messageId = messageId
      return { message_id: messageId }
    })
    const editMessageText = mock(async (id: number, messageId: number, text: string, extra?: SentMessage['options']) => {
      edited.push({ chatId: id, messageId, text })
      if (options?.editImpl) return await options.editImpl(id, messageId, text)
      sent.push({ chatId: id, text, options: extra, messageId })
      return true
    })
    const editMessageReplyMarkup = mock(async (id: number, messageId: number) => {
      markupEdits.push({ chatId: id, messageId })
      return true
    })

    const controller = createTelegramQuestionController({
      api: {
        sendMessage,
        editMessageText,
        ...(options?.withReplyMarkup ? { editMessageReplyMarkup } : {}),
      },
      isAllowedUser: (id) => allowed && id === userId,
      getSessionId: () => sessionId,
      submitAnswers: mock(async (id: string, requestId: string, answers: Record<string, string>) => {
        submitted.push({ chatId: id, requestId, answers })
        const impl = options?.submit
        if (typeof impl === 'function') return await impl()
        if (impl instanceof Promise) return await impl
        return impl ?? true
      }),
      deny: mock(async (id: string, requestId: string) => {
        denied.push({ chatId: id, requestId })
        const impl = options?.deny
        if (typeof impl === 'function') return await impl()
        if (impl instanceof Promise) return await impl
        return impl ?? true
      }),
      activity: mock((id: string, requestId: string) => {
        activities.push({ chatId: id, requestId })
        const impl = options?.activity
        if (typeof impl === 'function') return impl()
        return impl ?? true
      }),
    })

    function callbackCtx(data: string, overrides?: {
      userId?: number
      chatId?: number | string
      messageId?: number
      type?: string
    }) {
      return {
        from: { id: overrides?.userId ?? userId },
        chat: { id: overrides?.chatId ?? numericChatId, type: overrides?.type ?? 'private' },
        callbackQuery: {
          message: {
            message_id: overrides?.messageId ?? 10,
            chat: { id: overrides?.chatId ?? numericChatId },
            text: 'question',
          },
        },
        answerCallbackQuery: mock(async (text?: string) => {
          callbackAnswers.push(text)
        }),
      }
    }

    async function click(pattern: string | RegExp, ctxOverrides?: Parameters<typeof callbackCtx>[1]) {
      const button = findButton(sent, pattern)
      expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      expect(button.callback_data.startsWith('tgq:')).toBe(true)
      return await controller.handleCallback(
        callbackCtx(button.callback_data, {
          ...ctxOverrides,
          messageId: ctxOverrides?.messageId ?? button.messageId,
        }),
        button.callback_data,
      )
    }

    return {
      chatId,
      numericChatId,
      userId,
      sent,
      edited,
      markupEdits,
      submitted,
      denied,
      activities,
      callbackAnswers,
      sendMessage,
      controller,
      callbackCtx,
      click,
      setSessionId: (value: string | null) => {
        sessionId = value
      },
      texts: () => sent.map((item) => item.text),
    }
  }

  it('submits a single-question option immediately and records activity only on the click', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-single'])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.activities).toEqual([])
    expect(h.texts().join('\n')).toContain('选哪个库？')
    expect(buttonsOf(h.sent).some((button) => button.text.includes('Axios'))).toBe(true)

    expect(await h.click('Axios')).toBe(true)
    expect(h.activities).toEqual([{ chatId: h.chatId, requestId: 'q-single' }])
    expect(h.submitted).toEqual([{
      chatId: h.chatId,
      requestId: 'q-single',
      answers: { '选哪个库？': 'Axios' },
    }])
    expect(h.controller.hasPending(h.chatId)).toBe(false)
    expect(h.texts().some((text) => text.includes('已提交'))).toBe(true)
  })

  it('toggles multi-select options, shows selected buttons, and only submits after next', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi-select', multiSelectInput)
    expect(h.submitted).toEqual([])

    await h.click('缓存')
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(findButton(h.sent, '缓存').text).toContain('✓')

    await h.click('日志')
    expect(h.submitted).toEqual([])
    expect(findButton(h.sent, '日志').text).toContain('✓')
    expect(buttonsOf(h.sent).some((button) => /提交|下一题/.test(button.text))).toBe(true)

    await h.click(/提交|下一题/)
    expect(h.submitted).toEqual([{
      chatId: h.chatId,
      requestId: 'q-multi-select',
      answers: { '启用哪些能力？': '缓存, 日志' },
    }])
    expect(h.controller.hasPending(h.chatId)).toBe(false)
  })

  it('does not submit a multi-question request until every question is answered', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    const firstVersion = findButton(h.sent, 'React').callback_data

    await h.click('React')
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().join('\n')).toContain('数据库？')

    expect(await h.controller.handleCallback(h.callbackCtx(firstVersion), firstVersion)).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.callbackAnswers.some((text) => text && /失效|过期|无效/.test(text))).toBe(true)
  })

  it('submits every answer once from the summary', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    await h.click('React')
    await h.click('SQLite')
    expect(h.submitted).toEqual([])
    expect(h.texts().join('\n')).toMatch(/确认|摘要|全部答案/)

    await h.click('提交全部')
    expect(h.submitted).toEqual([{
      chatId: h.chatId,
      requestId: 'q-multi',
      answers: { '前端框架？': 'React', '数据库？': 'SQLite' },
    }])
    expect(h.controller.hasPending(h.chatId)).toBe(false)
  })

  it('accepts /answer with the original id and unique JSON without an id', async () => {
    const withId = createHarness()
    await withId.controller.receive(withId.chatId, 'q-single', singleQuestionInput)
    expect(await withId.controller.handleText({
      chatId: withId.chatId,
      text: '/answer q-single Axios',
      userId: withId.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(withId.submitted).toEqual([{
      chatId: withId.chatId,
      requestId: 'q-single',
      answers: { '选哪个库？': 'Axios' },
    }])

    const uniqueJson = createHarness()
    await uniqueJson.controller.receive(uniqueJson.chatId, 'q-multi', multiQuestionInput)
    expect(uniqueJson.controller.shouldHandleText({
      chatId: uniqueJson.chatId,
      text: '/answer {"前端框架？":"Vue","数据库？":"Postgres"}',
      hasOtherSelection: false,
    })).toBe(true)
    expect(await uniqueJson.controller.handleText({
      chatId: uniqueJson.chatId,
      text: '/answer {"前端框架？":"Vue","数据库？":"Postgres"}',
      userId: uniqueJson.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(uniqueJson.submitted).toEqual([{
      chatId: uniqueJson.chatId,
      requestId: 'q-multi',
      answers: { '前端框架？': 'Vue', '数据库？': 'Postgres' },
    }])
  })

  it('answers through reply-to even when another question is pending', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-first', singleQuestionInput)
    const firstMessageId = 10
    await h.controller.receive(h.chatId, 'q-second', {
      questions: [{ question: '第二题？', options: [{ label: 'A' }], multiSelect: false }],
    })
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-first', 'q-second'])

    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: 'Fetch',
      replyToMessageId: firstMessageId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Fetch',
      userId: h.userId,
      replyToMessageId: firstMessageId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([{
      chatId: h.chatId,
      requestId: 'q-first',
      answers: { '选哪个库？': 'Fetch' },
    }])
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-second'])
  })

  it('prompts for a focus target instead of guessing the latest request', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-first', singleQuestionInput)
    await h.controller.receive(h.chatId, 'q-second', multiQuestionInput)

    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: 'Axios',
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Axios',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.texts().some((text) => /点选|选择要回答/.test(text))).toBe(true)
    expect(buttonsOf(h.sent).some((button) => button.callback_data.includes(':f'))).toBe(true)

    const conflict = createHarness()
    await conflict.controller.receive(conflict.chatId, 'q-only', singleQuestionInput)
    expect(await conflict.controller.handleText({
      chatId: conflict.chatId,
      text: '1',
      userId: conflict.userId,
      hasOtherSelection: true,
    })).toBe(true)
    expect(conflict.submitted).toEqual([])
    expect(conflict.texts().some((text) => /点选|选择要回答|审批/.test(text))).toBe(true)
  })

  it('rejects unauthorized users, missing sessions, wrong chats, and stale versions', async () => {
    const unauthorized = createHarness({ allowed: false })
    await unauthorized.controller.receive(unauthorized.chatId, 'q-single', singleQuestionInput)
    const data = findButton(unauthorized.sent, 'Axios').callback_data
    expect(await unauthorized.controller.handleCallback(unauthorized.callbackCtx(data), data)).toBe(true)
    expect(unauthorized.submitted).toEqual([])
    expect(unauthorized.callbackAnswers.some((text) => text?.includes('未授权'))).toBe(true)

    const noSession = createHarness({ sessionId: 'session-1' })
    await noSession.controller.receive(noSession.chatId, 'q-single', singleQuestionInput)
    noSession.setSessionId(null)
    expect(await noSession.click('Axios')).toBe(true)
    expect(noSession.submitted).toEqual([])

    const wrongChat = createHarness()
    await wrongChat.controller.receive(wrongChat.chatId, 'q-single', singleQuestionInput)
    const wrongData = findButton(wrongChat.sent, 'Axios').callback_data
    expect(await wrongChat.controller.handleCallback(
      wrongChat.callbackCtx(wrongData, { chatId: 999 }),
      wrongData,
    )).toBe(true)
    expect(wrongChat.submitted).toEqual([])

    const stale = createHarness()
    await stale.controller.receive(stale.chatId, 'q-multi', multiQuestionInput)
    const old = findButton(stale.sent, 'React').callback_data
    await stale.click('React')
    expect(await stale.controller.handleCallback(stale.callbackCtx(old), old)).toBe(true)
    expect(stale.submitted).toEqual([])
  })

  it('keeps the draft and request when submit fails so the user can retry', async () => {
    let succeed = false
    const h = createHarness({ submit: () => succeed })
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    const oldAxios = findButton(h.sent, 'Axios').callback_data
    await h.click('Axios')
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().some((text) => /失败|重试/.test(text))).toBe(true)
    expect(h.texts().some((text) => /确认|摘要|全部答案/.test(text))).toBe(true)
    expect(buttonsOf(h.sent).some((button) => button.text.includes('提交全部'))).toBe(true)

    expect(await h.controller.handleCallback(h.callbackCtx(oldAxios), oldAxios)).toBe(true)
    expect(h.submitted).toHaveLength(1)
    expect(h.controller.hasPending(h.chatId)).toBe(true)

    succeed = true
    await h.click('提交全部')
    expect(h.submitted.at(-1)?.answers).toEqual({ '选哪个库？': 'Axios' })
    expect(h.controller.hasPending(h.chatId)).toBe(false)
  })

  it('does not reset a filled draft or resend cards when the same request is replayed', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    const sentAfterFirst = h.sent.length
    await h.click('React')
    const sentAfterChoice = h.sent.length
    expect(h.texts().join('\n')).toContain('数据库？')

    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    expect(h.sent.length).toBe(sentAfterChoice)
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-multi'])
    expect(h.texts().join('\n')).toContain('数据库？')
    expect(sentAfterFirst).toBeGreaterThan(0)
  })

  it('tombstones cards on clear/prune/remove and does not treat them as ordinary chat', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-keep', singleQuestionInput)
    await h.controller.receive(h.chatId, 'q-drop', multiQuestionInput)
    h.controller.prune(h.chatId, new Set(['q-keep']))
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-keep'])

    h.controller.remove(h.chatId, 'q-keep')
    expect(h.controller.hasPending(h.chatId)).toBe(false)
    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: 'Axios',
      replyToMessageId: 10,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Axios',
      userId: h.userId,
      replyToMessageId: 10,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.texts().some((text) => /失效|过期|无效/.test(text))).toBe(true)

    await h.controller.receive(h.chatId, 'q-clear', singleQuestionInput)
    h.controller.clear(h.chatId)
    expect(h.controller.hasPending(h.chatId)).toBe(false)
  })

  it('records activity on user interaction, never on receive, and does not claim cancel when activity fails', async () => {
    const h = createHarness({ activity: () => false })
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    expect(h.activities).toEqual([])

    await h.click('Axios')
    expect(h.activities).toEqual([{ chatId: h.chatId, requestId: 'q-single' }])
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().some((text) => /重试/.test(text))).toBe(true)
    expect(h.texts().some((text) => /已取消|已拒绝/.test(text))).toBe(false)

    const ok = createHarness()
    await ok.controller.receive(ok.chatId, 'q-single', singleQuestionInput)
    expect(await ok.controller.handleText({
      chatId: ok.chatId,
      text: '自己写',
      userId: ok.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(ok.activities).toEqual([{ chatId: ok.chatId, requestId: 'q-single' }])
    expect(ok.submitted[0]?.answers).toEqual({ '选哪个库？': '自己写' })
  })

  it('keeps unique ordinary text as a literal answer and ignores explicit non-answer commands', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: '1',
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: '/deny q-single',
      hasOtherSelection: false,
    })).toBe(false)
    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: '/new',
      hasOtherSelection: false,
    })).toBe(false)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/allow q-single',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(false)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '1',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted[0]?.answers).toEqual({ '选哪个库？': '1' })
  })

  it('prompts on empty, malformed, or incomplete JSON without clearing the draft', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    await h.click('React')

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer q-multi {not json',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer q-multi {"前端框架？":"Vue"}',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().filter((text) => /用法|无法识别|不完整|格式/.test(text)).length).toBeGreaterThan(0)

    await h.click('SQLite')
    await h.click('提交全部')
    expect(h.submitted[0]?.answers).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
  })

  it('does not submit after remove wins the race during an in-flight send', async () => {
    let release: ((value: { message_id: number }) => void) | undefined
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let sends = 0
    const h = createHarness({
      sendImpl: () => {
        sends += 1
        if (sends === 1) {
          started()
          return new Promise((resolve) => {
            release = resolve
          })
        }
        return Promise.resolve({ message_id: 80 + sends })
      },
    })
    const pendingReceive = h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    await startedPromise
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    h.controller.remove(h.chatId, 'q-single')
    release!({ message_id: 88 })
    await pendingReceive
    expect(h.controller.hasPending(h.chatId)).toBe(false)

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Axios',
      userId: h.userId,
      replyToMessageId: 88,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
  })

  it('enables free-text answering from the other button and keeps callback_data within 64 bytes', async () => {
    const h = createHarness()
    const longId = `q-${'x'.repeat(80)}`
    await h.controller.receive(h.chatId, longId, singleQuestionInput)
    for (const button of buttonsOf(h.sent)) {
      expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64)
    }
    await h.click('其他')
    expect(h.submitted).toEqual([])
    expect(h.texts().some((text) => /自由|文字/.test(text))).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '自己写',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted[0]).toEqual({
      chatId: h.chatId,
      requestId: longId,
      answers: { '选哪个库？': '自己写' },
    })
  })

  it('does not treat a reply to question 1 as an answer after question 2 arrives', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    const question1MessageId = 10
    await h.click('React')
    expect(h.submitted).toEqual([])
    expect(h.texts().join('\n')).toContain('数据库？')

    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: 'Vue',
      replyToMessageId: question1MessageId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Vue',
      userId: h.userId,
      replyToMessageId: question1MessageId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().some((text) => /过期/.test(text))).toBe(true)

    await h.click('Postgres')
    expect(h.texts().join('\n')).toMatch(/确认|摘要|全部答案/)
    expect(h.submitted).toEqual([])
  })

  it('does not submit a partial ordinary-text answer for a multi-question request', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'React',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().join('\n')).toContain('数据库？')

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer q-multi Vue',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().join('\n')).toMatch(/确认|摘要|全部答案/)
  })

  it('does not auto-submit on edit, back, or focus after a failed single-question send', async () => {
    let succeed = false
    const h = createHarness({ submit: () => succeed })
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    await h.click('Axios')
    expect(h.submitted).toHaveLength(1)
    expect(h.controller.hasPending(h.chatId)).toBe(true)

    await h.click('修改 1')
    expect(h.submitted).toHaveLength(1)
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.texts().join('\n')).toContain('选哪个库？')

    await h.click('Axios')
    expect(h.submitted).toHaveLength(2)
    expect(h.controller.hasPending(h.chatId)).toBe(true)

    await h.click('上一题')
    expect(h.submitted).toHaveLength(2)
    expect(h.controller.hasPending(h.chatId)).toBe(true)

    await h.controller.receive(h.chatId, 'q-other', multiQuestionInput)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'Axios',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    const focus = findButton(h.sent, '选哪个库？')
    expect(focus.callback_data.includes(':f')).toBe(true)
    expect(await h.controller.handleCallback(h.callbackCtx(focus.callback_data), focus.callback_data)).toBe(true)
    expect(h.submitted).toHaveLength(2)
    expect(h.controller.requestIds(h.chatId)).toContain('q-single')
  })

  it('does not submit a multi-question request from a forged choose action on the summary', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    await h.click('React')
    await h.click('SQLite')
    const submit = findButton(h.sent, '提交全部')
    const forged = submit.callback_data.replace(/:s$/, ':c:0')
    expect(await h.controller.handleCallback(
      h.callbackCtx(forged, { messageId: submit.messageId }),
      forged,
    )).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.callbackAnswers.some((text) => text && /无法选择|无效/.test(text))).toBe(true)
  })

  it('rejects illegal callback actions and negative indexes without submitting', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    const valid = findButton(h.sent, 'Axios').callback_data
    const prefix = valid.split(':').slice(0, 3).join(':')
    expect(await h.controller.handleCallback(h.callbackCtx(`${prefix}:z`), `${prefix}:z`)).toBe(true)
    expect(await h.controller.handleCallback(h.callbackCtx(`${prefix}:c:-1`), `${prefix}:c:-1`)).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(h.callbackAnswers.filter((text) => text === '无效操作').length).toBeGreaterThanOrEqual(2)
  })

  it('splits a long question across messages and binds every chunk to the current version', async () => {
    const h = createHarness()
    const longQuestion = `长问题 ${'x'.repeat(5000)}`
    await h.controller.receive(h.chatId, 'q-long', {
      questions: [{ question: longQuestion, options: [{ label: 'A' }], multiSelect: false }],
    })
    const questionMessages = h.sent.filter((item) => item.text.includes('长问题') || item.text.includes('x'.repeat(20)))
    expect(questionMessages.length).toBeGreaterThanOrEqual(2)
    for (const message of questionMessages) {
      expect(message.text.length).toBeLessThanOrEqual(4000)
    }
    expect(h.texts().join('')).toContain('x'.repeat(5000))
    expect(questionMessages.at(-1)?.options?.reply_markup).toBeDefined()
    for (const message of questionMessages.slice(0, -1)) {
      expect(message.options?.reply_markup).toBeUndefined()
    }

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: 'A',
      userId: h.userId,
      replyToMessageId: 10,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([{
      chatId: h.chatId,
      requestId: 'q-long',
      answers: { [longQuestion]: 'A' },
    }])
  })

  it('does not overwrite an earlier question body when stripping the old keyboard', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    await h.click('React')
    const overwritten = h.edited.filter((item) => item.messageId === 10)
    expect(overwritten.length).toBeGreaterThan(0)
    expect(overwritten.every((item) => item.text.includes('前端框架？'))).toBe(true)
    expect(overwritten.some((item) => item.text.includes('数据库？'))).toBe(false)

    const markup = createHarness({ withReplyMarkup: true })
    await markup.controller.receive(markup.chatId, 'q-multi', multiQuestionInput)
    await markup.click('React')
    expect(markup.markupEdits.some((item) => item.messageId === 10)).toBe(true)
    expect(markup.edited.some((item) => item.messageId === 10)).toBe(false)
  })

  it('retains all JSON answers in a retry summary when submission fails', async () => {
    let succeed = false
    const h = createHarness({ submit: () => succeed })
    await h.controller.receive(h.chatId, 'q-json', multiQuestionInput)
    await h.controller.handleText({
      chatId: h.chatId, text: '/answer {"1":"React","2":"SQLite"}',
      userId: h.userId, hasOtherSelection: false,
    })
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    expect(findButton(h.sent, '提交全部')).toBeDefined()
    succeed = true
    await h.click('提交全部')
    expect(h.submitted).toHaveLength(2)
    expect(h.submitted[1]?.answers).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
  })

  it('does not assign an unbound reply to the only current request after old bindings expire', async () => {
    const h = createHarness()
    for (let index = 0; index < 129; index += 1) {
      await h.controller.receive(h.chatId, `old-${index}`, singleQuestionInput)
      h.controller.remove(h.chatId, `old-${index}`)
    }
    await h.controller.receive(h.chatId, 'current', singleQuestionInput)
    expect(h.controller.shouldHandleText({
      chatId: h.chatId, text: 'Axios', replyToMessageId: 10, hasOtherSelection: false,
    })).toBe(false)
    expect(await h.controller.handleText({
      chatId: h.chatId, text: 'Axios', userId: h.userId,
      replyToMessageId: 10, hasOtherSelection: false,
    })).toBe(false)
    expect(h.submitted).toEqual([])
    expect(h.controller.requestIds(h.chatId)).toEqual(['current'])
  })

  it('uses an explicit request ID ahead of the replied question message', async () => {
    const h = createHarness()
    await h.controller.receive(h.chatId, 'q-a', singleQuestionInput)
    const a = findButton(h.sent, 'Axios')
    await h.controller.receive(h.chatId, 'q-b', singleQuestionInput)
    await h.controller.handleText({
      chatId: h.chatId, text: '/answer q-b Fetch', userId: h.userId,
      replyToMessageId: a.messageId, hasOtherSelection: false,
    })
    expect(h.submitted[0]?.requestId).toBe('q-b')
    expect(h.controller.requestIds(h.chatId)).toEqual(['q-a'])
  })

  it('does not consume text when the initial question card failed to send', async () => {
    let fail = true
    const h = createHarness({
      sendImpl: async () => {
        if (fail) throw new Error('offline')
        return { message_id: 30 }
      },
    })
    await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
    fail = false
    expect(await h.controller.handleText({
      chatId: h.chatId, text: '普通聊天', userId: h.userId, hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.controller.hasPending(h.chatId)).toBe(true)
    await h.click('Axios')
    expect(h.submitted[0]?.answers).toEqual({ '选哪个库？': 'Axios' })
  })

  it('resends a failed next-question card without consuming the recovery text', async () => {
    let failNext = true
    let messageId = 20
    const h = createHarness({
      sendImpl: async (_id, text, extra) => {
        if (failNext && text.includes('数据库？') && extra?.reply_markup) throw new Error('offline')
        return { message_id: messageId++ }
      },
    })
    await h.controller.receive(h.chatId, 'q-multi', multiQuestionInput)
    await h.click('React')
    failNext = false
    await h.controller.handleText({
      chatId: h.chatId, text: '别把这句当答案', userId: h.userId, hasOtherSelection: false,
    })
    expect(h.submitted).toEqual([])
    await h.click('SQLite')
    await h.click('提交全部')
    expect(h.submitted[0]?.answers).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
  })

  it('keeps partial long-card delivery unavailable until its final keyboard is sent', async () => {
    let failLast = true
    let messageId = 40
    const h = createHarness({
      sendImpl: async (_id, _text, extra) => {
        if (failLast && extra?.reply_markup) throw new Error('offline')
        return { message_id: messageId++ }
      },
    })
    const question = `长问题 ${'x'.repeat(5000)}`
    const input = { questions: [{ question, options: [{ label: 'A' }] }] }
    await h.controller.receive(h.chatId, 'q-long', input)
    failLast = false
    await h.controller.handleText({
      chatId: h.chatId, text: '普通聊天', userId: h.userId, hasOtherSelection: false,
    })
    expect(h.submitted).toEqual([])
    await h.click('A')
    expect(h.submitted[0]?.answers).toEqual({ [question]: 'A' })
  })

  for (const rejected of [false, true]) {
    it(`keeps an actionable retry summary after submission ${rejected ? 'rejects' : 'throws'}`, async () => {
      let fail = true
      const h = createHarness({
        submit: () => {
          if (!fail) return true
          if (rejected) return Promise.reject(new Error('offline'))
          throw new Error('offline')
        },
      })
      await h.controller.receive(h.chatId, 'q-single', singleQuestionInput)
      await h.click('Axios')
      expect(h.controller.hasPending(h.chatId)).toBe(true)
      expect(findButton(h.sent, '提交全部')).toBeDefined()
      fail = false
      await h.click('提交全部')
      expect(h.submitted).toHaveLength(2)
      expect(h.submitted[1]?.answers).toEqual({ '选哪个库？': 'Axios' })
      expect(h.controller.hasPending(h.chatId)).toBe(false)
    })
  }

  it('handles /answer with no pending request instead of falling through to chat', async () => {
    const h = createHarness()
    expect(h.controller.shouldHandleText({
      chatId: h.chatId,
      text: '/answer {"前端框架？":"Vue"}',
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer {"前端框架？":"Vue"}',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer Axios',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.submitted).toEqual([])
    expect(h.texts().filter((text) => /没有待答|没有待回答/.test(text)).length).toBeGreaterThanOrEqual(2)

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer missing-id Axios',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    expect(h.texts().some((text) => text.includes('未找到待回答的问题请求'))).toBe(true)

    expect(await h.controller.handleText({
      chatId: h.chatId,
      text: '/answer',
      userId: h.userId,
      hasOtherSelection: false,
    })).toBe(true)
    const usage = h.texts().filter((text) => text.includes('用法'))
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((text) => !text.includes('请求ID'))).toBe(true)
  })
})