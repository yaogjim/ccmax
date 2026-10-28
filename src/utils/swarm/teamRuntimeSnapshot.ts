import type { AppState } from '../../state/AppState.js'
import type { TeamFile } from './teamHelpers.js'
import { parseConsumerScope, withConsumerScope, type ScopeCheck } from './consumerScope.js'
import { getTeamFilePath } from './teamHelpers.js'

/** Verify the host carrier against disk and the actual restored process owner. */
export async function installProcessConsumerScope(
  rawScope: unknown,
  sessionId: string,
  install: (context: NonNullable<AppState['teamContext']>) => void,
): Promise<ScopeCheck<boolean>> {
  const parsed = parseConsumerScope(rawScope)
  if (parsed.status !== 'bound') return parsed
  const { scope } = parsed
  if (scope.ownerSessionId !== sessionId || scope.recipient.kind !== 'member') return { status: 'stale' }
  if (scope.recipient.backend !== 'pane' &&
    (scope.recipient.backend !== 'process' || scope.recipient.memberSessionId !== sessionId)) return { status: 'stale' }
  return withConsumerScope(scope, (current, team) => {
    install({ teamName: team.name, teamFilePath: getTeamFilePath(team.name), leadAgentId: team.leadAgentId, isLeader: false, consumerScope: current, teammates: {} })
    return true
  })
}

/** Host snapshots carry an identity, not a mutable copy of the team's state. */
export function buildTeamRuntimeSnapshot(
  team: TeamFile | null,
  expectedCreatedAt: number,
  sessionId: string,
  teamFilePath: string,
  rawScope: unknown,
): NonNullable<AppState['teamContext']> {
  const parsed = parseConsumerScope(rawScope)
  if (parsed.status !== 'bound') throw new Error(`Team runtime snapshot consumer identity ${parsed.status}`)
  const { scope } = parsed
  if (!team || team.createdAt !== expectedCreatedAt || team.leadSessionId !== sessionId ||
    scope.recipient.kind !== 'lead' || scope.ownerSessionId !== sessionId || scope.leadSessionId !== sessionId ||
    scope.teamName !== team.name || scope.createdAt !== team.createdAt) {
    throw new Error('Stale or foreign team runtime snapshot')
  }
  return {
    consumerScope: scope,
    teamName: team.name, teamFilePath, leadAgentId: team.leadAgentId, isLeader: true,
    teammates: Object.fromEntries(team.members.map(member => [member.agentId, {
      name: member.name, agentType: member.agentType, cwd: member.cwd,
      tmuxSessionName: member.backendType === 'process' ? 'process' : '', tmuxPaneId: member.tmuxPaneId,
      spawnedAt: member.joinedAt,
    }])),
  }
}
