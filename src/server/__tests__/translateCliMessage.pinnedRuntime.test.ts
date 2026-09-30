import { describe, expect, it } from 'bun:test'
import { readPinnedAgentRuntime } from '../ws/cliMessageParsing.js'
import { translateCliMessage } from '../ws/handler.js'

const PINNED_RESULT = {
  status: 'completed',
  agentId: 'ad0e13d30506707d2',
  runtime: {
    mode: 'pinned',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    requestedModel: 'deepseek-flash',
    status: 'completed',
    warnings: ['ignored'],
    secret: 'must not be forwarded',
  },
}

function agentResult(structured: Record<string, unknown>) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'done' }] }],
    },
    ...structured,
  }
}

describe('translateCliMessage: pinned agent runtime', () => {
  it('forwards where a pinned agent ran alongside its tool result', () => {
    const out = translateCliMessage(agentResult({ tool_use_result: PINNED_RESULT }), 'session-1')
    expect(out).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'toolu_agent',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        parentToolUseId: undefined,
        agentRuntime: { providerId: 'deepseek', providerName: 'DeepSeek', requestedModel: 'deepseek-flash' },
      },
    ])
  })

  it('also reads the camelCase structured result', () => {
    const out = translateCliMessage(agentResult({ toolUseResult: PINNED_RESULT }), 'session-1')
    expect(out[0]).toMatchObject({ agentRuntime: { providerName: 'DeepSeek' } })
  })

  it('leaves ordinary tool results without a runtime field', () => {
    const out = translateCliMessage(agentResult({ tool_use_result: { status: 'completed', agentId: 'a' } }), 'session-1')
    expect(out[0]).not.toHaveProperty('agentRuntime')
    const bare = translateCliMessage(agentResult({}), 'session-1')
    expect(bare[0]).not.toHaveProperty('agentRuntime')
  })

  it('ignores an incomplete or non-pinned runtime', () => {
    expect(readPinnedAgentRuntime({ runtime: { mode: 'pinned', providerId: 'p' } })).toBeUndefined()
    expect(readPinnedAgentRuntime({ runtime: { mode: 'inherit', providerId: 'p', providerName: 'P', requestedModel: 'm' } })).toBeUndefined()
    expect(readPinnedAgentRuntime('not an object')).toBeUndefined()
    expect(readPinnedAgentRuntime(null)).toBeUndefined()
  })
})
