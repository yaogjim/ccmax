import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { resumeAgentBackground } from './resumeAgent.js'
import * as runAgentModule from './runAgent.js'

afterEach(() => {
  mock.restore()
})

describe('resuming a pinned agent', () => {
  test('is refused instead of re-running its transcript on the session provider', async () => {
    const appState = getDefaultAppState()
    const toolUseContext = {
      options: { mainLoopModel: 'sonnet', tools: [], mcpClients: [], agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
    } as unknown as ToolUseContext
    spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({ messages: [], contentReplacements: [] })
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({
      agentType: 'niuma',
      runtime: { mode: 'pinned', providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash', model: 'deepseek-v4-flash', workerSessionId: 'w' },
    })
    const runAgentSpy = spyOn(runAgentModule, 'runAgent')

    await expect(resumeAgentBackground({
      agentId: 'ad0e13d30506707d2',
      prompt: 'Continue',
      toolUseContext,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
    })).rejects.toThrow('cannot be resumed or sent messages')
    expect(runAgentSpy).not.toHaveBeenCalled()
  })
})
