/**
 * Public Telegram entry: forward raw updates to the local server.
 *
 * No chatId runtime, no session WebSocket, no media download, and no writes
 * to the dedicated SessionStore. Pairing, replies and reports stay on the server.
 */

import { Bot, type Context } from 'grammy'
import { loadConfig, type AdapterConfig } from '../common/config.js'
import { telegramBotIdFromToken } from './bot-identity.js'
import { sanitizeTelegramError } from './sanitize-error.js'

export const PUBLIC_HTTP_TIMEOUT_MS = 15_000
export const PUBLIC_RUNTIME_PATH = '/api/telegram/public/runtime'
export const PUBLIC_UPDATE_PATH = '/api/telegram/public/update'
const FORWARD_FAILURE_NOTICE = '转发失败，请稍后重试。'

type PublicBotHook = (bot: Bot) => void
type PublicJson = {
  ok?: boolean
  error?: string
  message?: string
  botId?: number
  generation?: number
  accepted?: boolean
  duplicate?: boolean
}
type PublicPostResult = {
  status: number
  json: PublicJson | null
}

let publicBot: Bot | undefined
let publicBotHook: PublicBotHook | undefined
let registeredBotId: number | undefined
let registeredGeneration: number | undefined
let startedToken = ''
let lastDedicatedBotId: number | undefined
let serverUrl = ''
let startGeneration = 0
let publicUpdateTail = Promise.resolve()
let relaunchQueued = false
const inflight = new Set<Promise<void>>()

export function isTelegramPublicConfigured(config: AdapterConfig): boolean {
  return Boolean(config.telegram.public.enabled && config.telegram.public.botToken)
}

export function setPublicTelegramBotHook(hook: PublicBotHook | undefined): void {
  publicBotHook = hook
}

export function getPublicTelegramBot(): Bot | undefined {
  return publicBot
}

export async function startPublicTelegramAdapter(options?: {
  dedicatedBotId?: number
}): Promise<boolean> {
  const config = loadConfig()
  if (!isTelegramPublicConfigured(config)) return false

  const dedicatedBotId = options && 'dedicatedBotId' in options
    ? options.dedicatedBotId
    : lastDedicatedBotId

  if (publicBot) await stopPublicTelegramAdapter()
  lastDedicatedBotId = dedicatedBotId

  const generation = ++startGeneration
  const token = config.telegram.public.botToken
  serverUrl = config.serverUrl
  const bot = new Bot(token)
  publicBot = bot
  publicBotHook?.(bot)

  bot.catch((err) => {
    console.error('[Telegram public]', sanitizeTelegramError(err))
  })
  bot.on('message', (ctx) => enqueuePublicUpdate(ctx))
  bot.on('callback_query', (ctx) => enqueuePublicUpdate(ctx))

  const publicPrefix = telegramBotIdFromToken(token)
  if (lastDedicatedBotId != null && publicPrefix != null && publicPrefix === lastDedicatedBotId) {
    console.error('[Telegram public] Bot id matches dedicated entry; public not started')
    await abandonPublicStart(generation)
    return false
  }

  let me: { id: number }
  try {
    me = await bot.api.getMe()
    bot.botInfo = me as Bot['botInfo']
  } catch (err) {
    console.error('[Telegram public] getMe failed:', sanitizeTelegramError(err))
    await abandonPublicStart(generation)
    return false
  }

  if (lastDedicatedBotId != null && me.id === lastDedicatedBotId) {
    console.error('[Telegram public] Bot id matches dedicated entry; public not started')
    await abandonPublicStart(generation)
    return false
  }

  if (startGeneration !== generation) {
    await abandonPublicStart(generation)
    return false
  }

  try {
    await registerPublicRuntime(me.id, config.telegram.public.generation)
  } catch (err) {
    console.error('[Telegram public] runtime register failed:', sanitizeTelegramError(err))
    await abandonPublicStart(generation)
    return false
  }

  if (startGeneration !== generation) {
    await abandonPublicStart(generation)
    return false
  }

  const latestToken = loadConfig().telegram.public.botToken
  if (latestToken !== token) {
    console.error('[Telegram public] token changed before polling; restarting identity')
    await abandonPublicStart(generation)
    queuePublicRelaunch()
    return false
  }

  startedToken = token

  let started = false
  try {
    await new Promise<void>((resolve, reject) => {
      void bot.start({
        // Server-side update deduplication handles replay after a restart.
        // Dropping Telegram's queue here would lose unprocessed human input.
        drop_pending_updates: false,
        onStart: () => {
          started = true
          console.log('[Telegram public] Bot is running')
          resolve()
        },
      }).catch((err) => {
        if (!started) {
          reject(err)
          return
        }
        console.error('[Telegram public] polling failed:', sanitizeTelegramError(err))
        if (startGeneration === generation) void stopPublicTelegramAdapter()
      })
    })
  } catch (err) {
    console.error('[Telegram public] polling failed:', sanitizeTelegramError(err))
    await abandonPublicStart(generation)
    return false
  }

  if (startGeneration !== generation) {
    await abandonPublicStart(generation)
    return false
  }
  return true
}

async function abandonPublicStart(generation: number): Promise<void> {
  if (startGeneration !== generation) return
  await stopPublicTelegramAdapter()
}

export async function stopPublicTelegramAdapter(): Promise<void> {
  startGeneration += 1
  const bot = publicBot
  const botId = registeredBotId
  const generation = registeredGeneration
  publicBot = undefined
  registeredBotId = undefined
  registeredGeneration = undefined
  startedToken = ''
  lastDedicatedBotId = undefined
  const pending = [...inflight]
  if (pending.length > 0) await Promise.allSettled(pending)
  if (bot?.isRunning()) {
    try {
      await bot.stop()
    } catch (err) {
      console.error('[Telegram public] stop failed:', sanitizeTelegramError(err))
    }
  }
  if (botId != null && generation != null) {
    try {
      await deletePublicRuntime(botId, generation)
    } catch (err) {
      console.error('[Telegram public] runtime deregister failed:', sanitizeTelegramError(err))
    }
  }
}

function enqueuePublicUpdate(ctx: Context): Promise<void> {
  const task = publicUpdateTail.then(
    () => handlePublicUpdate(ctx),
    () => handlePublicUpdate(ctx),
  )
  publicUpdateTail = task.then(() => undefined, () => undefined)
  inflight.add(task)
  void task.finally(() => inflight.delete(task))
  return task
}

async function handlePublicUpdate(ctx: Context): Promise<void> {
  let notice: string | undefined
  try {
    notice = await forwardPublicUpdate(ctx)
  } catch (err) {
    notice = FORWARD_FAILURE_NOTICE
    console.error('[Telegram public] update forward failed:', sanitizeTelegramError(err))
  }
  await acknowledgePublicUpdate(ctx, notice)
}

async function forwardPublicUpdate(ctx: Context): Promise<string | undefined> {
  const update = ctx.update
  const pub = loadConfig().telegram.public
  if (!pub.enabled || registeredBotId == null || !startedToken) return
  if (pub.botToken !== startedToken) {
    console.error('[Telegram public] bot token changed; refusing stale poller and re-verifying identity')
    queuePublicRelaunch()
    return
  }
  if (pub.generation !== registeredGeneration) {
    await registerPublicRuntime(registeredBotId, pub.generation)
  }

  const payload = {
    botId: registeredBotId,
    generation: pub.generation,
    update,
  }
  const result = await postPublicJson('POST', PUBLIC_UPDATE_PATH, payload)
  if (isRuntimeIdentityMismatch(result)) {
    const latest = loadConfig().telegram.public
    if (latest.botToken !== startedToken) {
      queuePublicRelaunch()
      return
    }
    await registerPublicRuntime(registeredBotId, latest.generation)
    const retried = await postPublicJson('POST', PUBLIC_UPDATE_PATH, {
      botId: registeredBotId,
      generation: latest.generation,
      update,
    })
    return interpretUpdateResult(retried)
  }
  return interpretUpdateResult(result)
}

function interpretUpdateResult(result: PublicPostResult): string | undefined {
  if (isUpdateAccepted(result)) return undefined
  return publicErrorNotice(result) ?? FORWARD_FAILURE_NOTICE
}

function isUpdateAccepted(result: PublicPostResult): boolean {
  if (result.status < 200 || result.status >= 300) return false
  if (!result.json) return false
  if (result.json.ok === false) return false
  if (typeof result.json.error === 'string' && result.json.ok !== true) return false
  return result.json.ok === true
}

async function acknowledgePublicUpdate(ctx: Context, notice: string | undefined): Promise<void> {
  try {
    if (ctx.callbackQuery) {
      if (notice) {
        await ctx.answerCallbackQuery({ text: notice.slice(0, 200), show_alert: true })
      } else {
        await ctx.answerCallbackQuery()
      }
      return
    }
    if (notice && ctx.chat) {
      await ctx.reply(notice)
    }
  } catch (err) {
    console.error('[Telegram public] user notice failed:', sanitizeTelegramError(err))
  }
}

function queuePublicRelaunch(): void {
  if (relaunchQueued) return
  relaunchQueued = true
  const dedicatedBotId = lastDedicatedBotId
  queueMicrotask(() => {
    void (async () => {
      try {
        await stopPublicTelegramAdapter()
        await startPublicTelegramAdapter({ dedicatedBotId })
      } catch (err) {
        console.error('[Telegram public] relaunch failed:', sanitizeTelegramError(err))
      } finally {
        relaunchQueued = false
      }
    })()
  })
}

async function registerPublicRuntime(botId: number, generation: number): Promise<void> {
  const result = await postPublicJson('POST', PUBLIC_RUNTIME_PATH, { botId, generation })
  assertRuntimeRegistered(result, botId, generation)
  registeredBotId = botId
  registeredGeneration = generation
}

function assertRuntimeRegistered(result: PublicPostResult, botId: number, generation: number): void {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(publicErrorNotice(result) ?? `runtime register HTTP ${result.status}`)
  }
  if (!result.json) {
    throw new Error('runtime register returned no JSON')
  }
  if (result.json.ok === false) {
    throw new Error(publicErrorNotice(result) ?? 'runtime register rejected')
  }
  if (typeof result.json.error === 'string' && result.json.botId == null) {
    throw new Error(result.json.message || result.json.error)
  }
  if (result.json.botId !== botId || result.json.generation !== generation) {
    throw new Error('runtime register did not persist the requested bot identity')
  }
}

async function deletePublicRuntime(botId: number, generation: number): Promise<void> {
  await postPublicJson('DELETE', PUBLIC_RUNTIME_PATH, { botId, generation })
}

function isRuntimeIdentityMismatch(result: PublicPostResult): boolean {
  if (result.status === 409) return true
  const text = `${result.json?.error ?? ''} ${result.json?.message ?? ''}`
  return /代次|不一致|CONFLICT/i.test(text)
}

function publicErrorNotice(result: PublicPostResult): string | undefined {
  const message = result.json?.error || result.json?.message
  if (typeof message === 'string' && message.trim() && message.length < 200) return message
  return undefined
}

async function postPublicJson(
  method: 'POST' | 'DELETE',
  pathname: string,
  body: unknown,
): Promise<PublicPostResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUBLIC_HTTP_TIMEOUT_MS)
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    const token = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN?.trim()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${httpBaseUrl(serverUrl)}${pathname}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let json: PublicJson | null = null
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as PublicJson
        }
      } catch {
        json = null
      }
    }
    return { status: response.status, json }
  } finally {
    clearTimeout(timer)
  }
}

function httpBaseUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/$/, '')
}