import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { RequestBudget } from '../api/requestBudget.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { CompactRequestExecutors } from './compact.js'

/**
 * Feature gates read by compact.ts. A gate that is not listed resolves to the
 * caller's default, which matches an offline run with no GrowthBook payload.
 */
const featureGateOverrides: Record<string, unknown> = {}

// mock.module replaces a module's exports process-wide and outlives this file,
// so both modules mocked below are copied first and then put back in afterAll.
// The coverage gate runs all of src in one process: leaving the fake `query`
// here would hand every later file a canned summary instead of the real agent
// loop, and leaving the fake feature reader would pin every later gate.
// `query.js` is already loaded at this point (query → compact → forkedAgent),
// so this is a replacement, not a first load, and afterAll swaps it back.
const growthbookModule = await import('../analytics/growthbook.js')
const queryModule = await import('../../query.js')
const originalModules: Array<[string, Record<string, unknown>]> = [
  ['../analytics/growthbook.js', { ...growthbookModule }],
  ['../../query.js', { ...queryModule }],
]

// compact.ts reads its gates through growthbook, so stub only that reader:
// the streaming-retry lane stays testable without touching real feature state.
mock.module('../analytics/growthbook.js', () => ({
  ...growthbookModule,
  getFeatureValue_CACHED_MAY_BE_STALE: (
    feature: string,
    defaultValue: unknown,
  ) =>
    feature in featureGateOverrides
      ? featureGateOverrides[feature]
      : defaultValue,
}) as unknown as typeof growthbookModule)

/**
 * The compact pipeline's default fork executor runs the whole agent loop, so
 * replace only `query` and keep every other export real: the production
 * `streamCompactSummary` path then runs end to end without a provider.
 */
let queryCalls = 0
const fakeQuery = (async function* () {
  queryCalls += 1
  yield assistantSummary('forked summary')
}) as unknown as typeof queryModule.query

mock.module('../../query.js', () => ({ ...queryModule, query: fakeQuery }))

const {
  createRequestBudget,
  consumeRequestAttempt,
  isRequestBudgetExhausted,
  RequestBudgetExhaustedError,
} = await import('../api/requestBudget.js')
const { CannotRetryError } = await import('../api/withRetry.js')
const { getMaxOutputTokensForModel } = await import('../api/claude.js')
const { MODEL_CONTEXT_WINDOWS_ENV_KEY } = await import(
  '../../utils/model/modelContextWindows.js'
)
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../api/errors.js')
const { INTERRUPT_MESSAGE, NO_RESPONSE_REQUESTED } = await import(
  '../../utils/messages.js'
)
const { createFileStateCacheWithSizeLimit } = await import(
  '../../utils/fileStateCache.js'
)
const {
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  compactConversation,
  getCompactForkOutputCap,
  partialCompactConversation,
  streamCompactSummary,
} = await import('./compact.js')

const WINDOWS_ENV = MODEL_CONTEXT_WINDOWS_ENV_KEY
const previousWindowsEnv = process.env[WINDOWS_ENV]
const MAX_OUTPUT_ENV = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'
const previousMaxOutputEnv = process.env[MAX_OUTPUT_ENV]

afterAll(async () => {
  // Bun's mock.restore does not undo mock.module export replacements, so each
  // mocked module is restored from the untouched copy taken before mocking.
  for (const [path, original] of originalModules) {
    mock.module(path, () => original)
  }
  mock.restore()
  if (previousWindowsEnv === undefined) {
    delete process.env[WINDOWS_ENV]
  } else {
    process.env[WINDOWS_ENV] = previousWindowsEnv
  }
  if (previousMaxOutputEnv === undefined) {
    delete process.env[MAX_OUTPUT_ENV]
  } else {
    process.env[MAX_OUTPUT_ENV] = previousMaxOutputEnv
  }
  // Prove the restore took effect: a later file in the same process must see
  // the real exports, not this file's stand-ins.
  const restoredQuery = await import('../../query.js')
  const restoredGrowthbook = await import('../analytics/growthbook.js')
  expect(restoredQuery.query).toBe(queryModule.query)
  expect(restoredQuery.query).not.toBe(fakeQuery)
  expect(restoredGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE).toBe(
    growthbookModule.getFeatureValue_CACHED_MAY_BE_STALE,
  )
})

type ForkBehavior =
  | 'summary'
  | 'no-text'
  | 'abort-after'
  | 'budget-refused'
  | 'throw-abort'
  | 'abort-then-throw'
  | 'throw-error'
  | 'trailing-empty'
  | 'trailing-empty-ptl'
  | 'trailing-api-error'
  | 'trailing-unfinished-tool'
  | 'interrupt-tail'
  | 'stale-success'

type StreamBehavior =
  | 'summary'
  | 'no-response'
  | 'lose-terminal-once'
  | 'trailing-empty'
  | 'api-error-only'
  /**
   * The stream's only committed message is a synthetic provider error whose
   * text does NOT start with "API Error" (a 429 silent fallback or the Opus
   * off-switch notice). The old caller-side `startsWithApiErrorPrefix` guard
   * cannot see it, so it must be refused from the structured outcome.
   */
  | 'api-error-no-prefix'
  /** The stream's only committed message is the SDK's own abort notice. */
  | 'aborted-only'
  /** The stream ends on a tool_use block that no tool_result ever answered. */
  | 'unfinished-tool-only'
  /** The stream's only committed message is a prompt-too-long rejection. */
  | 'ptl-only'

let forkCalls = 0
let streamCalls = 0
let forkBehavior: ForkBehavior = 'summary'
let forkBudget: RequestBudget | undefined
let forkMaxOutputTokens: number | undefined
let lastThrownForkError: Error | undefined
let streamAttempted = false
let streamBehavior: StreamBehavior = 'summary'
let streamBudgets: Array<RequestBudget | undefined> = []
let activeController: AbortController | undefined
let abortAfterStream = false
/** Progress event that should cancel the compaction, mimicking a user Esc. */
let abortOnProgress: string | undefined

function assistantSummary(text: string) {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000010',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_test',
      role: 'assistant',
      model: 'compact-cap-large',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

/**
 * Another segment of the same API response (`msg_test`): the stream commits one
 * assistant message per content block, so a response's later block can carry no
 * text at all while earlier blocks hold the real summary.
 */
function assistantTailSameResponse(
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: object }>,
  {
    isApiErrorMessage = false,
    outputTokens = 42,
    uuid = '00000000-0000-0000-0000-000000000013',
    errorDetails,
  }: {
    isApiErrorMessage?: boolean
    outputTokens?: number
    uuid?: string
    /** Raw provider error text; the PTL retry parses token counts from it. */
    errorDetails?: string
  } = {},
) {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    ...(isApiErrorMessage && { isApiErrorMessage: true }),
    ...(errorDetails !== undefined && { errorDetails }),
    message: {
      id: 'msg_test',
      role: 'assistant',
      model: 'compact-cap-large',
      content,
      stop_reason: 'end_turn',
      // Distinguishable usage so a test can prove the tail's metadata survived.
      usage: { input_tokens: 7, output_tokens: outputTokens },
    },
  }
}

/** A provider-reported usage anchor, which the cap needs to trust an estimate. */
function assistantWithUsage(inputTokens: number): Message {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000012',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_usage_anchor',
      role: 'assistant',
      model: 'compact-cap-large',
      content: [{ type: 'text', text: 'anchor' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  } as Message
}

function makeExecutors(): CompactRequestExecutors {
  return {
    runFork: (async (params: {
      requestBudget?: RequestBudget
      maxOutputTokens?: number
    }) => {
      forkCalls += 1
      forkBudget = params.requestBudget
      forkMaxOutputTokens = params.maxOutputTokens
      // A real request is issued here; charge the shared budget once.
      consumeRequestAttempt(forkBudget)
      if (forkBehavior === 'budget-refused') {
        throw new CannotRetryError(
          new RequestBudgetExhaustedError(forkBudget?.limit ?? 0),
          { model: 'compact-cap-large', thinkingConfig: { type: 'disabled' } },
        )
      }
      if (forkBehavior === 'throw-abort') {
        lastThrownForkError = new APIUserAbortError()
        throw lastThrownForkError
      }
      if (forkBehavior === 'abort-then-throw') {
        // The user hit Esc while the fork request was in flight; the provider
        // client surfaces that as a generic transport error, not an abort.
        activeController?.abort()
        lastThrownForkError = new Error('fork request failed after abort')
        throw lastThrownForkError
      }
      if (forkBehavior === 'throw-error') {
        lastThrownForkError = new Error('fork request failed')
        throw lastThrownForkError
      }
      if (forkBehavior === 'abort-after') {
        activeController?.abort()
        return { messages: [assistantSummary('forked summary')], totalUsage: {} }
      }
      if (forkBehavior === 'no-text') {
        return { messages: [], totalUsage: {} }
      }
      if (forkBehavior === 'trailing-empty') {
        // Same response, valid summary first, then a text-less block. The
        // summary must survive; asking again would spend another attempt.
        return {
          messages: [
            assistantSummary('forked summary'),
            assistantTailSameResponse([]),
          ],
          totalUsage: {},
        }
      }
      if (forkBehavior === 'trailing-empty-ptl') {
        // The prompt-too-long text is a real response the outer truncate-and-
        // retry loop owns; an empty tail must not hide it.
        return {
          messages: [
            assistantSummary(`${PROMPT_TOO_LONG_ERROR_MESSAGE}: 220000 tokens`),
            assistantTailSameResponse([]),
          ],
          totalUsage: {},
        }
      }
      if (forkBehavior === 'trailing-api-error') {
        return {
          messages: [
            assistantSummary('forked summary'),
            assistantTailSameResponse(
              [{ type: 'text', text: 'API Error: 500 overloaded' }],
              { isApiErrorMessage: true },
            ),
          ],
          totalUsage: {},
        }
      }
      if (forkBehavior === 'trailing-unfinished-tool') {
        return {
          messages: [
            assistantSummary('forked summary'),
            assistantTailSameResponse([
              { type: 'tool_use', id: 'toolu_never_answered', name: 'Read', input: {} },
            ]),
          ],
          totalUsage: {},
        }
      }
      if (forkBehavior === 'interrupt-tail') {
        // The user interrupted the turn after the summary text: a synthetic
        // interrupt marker follows the last assistant message, so the turn
        // never completed and its text is not a summary.
        return {
          messages: [
            assistantSummary('forked summary'),
            {
              type: 'user',
              uuid: '00000000-0000-0000-0000-000000000014',
              timestamp: new Date().toISOString(),
              message: { role: 'user', content: INTERRUPT_MESSAGE },
            },
          ],
          totalUsage: {},
        }
      }
      if (forkBehavior === 'stale-success') {
        // The final response is empty; the earlier one is a different request
        // whose success text must not be reused as this compaction's summary.
        const earlier = assistantSummary('stale earlier summary')
        return {
          messages: [
            { ...earlier, message: { ...earlier.message, id: 'msg_earlier' } },
            assistantTailSameResponse([]),
          ],
          totalUsage: {},
        }
      }
      return { messages: [assistantSummary('forked summary')], totalUsage: {} }
    }) as unknown as CompactRequestExecutors['runFork'],
    queryStreaming: ((params: { options: { requestBudget?: RequestBudget } }) =>
      (async function* () {
        const attemptIndex = streamCalls
        streamCalls += 1
        streamBudgets.push(params.options.requestBudget)
        // A real request is issued here; charge the shared budget once.
        consumeRequestAttempt(params.options.requestBudget)
        streamAttempted = true
        if (streamBehavior === 'no-response') return
        if (streamBehavior === 'lose-terminal-once' && attemptIndex === 0) {
          // The stream starts producing text but ends without yielding the
          // final assistant message: the terminal state is lost.
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'text' },
            },
          }
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'partial summary' },
            },
          }
          return
        }
        if (streamBehavior === 'trailing-empty') {
          // One response, two committed blocks: the text block then a
          // text-less block that also ends the stream.
          yield assistantSummary('streamed summary')
          yield assistantTailSameResponse([])
          if (abortAfterStream) activeController?.abort()
          return
        }
        if (streamBehavior === 'api-error-only') {
          // The stream's only committed message is a synthetic provider error.
          yield assistantTailSameResponse(
            [{ type: 'text', text: 'API Error: 500 overloaded' }],
            { isApiErrorMessage: true },
          )
          if (abortAfterStream) activeController?.abort()
          return
        }
        if (streamBehavior === 'api-error-no-prefix') {
          // A 429 silent fallback or the Opus off-switch notice: a synthetic
          // error with no "API Error" prefix for the caller's string guard.
          yield assistantTailSameResponse(
            [{ type: 'text', text: NO_RESPONSE_REQUESTED }],
            { isApiErrorMessage: true },
          )
          if (abortAfterStream) activeController?.abort()
          return
        }
        if (streamBehavior === 'aborted-only') {
          // The SDK's own abort text, also without an "API Error" prefix.
          yield assistantTailSameResponse(
            [{ type: 'text', text: 'Request was aborted.' }],
            { isApiErrorMessage: true },
          )
          if (abortAfterStream) activeController?.abort()
          return
        }
        if (streamBehavior === 'unfinished-tool-only') {
          yield assistantTailSameResponse([
            {
              type: 'tool_use',
              id: 'toolu_stream_unanswered',
              name: 'Read',
              input: {},
            },
          ])
          if (abortAfterStream) activeController?.abort()
          return
        }
        if (streamBehavior === 'ptl-only') {
          // A prompt-too-long rejection: the outer truncate-and-retry loop
          // classifies it from the text and parses errorDetails for the gap.
          yield assistantTailSameResponse(
            [{ type: 'text', text: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 220000 tokens` }],
            {
              isApiErrorMessage: true,
              errorDetails: 'prompt is too long: 220000 tokens > 200000 maximum',
            },
          )
          if (abortAfterStream) activeController?.abort()
          return
        }
        yield assistantSummary('streamed summary')
        if (abortAfterStream) activeController?.abort()
      })()) as unknown as CompactRequestExecutors['queryStreaming'],
  }
}

function useWindowMap(windows: Record<string, number>): void {
  process.env[WINDOWS_ENV] = JSON.stringify(windows)
}

beforeEach(() => {
  delete process.env[WINDOWS_ENV]
  delete process.env[MAX_OUTPUT_ENV]
  for (const gate of Object.keys(featureGateOverrides)) {
    delete featureGateOverrides[gate]
  }
  forkCalls = 0
  queryCalls = 0
  streamCalls = 0
  forkBehavior = 'summary'
  forkBudget = undefined
  forkMaxOutputTokens = undefined
  lastThrownForkError = undefined
  streamAttempted = false
  streamBehavior = 'summary'
  streamBudgets = []
  abortAfterStream = false
  abortOnProgress = undefined
  activeController = undefined
})

function makeContext(
  controller: AbortController,
  model: string,
  thinkingConfig: ThinkingConfig = { type: 'disabled' },
): ToolUseContext {
  activeController = controller
  return {
    abortController: controller,
    options: {
      mainLoopModel: model,
      tools: [],
      thinkingConfig,
      agentDefinitions: { activeAgents: [] },
      isNonInteractiveSession: false,
      appendSystemPrompt: undefined,
      querySource: 'compact',
      mcpClients: [],
    },
    getAppState: () => ({
      toolPermissionContext: {},
      effortValue: undefined,
      tasks: {},
    }),
    setResponseLength: () => {},
    setStreamMode: () => {},
    setSDKStatus: () => {},
    onCompactProgress: (event: { hookType?: string }) => {
      if (abortOnProgress && event?.hookType === abortOnProgress) {
        activeController?.abort()
      }
    },
    readFileState: createFileStateCacheWithSizeLimit(100),
    loadedNestedMemoryPaths: new Set(),
    addNotification: () => {},
  } as unknown as ToolUseContext
}

async function runStreamCompact(
  model: string,
  budget: RequestBudget,
  {
    controller = new AbortController(),
    behavior = 'summary' as ForkBehavior,
    abortDuringStream = false,
    messages = [] as Message[],
    stream = 'summary' as StreamBehavior,
    thinkingConfig = { type: 'disabled' } as ThinkingConfig,
  } = {},
) {
  const context = makeContext(controller, model, thinkingConfig)
  forkBehavior = behavior
  abortAfterStream = abortDuringStream
  streamBehavior = stream
  return streamCompactSummary({
    messages,
    summaryRequest: {
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000011',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'summarize' },
    } as never,
    appState: context.getAppState() as never,
    context,
    preCompactTokenCount: 0,
    cacheSafeParams: {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: messages,
    },
    requestBudget: budget,
    executors: makeExecutors(),
  })
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('compact output cap', () => {
  function capFor(
    model: string,
    estimatedInputTokenCount: number,
    measuredInputTokenCount: number,
    thinkingConfig: ThinkingConfig = { type: 'disabled' },
  ) {
    return getCompactForkOutputCap({
      model,
      estimatedInputTokenCount,
      measuredInputTokenCount,
      thinkingConfig,
    })
  }

  test('keeps the cache-key params when the default output fits', () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    expect(capFor('compact-cap-large', 150_000, 150_000)).toEqual({
      kind: 'keep-cache-key',
    })
  })

  test('caps the fork output when the window cannot fit the default output', () => {
    useWindowMap({ 'compact-cap-small': 20_000 })
    const cap = capFor('compact-cap-small', 0, 5_000)
    // 20K window - 4K reserve = 16K available, below the 32K default.
    expect(cap).toEqual({
      kind: 'capped',
      maxOutputTokens: Math.min(
        getMaxOutputTokensForModel('compact-cap-small'),
        16_000,
      ),
    })
    if (cap.kind === 'capped') {
      expect(cap.maxOutputTokens).toBeLessThanOrEqual(20_000)
    }
  })

  test('refuses to call an input that already overflows the window legal', () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    // 197K of input cannot be sent with any max_tokens. Claiming a 1024 cap
    // would be a legal-looking request that the provider must reject anyway.
    expect(capFor('compact-cap-tight', 197_000, 197_000)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
  })

  test('declines to cap when no provider-reported usage anchors the estimate', () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    // Without usage the estimate covers messages only; system prompt and tool
    // schemas are unknown, so a 4K reserve cannot prove the request legal.
    expect(capFor('compact-cap-tight', 19_000, 0)).toEqual({
      kind: 'declined',
      reason: 'unmeasured-input',
    })
  })

  test('never caps below the thinking floor that keeps budget_tokens legal', () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    // available = 20K - 14_976 - 4K = 1024, one token short of the floor.
    expect(capFor('compact-cap-tight', 14_976, 14_976)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
    // 1025 is the smallest cap claude.ts can clamp a budget to 1024.
    expect(capFor('compact-cap-tight', 14_975, 14_975)).toEqual({
      kind: 'capped',
      maxOutputTokens: 1_025,
    })
  })

  test('declines rather than clamp an explicit thinking budget', () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const thinking = { type: 'enabled' as const, budgetTokens: 2_000 }
    // available = 20K - 17_000 - 4K = 1_000, less than budget + 1. A cap here
    // would silently cut the user's explicit thinking budget to 999 tokens.
    expect(capFor('compact-cap-tight', 17_000, 17_000, thinking)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
    // With room for the explicit budget the cap keeps it intact: 2001 leaves
    // claude.ts room to clamp budget_tokens to exactly 2000.
    expect(capFor('compact-cap-tight', 13_999, 13_999, thinking)).toEqual({
      kind: 'capped',
      maxOutputTokens: 2_001,
    })
  })

  test('honours a thinking budget above the 1025 floor instead of clamping it', () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const thinking = { type: 'enabled' as const, budgetTokens: 1_500 }
    // available = 20K - 14_500 - 4K = 1_500, one token short of budget + 1.
    expect(capFor('compact-cap-tight', 14_500, 14_500, thinking)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
    // 1_501 still leaves claude.ts room to keep budget_tokens at exactly 1_500.
    expect(capFor('compact-cap-tight', 14_499, 14_499, thinking)).toEqual({
      kind: 'capped',
      maxOutputTokens: 1_501,
    })
  })

  test('never caps below a user max-output limit that is itself under the floor', () => {
    process.env[MAX_OUTPUT_ENV] = '800'
    useWindowMap({ 'compact-cap-tight': 20_000 })
    // The floor becomes the user's own 800-token limit: a 799 cap would ask
    // for less output than the user configured, so decline instead.
    expect(capFor('compact-cap-tight', 15_201, 15_201)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
    // 900 tokens of room already fits the user's own limit, so no override.
    expect(capFor('compact-cap-tight', 15_100, 15_100)).toEqual({
      kind: 'keep-cache-key',
    })
  })

  test('declines when an over-limit thinking budget cannot fit under the model limit', () => {
    process.env[MAX_OUTPUT_ENV] = '8000'
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const thinking = { type: 'enabled' as const, budgetTokens: 9_000 }
    // budget + 1 = 9_001 exceeds the model's 8_000-token output limit, so the
    // floor stays at 8_000 and the remaining 7_999 tokens are not a legal cap.
    expect(capFor('compact-cap-tight', 16_001, 16_001, thinking)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
  })

  test('never returns a cap below the thinking floor the window would allow', () => {
    process.env[MAX_OUTPUT_ENV] = '32000'
    useWindowMap({ 'compact-cap-thinking': 30_000 })
    const thinking = { type: 'enabled' as const, budgetTokens: 25_000 }
    // available = 30K - 0 - 4K = 26_000, enough for budget + 1, so the room
    // check alone passes. The 20K fork ceiling would still clamp budget_tokens
    // to 19_999, silently cutting the user's explicit 25K budget. Declining
    // leaves that request on the existing non-fork path instead.
    expect(capFor('compact-cap-thinking', 0, 1, thinking)).toEqual({
      kind: 'declined',
      reason: 'no-room',
    })
  })

  test('still caps when the fork ceiling leaves the explicit budget intact', () => {
    process.env[MAX_OUTPUT_ENV] = '32000'
    useWindowMap({ 'compact-cap-thinking': 30_000 })
    const thinking = { type: 'enabled' as const, budgetTokens: 15_000 }
    // 20K of cap leaves claude.ts room to clamp budget_tokens to exactly 15K,
    // so the same tight window still earns the cache-sharing fork.
    expect(capFor('compact-cap-thinking', 0, 1, thinking)).toEqual({
      kind: 'capped',
      maxOutputTokens: 20_000,
    })
  })

  test('respects an explicit user max-output setting', () => {

    process.env[MAX_OUTPUT_ENV] = '8000'
    useWindowMap({ 'compact-cap-tight': 20_000 })
    expect(getMaxOutputTokensForModel('compact-cap-tight')).toBe(8_000)
    // A window that fits the user's own limit keeps the cache key.
    expect(capFor('compact-cap-tight', 8_000, 8_000)).toEqual({
      kind: 'keep-cache-key',
    })
    // A tighter window caps at the room left, never above the user's limit.
    expect(capFor('compact-cap-tight', 10_000, 10_000)).toEqual({
      kind: 'capped',
      maxOutputTokens: 6_000,
    })
  })
})

describe('compact shared request budget', () => {
  test('fork and streaming fallback spend the same budget object', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(2)

    await runStreamCompact('compact-cap-large', budget, { behavior: 'no-text' })

    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
    expect(forkBudget).toBe(budget)
    expect(streamBudgets).toEqual([budget])
    expect(budget.remaining).toBe(0)
  })

  test('an exhausted budget stops the fallback before another request', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(1)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, { behavior: 'no-text' }),
    )

    expect(error).toBeInstanceOf(RequestBudgetExhaustedError)
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(0)
  })

  test('an already-cancelled compact issues no request', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const controller = new AbortController()
    controller.abort()
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, { controller }),
    )

    expect(error).toBeInstanceOf(APIUserAbortError)
    expect(forkCalls).toBe(0)
    expect(streamCalls).toBe(0)
    expect(budget.remaining).toBe(4)
  })

  test('abort after the fork summary never reports a successful compact', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'abort-after',
      }),
    )

    expect(error).toBeInstanceOf(APIUserAbortError)
    expect(streamCalls).toBe(0)
  })

  test('abort after the streaming summary never reports a successful compact', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'no-text',
        abortDuringStream: true,
      }),
    )

    expect(error).toBeInstanceOf(APIUserAbortError)
  })

  test('a roomy window sends no explicit fork output override', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    await runStreamCompact('compact-cap-large', budget, {
      messages: [assistantWithUsage(150_000)],
    })

    expect(forkCalls).toBe(1)
    expect(forkMaxOutputTokens).toBeUndefined()
    expect(streamCalls).toBe(0)
  })

  test('a tight window sends an explicit fork output cap', async () => {
    useWindowMap({ 'compact-cap-small': 20_000 })
    const budget = createRequestBudget(4)

    await runStreamCompact('compact-cap-small', budget, {
      messages: [assistantWithUsage(5_000)],
    })

    expect(forkCalls).toBe(1)
    // 20K window - the 5_001 reported tokens - 4K reserve - the appended
    // "summarize" prompt (2 estimated tokens).
    expect(forkMaxOutputTokens).toBe(10_997)
    expect(streamCalls).toBe(0)
  })

  test('a window that cannot fit any legal fork output goes straight to the PTL-aware path', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-tight', budget, {
      messages: [assistantWithUsage(197_000)],
    })

    expect(forkCalls).toBe(0)
    expect(streamCalls).toBe(1)
    expect(forkMaxOutputTokens).toBeUndefined()
    expect(result).toMatchObject({ message: { content: [{ type: 'text', text: 'streamed summary' }] } })
  })

  test('an estimate without provider usage never claims a legal cap', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    await runStreamCompact('compact-cap-tight', budget)

    expect(forkCalls).toBe(0)
    expect(streamCalls).toBe(1)
  })

  test('a budget refusal from the fork is fatal and never falls back', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(1)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'budget-refused',
      }),
    )

    expect(isRequestBudgetExhausted(error)).toBe(true)
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(0)
  })

  test('a fork APIUserAbortError is rethrown unchanged and never falls back', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'throw-abort',
      }),
    )

    expect(error).toBe(lastThrownForkError)
    expect(error).toBeInstanceOf(APIUserAbortError)
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(3)
  })

  test('a fork failure after the user aborted becomes an APIUserAbortError, not a fallback', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'abort-then-throw',
      }),
    )

    // The transport error is not an abort, but the signal says the user
    // cancelled: report a cancel and never start another request.
    expect(error).toBeInstanceOf(APIUserAbortError)
    expect(error).not.toBe(lastThrownForkError)
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(0)
    expect(budget.remaining).toBe(3)
  })

  test('a generic fork failure falls back to streaming on the same budget', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'throw-error',
    })

    expect(result).toMatchObject({
      message: { content: [{ type: 'text', text: 'streamed summary' }] },
    })
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
    expect(forkBudget).toBe(budget)
    expect(streamBudgets).toEqual([budget])
    expect(budget.remaining).toBe(2)
  })

  test('a stream that loses its terminal state retries on the same budget', async () => {
    featureGateOverrides['tengu_compact_streaming_retry'] = true
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'no-text',
      stream: 'lose-terminal-once',
    })

    expect(result).toMatchObject({
      message: { content: [{ type: 'text', text: 'streamed summary' }] },
    })
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(2)
    expect(streamBudgets).toEqual([budget, budget])
    // One fork attempt plus two streaming attempts, all from one budget.
    expect(budget.remaining).toBe(1)
  })

  test('without the retry gate a lost stream terminal state fails after one attempt', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'no-text',
        stream: 'no-response',
      }),
    )

    expect((error as Error).message).toBe(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
    expect(budget.remaining).toBe(2)
  })

  test('an enabled thinking budget that cannot fit skips the cache-sharing fork', async () => {
    useWindowMap({ 'compact-cap-small': 20_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-small', budget, {
      messages: [assistantWithUsage(5_000)],
      thinkingConfig: { type: 'enabled', budgetTokens: 12_000 },
    })

    // Roughly 10_997 tokens of room cannot hold budget + 1 = 12_001, so any
    // cap would silently cut the user's thinking budget: skip the fork.
    expect(forkCalls).toBe(0)
    expect(streamCalls).toBe(1)
    expect(result).toMatchObject({
      message: { content: [{ type: 'text', text: 'streamed summary' }] },
    })
  })
})

describe('compact final response text', () => {
  // The streaming API commits one assistant message per content block and
  // every block of one response shares `message.id`, so a response's last
  // message can carry no text while an earlier message holds the summary.
  // These cases pin the boundary: only the final response may produce the
  // summary, and it must produce all of its text.
  test('a text-less tail of the same response keeps the fork summary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    // Exactly one attempt: any fallback would find the budget spent, so this
    // also proves the empty tail does not start a second request.
    const budget = createRequestBudget(1)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'trailing-empty',
    })

    expect(result.message.content).toEqual([
      { type: 'text', text: 'forked summary' },
    ])
    // The tail is the response's terminal state, so its metadata and usage
    // stay attached to the accepted summary.
    expect(result.uuid).toBe('00000000-0000-0000-0000-000000000013')
    expect(result.message.usage).toMatchObject({ output_tokens: 42 })
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(0)
  })

  test('a text-less tail of the same response keeps the streamed summary', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(1)

    // 197K of reported input leaves no legal fork output, so streaming is the
    // only request. Its text-less final block must not hide the summary the
    // same response already streamed.
    const result = await runStreamCompact('compact-cap-tight', budget, {
      messages: [assistantWithUsage(197_000)],
      stream: 'trailing-empty',
    })

    expect(result.message.content).toEqual([
      { type: 'text', text: 'streamed summary' },
    ])
    expect(result.uuid).toBe('00000000-0000-0000-0000-000000000013')
    expect(forkCalls).toBe(0)
    expect(streamCalls).toBe(1)
    expect(budget.remaining).toBe(0)
  })

  test('prompt-too-long text of the final response still reaches the outer truncate retry', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'trailing-empty-ptl',
    })

    // The PTL classification and the truncate retry live in the caller, so the
    // PTL text must come back intact instead of being replaced by the empty
    // tail of its own response.
    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 220000 tokens`,
      },
    ])
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(3)
  })

  test('an API error tail is never replaced by the earlier summary text', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'trailing-api-error',
    })

    // The response ends in an API error. Summarising its earlier block would
    // report a success the provider never gave, so the fallback runs instead.
    expect(result.message.content).toEqual([
      { type: 'text', text: 'streamed summary' },
    ])
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
    expect(budget.remaining).toBe(2)
  })

  test('an unfinished tool use tail is never replaced by the earlier summary text', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'trailing-unfinished-tool',
    })

    // A tool_use without its tool_result never completed the turn, so the text
    // before it is not a summary of anything.
    expect(result.message.content).toEqual([
      { type: 'text', text: 'streamed summary' },
    ])
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
  })

  test('an earlier response success is never reused as the final summary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const result = await runStreamCompact('compact-cap-large', budget, {
      behavior: 'stale-success',
    })

    // The final response is empty and belongs to a different request, so its
    // predecessor's success text must not stand in for it.
    expect(result.message.content).toEqual([
      { type: 'text', text: 'streamed summary' },
    ])
    expect(forkCalls).toBe(1)
    expect(streamCalls).toBe(1)
  })

  test('an API error response from the stream surfaces its own text as a failure', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'no-text',
        stream: 'api-error-only',
      }),
    )

    // The provider's own words are preserved, but they are reported as a
    // failure: returning them would let the caller accept the error text as a
    // summary.
    expect((error as Error).message).toBe('API Error: 500 overloaded')
    expect(streamCalls).toBe(1)
    expect(budget.remaining).toBe(2)
  })

  test('a synthetic API error without the API Error prefix is a failure, not a summary', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    // A 429 silent fallback answers NO_RESPONSE_REQUESTED. It is a synthetic
    // error message with no "API Error" prefix, so the caller's string guard
    // would have accepted "No response requested." as the summary.
    const error = await expectRejection(
      runStreamCompact('compact-cap-tight', budget, {
        messages: [assistantWithUsage(197_000)],
        stream: 'api-error-no-prefix',
      }),
    )

    expect((error as Error).message).toBe(NO_RESPONSE_REQUESTED)
    expect(streamCalls).toBe(1)
    expect(budget.remaining).toBe(3)
  })

  test('an aborted stream terminal is a failure, not a summary', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    // The SDK's own abort text carries no "API Error" prefix either.
    const error = await expectRejection(
      runStreamCompact('compact-cap-tight', budget, {
        messages: [assistantWithUsage(197_000)],
        stream: 'aborted-only',
      }),
    )

    expect((error as Error).message).toBe('Request was aborted.')
    expect(streamCalls).toBe(1)
  })

  test('a streamed response that ends on an unfinished tool use is a failure', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    // The streamed path never sees tool_result messages, so a tool_use without
    // an answer means the turn never completed. Returning the terminal message
    // would report its empty content as a successful (empty) summary and spend
    // the caller's fallback handling on it.
    const error = await expectRejection(
      runStreamCompact('compact-cap-tight', budget, {
        messages: [assistantWithUsage(197_000)],
        stream: 'unfinished-tool-only',
      }),
    )

    expect((error as Error).message).toContain('Compaction')
    expect(streamCalls).toBe(1)
  })

  test('prompt-too-long from the stream still reaches the outer truncate retry', async () => {
    useWindowMap({ 'compact-cap-tight': 20_000 })
    const budget = createRequestBudget(4)

    // PTL is the one api_error the caller must still see: it classifies the
    // text and parses errorDetails to size the truncation. Rejecting it here
    // would make the CC-1180 recovery unreachable.
    const result = await runStreamCompact('compact-cap-tight', budget, {
      messages: [assistantWithUsage(197_000)],
      stream: 'ptl-only',
    })

    expect(result.message.content).toEqual([
      { type: 'text', text: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 220000 tokens` },
    ])
    expect(result.isApiErrorMessage).toBe(true)
    // The raw provider text must survive for truncateHeadForPTLRetry's gap.
    expect(result.errorDetails).toBe(
      'prompt is too long: 220000 tokens > 200000 maximum',
    )
    expect(streamCalls).toBe(1)
  })

  test('an interrupted turn is reported as a cancel instead of a summary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const budget = createRequestBudget(4)

    const error = await expectRejection(
      runStreamCompact('compact-cap-large', budget, {
        behavior: 'interrupt-tail',
      }),
    )

    // The interrupt marker follows the last assistant message, so the turn
    // never completed: its text is not a summary and a cancel must not issue
    // another request.
    expect(error).toBeInstanceOf(APIUserAbortError)
    expect(forkCalls).toBe(1)
    expect(streamAttempted).toBe(false)
    expect(budget.remaining).toBe(3)
  })
})

describe('compact boundary protection', () => {
  function conversationMessages(): Message[] {
    return [
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000020',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'first question' },
      },
      {
        ...assistantWithUsage(1_000),
        uuid: '00000000-0000-0000-0000-000000000021',
      },
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000022',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'second question' },
      },
    ] as Message[]
  }

  function cacheSafe(
    messages: Message[],
    context: ToolUseContext,
  ): Parameters<typeof compactConversation>[2] {
    return {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: messages,
    } as unknown as Parameters<typeof compactConversation>[2]
  }

  function summaryText(result: {
    summaryMessages: Array<{ message: { content: unknown } }>
  }): string {
    return String(result.summaryMessages[0]?.message.content)
  }

  test('a completed full compact lands the summary boundary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const messages = conversationMessages()
    const context = makeContext(new AbortController(), 'compact-cap-large')

    const result = await compactConversation(
      messages,
      context,
      cacheSafe(messages, context),
      true,
    )

    // The production pipeline keeps its abort guards on the success path, so a
    // normal compaction proves they do not reject a live context.
    expect(queryCalls).toBe(1)
    expect(result.boundaryMarker).toMatchObject({ subtype: 'compact_boundary' })
    expect(result.summaryMessages).toHaveLength(1)
    expect(summaryText(result)).toContain('forked summary')
  })

  test('a completed partial compact keeps the messages outside the summarised slice', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const messages = conversationMessages()
    const context = makeContext(new AbortController(), 'compact-cap-large')

    const result = await partialCompactConversation(
      messages,
      1,
      context,
      cacheSafe(messages, context),
      undefined,
      'from',
    )

    expect(queryCalls).toBe(1)
    expect(result.boundaryMarker).toMatchObject({ subtype: 'compact_boundary' })
    expect(summaryText(result)).toContain('forked summary')
    // 'from' keeps everything before the pivot (the first user message).
    expect(result.messagesToKeep).toHaveLength(1)
    expect(result.messagesToKeep?.[0]?.uuid).toBe(
      '00000000-0000-0000-0000-000000000020',
    )
  })

  test('a cancel during post-compact hooks refuses to land the boundary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const messages = conversationMessages()
    const context = makeContext(new AbortController(), 'compact-cap-large')
    // The summary already succeeded; the cancel lands while the post-compact
    // session hooks run, before the boundary is written.
    abortOnProgress = 'session_start'

    const error = await expectRejection(
      compactConversation(messages, context, cacheSafe(messages, context), true),
    )

    expect(error).toBeInstanceOf(APIUserAbortError)
  })

  test('a cancel during post-compact hooks refuses to land a partial boundary', async () => {
    useWindowMap({ 'compact-cap-large': 1_000_000 })
    const messages = conversationMessages()
    const context = makeContext(new AbortController(), 'compact-cap-large')
    abortOnProgress = 'session_start'

    const error = await expectRejection(
      partialCompactConversation(
        messages,
        1,
        context,
        cacheSafe(messages, context),
        undefined,
        'from',
      ),
    )

    expect(error).toBeInstanceOf(APIUserAbortError)
  })
})
