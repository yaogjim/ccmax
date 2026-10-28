import { describe, expect, test } from 'bun:test'
import type { PromptCommand } from '../commands.js'
import type { Message } from '../types/message.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  extractResultText,
  extractResultTextOutcome,
  prepareForkedCommandContext,
} from './forkedAgent.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from './messages.js'

const makeAgent = (agentType: string): AgentDefinition => ({
  agentType,
  whenToUse: `Use ${agentType}`,
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => `${agentType} prompt`,
})

function makeContext(activeAgents: AgentDefinition[]): ToolUseContext {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysAllowRules: { command: [] },
      },
    }),
    options: {
      agentDefinitions: { activeAgents },
    },
  } as unknown as ToolUseContext
}

describe('prepareForkedCommandContext', () => {
  const command: PromptCommand = {
    type: 'prompt',
    progressMessage: 'running',
    contentLength: 0,
    source: 'builtin',
    getPromptForCommand: async (args) => [{ type: 'text', text: args }],
  }

  test('uses explicit agent and prompt overrides for dynamic forked commands', async () => {
    const prepared = await prepareForkedCommandContext(
      command,
      'debugger fix tests',
      makeContext([makeAgent('general-purpose'), makeAgent('debugger')]),
      {
        agentType: 'debugger',
        promptArgs: 'fix tests',
        requireAgentType: true,
      },
    )

    expect(prepared.baseAgent.agentType).toBe('debugger')
    expect(prepared.skillContent).toBe('fix tests')
  })

  test('throws when a required explicit agent is unavailable', async () => {
    await expect(
      prepareForkedCommandContext(
        command,
        'debugger fix tests',
        makeContext([makeAgent('general-purpose')]),
        {
          agentType: 'debugger',
          promptArgs: 'fix tests',
          requireAgentType: true,
        },
      ),
    ).rejects.toThrow('Agent not available: debugger')
  })
})

function inResponse(responseId: string, message: Message): Message {
  if (message.type === 'assistant') {
    message.message.id = responseId
  }
  return message
}

function emptyAssistant(responseId: string): Message {
  return inResponse(
    responseId,
    createAssistantMessage({ content: [] }) as Message,
  )
}

function textAssistant(responseId: string, text: string): Message {
  return inResponse(
    responseId,
    createAssistantMessage({ content: text }) as Message,
  )
}

function toolUseAssistant(
  responseId: string,
  toolUseId: string,
): Message {
  return inResponse(
    responseId,
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command: 'ls' },
        },
      ],
    }) as Message,
  )
}

function toolResult(toolUseId: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'ok',
        is_error: false,
      },
    ],
  }) as Message
}

describe('extractResultText', () => {
  test('returns the final assistant text', () => {
    expect(
      extractResultText([textAssistant('msg_1', 'All done')], 'Command completed'),
    ).toBe('All done')
  })

  test('recovers text from an earlier segment of the same response', () => {
    const messages = [
      textAssistant('msg_1', 'All done'),
      emptyAssistant('msg_1'),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('All done')
  })

  test('recovers text from a completed tool turn in the same response', () => {
    const messages = [
      textAssistant('msg_1', 'Checked the files'),
      toolUseAssistant('msg_1', 'toolu_1'),
      toolResult('toolu_1'),
      emptyAssistant('msg_1'),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe(
      'Checked the files',
    )
  })

  test('does not cross into an earlier response when the final response is empty', () => {
    const messages = [
      textAssistant('msg_1', 'Old success'),
      emptyAssistant('msg_2'),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('')
  })

  test('does not group responses when the response id is missing', () => {
    const messages = [
      textAssistant('', 'Old success'),
      emptyAssistant(''),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('')
  })

  test('does not return an earlier success when the final response is an API error', () => {
    const error = inResponse(
      'msg_2',
      createAssistantAPIErrorMessage({ content: 'API Error: 500' }) as Message,
    )

    expect(
      extractResultText(
        [textAssistant('msg_1', 'Old success'), error],
        'Command completed',
      ),
    ).toBe('API Error: 500')
  })

  test('does not fall back to an earlier success for an empty API error tail', () => {
    const error = inResponse(
      'msg_2',
      createAssistantAPIErrorMessage({ content: 'placeholder' }) as Message,
    )
    if (error.type === 'assistant') {
      error.message.content = []
    }

    expect(
      extractResultText(
        [textAssistant('msg_1', 'Old success'), error],
        'Command completed',
      ),
    ).toBe('')
  })

  test('does not present an interrupted turn as a completed result', () => {
    const messages = [
      textAssistant('msg_1', 'Partial answer'),
      createUserInterruptionMessage({}) as Message,
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('')
  })

  test('does not cross an unfinished tool use into an earlier success', () => {
    const messages = [
      textAssistant('msg_1', 'Old success'),
      toolUseAssistant('msg_2', 'toolu_unfinished'),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('')
  })

  test('does not present preamble text as the result of an unfinished tool turn', () => {
    const messages = [
      textAssistant('msg_1', 'Preamble'),
      toolUseAssistant('msg_1', 'toolu_unfinished'),
    ]

    expect(extractResultText(messages, 'Command completed')).toBe('')
  })

  test('does not use the success default when no assistant text exists', () => {
    expect(
      extractResultText([emptyAssistant('msg_1')], 'Execution completed'),
    ).toBe('')
    expect(extractResultText([], 'Execution completed')).toBe('')
  })
})

describe('extractResultTextOutcome', () => {
  test('reports why the final response could not yield text', () => {
    expect(
      extractResultTextOutcome([textAssistant('msg_1', 'All done')]),
    ).toEqual({ text: 'All done', status: 'ok' })
    expect(extractResultTextOutcome([emptyAssistant('msg_1')])).toEqual({
      text: '',
      status: 'empty',
    })
    expect(extractResultTextOutcome([])).toEqual({
      text: '',
      status: 'no_assistant',
    })
    expect(
      extractResultTextOutcome([
        textAssistant('msg_1', 'Partial answer'),
        createUserInterruptionMessage({}) as Message,
      ]),
    ).toEqual({ text: '', status: 'cancelled' })
    expect(
      extractResultTextOutcome([
        textAssistant('msg_1', 'Old success'),
        inResponse(
          'msg_2',
          createAssistantAPIErrorMessage({ content: 'API Error: 500' }) as Message,
        ),
      ]),
    ).toEqual({ text: 'API Error: 500', status: 'api_error' })
    expect(
      extractResultTextOutcome([
        textAssistant('msg_1', 'Old success'),
        toolUseAssistant('msg_2', 'toolu_unfinished'),
      ]),
    ).toEqual({ text: '', status: 'incomplete_tool_use' })
  })
})
