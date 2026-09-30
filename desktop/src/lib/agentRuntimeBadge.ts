import type { AgentRuntimeBadge } from '../types/chat'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Where a pinned Agent ran, read from a persisted tool result
 * (`toolUseResult.runtime`). Only the three display fields are copied; the
 * result carries more (warnings, worker ids) that is not meant for the card.
 */
export function readAgentRuntimeBadge(toolUseResult: unknown): AgentRuntimeBadge | undefined {
  const runtime = asRecord(asRecord(toolUseResult)?.runtime)
  if (!runtime || runtime.mode !== 'pinned') return undefined
  const { providerId, providerName, requestedModel } = runtime
  if (
    typeof providerId !== 'string' ||
    typeof providerName !== 'string' ||
    typeof requestedModel !== 'string'
  ) return undefined
  return { providerId, providerName, requestedModel }
}

/** Spread into a `tool_result` UI message. */
export function agentRuntimeField(toolUseResult: unknown): { agentRuntime?: AgentRuntimeBadge } {
  const agentRuntime = readAgentRuntimeBadge(toolUseResult)
  return agentRuntime ? { agentRuntime } : {}
}

export function formatAgentRuntimeBadge(badge: AgentRuntimeBadge): string {
  return `${badge.providerName} · ${badge.requestedModel}`
}
