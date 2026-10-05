import { afterEach, describe, expect, test, mock, spyOn } from 'bun:test'
import { conversationService } from './conversationService.js'
import { sessionService } from './sessionService.js'
import { computerUseApprovalService } from './computerUseApprovalService.js'
import {
  beginSessionTurn, clearSessionTurnContext, emitSessionTurnEvent,
  getSessionTurnContext, getSessionPermissionOrigin, observeSessionTurns,
  type SessionTurnEvent, type SessionTurnOrigin,
} from './sessionTurnEvents.js'
import {
  __resetWebSocketHandlerStateForTests, handleWebSocket,
  submitHumanSessionTurn, submitSessionTurn, respondToSessionPermission, respondToSessionComputerUsePermission,
  type WebSocketData,
} from '../ws/handler.js'

const origin: SessionTurnOrigin = {
  entrypoint: 'telegram-public', botId: 42, generation: 1,
  userId: 7, chatId: '7', turnId: 'input-100',
}

function socket(sessionId: string, dedicated = false) {
  const sent: any[] = []
  const data: WebSocketData = {
    sessionId, channel: 'client', connectedAt: Date.now(), sdkToken: null,
    serverHost: '127.0.0.1', serverPort: 1234,
    ...(dedicated ? { imOrigin: { entrypoint: 'telegram-dedicated' as const, chatId: '7' } } : {}),
  }
  return { data, sent, send: mock((raw: string) => { sent.push(JSON.parse(raw)); return 1 }), close: mock(() => {}) }
}

function fixture() {
  const callbacks = new Set<(message: any) => void>()
  spyOn(sessionService, 'shouldPersistSession').mockReturnValue(false)
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Telegram regression')
  spyOn(conversationService, 'hasSession').mockReturnValue(true)
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'onOutput').mockImplementation((_id, cb) => { callbacks.add(cb) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, cb) => { callbacks.delete(cb) })
  return callbacks
}

async function ticks() { for (let i = 0; i < 80; i++) await Promise.resolve() }

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  for (const id of ['telegram-human', 'telegram-origins', 'telegram-permission', 'telegram-other']) clearSessionTurnContext(id)
  mock.restore()
})

describe('Telegram human input and entry ownership', () => {
  test('uses normal human delivery without a renderer or collaboration envelope', async () => {
    const callbacks = fixture()
    const send = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    const control = spyOn(conversationService, 'requestControl')
    const events: SessionTurnEvent[] = []
    const unobserve = observeSessionTurns(event => { events.push(event) })
    try {
      await submitHumanSessionTurn('telegram-human', '补一个测试', {
        serverHost: '127.0.0.1', serverPort: 1234, inputId: 'input-100', origin,
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.slice(0, 2)).toEqual(['telegram-human', '补一个测试'])
      expect(control).not.toHaveBeenCalled()
      expect(events.find(event => event.type === 'input-committed')?.origin).toMatchObject({ entrypoint: 'telegram-public', botId: 42 })
      await expect(submitHumanSessionTurn('telegram-human', '重复', {
        serverHost: '127.0.0.1', serverPort: 1234, inputId: 'input-101', origin,
      })).rejects.toThrow('active turn')
      for (const callback of [...callbacks]) callback({ type: 'result', uuid: 'result-100', result: '完成', is_error: false })
      await ticks()
      expect(events.find(event => event.type === 'output' && event.message.type === 'result')?.eventId).toBe('telegram-human:result-100')
      expect(events.find(event => event.type === 'output' && event.message.type === 'result')?.origin?.entrypoint).toBe('telegram-public')
    } finally { unobserve() }
  })

  test('keeps desktop output while suppressing public-origin text and approvals in dedicated Bot', async () => {
    const callbacks = fixture()
    const desktop = socket('telegram-origins')
    const dedicated = socket('telegram-origins', true)
    handleWebSocket.open(desktop)
    handleWebSocket.open(dedicated)
    desktop.sent.length = 0
    dedicated.sent.length = 0
    beginSessionTurn('telegram-origins', origin)
    for (const callback of [...callbacks]) callback({ type: 'assistant', message: { content: [{ type: 'text', text: '只回公共入口' }] } })
    await ticks()
    expect(desktop.sent.some(message => message.type === 'content_delta' && message.text === '只回公共入口')).toBe(true)
    expect(dedicated.sent.some(message => message.type === 'content_delta')).toBe(false)
    emitSessionTurnEvent({ type: 'output', sessionId: 'telegram-origins', message: { type: 'control_request', request_id: 'request-public', request: { subtype: 'can_use_tool' } } })
    const respond = spyOn(conversationService, 'respondToPermission').mockReturnValue(true)
    handleWebSocket.message(dedicated, JSON.stringify({ type: 'permission_response', requestId: 'request-public', allowed: true }))
    expect(respond).not.toHaveBeenCalled()
    expect(dedicated.sent).toContainEqual({ type: 'error', code: 'IM_ROUTE_DENIED', message: '该操作属于公共入口，请在那里或桌面处理。' })
    handleWebSocket.message(desktop, JSON.stringify({ type: 'permission_response', requestId: 'request-public', allowed: true }))
    expect(respond).toHaveBeenCalledTimes(1)
  })

  test('rejects a dedicated clear command while a public human turn is active', async () => {
    fixture()
    spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    const stop = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    await submitHumanSessionTurn('telegram-human', '先完成这轮', {
      serverHost: '127.0.0.1', serverPort: 1234, inputId: 'input-100', origin,
    })
    const dedicated = socket('telegram-human', true)
    handleWebSocket.open(dedicated)
    dedicated.sent.length = 0
    handleWebSocket.message(dedicated, JSON.stringify({ type: 'user_message', content: '/clear' }))
    await ticks()
    expect(stop).not.toHaveBeenCalled()
    expect(dedicated.sent.some(message => message.type === 'error' && message.code === 'SESSION_BUSY')).toBe(true)
    expect(getSessionTurnContext('telegram-human')?.origin.entrypoint).toBe('telegram-public')
  })

  test('does not inherit public human ownership when an existing background turn follows', async () => {
    const callbacks = fixture()
    spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(conversationService, 'requestControl').mockResolvedValue({ status: 'queued' })
    const events: SessionTurnEvent[] = []
    const unobserve = observeSessionTurns(event => { events.push(event) })
    try {
      await submitHumanSessionTurn('telegram-human', '公共输入', {
        serverHost: '127.0.0.1', serverPort: 1234, inputId: 'input-100', origin,
      })
      for (const callback of [...callbacks]) callback({ type: 'result', uuid: 'public-done', result: '完成', is_error: false })
      await ticks()
      await submitSessionTurn('telegram-human', '已有后台消息', {
        serverHost: '127.0.0.1', serverPort: 1234, messageId: 'background-next', sourceSessionId: 'root',
      })
      for (const callback of [...callbacks]) callback({ type: 'control_request', request_id: 'background-permission', request: { subtype: 'can_use_tool' } })
      await ticks()
      const request = events.find(event => event.type === 'output' && event.message.request_id === 'background-permission')
      expect(request).toBeDefined()
      expect(request?.origin).toBeUndefined()
      expect(getSessionPermissionOrigin('telegram-human', 'background-permission')).toBeUndefined()
    } finally { unobserve() }
  })

  test('captures immutable event source and permission source before the next turn', () => {
    const events: SessionTurnEvent[] = []
    const unobserve = observeSessionTurns(event => { events.push(event) })
    try {
      beginSessionTurn('telegram-origins', origin)
      const message = { type: 'control_request', request_id: 'request-public', request: { subtype: 'can_use_tool' } }
      emitSessionTurnEvent({ type: 'output', sessionId: 'telegram-origins', message })
      const captured = getSessionTurnContext('telegram-origins')
      beginSessionTurn('telegram-origins', { entrypoint: 'desktop', turnId: 'desktop-next' })
      emitSessionTurnEvent({ type: 'output', sessionId: 'telegram-origins', message: { type: 'result', uuid: 'old-result' }, ...captured })
      expect(events[1]?.origin?.entrypoint).toBe('telegram-public')
      expect(getSessionPermissionOrigin('telegram-origins', 'request-public')?.entrypoint).toBe('telegram-public')
    } finally { unobserve() }
  })

  test('resolves tool requests once and rejects Computer Use responses for another session', async () => {
    fixture()
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{ requestId: 'p1', toolName: 'Bash', input: {} }])
    const respond = spyOn(conversationService, 'respondToPermission').mockReturnValueOnce(true).mockReturnValue(false)
    expect(await respondToSessionPermission('telegram-permission', { requestId: 'p1', allowed: true })).toBe(true)
    expect(await respondToSessionPermission('telegram-permission', { requestId: 'p1', allowed: true })).toBe(false)
    expect(respond).toHaveBeenCalledTimes(2)
    spyOn(computerUseApprovalService, 'getPendingRequests').mockImplementation(id => id === 'telegram-permission' ? [{ requestId: 'cu1' } as any] : [])
    const resolve = spyOn(computerUseApprovalService, 'resolveApproval').mockReturnValue(true)
    const response = { granted: [], denied: [], flags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false }, userConsented: false }
    expect(await respondToSessionComputerUsePermission('telegram-other', 'cu1', response)).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(await respondToSessionComputerUsePermission('telegram-permission', 'cu1', response)).toBe(true)
  })
})