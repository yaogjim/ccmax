/**
 * Scheduled (cron) task run timeout — the seconds↔milliseconds bridge the task
 * editor and the task API share.
 *
 * Server contract: a task may carry `timeoutMs`, a positive integer number of
 * milliseconds in `1..2147483647`. Sending `null` on update clears the explicit
 * value, so the process environment variable `CC_HAHA_TASK_TIMEOUT_MS`, then the
 * built-in 600s default, takes over. Precedence is task value > environment >
 * default, and the resolution itself is the server's job — this module only
 * validates and converts what the editor collects.
 */

export const CRON_TASK_TIMEOUT_DEFAULT_MS = 600_000
export const CRON_TASK_TIMEOUT_MIN_MS = 1
export const CRON_TASK_TIMEOUT_MAX_MS = 2_147_483_647
export const CRON_TASK_TIMEOUT_ENV_VAR = 'CC_HAHA_TASK_TIMEOUT_MS'

/** The built-in default in the unit the editor shows its hint in. */
export const CRON_TASK_TIMEOUT_DEFAULT_SECONDS = CRON_TASK_TIMEOUT_DEFAULT_MS / 1000
/** Largest accepted seconds value, i.e. the millisecond ceiling. */
export const CRON_TASK_TIMEOUT_MAX_SECONDS = CRON_TASK_TIMEOUT_MAX_MS / 1000

/** True when a millisecond value is a positive integer inside the contract. */
export function isValidCronTaskTimeoutMs(ms: number): boolean {
  return Number.isInteger(ms) && ms >= CRON_TASK_TIMEOUT_MIN_MS && ms <= CRON_TASK_TIMEOUT_MAX_MS
}

export type ParsedCronTaskTimeoutSeconds =
  | { kind: 'empty' }
  | { kind: 'valid'; ms: number }
  | { kind: 'invalid' }

/**
 * A plain decimal number: digits with an optional fractional part. Rejects the
 * alternative numeric literals `Number()` would otherwise accept — hex `0x1F`,
 * binary `0b101`, octal `0o17`, and exponent `1e3` — because the field is a
 * decimal count of seconds, and reading `0x1F` as 31 s would store a value the
 * user never typed.
 */
const DECIMAL_SECONDS_PATTERN = /^\d*\.?\d+$/

/**
 * Parse the editor's free-text seconds value into the integer milliseconds the
 * server stores.
 *
 * `empty` means the user left it blank: no explicit task value, so the
 * environment variable and then the built-in default apply. `invalid` covers
 * zero, negatives, non-decimal forms, non-numbers, values past the millisecond
 * ceiling, and sub-millisecond precision (0.0005s is not representable as whole
 * milliseconds), all of which must block the save rather than be rounded into a
 * value the user did not type.
 */
export function parseCronTaskTimeoutSeconds(input: string): ParsedCronTaskTimeoutSeconds {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (!DECIMAL_SECONDS_PATTERN.test(trimmed)) return { kind: 'invalid' }

  const seconds = Number(trimmed)
  if (!Number.isFinite(seconds) || seconds <= 0) return { kind: 'invalid' }

  const exactMs = seconds * 1000
  const ms = Math.round(exactMs)
  if (!isValidCronTaskTimeoutMs(ms)) return { kind: 'invalid' }
  // Reject a value whose rounding moved it: only whole-millisecond inputs are
  // accepted, so `Math.round` here is exact, never a silent adjustment.
  if (Math.abs(ms - exactMs) > 1e-6) return { kind: 'invalid' }

  return { kind: 'valid', ms }
}

/** Render a stored millisecond value back into the seconds input. */
export function formatCronTaskTimeoutSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  return String(ms / 1000)
}