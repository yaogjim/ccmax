/**
 * Strip Telegram bot tokens from log output. grammY and fetch errors often
 * embed the token in the URL (`/bot<token>/getMe`) or the message text.
 */
const TOKEN_IN_PATH = /\/bot[^/\s?#]+/gi
const TOKEN_LITERAL = /\b\d+:[A-Za-z0-9_-]{8,}\b/g

export function sanitizeTelegramError(err: unknown): string {
  const chunks: string[] = []
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const inner = (err as { error: unknown }).error
    if (inner !== err) chunks.push(stringifyUnknown(inner))
  }
  chunks.push(stringifyUnknown(err))
  return redactTelegramSecrets(chunks.filter(Boolean).join(' | '))
}

export function redactTelegramSecrets(text: string): string {
  return text
    .replace(TOKEN_IN_PATH, '/bot[redacted]')
    .replace(TOKEN_LITERAL, '[redacted-token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:access_token|token)=[^&\s#]+/gi, 'token=[redacted]')
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}