import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import {
  createRequestBudget,
  RequestBudgetExhaustedError,
} from './requestBudget.js'
import { CannotRetryError, withRetry } from './withRetry.js'

const MODEL = 'claude-opus-4-7'

function retryableServerError(): APIError {
  return new APIError(
    500,
    { type: 'error', error: { type: 'api_error', message: 'upstream blip' } },
    'upstream blip',
  )
}

/**
 * Drive a withRetry generator to completion and return the terminal error or
 * the successful value. The generator yields retry status messages we ignore.
 */
async function drainRetry(
  generator: AsyncGenerator<unknown, string, void>,
): Promise<{ value?: string; error?: unknown }> {
  for (;;) {
    const next = await generator.next().catch(error => ({ error }) as const)
    if ('error' in next) return { error: next.error }
    if (next.done) return { value: next.value as string }
  }
}

describe('shared request-attempt budget', () => {
  test('consumes one attempt per real request and caps withRetry retries', async () => {
    const budget = createRequestBudget(2)
    let requests = 0

    const result = await drainRetry(
      withRetry<string>(
        async () => ({}) as Anthropic,
        async () => {
          requests += 1
          throw retryableServerError()
        },
        {
          model: MODEL,
          thinkingConfig: { type: 'disabled' },
          maxRetries: 5,
          requestBudget: budget,
        },
      ),
    )

    expect(requests).toBe(2)
    expect(budget.remaining).toBe(0)
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect((result.error as CannotRetryError).originalError).toBeInstanceOf(
      RequestBudgetExhaustedError,
    )
  })

  test('a successful request consumes exactly one attempt', async () => {
    const budget = createRequestBudget(3)
    let requests = 0

    const result = await drainRetry(
      withRetry<string>(
        async () => ({}) as Anthropic,
        async () => {
          requests += 1
          return 'ok'
        },
        {
          model: MODEL,
          thinkingConfig: { type: 'disabled' },
          maxRetries: 2,
          requestBudget: budget,
        },
      ),
    )

    expect(result.value).toBe('ok')
    expect(requests).toBe(1)
    expect(budget.remaining).toBe(2)
  })

  test('does not issue a request once the budget is spent', async () => {
    const budget = createRequestBudget(0)
    let requests = 0

    const result = await drainRetry(
      withRetry<string>(
        async () => ({}) as Anthropic,
        async () => {
          requests += 1
          return 'unreachable'
        },
        {
          model: MODEL,
          thinkingConfig: { type: 'disabled' },
          maxRetries: 1,
          requestBudget: budget,
        },
      ),
    )

    expect(requests).toBe(0)
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect((result.error as CannotRetryError).originalError).toBeInstanceOf(
      RequestBudgetExhaustedError,
    )
  })

  test('omitting the budget leaves ordinary conversation retries unchanged', async () => {
    let requests = 0

    const result = await drainRetry(
      withRetry<string>(
        async () => ({}) as Anthropic,
        async () => {
          requests += 1
          throw retryableServerError()
        },
        {
          model: MODEL,
          thinkingConfig: { type: 'disabled' },
          maxRetries: 2,
        },
      ),
    )

    expect(requests).toBe(3)
    expect(result.error).toBeInstanceOf(CannotRetryError)
  })

  test('an aborted request does not consume or issue', async () => {
    const budget = createRequestBudget(2)
    const controller = new AbortController()
    controller.abort()
    let requests = 0

    const result = await drainRetry(
      withRetry<string>(
        async () => ({}) as Anthropic,
        async () => {
          requests += 1
          return 'unreachable'
        },
        {
          model: MODEL,
          thinkingConfig: { type: 'disabled' },
          maxRetries: 1,
          signal: controller.signal,
          requestBudget: budget,
        },
      ),
    )

    expect(requests).toBe(0)
    expect(budget.remaining).toBe(2)
    expect(result.error).toBeInstanceOf(APIUserAbortError)
  })
})