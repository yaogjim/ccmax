import { expect, spyOn, test } from 'bun:test'
import * as lockfile from '../lockfile.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'
import { claimMailboxMessages, getInboxHistoryPath, getInboxPath } from '../teammateMailbox.js'
import {
  cleanupTeamDirectories,
  getTeamFilePath,
  mutateTeamFileAsync,
  readTeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'
import * as consumers from './consumerScope.js'
import { consumerScopeKey, sameConsumerScope, type ConsumerScope } from './consumerScope.js'

/** Writes the live inbox directly so duplicate ids and legacy tuples stay exact. */
async function writeInbox(teamName: string, messages: readonly unknown[]): Promise<void> {
  const live = getInboxPath('worker', teamName)
  await mkdir(dirname(live), { recursive: true })
  await writeFile(live, JSON.stringify(messages))
}

const scope: ConsumerScope = {
  version: 1, teamName: 'fixture', generation: 1, createdAt: 10,
  leadSessionId: 'lead', ownerSessionId: 'lead', recipient: { kind: 'lead' },
}

test('stale registration and late cleanup leave the replacement roster unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'consumer-registration-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const team = {
      name: 'registration', createdAt: 10, leadSessionId: 'lead', leadAgentId: 'team-lead@registration',
      members: [{ name: 'worker', agentId: 'worker@registration', consumerInstanceId: 'old',
        backendType: 'in-process' as const, joinedAt: 10, cwd: home, tmuxPaneId: 'in-process', subscriptions: [] }],
    }
    await writeTeamFileAsync(team.name, team)
    const list = getCanonicalTeamTaskListId(team.name)
    const lifecycle = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, {
      teamName: team.name, createdAt: 10, leadSessionId: 'lead',
    }))
    const old = consumers.memberConsumerScope({ team, generation: lifecycle.generation,
      ownerSessionId: 'lead', backend: 'in-process', agentName: 'worker', memberInstanceId: 'old' })
    const replacement = { ...team, members: [{ ...team.members[0]!, consumerInstanceId: 'new' }] }
    await writeTeamFileAsync(team.name, replacement)
    const bytes = await readFile(getTeamFilePath(team.name), 'utf8')
    expect(await consumers.mutateScopedTeam(old, current => { current.members = [] })).toEqual({ status: 'stale' })
    expect(await consumers.removeScopedMember(old, 'worker@registration')).toEqual({ status: 'stale' })
    expect(await readFile(getTeamFilePath(team.name), 'utf8')).toBe(bytes)
    const fresh = { ...old, recipient: { ...old.recipient, memberInstanceId: 'new' } } as ConsumerScope
    expect(await consumers.removeScopedMember(fresh, 'worker@registration')).toEqual({ status: 'current', value: true })
    expect(readTeamFile(team.name)!.members).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('pane consumers accept tmux and iTerm2 only for their original session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'consumer-pane-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const team = { name: 'pane', createdAt: 10, leadSessionId: 'lead', leadAgentId: 'team-lead@pane',
      members: [{ name: 'worker', agentId: 'worker@pane', consumerInstanceId: 'instance',
        backendType: 'tmux' as const, sessionId: 'pane-session', joinedAt: 10, cwd: home, tmuxPaneId: '%1', subscriptions: [] }] }
    await writeTeamFileAsync(team.name, team)
    const list = getCanonicalTeamTaskListId(team.name)
    const lifecycle = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, {
      teamName: team.name, createdAt: 10, leadSessionId: 'lead',
    }))
    const pane = consumers.memberConsumerScope({ team, generation: lifecycle.generation,
      ownerSessionId: 'pane-session', backend: 'pane', agentName: 'worker', memberInstanceId: 'instance' })
    expect(await consumers.withConsumerScope(pane, () => 'accepted')).toEqual({ status: 'current', value: 'accepted' })
    await writeTeamFileAsync(team.name, { ...team, members: [{ ...team.members[0]!, backendType: 'iterm2' }] })
    expect(await consumers.withConsumerScope(pane, () => 'accepted')).toEqual({ status: 'current', value: 'accepted' })
    expect(await consumers.withConsumerScope({ ...pane, ownerSessionId: 'other-session' }, () => 'accepted')).toEqual({ status: 'stale' })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('a scoped consumer cannot read, claim or acknowledge a recreated same-name inbox', async () => {
  const home = await mkdtemp(join(tmpdir(), 'consumer-recreated-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const name = 'recreated'
    const firstConfig = {
      name,
      createdAt: 100,
      leadSessionId: 'old-lead',
      leadAgentId: `team-lead@${name}`,
      members: [{
        name: 'worker', agentId: `worker@${name}`, consumerInstanceId: 'old-instance',
        backendType: 'in-process' as const, joinedAt: 100, cwd: home,
        tmuxPaneId: 'in-process', subscriptions: [],
      }],
    }
    await writeTeamFileAsync(name, firstConfig)
    const list = getCanonicalTeamTaskListId(name)
    const first = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, {
      teamName: name, createdAt: firstConfig.createdAt, leadSessionId: firstConfig.leadSessionId,
    }))
    const oldScope = consumers.memberConsumerScope({
      team: firstConfig, generation: first.generation, ownerSessionId: 'old-lead',
      backend: 'in-process', agentName: 'worker', memberInstanceId: 'old-instance',
    })
    // Two messages that a name-only identity would confuse: the same legacy
    // tuple twice, and the same envelope id twice with different text.
    await writeInbox(name, [
      { from: 'team-lead', text: 'same legacy tuple', timestamp: '2026-01-01T00:00:00.000Z', read: false },
      { from: 'team-lead', text: 'same legacy tuple', timestamp: '2026-01-01T00:00:00.000Z', read: false },
      { from: 'team-lead', text: 'duplicate id one', timestamp: '2026-01-01T00:00:01.000Z', id: 'dup-1', read: false },
      { from: 'team-lead', text: 'duplicate id two', timestamp: '2026-01-01T00:00:02.000Z', id: 'dup-1', read: false },
    ])
    const oldBatch = await consumers.readScopedMailbox(oldScope)
    expect(oldBatch.status).toBe('current')
    if (oldBatch.status !== 'current') throw new Error('Expected the old inbox to be current')
    expect(oldBatch.value).toHaveLength(4)

    await cleanupTeamDirectories(name, first)
    const secondConfig = {
      ...firstConfig,
      createdAt: 200,
      leadSessionId: 'new-lead',
      members: [{
        ...firstConfig.members[0]!,
        consumerInstanceId: 'new-instance',
        sessionId: 'new-session',
      }],
    }
    await writeTeamFileAsync(name, secondConfig)
    const second = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, {
      teamName: name, createdAt: secondConfig.createdAt, leadSessionId: secondConfig.leadSessionId,
    }))
    expect(second.generation).toBe(first.generation + 1)
    await writeInbox(name, [
      { from: 'team-lead', text: 'same legacy tuple', timestamp: '2026-01-01T00:00:00.000Z', read: false },
      { from: 'team-lead', text: 'same legacy tuple', timestamp: '2026-01-01T00:00:00.000Z', read: false },
      { from: 'team-lead', text: 'duplicate id one', timestamp: '2026-01-01T00:00:01.000Z', id: 'dup-1', read: false },
      { from: 'team-lead', text: 'duplicate id two', timestamp: '2026-01-01T00:00:02.000Z', id: 'dup-1', read: false },
      { from: 'team-lead', text: 'new only', timestamp: '2026-01-01T00:00:03.000Z', id: 'new-1', read: false },
    ])
    const livePath = getInboxPath('worker', name)
    const historyPath = getInboxHistoryPath(livePath)
    const liveBefore = await readFile(livePath, 'utf8')

    await expect(consumers.readScopedMailbox(oldScope)).resolves.toEqual({ status: 'stale' })
    await expect(consumers.claimScopedMailbox(oldScope, oldBatch.value)).resolves.toEqual({ status: 'stale' })
    await expect(consumers.markScopedMailboxRead(oldScope, oldBatch.value)).resolves.toEqual({ status: 'stale' })
    expect(await readFile(livePath, 'utf8')).toBe(liveBefore)
    expect(await readFile(historyPath, 'utf8').catch(() => null)).toBeNull()

    const newScope = consumers.memberConsumerScope({
      team: secondConfig, generation: second.generation, ownerSessionId: 'new-session',
      backend: 'in-process', agentName: 'worker', memberInstanceId: 'new-instance',
    })
    const newBatch = await consumers.readScopedMailbox(newScope)
    expect(newBatch.status).toBe('current')
    if (newBatch.status !== 'current') throw new Error('Expected the new inbox to be current')
    expect(newBatch.value).toHaveLength(5)
    const claimed = await consumers.claimScopedMailbox(newScope, newBatch.value)
    expect(claimed.status).toBe('claimed')
    if (claimed.status !== 'claimed') throw new Error('Expected the new instance to claim its inbox')
    expect(claimed.messages.map(message => message.text)).toEqual([
      'same legacy tuple', 'same legacy tuple', 'duplicate id one', 'duplicate id two', 'new only',
    ])
    expect(JSON.parse(await readFile(livePath, 'utf8'))).toEqual([])
    const history = (await readFile(historyPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(history.map(message => message.text)).toEqual([
      'same legacy tuple', 'same legacy tuple', 'duplicate id one', 'duplicate id two', 'new only',
    ])
    expect(history.every(message => message.read === true)).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('a consumer that commits first keeps its claim while the replacement waits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'consumer-ordering-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const name = 'ordering'
    const config = {
      name,
      createdAt: 300,
      leadSessionId: 'lead',
      leadAgentId: `team-lead@${name}`,
      members: [{
        name: 'worker', agentId: `worker@${name}`, consumerInstanceId: 'instance',
        backendType: 'in-process' as const, joinedAt: 300, cwd: home,
        tmuxPaneId: 'in-process', subscriptions: [],
      }],
    }
    await writeTeamFileAsync(name, config)
    const list = getCanonicalTeamTaskListId(name)
    const lifecycle = await withTaskListLifecycleLock(list, () => beginTaskListLifecycle(list, {
      teamName: name, createdAt: config.createdAt, leadSessionId: config.leadSessionId,
    }))
    const scope = consumers.memberConsumerScope({
      team: config, generation: lifecycle.generation, ownerSessionId: 'lead',
      backend: 'in-process', agentName: 'worker', memberInstanceId: 'instance',
    })
    await writeInbox(name, [
      { from: 'team-lead', text: 'first batch', timestamp: '2026-01-01T00:00:00.000Z', id: 'first-batch', read: false },
    ])
    const batch = await consumers.readScopedMailbox(scope)
    expect(batch.status).toBe('current')
    if (batch.status !== 'current') throw new Error('Expected the inbox to be current')

    // 在 lifecycle → config 锁内暂停旧实例提交，再明确观察替换请求锁。
    let entered!: () => void
    const inCommit = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commit = consumers.withConsumerScope(scope, async (_current, team) => {
      entered()
      await gate
      return claimMailboxMessages('worker', team.name, batch.value)
    })
    await inCommit
    let attempted!: () => void
    const lockAttempt = new Promise<void>(resolve => { attempted = resolve })
    const originalLock = lockfile.lock
    const observeLock = spyOn(lockfile, 'lock').mockImplementation(async (...args) => {
      if (String(args[0]) === getTeamFilePath(name)) attempted()
      return originalLock(...args)
    })
    let replaced = false
    let replacement: Promise<unknown> | undefined
    try {
      replacement = mutateTeamFileAsync(name, team => {
        team.members[0]!.consumerInstanceId = 'replacement'
        team.members[0]!.sessionId = 'replacement-session'
      }).then(() => { replaced = true })
      void replacement.catch(() => {})
      await lockAttempt
      expect(replaced).toBe(false)
      release()
      const committed = await commit
      expect(committed.status).toBe('current')
      if (committed.status !== 'current') throw new Error('Expected the old commit to be current')
      expect(committed.value?.map(message => message.id)).toEqual(['first-batch'])
      await replacement
      expect(replaced).toBe(true)
      expect(readTeamFile(name)!.members[0]!.consumerInstanceId).toBe('replacement')
    } finally {
      release()
      await Promise.allSettled([commit, ...(replacement ? [replacement] : [])])
      observeLock.mockRestore()
    }

    // 替换先完成时，旧消费者不能对新实例产生任何邮箱写入。
    await writeInbox(name, batch.value)
    const livePath = getInboxPath('worker', name)
    const historyPath = getInboxHistoryPath(livePath)
    const liveBefore = await readFile(livePath, 'utf8')
    const historyBefore = await readFile(historyPath, 'utf8')
    await expect(consumers.readScopedMailbox(scope)).resolves.toEqual({ status: 'stale' })
    await expect(consumers.claimScopedMailbox(scope, batch.value)).resolves.toEqual({ status: 'stale' })
    await expect(consumers.markScopedMailboxRead(scope, batch.value)).resolves.toEqual({ status: 'stale' })
    expect(await readFile(livePath, 'utf8')).toBe(liveBefore)
    expect(await readFile(historyPath, 'utf8')).toBe(historyBefore)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('validated scope round trips preserve future fields without changing identity', () => {
  const raw = { ...scope, futureRoot: { keep: true }, recipient: { kind: 'lead', futureRecipient: 'keep' } }
  const parsed = consumers.parseConsumerScope(JSON.stringify(raw))
  expect(parsed.status).toBe('bound')
  if (parsed.status !== 'bound') throw new Error('Expected bound fixture')
  expect(JSON.parse(JSON.stringify(parsed.scope))).toEqual(raw)
  expect(consumers.sameConsumerScope(parsed.scope, scope)).toBe(true)
  expect(consumers.parseConsumerScope({ ...raw, version: 2 })).toEqual({ status: 'unsupported' })
})

test('identity key cannot collide when fields contain delimiters', () => {
  const left = { ...scope, leadSessionId: 'a|b', ownerSessionId: 'c' }
  const right = { ...scope, leadSessionId: 'a', ownerSessionId: 'b|c' }
  expect(consumerScopeKey(left)).not.toBe(consumerScopeKey(right))
  expect(sameConsumerScope(left, right)).toBe(false)
})

test('identity key ignores object property order, not identity fields', () => {
  const reordered: ConsumerScope = {
    recipient: { kind: 'lead' }, ownerSessionId: 'lead', leadSessionId: 'lead',
    createdAt: 10, generation: 1, teamName: 'fixture', version: 1,
  }
  expect(sameConsumerScope(scope, reordered)).toBe(true)
  expect(sameConsumerScope(scope, { ...scope, generation: 2 })).toBe(false)
})
