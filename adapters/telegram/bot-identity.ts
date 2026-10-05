/**
 * Telegram bot identity helpers that never log or persist the token.
 *
 * BotFather tokens are `{botId}:{secret}`. The numeric prefix is enough to
 * fail-closed when dedicated getMe is unavailable, without treating a missing
 * dedicated id as "no dedicated bot".
 */

export function telegramBotIdFromToken(token: string): number | undefined {
  const match = /^(\d+):/.exec(token.trim())
  if (!match) return undefined
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export type DedicatedIdentity =
  | { status: 'absent' }
  | { status: 'known'; botId: number }
  | { status: 'blocked' }

export async function resolveDedicatedIdentity(input: {
  token: string
  getMe: () => Promise<{ id: number }>
}): Promise<DedicatedIdentity> {
  if (!input.token) return { status: 'absent' }
  const fromToken = telegramBotIdFromToken(input.token)
  try {
    const me = await input.getMe()
    if (typeof me.id === 'number' && Number.isSafeInteger(me.id) && me.id > 0) {
      return { status: 'known', botId: me.id }
    }
  } catch {
    // Fall through to the token prefix. A failed getMe must not pretend the
    // dedicated bot is absent — that would let a second copy of the same bot
    // start as the public entry.
  }
  if (fromToken != null) return { status: 'known', botId: fromToken }
  return { status: 'blocked' }
}

export function publicSharesDedicatedIdentity(
  dedicated: DedicatedIdentity,
  publicBotId: number,
): boolean {
  return dedicated.status === 'known' && dedicated.botId === publicBotId
}