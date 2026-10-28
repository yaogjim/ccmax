/**
 * A shared budget for real provider request attempts inside one logical
 * operation (today: one compaction). Every provider dispatch charges it once,
 * including retries hidden inside withRetry, mid-stream retries and fallbacks.
 *
 * Callers that do not pass a budget keep the previous unbounded behavior.
 */
export type RequestBudget = {
  /** Total attempts this logical operation may issue. */
  readonly limit: number
  /** Attempts still available. */
  remaining: number
}

export class RequestBudgetExhaustedError extends Error {
  constructor(public readonly limit: number) {
    super(`Request attempt budget exhausted (limit ${limit})`)
    this.name = 'RequestBudgetExhaustedError'
  }
}

export function createRequestBudget(limit: number): RequestBudget {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(
      `Request budget limit must be a non-negative integer, got ${limit}`,
    )
  }
  return { limit, remaining: limit }
}

/**
 * Charge one real request attempt. Must be called immediately before the
 * provider dispatch so a budget is never spent on a request that is skipped.
 */
export function consumeRequestAttempt(budget: RequestBudget | undefined): void {
  if (!budget) return
  if (budget.remaining <= 0) {
    throw new RequestBudgetExhaustedError(budget.limit)
  }
  budget.remaining -= 1
}

/**
 * True when `error` is, or wraps, a budget refusal. withRetry wraps terminal
 * faults in CannotRetryError, so this follows `originalError` instead of
 * importing that class — withRetry imports this module, which would cycle.
 */
export function isRequestBudgetExhausted(error: unknown): boolean {
  if (error instanceof RequestBudgetExhaustedError) return true
  if (typeof error !== 'object' || error === null) return false
  const original = (error as { originalError?: unknown }).originalError
  return original instanceof RequestBudgetExhaustedError
}