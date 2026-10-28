import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

// Real request path: streamCompactSummary -> runForkedAgent/query -> withRetry ->
// SDK -> loopback "provider". The server counts actual HTTP requests, so these
// tests prove the shared budget caps requests on the wire (fork retry, streaming
// fallback, mid-stream re-send), not just calls into a fake executor.
//
// Runs in a child process because the fork needs a sandboxed HOME/config and an
// ANTHROPIC_BASE_URL fixed before claude.ts builds its client.

if (!process.env.COMPACT_BUDGET_LOOPBACK_FIXTURE) {
  test('compact budget against a loopback provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compact-budget-loopback-'))
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          'test',
          fileURLToPath(import.meta.url),
        ],
        {
          cwd: root,
          env: createSandboxedTestEnvironment(root, {
            COMPACT_BUDGET_LOOPBACK_FIXTURE: '1',
            NODE_ENV: 'production',
            ANTHROPIC_API_KEY: 'offline-fixture-key',
            CLAUDE_CODE_SIMPLE: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
            CLAUDE_CODE_MAX_RETRIES: '1',
            CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '1',
          }),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const timeout = setTimeout(() => child.kill(), 60_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stdout + stderr).toBe(0)
      } finally {
        clearTimeout(timeout)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
} else {
  type ResponseFactory = () => Response
  type RequestBody = { max_tokens?: number; stream?: boolean }

  let server: ReturnType<typeof Bun.serve>
  let requests: RequestBody[] = []
  let responses: ResponseFactory[] = []
  let requestReceived: () => void = () => {}
  let firstRequest = new Promise<void>(resolve => {
    requestReceived = resolve
  })

  const encoder = new TextEncoder()

  function sse(events: Array<Record<string, unknown>>): string {
    return events
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('')
  }

  function textStream(text: string): Response {
    return new Response(
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_compact',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 4 },
        },
        { type: 'message_stop' },
      ]),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  /** A 200 SSE body cut off before message_stop: a mid-stream transport failure. */
  function truncatedStream(text: string): Response {
    return new Response(
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_compact_cut',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ]),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  /** Ends the turn without any text block, forcing compact's streaming fallback. */
  function emptyStream(): Response {
    return new Response(
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_compact_empty',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        },
        { type: 'message_stop' },
      ]),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  /** Keeps the body open so only an abort can end the request. */
  function hangingStream(): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sse([
            {
              type: 'message_start',
              message: {
                id: 'msg_compact_hang',
                type: 'message',
                role: 'assistant',
                model: 'fixture-model',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 9, output_tokens: 0 },
              },
            },
          ])))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  function retryableFailure(): Response {
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: 'upstream blip' } },
      { status: 500 },
    )
  }

  /** An Anthropic-shaped non-streaming reply for the fallback request. */
  function jsonMessage(text: string): Response {
    return Response.json({
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 4 },
    })
  }

  function queue(factories: ResponseFactory[]): void {
    responses = [...factories]
    requests = []
    firstRequest = new Promise<void>(resolve => {
      requestReceived = resolve
    })
  }

  let streamCompactSummary: typeof import('./compact.js').streamCompactSummary
  let compactConversation: typeof import('./compact.js').compactConversation
  let partialCompactConversation: typeof import('./compact.js').partialCompactConversation
  let createRequestBudget: typeof import('../api/requestBudget.js').createRequestBudget
  let isRequestBudgetExhausted: typeof import('../api/requestBudget.js').isRequestBudgetExhausted
  let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
  let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
  let getDefaultAppState: typeof import('../../state/AppStateStore.js').getDefaultAppState
  let createFileStateCacheWithSizeLimit: typeof import('../../utils/fileStateCache.js').createFileStateCacheWithSizeLimit

  test('setup', async () => {
    // @ts-expect-error test global
    globalThis.MACRO = { BUILD_TIME: '' }
    const bootstrap = await import('../../bootstrap/state.js')
    bootstrap.setCwdState(process.env.HOME!)
    bootstrap.setOriginalCwd(process.env.HOME!)
    bootstrap.setProjectRoot(process.env.HOME!)
    const { enableConfigs } = await import('../../utils/config.js')
    enableConfigs()
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as RequestBody)
        const next = responses.shift()
        requestReceived()
        return next ? next() : new Response('unexpected request', { status: 500 })
      },
    })
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    ;({ streamCompactSummary } = await import('./compact.js'))
    ;({ compactConversation, partialCompactConversation } = await import(
      './compact.js'
    ))
    ;({ createRequestBudget, isRequestBudgetExhausted } = await import(
      '../api/requestBudget.js'
    ))
    ;({ createUserMessage } = await import('../../utils/messages.js'))
    ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
    ;({ getDefaultAppState } = await import('../../state/AppStateStore.js'))
    ;({ createFileStateCacheWithSizeLimit } = await import(
      '../../utils/fileStateCache.js'
    ))
  })

  test('a fork summary spends one request from the budget', async () => {
    queue([() => textStream('forked summary')])
    const budget = createRequestBudget(1)
    const result = await runCompact(budget)

    expect(requests).toHaveLength(1)
    expect(budget.remaining).toBe(0)
    expect(summaryText(result)).toBe('forked summary')
  }, 20_000)

  test('a fork retry is refused by the budget and never falls back', async () => {
    // The 500 would normally be retried. With a one-attempt budget the retry is
    // refused before dispatch, so the provider sees exactly one request and the
    // refusal must surface as an error instead of a synthetic API message that
    // compact would treat as a fallback trigger.
    queue([retryableFailure])
    const budget = createRequestBudget(1)
    const error = await rejectionOf(runCompact(budget))

    expect(requests).toHaveLength(1)
    expect(budget.remaining).toBe(0)
    expect(isRequestBudgetExhausted(error)).toBe(true)
  }, 20_000)

  test('a text-less fork falls back and charges the same budget', async () => {
    queue([emptyStream, () => textStream('streamed summary')])
    const budget = createRequestBudget(2)
    const result = await runCompact(budget)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.stream).toBe(true)
    expect(requests[1]?.stream).toBe(true)
    expect(budget.remaining).toBe(0)
    expect(summaryText(result)).toBe('streamed summary')
  }, 20_000)

  test('a mid-stream re-send is replayed once and charged', async () => {
    queue([
      emptyStream,
      () => truncatedStream('partial-attempt'),
      () => textStream('recovered summary'),
    ])
    const budget = createRequestBudget(3)
    const result = await runCompact(budget)

    expect(requests).toHaveLength(3)
    expect(budget.remaining).toBe(0)
    expect(summaryText(result)).toBe('recovered summary')
  }, 20_000)

  test('the budget refuses a mid-stream re-send', async () => {
    queue([
      emptyStream,
      () => truncatedStream('partial-attempt'),
      () => textStream('never sent'),
    ])
    const budget = createRequestBudget(2)
    const error = await rejectionOf(runCompact(budget))

    expect(requests).toHaveLength(2)
    expect(budget.remaining).toBe(0)
    expect(isRequestBudgetExhausted(error)).toBe(true)
  }, 20_000)

  test('the non-streaming fallback spends the same budget', async () => {
    // The streaming endpoint answers 404, so queryModel switches to a
    // non-streaming request. That request must charge the shared budget too.
    queue([
      emptyStream,
      () => new Response('not found', { status: 404 }),
      () => jsonMessage('fallback summary'),
    ])
    const budget = createRequestBudget(3)
    const result = await runCompact(budget)

    expect(requests.map(request => request.stream ?? false)).toEqual([
      true,
      true,
      false,
    ])
    expect(budget.remaining).toBe(0)
    expect(summaryText(result)).toBe('fallback summary')
  }, 20_000)

  test('an abort mid-fork stops before the fallback and returns no result', async () => {
    queue([hangingStream])
    const budget = createRequestBudget(3)
    const controller = new AbortController()
    const pending = runCompact(budget, { controller })
    const settled = pending.then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    )

    await firstRequest
    controller.abort()
    const outcome = await settled

    expect('result' in outcome).toBe(false)
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(
      APIUserAbortError,
    )
    expect(requests).toHaveLength(1)
    expect(budget.remaining).toBe(2)
  }, 20_000)

  test('the critical-window cap reaches the wire as max_tokens', async () => {
    // 20K window with a 5_000-token usage anchor: 20_000 - 5_001 - 4_000.
    process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = JSON.stringify({
      'fixture-model': 20_000,
    })
    try {
      queue([() => textStream('capped summary')])
      const budget = createRequestBudget(1)
      const anchor = {
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-0000000000aa',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_usage_anchor',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          content: [{ type: 'text', text: 'anchor' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 5_000,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }
      const result = await runCompact(budget, { messages: [anchor] })
      const { tokenCountWithEstimation } = await import(
        '../../utils/tokens.js'
      )
      const expectedMaxTokens =
        20_000 -
        tokenCountWithEstimation([
          anchor,
          createUserMessage({ content: 'summarize this' }),
        ] as never) -
        4_000

      expect(requests).toHaveLength(1)
      expect(requests[0]?.max_tokens).toBe(expectedMaxTokens)
      expect(requests[0]?.max_tokens).toBeGreaterThan(10_000)
      expect(requests[0]?.max_tokens).toBeLessThan(11_000)
      expect(summaryText(result)).toBe('capped summary')
    } finally {
      delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    }
  }, 20_000)

  // The outer truncate-and-retry loops (full and partial compaction) reuse one
  // budget across every PTL round. A round that needs a fork plus a streaming
  // fallback spends two requests, so an unbudgeted loop would reach the provider
  // long past the limit.
  const PTL_TEXT = 'Prompt is too long'

  const assistantTextMessage = (text: string) => ({
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  })

  /** Enough rounds that PTL truncation always keeps a group to summarize. */
  function conversationWithRounds(rounds: number): unknown[] {
    const messages: unknown[] = []
    for (let index = 0; index < rounds; index++) {
      messages.push(createUserMessage({ content: `question ${index}` }))
      messages.push(assistantTextMessage(`answer ${index}`))
    }
    messages.push(createUserMessage({ content: 'current question' }))
    return messages
  }

  async function runOuterCompact(
    entry: 'full' | 'partial',
    messages: unknown[],
    {
      controller = new AbortController(),
    }: { controller?: AbortController } = {},
  ) {
    const state = getDefaultAppState()
    const context = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'fixture-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: controller,
      readFileState: createFileStateCacheWithSizeLimit(100),
      loadedNestedMemoryPaths: new Set(),
      getAppState: () => state,
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      setSDKStatus: () => {},
      setStreamMode: () => {},
      onCompactProgress: () => {},
      addNotification: () => {},
      messages: [],
    } as unknown as import('../../Tool.js').ToolUseContext
    const cacheSafeParams = {
      systemPrompt: asSystemPrompt(['cached system prefix']),
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: messages as never,
    }
    return entry === 'full'
      ? compactConversation(messages as never, context, cacheSafeParams, false)
      : partialCompactConversation(
          messages as never,
          2,
          context,
          cacheSafeParams,
        )
  }

  /** Fork sees no text, so each PTL round costs one fork and one fallback. */
  function ptlRounds(count: number): ResponseFactory[] {
    return Array.from({ length: count }, (_, index) =>
      index % 2 === 0 ? emptyStream : () => textStream(PTL_TEXT),
    )
  }

  for (const entry of ['full', 'partial'] as const) {
    test(`the ${entry} compact PTL loop never sends a seventh request`, async () => {
      queue(ptlRounds(10))
      const error = await rejectionOf(
        runOuterCompact(entry, conversationWithRounds(8)),
      )

      // Three PTL rounds spend the six-attempt budget; the fourth round is
      // refused before it reaches the provider, so no request can slip past it
      // and no boundary can land.
      expect(requests).toHaveLength(6)
      expect(isRequestBudgetExhausted(error)).toBe(true)
    }, 30_000)
  }

  test('a cancel after a PTL response issues no further request', async () => {
    const controller = new AbortController()
    queue([
      emptyStream,
      () => {
        // Cancel before the PTL body reaches the client: the loop must not
        // start another round just because this attempt produced a rejection.
        controller.abort()
        return textStream(PTL_TEXT)
      },
      () => textStream('never sent'),
    ])
    const error = await rejectionOf(
      runOuterCompact('full', conversationWithRounds(8), { controller }),
    )

    expect(requests).toHaveLength(2)
    expect(isRequestBudgetExhausted(error)).toBe(false)
    expect(error).toBeInstanceOf(APIUserAbortError)
  }, 30_000)

  // Helpers -----------------------------------------------------------------

  async function runCompact(
    budget: import('../api/requestBudget.js').RequestBudget,
    {
      controller = new AbortController(),
      messages = [createUserMessage({ content: 'current context' })],
    }: { controller?: AbortController; messages?: unknown[] } = {},
  ) {
    const state = getDefaultAppState()
    const context = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'fixture-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: controller,
      readFileState: createFileStateCacheWithSizeLimit(100),
      getAppState: () => state,
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    } as unknown as import('../../Tool.js').ToolUseContext
    return streamCompactSummary({
      messages: messages as never,
      summaryRequest: createUserMessage({ content: 'summarize this' }),
      appState: state as never,
      context,
      preCompactTokenCount: 0,
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(['cached system prefix']),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: messages as never,
      },
      requestBudget: budget,
    })
  }

  async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
    try {
      await pending
    } catch (error) {
      return error
    }
    throw new Error('expected the compact to reject')
  }

  function summaryText(message: {
    message?: { content?: Array<{ type: string; text?: string }> }
  }): string | undefined {
    return message.message?.content?.find(block => block.type === 'text')?.text
  }
}