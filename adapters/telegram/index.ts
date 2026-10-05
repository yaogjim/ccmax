/**
 * Telegram adapter launcher.
 *
 * Loads the dedicated exclusive-session bot and/or the public forwarder from
 * config. Existing tests keep importing this module for
 * `bot` / `startTelegramAdapter` / `stopTelegramAdapter` / `MAX_PENDING_INPUTS_PER_CHAT`.
 *
 * Dedicated is loaded only when a dedicated token is present. The specifier
 * below is a string literal so bun compile / scan-missing-imports can include
 * `dedicated.ts` in the sidecar without evaluating it for public-only runs.
 *
 * Start: TELEGRAM_BOT_TOKEN=xxx bun run telegram/index.ts
 * Desktop sidecar: --telegram (public-only config also takes this flag).
 */

import { loadConfig } from '../common/config.js'
import { resolveDedicatedIdentity } from './bot-identity.js'
import {
  isTelegramPublicConfigured,
  setPublicTelegramBotHook,
  startPublicTelegramAdapter,
  stopPublicTelegramAdapter,
} from './public.js'
import { sanitizeTelegramError } from './sanitize-error.js'

type DedicatedModule = typeof import('./dedicated.js')

const FALLBACK_MAX_PENDING_INPUTS_PER_CHAT = 8

function loadDedicatedModule(): Promise<DedicatedModule> {
  return import('./dedicated.js')
}

const config = loadConfig()

let dedicated: DedicatedModule | undefined
if (config.telegram.botToken) {
  try {
    dedicated = await loadDedicatedModule()
  } catch (err) {
    console.error('[Telegram] Dedicated module failed to load:', sanitizeTelegramError(err))
  }
}

export const bot = dedicated?.bot as DedicatedModule['bot']
export const MAX_PENDING_INPUTS_PER_CHAT =
  dedicated?.MAX_PENDING_INPUTS_PER_CHAT ?? FALLBACK_MAX_PENDING_INPUTS_PER_CHAT
export { setPublicTelegramBotHook }

let shutdownBound = false
let publicStarting: Promise<boolean> | undefined

export async function stopTelegramAdapter(): Promise<void> {
  const pendingPublic = publicStarting
  publicStarting = undefined
  await Promise.all([
    stopPublicTelegramAdapter(),
    dedicated ? dedicated.stopTelegramAdapter() : Promise.resolve(),
  ])
  if (pendingPublic) await pendingPublic.catch(() => {})
}

export function startTelegramAdapter(): void {
  bindProcessShutdown()
  if (dedicated) {
    try {
      dedicated.startTelegramAdapter({ registerProcessShutdown: false })
    } catch (err) {
      console.error('[Telegram] Dedicated start failed:', sanitizeTelegramError(err))
    }
  }
  const latest = loadConfig()
  if (isTelegramPublicConfigured(latest)) {
    publicStarting = startPublicEntry()
  }
}

async function startPublicEntry(): Promise<boolean> {
  const latest = loadConfig()
  const identity = dedicated || latest.telegram.botToken
    ? await resolveDedicatedIdentity({
        token: latest.telegram.botToken,
        getMe: async () => {
          if (!dedicated) throw new Error('dedicated module unavailable')
          if (dedicated.bot.isInited()) return dedicated.bot.botInfo
          return dedicated.bot.api.getMe()
        },
      })
    : { status: 'absent' as const }

  if (identity.status === 'blocked') {
    console.error('[Telegram public] Dedicated identity could not be verified; public not started')
    return false
  }

  try {
    return await startPublicTelegramAdapter({
      dedicatedBotId: identity.status === 'known' ? identity.botId : undefined,
    })
  } catch (err) {
    console.error('[Telegram public] start failed:', sanitizeTelegramError(err))
    return false
  }
}

function bindProcessShutdown(): void {
  if (shutdownBound) return
  shutdownBound = true
  const shutdown = (): void => {
    console.log('[Telegram] Shutting down...')
    void stopTelegramAdapter().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (import.meta.main || process.argv.includes('--telegram')) startTelegramAdapter()
