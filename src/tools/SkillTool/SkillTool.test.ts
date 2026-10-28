import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { ToolUseContext } from 'src/Tool.js'
import type { AssistantMessage, Message } from 'src/types/message.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserInterruptionMessage,
} from 'src/utils/messages.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key'

const realCommands = await import('../../commands.js')

const forkedSkill = {
  type: 'prompt' as const,
  name: 'fork-skill',
  description: 'fake forked skill',
  progressMessage: 'running',
  contentLength: 0,
  source: 'builtin' as const,
  context: 'fork' as const,
  getPromptForCommand: async () => [
    { type: 'text' as const, text: 'do the work' },
  ],
}

let agentMessages: Message[] = []

const runAgentMock = mock(() =>
  (async function* () {
    for (const message of agentMessages) yield message
  })(),
)

mock.module('../../commands.js', () => ({
  ...realCommands,
  builtInCommandNames: () => new Set<string>(),
  findCommand: (name: string, commands: readonly { name?: string }[]) =>
    commands.find(command => command.name === name),
  getCommands: async () => [forkedSkill],
}))

mock.module('../AgentTool/runAgent.js', () => ({ runAgent: runAgentMock }))

const { SkillTool } = await import('./SkillTool.js')

const generalPurposeAgent: AgentDefinition = {
  agentType: 'general-purpose',
  whenToUse: 'Use for anything',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => 'general purpose prompt',
}

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      mcp: { commands: [] },
      toolPermissionContext: { alwaysAllowRules: { command: [] } },
    }),
    options: {
      tools: [],
      agentDefinitions: { activeAgents: [generalPurposeAgent] },
    },
  } as unknown as ToolUseContext
}

const parentMessage = createAssistantMessage({
  content: [
    {
      type: 'tool_use',
      id: 'toolu_parent',
      name: 'Skill',
      input: { skill: forkedSkill.name },
    },
  ],
}) as AssistantMessage

const canUseTool = (async () => ({
  behavior: 'allow',
  updatedInput: {},
})) as unknown as CanUseToolFn

function inResponse(responseId: string, message: Message): Message {
  if (message.type === 'assistant') {
    message.message.id = responseId
  }
  return message
}

function textAssistant(responseId: string, text: string): Message {
  return inResponse(
    responseId,
    createAssistantMessage({ content: text }) as unknown as Message,
  )
}

function emptyAssistant(responseId: string): Message {
  return inResponse(
    responseId,
    createAssistantMessage({ content: [] }) as unknown as Message,
  )
}

function apiErrorAssistant(responseId: string, text: string): Message {
  return inResponse(
    responseId,
    createAssistantAPIErrorMessage({ content: text }) as unknown as Message,
  )
}

async function runForkedSkill() {
  return SkillTool.call(
    { skill: forkedSkill.name },
    makeContext(),
    canUseTool,
    parentMessage,
  )
}

describe('SkillTool forked execution outcome', () => {
  beforeEach(() => {
    runAgentMock.mockClear()
    agentMessages = []
  })

  test('keeps the plain success result for an ok run', async () => {
    agentMessages = [textAssistant('msg_ok', 'Skill finished')]

    const result = await runForkedSkill()
    const block = SkillTool.mapToolResultToToolResultBlockParam(
      result.data,
      'toolu_1',
    )

    expect(result.data).toMatchObject({
      success: true,
      status: 'forked',
      result: 'Skill finished',
      resultStatus: 'ok',
    })
    expect(block.is_error).toBeFalsy()
    expect(String(block.content)).toContain('completed (forked execution)')
  })

  test('marks an API error as a failed skill instead of success', async () => {
    agentMessages = [apiErrorAssistant('msg_api_error', 'API Error: 500')]

    const result = await runForkedSkill()
    const block = SkillTool.mapToolResultToToolResultBlockParam(
      result.data,
      'toolu_1',
    )

    expect(result.data).toMatchObject({
      success: false,
      status: 'forked',
      result: 'API Error: 500',
      resultStatus: 'api_error',
    })
    expect(block.is_error).toBe(true)
    expect(String(block.content)).toContain(
      'did not complete (forked execution): api_error',
    )
    expect(String(block.content)).toContain('API Error: 500')
  })

  test('marks a cancelled forked run as failed', async () => {
    agentMessages = [
      textAssistant('msg_partial', 'Partial output'),
      createUserInterruptionMessage({ toolUse: false }) as unknown as Message,
    ]

    const result = await runForkedSkill()
    const block = SkillTool.mapToolResultToToolResultBlockParam(
      result.data,
      'toolu_1',
    )

    expect(result.data).toMatchObject({
      success: false,
      resultStatus: 'cancelled',
    })
    expect(block.is_error).toBe(true)
    expect(String(block.content)).toContain('cancelled')
  })

  test('marks a response with no text as failed', async () => {
    agentMessages = [emptyAssistant('msg_empty')]

    const result = await runForkedSkill()
    const block = SkillTool.mapToolResultToToolResultBlockParam(
      result.data,
      'toolu_1',
    )

    expect(result.data).toMatchObject({
      success: false,
      result: '',
      resultStatus: 'empty',
    })
    expect(block.is_error).toBe(true)
    expect(String(block.content)).toContain('empty')
  })
})