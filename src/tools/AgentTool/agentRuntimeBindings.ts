import {
  getEnabledSettingSources,
  type SettingSource,
} from '../../utils/settings/constants.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'

/**
 * Only these sources may pin an agent to a provider. A binding decides where a
 * task's content is sent, so project, local, flag and plugin files (all of
 * which can arrive with a cloned repository) must not be able to declare one.
 * Listed lowest priority first; a later source wins.
 */
const BINDING_SOURCES: readonly SettingSource[] = [
  'userSettings',
  'policySettings',
]

export type AgentRuntimeBinding = {
  providerId: string
  modelId: string
  /** Which settings file supplied this binding — drives editability in the UI. */
  source: SettingSource
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

/**
 * Read `agentRuntimeBindings` from user and managed settings.
 *
 * Walks sources instead of the merged settings object for the same reasons as
 * resolveBuiltInAgentOverrides: source attribution for the UI, and load-time
 * enforcement of `strictPluginOnlyCustomization` (settings.json is
 * user-writable, so blocking only the write path would not be enough).
 *
 * Entries missing either field are ignored rather than half-applied: an agent
 * with a provider but no model must run unpinned-and-reported, never on a
 * guessed model.
 */
export function resolveAgentRuntimeBindings(): Map<string, AgentRuntimeBinding> {
  const resolved = new Map<string, AgentRuntimeBinding>()
  const agentsLocked = isRestrictedToPluginOnly('agents')
  const enabled = new Set(getEnabledSettingSources())

  for (const source of BINDING_SOURCES) {
    if (!enabled.has(source)) continue
    if (agentsLocked && !isSourceAdminTrusted(source)) continue

    const bindings = getSettingsForSource(source)?.agentRuntimeBindings
    if (!bindings || typeof bindings !== 'object') continue

    for (const [agentType, entry] of Object.entries(bindings)) {
      if (!entry || typeof entry !== 'object') continue
      // Re-validate: policySettings can arrive from MDM/registry/remote sync,
      // which never passes through the file parser's per-field .catch().
      const providerId = readString(entry.providerId)
      const modelId = readString(entry.modelId)
      if (!providerId || !modelId) continue
      resolved.set(agentType, { providerId, modelId, source })
    }
  }

  return resolved
}

export function resolveAgentRuntimeBinding(
  agentType: string,
): AgentRuntimeBinding | undefined {
  return resolveAgentRuntimeBindings().get(agentType)
}
