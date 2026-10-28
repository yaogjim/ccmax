import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-supervisor-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  process.env.CLAUDE_CLI_PATH = join(import.meta.dir, '__fixtures__', 'team-worker-cli.ts')
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  const runtime = await import('./teamPlanRuntime.js')
  runtime.setTeamRuntimeTimingForTests(null)
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(home, { recursive: true, force: true })
})

test('worker failures are classified as transient only for provider and transport hiccups', async () => {
  const { isTransientWorkerFailure } = await import('./teamPlanRuntime.js')
  for (const text of [
    'API Error: {"type":"error","error":{"type":"stream_truncated","message":"OpenAI Chat upstream stream ended without finish_reason"}}',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'API Error: 502 Bad Gateway',
    'Request timed out',
    'API Error: Connection error.',
    'Repeated 529 Overloaded errors',
    'API Error: 429 Too Many Requests',
  ]) expect(isTransientWorkerFailure(text)).toBe(true)
  for (const text of [
    '',
    'Prompt is too long',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'Credit balance is too low',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad tool"}}',
    'Reached maximum turns',
    'Done: everything reviewed.',
  ]) expect(isTransientWorkerFailure(text)).toBe(false)
})

type Harness = Awaited<ReturnType<typeof startHarness>>

/**
 * A real ConversationService with fixture worker CLIs over a loopback SDK
 * bridge. `respond` decides how each upstream "model" call ends.
 */
async function startHarness(memberNames: string[], options: {
  tasks?: Array<{ id: string; subject: string; ownerId: string; dependencies: string[] }>
  /** Members expected to get their instructions at launch (default: all). */
  instructedAtLaunch?: string[]
  beforeLaunch?: (teamName: string) => void
} = {}) {
  const { conversationService: service } = await import('./conversationService.js')
  const { ProviderService } = await import('./providerService.js')
  const { launchTeamPlanRuntime } = await import('./teamPlanRuntime.js')
  const { writeTeamFileAsync, getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, withTaskListLifecycleLock, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
  const requests: Array<{ resumed: string | null; prompt: string; presetType?: string }> = []
  const replies: string[] = []
  let held: Promise<void> | undefined
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { resumed?: string | null; prompt?: unknown; presetType?: string }
    requests.push({ resumed: body.resumed ?? null, prompt: JSON.stringify(body.prompt ?? ''), presetType: body.presetType })
    await held
    // Scripted failures belong to member work, not the independently queued
    // launch/update notifications sent to the lead. Otherwise scheduling can
    // consume the failure on the lead and leave the intended member successful.
    return new Response(body.presetType === 'leader' ? 'fixture result' : replies.shift() ?? 'fixture result')
  } })
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('bad', { status: 400 })
    },
    websocket: { open(ws) { service.attachSdkConnection(ws.data.id, ws) }, message(ws, msg) { service.handleSdkPayload(ws.data.id, String(msg)) }, close(ws) { service.detachSdkConnection(ws.data.id, ws) } },
  })
  const oldPort = ProviderService.getServerPort()
  ProviderService.setServerPort(bridge.port!)
  const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'local', baseUrl: upstream.url.toString(), apiKey: 'fake', models: { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' } })
  const parentId = `parent-${crypto.randomUUID()}`
  const teamName = `team-${crypto.randomUUID().slice(0, 8)}`
  const createdAt = Date.now()
  await writeTeamFileAsync(teamName, { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: parentId, members: [] } as any)
  const taskListId = getCanonicalTeamTaskListId(teamName)
  await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, { teamName, createdAt, leadSessionId: parentId }))
  // The lead is a fixture process too; it only needs to answer control requests.
  await service.startSession(parentId, home, `ws://127.0.0.1:${bridge.port}/sdk/${parentId}?token=parent`, { providerId: provider.id, model: 'cheap', teamWorker: { parentSessionId: 'external', teamName: 'lead-fixture', memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' } })
  const members = memberNames.map(name => ({ id: name, name, agentType: 'research', prompt: `Work as ${name}`, runtime: { providerId: provider.id, modelId: 'cheap' }, agentSnapshot: { systemPrompt: 'Read only', tools: ['Read'] } }))
  const tasks = options.tasks ?? memberNames.map(name => ({ id: `task-${name}`, subject: `Task for ${name}`, ownerId: name, dependencies: [] }))
  const planId = crypto.randomUUID()
  const plan = { schemaVersion: 1, planId, sessionId: parentId, teamName, incarnationId: createHash('sha256').update(JSON.stringify([teamName, parentId, createdAt])).digest('hex'), revision: 2, state: 'launching', workDir: home, members, tasks, leaderRuntime: members[0]!.runtime, createdAt, updatedAt: createdAt, approvedSnapshot: { revision: 1, members, tasks, leaderRuntime: members[0]!.runtime, approvedAt: Date.now(), requestId: 'approve' } } as any
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
  options.beforeLaunch?.(teamName)
  const { memberIds } = await launchTeamPlanRuntime(plan)
  // The service records the running state the way TeamPlanService does after launch.
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify({ ...plan, state: 'running', revision: 3, launch: { status: 'running', memberIds } }))
  const waitFor = async (condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs
    while (!(await condition()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
    if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
  }
  const instructed = options.instructedAtLaunch ?? memberNames
  await waitFor(() => instructed.every(name => requests.some(request => request.prompt.includes(`Work as ${name}`))), 'initial member turns')
  return {
    service, teamName, parentId, planId, memberIds, requests, replies, waitFor,
    upstreamUrl: upstream.url,
    /** Keeps model replies (and so member turns) pending until released. */
    holdReplies() {
      let release!: () => void
      held = new Promise(resolve => { release = resolve })
      return () => { held = undefined; release() }
    },
    async teamMember(name: string) {
      const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
      return readTeamFile(teamName)?.members.find(member => member.name === name)
    },
    async leadNotifications() {
      const { readMailbox } = await import('../../utils/teammateMailbox.js')
      return (await readMailbox('team-lead', teamName)).map(message => {
        try { return { from: message.from, ...JSON.parse(message.text) } } catch { return { from: message.from, text: message.text } }
      })
    },
    async cleanup() {
      const runtime = await import('./teamPlanRuntime.js')
      await runtime.stopTeamPlanRuntime(planId)
      await service.stopAllSessionsAndWait(1000)
      ProviderService.setServerPort(oldPort)
      bridge.stop(true)
      upstream.stop(true)
    },
  }
}

/**
 * The user sends the lead a message. The lead here is a fixture whose turns
 * would call the fake model too, so what the runtime tells it is recorded
 * instead of delivered.
 */
async function userMessagesLead(h: Harness, toLead: string[] = []) {
  const { noteLeadUserMessage } = await import('./teamPlanRuntime.js')
  const send = h.service.sendMessage.bind(h.service)
  const spy = spyOn(h.service, 'sendMessage').mockImplementation(async (...args: Parameters<typeof send>) => {
    if (args[0] !== h.parentId) return send(...args)
    toLead.push(String(args[1]))
    return true
  })
  try {
    await noteLeadUserMessage(h.parentId)
  } finally {
    spy.mockRestore()
  }
  return toLead
}

async function messageMember(h: Harness, to: string, from: string, text: string, id?: string) {
  const { writeToMailbox } = await import('../../utils/teammateMailbox.js')
  await writeToMailbox(to, {
    ...(id ? { id } : {}),
    from,
    text,
    timestamp: new Date().toISOString(),
  }, h.teamName)
}

test.each(['review initialization', 'member registration', 'runtime stop'] as const)(
  '%s preserves a mutation committed before it acquires the config lock',
  async stage => {
    const helpers = await import('../../utils/swarm/teamHelpers.js')
    const locks = await import('../../utils/lockfile.js')
    const realLock = locks.lock
    const pausedAt = 1_790_000_012_345
    const externalMember = {
      agentId: 'external@fixture', name: 'external', agentType: 'research', joinedAt: 1,
      tmuxPaneId: '', cwd: home, subscriptions: [], sessionId: 'external-session', backendType: 'process' as const,
    }
    let spy: ReturnType<typeof spyOn> | undefined
    let intervened = false
    const installBarrier = (teamName: string, targetAttempt: number) => {
      let attempts = 0
      spy = spyOn(locks, 'lock').mockImplementation(async (file, options) => {
        if (file === join(helpers.getTeamDir(teamName), 'config.json') && !intervened && ++attempts === targetAttempt) {
          // The runtime has reached its config-lock boundary. Commit a separate
          // writer first; an out-of-lock snapshot must not overwrite its fields.
          intervened = true
          await helpers.mutateTeamFileAsync(teamName, team => ({
            ...team, pausedAt, members: [...team.members, externalMember],
          }))
        }
        return realLock(file, options)
      })
    }
    let h: Harness | undefined
    try {
      h = await startHarness(['reader'], {
        tasks: [], instructedAtLaunch: [],
        ...(stage === 'runtime stop' ? {} : {
          beforeLaunch: (teamName: string) => installBarrier(teamName, stage === 'review initialization' ? 1 : 2),
        }),
      })
      if (stage === 'runtime stop') {
        installBarrier(h.teamName, 1)
        const runtime = await import('./teamPlanRuntime.js')
        await runtime.stopTeamPlanRuntime(h.planId)
      }
      const current = helpers.readTeamFile(h.teamName)!
      expect(intervened).toBe(true)
      expect(current.pausedAt).toBe(pausedAt)
      expect(current.members.find(member => member.sessionId === externalMember.sessionId)).toEqual(externalMember)
      expect(current.reviewRequired).toBe(true)
      expect(current.members.find(member => member.name === 'reader')).toMatchObject(
        stage === 'runtime stop'
          ? { sessionId: h.memberIds.reader, isActive: false, terminated: true }
          : { sessionId: h.memberIds.reader, initialStartPending: true },
      )
    } finally {
      spy?.mockRestore()
      await h?.cleanup()
    }
  },
  20_000,
)

test('a lead notification cannot consume a scripted member failure in the harness', async () => {
  const h = await startHarness(['reader'])
  try {
    const failure = 'FIXTURE_ERROR:API Error: 401 synthetic member failure'
    h.replies.push(failure)
    const response = await fetch(h.upstreamUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetType: 'leader', prompt: 'A late lead launch notification' }),
    })
    expect(await response.text()).toBe('fixture result')
    expect(h.replies).toEqual([failure])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test('approved process registration assigns a stable consumer instance and publishes the fixed lead scope', async () => {
  const { conversationService } = await import('./conversationService.js')
  const control = spyOn(conversationService, 'requestControl')
  let h: Harness | undefined
  try {
    h = await startHarness(['reader'])
    const member = await h.teamMember('reader')
    expect(member?.consumerInstanceId).toBeString()
    expect(member?.consumerInstanceId?.length).toBeGreaterThan(0)
    const request = control.mock.calls.find(([id, request]) => id === h!.parentId && request.subtype === 'team_runtime_snapshot')?.[1]
    expect(request?.consumer_scope).toMatchObject({ version: 1, teamName: h.teamName, ownerSessionId: h.parentId, recipient: { kind: 'lead' } })
    const { rehydrateTeamPlanRuntime, forgetTeamPlanRuntimesForTests } = await import('./teamPlanRuntime.js')
    const { readTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    const plan = await readTeamPlan(h.teamName)
    forgetTeamPlanRuntimesForTests()
    expect(await rehydrateTeamPlanRuntime(plan!)).toBe(true)
    expect((await h.teamMember('reader'))?.consumerInstanceId).toBe(member?.consumerInstanceId)
  } finally {
    control.mockRestore()
    await h?.cleanup()
  }
}, 20_000)

test('legacy process restoration requires its durable approved worker session and preserves unknown roster fields', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const helpers = await import('../../utils/swarm/teamHelpers.js')
    const { readTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    runtime.forgetTeamPlanRuntimesForTests()
    const plan = (await readTeamPlan(h.teamName))!
    await helpers.mutateTeamFileAsync(h.teamName, team => ({ ...team, futureTeamField: 'keep', members: team.members.map(({ consumerInstanceId: _legacy, ...member }) => ({ ...member, futureMemberField: { keep: true } })) }))
    expect(await runtime.rehydrateTeamPlanRuntime({ ...plan, launch: { ...plan.launch!, memberIds: { reader: 'not-original-session' } } })).toBe(false)
    expect((await h.teamMember('reader'))?.consumerInstanceId).toBeUndefined()
    expect(await runtime.rehydrateTeamPlanRuntime(plan)).toBe(true)
    const migrated = await h.teamMember('reader')
    expect(migrated?.consumerInstanceId).toBeString()
    expect(migrated?.sessionId).toBe(h.memberIds.reader)
    expect((migrated as any).futureMemberField).toEqual({ keep: true })
    expect((helpers.readTeamFile(h.teamName) as any).futureTeamField).toBe('keep')
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntime(plan)).toBe(true)
    expect((await h.teamMember('reader'))?.consumerInstanceId).toBe(migrated?.consumerInstanceId)
  } finally {
    await h.cleanup()
  }
}, 20_000)

test('sent mailbox batches retain the consumption slot through ACK failures and Stop without resending', async () => {
  const h = await startHarness(['reader'])
  const scoped = await import('../../utils/swarm/consumerScope.js')
  const claim = scoped.claimScopedMailbox
  let ackAttempts = 0
  let allowAck = false
  const ack = spyOn(scoped, 'claimScopedMailbox').mockImplementation(async (scope, messages) => {
    if (messages.some(message => message.id === 'ack-pending-1')) {
      ackAttempts++
      if (!allowAck) return { status: 'retryable_io' }
    }
    return claim(scope, messages)
  })
  try {
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    await messageMember(h, 'reader', 'user', 'first fenced batch', 'ack-pending-1')
    await h.waitFor(() => ackAttempts >= 2, 'repeated ACK only')
    await messageMember(h, 'reader', 'task-list', 'second batch waits', 'ack-pending-2')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const before = ackAttempts
    await h.waitFor(() => ackAttempts > before, 'ACK retry while stopped')
    expect(h.requests.filter(request => request.prompt.includes('ack-pending-1'))).toHaveLength(1)
    expect(h.requests.some(request => request.prompt.includes('ack-pending-2'))).toBe(false)
    expect((await readUnreadMessages('reader', h.teamName)).map(message => message.id)).toContain('ack-pending-1')
    allowAck = true
    await h.waitFor(async () => !(await readUnreadMessages('reader', h.teamName)).some(message => message.id === 'ack-pending-1'), 'safe ACK settles after Stop')
    expect((await readUnreadMessages('reader', h.teamName)).map(message => message.id)).toContain('ack-pending-2')
  } finally {
    ack.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('member replacement after scoped read does not reach the old socket or ACK the replacement inbox', async () => {
  const h = await startHarness(['reader'])
  const helpers = await import('../../utils/swarm/teamHelpers.js')
  const scoped = await import('../../utils/swarm/consumerScope.js')
  const read = scoped.readScopedMailbox
  let replaced = false
  const barrier = spyOn(scoped, 'readScopedMailbox').mockImplementation(async scope => {
    const result = await read(scope)
    if (!replaced && result.status === 'current' && result.value.some(message => message.id === 'same-id')) {
      replaced = true
      await helpers.mutateTeamFileAsync(h.teamName, team => ({ ...team, members: team.members.map(member => member.name === 'reader' ? { ...member, consumerInstanceId: 'replacement-instance', sessionId: 'replacement-session' } : member) }))
    }
    return result
  })
  try {
    const { readUnreadMessages, readMailboxHistory } = await import('../../utils/teammateMailbox.js')
    await messageMember(h, 'reader', 'user', 'must remain unread', 'same-id')
    await h.waitFor(() => replaced, 'member replacement barrier')
    // A second loop proves that the old consumer stops rather than rebinding by name.
    await h.waitFor(() => h.service.getRecentSdkMessages(h.memberIds.reader!).some(message => message.type === 'result'), 'old member initial turn')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.some(request => request.prompt.includes('same-id'))).toBe(false)
    expect((await readUnreadMessages('reader', h.teamName)).map(message => message.id)).toContain('same-id')
    expect((await readMailboxHistory('reader', h.teamName)).filter(message => message.id === 'same-id' && message.read)).toEqual([])
    expect((await h.teamMember('reader'))?.sessionId).toBe('replacement-session')
  } finally {
    barrier.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('delivers the mailbox envelope id into the member prompt', async () => {
  const h = await startHarness(['reader'])
  try {
    const before = h.requests.length
    // Two envelopes written back to back: whether the runtime hands them over
    // as one batch or one at a time, neither correlation id may be dropped.
    await messageMember(h, 'reader', 'user', 'status?', 'client-direct-1')
    await messageMember(h, 'reader', 'task-list', 'ready', 'client-direct-2')
    await h.waitFor(
      () => h.requests.slice(before).some(request => request.prompt.includes('client-direct-2')),
      'delivered direct messages',
    )
    const prompts = h.requests.slice(before).map(request => request.prompt).join('\n')
    expect(prompts).toContain('teammate_id=\\"user\\"')
    expect(prompts).toContain('id=\\"client-direct-1\\"')
    expect(prompts).toContain('id=\\"client-direct-2\\"')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member whose process died restarts from its own transcript when the lead messages it', async () => {
  const h = await startHarness(['reader'])
  try {
    const sessionId = h.memberIds.reader!
    h.replies.push('FIXTURE_CRASH')
    await messageMember(h, 'reader', 'team-lead', 'Check one more file')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'crash to be recorded')
    expect(h.service.hasSession(sessionId)).toBe(false)
    // Roster persistence precedes the asynchronous mailbox notification. Wait
    // for that separate boundary instead of treating terminated as delivery.
    await h.waitFor(
      async () => (await h.leadNotifications()).some(item => item.type === 'idle_notification' && item.idleReason === 'failed'),
      'crash notification to be delivered',
    )
    const crashNotice = (await h.leadNotifications()).find(item => item.type === 'idle_notification' && item.idleReason === 'failed')
    expect(crashNotice?.failureReason).toContain('restarts it from its saved conversation')

    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Please continue')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.resumed).toBe(sessionId)
    expect(h.requests.at(-1)?.prompt).toContain('Please continue')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === false, 'restart to be recorded')
    expect(h.service.hasSession(sessionId)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('transient turn failures are continued automatically and only exhausted retries reach the lead', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40, 40] })
  const h = await startHarness(['reader'])
  try {
    const truncated = 'FIXTURE_ERROR:API Error: {"type":"error","error":{"type":"stream_truncated","message":"OpenAI Chat upstream stream ended without finish_reason"}}'
    h.replies.push(truncated, truncated, truncated)
    const before = h.requests.length
    const continuations = () => h.requests.slice(before).filter(request => request.prompt.includes('[Team runtime notice]'))
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    // Wait on the continuation notices themselves: a lead notice may still land
    // after the member's first turn, so request counts are not a stable index.
    await h.waitFor(() => continuations().length === 2, 'two automatic continuations')
    expect(continuations()).toHaveLength(2)
    expect(h.requests.length).toBeGreaterThanOrEqual(before + 3)
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.idleReason === 'failed'), 'exhaustion notice')
    const failures = (await h.leadNotifications()).filter(item => item.idleReason === 'failed')
    expect(failures).toHaveLength(1)
    expect(failures[0].failureReason).toContain('automatic retries exhausted')
    // The member stayed alive throughout: a message still reaches it directly.
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a successful turn reports its result to the lead and resets the retry budget', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40] })
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: 502 Bad Gateway', 'Found 3 issues in runner.ts')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.result === 'Found 3 issues in runner.ts'), 'result notification')
    // The member's own turns only: a lead notice can land at any time.
    const memberTurns = () => h.requests.slice(before).filter(request => request.prompt.includes('Review the runner') || request.prompt.includes('[Team runtime notice]'))
    expect(memberTurns()).toHaveLength(2)
    expect((await h.leadNotifications()).filter(item => item.idleReason === 'failed')).toHaveLength(0)
    const entry = await h.teamMember('reader') as any
    expect(entry.lastError).toBeUndefined()
    expect(entry.autoRetry).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a message to a failed member clears its failure as soon as the member starts on it', async () => {
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(async () => (await h.teamMember('reader') as any)?.lastError !== undefined, 'failure to be recorded')
    const release = h.holdReplies()
    try {
      await messageMember(h, 'reader', 'user', 'The key is fixed, please retry')
      await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === true, 'recovery turn to start')
      const entry = await h.teamMember('reader') as any
      expect(entry.lastError).toBeUndefined()
      expect(entry.autoRetry).toBeUndefined()
    } finally {
      release()
    }
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'recovery turn to finish')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an automatic continuation that cannot be sent reports the failure instead of a stale countdown', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40, 40] })
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: {"type":"error","error":{"type":"stream_truncated","message":"upstream stream ended without finish_reason"}}')
    const send = h.service.sendScopedMessage.bind(h.service)
    const spy = spyOn(h.service, 'sendScopedMessage').mockImplementation(async (...args: Parameters<typeof send>) =>
      String(args[1]).includes('[Team runtime notice]') ? { status: 'rejected', reason: 'transport' } : send(...args))
    try {
      await messageMember(h, 'reader', 'team-lead', 'Review the runner')
      await h.waitFor(async () => (await h.leadNotifications()).some(item => item.idleReason === 'failed'), 'failure notice')
    } finally {
      spy.mockRestore()
    }
    const entry = await h.teamMember('reader') as any
    expect(entry.autoRetry).toBeUndefined()
    expect(entry.lastError).toContain('stream_truncated')
    expect(entry.isActive).toBe(false)
    const failure = (await h.leadNotifications()).find(item => item.idleReason === 'failed')
    expect(failure.failureReason).toContain('could not continue automatically')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("the user's Stop pauses the team instead of ending it, and only an instruction resumes members", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { isTeamPlanRuntimeActive } = await import('./teamPlanRuntime.js')
    const { getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    const reportsBeforeStop = await h.leadNotifications()
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)
    expect(isTeamPlanRuntimeActive(h.planId)).toBe(true)
    expect(JSON.parse(await readFile(join(getTeamDir(h.teamName), 'plan.json'), 'utf8')).state).toBe('running')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true && (await h.teamMember('writer'))?.terminated === true, 'members recorded as stopped')
    // Nothing new reaches the lead's mailbox: a delivered notice would start a
    // lead turn right after the user stopped everything.
    expect(await h.leadNotifications()).toEqual(reportsBeforeStop)

    const before = h.requests.length
    await messageMember(h, 'writer', 'reader', 'peer note sent before the user stopped')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.requests.length).toBe(before)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)

    // A lead message the user did not ask for (one the lead was sending as the
    // user pressed Stop, or a turn it started on its own) must not undo the Stop.
    await messageMember(h, 'writer', 'team-lead', 'Lead message from before the user spoke again')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.requests.length).toBe(before)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)

    await userMessagesLead(h)
    await messageMember(h, 'writer', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.requests.length > before, 'resumed member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.writer)
    expect(h.requests.at(-1)?.prompt).toContain('peer note sent before the user stopped')
    expect(h.requests.at(-1)?.prompt).toContain('The user wants you to continue')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("a user's direct message resumes a stopped member without waiting for the lead", async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const before = h.requests.length
    await messageMember(h, 'reader', 'user', 'Keep going on your own')
    await h.waitFor(() => h.requests.length > before, 'resumed member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
    expect(h.requests.at(-1)?.prompt).toContain('Keep going on your own')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a Stop while a member is restarting leaves that member stopped', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    const sessionId = h.memberIds.reader!
    await h.service.stopSessionAndWait(sessionId)
    const start = h.service.startSession.bind(h.service)
    let stopped = false
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof start>) => {
      // The user presses Stop after the restart began but before its process
      // exists, so Stop's kill pass cannot see it.
      if (args[0] === sessionId && !stopped) {
        stopped = true
        h.service.sendInterrupt(h.parentId)
      }
      return start(...args)
    })
    try {
      await messageMember(h, 'reader', 'team-lead', 'Check one more file')
      await h.waitFor(() => stopped, 'restart to begin')
      await h.service.waitForTeamWorkersStopped(h.parentId)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(h.service.hasSession(sessionId)).toBe(false)
      expect((await h.teamMember('reader'))?.terminated).toBe(true)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("after a Stop, the lead's next message tells it which members stopped and how to resume them", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    // Without a Stop or a failure there is nothing to tell.
    expect(await userMessagesLead(h)).toEqual([])

    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const notices = await userMessagesLead(h)
    await userMessagesLead(h, notices)

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("[Team runtime notice] The user's Stop also stopped your team")
    expect(notices[0]).toMatch(/- reader: #\d+ Task for reader \(pending\)/)
    expect(notices[0]).toMatch(/- writer: #\d+ Task for writer \(pending\)/)
    expect(notices[0]).toContain('SendMessage each member that still has work')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("after any failure, the user's next message tells the lead which members to wake, once per failure", async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40] })
  const h = await startHarness(['billing', 'network', 'crash', 'healthy'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 4, 'initial turn reports')
    const notices: string[] = []
    const failureCount = async () => (await h.leadNotifications()).filter(item => item.idleReason === 'failed').length
    // Model calls are answered in arrival order, so members fail one at a
    // time: billing is final, a dropped connection exhausts its one retry,
    // and a crash ends the process.
    for (const [name, replies] of [
      ['billing', ['FIXTURE_ERROR:Credit balance is too low']],
      ['network', ['FIXTURE_ERROR:API Error: Connection error.', 'FIXTURE_ERROR:API Error: Connection error.']],
      ['crash', ['FIXTURE_CRASH']],
    ] as const) {
      const count = await failureCount()
      h.replies.push(...replies)
      await messageMember(h, name, 'team-lead', 'Keep working')
      await h.waitFor(async () => await failureCount() > count, `${name} failure`)
    }

    // No Stop happened, yet the user's next message names every member
    // that stopped on an error.
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(1)
    const notice = notices[0]!
    expect(notice).toContain('[Team runtime notice]')
    expect(notice).toMatch(/- billing \(stopped on an error: Credit balance is too low\): #\d+ Task for billing \(pending\)/)
    expect(notice).toMatch(/- network \(stopped on an error: [^)]*Connection error[^\n]*\): #\d+ Task for network/)
    expect(notice).toMatch(/- crash \(stopped on an error: [^\n]*exited[^\n]*\): #\d+ Task for crash/)
    expect(notice).not.toContain('healthy')
    expect(notice).toContain('SendMessage each member that still has work')

    // Each failure is announced once.
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(1)

    // The lead wakes a member: it continues in its own conversation.
    const before = h.requests.length
    await messageMember(h, 'billing', 'team-lead', 'Billing is fixed, continue')
    await h.waitFor(() => h.requests.length > before, 'woken member turn')
    expect(h.requests.at(-1)?.prompt).toContain('Billing is fixed, continue')
    await h.waitFor(async () => (await h.teamMember('billing'))?.isActive === false, 'woken turn to finish')

    // A new failure is announced again, alone.
    const count = await failureCount()
    h.replies.push('FIXTURE_ERROR:Credit balance is too low')
    await messageMember(h, 'billing', 'team-lead', 'One more thing')
    await h.waitFor(async () => await failureCount() > count, 'second billing failure')
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain('- billing (stopped on an error')
    expect(notices[1]).not.toContain('- network')
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('stopping and resuming the team repeatedly is never mistaken for a crash loop', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    // More Stop/resume cycles than the crash-loop guard allows restarts.
    for (let cycle = 1; cycle <= 4; cycle++) {
      h.service.sendInterrupt(h.parentId)
      await h.service.waitForTeamWorkersStopped(h.parentId)
      await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, `stop ${cycle} to be recorded`)
      const before = h.requests.length
      await userMessagesLead(h)
      await messageMember(h, 'reader', 'team-lead', `Continue after stop ${cycle}`)
      await h.waitFor(() => h.requests.length > before, `resume ${cycle}`)
      expect(h.requests.at(-1)?.prompt).toContain(`Continue after stop ${cycle}`)
      await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === false, `resume ${cycle} to be recorded`)
    }
    expect((await h.leadNotifications()).filter(item => item.idleReason === 'failed')).toEqual([])
    expect((await h.teamMember('reader') as any).lastError).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('replacing the lead process keeps members working and restores the roster on the next lead start', async () => {
  const h = await startHarness(['reader'])
  try {
    const control = spyOn(h.service, 'requestControl')
    h.service.stopSession(h.parentId, { keepTeamWorkers: true })
    expect(h.service.hasSession(h.parentId)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
    const { ProviderService } = await import('./providerService.js')
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=parent-2`, { teamWorker: { parentSessionId: 'external', teamName: 'lead-fixture', memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' } })
    await h.waitFor(() => control.mock.calls.some(([sessionId, request]) => sessionId === h.parentId && (request as { subtype?: string }).subtype === 'team_runtime_snapshot'), 'team snapshot after lead restart')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Still there?')
    await h.waitFor(() => h.requests.length > before, 'member turn after lead restart')
    expect(h.requests.at(-1)?.resumed).toBeNull()
    control.mockRestore()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a team whose owner was lost is rehydrated dormant and its members restart on demand', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    // Simulate a server restart: the processes and the in-memory owner are gone.
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(true)
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'dormant member state')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Resume after restart')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('after a server restart the next lead start re-owns the team and restores its roster', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { ProviderService } = await import('./providerService.js')
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    h.service.stopSession(h.parentId, { keepTeamWorkers: true })
    runtime.forgetTeamPlanRuntimesForTests()
    const control = spyOn(h.service, 'requestControl')
    // A real lead is an ordinary session, never a team worker.
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=parent-3`, {})
    await h.waitFor(() => runtime.isTeamPlanRuntimeActive(h.planId), 're-owned team', 20_000)
    await h.waitFor(() => control.mock.calls.some(([sessionId, request]) => sessionId === h.parentId && (request as { subtype?: string }).subtype === 'team_runtime_snapshot'), 'restored roster')
    control.mockRestore()
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Pick up where you left off')
    await h.waitFor(() => h.requests.length > before, 'member restarted after server restart')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('ending a lead (/clear or deletion) stops its team and removes only its reviewed team', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { getTeamDir, writeTeamFileAsync, readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    // Another session's team and an unreviewed (CLI) team of the same lead stay.
    await writeTeamFileAsync('other-team', { name: 'other-team', createdAt: 1, leadAgentId: 'team-lead@other-team', leadSessionId: 'someone-else', reviewRequired: true, members: [] })
    const { mutateTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    await mutateTeamFileAsync(h.teamName, team => ({ ...team, reviewRequired: true }))
    await runtime.endTeamsForParent(h.parentId)
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(readTeamFile(h.teamName)).toBeNull()
    await expect(readFile(join(getTeamDir(h.teamName), 'plan.json'), 'utf8')).rejects.toThrow()
    expect(readTeamFile('other-team')?.name).toBe('other-team')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a newly unblocked task wakes its idle owner once', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  const h = await startHarness(['reader'])
  try {
    const { createTask, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    const blocker = await createTask(taskListId, { subject: 'Blocker', description: '', status: 'in_progress', blocks: [], blockedBy: [] })
    const follow = await createTask(taskListId, { subject: 'Follow-up review', description: '', status: 'pending', owner: 'reader', blocks: [], blockedBy: [blocker] })
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'member idle')
    const before = h.requests.length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(h.requests.length).toBe(before)
    await updateTask(taskListId, blocker, { status: 'completed' })
    await h.waitFor(() => h.requests.length > before, 'wake for the ready task')
    expect(h.requests.at(-1)?.prompt).toContain(`Task #${follow}`)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes(`Task #${follow}`))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

/** recon maps the release; analyst reviews it once the map exists. */
async function startDependentTeam() {
  const h = await startHarness(['recon', 'analyst'], {
    tasks: [
      { id: 'map', subject: 'Map the release', ownerId: 'recon', dependencies: [] },
      { id: 'review', subject: 'Review the release', ownerId: 'analyst', dependencies: ['map'] },
    ],
    instructedAtLaunch: ['recon'],
  })
  const { listTasks, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
  const taskListId = getCanonicalTeamTaskListId(h.teamName)
  const tasks = await listTasks(taskListId)
  return {
    ...h,
    taskListId,
    map: tasks.find(task => task.subject === 'Map the release')!.id,
    review: tasks.find(task => task.subject === 'Review the release')!.id,
    analystBriefs: () => h.requests.filter(request => request.prompt.includes('Work as analyst')),
  }
}

test('a member whose tasks all wait on other tasks gets its instructions only once one is ready', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  // A redundant "task is ready" wake after the instructions would come at once.
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.analystBriefs()).toHaveLength(0)
    // An approved dependency wait costs no process: only its ready task starts it.
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
    expect(h.analystBriefs()[0]!.prompt).toContain(`#${h.review} Review the release`)
    // recon completed without sending anything: the analyst is told, so it
    // asks instead of working without the result it depends on.
    expect(h.analystBriefs()[0]!.prompt).toContain('Nothing has reached you from recon yet')
    expect(h.analystBriefs()[0]!.resumed).toBeNull()
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions recorded as delivered')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes(`#${h.review}`))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("only the user's own message starts a waiting member early; the lead's waits and arrives with its instructions", async () => {
  const h = await startDependentTeam()
  try {
    // A lead relays results as they come in; that must not start the member.
    await messageMember(h, 'analyst', 'team-lead', 'Forwarded: the inventory so far')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.analystBriefs()).toHaveLength(0)
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })

    await messageMember(h, 'analyst', 'user', 'Start now, on my word')
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions with the user message')
    expect(h.analystBriefs()[0]!.prompt).toContain('Start now, on my word')
    expect(h.analystBriefs()[0]!.prompt).toContain('Forwarded: the inventory so far')
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions recorded as delivered')

    await messageMember(h, 'analyst', 'team-lead', 'One more thing')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('One more thing')), 'second message')
    expect(h.analystBriefs()).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a shutdown request reaches a member that has not started yet, without its instructions', async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    const { createShutdownRequestMessage } = await import('../../utils/teammateMailbox.js')
    await messageMember(h, 'analyst', 'team-lead', JSON.stringify(createShutdownRequestMessage({ requestId: 'shutdown-1', from: 'team-lead' })))
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('shutdown-1')), 'shutdown request delivered')
    expect(h.analystBriefs()).toHaveLength(0)
    await h.waitFor(async () => (await h.teamMember('analyst'))?.isActive === false, 'member idle again')
    expect((await h.teamMember('analyst'))?.awaitingDependencies).toBe(true)

    // Declined or ignored, it still starts properly once its task is ready.
    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('after a Stop, a member that has not started yet starts once the team runs again and its task is ready', async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'recon report')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const notices = await userMessagesLead(h)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/- recon: #\d+ Map the release \(pending\)/)
    expect(notices[0]).toContain(`- analyst: not started yet; it starts by itself once #${h.map} is completed, and messages to it wait until then`)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 700))
    // A finished dependency does not undo the user's Stop.
    expect(h.analystBriefs()).toHaveLength(0)

    // The lead's instruction resumes the team even when it goes to the member
    // that has not started; that member then starts because its task is ready.
    await messageMember(h, 'analyst', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.analystBriefs().length > 0, 'analyst starts once the team runs again')
    expect(h.analystBriefs()[0]!.prompt).toContain('The user wants you to continue')
    // It never had a turn, so its own session starts afresh rather than resuming.
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member still waiting after a server restart gets its approved instructions once a task is ready', async () => {
  const h = await startDependentTeam()
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { updateTask } = await import('../../utils/tasks.js')
    await h.service.stopSessionAndWait(h.memberIds.recon!)
    await h.service.stopSessionAndWait(h.memberIds.analyst!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.analystBriefs()).toHaveLength(0)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions after the restart')
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
    // The rebuilt instructions carry the live task ids.
    expect(h.analystBriefs()[0]!.prompt).toContain(`\\"id\\":\\"${h.review}\\"`)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('members written before deferred instructions rehydrate as already instructed', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    // An older team file never carries awaitingDependencies.
    expect(await h.teamMember('reader')).not.toHaveProperty('awaitingDependencies')
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    const before = h.requests.length
    const resumedTurns = () => h.requests.slice(before).filter(request => (
      request.presetType === 'reader' && request.resumed === h.memberIds.reader
    ))
    await messageMember(h, 'reader', 'team-lead', 'Resume after restart')
    await h.waitFor(() => resumedTurns().length > 0, 'restarted member turn')
    expect(resumedTurns()[0]!.prompt).toContain('Resume after restart')
    expect(resumedTurns()[0]!.prompt).not.toContain('Work as reader')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("a teammate's note does not start a waiting member and arrives with its instructions", async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    // recon hands its result over before it closes the task.
    await messageMember(h, 'analyst', 'recon', 'Release map: three feature groups')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.analystBriefs()).toHaveLength(0)
    expect(await readUnreadMessages('analyst', h.teamName)).toHaveLength(1)
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
    expect(h.analystBriefs()[0]!.prompt).toContain('Release map: three feature groups')
    expect(h.analystBriefs()[0]!.prompt).toContain(`#${h.review} Review the release`)
    // The result it depends on is in hand, so nothing is reported missing.
    expect(h.analystBriefs()[0]!.prompt).not.toContain('Nothing has reached you')
    await h.waitFor(async () => (await readUnreadMessages('analyst', h.teamName)).length === 0, 'note marked as read')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes('Release map: three feature groups'))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('the release-review plan that started its second layer first now runs layer by layer', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  // The approved plan of the reported run: one inventory, three analyses that
  // depend on it, a verification of all three, and a report by one analyst.
  const names = ['recon', 'perf-analyst', 'sec-analyst', 'ux-analyst', 'verifier']
  const h = await startHarness(names, {
    tasks: [
      { id: 't1', subject: 'Inventory', ownerId: 'recon', dependencies: [] },
      { id: 't2', subject: 'Performance', ownerId: 'perf-analyst', dependencies: ['t1'] },
      { id: 't3', subject: 'Security', ownerId: 'sec-analyst', dependencies: ['t1'] },
      { id: 't4', subject: 'Interaction', ownerId: 'ux-analyst', dependencies: ['t1'] },
      { id: 't5', subject: 'Verification', ownerId: 'verifier', dependencies: ['t2', 't3', 't4'] },
      { id: 't6', subject: 'Report', ownerId: 'perf-analyst', dependencies: ['t2', 't3', 't4', 't5'] },
    ],
    instructedAtLaunch: ['recon'],
  })
  try {
    const { listTasks, getTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const { applyTaskDeliveryAction } = await import('../../utils/taskDelivery.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    const id = Object.fromEntries((await listTasks(taskListId)).map(task => [task.subject, task.id]))
    const deliver = async (subject: string, version = 1) => {
      const task = (await getTask(taskListId, id[subject]!))!
      return applyTaskDeliveryAction(h.teamName, task.id, task.owner!, {
        action: 'submit', version, requestId: `submit-${subject}-${version}`,
        expectedRevision: task.delivery?.revision ?? 0,
        artifact: `${subject} artifact v${version}`, criteria: 'Synthetic verification passed',
      })
    }
    const complete = async (subject: string) => {
      const task = (await getTask(taskListId, id[subject]!))!
      if (!task.delivery?.submissions.length) await deliver(subject)
      const submitted = (await getTask(taskListId, task.id))!
      return applyTaskDeliveryAction(h.teamName, task.id, 'user', {
        action: 'accept', version: submitted.delivery!.submissions.at(-1)!.version,
        requestId: `accept-${subject}`, expectedRevision: submitted.delivery!.revision,
      })
    }
    const briefs = (name: string) => h.requests.filter(request => request.prompt.includes(`Work as ${name}`))
    const instructed = () => names.filter(name => briefs(name).length > 0)
    const settle = () => new Promise(resolve => setTimeout(resolve, 600))

    await settle()
    expect(instructed()).toEqual(['recon'])
    // Each member is told who waits on its task, and to hand its result over
    // before completing it: the inventory goes to the three analysts.
    expect(briefs('recon')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"perf-analyst\\",\\"sec-analyst\\",\\"ux-analyst\\"]`)
    expect(briefs('recon')[0]!.prompt).toContain('first SendMessage its result to each member listed there, then submit its versioned artifact for independent acceptance')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes(`Approved team ${h.teamName} is running`)), 'launch notice to the lead')
    expect(h.requests.find(request => request.prompt.includes(`Approved team ${h.teamName} is running`))!.prompt)
      .toContain('Every task of perf-analyst, sec-analyst, ux-analyst, verifier waits on other tasks')

    await deliver('Inventory')
    await settle()
    expect(instructed()).toEqual(['recon'])
    await applyTaskDeliveryAction(h.teamName, id.Inventory!, 'user', {
      action: 'return', version: 1, expectedRevision: 1,
      requestId: 'return-inventory', reason: 'Add the missing fixture evidence',
    })
    await settle()
    expect(instructed()).toEqual(['recon'])
    await deliver('Inventory', 2)
    await settle()
    expect(instructed()).toEqual(['recon'])
    await complete('Inventory')
    await h.waitFor(() => instructed().length === 4, 'the three analysts to start')
    await settle()
    expect(instructed()).toEqual(['recon', 'perf-analyst', 'sec-analyst', 'ux-analyst'])

    await complete('Performance')
    await complete('Security')
    await settle()
    expect(briefs('verifier')).toHaveLength(0)
    await complete('Interaction')
    await h.waitFor(() => briefs('verifier').length > 0, 'the verifier to start')
    expect(briefs('verifier')[0]!.prompt).toContain(`#${id.Verification} Verification`)
    // An analyst hands its analysis to the verifier; its own report task is not a hand-off.
    expect(briefs('perf-analyst')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"verifier\\"]`)
    // The verification goes to the analyst who writes the report.
    expect(briefs('verifier')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"perf-analyst\\"]`)

    // The analyst that also owns the report is woken for it, not instructed twice.
    await h.waitFor(async () => (await h.teamMember('perf-analyst'))?.isActive === false, 'perf-analyst idle')
    await complete('Verification')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes(`Task #${id.Report}`)), 'wake for the report')
    await settle()
    for (const name of names) expect(briefs(name)).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('a member that leaves after approving a shutdown request is not reported as a failure', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { createShutdownRequestMessage } = await import('../../utils/teammateMailbox.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    const request = (marker: string) => JSON.stringify(createShutdownRequestMessage({ requestId: `stop-${marker}`, from: 'team-lead', reason: marker }))
    // reader agrees and leaves; writer's process disappears without answering.
    await messageMember(h, 'reader', 'team-lead', request('FIXTURE_APPROVE_SHUTDOWN'))
    await messageMember(h, 'writer', 'team-lead', request('FIXTURE_SHUTDOWN'))
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true && (await h.teamMember('writer'))?.terminated === true, 'both processes gone')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.from === 'writer' && item.idleReason === 'failed'), 'failure notice for the member that vanished')

    // An exit that is not recognised as approved is recorded a moment later,
    // so give that time to happen before asserting it did not.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect((await h.teamMember('reader'))?.lastError).toBeUndefined()
    expect((await h.teamMember('writer'))?.lastError).toContain('exited')
    const notices = await h.leadNotifications()
    expect(notices.some(item => item.from === 'reader' && item.type === 'shutdown_approved')).toBe(true)
    expect(notices.filter(item => item.from === 'reader' && item.idleReason === 'failed')).toEqual([])
    // With the user's next message the lead hears about the failure only.
    const told = await userMessagesLead(h)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('- writer (stopped on an error')
    expect(told[0]).not.toContain('- reader')

    // The approval covers that one exit: a later crash is a failure again.
    const sessionId = h.memberIds.reader!
    await messageMember(h, 'reader', 'team-lead', 'One more check, please')
    await h.waitFor(() => h.service.hasSession(sessionId), 'reader restarted by the message')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'reader idle after the message')
    h.replies.push('FIXTURE_CRASH')
    await messageMember(h, 'reader', 'team-lead', 'And another')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.from === 'reader' && item.idleReason === 'failed'), 'failure notice for the later crash')
    expect((await h.teamMember('reader'))?.lastError).toBeTruthy()
  } finally {
    await h.cleanup()
  }
}, 30_000)

// ── S3.2: approved members stand by until there is work or an instruction ──

test('an approved member with no task gets no process until a ready task starts it for the first time', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const sessionId = h.memberIds.analyst!
    await new Promise(resolve => setTimeout(resolve, 700))
    // Approval without a task must not cost a process or a turn.
    expect(h.service.hasSession(sessionId)).toBe(false)
    expect(h.requests.some(request => request.prompt.includes('Work as analyst'))).toBe(false)
    // The member still has a stable identity, and has not been terminated.
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })
    expect((await h.teamMember('analyst'))?.sessionId).toBe(sessionId)
    expect((await h.teamMember('analyst'))?.terminated).toBeUndefined()

    const { createTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const task = await createTask(getCanonicalTeamTaskListId(h.teamName), { subject: 'Analyse the runner', description: '', status: 'pending', owner: 'analyst', blocks: [], blockedBy: [] })
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Analyse the runner')), 'first start for a ready task')
    const turn = h.requests.find(request => request.prompt.includes('Analyse the runner'))!
    expect(turn.prompt).toContain('Work as analyst')
    expect(turn.prompt).toContain(`#${task}`)
    // A first start begins its own conversation: it is not a restart or a resume.
    expect(turn.resumed).toBeNull()
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions recorded as delivered')
    expect(h.service.hasSession(sessionId)).toBe(true)
    // Now that it runs, "terminated: false" is accurate; it was never true.
    expect((await h.teamMember('analyst'))?.terminated).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test.each(['missing dependency', 'unsupported delivery'])('a standby member cannot first-start for %s', async (problem) => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const { getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    const { mkdir } = await import('node:fs/promises')
    const taskDir = join(home, 'tasks', taskListId)
    await mkdir(taskDir, { recursive: true })
    const taskPath = join(taskDir, '1.json')
    const task = { id: '1', subject: 'Only executable work starts the role', description: '', owner: 'analyst', status: 'pending', blocks: [], blockedBy: problem === 'missing dependency' ? ['404'] : [],
      ...(problem === 'unsupported delivery' ? { delivery: { schemaVersion: 99 } } : {}),
    }
    await writeFile(taskPath, JSON.stringify(task))
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    expect(h.requests.some(request => request.prompt.includes('Work as analyst'))).toBe(false)
    // Positive control: the same supervisor starts the approved role as soon
    // as its task is actually readable and every dependency is satisfied.
    await writeFile(taskPath, JSON.stringify({ ...task, blockedBy: [], delivery: undefined }))
    await h.waitFor(() => h.service.hasSession(h.memberIds.analyst!), 'start after the task becomes executable')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Work as analyst')), 'approved first instructions')
  } finally {
    await h.cleanup()
  }
}, 20_000)

test('an idle started member is woken only by a task whose dependencies are present and completed', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  const h = await startHarness(['reader'])
  try {
    const { createTask, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'member idle')
    const before = h.requests.length
    // A dependency whose task file does not exist is not finished work: the
    // dangling edge keeps the task unready exactly like an unfinished one.
    const dangling = await createTask(taskListId, { subject: 'Waits on a deleted task', description: '', status: 'pending', owner: 'reader', blocks: [], blockedBy: ['404'] })
    const blocker = await createTask(taskListId, { subject: 'Blocker', description: '', status: 'pending', blocks: [], blockedBy: [] })
    const follow = await createTask(taskListId, { subject: 'Waits on a real task', description: '', status: 'pending', owner: 'reader', blocks: [], blockedBy: [blocker] })
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(h.requests.length).toBe(before)

    // Only a dependency that exists and is completed makes the task ready.
    await updateTask(taskListId, blocker, { status: 'completed' })
    await h.waitFor(() => h.requests.length > before, 'wake for the completed dependency')
    expect(h.requests.at(-1)?.prompt).toContain(`Task #${follow}`)
    expect(h.requests.at(-1)?.prompt).not.toContain(`Task #${dangling}`)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes(`Task #${dangling}`))).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an explicit lead instruction still first-starts a standby member with no task', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    // Readiness never starts it; the lead's explicit instruction still does.
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    await messageMember(h, 'analyst', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('The user wants you to continue')), 'first start on the lead instruction')
    expect(h.requests.find(request => request.prompt.includes('The user wants you to continue'))!.prompt).toContain('Work as analyst')
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an explicit instruction first-starts a standby member with its approved instructions', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const sessionId = h.memberIds.analyst!
    await messageMember(h, 'analyst', 'user', 'Please start now')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Please start now')), 'first start on the user instruction')
    const turn = h.requests.find(request => request.prompt.includes('Please start now'))!
    expect(turn.prompt).toContain('Work as analyst')
    expect(turn.resumed).toBeNull()
    expect(h.service.hasSession(sessionId)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member that never started keeps its identity and is not terminated by a restart', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const runtime = await import('./teamPlanRuntime.js')
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 700))
    // Not started is not the same as terminated.
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })
    expect((await h.teamMember('analyst'))?.terminated).toBeUndefined()
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)

    const before = h.requests.length
    await messageMember(h, 'analyst', 'user', 'Start after the restart')
    await h.waitFor(() => h.requests.length > before, 'first start after the restart')
    expect(h.requests.at(-1)?.resumed).toBeNull()
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a first start reads the approved preset, not one edited after approval', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const { getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
    const path = join(getTeamDir(h.teamName), 'plan.json')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...stored,
      members: stored.members.map((member: { id: string }) => ({ ...member, agentSnapshot: { systemPrompt: 'EDITED PRESET' } })),
      agentCatalog: { ...(stored.agentCatalog ?? {}), research: { systemPrompt: 'EDITED PRESET' } },
    }))
    const start = spyOn(h.service, 'startSession')
    try {
      await messageMember(h, 'analyst', 'user', 'Start with what was approved')
      await h.waitFor(() => h.service.hasSession(h.memberIds.analyst!), 'first start')
      const options = start.mock.calls.find(([id]) => id === h.memberIds.analyst)?.[3] as { teamWorker?: { systemPrompt?: string } } | undefined
      expect(options?.teamWorker?.systemPrompt).toBe('Read only')
    } finally {
      start.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a failed first start waits for a newer instruction instead of retrying every supervisor pass', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const real = h.service.startSession.bind(h.service)
    let attempts = 0
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof real>) => {
      if (args[0] === h.memberIds.analyst) {
        attempts += 1
        throw new Error('provider unavailable')
      }
      return real(...args)
    })
    try {
      await messageMember(h, 'analyst', 'user', 'Start now')
      await h.waitFor(() => attempts === 1, 'first start attempt')
      await new Promise(resolve => setTimeout(resolve, 900))
      // No retry storm, and the member is still a standby member, not exited.
      expect(attempts).toBe(1)
      expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
      expect((await h.teamMember('analyst'))?.awaitingDependencies).toBe(true)
      expect((await h.teamMember('analyst'))?.terminated).toBeUndefined()
      expect(((await h.teamMember('analyst')) as { lastError?: string }).lastError).toContain('Start failed')
    } finally {
      spy.mockRestore()
    }
    // A newer instruction is a new attempt.
    await messageMember(h, 'analyst', 'user', 'Try again now')
    await h.waitFor(() => h.service.hasSession(h.memberIds.analyst!), 'first start on the newer message')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a Stop keeps a standby member unstarted for background work and ordinary notices', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    await new Promise(resolve => setTimeout(resolve, 300))
    const { createTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    await createTask(getCanonicalTeamTaskListId(h.teamName), { subject: 'Background follow-up', description: '', status: 'pending', owner: 'analyst', blocks: [], blockedBy: [] })
    // A ready task, a peer note and a task-list notice are not the user continuing.
    await messageMember(h, 'analyst', 'recon', 'A peer note')
    await messageMember(h, 'analyst', 'task-list', 'Task is ready')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    expect(h.requests.some(request => request.prompt.includes('Background follow-up'))).toBe(false)
    expect((await h.teamMember('analyst'))?.terminated).toBeUndefined()

    await messageMember(h, 'analyst', 'user', 'Resume from my instruction')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Resume from my instruction')), 'first start after the user continues')
    const turn = h.requests.find(request => request.prompt.includes('Resume from my instruction'))!
    expect(turn.prompt).toContain('Work as analyst')
    expect(turn.resumed).toBeNull()
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('every user Stop advances the durable stop epoch and nothing else does', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
  const runtime = await import('./teamPlanRuntime.js')
  try {
    expect(readTeamFile(h.teamName)?.stopEpoch).toBeUndefined()
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    await h.waitFor(() => readTeamFile(h.teamName)?.stopEpoch === 1, 'first durable stop epoch')

    // Tearing the runtime down is not another user Stop.
    await runtime.stopTeamPlanRuntime(h.planId)
    expect(readTeamFile(h.teamName)?.stopEpoch).toBe(1)

    // Restarting and continuing keeps the same count: the value counts Stops,
    // not runs, so a pending send from before the Stop stays settled.
    runtime.forgetTeamPlanRuntimesForTests()
    runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)
    await messageMember(h, 'analyst', 'user', 'Continue after the stop')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Continue after the stop')), 'restart after a Stop')
    expect(readTeamFile(h.teamName)?.stopEpoch).toBe(1)

    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    await h.waitFor(() => readTeamFile(h.teamName)?.stopEpoch === 2, 'second durable stop epoch')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a Stop outlives the runtime: the restored team stays paused until a new instruction', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    // The pause must be durable before the process that holds it can vanish.
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    await h.waitFor(() => readTeamFile(h.teamName)?.pausedAt !== undefined, 'durable Stop record')

    const runtime = await import('./teamPlanRuntime.js')
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    expect(await h.service.hasSession(h.memberIds.analyst!)).toBe(false)

    const { createTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    await createTask(getCanonicalTeamTaskListId(h.teamName), { subject: 'Background follow-up', description: '', status: 'pending', owner: 'analyst', blocks: [], blockedBy: [] })
    await messageMember(h, 'analyst', 'task-list', 'Task is ready')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    // Restoring the team is not the user continuing it.
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    expect(h.requests.some(request => request.prompt.includes('Background follow-up'))).toBe(false)

    await messageMember(h, 'analyst', 'user', 'Resume from my instruction')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Resume from my instruction')), 'first start after the user continues')
    // Resuming clears the durable pause, so a later restart does not re-pause it.
    await h.waitFor(() => readTeamFile(h.teamName)?.pausedAt === undefined, 'durable pause cleared on resume')
  } finally {
    await h.cleanup()
  }
}, 30_000)

// ── S3.2 compatibility: initialStartPending is the only "never ran" marker ──

test('a standby member recorded before initialStartPending resumes its saved transcript when its task becomes ready', async () => {
  const h = await startDependentTeam()
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { mutateTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { updateTask } = await import('../../utils/tasks.js')
    runtime.forgetTeamPlanRuntimesForTests()
    // The legacy member had a process, so it has a transcript. Losing it is the
    // failure this test exists for.
    const { mkdir } = await import('node:fs/promises')
    const { sanitizePath } = await import('../../utils/sessionStoragePortable.js')
    const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(home))
    await mkdir(transcriptDir, { recursive: true })
    const sessionId = h.memberIds.analyst!
    const line = {
      type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId,
      cwd: home, teamName: h.teamName, agentName: 'analyst',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier research notes' }] },
    }
    await writeFile(join(transcriptDir, sessionId + '.jsonl'), JSON.stringify(line) + '\n')
    await mutateTeamFileAsync(h.teamName, team => ({
      ...team,
      members: team.members.map(member => member.name === 'analyst'
        ? { ...member, isActive: true, awaitingDependencies: true, initialStartPending: undefined }
        : member),
    }))
    expect(await h.teamMember('analyst')).not.toHaveProperty('initialStartPending')
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
    const turn = h.analystBriefs()[0]!
    // It already had a process and a transcript: resume it, never start over.
    expect(turn.resumed).toBe(h.memberIds.analyst!)
    expect(turn.prompt).toContain(`#${h.review} Review the release`)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an approved member is persisted as initialStartPending until its first start records it', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    // The identity exists now; the first start does not.
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true, initialStartPending: true })
    await messageMember(h, 'analyst', 'user', 'Start now')
    await h.waitFor(async () => (await h.teamMember('analyst'))?.initialStartPending === false, 'first start recorded')
    // The held instructions arrive on the pass after the process is up.
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions delivered')
    const entry = await h.teamMember('analyst')
    expect(entry?.terminated).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a Stop that lands during the first spawn aborts it without recording a failure', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const real = h.service.startSession.bind(h.service)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const spawning = new Promise<void>(resolve => { entered = resolve })
    let attempts = 0
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof real>) => {
      if (args[0] !== h.memberIds.analyst) return real(...args)
      attempts += 1
      if (attempts > 1) return real(...args)
      entered()
      await gate
      // The Stop killed the CLI while it was still spawning.
      throw new Error('CLI session exited during startup')
    })
    try {
      await messageMember(h, 'analyst', 'user', 'Start now')
      await spawning
      h.service.sendInterrupt(h.parentId)
      await h.service.waitForTeamWorkersStopped(h.parentId)
      release()
      await new Promise(resolve => setTimeout(resolve, 500))
      const entry = await h.teamMember('analyst') as { lastError?: string; initialStartPending?: boolean; terminated?: boolean }
      // A Stop is not a failed start: nothing to report, nothing to retry, and
      // the member is still waiting rather than exited.
      expect(entry.lastError).toBeUndefined()
      expect(entry.initialStartPending).toBe(true)
      expect(entry.terminated).toBeUndefined()
      expect(h.requests.some(request => request.prompt.includes('Start now'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    // The user continuing afterwards still first-starts it, with the held brief.
    await messageMember(h, 'analyst', 'user', 'Continue now')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Continue now')), 'first start after the stop')
    expect(h.requests.find(request => request.prompt.includes('Continue now'))!.resumed).toBeNull()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('ending the team during the first spawn stops the reserved member in the same pass', async () => {
  const h = await startHarness(['analyst'], { tasks: [], instructedAtLaunch: [] })
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const real = h.service.startSession.bind(h.service)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const spawned = new Promise<void>(resolve => { entered = resolve })
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof real>) => {
      if (args[0] !== h.memberIds.analyst) return real(...args)
      await real(...args)
      entered()
      await gate
    })
    try {
      await messageMember(h, 'analyst', 'user', 'Start now')
      await spawned
      expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
      await runtime.stopTeamPlanRuntime(h.planId)
      // The process id was reserved before the process existed, so this kill
      // pass owns it instead of leaving it behind a deleted launch.
      expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
      release()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect((await h.teamMember('analyst'))?.initialStartPending).not.toBe(false)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('approved standby dynamic delivery return Stop continue and server recovery form one lifecycle', async () => {
  const h = await startHarness(['builder', 'reviewer'], { tasks: [], instructedAtLaunch: [] })
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { createTask, getCanonicalTeamTaskListId, getTask } = await import('../../utils/tasks.js')
    const { applyTaskDeliveryAction } = await import('../../utils/taskDelivery.js')
    const list = getCanonicalTeamTaskListId(h.teamName)
    expect(h.service.hasSession(h.memberIds.builder!)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reviewer!)).toBe(false)
    const taskId = await createTask(list, { subject: 'Versioned dynamic delivery', description: '', owner: 'builder', status: 'pending', blockedBy: [], blocks: [] })
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Versioned dynamic delivery')), 'dynamic task first launch')
    expect(h.requests.find(request => request.prompt.includes('Versioned dynamic delivery'))?.resumed).toBeNull()
    await h.waitFor(async () => (await h.teamMember('builder'))?.isActive === false, 'owner finishes first turn')
    await applyTaskDeliveryAction(h.teamName, taskId, 'builder', { action: 'submit', expectedRevision: 0, version: 1, requestId: 'submit-v1', artifact: 'dynamic@v1 digest:fixture', criteria: 'Regression and boundary evidence' })
    const pendingCount = h.requests.length
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.requests.length).toBe(pendingCount)
    expect(h.service.hasSession(h.memberIds.reviewer!)).toBe(false)
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    await applyTaskDeliveryAction(h.teamName, taskId, 'user', { action: 'return', expectedRevision: 1, version: 1, requestId: 'return-v1', reason: 'Add boundary regression' })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(h.service.hasSession(h.memberIds.builder!)).toBe(false)
    await messageMember(h, 'builder', 'user', 'Continue rework after Stop')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('Continue rework after Stop') && request.prompt.includes('Add boundary regression')), 'explicit continuation with rework reason')
    await applyTaskDeliveryAction(h.teamName, taskId, 'builder', { action: 'submit', expectedRevision: 2, version: 2, requestId: 'submit-v2', artifact: 'dynamic@v2 digest:fixture-with-boundary', criteria: 'Regression and boundary evidence' })
    runtime.forgetTeamPlanRuntimesForTests()
    await h.service.stopSessionAndWait(h.memberIds.builder!)
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    const beforeAcceptance = h.requests.length
    await applyTaskDeliveryAction(h.teamName, taskId, 'user', { action: 'accept', expectedRevision: 3, version: 2, requestId: 'accept-v2' })
    await new Promise(resolve => setTimeout(resolve, 550))
    expect(h.requests.length).toBe(beforeAcceptance)
    expect((await getTask(list, taskId))?.status).toBe('completed')
    expect((await getTask(list, taskId))?.delivery?.submissions.map(item => item.review?.decision)).toEqual(['return', 'accept'])
    expect((await h.teamMember('reviewer'))?.initialStartPending).toBe(true)
    expect((await h.teamMember('reviewer'))?.terminated).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 30_000)
