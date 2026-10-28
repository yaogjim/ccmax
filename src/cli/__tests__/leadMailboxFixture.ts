import { leadConsumerScope } from '../../utils/swarm/consumerScope.js'
import { writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import {
  beginTaskListLifecycle,
  getCanonicalTeamTaskListId,
  withTaskListLifecycleLock,
} from '../../utils/tasks.js'

export async function createLeadMailboxFixture(teamName: string) {
  const team = {
    name: teamName,
    createdAt: 10,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: 'fixture-lead-session',
    members: [],
  }
  const listId = getCanonicalTeamTaskListId(teamName)
  const lifecycle = await withTaskListLifecycleLock(listId, async () => {
    await writeTeamFileAsync(teamName, team)
    return beginTaskListLifecycle(listId, {
      teamName,
      createdAt: team.createdAt,
      leadSessionId: team.leadSessionId,
    })
  })
  return leadConsumerScope({
    team,
    generation: lifecycle.generation,
    ownerSessionId: team.leadSessionId,
  })
}
