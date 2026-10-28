import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { RequestBudgetExhaustedError, type RequestBudget } from './requestBudget.js'
import type { AssistantMessage } from '../../types/message.js'

// The Azure branch trades with the same shared request budget as every other
// provider dispatch. A refusal there is a budget decision, not a model reply:
// rewriting it as an assistant API-error message makes the caller issue one
// more request against a budget it already spent.
const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let responseStatus = 200
let requests = 0
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

const successBody = JSON.stringify({
  id: 'resp_fixture',
  output_text: 'fixture summary',
  usage: { input_tokens: 5, output_tokens: 2 },
  status: 'completed',
})

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-azure-budget-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(
    process.env,
    createSandboxedTestEnvironment(
      sandbox,
      {
        NODE_ENV: 'production',
        CLAUDE_CODE_USE_AZURE_OPENAI: '1',
        CLAUDE_CODE_SKIP_AZURE_OPENAI_AUTH: '1',
        AZURE_OPENAI_CODEX_DEPLOYMENT: 'fixture-deployment',
        AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
      },
      originalEnvironment,
    ),
  )
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++
      return new Response(
        responseStatus === 200 ? successBody : 'upstream failure',
        {
          status: responseStatus,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })
  process.env.AZURE_OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  responseStatus = 200
  requests = 0
})

async function collect(budget: RequestBudget): Promise<AssistantMessage[]> {
  const model = 'fixture-model'
  const messages: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'fixture' })],
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'compact',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      requestBudget: budget,
    },
  })) {
    if (message.type === 'assistant') messages.push(message)
  }
  return messages
}

test('an exhausted Azure budget is a refusal, never a model response', async () => {
  const budget: RequestBudget = { limit: 1, remaining: 0 }
  await expect(collect(budget)).rejects.toBeInstanceOf(RequestBudgetExhaustedError)
  // A refusal must not dispatch: the budget is checked before the provider call.
  expect(requests).toBe(0)
  expect(budget.remaining).toBe(0)
})

test('a spent Azure budget keeps refusing later dispatches in the same operation', async () => {
  const budget: RequestBudget = { limit: 1, remaining: 1 }
  const messages = await collect(budget)
  expect(messages).toHaveLength(1)
  expect(requests).toBe(1)
  expect(budget.remaining).toBe(0)

  await expect(collect(budget)).rejects.toBeInstanceOf(RequestBudgetExhaustedError)
  expect(requests).toBe(1)
})

test('a non-budget Azure failure still surfaces as an assistant error message', async () => {
  responseStatus = 500
  const budget: RequestBudget = { limit: 3, remaining: 3 }
  const messages = await collect(budget)
  expect(requests).toBe(1)
  // Only the budget refusal changes channel; an upstream fault keeps the
  // existing assistant-error presentation and charges one attempt.
  expect(messages).toHaveLength(1)
  expect(messages[0]?.isApiErrorMessage).toBe(true)
  expect(budget.remaining).toBe(2)
})
