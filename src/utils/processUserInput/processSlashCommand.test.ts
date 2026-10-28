import { beforeEach, describe, expect, mock, test } from 'bun:test'
import agentCommand from '../../commands/agent.js'
import teamCommand from '../../commands/team.js'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserInterruptionMessage,
} from '../messages.js'

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key'

const defaultAgentMessages = (): Message[] => [
  createAssistantMessage({ content: 'debugger result' }) as unknown as Message,
]

let forkedAgentMessages: Message[] = defaultAgentMessages()

const runAgentMock = mock(() =>
  (async function* () {
    for (const message of forkedAgentMessages) yield message
  })(),
)

mock.module('../../tools/AgentTool/runAgent.js', () => ({
  runAgent: runAgentMock,
}))

const { processSlashCommand } = await import('./processSlashCommand.js')

const makeAgent = (agentType: string): AgentDefinition => ({
  agentType,
  whenToUse: `Use ${agentType}`,
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => `${agentType} prompt`,
})

function makeContext(
  activeAgents: AgentDefinition[],
  commands: Command[] = [agentCommand],
): ToolUseContext {
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      kairosEnabled: false,
      mcp: { clients: [] },
      toolPermissionContext: {
        alwaysAllowRules: { command: [] },
      },
    }),
    setResponseLength: () => {},
    options: {
      commands,
      tools: [],
      agentDefinitions: { activeAgents },
    },
  } as unknown as ToolUseContext
}

function metaPromptText(result: Awaited<ReturnType<typeof processSlashCommand>>): string {
  const metaPrompt = result.messages.find(
    message => message.type === 'user' && message.isMeta,
  )
  return Array.isArray(metaPrompt?.message.content)
    ? metaPrompt.message.content
        .map(block => ('text' in block ? block.text : ''))
        .join('\n')
    : ''
}

describe('/agent slash command processing', () => {
  beforeEach(() => {
    runAgentMock.mockClear()
  })

  test('routes the selected agent through the normal chat loop', async () => {
    const result = await processSlashCommand(
      '/agent debugger fix failing tests',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose'), makeAgent('debugger')]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(runAgentMock.mock.calls.length).toBe(0)

    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('<local-command-stdout>'),
      ),
    ).toBe(false)

    const metaPrompt = result.messages.find(
      message => message.type === 'user' && message.isMeta,
    )
    const metaPromptText = Array.isArray(metaPrompt?.message.content)
      ? metaPrompt.message.content
          .map(block => ('text' in block ? block.text : ''))
          .join('\n')
      : ''
    expect(metaPromptText).toContain('subagent_type "debugger"')
    expect(metaPromptText).toContain('fix failing tests')
  })

  test('shows usage when the agent prompt is missing', async () => {
    const result = await processSlashCommand(
      '/agent debugger',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose'), makeAgent('debugger')]),
      () => {},
    )

    expect(result.shouldQuery).toBe(false)
    expect(runAgentMock.mock.calls.length).toBe(0)
    expect(
      result.messages.some(
        message => message.message.content === 'Usage: /agent <agent> <prompt>',
      ),
    ).toBe(true)
  })

})

describe('/team slash command processing', () => {
  test('queries the model with actionable help for an exact /team invocation', async () => {
    const result = await processSlashCommand(
      '/team',
      [],
      [],
      [],
      makeContext([], [teamCommand]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(metaPromptText(result)).toContain('/team <goal>')
    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('<local-command-stdout>'),
      ),
    ).toBe(false)
  })

  test('carries the exact goal and structured team tools into the normal turn', async () => {
    const result = await processSlashCommand(
      '/team audit authentication and fix the highest-risk issue',
      [],
      [],
      [],
      makeContext([], [teamCommand]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(metaPromptText(result)).toContain('audit authentication and fix the highest-risk issue')
    expect(metaPromptText(result)).toContain('TeamCreate')
    expect(result.allowedTools).toEqual(expect.arrayContaining([
      'TeamCreate',
      'TaskCreate',
      'TaskUpdate',
      'Agent',
      'SendMessage',
    ]))
  })
})

const forkedCommand = {
  type: 'prompt',
  name: 'forked-report',
  description: 'fake forked command',
  progressMessage: 'running',
  contentLength: 0,
  source: 'builtin',
  context: 'fork',
  getPromptForCommand: async () => [{ type: 'text', text: 'build the report' }],
} as unknown as Command

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

function commandOutput(result: Awaited<ReturnType<typeof processSlashCommand>>): string {
  return (
    result.messages
      .filter(message => message.type === 'user')
      .map(message => message.message.content)
      .filter((content): content is string => typeof content === 'string')
      .find(
        content =>
          content.includes('<local-command-stdout>') ||
          content.includes('<local-command-stderr>'),
      ) ?? ''
  )
}

describe('/forked prompt slash command outcome', () => {
  beforeEach(() => {
    runAgentMock.mockClear()
    forkedAgentMessages = defaultAgentMessages()
  })

  test('keeps stdout and the result text for a successful fork', async () => {
    forkedAgentMessages = [textAssistant('msg_ok', 'Command output')]

    const result = await processSlashCommand(
      '/forked-report',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose')], [forkedCommand]),
      () => {},
    )

    expect(result.shouldQuery).toBe(false)
    expect(commandOutput(result)).toContain('<local-command-stdout>')
    expect(commandOutput(result)).toContain('Command output')
    expect(result.resultText).toBe('Command output')
  })

  test('reports an API error on stderr instead of a successful stdout', async () => {
    forkedAgentMessages = [
      inResponse(
        'msg_api_error',
        createAssistantAPIErrorMessage({ content: 'API Error: 500' }) as unknown as Message,
      ),
    ]

    const result = await processSlashCommand(
      '/forked-report',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose')], [forkedCommand]),
      () => {},
    )

    const output = commandOutput(result)
    expect(output).toContain('<local-command-stderr>')
    expect(output).not.toContain('<local-command-stdout>')
    expect(output).toContain('api_error')
    expect(output).toContain('API Error: 500')
    expect(result.resultText).toContain('did not complete (api_error)')
  })

  test('reports a cancelled fork on stderr', async () => {
    forkedAgentMessages = [
      textAssistant('msg_partial', 'Partial output'),
      createUserInterruptionMessage({ toolUse: false }) as unknown as Message,
    ]

    const result = await processSlashCommand(
      '/forked-report',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose')], [forkedCommand]),
      () => {},
    )

    const output = commandOutput(result)
    expect(output).toContain('<local-command-stderr>')
    expect(output).not.toContain('<local-command-stdout>')
    expect(output).toContain('cancelled')
    expect(result.resultText).toContain('cancelled')
  })
})
