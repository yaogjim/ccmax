/**
 * Teammate Initialization Module
 *
 * Handles initialization for Claude Code instances running as teammates in a swarm.
 * Registers a Stop hook to notify the team leader when the teammate becomes idle.
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { jsonStringify } from '../slowOperations.js'
import { getTeammateColor } from '../teammate.js'
import {
  createIdleNotification,
  getLastPeerDmSummary,
  writeToMailbox,
} from '../teammateMailbox.js'
import { formatAgentId } from '../agentId.js'
import { mutateScopedTeam, parseConsumerScope, withConsumerScope, type ConsumerScope } from './consumerScope.js'

/**
 * Initializes hooks for a teammate running in a swarm.
 * Should be called early in session startup after AppState is available.
 *
 * Registers a Stop hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export async function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: { teamName: string; agentId: string; agentName: string; consumerScope?: ConsumerScope },
): Promise<void> {
  const { teamName, agentId, agentName } = teamInfo
  const parsed = parseConsumerScope(teamInfo.consumerScope)
  if (parsed.status !== 'bound') return
  const scope = parsed.scope
  if (scope.teamName !== teamName || (scope.recipient.kind === 'member' &&
    (scope.recipient.agentName !== agentName || agentId !== formatAgentId(agentName, teamName)))) return

  const initialized = await withConsumerScope(scope, (_scope, teamFile) => {
    const leadAgentId = teamFile.leadAgentId
    if (scope.recipient.kind === 'lead' && agentId !== leadAgentId) return

    // Apply team-wide allowed paths if any exist
    if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
      logForDebugging(
        `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
      )

      for (const allowedPath of teamFile.teamAllowedPaths) {
        // For absolute paths (starting with /), prepend one / to create //path/** pattern
        // For relative paths, just use path/**
        const ruleContent = allowedPath.path.startsWith('/')
          ? `/${allowedPath.path}/**`
          : `${allowedPath.path}/**`

        logForDebugging(
          `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
        )

        setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(
            prev.toolPermissionContext,
            {
              type: 'addRules',
              rules: [
                {
                  toolName: allowedPath.toolName,
                  ruleContent,
                },
              ],
              behavior: 'allow',
              destination: 'session',
            },
          ),
        }))
      }
    }

    // Find the leader's name from the members array
    const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
    const leadAgentName = leadMember?.name || 'team-lead'

    // Don't register hook if this agent is the leader
    if (agentId === leadAgentId) {
      logForDebugging(
        '[TeammateInit] This agent is the team leader - skipping idle notification hook',
      )
      return
    }

    logForDebugging(
      `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
    )

    // Register Stop hook to notify leader when this teammate stops
    addFunctionHook(
      setAppState,
      sessionId,
      'Stop',
      '', // No matcher - applies to all Stop events
      async (messages, _signal) => {
        const notification = createIdleNotification(agentName, {
          idleReason: 'available',
          summary: getLastPeerDmSummary(messages),
        })
        const stopped = await mutateScopedTeam(scope, async team => {
          const recipient = scope.recipient
          if (recipient.kind !== 'member') return
          const member = team.members.find(member => member.agentId === agentId &&
            member.name === agentName && member.consumerInstanceId === recipient.memberInstanceId)
          if (!member) return
          member.isActive = false
          await writeToMailbox(leadAgentName, {
            from: agentName,
            text: jsonStringify(notification),
            timestamp: new Date().toISOString(),
            color: getTeammateColor(),
          }, teamName)
        }, { expectedOwnerSessionId: sessionId })
        logForDebugging(
          `[TeammateInit] Stop notification ${stopped.status} for ${agentName}`,
        )
        return true // Don't block the Stop
      },
      'Failed to send idle notification to team leader',
      {
        timeout: 10000,
      },
    )
  }, { expectedOwnerSessionId: sessionId })
  if (initialized.status !== 'current') {
    logForDebugging(`[TeammateInit] Initialization refused: ${initialized.status}`)
  }
}
