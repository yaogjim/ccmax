/**
 * Swarm Reconnection Module
 *
 * Handles initialization of swarm context for teammates.
 * - Fresh spawns: Initialize from CLI args (set in main.tsx via dynamicTeamContext)
 * - Resumed sessions: Initialize from teamName/agentName stored in the transcript
 */

import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicTeamContext, setDynamicTeamContext } from '../teammate.js'
import { parseConsumerScope, withConsumerScope, type ScopeCheck } from './consumerScope.js'
import { getTeamFilePath, readTeamFile } from './teamHelpers.js'

/**
 * Computes the initial teamContext for AppState.
 *
 * This is called synchronously in main.tsx to compute the teamContext
 * BEFORE the first render, eliminating the need for useEffect workarounds.
 *
 * @returns The teamContext object to include in initialState, or undefined if not a teammate
 */
export function computeInitialTeamContext():
  | AppState['teamContext']
  | undefined {
  // dynamicTeamContext is set in main.tsx from CLI args
  const context = getDynamicTeamContext()

  if (!context?.teamName || !context?.agentName) {
    logForDebugging(
      '[Reconnection] computeInitialTeamContext: No teammate context set (not a teammate)',
    )
    return undefined
  }

  const { teamName, agentId, agentName } = context

  // Read team file to get lead agent ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logError(
      new Error(
        `[computeInitialTeamContext] Could not read team file for ${teamName}`,
      ),
    )
    return undefined
  }

  const teamFilePath = getTeamFilePath(teamName)

  const isLeader = !agentId

  logForDebugging(
    `[Reconnection] Computed initial team context for ${isLeader ? 'leader' : `teammate ${agentName}`} in team ${teamName}`,
  )

  return {
    teamName,
    teamFilePath,
    leadAgentId: teamFile.leadAgentId,
    selfAgentId: agentId,
    selfAgentName: agentName,
    isLeader,
    teammates: {},
    consumerScope: context.consumerScope,
  }
}

/** Last explicit carrier wins, including null, malformed and future versions. */
export function latestTranscriptConsumerScope(messages: readonly unknown[]): unknown {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (typeof message === 'object' && message !== null && Object.hasOwn(message, 'consumerScope')) {
      return (message as { consumerScope: unknown }).consumerScope
    }
  }
  return undefined
}

/** Restore only the original instance under the normal consumption fences. */
export async function restoreTranscriptConsumerScope(
  messages: readonly unknown[],
  ownerSessionId: string,
  install: (context: NonNullable<AppState['teamContext']>) => void,
): Promise<ScopeCheck<boolean>> {
  const parsed = parseConsumerScope(latestTranscriptConsumerScope(messages))
  if (parsed.status !== 'bound') return parsed
  const { scope } = parsed
  // A root transcript may not acquire the identity of an in-process child.
  // Those recover through their metadata + transcript ID in the runner.
  if (scope.recipient.kind === 'member' && scope.recipient.backend === 'in-process') return { status: 'stale' }
  return withConsumerScope(scope, (current, team) => {
    // The owner may have switched during lock acquisition (/resume). Do not
    // install a binding validated for a process that no longer owns this turn.
    if (getSessionId() !== ownerSessionId) return false
    const member = current.recipient.kind === 'member'
      ? team.members.find(candidate => candidate.consumerInstanceId === (current.recipient.kind === 'member' ? current.recipient.memberInstanceId : undefined))
      : undefined
    if (current.recipient.kind === 'member' && !member) return false
    if (member) {
      setDynamicTeamContext({
        teamName: team.name, agentId: member.agentId, agentName: member.name,
        planModeRequired: member.planModeRequired ?? false,
        color: member.color, parentSessionId: current.leadSessionId, consumerScope: current,
      })
    }
    install({
      teamName: team.name, teamFilePath: getTeamFilePath(team.name),
      leadAgentId: team.leadAgentId, selfAgentId: member?.agentId,
      selfAgentName: member?.name, isLeader: current.recipient.kind === 'lead',
      teammates: {}, consumerScope: current,
    })
    return true
  }, { expectedOwnerSessionId: ownerSessionId })
}

/**
 * Initialize teammate context from a resumed session.
 *
 * This is called when resuming a session that has teamName/agentName stored
 * in the transcript. It sets up teamContext in AppState so that heartbeat
 * and other swarm features work correctly.
 */
export async function initializeTeammateContextFromSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  teamName: string,
  agentName: string,
  consumerScope?: unknown,
  ownerSessionId?: string,
): Promise<void> {
  // Names are display/address metadata, never a registration authority.
  const parsed = parseConsumerScope(consumerScope)
  if (parsed.status !== 'bound' || !ownerSessionId || parsed.scope.teamName !== teamName ||
    parsed.scope.recipient.kind !== 'member' || parsed.scope.recipient.agentName !== agentName) return
  await restoreTranscriptConsumerScope([{ consumerScope }], ownerSessionId, context => {
    setAppState(prev => ({ ...prev, teamContext: context }))
  })
}
