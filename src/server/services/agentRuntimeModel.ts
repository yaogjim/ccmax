import { CLAUDE_OFFICIAL_PROVIDER_ID, type SavedProvider } from '../types/provider.js'
import { ApiError } from '../middleware/errorHandler.js'
import { normalizeExplicitClaudeOfficialModelId } from './claudeOfficialRuntime.js'
import type { ProviderService } from './providerService.js'

const MODEL_ALIASES = ['default', 'main', 'fable', 'sonnet', 'opus', 'haiku']

export type AgentRuntimeModelErrorCode =
  | 'provider_missing'
  | 'model_unresolvable'

/**
 * A runtime (provider + model) that cannot be launched. Carries a stable code
 * so callers can report a status without parsing the message.
 */
export class AgentRuntimeModelError extends Error {
  constructor(
    readonly code: AgentRuntimeModelErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentRuntimeModelError'
  }
}

export type ResolvedAgentRuntimeModel = {
  /** `null` for the desktop-managed Claude official login. */
  provider: SavedProvider | null
  /** Concrete model id, after alias mapping. Never `inherit`. */
  modelId: string
}

export type AgentRuntimeStatus = 'valid' | AgentRuntimeModelErrorCode

/**
 * Non-throwing form for listings: reports whether a saved binding could launch
 * right now, plus the resolved provider name when it can be found.
 */
export async function describeAgentRuntime(
  providerService: Pick<ProviderService, 'getProvider'>,
  runtime: { providerId: string; modelId: string },
): Promise<{
  status: AgentRuntimeStatus
  providerName?: string
  resolvedModelId?: string
}> {
  try {
    const resolved = await resolveAgentRuntimeModel(providerService, runtime)
    return {
      status: 'valid',
      providerName: resolved.provider?.name ?? 'Claude',
      resolvedModelId: resolved.modelId,
    }
  } catch (error) {
    if (error instanceof AgentRuntimeModelError) {
      return { status: error.code }
    }
    // Unreadable provider store etc.: not a binding problem the user can fix by
    // reselecting, but a listing must not fail because of it.
    return { status: 'provider_missing' }
  }
}

/**
 * Turn a saved (providerId, modelId) pair into a launchable concrete model.
 *
 * Shared by Team plans and pinned agents so the two cannot drift. Purely local:
 * never invokes a model or discovers credentials.
 *
 * `subject` names what the caller is validating ("teammate x", "agent niuma")
 * for the "choose a concrete model" message.
 */
export async function resolveAgentRuntimeModel(
  providerService: Pick<ProviderService, 'getProvider'>,
  runtime: { providerId: string; modelId: string },
  subject = 'this runtime',
): Promise<ResolvedAgentRuntimeModel> {
  let provider: SavedProvider | null = null
  if (runtime.providerId !== CLAUDE_OFFICIAL_PROVIDER_ID) {
    try {
      provider = await providerService.getProvider(runtime.providerId)
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        throw new AgentRuntimeModelError('provider_missing', error.message)
      }
      throw error
    }
  }

  const requestedModel = runtime.modelId.trim()
  const aliases = provider?.models as Record<string, string> | undefined
  if (
    provider &&
    MODEL_ALIASES.includes(requestedModel) &&
    !aliases?.[requestedModel === 'default' ? 'main' : requestedModel]
  ) {
    throw new AgentRuntimeModelError(
      'model_unresolvable',
      `Provider has no mapping for ${requestedModel}`,
    )
  }

  const modelId = provider
    ? aliases?.[requestedModel === 'default' ? 'main' : requestedModel] ||
      requestedModel
    : normalizeExplicitClaudeOfficialModelId(requestedModel)
  if (!modelId || !/^[^\s\x00-\x1f]+$/.test(modelId) || modelId === 'inherit') {
    throw new AgentRuntimeModelError(
      'model_unresolvable',
      `Choose a concrete model for ${subject}`,
    )
  }
  return { provider, modelId }
}
