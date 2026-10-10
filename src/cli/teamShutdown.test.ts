import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  createShutdownTeamPrompt,
  hasTeammatesRequiringShutdown,
  shouldInjectShutdownPrompt,
} from './print.js'
import { isShutdownTeamPrompt, SHUTDOWN_TEAM_PROMPT } from '../utils/swarm/teamShutdownPrompt.js'

test('a draft team with only its leader does not trigger shutdown', () => {
  const state = getDefaultAppState()
  const lead = { name: 'team-lead' }
  const teamContext = { teammates: { lead } } as unknown as NonNullable<typeof state.teamContext>
  expect(hasTeammatesRequiringShutdown(state)).toBe(false)
  expect(hasTeammatesRequiringShutdown({ ...state, teamContext })).toBe(false)
  expect(hasTeammatesRequiringShutdown({ ...state, teamContext: { ...teamContext, teammates: { lead, worker: { ...lead, name: 'worker' } } } as typeof teamContext })).toBe(true)
  const activeTask = { type: 'in_process_teammate', status: 'running' }
  expect(hasTeammatesRequiringShutdown({ ...state, tasks: { worker: activeTask } as typeof state.tasks })).toBe(true)
})

test('shutdown instruction is model-visible but hidden from user history', () => {
  const command = createShutdownTeamPrompt()
  expect(command.mode).toBe('prompt')
  expect(command.isMeta).toBe(true)
  expect(command.value).toContain('requestShutdown')
  expect(isShutdownTeamPrompt([{ type: 'text', text: SHUTDOWN_TEAM_PROMPT }])).toBe(true)
  expect(isShutdownTeamPrompt('User quoted requestShutdown in a question')).toBe(false)
})

test('a closing lead re-reads the roster before injecting a shutdown turn', () => {
  const state = getDefaultAppState()
  const lead = { name: 'team-lead' }
  const worker = { name: 'worker' }
  const teamContext = (teammates: Record<string, { name: string }>) =>
    ({ teammates }) as unknown as NonNullable<typeof state.teamContext>

  // Input open: the lead keeps running, nothing to inject.
  expect(
    shouldInjectShutdownPrompt(
      { ...state, teamContext: teamContext({ lead, worker }) },
      { inputClosed: false, alreadyInjected: false },
    ),
  ).toBe(false)

  // Input closed with a live teammate: the lead must ask the team to stand down.
  expect(
    shouldInjectShutdownPrompt(
      { ...state, teamContext: teamContext({ lead, worker }) },
      { inputClosed: true, alreadyInjected: false },
    ),
  ).toBe(true)

  // In-process teammates count even without a team file entry.
  expect(
    shouldInjectShutdownPrompt(
      { ...state, tasks: { worker: { type: 'in_process_teammate', status: 'running' } } as typeof state.tasks },
      { inputClosed: true, alreadyInjected: false },
    ),
  ).toBe(true)

  // Only once per session.
  expect(
    shouldInjectShutdownPrompt(
      { ...state, teamContext: teamContext({ lead, worker }) },
      { inputClosed: true, alreadyInjected: true },
    ),
  ).toBe(false)

  // Regression anchor: the roster empties while the closing lead's mailbox
  // read is in flight (the desktop closes the session, the last teammate
  // exits). Reusing the roster captured at the top of that poll iteration
  // asked a team that no longer existed to shut down, spending a model turn
  // after the session had closed — and, in `print.leadMailboxPause.test.ts`,
  // pushing an extra prompt that made the next test's exact prompt-count
  // assertion unsatisfiable.
  expect(
    shouldInjectShutdownPrompt(
      { ...state, teamContext: teamContext({ lead }) },
      { inputClosed: true, alreadyInjected: false },
    ),
  ).toBe(false)
  expect(
    shouldInjectShutdownPrompt(
      { ...state, teamContext: undefined } as typeof state,
      { inputClosed: true, alreadyInjected: false },
    ),
  ).toBe(false)
})
