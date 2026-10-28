import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Run explicitly with an empty environment and a disposable HOME/config.
// Not a test/gate: exit 0 means the observation completed, NOT product acceptance.
const home = process.env.HOME!
assert(home && home === process.env.CLAUDE_CONFIG_DIR, 'HOME/config must be the same disposable directory')
assert(/^\/(?:private\/)?tmp\/team-stop-probe\.[^/]+(?:\/|$)/.test(resolve(home)), 'Refusing HOME outside a /tmp/team-stop-probe.* sandbox')
const phase = process.argv[2]
const safeEnv = (directory: string): NodeJS.ProcessEnv => ({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: directory,
  CLAUDE_CONFIG_DIR: directory,
  XDG_CONFIG_HOME: join(directory, 'xdg'),
  XDG_CACHE_HOME: join(directory, 'cache'),
  TMPDIR: join(directory, 'tmp'),
  CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
  CLAUDE_CLI_PATH: join(import.meta.dir, 'team-worker-cli.ts'),
  NO_COLOR: '1',
})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

async function host(scenario: string | undefined) {
  // Do this before importing any production module: no inherited provider,
  // shell startup, real HOME, config, credentials, or app-state environment.
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, safeEnv(home))
  const { conversationService: service } = await import('../conversationService.js')
  const { ProviderService } = await import('../providerService.js')
  const runtime = await import('../teamPlanRuntime.js')
  const helpers = await import('../../../utils/swarm/teamHelpers.js')
  const tasks = await import('../../../utils/tasks.js')
  const { migrationMaintenance } = await import('../../migrationMaintenance.js')
  const requests: Array<{ presetType?: string; prompt?: unknown; resumed?: string | null }> = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as typeof requests[number])
    return new Response('fixture result')
  } })
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('bad', { status: 400 })
    },
    websocket: {
      open(ws) { service.attachSdkConnection(ws.data.id, ws) },
      message(ws, message) { service.handleSdkPayload(ws.data.id, String(message)) },
      close(ws) { service.detachSdkConnection(ws.data.id, ws) },
    },
  })
  ProviderService.setServerPort(bridge.port!)
  let cleaning: Promise<void> | undefined
  const cleanup = () => cleaning ??= (async () => {
    await service.stopAllSessionsAndWait(1000)
    await migrationMaintenance.drain()
    assert.equal(service.getActiveSessions().length, 0)
    bridge.stop(true)
    upstream.stop(true)
  })()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void cleanup().finally(() => process.exit(128))
  })
  const startLead = async (parentId: string, teamName: string, providerId: string) => {
    await service.startSession(parentId, home, `ws://127.0.0.1:${bridge.port}/sdk/${parentId}?token=parent`, {
      providerId, model: 'cheap',
      teamWorker: { parentSessionId: 'external', teamName, memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' },
    })
  }
  const waitFor = async (condition: () => boolean, label: string, timeout = 8000) => {
    const end = Date.now() + timeout
    while (!condition() && Date.now() < end) await delay(20)
    assert(condition(), `Timed out: ${label}`)
  }
  let result: Record<string, unknown>
  try {
    const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'loopback-only', baseUrl: upstream.url.toString(), apiKey: 'fake', models: { main: 'cheap', sonnet: 'cheap', opus: 'cheap', haiku: 'cheap' } })
    if (phase === 'stop') {
      const parentId = `parent-${crypto.randomUUID()}`
      const teamName = `stop-probe-${crypto.randomUUID().slice(0, 8)}`
      const createdAt = Date.now()
      await helpers.writeTeamFileAsync(teamName, { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: parentId, members: [] } as any)
      const taskListId = tasks.getCanonicalTeamTaskListId(teamName)
      await tasks.withTaskListLifecycleLock(taskListId, () => tasks.beginTaskListLifecycle(taskListId, { teamName, createdAt, leadSessionId: parentId }))
      await startLead(parentId, 'lead-fixture', provider.id)
      const members = [{ id: 'analyst', name: 'analyst', agentType: 'research', prompt: 'Work as analyst', runtime: { providerId: provider.id, modelId: 'cheap' }, agentSnapshot: { systemPrompt: 'Read only', tools: ['Read'] } }]
      const plan = { schemaVersion: 1, planId: crypto.randomUUID(), sessionId: parentId, teamName, incarnationId: createHash('sha256').update(JSON.stringify([teamName, parentId, createdAt])).digest('hex'), revision: 2, state: 'launching', workDir: home, members, tasks: [], leaderRuntime: members[0]!.runtime, createdAt, updatedAt: createdAt, approvedSnapshot: { revision: 1, members, tasks: [], leaderRuntime: members[0]!.runtime, approvedAt: Date.now(), requestId: 'probe-approval' } } as const
      const planPath = join(helpers.getTeamDir(teamName), 'plan.json')
      await writeFile(planPath, JSON.stringify(plan))
      const { memberIds } = await runtime.launchTeamPlanRuntime(plan as any)
      await writeFile(planPath, JSON.stringify({ ...plan, state: 'running', revision: 3, launch: { status: 'running', memberIds } }))
      const memberId = memberIds.analyst!
      assert.equal(service.hasSession(memberId), false)
      assert.equal(helpers.readTeamFile(teamName)?.members[0]?.initialStartPending, true)
      await migrationMaintenance.drain()
      const configPath = helpers.getTeamFilePath(teamName)
      const before = await readFile(configPath)
      // `write-failure` makes the durable Stop record impossible without adding
      // a production hook: the team directory refuses both the lock file and
      // the temp file the pause write needs.
      const teamDir = helpers.getTeamDir(teamName)
      if (scenario === 'write-failure') await chmod(teamDir, 0o555)
      const stopAccepted = service.sendInterrupt(parentId)
      await service.waitForTeamWorkersStopped(parentId)
      await migrationMaintenance.drain()
      const diskBytesUnchanged = before.equals(await readFile(configPath))
      const durableStopRecorded = helpers.readTeamFile(teamName)?.pausedAt !== undefined
      if (scenario === 'write-failure') await chmod(teamDir, 0o755)
      assert.equal(stopAccepted, true)
      // The probe must fail the write for real, not merely claim it did.
      if (scenario === 'write-failure') assert.equal(durableStopRecorded, false, 'write-failure must lose the durable Stop record')
      else await waitFor(() => helpers.readTeamFile(teamName)?.pausedAt !== undefined, 'durable Stop record')
      const taskId = await tasks.createTask(taskListId, { subject: 'Background follow-up', description: '', status: 'pending', owner: 'analyst', blocks: [], blockedBy: [] })
      await delay(1000)
      const memberStartedBeforeRestart = service.hasSession(memberId)
      assert.equal(memberStartedBeforeRestart, false, 'Stop must suppress ready task before restart')
      assert.equal(requests.some(request => JSON.stringify(request.prompt).includes('Work as analyst')), false)
      await writeFile(join(home, 'identity.json'), JSON.stringify({ parentId, teamName, memberId, taskId }))
      result = { pid: process.pid, scenario, stopAccepted, standbyAtStop: true, taskId, memberStartedBeforeRestart, diskBytesUnchanged, durableStopRecorded }
    } else {
      assert.equal(phase, 'recover')
      const { parentId, teamName, memberId, taskId } = await readJson(join(home, 'identity.json'))
      // A new OS process has imported a fresh runtime. No forget/reset seam.
      assert.equal(service.hasSession(memberId), false)
      // Refresh only the fake provider's loopback port before supervision starts.
      // Preserve its saved ID, plan, tasks, and team config; send no instructions.
      const identityPlan = await readJson(join(helpers.getTeamDir(teamName), 'plan.json'))
      const savedProviderId = identityPlan.members[0].runtime.providerId
      await new ProviderService().updateProvider(savedProviderId, { baseUrl: upstream.url.toString() })
      const restored = await runtime.rehydrateTeamPlanRuntimesForSession(parentId)
      assert.equal(restored, true)
      await startLead(parentId, 'lead-fixture', provider.id)
      const observationMs = 2500
      await delay(observationMs)
      const memberStartedWithoutNewInstruction = service.hasSession(memberId)
      if (memberStartedWithoutNewInstruction) await waitFor(() => requests.some(request => request.presetType !== 'leader' && JSON.stringify(request.prompt).includes('Work as analyst')), 'member loopback work')
      result = { pid: process.pid, restored, taskId, observationMs, newInstructionsSent: 0, memberStartedWithoutNewInstruction, memberWorkObserved: requests.some(request => request.presetType !== 'leader' && JSON.stringify(request.prompt).includes('Work as analyst')), memberEntry: helpers.readTeamFile(teamName)?.members.find(member => member.sessionId === memberId) }
    }
  } finally {
    // Do not end/delete the runtime's durable roster between hosts. Stop actual
    // children, await exit, then exit this host (which discards its timers).
    await cleanup()
  }
  await writeFile(join(home, `${phase}.json`), JSON.stringify({ ...result!, cleanupComplete: true }))
  process.exit(0)
}

async function orchestrate() {
  const root = await mkdtemp(join(home, 'team-stop-recovery-'))
  const active = new Set<ReturnType<typeof spawn>>()
  const runHost = (directory: string, phase: string, scenario: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['run', import.meta.path, phase, scenario], { env: safeEnv(directory), cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    active.add(child)
    let output = ''
    let timedOut = false
    const capture = (chunk: Buffer) => { output = (output + String(chunk)).slice(-12000) }
    child.stdout!.on('data', capture)
    child.stderr!.on('data', capture)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 20000)
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 24000)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(force)
      // Reap any fixture descendants even if a host failed before its finally.
      try { process.kill(-child.pid!, 'SIGKILL') } catch {}
      active.delete(child)
      if (code !== 0 || timedOut) reject(new Error(`${phase}/${scenario}: exit ${code}, signal ${signal}, timeout ${timedOut}\n${output}`))
      else resolve()
    })
  })
  try {
    const observed = []
    for (const scenario of ['normal', 'write-failure']) {
      const directory = join(root, scenario)
      await mkdir(join(directory, 'tmp'), { recursive: true })
      await runHost(directory, 'stop', scenario)
      // Sequentially await host exit BEFORE starting the recovery host.
      await runHost(directory, 'recover', scenario)
      const stopped = await readJson(join(directory, 'stop.json'))
      const recovered = await readJson(join(directory, 'recover.json'))
      assert.notEqual(stopped.pid, recovered.pid)
      // A lost durable Stop record is the disclosed residual window: the
      // team restarts, so the probe records it instead of claiming a guarantee.
      const stoppedDurably = stopped.durableStopRecorded !== false
      const recoveredOnlyWhenWritable = stoppedDurably
        ? !recovered.memberStartedWithoutNewInstruction && !recovered.memberWorkObserved
        : recovered.memberStartedWithoutNewInstruction
      observed.push({ scenario, stop: stopped, recovery: recovered, requirementSatisfied: recoveredOnlyWhenWritable })
    }
    console.log(JSON.stringify({ probeCompleted: true, observed, requirementSatisfied: observed.every(result => result.requirementSatisfied), gaps: ['Write-failure injection not covered: fs/promises rename spy did not intercept Stop persistence (0 calls); no production hook added', 'No running-member Stop race or power-loss/crash window coverage', 'Absence of wake is bounded to the 2500 ms recovery observation window'], exitCodeMeaning: '0 = probe completed; requirementSatisfied is product verdict' }, null, 2))
  } finally {
    for (const child of active) { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true })
  }
}

await (phase ? host(process.argv[3]) : orchestrate())
