import { afterEach, describe, expect, spyOn, test, mock } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import * as resumeAgentModule from '../AgentTool/resumeAgent.js'
import { SendMessageTool } from './SendMessageTool.js'

const AGENT_ID = 'ad0e13d30506707d2'

afterEach(() => {
  mock.restore()
})

function send() {
  const appState = getDefaultAppState()
  const context = {
    options: { mainLoopModel: 'sonnet', tools: [], mcpClients: [] },
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
  } as unknown as ToolUseContext
  return SendMessageTool.call(
    { to: AGENT_ID, summary: 'follow up', message: 'Continue please' } as never,
    context,
    (async () => ({ behavior: 'allow' })) as never,
    createAssistantMessage({ content: 'Sending.' }),
  )
}

describe('SendMessage to a pinned agent', () => {
  test('is refused with a clear message and does not resume it on this session', async () => {
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({
      agentType: 'niuma',
      runtime: { mode: 'pinned', providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', model: 'deepseek-v4-flash', workerSessionId: 'w' },
    })
    const resumeSpy = spyOn(resumeAgentModule, 'resumeAgentBackground')

    const result = await send()

    expect(result.data).toMatchObject({
      success: false,
      message: expect.stringContaining('cannot be resumed or sent messages'),
    })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  test('an ordinary agent is still resumed', async () => {
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({ agentType: 'general-purpose' })
    const resumeSpy = spyOn(resumeAgentModule, 'resumeAgentBackground').mockResolvedValue({
      agentId: AGENT_ID,
      description: 'd',
      outputFile: '/tmp/out',
    })

    const result = await send()

    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({ success: true })
  })
})
