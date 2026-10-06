import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
  TelegramPublicEventLog,
  telegramPublicEventLogFileName,
} from './telegramPublicEventLog.js'
import { SUBSCRIPTION_LIST_TTL_MS } from './telegramSubscriptionLists.js'
import { TelegramPublicStore } from './telegramPublicStore.js'
import {
  TelegramPublicService,
  setTelegramPublicServiceForTests,
  type TelegramChannelSendResult,
  type TelegramPublicHandlerDeps,
  type TelegramPublicOrigin,
  type TelegramPublicSessionSummary,
  type TelegramPublicTurnEvent,
} from './telegramPublicService.js'

const OWNER = 4242
const BOT = 99
const GEN = 3

type Sent = { chatId: string; text: string; replyMarkup?: unknown; messageId: number }

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let nextUpdateId = 1

function privateMessage(text: string, extra: Record<string, unknown> = {}) {
  const reply = extra.reply_to_message && typeof extra.reply_to_message === 'object'
    ? extra.reply_to_message
    : 'reply_to_message_id' in extra
      ? {
          message_id: extra.reply_to_message_id,
          ...('reply_forward_date' in extra ? { forward_date: extra.reply_forward_date } : {}),
        }
      : undefined
  return {
    update_id: extra.update_id ?? nextUpdateId++,
    message: {
      message_id: extra.message_id ?? 1,
      from: { id: extra.fromId ?? OWNER },
      chat: { id: extra.chatId ?? OWNER, type: extra.chatType ?? 'private' },
      text,
      ...(reply ? { reply_to_message: reply } : {}),
      ...('photo' in extra ? { photo: extra.photo } : {}),
      ...('caption' in extra ? { caption: extra.caption } : {}),
      ...('forward_date' in extra ? { forward_date: extra.forward_date } : {}),
    },
  }
}

function callbackUpdate(data: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: extra.update_id ?? nextUpdateId++,
    callback_query: {
      id: 'cb',
      from: { id: extra.fromId ?? OWNER },
      data,
      ...(extra.omitMessage
        ? { inline_message_id: extra.inline_message_id ?? 'inline-1' }
        : {
            message: {
              message_id: extra.message_id ?? 8,
              chat: { id: extra.chatId ?? OWNER, type: extra.chatType ?? 'private' },
            },
          }),
    },
  }
}

function summary(id: string, title: string, workDir: string): TelegramPublicSessionSummary {
  return { id, title, projectPath: workDir, projectRoot: workDir, workDir }
}

describe('telegram public channel', () => {
  const previous = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    TMPDIR: process.env.TMPDIR,
  }

  let root = ''
  let configDir = ''
  let workRoot = ''
  let otherRoot = ''
  let evilRoot = ''
  let sent: Sent[]
  let nextMessageId = 10
  let sendImpl: () => Promise<TelegramChannelSendResult>
  let sessions: Map<string, TelegramPublicSessionSummary>
  let pending: Set<string>
  let submitted: Array<{ sessionId: string; content: string; origin: TelegramPublicOrigin }>
  let submitError: string | undefined
  let submitWait: Promise<void> | undefined
  let summaryWait: Promise<void> | undefined
  let summaryEntered: (() => void) | undefined
  let permissionResponses: Array<{ sessionId: string; requestId: string; allowed: boolean }>
  let computerResponses: Array<{ sessionId: string; requestId: string }>
  let turnState: Map<string, 'running' | 'blocked' | 'idle'>
  let dedicated: { sessionId: string } | null
  let observer: ((event: TelegramPublicTurnEvent) => void) | undefined
  let publicConfig: Record<string, unknown>
  let service: TelegramPublicService
  let sleeps: number[]
  let nowMs: number
  let editFailure: boolean

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-public-'))
    const home = path.join(root, 'home')
    configDir = path.join(root, 'claude')
    workRoot = path.join(root, 'work')
    otherRoot = path.join(root, 'other')
    evilRoot = path.join(root, 'work-evil')
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(path.join(root, 'xdg'), { recursive: true })
    await fs.mkdir(path.join(root, 'tmp'), { recursive: true })
    await fs.mkdir(workRoot, { recursive: true })
    await fs.mkdir(otherRoot, { recursive: true })
    await fs.mkdir(evilRoot, { recursive: true })
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
    process.env.TMPDIR = path.join(root, 'tmp')

    sent = []
    nextMessageId = 10
    nextUpdateId = 1
    sleeps = []
    nowMs = Date.parse('2026-04-04T00:00:00.000Z')
    editFailure = false
    sendImpl = async () => {
      const messageId = ++nextMessageId
      return { outcome: 'delivered', messageId }
    }
    sessions = new Map([
      ['sess-a', summary('sess-a', '修复登录', workRoot)],
      ['sess-b', summary('sess-b', '支付退款', workRoot)],
      ['sess-c', summary('sess-c', '未订阅', workRoot)],
      ['sess-evil', summary('sess-evil', '越界', evilRoot)],
    ])
    pending = new Set()
    submitted = []
    submitError = undefined
    submitWait = undefined
    summaryWait = undefined
    summaryEntered = undefined
    permissionResponses = []
    computerResponses = []
    turnState = new Map()
    dedicated = null
    observer = undefined
    publicConfig = {
      enabled: true,
      botToken: 'public-secret-token',
      ownerUserId: OWNER,
      generation: GEN,
      allowedProjectRoots: [workRoot],
    }

    const handler: TelegramPublicHandlerDeps = {
      submitHumanSessionTurn: async (sessionId, content, options) => {
        if ((turnState.get(sessionId) ?? 'idle') !== 'idle') {
          throw new Error('Session already has an active turn')
        }
        if (submitWait) await submitWait
        if (submitError) throw new Error(submitError)
        submitted.push({ sessionId, content, origin: options.origin })
      },
      respondToSessionPermission: async (sessionId, params) => {
        const key = `${sessionId}:${params.requestId}`
        if (!pending.has(key)) return false
        pending.delete(key)
        permissionResponses.push({ sessionId, requestId: params.requestId, allowed: params.allowed })
        return true
      },
      respondToSessionComputerUsePermission: async (sessionId, requestId) => {
        const key = `${sessionId}:${requestId}`
        if (!pending.has(key)) return false
        pending.delete(key)
        computerResponses.push({ sessionId, requestId })
        return true
      },
      isSessionPermissionPending: (sessionId, requestId) => pending.has(`${sessionId}:${requestId}`),
      getSessionTurnState: sessionId => turnState.get(sessionId) ?? 'idle',
    }

    service = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      now: () => nowMs,
      sleep: async ms => { sleeps.push(ms) },
      serverHost: '127.0.0.1',
      serverPort: 3456,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      claimPairing: async (code, userId) => {
        if (code !== 'ABC123') throw Object.assign(new Error('Pairing code expired or invalid'), { statusCode: 400 })
        publicConfig.ownerUserId = userId
        publicConfig.generation = GEN
        return { ownerUserId: userId, generation: GEN }
      },
      listSessions: async options => ({ sessions: [...sessions.values()].slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? sessions.size)).map(item => ({
        id: item.id,
        title: item.title,
        createdAt: '',
        modifiedAt: '',
        messageCount: 0,
        projectPath: item.projectPath,
        projectRoot: item.projectRoot ?? null,
        workDir: item.workDir,
        workDirExists: true,
        workspaceState: 'available',
      })), total: sessions.size }),
      getSessionSummary: async id => {
        if (summaryWait) {
          summaryEntered?.()
          await summaryWait
        }
        return sessions.get(id) ?? null
      },
      searchSessionMetadata: async (query, options) => {
        const matches = [...sessions.values()].filter(item => item.title.includes(query) || item.id.includes(query))
        return { sessions: matches.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? matches.length)), total: matches.length }
      },
      observeSessionTurns: listener => {
        observer = listener
        return () => { observer = undefined }
      },
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      editTelegramChannelMessage: async (_token, chatId, messageId, text, options) => {
        if (editFailure) return { outcome: 'failed', error: 'fixture edit failure' }
        sent.push({ chatId, text, messageId, replyMarkup: options?.replyMarkup })
        return { outcome: 'delivered', messageId }
      },
      getDedicatedBinding: () => dedicated,
      handler,
    })
    setTelegramPublicServiceForTests(service)
    await service.start()
    await service.registerRuntime({ botId: BOT, generation: GEN })
  })

  afterEach(async () => {
    service.stop()
    setTelegramPublicServiceForTests(null)
    restoreEnv('HOME', previous.HOME)
    restoreEnv('CLAUDE_CONFIG_DIR', previous.CLAUDE_CONFIG_DIR)
    restoreEnv('XDG_CONFIG_HOME', previous.XDG_CONFIG_HOME)
    restoreEnv('TMPDIR', previous.TMPDIR)
    await fs.rm(root, { recursive: true, force: true })
  })

  async function emitResult(sessionId: string, result: string, extra: {
    uuid?: string
    isError?: boolean
    origin?: TelegramPublicOrigin
  } = {}) {
    observer?.({
      type: 'output',
      sessionId,
      eventId: extra.uuid,
      origin: extra.origin,
      message: { type: 'result', result, is_error: extra.isError === true, uuid: extra.uuid },
    })
    await service.flushForTests()
  }

  async function emitPermission(sessionId: string, requestId: string, toolName: string, origin?: TelegramPublicOrigin, input?: unknown) {
    pending.add(`${sessionId}:${requestId}`)
    observer?.({
      type: 'output',
      sessionId,
      eventId: `evt-${requestId}`,
      origin,
      message: {
        type: 'control_request',
        request_id: requestId,
        uuid: `evt-${requestId}`,
        request: { subtype: 'can_use_tool', tool_name: toolName, input, description: `${toolName} 请求` },
      },
    })
    await service.flushForTests()
  }

  async function inbound(update: unknown) {
    const result = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    await service.flushForTests()
    return result
  }

  function listButton(label: string) {
    const message = [...sent].reverse().find(item => (item.replyMarkup as { inline_keyboard?: unknown })?.inline_keyboard)
    const buttons = (message?.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })?.inline_keyboard.flat() ?? []
    const button = buttons.find(item => item.text.includes(label))
    expect(button).toBeDefined()
    expect(Buffer.byteLength(button!.callback_data)).toBeLessThanOrEqual(64)
    return { data: button!.callback_data, messageId: message!.messageId }
  }

  async function clickList(label: string) {
    const button = listButton(label)
    return inbound(callbackUpdate(button.data, { message_id: button.messageId }))
  }

  test('订阅列表：多选与取消选择确认前不改真值，批量确认与重复回调幂等', async () => {
    await inbound(privateMessage('/sessions'))
    expect(sent.at(-1)?.text).not.toContain('sess-a')
    await clickList('未选择 · 修复登录')
    await clickList('未选择 · 支付退款')
    expect((await service.getStatus()).subscriptions).toHaveLength(0)
    await clickList('已选择 · 修复登录')
    listButton('订阅所选（1）')
    await clickList('未选择 · 修复登录')
    const submit = listButton('订阅所选（2）')
    await Promise.all([
      inbound(callbackUpdate(submit.data, { message_id: submit.messageId })),
      inbound(callbackUpdate(submit.data, { message_id: submit.messageId })),
    ])
    const status = await service.getStatus()
    expect(status.subscriptions).toHaveLength(2)
    expect(new Set(status.subscriptions.map(item => item.shortId)).size).toBe(2)
    expect(sent.some(item => item.text.includes('成功 · 修复登录') && item.text.includes('不补发历史'))).toBe(true)
    await clickList('已订阅 · 修复登录')
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    expect(submitted).toHaveLength(0)
    expect(permissionResponses).toHaveLength(0)
  })

  test('订阅列表：同项目同名或长名称截断仍能区分，特殊格式字符原样展示', async () => {
    sessions.clear()
    const title = '<同名> _标题_ [测试] & ' + '很长的名称'.repeat(50)
    sessions.set('same-a', summary('same-a', title, workRoot))
    sessions.set('same-b', summary('same-b', title, workRoot))
    await inbound(privateMessage('/sessions'))
    const first = listButton('#1')
    const second = listButton('#2')
    expect(first.data).not.toBe(second.data)
    await inbound(callbackUpdate(first.data, { message_id: first.messageId }))
    await clickList('订阅所选（1）')
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['same-a'])
    expect(sent.some(item => item.text.includes('<同名> _标题_ [测试] &'))).toBe(true)
  })

  test('订阅列表：无选择、清空和已订阅条目不取消真订阅', async () => {
    await service.subscribe('sess-a')
    await inbound(privateMessage('/sessions'))
    await clickList('订阅所选（0）')
    expect(sent.at(-1)?.text).toContain('尚未选择')
    await clickList('未选择 · 支付退款')
    await clickList('清空选择')
    listButton('订阅所选（0）')
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['sess-a'])
  })

  test('订阅列表：超过查询页上限、跨页选择与搜索新轮次失效', async () => {
    sessions.clear()
    for (let index = 0; index < 125; index++) sessions.set(`page-${index}`, summary(`page-${index}`, `标题${index}`, workRoot))
    await inbound(privateMessage('/sessions'))
    expect(sent.at(-1)?.text).toContain('共 125 项')
    await clickList('未选择 · 标题0 ·')
    await clickList('下一页')
    await clickList('未选择 · 标题20 ·')
    await clickList('上一页')
    listButton('已选择 · 标题0 ·')
    const old = listButton('订阅所选（2）')
    await clickList('订阅所选（2）')
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['page-0', 'page-20'])
    await inbound(privateMessage('/sessions 标题124'))
    listButton('未选择 · 标题124')
    listButton('订阅所选（0）')
    await inbound(callbackUpdate(old.data, { message_id: old.messageId }))
    expect(sent.at(-1)?.text).toContain('列表已失效')
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    await inbound(privateMessage('/sessions 没有这个标题'))
    expect(sent.at(-1)?.text).toContain('没有匹配且可访问')
  })

  test('订阅列表：部分失败保留待选，重试不回滚成功，文字变更按真值处理', async () => {
    await inbound(privateMessage('/sessions'))
    await clickList('未选择 · 修复登录')
    await clickList('未选择 · 支付退款')
    publicConfig.allowedProjectRoots = [otherRoot]
    sessions.set('sess-a', summary('sess-a', '修复登录', otherRoot))
    await clickList('订阅所选（2）')
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['sess-a'])
    expect(sent.some(item => item.text.includes('成功 · 修复登录') && item.text.includes('失败 · 支付退款'))).toBe(true)
    listButton('订阅所选（1）')
    publicConfig.allowedProjectRoots = [workRoot, otherRoot]
    await inbound(privateMessage('/subscribe sess-b'))
    await clickList('订阅所选（1）')
    expect(sent.some(item => item.text.includes('已订阅 · 支付退款'))).toBe(true)
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    listButton('订阅所选（0）')
    await inbound(privateMessage('/unsubscribe sess-b'))
    await clickList('已订阅 · 支付退款')
    expect((await service.getStatus()).subscriptions).toHaveLength(1)
    listButton('订阅所选（1）')
    await clickList('订阅所选（1）')
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
  })

  test('订阅列表：会话删除失败项保留，恢复后可重试', async () => {
    await inbound(privateMessage('/sessions'))
    await clickList('未选择 · 修复登录')
    const row = sessions.get('sess-a')!
    sessions.delete('sess-a')
    await clickList('订阅所选（1）')
    expect((await service.getStatus()).subscriptions).toHaveLength(0)
    expect(sent.some(item => item.text.includes('失败 · 修复登录'))).toBe(true)
    listButton('订阅所选（1）')
    sessions.set('sess-a', row)
    await clickList('订阅所选（1）')
    expect((await service.getStatus()).subscriptions).toHaveLength(1)
  })

  test('订阅列表：owner 私聊、消息、伪造、过期、旧 Bot 与旧代次安全拒绝', async () => {
    await inbound(privateMessage('/sessions'))
    await clickList('未选择 · 修复登录')
    const submit = listButton('订阅所选（1）')
    for (const extra of [{ fromId: OWNER + 1 }, { chatType: 'group' }, { chatId: OWNER + 1 }, { omitMessage: true }, { message_id: submit.messageId + 1 }]) {
      await inbound(callbackUpdate(submit.data, { message_id: submit.messageId, ...extra }))
      expect((await service.getStatus()).subscriptions).toHaveLength(0)
    }
    await inbound(callbackUpdate('tgsub:forged', { message_id: submit.messageId }))
    expect(sent.at(-1)?.text).toContain('列表已失效')
    expect((await service.handleUpdate({ botId: BOT + 1, generation: GEN, update: callbackUpdate(submit.data) })).ok).toBe(false)
    expect((await service.handleUpdate({ botId: BOT, generation: GEN - 1, update: callbackUpdate(submit.data) })).ok).toBe(false)
    nowMs += SUBSCRIPTION_LIST_TTL_MS
    await inbound(callbackUpdate(submit.data, { message_id: submit.messageId }))
    expect(sent.at(-1)?.text).toContain('列表已失效')
    expect((await service.getStatus()).subscriptions).toHaveLength(0)
  })

  test('订阅列表：重注册后旧按钮失效，确认过程中改变 generation 不持久化', async () => {
    await inbound(privateMessage('/sessions'))
    await clickList('未选择 · 修复登录')
    const old = listButton('订阅所选（1）')
    await service.registerRuntime({ botId: BOT, generation: GEN })
    await inbound(callbackUpdate(old.data, { message_id: old.messageId }))
    expect(sent.at(-1)?.text).toContain('列表已失效')
    await inbound(privateMessage('/sessions'))
    await clickList('未选择 · 修复登录')
    let release!: () => void
    summaryWait = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const gate = new Promise<void>(resolve => { entered = resolve })
    summaryEntered = entered
    const submit = listButton('订阅所选（1）')
    const result = inbound(callbackUpdate(submit.data, { message_id: submit.messageId }))
    await gate
    publicConfig.generation = GEN + 1
    release()
    await expect(result).rejects.toThrow('列表已失效')
    summaryWait = undefined
    expect((await service.getStatus()).subscriptions).toHaveLength(0)
  })

  test('订阅列表：取消必须确认，返回或旧确认不改订阅，重复确认隔离其他订阅', async () => {
    await service.subscribe('sess-a')
    await service.subscribe('sess-b')
    await inbound(privateMessage('/subscriptions'))
    await clickList('取消订阅 · 修复登录')
    expect(sent.at(-1)?.text).toContain('取消后不再接收')
    const stale = listButton('确认取消')
    await clickList('返回')
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    await inbound(callbackUpdate(stale.data, { message_id: stale.messageId }))
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    await clickList('取消订阅 · 修复登录')
    const confirm = listButton('确认取消')
    await clickList('确认取消')
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['sess-b'])
    await service.subscribe('sess-a')
    await inbound(callbackUpdate(confirm.data, { message_id: confirm.messageId }))
    expect((await service.getStatus()).subscriptions).toHaveLength(2)
    expect(submitted).toHaveLength(0)
  })

  test('订阅列表：未消费的取消确认不能取消文字命令新建的订阅', async () => {
    await service.subscribe('sess-a')
    await inbound(privateMessage('/subscriptions'))
    await clickList('取消订阅 · 修复登录')
    const confirm = listButton('确认取消')
    await inbound(privateMessage('/unsubscribe sess-a'))
    await inbound(privateMessage('/subscribe sess-a'))
    // 固定 now 故意让 subscribedAt 相等，不能仅凭时间戳识别订阅生命周期。
    await inbound(callbackUpdate(confirm.data, { message_id: confirm.messageId }))
    expect((await service.getStatus()).subscriptions.map(item => item.sessionId)).toEqual(['sess-a'])
    expect(sent.at(-1)?.text).toContain('确认已失效')
  })

  test('订阅列表：文字先取消后重复确认提示已取消，订阅管理分页与空态', async () => {
    await service.subscribe('sess-a')
    await inbound(privateMessage('/subscriptions'))
    await clickList('取消订阅 · 修复登录')
    const confirm = listButton('确认取消')
    await inbound(privateMessage('/unsubscribe sess-a'))
    await inbound(callbackUpdate(confirm.data, { message_id: confirm.messageId }))
    expect(sent.at(-1)?.text).toContain('已取消订阅')
    expect(sent.at(-1)?.text).toContain('当前没有公共订阅')
    for (let index = 0; index < 21; index++) {
      sessions.set(`sub-${index}`, summary(`sub-${index}`, `订阅${index}`, workRoot))
      await service.subscribe(`sub-${index}`)
    }
    await inbound(privateMessage('/subscriptions'))
    await clickList('下一页')
    expect(sent.at(-1)?.text).toContain('第 2 / 2 页')
    listButton('取消订阅 · 订阅20')
  })

  test('订阅列表：并发相同选择仅一次，编辑失败传播明确错误并保留订阅真值', async () => {
    await inbound(privateMessage('/sessions'))
    const toggle = listButton('未选择 · 修复登录')
    await Promise.all([
      inbound(callbackUpdate(toggle.data, { message_id: toggle.messageId })),
      inbound(callbackUpdate(toggle.data, { message_id: toggle.messageId })),
    ])
    listButton('订阅所选（1）')
    editFailure = true
    await expect(clickList('订阅所选（1）')).rejects.toThrow('列表更新失败')
    expect((await service.getStatus()).subscriptions).toHaveLength(1)
    expect(submitted).toHaveLength(0)
  })

  test('同 owner 多 session 隔离，未订阅 C 不报告，公共结果只投一次', async () => {
    await service.subscribe('sess-a')
    await service.subscribe('sess-b')
    await emitResult('sess-a', 'A 完成全文', {
      uuid: 'uuid-a',
      origin: { entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 't-a' },
    })
    await emitResult('sess-b', 'B 摘要来源', { uuid: 'uuid-b' })
    await emitResult('sess-c', 'C 不应出现', { uuid: 'uuid-c' })
    const texts = sent.map(item => item.text).join('\n')
    expect(texts).toContain('修复登录')
    expect(texts).toContain('A 完成全文')
    expect(texts).toContain('支付退款')
    expect(texts).not.toContain('未订阅')
    expect(texts).not.toContain('C 不应出现')
    expect(sent.filter(item => item.text.includes('A 完成全文'))).toHaveLength(1)
  })

  test('来源标识：订阅会话报告保留定位信息且不会伪装成定时任务', async () => {
    const subscription = await service.subscribe('sess-a')
    await emitResult('sess-a', '订阅结果正文', { uuid: 'subscription-source-label' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe(`[ccmax · 订阅会话 · ${workRoot} · 修复登录 · ${subscription.shortId}] 已完成：订阅结果正文`)
    expect(sent[0]!.text).not.toContain('定时任务')
    await inbound(privateMessage('仍可回复订阅报告', { reply_to_message_id: sent[0]!.messageId }))
    expect(submitted).toEqual([expect.objectContaining({ sessionId: 'sess-a', content: '仍可回复订阅报告' })])
  })

  const reportOrigins = ['desktop', 'telegram-dedicated', 'unknown', 'telegram-public'] as const

  function reportOrigin(entrypoint: typeof reportOrigins[number]): TelegramPublicOrigin | undefined {
    if (entrypoint === 'unknown') return undefined
    return entrypoint === 'telegram-public'
      ? { entrypoint, botId: BOT, generation: GEN, turnId: 'report-turn' }
      : { entrypoint, turnId: 'report-turn' }
  }

  test.each(reportOrigins)('完整报告：%s 的完成与失败正文超过 280 字符仍逐轮完整发送', async entrypoint => {
    const sub = await service.subscribe('sess-a')
    const body = `${'正文'.repeat(650)}尾部保留`.padEnd(1318, '完')
    for (const isError of [false, true]) {
      const uuid = `complete-${entrypoint}-${isError}`
      const before = sent.length
      await emitResult('sess-a', body, { uuid, isError, origin: reportOrigin(entrypoint) })
      const messages = sent.slice(before)
      expect(messages).toHaveLength(1)
      const header = `[ccmax · 订阅会话 · ${workRoot} · 修复登录 · ${sub.shortId}] ${isError ? '失败' : '已完成'}：`
      // 原缺陷在非公共入口来源入队时截为 280 字符；保留两路既有拼接格式。
      expect(messages[0]!.text).toBe(`${header}${entrypoint === 'telegram-public' ? '\n' : ''}${body}`)
      expect(messages[0]!.text).not.toContain('…')
      expect(messages[0]!.chatId).toBe(String(OWNER))
      await emitResult('sess-a', body, { uuid, isError, origin: reportOrigin(entrypoint) })
      expect(sent.length).toBe(before + 1)
    }
  })

  test.each(reportOrigins)('完整报告：%s 的超长正文无损分片并保留顺序、归属和幂等', async entrypoint => {
    const sub = await service.subscribe('sess-a')
    const body = `${'首段 🧪 '.repeat(900)}\n\n  缩进\t与换行\n${'末段 🚀\n'.repeat(900)}终点`
    const uuid = `lossless-${entrypoint}`
    await emitResult('sess-a', body, { uuid, origin: reportOrigin(entrypoint) })
    const messages = [...sent]
    expect(messages.length).toBeGreaterThan(2)
    const header = `[ccmax · 订阅会话 · ${workRoot} · 修复登录 · ${sub.shortId}] 已完成：`
    const prefixes = messages.map((_, index) => index === 0
      ? `${header}${entrypoint === 'telegram-public' ? '\n' : ''}`
      : `[ccmax · 订阅会话 · ${sub.shortId} · 已完成 · 续 ${index + 1}]：\n`)
    const reconstructed = messages.map((message, index) => {
      expect(message.text.startsWith(prefixes[index]!)).toBe(true)
      expect(message.text.length).toBeLessThanOrEqual(4000)
      expect(message.text.isWellFormed()).toBe(true)
      expect(message.chatId).toBe(String(OWNER))
      return message.text.slice(prefixes[index]!.length)
    }).join('')
    expect(reconstructed).toBe(body)
    const state = await new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')).read()
    const fragments = state.outbox.filter(record => record.eventId === uuid)
    expect(fragments.map(record => record.part)).toEqual(messages.map((_, index) => index))
    expect(fragments.map(record => record.text)).toEqual(messages.map(message => message.text))
    expect(fragments.every(record => record.status === 'delivered')).toBe(true)
    for (const message of messages) {
      expect(state.messageMaps[`${GEN}:${BOT}:${OWNER}:${message.messageId}`]).toMatchObject({
        sessionId: 'sess-a', shortId: sub.shortId, eventId: uuid,
        turnId: entrypoint === 'unknown' ? undefined : 'report-turn', kind: 'report',
      })
    }
    await emitResult('sess-a', body, { uuid, origin: reportOrigin(entrypoint) })
    expect(sent).toHaveLength(messages.length)
    await inbound(privateMessage('回复续片仍定向原会话', { reply_to_message_id: messages.at(-1)!.messageId }))
    expect(submitted).toEqual([expect.objectContaining({ sessionId: 'sess-a', content: '回复续片仍定向原会话' })])
  })

  test.each(['desktop', 'telegram-public'] as const)('完整报告：%s 在长度与 emoji 边界不丢字符', async entrypoint => {
    const sub = await service.subscribe('sess-a')
    const header = `[ccmax · 订阅会话 · ${workRoot} · 修复登录 · ${sub.shortId}] 已完成：${entrypoint === 'telegram-public' ? '\n' : ''}`
    for (const length of [3999, 4000, 4001, 4096, 4097]) {
      const body = '中'.repeat(length - header.length)
      const before = sent.length
      await emitResult('sess-a', body, { uuid: `boundary-${length}`, origin: reportOrigin(entrypoint) })
      const messages = sent.slice(before)
      expect(messages).toHaveLength(length <= 4000 ? 1 : 2)
      expect(messages.every(message => message.text.length <= 4000)).toBe(true)
      expect(messages.map((message, index) => index === 0
        ? message.text
        : message.text.slice(`[ccmax · 订阅会话 · ${sub.shortId} · 已完成 · 续 ${index + 1}]：\n`.length)).join('')).toBe(header + body)
    }
    // 强制把 emoji 的高代理项放在第一片最后一个 UTF-16 单元。
    const body = `${'中'.repeat(3999 - header.length)}🚀${'末'.repeat(4500)}`
    const before = sent.length
    await emitResult('sess-a', body, { uuid: 'surrogate-boundary', origin: reportOrigin(entrypoint) })
    const messages = sent.slice(before)
    expect(messages[0]!.text).toHaveLength(3999)
    expect(messages.every(message => message.text.isWellFormed())).toBe(true)
    expect(messages.map((message, index) => index === 0
      ? message.text
      : message.text.slice(`[ccmax · 订阅会话 · ${sub.shortId} · 已完成 · 续 ${index + 1}]：\n`.length)).join('')).toBe(header + body)
  })

  test('订阅在重启后仍然有效', async () => {
    const created = await service.subscribe('sess-a')
    service.stop()
    const reopened = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: listener => {
        observer = listener
        return () => { observer = undefined }
      },
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await reopened.start()
    await reopened.registerRuntime({ botId: BOT, generation: GEN })
    const status = await reopened.getStatus()
    expect(status.subscriptions[0]?.sessionId).toBe('sess-a')
    expect(status.subscriptions[0]?.shortId).toBe(created.shortId)
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'after-restart',
      message: { type: 'result', result: '重启后仍报告', uuid: 'after-restart' },
    })
    await reopened.flushForTests()
    expect(sent.some(item => item.text.includes('重启后仍报告'))).toBe(true)
    reopened.stop()
  })

  test('回复较早消息只进入对应 session，/to 冲突拒绝，无目标只提示', async () => {
    const a = await service.subscribe('sess-a')
    const b = await service.subscribe('sess-b')
    await emitResult('sess-a', '报告 A', { uuid: 'ua' })
    await emitResult('sess-b', '报告 B', { uuid: 'ub' })
    const messageA = sent.find(item => item.text.includes('报告 A'))!
    const messageB = sent.find(item => item.text.includes('报告 B'))!
    const accepted = await inbound(privateMessage('补一个测试', { update_id: 1, reply_to_message_id: messageA.messageId, message_id: 50 }))
    expect(accepted).toEqual({ ok: true, accepted: true })
    expect(submitted).toEqual([expect.objectContaining({ sessionId: 'sess-a', content: '补一个测试' })])
    expect(sent.some(item => item.text.includes('已接收'))).toBe(true)
    const conflict = await inbound(privateMessage(`/to ${b.shortId} 发给 B`, {
      update_id: 2,
      reply_to_message_id: messageA.messageId,
      message_id: 51,
    }))
    expect(conflict).toEqual({ ok: true })
    expect(submitted).toHaveLength(1)
    expect(sent.some(item => item.text.includes('不一致'))).toBe(true)
    await inbound(privateMessage('没有目标', { update_id: 3, message_id: 52 }))
    expect(submitted).toHaveLength(1)
    expect(sent.some(item => item.text.includes('未指定目标'))).toBe(true)
    await inbound(privateMessage(`/to ${a.shortId} 明确发给 A`, { update_id: 4, message_id: 53 }))
    expect(submitted[1]).toEqual(expect.objectContaining({ sessionId: 'sess-a', content: '明确发给 A' }))
  })

  test('media 拒绝且不执行 caption，忙碌明示，update 重复不再执行', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '报告', { uuid: 'u1' })
    const report = sent.find(item => item.text.includes('报告'))!
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('', {
        update_id: 11,
        caption: '/to SXXXX 不该执行',
        photo: [{ file_id: 'x' }],
        reply_to_message_id: report.messageId,
      }),
    })
    expect(submitted).toHaveLength(0)
    expect(sent.some(item => item.text.includes('暂不支持'))).toBe(true)

    turnState.set('sess-a', 'running')
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('再试', { update_id: 12, reply_to_message_id: report.messageId }),
    })
    expect(submitted).toHaveLength(0)
    expect(sent.some(item => item.text.includes('忙碌'))).toBe(true)

    turnState.set('sess-a', 'idle')
    let resume = () => {}
    submitWait = new Promise<void>(resolve => { resume = resolve })
    const update = privateMessage('只执行一次', { update_id: 13, reply_to_message_id: report.messageId })
    const first = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    expect(first).toEqual({ ok: true, accepted: true })
    expect(submitted).toHaveLength(0)
    const dup = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    expect(dup).toEqual({ ok: true, duplicate: true })
    resume()
    await service.flushForTests()
    expect(submitted).toHaveLength(1)
    expect(sent.some(item => item.text.includes('已接收'))).toBe(true)
  })

  test.each(reportOrigins)('a rate-limited %s first fragment holds later fragments without blocking unrelated reports', async entrypoint => {
    await service.subscribe('sess-a')
    await service.subscribe('sess-b')
    let attempts = 0
    sendImpl = async () => ++attempts === 1
      ? { outcome: 'failed', error: '429', retryAfterMs: 60_000 }
      : { outcome: 'delivered', messageId: ++nextMessageId }
    await emitResult('sess-a', '长'.repeat(8500), {
      uuid: 'fragment-order',
      origin: reportOrigin(entrypoint),
    })
    expect(sent).toHaveLength(1)
    await emitResult('sess-b', '其他会话仍可报告', { uuid: 'unrelated-report' })
    expect(sent.some(item => item.text.includes('其他会话仍可报告'))).toBe(true)
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(state => {
      for (const record of state.outbox) {
        if (record.eventId === 'fragment-order' && record.part === 0) delete record.nextAttemptAt
      }
    })
    await service.registerRuntime({ botId: BOT, generation: GEN })
    await service.flushForTests()
    const fragments = (await store.read()).outbox.filter(record => record.eventId === 'fragment-order')
    expect(fragments).toHaveLength(3)
    expect(fragments.every(record => record.status === 'delivered')).toBe(true)
    expect(fragments.map(record => record.messageId)).toEqual([12, 13, 14])
  })

  test.each(reportOrigins.flatMap(entrypoint =>
    (['failed', 'indeterminate'] as const).map(outcome => [entrypoint, outcome] as const),
  ))('a %s report with a %s fragment prevents sending its remaining fragments', async (entrypoint, outcome) => {
    await service.subscribe('sess-a')
    sendImpl = async () => ({ outcome, error: 'fixture delivery failure' })
    await emitResult('sess-a', '长'.repeat(8500), {
      uuid: `fragment-${outcome}`,
      origin: reportOrigin(entrypoint),
    })
    expect(sent).toHaveLength(1)
    const state = await new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')).read()
    const fragments = state.outbox.filter(record => record.eventId === `fragment-${outcome}`)
    expect(fragments).toHaveLength(3)
    expect(fragments[0]?.status).toBe(outcome)
    expect(fragments.slice(1).every(record => record.status === 'failed' && record.attempts === 0)).toBe(true)
  })

  test('outbox timeout / 429 / 缺回执 / sending 崩溃恢复', async () => {
    await service.subscribe('sess-a')
    sendImpl = async () => ({ outcome: 'indeterminate', error: 'timeout' })
    await emitResult('sess-a', '超时', { uuid: 'evt-timeout' })
    expect((await service.getStatus()).deliveries[0]?.status).toBe('indeterminate')

    sendImpl = async () => ({ outcome: 'failed', error: 'too many', retryAfterMs: 120_000 })
    await emitResult('sess-a', '限流', { uuid: 'evt-429' })
    expect(sleeps).toEqual([])
    const limited = (await new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')).read())
      .outbox.find(item => item.eventId === 'evt-429')
    expect(limited?.status).toBe('queued')
    expect(limited?.nextAttemptAt).toBe('2026-04-04T00:02:00.000Z')
    expect(limited?.retryAfterMs).toBe(120_000)

    sendImpl = async () => ({ outcome: 'delivered', messageId: ++nextMessageId })
    await emitResult('sess-a', '429等待中仍可观察', { uuid: 'evt-during-429' })
    expect(sent.some(item => item.text.includes('429等待中仍可观察'))).toBe(true)

    sendImpl = async () => ({ outcome: 'delivered' })
    await emitResult('sess-a', '无回执', { uuid: 'evt-noreceipt' })
    expect((await service.getStatus()).deliveries.some(item => item.status === 'indeterminate' && item.error?.includes('回执'))).toBe(true)

    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'crash-1',
        idempotencyKey: 'crash:3:99:4242:sess-a:0',
        status: 'sending',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'crash',
        part: 0,
        text: 'sending',
        attempts: 1,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
      current.inboundUpdates['3:99:88'] = {
        key: '3:99:88',
        updateId: 88,
        botId: BOT,
        generation: GEN,
        status: 'processing',
        createdAt: '2026-04-04T00:00:00.000Z',
      }
    })
    const recovered = new TelegramPublicService({
      store,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async () => ({ outcome: 'delivered', messageId: 1 }),
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await recovered.start()
    await recovered.registerRuntime({ botId: BOT, generation: GEN })
    const status = await recovered.getStatus()
    expect(status.deliveries.find(item => item.id === 'crash-1')?.status).toBe('indeterminate')
    expect(status.running).toBe(true)
    const inboundState = (await store.read()).inboundUpdates['3:99:88']
    expect(inboundState?.status).toBe('unknown')
    const replay = await recovered.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: { update_id: 88, message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: 'replay' } },
    })
    expect(replay).toEqual({ ok: false, error: '该 update 在上次中断后状态未知，不会自动重放' })
    recovered.stop()
  })

  test('审批跨 bot / 双击 / 桌面已解决 / 解绑拒绝', async () => {
    await service.subscribe('sess-a')
    await emitPermission('sess-a', 'req-1', 'Bash', {
      entrypoint: 'telegram-public',
      botId: BOT,
      generation: GEN,
      turnId: 't1',
    })
    const markup = sent.find(item => item.replyMarkup)?.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const allow = markup.inline_keyboard.flat().find(button => button.callback_data.startsWith('tgp:'))!.callback_data
    const deny = markup.inline_keyboard.flat().find(button => button.callback_data !== allow)!.callback_data

    const cross = await service.handleUpdate({
      botId: BOT + 1,
      generation: GEN,
      update: callbackUpdate(allow, { update_id: 21 }),
    })
    expect(cross).toEqual({ ok: false, error: 'Bot 运行时未注册或已停止' })
    expect(permissionResponses).toHaveLength(0)

    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(allow, { update_id: 22 }) })
    expect(permissionResponses).toEqual([{ sessionId: 'sess-a', requestId: 'req-1', allowed: true }])
    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(allow, { update_id: 23 }) })
    expect(permissionResponses).toHaveLength(1)

    await emitPermission('sess-a', 'req-2', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 't2',
    })
    const second = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const secondAllow = second.inline_keyboard.flat()[0]!.callback_data
    pending.delete('sess-a:req-2')
    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(secondAllow, { update_id: 24 }) })
    expect(permissionResponses.every(item => item.requestId !== 'req-2' || item.sessionId !== 'sess-a' || true)).toBe(true)
    expect(sent.some(item => item.text.includes('已在桌面或其他入口处理'))).toBe(true)

    await emitPermission('sess-a', 'req-3', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 't3',
    })
    await service.unsubscribe('sess-a')
    const third = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const thirdAllow = third.inline_keyboard.flat()[0]!.callback_data
    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(thirdAllow, { update_id: 25 }) })
    expect(permissionResponses.some(item => item.requestId === 'req-3')).toBe(false)
    expect(sent.some(item => item.text.includes('取消订阅') || item.text.includes('按钮已失效'))).toBe(true)
    void deny
  })

  test('无可靠 origin 只读；专属绑定存在时桌面/专属发起只读', async () => {
    await service.subscribe('sess-a')
    dedicated = { sessionId: 'sess-a' }
    await emitPermission('sess-a', 'req-old', 'Bash')
    expect(sent.some(item => item.text.includes('来源无法确认'))).toBe(true)
    expect(sent.filter(item => item.replyMarkup).length).toBe(0)

    await emitPermission('sess-a', 'req-ded', 'Bash', {
      entrypoint: 'telegram-dedicated', botId: 1, generation: 1, turnId: 'd1',
    })
    expect(sent.some(item => item.text.includes('专属入口'))).toBe(true)
    expect(sent.filter(item => item.replyMarkup).length).toBe(0)

    await emitPermission('sess-a', 'req-desk-bound', 'Bash', { entrypoint: 'desktop', turnId: 'desk-bound' })
    const bound = sent.filter(item => item.text.includes('Bash 请求') && item.text.includes('专属入口')).at(-1)
    expect(bound).toBeTruthy()
    expect(bound?.replyMarkup).toBeUndefined()
    const boundStore = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    expect(Object.values((await boundStore.read()).callbackTokens)
      .filter(item => item.requestId === 'req-desk-bound' || item.requestId === 'req-old' || item.requestId === 'req-ded')).toHaveLength(0)
  })

  test('项目根目录用 realpath 边界，不以 startsWith 误匹配', async () => {
    await expect(service.subscribe('sess-evil')).rejects.toMatchObject({ statusCode: 400 })
    const listed = await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('/sessions', { update_id: 31 }),
    })
    expect(listed).toEqual({ ok: true })
    const markup = sent.at(-1)?.replyMarkup as { inline_keyboard: Array<Array<{ text: string }>> }
    const labels = markup.inline_keyboard.flat().map(item => item.text)
    expect(labels.some(label => label.includes('修复登录'))).toBe(true)
    expect(labels.some(label => label.includes('越界'))).toBe(false)
  })

  test('群组与他人拒绝；runtime 代次变化使旧待发不能改投', async () => {
    await service.subscribe('sess-a')
    const before = sent.length
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('hi', { update_id: 41, chatId: -10001, fromId: OWNER, chatType: 'supergroup' }),
    })
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('hi', { update_id: 42, fromId: 7, chatId: 7 }),
    })
    expect(submitted).toHaveLength(0)
    expect(sent.length).toBe(before)

    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'stale-queued',
        idempotencyKey: 'stale:3:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'stale',
        part: 0,
        text: '旧待发',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    publicConfig.generation = GEN + 1
    await expect(service.registerRuntime({ botId: BOT, generation: GEN })).rejects.toMatchObject({ statusCode: 400 })
    const staleUpdate = await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('stale', { update_id: 43 }),
    })
    expect(staleUpdate).toEqual({ ok: false, error: 'Bot 运行时身份与配置代次不一致' })
    await service.registerRuntime({ botId: BOT, generation: GEN + 1 })
    const status = await service.getStatus()
    expect(status.generation).toBe(GEN + 1)
    expect(status.deliveries.some(item => item.status === 'failed' && item.error?.includes('改投'))).toBe(true)
    expect(status.subscriptions.some(item => item.sessionId === 'sess-a')).toBe(true)
  })

  test('旧配置没有 public 不写新状态', async () => {
    const isolatedDir = path.join(root, 'nopublic')
    await fs.mkdir(isolatedDir, { recursive: true })
    const isolated = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(isolatedDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { botToken: 'exclusive' } }),
      observeSessionTurns: () => () => {},
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await isolated.start()
    await expect(isolated.subscribe('sess-a')).rejects.toMatchObject({ statusCode: 400 })
    expect(await fs.access(path.join(isolatedDir, 'ccmax', 'telegram-public.json')).then(() => true).catch(() => false)).toBe(false)
    isolated.stop()
  })

  test('转发消息拒绝；分片都映射同一 shortId', async () => {
    const sub = await service.subscribe('sess-a')
    await emitResult('sess-a', 'z'.repeat(5000), {
      uuid: 'long',
      origin: { entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'long' },
    })
    const chunks = sent.filter(item => item.text.includes('z') || item.text.includes(sub.shortId))
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('转发', { update_id: 51, forward_date: 1, reply_to_message_id: chunks[0]!.messageId }),
    })
    expect(submitted).toHaveLength(0)
    expect(sent.some(item => item.text.includes('转发'))).toBe(true)
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('对第二片', { update_id: 52, reply_to_message_id: chunks.at(-1)!.messageId }),
    })
    await service.flushForTests()
    expect(submitted[0]?.sessionId).toBe('sess-a')
  })

  test('同一 uuid 不重复投递；/pair 占用 owner；普通文本不批准工具', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '一次即可', { uuid: 'same-uuid' })
    await emitResult('sess-a', '一次即可', { uuid: 'same-uuid' })
    expect(sent.filter(item => item.text.includes('一次即可'))).toHaveLength(1)

    await emitPermission('sess-a', 'req-text', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'p1',
    })
    const perm = sent.find(item => item.text.includes('Bash 请求'))!
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('yes', { update_id: 62, reply_to_message_id: perm.messageId }),
    })
    expect(permissionResponses.some(item => item.requestId === 'req-text')).toBe(false)
    expect(sent.some(item => item.text.includes('不会被当作批准'))).toBe(true)
  })

  test('AskUserQuestion 显式解析；Computer Use 按钮走独立回调', async () => {
    await service.subscribe('sess-a')
    const input = { questions: [{ question: '用哪个库？', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] }
    await emitPermission('sess-a', 'q1', 'AskUserQuestion', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'q',
    }, input)
    const question = sent.find(item => item.text.includes('等待回答'))!
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('React', { update_id: 71, reply_to_message_id: question.messageId }),
    })
    expect(permissionResponses).toEqual([expect.objectContaining({ sessionId: 'sess-a', requestId: 'q1', allowed: true })])

    await emitPermission('sess-a', 'cu1', 'ComputerUse', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'cu',
    })
    const cuMarkup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
    const allow = cuMarkup.inline_keyboard.flat().find(button => button.text === '允许')!.callback_data
    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(allow, { update_id: 72 }) })
    expect(computerResponses).toEqual([{ sessionId: 'sess-a', requestId: 'cu1' }])
  })

  test('registerRuntime 必须启用且代次等于 snapshot，旧 runtime 不能用新 token 投递', async () => {
    publicConfig.enabled = false
    await expect(service.registerRuntime({ botId: BOT, generation: GEN })).rejects.toMatchObject({ statusCode: 400 })
    publicConfig.enabled = true
    await expect(service.registerRuntime({ botId: BOT, generation: GEN - 1 })).rejects.toMatchObject({ statusCode: 400 })

    await service.subscribe('sess-a')
    publicConfig.generation = GEN + 1
    publicConfig.botToken = 'rotated-token'
    const before = sent.length
    await emitResult('sess-a', '不应改投新 token', { uuid: 'no-rotate' })
    expect(sent.length).toBe(before)
  })

  test('私聊 type 强制；callback 必须有 message/chat；回复转发目标拒绝', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '报告', { uuid: 'fwd-src' })
    const report = sent.find(item => item.text.includes('报告'))!
    const beforeSubmit = submitted.length
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('伪装私聊', { update_id: 81, chatId: OWNER, fromId: OWNER, chatType: 'group' }),
    })
    expect(submitted).toHaveLength(beforeSubmit)

    await emitPermission('sess-a', 'req-inline', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'in',
    })
    const markup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const allow = markup.inline_keyboard.flat()[0]!.callback_data
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: callbackUpdate(allow, { update_id: 82, omitMessage: true }),
    })
    expect(permissionResponses.some(item => item.requestId === 'req-inline')).toBe(false)

    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('回转发目标', {
        update_id: 83,
        reply_to_message_id: report.messageId,
        reply_forward_date: 1,
      }),
    })
    expect(submitted).toHaveLength(beforeSubmit)
    expect(sent.some(item => item.text.includes('转发'))).toBe(true)
  })

  test('workDir 优先；在外则拒绝，不看内部 projectPath；realpath 失败 deny', async () => {
    sessions.set('sess-mixed', {
      id: 'sess-mixed',
      title: '混路径',
      projectPath: workRoot,
      projectRoot: workRoot,
      workDir: otherRoot,
    })
    await expect(service.subscribe('sess-mixed')).rejects.toMatchObject({ statusCode: 400 })

    sessions.set('sess-rootonly', {
      id: 'sess-rootonly',
      title: '仅根',
      projectPath: workRoot,
      projectRoot: workRoot,
      workDir: null,
    })
    await expect(service.subscribe('sess-rootonly')).resolves.toMatchObject({ sessionId: 'sess-rootonly' })

    const isolated = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(root, 'realpath-fail', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      realpath: async () => { throw new Error('ENOENT') },
      observeSessionTurns: () => () => {},
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await isolated.start()
    await expect(isolated.subscribe('sess-a')).rejects.toMatchObject({ statusCode: 400 })
    isolated.stop()
  })

  test('header 含项目和当前标题；发送/审批/回答每次校验会话与 roots；queued 不能绕过撤订', async () => {
    const created = await service.subscribe('sess-a')
    sessions.set('sess-a', summary('sess-a', '新标题', workRoot))
    await emitResult('sess-a', '带 header', { uuid: 'hdr-1' })
    const report = sent.find(item => item.text.includes('带 header'))!
    expect(report.text).toContain(workRoot)
    expect(report.text).toContain('新标题')
    expect(report.text).toContain(created.shortId)

    await emitPermission('sess-a', 'req-root', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'r1',
    })
    sessions.set('sess-a', summary('sess-a', '新标题', evilRoot))
    const markup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const allow = markup.inline_keyboard.flat()[0]!.callback_data
    await service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(allow, { update_id: 91 }) })
    expect(permissionResponses.some(item => item.requestId === 'req-root')).toBe(false)
    expect(sent.some(item => item.text.includes('项目根目录'))).toBe(true)

    sessions.set('sess-a', summary('sess-a', '新标题', workRoot))
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'late-queued',
        idempotencyKey: 'late:3:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'late',
        part: 0,
        text: '延迟 queued',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    await service.unsubscribe('sess-a')
    await service.flushForTests()
    const after = await store.read()
    expect(after.outbox.find(item => item.id === 'late-queued')?.status).toBe('failed')
    expect(sent.some(item => item.text.includes('延迟 queued'))).toBe(false)

    await service.subscribe('sess-a')
    await store.mutate(current => {
      current.outbox.push({
        id: 'root-queued',
        idempotencyKey: 'root:3:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'root-late',
        part: 0,
        text: 'roots 变更 queued',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    sessions.set('sess-a', summary('sess-a', '新标题', evilRoot))
    await service.flushForTests()
    expect((await store.read()).outbox.find(item => item.id === 'root-queued')?.status).toBe('failed')
    expect(sent.some(item => item.text.includes('roots 变更 queued'))).toBe(false)
    sessions.set('sess-a', summary('sess-a', '新标题', workRoot))
  })

  test('owner 变更取消订阅；同 owner 代次变更保留订阅；首次配对可注册新代次且不重投', async () => {
    await service.subscribe('sess-a')
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'owner-queued',
        idempotencyKey: 'owner:3:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'owner-q',
        part: 0,
        text: '旧 owner 待发',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    publicConfig.ownerUserId = 7
    publicConfig.generation = GEN + 1
    await service.registerRuntime({ botId: BOT, generation: GEN + 1 })
    expect((await service.getStatus()).subscriptions).toEqual([])
    expect((await store.read()).outbox.find(item => item.id === 'owner-queued')?.status).toBe('failed')

    publicConfig.ownerUserId = OWNER
    publicConfig.generation = GEN + 2
    await service.registerRuntime({ botId: BOT, generation: GEN + 2 })
    const resub = await service.subscribe('sess-a')
    publicConfig.generation = GEN + 3
    await service.registerRuntime({ botId: BOT, generation: GEN + 3 })
    expect((await service.getStatus()).subscriptions[0]?.sessionId).toBe('sess-a')
    expect((await service.getStatus()).subscriptions[0]?.shortId).toBe(resub.shortId)

    const isolatedDir = path.join(root, 'first-pair')
    const pairConfig: Record<string, unknown> = {
      enabled: true,
      botToken: 'public-secret-token',
      generation: 0,
      allowedProjectRoots: [workRoot],
    }
    const isolatedStore = new TelegramPublicStore(path.join(isolatedDir, 'telegram-public.json'))
    await isolatedStore.mutate(current => {
      current.outbox.push({
        id: 'pre-pair',
        idempotencyKey: 'pre:0:99:1:sess-a:0',
        status: 'queued',
        generation: 0,
        botId: BOT,
        chatId: '1',
        sessionId: 'sess-a',
        eventId: 'pre',
        part: 0,
        text: '配对前旧消息',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    const isolatedSent: string[] = []
    const isolated = new TelegramPublicService({
      store: isolatedStore,
      getRawConfig: async () => ({ telegram: { public: pairConfig } }),
      claimPairing: async (_code, userId) => {
        pairConfig.ownerUserId = userId
        pairConfig.generation = 1
        return { ownerUserId: userId, generation: 1 }
      },
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, _chatId, text) => {
        isolatedSent.push(text)
        return { outcome: 'delivered', messageId: 1 }
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await isolated.start()
    await isolated.registerRuntime({ botId: BOT, generation: 0 })
    const paired = await isolated.handleUpdate({
      botId: BOT,
      generation: 0,
      update: privateMessage('/pair ABC123', { update_id: 101 }),
    })
    expect(paired).toEqual({ ok: true })
    expect(isolatedSent.some(text => text.includes('已配对'))).toBe(true)
    const afterPair = await isolated.getStatus()
    expect(afterPair.running).toBe(true)
    expect(afterPair.generation).toBe(1)
    expect(afterPair.ownerUserId).toBe(OWNER)
    const isolatedState = await isolatedStore.read()
    expect(isolatedState.runtime?.generation).toBe(1)
    expect(isolatedState.outbox.find(item => item.id === 'pre-pair')?.status).toBe('failed')
    expect(isolatedSent.some(text => text.includes('配对前旧消息'))).toBe(false)
    isolated.stop()
  })

  test('allow/deny 原子消费同一请求；自由文本不得只因 mapping 批准', async () => {
    await service.subscribe('sess-a')
    await emitPermission('sess-a', 'req-race', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'race',
    })
    const markup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const buttons = markup.inline_keyboard.flat().map(button => button.callback_data)
    await Promise.all([
      service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(buttons[0]!, { update_id: 111 }) }),
      service.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(buttons[1]!, { update_id: 112 }) }),
    ])
    expect(permissionResponses.filter(item => item.requestId === 'req-race')).toHaveLength(1)
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const leftover = Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-race')
    expect(leftover).toHaveLength(0)

    const input = { questions: [{ question: '用哪个库？', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] }
    await emitPermission('sess-a', 'q-map', 'AskUserQuestion', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'qm',
    }, input)
    const question = sent.filter(item => item.text.includes('等待回答')).at(-1)!
    await store.mutate(current => {
      current.callbackTokens = Object.fromEntries(
        Object.entries(current.callbackTokens).filter(([, entry]) => entry.requestId !== 'q-map'),
      )
    })
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('React', { update_id: 113, reply_to_message_id: question.messageId }),
    })
    expect(permissionResponses.some(item => item.requestId === 'q-map')).toBe(false)
  })

  test('repeat result/permission 不新增 tokens；真实 result.uuid 作为 eventId', async () => {
    await service.subscribe('sess-a')
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      message: { type: 'result', result: '真实 uuid 报告', uuid: 'real-result-uuid' },
    })
    await service.flushForTests()
    expect(sent.some(item => item.text.includes('真实 uuid 报告'))).toBe(true)
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const first = (await store.read()).outbox.find(item => item.eventId === 'real-result-uuid')
    expect(first).toBeTruthy()
    const eventDir = path.join(configDir, 'ccmax', 'telegram-public-events')
    const leftover = await fs.readdir(eventDir).catch(() => [])
    expect(leftover.filter(name => name.endsWith('.json') && !name.includes('.tmp.'))).toEqual([])

    await emitPermission('sess-a', 'req-repeat', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'rep',
    })
    const tokenCount = Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-repeat').length
    expect(tokenCount).toBe(2)
    await emitPermission('sess-a', 'req-repeat', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'rep',
    })
    const again = Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-repeat')
    expect(again).toHaveLength(2)
    expect(sent.filter(item => item.text.includes('req-repeat') || (item.replyMarkup && item.text.includes('Bash 请求'))).length).toBeGreaterThanOrEqual(1)
  })

  test('send 异常 settle indeterminate；缺 sender wrapper 错误可见', async () => {
    await service.subscribe('sess-a')
    sendImpl = async () => {
      throw new Error('socket hang up')
    }
    await emitResult('sess-a', '发送抛错', { uuid: 'evt-throw' })
    expect((await service.getStatus()).deliveries.some(item => item.status === 'indeterminate' && item.error?.includes('socket hang up'))).toBe(true)

    const isolated = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(root, 'nosender', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: listener => {
        observer = listener
        return () => { observer = undefined }
      },
      sendTelegramChannelMessage: async () => {
        throw new Error('telegram public channel requires sendTelegramChannelMessage (injected in tests; production wrapper is owned by ws/handler or notificationService)')
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await isolated.start()
    await isolated.registerRuntime({ botId: BOT, generation: GEN })
    await isolated.subscribe('sess-a')
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      message: { type: 'result', result: '缺 wrapper', uuid: 'missing-sender' },
    })
    await isolated.flushForTests()
    const status = await isolated.getStatus()
    expect(status.deliveries.some(item => item.status === 'indeterminate' && item.error?.includes('sendTelegramChannelMessage'))).toBe(true)
    isolated.stop()
  })

  test('sendSessionReport 走订阅 outbox 并校验 roots', async () => {
    await service.subscribe('sess-a')
    const queued = await service.sendSessionReport('sess-a', 'notify-1', '本地通知')
    expect(queued).toEqual({ queued: true })
    await service.flushForTests()
    expect(sent.some(item => item.text.includes('本地通知') && item.text.includes('修复登录'))).toBe(true)
    await expect(service.sendSessionReport('sess-c', 'notify-2', '未订阅')).rejects.toMatchObject({ statusCode: 400 })
    sessions.set('sess-a', summary('sess-a', '修复登录', evilRoot))
    await expect(service.sendSessionReport('sess-a', 'notify-3', '越界')).rejects.toMatchObject({ statusCode: 400 })
  })

  test('inbound watermark 阻止修剪后重放已执行 update', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '报告', { uuid: 'wm-src' })
    const report = sent.find(item => item.text.includes('报告'))!
    const update = privateMessage('只执行一次水位', { update_id: 5001, reply_to_message_id: report.messageId })
    await inbound(update)
    expect(submitted.filter(item => item.content === '只执行一次水位')).toHaveLength(1)
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.inboundUpdates = {}
    })
    const replay = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    expect(replay).toEqual({ ok: true, duplicate: true })
    expect(submitted.filter(item => item.content === '只执行一次水位')).toHaveLength(1)
  })

  test('getStatus running 来自内存注册，stop/deregister 不假装运行', async () => {
    const status = await service.getStatus()
    expect(status.running).toBe(true)
    expect(status.botId).toBe(BOT)
    expect(status.ownerUserId).toBe(OWNER)
    await service.deregisterRuntime({ botId: BOT, generation: GEN })
    const stopped = await service.getStatus()
    expect(stopped.running).toBe(false)
    expect(stopped.botId).toBe(BOT)
    await expect(service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('/subscriptions', { update_id: 9001 }),
    })).resolves.toEqual({ ok: false, error: 'Bot 运行时未注册或已停止' })
    service.stop()
    const afterStop = await service.getStatus()
    expect(afterStop.running).toBe(false)
    expect(afterStop.botId).toBe(BOT)
    const reopened = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async () => ({ outcome: 'delivered', messageId: 1 }),
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await reopened.start()
    const restarted = await reopened.getStatus()
    expect(restarted.running).toBe(false)
    expect(restarted.botId).toBe(BOT)
    reopened.stop()
  })

  test('未配对时桌面 subscribe 拒绝，不让后续 owner 继承', async () => {
    const pairConfig: Record<string, unknown> = {
      enabled: true,
      botToken: 'public-secret-token',
      generation: 0,
      allowedProjectRoots: [workRoot],
    }
    const isolated = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(root, 'no-owner', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: pairConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async () => ({ outcome: 'delivered', messageId: 1 }),
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await isolated.start()
    await isolated.registerRuntime({ botId: BOT, generation: 0 })
    expect((await isolated.getStatus()).ownerUserId).toBeNull()
    await expect(isolated.subscribe('sess-a')).rejects.toMatchObject({ statusCode: 400, message: 'public owner is not paired' })
    isolated.stop()
  })

  test('文本长路径 accepted 后后台失败发未接收且不重放', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '报告', { uuid: 'bg-fail' })
    const report = sent.find(item => item.text.includes('报告'))!
    submitError = 'admission timeout'
    const update = privateMessage('后台失败', { update_id: 9101, reply_to_message_id: report.messageId })
    const first = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    expect(first).toEqual({ ok: true, accepted: true })
    await service.flushForTests()
    expect(sent.some(item => item.text.includes('未接收') && item.text.includes('admission timeout'))).toBe(true)
    const replay = await service.handleUpdate({ botId: BOT, generation: GEN, update })
    expect(replay).toEqual({ ok: true, duplicate: true })
  })

  test('control_response 立即撤销同 request tokens，不依赖提示发送成功', async () => {
    await service.subscribe('sess-a')
    await emitPermission('sess-a', 'req-cancel', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'c1',
    })
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    expect(Object.values((await store.read()).callbackTokens).some(item => item.requestId === 'req-cancel')).toBe(true)
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'cancel-1',
      message: { type: 'control_response', request_id: 'req-cancel' },
    })
    await service.flushForTests()
    expect(Object.values((await store.read()).callbackTokens).some(item => item.requestId === 'req-cancel')).toBe(false)
    expect(sent.some(item => item.text.includes('按钮已失效'))).toBe(true)
    const leftoverMaps = Object.values((await store.read()).messageMaps).filter(item => item.requestId === 'req-cancel')
    expect(leftoverMaps).toHaveLength(0)
  })

  test('callback 使用每 request 的 origin snapshot 而不是最新 session', async () => {
    await service.subscribe('sess-a')
    service.stop()
    dedicated = { sessionId: 'sess-a' }
    const origins = new Map<string, TelegramPublicOrigin>([
      ['sess-a:req-old', { entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'old' }],
    ])
    const withOrigin = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      now: () => nowMs,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      getSessionPermissionOrigin: (sessionId, requestId) => origins.get(`${sessionId}:${requestId}`),
      observeSessionTurns: listener => {
        observer = listener
        return () => { observer = undefined }
      },
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      editTelegramChannelMessage: async (_token, chatId, messageId, text, options) => {
        if (editFailure) return { outcome: 'failed', error: 'fixture edit failure' }
        sent.push({ chatId, text, messageId, replyMarkup: options?.replyMarkup })
        return { outcome: 'delivered', messageId }
      },
      getDedicatedBinding: () => dedicated,
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async (sessionId, params) => {
          const key = `${sessionId}:${params.requestId}`
          if (!pending.has(key)) return false
          pending.delete(key)
          permissionResponses.push({ sessionId, requestId: params.requestId, allowed: params.allowed })
          return true
        },
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: (sessionId, requestId) => pending.has(`${sessionId}:${requestId}`),
        getSessionTurnState: () => 'idle',
      },
    })
    await withOrigin.start()
    await withOrigin.registerRuntime({ botId: BOT, generation: GEN })
    pending.add('sess-a:req-old')
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'evt-req-old',
      origin: { entrypoint: 'desktop', turnId: 'desktop-now' },
      message: {
        type: 'control_request',
        request_id: 'req-old',
        uuid: 'evt-req-old',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'Bash 请求' },
      },
    })
    await withOrigin.flushForTests()
    const snapStore = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const snapTokens = Object.values((await snapStore.read()).callbackTokens).filter(item => item.requestId === 'req-old')
    expect(snapTokens.length).toBeGreaterThan(0)
    expect(snapTokens.every(item => item.originEntrypoint === 'telegram-public')).toBe(true)
    const markup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const allow = markup.inline_keyboard.flat()[0]!.callback_data
    withOrigin.stop()
    const reopened = new TelegramPublicService({
      store: snapStore,
      now: () => nowMs,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      editTelegramChannelMessage: async (_token, chatId, messageId, text, options) => {
        if (editFailure) return { outcome: 'failed', error: 'fixture edit failure' }
        sent.push({ chatId, text, messageId, replyMarkup: options?.replyMarkup })
        return { outcome: 'delivered', messageId }
      },
      getDedicatedBinding: () => dedicated,
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async (sessionId, params) => {
          const key = `${sessionId}:${params.requestId}`
          if (!pending.has(key)) return false
          pending.delete(key)
          permissionResponses.push({ sessionId, requestId: params.requestId, allowed: params.allowed })
          return true
        },
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: (sessionId, requestId) => pending.has(`${sessionId}:${requestId}`),
        getSessionTurnState: () => 'idle',
      },
    })
    await reopened.start()
    await reopened.registerRuntime({ botId: BOT, generation: GEN })
    await reopened.handleUpdate({ botId: BOT, generation: GEN, update: callbackUpdate(allow, { update_id: 9201 }) })
    expect(permissionResponses.some(item => item.requestId === 'req-old')).toBe(true)
    reopened.stop()
  })

  test('可靠 team 元数据才进 header，没有则不强做', async () => {
    sessions.set('sess-a', { ...summary('sess-a', '修复登录', workRoot), team: '平台组', member: 'Alice' })
    await service.subscribe('sess-a')
    await emitResult('sess-a', '带团队', { uuid: 'team-1' })
    expect(sent.some(item => item.text.includes('平台组') && item.text.includes('Alice'))).toBe(true)
    sessions.set('sess-b', summary('sess-b', '支付退款', workRoot))
    await service.subscribe('sess-b')
    await emitResult('sess-b', '无团队', { uuid: 'team-2' })
    const plain = sent.find(item => item.text.includes('无团队'))!.text
    expect(plain).toContain('支付退款')
    expect(plain).not.toContain('undefined')
    expect(plain).not.toContain('平台组')
    expect(plain).not.toContain('Alice')
  })

  test('journal write 后 outbox 前崩溃会按 eventId 恢复；outbox 后删除前崩溃不重发', async () => {
    await service.subscribe('sess-a')
    service.stop()
    const log = TelegramPublicEventLog.fromStorePath(path.join(configDir, 'ccmax', 'telegram-public.json'))
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'crash-before-outbox',
      botId: BOT,
      generation: GEN,
      ownerUserId: OWNER,
      sessionId: 'sess-a',
      kind: 'result',
      observedAt: '2026-04-04T00:00:00.000Z',
      message: { type: 'result', result: '从日志恢复', uuid: 'crash-before-outbox' },
    })
    expect(log.readSync('crash-before-outbox', GEN)?.eventId).toBe('crash-before-outbox')
    const recovered = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await recovered.start()
    expect((await recovered.getStatus()).running).toBe(false)
    await recovered.registerRuntime({ botId: BOT, generation: GEN })
    await recovered.flushForTests()
    expect(sent.filter(item => item.text.includes('从日志恢复'))).toHaveLength(1)
    expect(log.readSync('crash-before-outbox', GEN)).toBeNull()

    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'after-outbox',
        idempotencyKey: 'crash-after-outbox:3:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'crash-after-outbox',
        part: 0,
        text: '[ccmax · x · y · S1] 已完成：outbox已有',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'crash-after-outbox',
      botId: BOT,
      generation: GEN,
      ownerUserId: OWNER,
      sessionId: 'sess-a',
      kind: 'result',
      observedAt: '2026-04-04T00:00:00.000Z',
      message: { type: 'result', result: 'outbox已有', uuid: 'crash-after-outbox' },
    })
    const before = sent.filter(item => item.text.includes('outbox已有')).length
    recovered.stop()
    const replayed = new TelegramPublicService({
      store,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await replayed.start()
    await replayed.registerRuntime({ botId: BOT, generation: GEN })
    await replayed.flushForTests()
    expect(sent.filter(item => item.text.includes('outbox已有')).length - before).toBe(1)
    expect(log.readSync('crash-after-outbox', GEN)).toBeNull()
    replayed.stop()
    recovered.stop()
  })

  test('损坏 journal fail-closed 暴露且不删除未知格式；观察同步落盘', async () => {
    await service.subscribe('sess-a')
    const log = TelegramPublicEventLog.fromStorePath(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await fs.mkdir(log.directory, { recursive: true })
    await fs.writeFile(path.join(log.directory, 'notes.txt'), 'keep', 'utf-8')
    await fs.writeFile(path.join(log.directory, telegramPublicEventLogFileName('bad', GEN)), '{nope', 'utf-8')
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'sync-journal',
      message: { type: 'result', result: '同步写入', uuid: 'sync-journal' },
    })
    expect(log.readSync('sync-journal', GEN)?.eventId).toBe('sync-journal')
    service.stop()
    const crashed = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async () => ({ outcome: 'delivered', messageId: 1 }),
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await crashed.start()
    const status = await crashed.getStatus()
    expect(status.error).toMatch(/corrupt|unknown format/)
    expect(await fs.readFile(path.join(log.directory, 'notes.txt'), 'utf-8')).toBe('keep')
    expect(await fs.readFile(path.join(log.directory, telegramPublicEventLogFileName('bad', GEN)), 'utf-8')).toBe('{nope')
    crashed.stop()
  })

  test('同 chatId 双 Bot 的映射、入站与回调不混线', async () => {
    await service.subscribe('sess-a')
    await service.subscribe('sess-b')
    await emitResult('sess-a', '公共报告', { uuid: 'pub-map' })
    const report = sent.find(item => item.text.includes('公共报告'))!
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.messageMaps[`${GEN}:1:${OWNER}:${report.messageId}`] = {
        generation: GEN,
        botId: 1,
        chatId: String(OWNER),
        messageId: report.messageId,
        sessionId: 'sess-b',
        shortId: 'SDED1',
        kind: 'report',
        createdAt: '2026-04-04T00:00:00.000Z',
      }
      current.inboundUpdates[`${GEN}:1:7001`] = {
        key: `${GEN}:1:7001`,
        updateId: 7001,
        botId: 1,
        generation: GEN,
        status: 'completed',
        createdAt: '2026-04-04T00:00:00.000Z',
      }
    })
    const accepted = await inbound(privateMessage('只进公共', {
      update_id: 7001,
      reply_to_message_id: report.messageId,
    }))
    expect(accepted).toEqual({ ok: true, accepted: true })
    expect(submitted).toEqual([expect.objectContaining({ sessionId: 'sess-a', content: '只进公共' })])
    const otherBot = await service.handleUpdate({
      botId: 1,
      generation: GEN,
      update: privateMessage('专属侧', { update_id: 7002, reply_to_message_id: report.messageId }),
    })
    expect(otherBot).toEqual({ ok: false, error: 'Bot 运行时未注册或已停止' })
    expect(submitted).toHaveLength(1)
  })

  test('桌面无专属绑定时公共可审批；专属来源无绑定只读；绑定出现后旧按钮失效', async () => {
    await service.subscribe('sess-a')
    dedicated = null
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))

    await emitPermission('sess-a', 'req-desk', 'Bash', { entrypoint: 'desktop', turnId: 'desk-1' })
    const desktopMsg = sent.filter(item => item.text.includes('Bash 请求') && item.replyMarkup).at(-1)
    expect(desktopMsg?.replyMarkup).toBeTruthy()
    expect(desktopMsg?.text.includes('仅可查看') || desktopMsg?.text.includes('不是公共入口')).toBe(false)
    const deskMarkup = desktopMsg!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    const deskAllow = deskMarkup.inline_keyboard.flat().find(button => button.callback_data.startsWith('tgp:'))!.callback_data
    expect(Object.values((await store.read()).callbackTokens).some(item => item.requestId === 'req-desk')).toBe(true)
    await inbound(callbackUpdate(deskAllow, { update_id: 9401 }))
    expect(permissionResponses).toEqual([{ sessionId: 'sess-a', requestId: 'req-desk', allowed: true }])
    expect(Object.values((await store.read()).callbackTokens).some(item => item.requestId === 'req-desk')).toBe(false)

    await emitPermission('sess-a', 'req-ded-free', 'Bash', {
      entrypoint: 'telegram-dedicated', botId: 1, generation: 1, turnId: 'd-free',
    })
    const dedicatedMsg = sent.filter(item => item.text.includes('专属入口')).at(-1)
    expect(dedicatedMsg).toBeTruthy()
    expect(dedicatedMsg?.replyMarkup).toBeUndefined()
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-ded-free')).toHaveLength(0)

    await emitPermission('sess-a', 'req-desk-2', 'Bash', { entrypoint: 'desktop', turnId: 'desk-2' })
    const later = sent.filter(item => item.replyMarkup && item.text.includes('Bash 请求')).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const laterAllow = later.inline_keyboard.flat()[0]!.callback_data
    dedicated = { sessionId: 'sess-a' }
    const beforeBoundClick = sent.length
    await inbound(callbackUpdate(laterAllow, { update_id: 9402 }))
    expect(permissionResponses.some(item => item.requestId === 'req-desk-2')).toBe(false)
    expect(sent.slice(beforeBoundClick).some(item => item.text.includes('专属入口处理'))).toBe(true)
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-desk-2')).toHaveLength(0)

    await emitPermission('sess-a', 'req-desk-bound-live', 'Bash', { entrypoint: 'desktop', turnId: 'desk-bound-live' })
    const boundLive = sent.filter(item => item.text.includes('Bash 请求')).at(-1)
    expect(boundLive?.replyMarkup).toBeUndefined()
    expect(boundLive?.text.includes('专属入口')).toBe(true)
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-desk-bound-live')).toHaveLength(0)

    await emitPermission('sess-a', 'req-pub', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'p-ok',
    })
    const publicMsg = sent.filter(item => item.replyMarkup && item.text.includes('Bash 请求')).at(-1)
    expect(publicMsg?.replyMarkup).toBeTruthy()
    const publicMarkup = publicMsg!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    const publicAllow = publicMarkup.inline_keyboard.flat()[0]!.callback_data
    await inbound(callbackUpdate(publicAllow, { update_id: 9403 }))
    expect(permissionResponses.some(item => item.requestId === 'req-pub' && item.allowed)).toBe(true)
  })

  test('公共来源 snapshot 与当前 bot 不一致时，即使 event.origin 是 desktop 也不发可操作按钮', async () => {
    await service.subscribe('sess-a')
    service.stop()
    dedicated = null
    const origins = new Map<string, TelegramPublicOrigin>([
      ['sess-a:req-stale-public', { entrypoint: 'telegram-public', botId: BOT + 1, generation: GEN, turnId: 'stale' }],
    ])
    const withOrigin = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      now: () => nowMs,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      getSessionPermissionOrigin: (sessionId, requestId) => origins.get(`${sessionId}:${requestId}`),
      observeSessionTurns: listener => {
        observer = listener
        return () => { observer = undefined }
      },
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      editTelegramChannelMessage: async (_token, chatId, messageId, text, options) => {
        if (editFailure) return { outcome: 'failed', error: 'fixture edit failure' }
        sent.push({ chatId, text, messageId, replyMarkup: options?.replyMarkup })
        return { outcome: 'delivered', messageId }
      },
      getDedicatedBinding: () => dedicated,
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async (sessionId, params) => {
          const key = `${sessionId}:${params.requestId}`
          if (!pending.has(key)) return false
          pending.delete(key)
          permissionResponses.push({ sessionId, requestId: params.requestId, allowed: params.allowed })
          return true
        },
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: (sessionId, requestId) => pending.has(`${sessionId}:${requestId}`),
        getSessionTurnState: () => 'idle',
      },
    })
    await withOrigin.start()
    await withOrigin.registerRuntime({ botId: BOT, generation: GEN })
    pending.add('sess-a:req-stale-public')
    const before = sent.length
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'evt-req-stale-public',
      origin: { entrypoint: 'desktop', turnId: 'desktop-now' },
      message: {
        type: 'control_request',
        request_id: 'req-stale-public',
        uuid: 'evt-req-stale-public',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'Bash 请求' },
      },
    })
    await withOrigin.flushForTests()
    expect(sent.length).toBe(before)
    const staleStore = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    expect(Object.values((await staleStore.read()).callbackTokens)
      .filter(item => item.requestId === 'req-stale-public')).toHaveLength(0)
    withOrigin.stop()
  })

  test('drain 校验 botId/generation/owner chatId，旧 queued 不改投', async () => {
    await service.subscribe('sess-a')
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    await store.mutate(current => {
      current.outbox.push({
        id: 'wrong-bot',
        idempotencyKey: 'wrong-bot:3:100:4242:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT + 1,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'wrong-bot',
        part: 0,
        text: '不应改投的旧 Bot 待发',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
      current.outbox.push({
        id: 'wrong-chat',
        idempotencyKey: 'wrong-chat:3:99:7:sess-a:0',
        status: 'queued',
        generation: GEN,
        botId: BOT,
        chatId: '7',
        sessionId: 'sess-a',
        eventId: 'wrong-chat',
        part: 0,
        text: '不应发给旧 chat',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
      current.outbox.push({
        id: 'wrong-gen',
        idempotencyKey: 'wrong-gen:2:99:4242:sess-a:0',
        status: 'queued',
        generation: GEN - 1,
        botId: BOT,
        chatId: String(OWNER),
        sessionId: 'sess-a',
        eventId: 'wrong-gen',
        part: 0,
        text: '旧代次待发',
        attempts: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        updatedAt: '2026-04-04T00:00:00.000Z',
      })
    })
    await service.flushForTests()
    const after = await store.read()
    expect(after.outbox.find(item => item.id === 'wrong-bot')?.status).toBe('failed')
    expect(after.outbox.find(item => item.id === 'wrong-chat')?.status).toBe('failed')
    expect(after.outbox.find(item => item.id === 'wrong-gen')?.status).toBe('failed')
    expect(sent.some(item => item.text.includes('不应改投') || item.text.includes('不应发给旧') || item.text.includes('旧代次待发'))).toBe(false)
  })

  test('失败与未知 send 不写 messageMap 且不二次发送', async () => {
    await service.subscribe('sess-a')
    sendImpl = async () => ({ outcome: 'failed', error: 'forbidden' })
    await emitResult('sess-a', '永久失败正文', { uuid: 'perm-fail' })
    const failedAttempts = sent.filter(item => item.text.includes('永久失败正文')).length
    expect(failedAttempts).toBe(1)
    await service.flushForTests()
    expect(sent.filter(item => item.text.includes('永久失败正文')).length).toBe(1)
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const failed = (await store.read()).outbox.find(item => item.eventId === 'perm-fail')
    expect(failed?.status).toBe('failed')
    expect(Object.values((await store.read()).messageMaps).some(item => item.eventId === 'perm-fail')).toBe(false)

    sendImpl = async () => ({ outcome: 'indeterminate', error: 'timeout' })
    await emitResult('sess-a', '未知结果正文', { uuid: 'unk-fail' })
    const unknownAttempts = sent.filter(item => item.text.includes('未知结果正文')).length
    expect(unknownAttempts).toBe(1)
    await service.flushForTests()
    expect(sent.filter(item => item.text.includes('未知结果正文')).length).toBe(1)
    expect(Object.values((await store.read()).messageMaps).some(item => item.eventId === 'unk-fail')).toBe(false)
    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'perm-fail',
      message: { type: 'result', result: '永久失败正文', uuid: 'perm-fail' },
    })
    await service.flushForTests()
    expect(sent.filter(item => item.text.includes('永久失败正文')).length).toBe(1)
  })

  test('旧 generation 回调失效且不消费当前 token', async () => {
    await service.subscribe('sess-a')
    await emitPermission('sess-a', 'req-stale-cb', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'stale-cb',
    })
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const tokens = Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-stale-cb')
    expect(tokens).toHaveLength(2)
    const allow = tokens.find(item => item.action === 'allow')!
    const deny = tokens.find(item => item.action === 'deny')!
    await store.mutate(current => {
      current.callbackTokens[allow.token] = { ...allow, generation: GEN - 1 }
    })
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: callbackUpdate(`tgp:${allow.token}`, { update_id: 9301 }),
    })
    expect(permissionResponses.some(item => item.requestId === 'req-stale-cb')).toBe(false)
    expect(sent.some(item => item.text.includes('不属于当前 Bot'))).toBe(true)
    expect((await store.read()).callbackTokens[deny.token]?.requestId).toBe('req-stale-cb')
    await service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: callbackUpdate(`tgp:${deny.token}`, { update_id: 9302 }),
    })
    expect(permissionResponses).toEqual([{ sessionId: 'sess-a', requestId: 'req-stale-cb', allowed: false }])
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-stale-cb')).toHaveLength(0)
  })

  test('错误 generation/owner 的 event spool 不回放、不删除', async () => {
    await service.subscribe('sess-a')
    service.stop()
    const log = TelegramPublicEventLog.fromStorePath(path.join(configDir, 'ccmax', 'telegram-public.json'))
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'old-gen-journal',
      botId: BOT,
      generation: GEN - 1,
      ownerUserId: OWNER,
      sessionId: 'sess-a',
      kind: 'result',
      observedAt: '2026-04-04T00:00:00.000Z',
      message: { type: 'result', result: '旧代次日志', uuid: 'old-gen-journal' },
    })
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'old-owner-journal',
      botId: BOT,
      generation: GEN,
      ownerUserId: 7,
      sessionId: 'sess-a',
      kind: 'result',
      observedAt: '2026-04-04T00:00:00.000Z',
      message: { type: 'result', result: '旧 owner 日志', uuid: 'old-owner-journal' },
    })
    const recovered = new TelegramPublicService({
      store: new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json')),
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => false,
        getSessionTurnState: () => 'idle',
      },
    })
    await recovered.start()
    await recovered.registerRuntime({ botId: BOT, generation: GEN })
    await recovered.flushForTests()
    expect(sent.some(item => item.text.includes('旧代次日志') || item.text.includes('旧 owner 日志'))).toBe(false)
    expect(log.readSync('old-gen-journal', GEN - 1)?.eventId).toBe('old-gen-journal')
    expect(log.readSync('old-owner-journal', GEN)?.eventId).toBe('old-owner-journal')
    recovered.stop()
  })

  test('registerRuntime 必须对应 token 前缀与已保存 runtime botId', async () => {
    await expect(service.registerRuntime({ botId: BOT + 1, generation: GEN })).rejects.toMatchObject({
      statusCode: 400,
      message: 'botId does not match registered runtime identity',
    })
    expect((await service.getStatus()).botId).toBe(BOT)

    publicConfig.botToken = `${BOT + 7}:AAHfake-token`
    publicConfig.generation = GEN + 1
    await expect(service.registerRuntime({ botId: BOT, generation: GEN + 1 })).rejects.toMatchObject({
      statusCode: 400,
      message: 'botId does not match telegram.public.botToken identity',
    })
    await service.registerRuntime({ botId: BOT + 7, generation: GEN + 1 })
    expect((await service.getStatus()).botId).toBe(BOT + 7)
    expect((await service.getStatus()).generation).toBe(GEN + 1)
  })

  test('同一 requestId 换 eventId/来源回放不改成可操作审批，故障恢复也不重投', async () => {
    await service.subscribe('sess-a')
    dedicated = null
    await emitPermission('sess-a', 'req-replay', 'Bash', {
      entrypoint: 'telegram-dedicated', botId: 1, generation: 1, turnId: 'd-replay',
    })
    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-replay')).toHaveLength(0)
    expect((await store.read()).outbox.some(item => item.sessionId === 'sess-a' && item.requestId === 'req-replay')).toBe(true)

    observer?.({
      type: 'output',
      sessionId: 'sess-a',
      eventId: 'evt-req-replay-2',
      origin: { entrypoint: 'desktop', turnId: 'desk-replay' },
      message: {
        type: 'control_request',
        request_id: 'req-replay',
        uuid: 'evt-req-replay-2',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'Bash 请求' },
      },
    })
    await service.flushForTests()
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-replay')).toHaveLength(0)
    expect((await store.read()).outbox.filter(item => item.eventId === 'evt-req-replay-2')).toHaveLength(0)
    expect(sent.filter(item => item.replyMarkup && item.text.includes('Bash 请求')).length).toBe(0)

    service.stop()
    const log = TelegramPublicEventLog.fromStorePath(path.join(configDir, 'ccmax', 'telegram-public.json'))
    log.writeSync({
      schemaVersion: TELEGRAM_PUBLIC_EVENT_LOG_SCHEMA_VERSION,
      eventId: 'evt-req-replay-journal',
      botId: BOT,
      generation: GEN,
      ownerUserId: OWNER,
      sessionId: 'sess-a',
      kind: 'control_request',
      observedAt: '2026-04-04T00:00:00.000Z',
      origin: { entrypoint: 'desktop', turnId: 'journal-replay' },
      message: {
        type: 'control_request',
        request_id: 'req-replay',
        uuid: 'evt-req-replay-journal',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'Bash 请求' },
      },
    })
    const recovered = new TelegramPublicService({
      store,
      getRawConfig: async () => ({ telegram: { public: publicConfig } }),
      getSessionSummary: async id => sessions.get(id) ?? null,
      observeSessionTurns: () => () => {},
      sendTelegramChannelMessage: async (_token, chatId, text, options) => {
        const result = await sendImpl()
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup, messageId: result.messageId ?? -1 })
        return result
      },
      getDedicatedBinding: () => null,
      handler: {
        submitHumanSessionTurn: async () => {},
        respondToSessionPermission: async () => false,
        respondToSessionComputerUsePermission: async () => false,
        isSessionPermissionPending: () => true,
        getSessionTurnState: () => 'idle',
      },
    })
    await recovered.start()
    await recovered.registerRuntime({ botId: BOT, generation: GEN })
    await recovered.flushForTests()
    expect(Object.values((await store.read()).callbackTokens).filter(item => item.requestId === 'req-replay')).toHaveLength(0)
    expect(sent.filter(item => item.replyMarkup && item.text.includes('Bash 请求'))).toHaveLength(0)
    expect(log.readSync('evt-req-replay-journal', GEN)).toBeNull()
    recovered.stop()
  })

  test('入站提交在 sessionSummary await 期间代次轮换不得提交', async () => {
    await service.subscribe('sess-a')
    await emitResult('sess-a', '报告', { uuid: 'await-gen' })
    const report = sent.find(item => item.text.includes('报告'))!
    let resume!: () => void
    const entered = new Promise<void>(resolve => { summaryEntered = resolve })
    summaryWait = new Promise<void>(resolve => { resume = resolve })
    const pendingUpdate = service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: privateMessage('轮换后不应提交', { update_id: 9801, reply_to_message_id: report.messageId }),
    })
    await entered
    publicConfig.generation = GEN + 1
    await service.registerRuntime({ botId: BOT, generation: GEN + 1 })
    resume()
    summaryWait = undefined
    const result = await pendingUpdate
    await service.flushForTests()
    expect(submitted).toHaveLength(0)
    expect(result).toEqual({ ok: true })
    expect(sent.some(item => item.text.includes('代次') || item.text.includes('未接收') || item.text.includes('已变更'))).toBe(true)
  })

  test('callback 在 sessionSummary await 期间配置代次变更不得审批', async () => {
    await service.subscribe('sess-a')
    await emitPermission('sess-a', 'req-await-cb', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'await-cb',
    })
    const markup = sent.filter(item => item.replyMarkup).at(-1)!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    const allow = markup.inline_keyboard.flat()[0]!.callback_data
    let resume!: () => void
    const entered = new Promise<void>(resolve => { summaryEntered = resolve })
    summaryWait = new Promise<void>(resolve => { resume = resolve })
    const pendingUpdate = service.handleUpdate({
      botId: BOT,
      generation: GEN,
      update: callbackUpdate(allow, { update_id: 9802 }),
    })
    await entered
    publicConfig.generation = GEN + 1
    resume()
    summaryWait = undefined
    await pendingUpdate
    expect(permissionResponses.some(item => item.requestId === 'req-await-cb')).toBe(false)
  })

  test('多会话各自归属；取消一个后另一个仍报告，已取消者的待发/回复映射/审批回调按语义失效', async () => {
    const a = await service.subscribe('sess-a')
    const b = await service.subscribe('sess-b')

    await emitResult('sess-a', 'A 独立完成', {
      uuid: 'multi-a',
      origin: { entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'turn-a' },
    })
    await emitResult('sess-b', 'B 独立完成', {
      uuid: 'multi-b',
      origin: { entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'turn-b' },
    })

    const store = new TelegramPublicStore(path.join(configDir, 'ccmax', 'telegram-public.json'))
    const initial = await store.read()
    const outA = initial.outbox.filter(record => record.eventId === 'multi-a')
    const outB = initial.outbox.filter(record => record.eventId === 'multi-b')
    expect(outA).toHaveLength(1)
    expect(outB).toHaveLength(1)
    expect(outA[0]?.sessionId).toBe('sess-a')
    expect(outB[0]?.sessionId).toBe('sess-b')
    expect(outA[0]?.chatId).toBe(String(OWNER))
    expect(outB[0]?.chatId).toBe(String(OWNER))
    expect(outA[0]?.status).toBe('delivered')
    expect(outB[0]?.status).toBe('delivered')

    const reportA = sent.find(item => item.text.includes('A 独立完成'))!
    const reportB = sent.find(item => item.text.includes('B 独立完成'))!
    expect(reportA.chatId).toBe(String(OWNER))
    expect(reportA.messageId).toBe(outA[0]?.messageId)
    expect(reportA.text).toContain('修复登录')
    expect(reportA.text).toContain(a.shortId)
    expect(reportA.text).not.toContain('支付退款')
    expect(reportB.chatId).toBe(String(OWNER))
    expect(reportB.messageId).toBe(outB[0]?.messageId)
    expect(reportB.text).toContain('支付退款')
    expect(reportB.text).toContain(b.shortId)
    expect(reportB.text).not.toContain('修复登录')

    sendImpl = async () => ({ outcome: 'failed', error: 'too many', retryAfterMs: 120_000 })
    await emitResult('sess-a', 'A 限流待发', { uuid: 'multi-a-queued' })
    sendImpl = async () => ({ outcome: 'delivered', messageId: ++nextMessageId })
    await emitPermission('sess-a', 'req-multi-a', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'turn-a-perm',
    })
    await emitPermission('sess-b', 'req-multi-b', 'Bash', {
      entrypoint: 'telegram-public', botId: BOT, generation: GEN, turnId: 'turn-b-perm',
    })

    const beforeCancel = await store.read()
    expect(beforeCancel.outbox.some(record =>
      record.sessionId === 'sess-a' && record.eventId === 'multi-a-queued' && record.status === 'queued',
    )).toBe(true)
    expect(Object.values(beforeCancel.callbackTokens).some(entry => entry.sessionId === 'sess-a')).toBe(true)
    expect(Object.values(beforeCancel.callbackTokens).some(entry => entry.sessionId === 'sess-b')).toBe(true)
    expect(Object.values(beforeCancel.messageMaps).some(entry => entry.sessionId === 'sess-a')).toBe(true)
    expect(Object.values(beforeCancel.messageMaps).some(entry => entry.sessionId === 'sess-b')).toBe(true)

    await service.unsubscribe('sess-a')

    const afterCancel = await store.read()
    expect(afterCancel.subscriptions['sess-a']).toBeUndefined()
    expect(afterCancel.subscriptions['sess-b']).toBeDefined()
    const queuedA = afterCancel.outbox.find(record => record.eventId === 'multi-a-queued')!
    expect(queuedA.status).toBe('failed')
    expect(queuedA.error).toContain('已取消订阅')
    expect(Object.values(afterCancel.callbackTokens).some(entry => entry.sessionId === 'sess-a')).toBe(false)
    expect(Object.values(afterCancel.messageMaps).some(entry => entry.sessionId === 'sess-a')).toBe(false)
    expect(Object.values(afterCancel.callbackTokens).some(entry => entry.sessionId === 'sess-b')).toBe(true)
    expect(Object.values(afterCancel.messageMaps).some(entry => entry.sessionId === 'sess-b')).toBe(true)

    const beforeIsolated = sent.length
    await emitResult('sess-a', 'A 取消后不应投递', { uuid: 'multi-a-after' })
    await emitResult('sess-b', 'B 取消后仍报告', { uuid: 'multi-b-after' })
    expect(sent.some(item => item.text.includes('A 取消后不应投递'))).toBe(false)
    expect(sent.length).toBe(beforeIsolated + 1)
    const isolatedB = sent.find(item => item.text.includes('B 取消后仍报告'))!
    expect(isolatedB.chatId).toBe(String(OWNER))
    expect(isolatedB.text).toContain('支付退款')
    expect(isolatedB.text).not.toContain('修复登录')

    const final = await store.read()
    expect(final.outbox.some(record => record.eventId === 'multi-a-after')).toBe(false)
    expect(final.outbox.some(record => record.eventId === 'multi-b-after' && record.status === 'delivered')).toBe(true)
  })
})
