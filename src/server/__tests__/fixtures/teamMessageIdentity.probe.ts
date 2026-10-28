import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 诊断现状，不是需求已满足的回归测试；所有模块在隔离环境设置后加载。
const home = await mkdtemp(join(tmpdir(), 'team-identity-probe-'))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
globalThis.fetch = (() => { throw new Error('Probe forbids network calls') }) as typeof fetch
const watchdog = setTimeout(() => { console.error('Identity probe timed out'); process.exit(1) }, 15_000)
const { handleTeamsApi } = await import('../../api/teams.js')
const { teamService, teamIncarnationId } = await import('../../services/teamService.js')
const { mutateTeamFileAsync } = await import('../../../utils/swarm/teamHelpers.js')
const teamName = 'identity-probe'
const directory = join(home, 'teams', teamName)
const configPath = join(directory, 'config.json')
const inboxPath = join(directory, 'inboxes', 'worker.json')
const historyPath = join(directory, 'inboxes', 'worker.history.jsonl')
const readOrEmpty = async (path: string) => readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''
  throw error
})
const config = {
  name: teamName, createdAt: 1700000000000, leadSessionId: 'fixture-lead',
  leadAgentId: `team-lead@${teamName}`,
  members: [{ agentId: `worker@${teamName}`, name: 'worker', agentType: 'worker',
    sessionId: 'fixture-old-member', joinedAt: 1700000000001, isActive: false }],
}
const post = async (id: string, identity = {}) => {
  const url = new URL(`http://localhost/api/teams/${teamName}/members/worker%40${teamName}/messages`)
  return handleTeamsApi(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'fixture instruction', messageId: id, ...identity }),
  }), url, url.pathname.split('/').filter(Boolean))
}

try {
  await mkdir(directory, { recursive: true })
  await writeFile(configPath, JSON.stringify(config))
  const before = { live: await readOrEmpty(inboxPath), history: await readOrEmpty(historyPath) }
  const responses = [await post('probe-missing-identity'), await post('probe-missing-identity')]
  const after = { live: await readOrEmpty(inboxPath), history: await readOrEmpty(historyPath) }
  assert.deepEqual(responses.map(response => response.status), [400, 400])
  assert.deepEqual(after, before)
  console.log(JSON.stringify({ scenario: 'missing-identity-retry', statuses: responses.map(r => r.status),
    liveChanged: before.live !== after.live, historyChanged: before.history !== after.history,
    requirementSatisfied: true }))

  // 在真实成员解析完成后设置可控屏障；替换仍经生产 config mutation。
  const internals = teamService as unknown as {
    resolveMemberName: (...args: unknown[]) => Promise<string | null>
  }
  const original = internals.resolveMemberName
  let release!: () => void
  let reached!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const resolved = new Promise<void>(resolve => { reached = resolve })
  internals.resolveMemberName = async function (...args) {
    const recipient = await original.apply(this, args)
    reached()
    await barrier
    return recipient
  }
  try {
    const pending = post('probe-replaced-member', { incarnationId: teamIncarnationId(config), memberSessionId: 'fixture-old-member' })
    await resolved
    const replacement = mutateTeamFileAsync(teamName, current => {
      current.members[0]!.sessionId = 'fixture-replacement-member'
    })
    release()
    const response = await pending
    await replacement
    const current = JSON.parse(await readFile(configPath, 'utf8'))
    const delivered = JSON.parse(await readFile(inboxPath, 'utf8'))
    assert.equal(response.status, 200)
    assert.equal(current.members[0].sessionId, 'fixture-replacement-member')
    assert.ok(delivered.some((entry: { id: string }) => entry.id === 'probe-replaced-member'))
    const beforeRetry = await readFile(inboxPath, 'utf8')
    const retry = await post('probe-replaced-member', { incarnationId: teamIncarnationId(config), memberSessionId: 'fixture-old-member' })
    assert.equal(retry.status, 409)
    assert.equal(await readFile(inboxPath, 'utf8'), beforeRetry)
    console.log(JSON.stringify({ scenario: 'member-replaced-after-resolution', status: response.status,
      staleRetryStatus: retry.status, requirementSatisfied: true,
      boundary: 'send commits before replacement; stale retry rejected; lock ordering asserted in teams.test.ts' }))
  } finally {
    release()
    internals.resolveMemberName = original
  }
} finally {
  clearTimeout(watchdog)
  await rm(home, { recursive: true, force: true })
}
