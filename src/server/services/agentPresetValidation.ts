import type { TeamPlanAgentSnapshot } from '../../shared/teamPlan.js'

/**
 * Restrictions an agent preset must satisfy before a server-started worker can
 * run it. Shared by Team plans and pinned agents so the two cannot drift.
 *
 * Pure and local: it never touches settings, plugins, or a model.
 */
export function validateAgentPresetSnapshot(
  snapshot: TeamPlanAgentSnapshot,
  agentType: string,
  options: {
    /** Permission mode of the session that will own the worker. */
    parentPermissionMode: string
    /** Names the kind of worker in error text, e.g. "team worker". */
    workerLabel: string
    /** Appended to the permission-mode conflict, telling the user how to fix it. */
    permissionHint: string
  },
): void {
  if (snapshot.configurationError) {
    throw new Error(`Agent preset ${agentType}: ${snapshot.configurationError}`)
  }
  if (
    snapshot.permissionMode &&
    snapshot.permissionMode !== 'default' &&
    snapshot.permissionMode !== options.parentPermissionMode
  ) {
    throw new Error(
      `Agent preset ${agentType} requires permission mode ${snapshot.permissionMode}; ${options.permissionHint}`,
    )
  }
  const unsupported = [...(snapshot.isolation ? ['isolation'] : [])]
  if (unsupported.length) {
    throw new Error(
      `Agent preset ${agentType} uses unsupported ${options.workerLabel} settings: ${unsupported.join(', ')}`,
    )
  }
  if (
    snapshot.maxTurns !== undefined &&
    (!Number.isInteger(snapshot.maxTurns) || snapshot.maxTurns < 1)
  ) {
    throw new Error(`Agent preset ${agentType} has invalid maxTurns`)
  }
}
