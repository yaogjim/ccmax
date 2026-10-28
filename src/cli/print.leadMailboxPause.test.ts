import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'lead-mailbox-pause-'))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(
    home,
    { CLAUDE_CODE_SIMPLE: '1', CC_HAHA_AGENT_TEAMS_ENABLED: '1' },
    originalEnv,
  ),
)

const LEAD_ID = 'team-lead@pause-team'
const WORKER_ID = 'worker@pause-team'

// Each lead turn records its prompt instead of calling a model. A test can
// hold the first turn open so the input closes while a run is still active.
const prompts: string[] = []
let firstTurnHeld = false
let releaseFirstTurn: () => void = () => {}
// Safety valve: a regression that re-enqueues the shutdown prompt once per
// run() would otherwise starve the event loop and hang the runner. When the
// guard trips, the test unbinds the member so the loop can end and the
// assertion reports a count.
const SHUTDOWN_INJECTION_GUARD = 8
let onShutdownGuard: () => void = () => {}
const shutdownCount = () =>
  prompts.filter(p => p === SHUTDOWN_TEAM_PROMPT).length

const queryEngine = await import('../QueryEngine.js')
const originalQueryEngine = { ...queryEngine }
mock.module('../QueryEngine.js', () => ({
  ...queryEngine,
  ask: async function* (params: { prompt: unknown }) {
    const prompt =
      typeof params.prompt === 'string'
        ? params.prompt
        : JSON.stringify(params.prompt)
    prompts.push(prompt)
    if (firstTurnHeld) {
      firstTurnHeld = false
      await new Promise<void>(resolve => {
        releaseFirstTurn = resolve
      })
    }
    if (
      prompt === SHUTDOWN_TEAM_PROMPT &&
      shutdownCount() >= SHUTDOWN_INJECTION_GUARD
    ) {
      onShutdownGuard()
    }
  },
}))

const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { setIsInteractive, getIsInteractive } = await import(
  '../bootstrap/state.js'
)
const mailbox = await import('../utils/teammateMailbox.js')
const { createLeadMailboxFixture } = await import('./__tests__/leadMailboxFixture.js')
const { SHUTDOWN_TEAM_PROMPT } = await import(
  '../utils/swarm/teamShutdownPrompt.js'
)

const wasInteractive = getIsInteractive()
setIsInteractive(false)
afterAll(() => {
  // mock.restore does not undo mock.module; later files in the same run
  // must see the real QueryEngine.
  mock.module('../QueryEngine.js', () => originalQueryEngine)
  clearCommandQueue()
  setIsInteractive(wasInteractive)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  prompts.length = 0
  firstTurnHeld = false
  onShutdownGuard = () => {}
  clearCommandQueue()
})

async function startLead(team: string, options: { inProcessTeammate?: boolean } = {}) {
  const consumerScope = await createLeadMailboxFixture(team)
  const defaults = getDefaultAppState()
  const inProcessTeammate = options.inProcessTeammate === true
  let state = {
    ...defaults,
    teamContext: inProcessTeammate
      ? undefined
      : {
          teamName: team,
          consumerScope,
          teamFilePath: join(home, 'teams', team, 'config.json'),
          leadAgentId: LEAD_ID,
          teammates: {
            [LEAD_ID]: { name: 'team-lead' },
            [WORKER_ID]: { name: 'worker' },
          },
        },
    tasks: inProcessTeammate
      ? {
          [WORKER_ID]: {
            type: 'in_process_teammate',
            status: 'running',
            isIdle: true,
          },
        }
      : defaults.tasks,
  } as unknown as typeof defaults
  const input = new Stream<string>()
  const responses = new Set<string>()
  let closed = false
  const output = __runHeadlessStreamingForTests(
    new StructuredIO(input),
    [],
    [],
    [],
    [],
    (() => undefined) as never,
    {},
    () => state,
    update => {
      state = update(state)
    },
    [],
    { outputFormat: 'stream-json' } as never,
  )
  const drained = (async () => {
    for await (const message of output) {
      const response = (message as { type?: string; response?: { request_id?: string } })
      if (response.type === 'control_response' && response.response?.request_id) {
        responses.add(response.response.request_id)
      }
    }
    closed = true
  })()
  const send = (message: unknown) => input.enqueue(`${JSON.stringify(message)}\n`)
  return {
    say: (content: string) => send({ type: 'user', message: { role: 'user', content } }),
    async control(subtype: string) {
      const id = `${subtype}-${Math.random()}`
      send({ type: 'control_request', request_id: id, request: { subtype } })
      await until(() => responses.has(id))
    },
    // Let the input close while the first turn is still in flight, so the
    // closing lead actually reaches the shutdown path.
    holdFirstTurn: () => {
      firstTurnHeld = true
    },
    releaseFirstTurn: () => releaseFirstTurn(),
    inputDone: () => input.done(),
    // Model the member exiting: the in-process task goes away and the session
    // must converge instead of polling forever.
    finishInProcessTeammate: () => {
      state = { ...state, tasks: {} } as typeof state
    },
    // Model the team exiting: the last teammate leaves the roster.
    finishTeam: () => {
      state = {
        ...state,
        teamContext: {
          ...state.teamContext!,
          teammates: { [LEAD_ID]: { name: 'team-lead' } },
        },
      } as typeof state
    },
    isClosed: () => closed,
    drained,
    async close() {
      // Without teammates the closing input ends the session instead of
      // asking the lead to shut a team down.
      state = { ...state, teamContext: { ...state.teamContext!, teammates: { [LEAD_ID]: { name: 'team-lead' } } } } as typeof state
      input.done()
      await drained
      clearCommandQueue()
    },
  }
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(20)
  expect(done()).toBe(true)
}

async function report(team: string, text: string, id: string): Promise<void> {
  expect(
    await mailbox.writeToMailbox(
      'team-lead',
      { id, from: 'worker', text, timestamp: new Date().toISOString() },
      team,
    ),
  ).toBe(true)
}

const delivered = (text: string, id: string) =>
  `<teammate-message teammate_id="worker" id="${id}">\n${text}\n</teammate-message>`

test('a team pause keeps teammate mail from starting lead turns until the user speaks again', async () => {
  const team = 'pause-team'
  const lead = await startLead(team)
  try {
    lead.say('start')
    await until(() => prompts.length === 1)
    await lead.control('team_plan_pause')

    // A report a member wrote before the Stop killed it.
    await report(team, 'halfway done', 'client-pause-halfway')
    // Several poll intervals: the lead must not act on its own.
    await Bun.sleep(1_500)
    expect(prompts).toEqual(['start'])
    expect((await mailbox.readUnreadMessages('team-lead', team)).map(m => m.text)).toEqual(['halfway done'])

    lead.say('continue')
    await until(() => prompts.length === 3)
    expect(prompts).toEqual([
      'start',
      'continue',
      delivered('halfway done', 'client-pause-halfway'),
    ])
  } finally {
    await lead.close()
  }
}, 30_000)

test('a plain interrupt keeps delivering teammate mail between turns', async () => {
  const team = 'interrupt-team'
  const lead = await startLead(team)
  try {
    lead.say('start')
    await until(() => prompts.length === 1)
    await lead.control('interrupt')

    await report(team, 'done', 'client-interrupt-done')
    await until(() => prompts.length === 2)
    expect(prompts).toEqual([
      'start',
      delivered('done', 'client-interrupt-done'),
    ])
  } finally {
    await lead.close()
  }
}, 30_000)

test('a closing lead asks a lingering team to shut down once, then closes when it exits', async () => {
  const team = 'shutdown-once-team'
  const lead = await startLead(team, { inProcessTeammate: true })
  onShutdownGuard = () => lead.finishInProcessTeammate()
  try {
    lead.holdFirstTurn()
    lead.say('start')
    await until(() => prompts.length === 1)

    // Close the input while the first turn is still in flight; this is the
    // path where the closing lead decides whether to ask the team to stand
    // down.
    lead.inputDone()
    lead.releaseFirstTurn()

    // Keep the member alive past the first request: a regression re-enqueued
    // the shutdown prompt once per run() and never let the session end.
    await until(() => shutdownCount() >= 1)
    await Bun.sleep(1_000)
    expect(shutdownCount()).toBe(1)

    // The member exits: the session must converge instead of polling forever.
    lead.finishInProcessTeammate()
    await until(() => lead.isClosed())
  } finally {
    clearCommandQueue()
  }
}, 30_000)

test('a closing lead asks a host-paused team to shut down once, then closes when it exits', async () => {
  const team = 'shutdown-once-held-team'
  const lead = await startLead(team)
  onShutdownGuard = () => lead.finishTeam()
  try {
    lead.holdFirstTurn()
    lead.say('start')
    await until(() => prompts.length === 1)

    // The desktop stops the team, then the input closes while the first turn
    // is still in flight. A host pause must not be able to re-enqueue the same
    // shutdown prompt every turn.
    await lead.control('team_plan_pause')
    lead.inputDone()
    lead.releaseFirstTurn()

    await until(() => shutdownCount() >= 1)
    await Bun.sleep(1_000)
    expect(shutdownCount()).toBe(1)

    lead.finishTeam()
    await until(() => lead.isClosed())
  } finally {
    clearCommandQueue()
  }
}, 30_000)
