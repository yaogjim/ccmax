/**
 * Wire types of `POST /api/pinned-agent/run` (NDJSON, one event per line).
 * Shared by the server that produces the stream and the CLI adapter that
 * consumes it.
 */
export type PinnedAgentUsage = Record<string, unknown>

export type PinnedAgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; text: string }

export type PinnedAgentErrorCode =
  | 'worker_error'
  | 'worker_exited'
  | 'worker_stopped'
  | 'cancelled'

export type PinnedAgentEvent =
  | {
      type: 'started'
      workerSessionId: string
      provider: { id: string; name: string }
      /** What the user configured (may be an alias). */
      requestedModel: string
      /** The concrete model id the worker was launched with. */
      model: string
      toolUseId?: string
      agentId?: string
    }
  | { type: 'progress'; kind: 'assistant' | 'tool_result'; blocks: PinnedAgentBlock[] }
  | {
      type: 'result'
      ok: boolean
      text: string
      errorCode?: PinnedAgentErrorCode
      usage?: PinnedAgentUsage
      numTurns?: number
      durationMs?: number
      costUsd?: number
    }

/**
 * Where a pinned agent ran, as reported by the Agent tool's structured result
 * and forwarded to the desktop so a card can say "provider · model". Always
 * derived from the server's `started` event, never from the agent's own text.
 */
export type PinnedAgentRuntimeBadge = {
  providerId: string
  providerName: string
  requestedModel: string
}
