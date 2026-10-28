import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import * as sdkEventQueue from '../../utils/sdkEventQueue.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import type { SessionId } from '../../types/ids.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
} from '../../utils/messages.js'
import { AbortError } from '../../utils/errors.js'
import { registerTask } from '../../utils/task/framework.js'
import {
  emitAgentToolActivitiesForMessage,
  extractAgentToolActivities,
  finalizeAgentTool,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'

describe('runAsyncAgentLifecycle', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  test('notifies the parent before post-completion cleanup finishes', async () => {
    const taskId = 'agent-notify-first'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Review code', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      prompt: 'Review code',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'Review complete.' }],
    }) as Message
    let cleanupStarted = false

    async function* makeStream(): AsyncGenerator<Message, void> {
      yield message
    }

    const result = await Promise.race([
      runAsyncAgentLifecycle({
        taskId,
        abortController,
        makeStream,
        metadata: {
          prompt: 'Review code',
          resolvedAgentModel: 'test-model',
          isBuiltInAgent: true,
          startTime: Date.now(),
          agentType: 'general-purpose',
          isAsync: true,
        },
        description: 'Review code',
        parentToolUseId: 'toolu_agent',
        toolUseContext: {
          options: { tools: [] },
          toolUseId: 'toolu_agent',
          getAppState: () => appState,
        } as unknown as ToolUseContext,
        rootSetAppState: setAppState,
        agentIdForCleanup: taskId,
        enableSummarization: false,
        getWorktreeResult: () => {
          cleanupStarted = true
          return new Promise(() => {})
        },
      }).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(result).toBe('completed')
    expect(cleanupStarted).toBe(true)
    expect(appState.tasks[taskId]?.status).toBe('completed')
    expect(getCommandQueue()).toHaveLength(1)
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<status>completed</status>',
    )
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<task-type>local_agent</task-type>',
    )
    expect(String(getCommandQueue()[0]?.value)).toContain('Review complete.')
  })

  test('streams a background agent\'s tool activity tagged with the parent tool_use id', async () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const taskId = 'agent-activity'
      const abortController = new AbortController()
      const task: LocalAgentTaskState = {
        ...createTaskStateBase(taskId, 'local_agent', 'Probe', 'toolu_parent'),
        status: 'running',
        agentId: taskId,
        prompt: 'Probe',
        agentType: 'general-purpose',
        abortController,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }
      let appState = {
        tasks: { [taskId]: task },
        toolPermissionContext: getEmptyToolPermissionContext(),
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      const toolUseMsg = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } },
        ],
      }) as Message
      const toolResultMsg = createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
        ],
      }) as Message
      async function* makeStream(): AsyncGenerator<Message, void> {
        yield toolUseMsg
        yield toolResultMsg
      }

      await Promise.race([
        runAsyncAgentLifecycle({
          taskId,
          abortController,
          makeStream,
          metadata: {
            prompt: 'Probe',
            resolvedAgentModel: 'test-model',
            isBuiltInAgent: true,
            startTime: Date.now(),
            agentType: 'general-purpose',
            isAsync: true,
          },
          description: 'Probe',
          parentToolUseId: 'toolu_parent',
          toolUseContext: {
            options: { tools: [] },
            toolUseId: 'toolu_parent',
            getAppState: () => appState,
          } as unknown as ToolUseContext,
          rootSetAppState: setAppState,
          agentIdForCleanup: taskId,
          enableSummarization: false,
          getWorktreeResult: () => new Promise(() => {}),
        }).then(() => 'completed'),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
      ])

      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_child', input: { command: 'ls' } },
      ])
      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
      ])
    } finally {
      emitSpy.mockRestore()
    }
  })

  test('files a resumed agent under its spawning Agent card, not the resuming tool', async () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const taskId = 'agent-resumed'
      const abortController = new AbortController()
      const task: LocalAgentTaskState = {
        ...createTaskStateBase(taskId, 'local_agent', 'Verify', 'toolu_agent'),
        status: 'running',
        agentId: taskId,
        prompt: 'Verify',
        agentType: 'general-purpose',
        abortController,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }
      let appState = {
        tasks: { [taskId]: task },
        toolPermissionContext: getEmptyToolPermissionContext(),
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      async function* makeStream(): AsyncGenerator<Message, void> {
        yield createAssistantMessage({
          content: [
            { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } },
          ],
        }) as Message
      }

      await Promise.race([
        runAsyncAgentLifecycle({
          taskId,
          abortController,
          makeStream,
          metadata: {
            prompt: 'Verify',
            resolvedAgentModel: 'test-model',
            isBuiltInAgent: true,
            startTime: Date.now(),
            agentType: 'general-purpose',
            isAsync: true,
          },
          description: 'Verify',
          // The original Agent call, recovered from persisted metadata.
          parentToolUseId: 'toolu_agent',
          toolUseContext: {
            options: { tools: [] },
            // SendMessage drove this resume, so the context carries its id.
            toolUseId: 'toolu_sendmessage',
            getAppState: () => appState,
          } as unknown as ToolUseContext,
          rootSetAppState: setAppState,
          agentIdForCleanup: taskId,
          enableSummarization: false,
          getWorktreeResult: () => new Promise(() => {}),
        }).then(() => 'completed'),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
      ])

      const parents = emitSpy.mock.calls.map(call => call[1])
      expect(parents).toContain('toolu_agent')
      expect(parents).not.toContain('toolu_sendmessage')
      expect(String(getCommandQueue()[0]?.value)).toContain(
        '<tool-use-id>toolu_agent</tool-use-id>',
      )
    } finally {
      emitSpy.mockRestore()
    }
  })

  test('keeps start, progress, and terminal owned when root resumes a nested run', async () => {
    resetStateForTests()
    setIsInteractive(false)
    switchSession('nested-resume-owner-test' as SessionId)
    sdkEventQueue.drainSdkEvents()
    const taskId = 'agent-owned-resume'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Resume nested work', 'toolu_agent'),
      type: 'local_agent',
      status: 'running',
      ownerAgentId: 'parent-agent',
      agentId: taskId,
      prompt: 'Resume nested work',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }

    try {
      registerTask(task, setAppState)
      async function* makeStream(): AsyncGenerator<Message, void> {
        yield createAssistantMessage({
          content: [{
            type: 'tool_use',
            id: 'toolu_child',
            name: 'Bash',
            input: { command: 'pwd' },
          }],
        }) as Message
      }

      await runAsyncAgentLifecycle({
        taskId,
        abortController,
        makeStream,
        metadata: {
          prompt: 'Resume nested work',
          resolvedAgentModel: 'test-model',
          isBuiltInAgent: true,
          startTime: Date.now(),
          agentType: 'general-purpose',
          isAsync: true,
        },
        description: 'Resume nested work',
        parentToolUseId: 'toolu_agent',
        // Deliberately a root continuation. Ownership must come from the
        // resumed run, not from the current caller.
        toolUseContext: {
          options: { tools: [] },
          toolUseId: 'toolu_sendmessage',
          getAppState: () => appState,
        } as unknown as ToolUseContext,
        rootSetAppState: setAppState,
        agentIdForCleanup: taskId,
        enableSummarization: false,
        getWorktreeResult: async () => ({}),
        ownerAgentId: 'parent-agent',
      })

      const events = sdkEventQueue.drainSdkEvents()
      const lifecycle = events.filter(event => (
        'task_id' in event
        && event.task_id === taskId
        && (
          event.subtype === 'task_started'
          || event.subtype === 'task_progress'
          || event.subtype === 'task_notification'
        )
      ))
      expect(lifecycle.map(event => event.subtype)).toEqual([
        'task_started',
        'task_progress',
        'task_notification',
      ])
      expect(lifecycle.every(event => (
        'owner_agent_id' in event && event.owner_agent_id === 'parent-agent'
      ))).toBe(true)
      expect(events).toContainEqual(expect.objectContaining({
        subtype: 'agent_tool_activity',
        task_id: taskId,
        owner_agent_id: 'parent-agent',
      }))
      expect(getCommandQueue()[0]?.agentId).toBe('parent-agent')
    } finally {
      sdkEventQueue.drainSdkEvents()
      resetStateForTests()
    }
  })
})

describe('finalizeAgentTool', () => {
  const metadata = {
    prompt: 'Probe',
    resolvedAgentModel: 'test-model',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: false,
  }

  const inResponse = (responseId: string, message: Message): Message => {
    if (message.type === 'assistant') {
      message.message.id = responseId
    }
    return message
  }
  const textAssistant = (responseId: string, text: string): Message =>
    inResponse(responseId, createAssistantMessage({ content: text }) as Message)
  const emptyAssistant = (responseId: string): Message =>
    inResponse(responseId, createAssistantMessage({ content: [] }) as Message)
  const toolUseAssistant = (
    responseId: string,
    toolUseId: string,
  ): Message =>
    inResponse(
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

  const textOf = (content: Message['message']['content']): string =>
    content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('\n')

  test('recovers text from an earlier segment of the final response', () => {
    const result = finalizeAgentTool(
      [textAssistant('msg_1', 'All done'), emptyAssistant('msg_1')],
      'agent-1',
      metadata,
    )

    expect(textOf(result.content)).toBe('All done')
  })

  const captureThrow = (run: () => unknown): Error => {
    try {
      run()
    } catch (error) {
      return error as Error
    }
    throw new Error('expected finalizeAgentTool to throw')
  }

  test('keeps every text segment of the final response', () => {
    const result = finalizeAgentTool(
      [
        textAssistant('msg_1', 'First'),
        textAssistant('msg_1', 'Second'),
        emptyAssistant('msg_1'),
      ],
      'agent-multi',
      metadata,
    )

    expect(textOf(result.content)).toBe('First\nSecond')
  })

  test('fails instead of settling an empty final response as a result', () => {
    const error = captureThrow(() =>
      finalizeAgentTool(
        [textAssistant('msg_1', 'Old success'), emptyAssistant('msg_2')],
        'agent-2',
        metadata,
      ),
    )

    expect(error.message).toBe('Agent finished without a result')
  })

  test('fails with the final API error text instead of an earlier success', () => {
    const error = captureThrow(() =>
      finalizeAgentTool(
        [
          textAssistant('msg_1', 'Old success'),
          inResponse(
            'msg_2',
            createAssistantAPIErrorMessage({ content: 'API Error: 500' }) as Message,
          ),
        ],
        'agent-3',
        metadata,
      ),
    )

    expect(error.message).toBe('API Error: 500')
  })

  test('fails when the API error tail has no text', () => {
    const apiError = inResponse(
      'msg_2',
      createAssistantAPIErrorMessage({ content: 'placeholder' }) as Message,
    )
    if (apiError.type === 'assistant') {
      apiError.message.content = []
    }
    const error = captureThrow(() =>
      finalizeAgentTool(
        [textAssistant('msg_1', 'Old success'), apiError],
        'agent-3b',
        metadata,
      ),
    )

    expect(error.message).toBe(
      'Agent stopped: the API returned an error with no message',
    )
  })

  test('fails on an unfinished tool use instead of reaching an earlier success', () => {
    const error = captureThrow(() =>
      finalizeAgentTool(
        [
          textAssistant('msg_1', 'Old success'),
          toolUseAssistant('msg_2', 'toolu_unfinished'),
        ],
        'agent-4',
        metadata,
      ),
    )

    expect(error.message).toBe(
      'Agent stopped before its final tool call completed',
    )
  })

  test('reports a cancelled turn as an abort instead of a result', () => {
    const error = captureThrow(() =>
      finalizeAgentTool(
        [
          textAssistant('msg_1', 'Old success'),
          createUserMessage({ content: INTERRUPT_MESSAGE }) as Message,
        ],
        'agent-5',
        metadata,
      ),
    )

    expect(error).toBeInstanceOf(AbortError)
  })

  test('settles a final response whose tool call completed', () => {
    const result = finalizeAgentTool(
      [
        inResponse(
          'msg_1',
          createAssistantMessage({
            content: [
              { type: 'text', text: 'Checked the tree' },
              {
                type: 'tool_use',
                id: 'toolu_done',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          }) as Message,
        ),
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_done',
              content: 'files',
              is_error: false,
            },
          ],
        }) as Message,
      ],
      'agent-6',
      metadata,
    )

    expect(textOf(result.content)).toBe('Checked the tree')
  })
})

describe('runAsyncAgentLifecycle terminal outcomes', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  async function runToTerminal(messages: Message[]): Promise<{
    state: LocalAgentTaskState
    notification: string
  }> {
    const taskId = 'agent-terminal'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Probe', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      prompt: 'Probe',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }

    async function* makeStream(): AsyncGenerator<Message, void> {
      for (const message of messages) {
        yield message
      }
    }

    await runAsyncAgentLifecycle({
      taskId,
      abortController,
      makeStream,
      metadata: {
        prompt: 'Probe',
        resolvedAgentModel: 'test-model',
        isBuiltInAgent: true,
        startTime: Date.now(),
        agentType: 'general-purpose',
        isAsync: true,
      },
      description: 'Probe',
      parentToolUseId: 'toolu_agent',
      toolUseContext: {
        options: { tools: [] },
        toolUseId: 'toolu_agent',
        getAppState: () => appState,
      } as unknown as ToolUseContext,
      rootSetAppState: setAppState,
      agentIdForCleanup: taskId,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })

    return {
      state: appState.tasks[taskId] as LocalAgentTaskState,
      notification: String(getCommandQueue()[0]?.value ?? ''),
    }
  }

  test('fails the background task when the final response is an API error', async () => {
    const { state, notification } = await runToTerminal([
      createAssistantMessage({ content: 'Old success' }) as Message,
      createAssistantAPIErrorMessage({ content: 'API Error: 500' }) as Message,
    ])

    expect(state.status).toBe('failed')
    expect(state.error).toBe('API Error: 500')
    expect(state.result).toBeUndefined()
    expect(notification).toContain('<status>failed</status>')
    expect(notification).not.toContain('<status>completed</status>')
  })

  test('fails the background task when the final response has no text', async () => {
    const { state, notification } = await runToTerminal([
      createAssistantMessage({ content: [] }) as Message,
    ])

    expect(state.status).toBe('failed')
    expect(state.error).toBe('Agent finished without a result')
    expect(state.result).toBeUndefined()
    expect(notification).toContain('<status>failed</status>')
    expect(notification).not.toContain('<status>completed</status>')
  })

  test('stops the background task when the turn was cancelled', async () => {
    const { state, notification } = await runToTerminal([
      createAssistantMessage({ content: 'Old success' }) as Message,
      createUserMessage({ content: INTERRUPT_MESSAGE }) as Message,
    ])

    expect(state.status).toBe('killed')
    expect(state.result).toBeUndefined()
    expect(notification).toContain('<status>killed</status>')
    expect(notification).not.toContain('<status>completed</status>')
  })
})

describe('extractAgentToolActivities', () => {
  test('extracts tool_use blocks from an assistant message', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'text', text: 'Running a command' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' } },
    ])
  })

  test('skips the internal StructuredOutput tool', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: SYNTHETIC_OUTPUT_TOOL_NAME, input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'toolu_2', input: { file_path: '/a' } },
    ])
  })

  test('extracts tool_result blocks from a user message', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
    ])
  })

  test('marks errored tool_result blocks', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
    ])
  })

  test('returns empty for string-only user content', () => {
    const message = createUserMessage({ content: 'just text' }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })

  test('returns empty for an assistant message with no tool_use', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'no tools here' }],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })
})

describe('emitAgentToolActivitiesForMessage', () => {
  test('emits child tool activity for backgrounded sync agents', () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const message = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'pwd' } },
        ],
      }) as Message

      emitAgentToolActivitiesForMessage(
        message,
        'agent-foregrounded',
        'toolu_parent',
        'parent-agent',
      )

      expect(emitSpy.mock.calls).toEqual([
        [
          'agent-foregrounded',
          'toolu_parent',
          { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_child', input: { command: 'pwd' } },
          'parent-agent',
        ],
      ])
    } finally {
      emitSpy.mockRestore()
    }
  })

  test('does nothing without a parent tool use id', () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const message = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'pwd' } },
        ],
      }) as Message

      emitAgentToolActivitiesForMessage(message, 'agent-foregrounded', undefined)

      expect(emitSpy).not.toHaveBeenCalled()
    } finally {
      emitSpy.mockRestore()
    }
  })
})
