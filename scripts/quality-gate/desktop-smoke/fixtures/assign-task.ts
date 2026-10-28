/** Dynamic assignment, not a seeded launch/result: use the existing task store. */
import { createTask, getCanonicalTeamTaskListId } from '../../../../src/utils/tasks'

const [teamName, owner] = process.argv.slice(2)
if (!process.env.CLAUDE_CONFIG_DIR || !teamName || !owner) throw new Error('Sandbox config, team and owner are required')
const taskId = await createTask(getCanonicalTeamTaskListId(teamName), {
  subject: 'P3 dynamic delivery', description: 'Publish a versioned checklist for independent review.',
  owner, status: 'pending', blocks: [], blockedBy: [],
})
console.log(JSON.stringify({ taskId }))
