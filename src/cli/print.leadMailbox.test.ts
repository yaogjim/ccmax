import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as mailbox from '../utils/teammateMailbox.js'
import {
  acceptLeadMailboxPrompt,
  createLeadMailboxPollState,
  type LeadMailboxPollStep,
  MAX_LEAD_MAILBOX_ACK_FAILURES,
  takeLeadMailboxBatch,
} from './print.js'

import { createLeadMailboxFixture } from './__tests__/leadMailboxFixture.js'
import type { ConsumerScope } from '../utils/swarm/consumerScope.js'
import * as scopes from '../utils/swarm/consumerScope.js'

const TEAM = 'print-lead-team'
let consumerScope: ConsumerScope

let configDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-print-lead-mailbox-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  consumerScope = await createLeadMailboxFixture(TEAM)
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

async function send(from: string, text: string, second: number): Promise<void> {
  const timestamp = new Date(Date.UTC(2026, 9, 3, 0, 0, second)).toISOString()
  expect(
    await mailbox.writeToMailbox('team-lead', { from, text, timestamp }, TEAM),
  ).toBe(true)
}

async function unreadTexts(): Promise<string[]> {
  return (await mailbox.readUnreadMessages('team-lead', TEAM)).map(m => m.text)
}

function texts(step: LeadMailboxPollStep): string[] | undefined {
  return step.kind === 'batch' ? step.messages.map(m => m.text) : undefined
}

describe('print-mode team lead mailbox poll', () => {
  test('an unbound lead stops without reading or acknowledging mail', async () => {
    await send('worker', 'still unread', 1)
    const state = createLeadMailboxPollState()
    expect(await takeLeadMailboxBatch(state, {
      teamName: TEAM,
      hasActiveTeammates: true,
    })).toEqual({ kind: 'stop' })
    expect(state.identityRejected).toBe('unbound')
    expect(await unreadTexts()).toEqual(['still unread'])
  })

  test('a queued batch cannot enter the prompt list after the team is recreated', async () => {
    await send('worker', 'old batch', 1)
    const step = await takeLeadMailboxBatch(createLeadMailboxPollState(), {
      teamName: TEAM, consumerScope, hasActiveTeammates: true,
    })
    expect(step.kind).toBe('batch')
    if (step.kind !== 'batch') throw new Error('Expected a claimed batch')
    await createLeadMailboxFixture(TEAM)
    await send('worker', 'new inbox', 2)
    const accepted: unknown[] = []
    expect(await acceptLeadMailboxPrompt({
      value: 'old batch', mode: 'prompt', consumerScope: step.scope,
    }, false, command => accepted.push(command))).toBe('stale')
    expect(accepted).toEqual([])
    expect(await unreadTexts()).toEqual(['new inbox'])
  })

  test('identity replacement never enters the acknowledgement failure fallback', async () => {
    await send('worker', 'old candidate', 1)
    const claim = spyOn(scopes, 'claimScopedMailbox').mockImplementation(async () => {
      await createLeadMailboxFixture(TEAM)
      return { status: 'stale' }
    })
    const state = createLeadMailboxPollState()
    state.consecutiveAckFailures = MAX_LEAD_MAILBOX_ACK_FAILURES - 1
    try {
      expect(await takeLeadMailboxBatch(state, {
        teamName: TEAM, consumerScope, hasActiveTeammates: true,
      })).toEqual({ kind: 'stop' })
      expect(state.identityRejected).toBe('stale')
      expect(await unreadTexts()).toEqual(['old candidate'])
    } finally {
      claim.mockRestore()
    }
  })

  test('acknowledges only the batch it read', async () => {
    await send('alice', 'report', 1)
    const readUnread = mailbox.readUnreadMessages
    const read = spyOn(mailbox, 'readUnreadMessages').mockImplementation(
      async (agentName, teamName) => {
        const batch = await readUnread(agentName, teamName)
        // A teammate fails while the lead is between its read and its ack.
        await send('bob', 'failed: provider stream ended', 2)
        return batch
      },
    )

    try {
      const step = await takeLeadMailboxBatch(createLeadMailboxPollState(), {
        teamName: TEAM, consumerScope,
        hasActiveTeammates: true,
      })
      expect(texts(step)).toEqual(['report'])
    } finally {
      read.mockRestore()
    }

    expect(await unreadTexts()).toEqual(['failed: provider stream ended'])
  })

  test('keeps polling quietly while teammates work and nothing is unread', async () => {
    expect(
      await takeLeadMailboxBatch(createLeadMailboxPollState(), {
        teamName: TEAM, consumerScope,
        hasActiveTeammates: true,
      }),
    ).toEqual({ kind: 'idle' })
  })

  test('drains mail left behind by the last teammate before stopping', async () => {
    await send('worker', 'final report', 1)
    const state = createLeadMailboxPollState()
    const departed = { teamName: TEAM, consumerScope, hasActiveTeammates: false }

    expect(texts(await takeLeadMailboxBatch(state, departed))).toEqual([
      'final report',
    ])
    expect(await takeLeadMailboxBatch(state, departed)).toEqual({ kind: 'stop' })
    expect(await unreadTexts()).toEqual([])
  })

  test('drains only once per departure, then waits for an active teammate', async () => {
    await send('worker', 'final report', 1)
    const state = createLeadMailboxPollState()
    const departed = { teamName: TEAM, consumerScope, hasActiveTeammates: false }

    expect(texts(await takeLeadMailboxBatch(state, departed))).toEqual([
      'final report',
    ])
    await send('worker', 'written during the drain turn', 2)
    expect(await takeLeadMailboxBatch(state, departed)).toEqual({ kind: 'stop' })
    expect(await unreadTexts()).toEqual(['written during the drain turn'])

    expect(
      texts(
        await takeLeadMailboxBatch(state, {
          teamName: TEAM, consumerScope,
          hasActiveTeammates: true,
        }),
      ),
    ).toEqual(['written during the drain turn'])
  })

  test('retries an unacknowledged batch before processing it anyway', async () => {
    await send('alice', 'report', 1)
    const claim = spyOn(mailbox, 'claimMailboxMessages').mockResolvedValue(
      undefined,
    )
    const state = createLeadMailboxPollState()
    const active = { teamName: TEAM, consumerScope, hasActiveTeammates: true }

    try {
      for (let poll = 1; poll < MAX_LEAD_MAILBOX_ACK_FAILURES; poll++) {
        expect(await takeLeadMailboxBatch(state, active)).toEqual({
          kind: 'retry',
        })
      }
      expect(texts(await takeLeadMailboxBatch(state, active))).toEqual(['report'])
    } finally {
      claim.mockRestore()
    }

    // Acknowledging works again: the failure streak resets.
    expect(texts(await takeLeadMailboxBatch(state, active))).toEqual(['report'])
    expect(state.consecutiveAckFailures).toBe(0)
    expect(await unreadTexts()).toEqual([])
  })
})
