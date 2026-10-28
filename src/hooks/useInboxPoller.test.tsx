import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import type { AppState } from '../state/AppState.js'
import type { TeammateMessage } from '../utils/teammateMailbox.js'

const mailboxModule = await import('../utils/teammateMailbox.js')
const useHooksTsModule = await import('usehooks-ts')
const terminalNotificationModule = await import(
  '../ink/useTerminalNotification.js'
)
const appStateModule = await import('../state/AppState.js')
const teammateModule = await import('../utils/teammate.js')
const teammateContextModule = await import('../utils/teammateContext.js')
const teamHelpersModule = await import('../utils/swarm/teamHelpers.js')
const originalTeamHelpers = { ...teamHelpersModule }
const backendRegistryModule = await import(
  '../utils/swarm/backends/registry.js'
)
const backendDetectionModule = await import(
  '../utils/swarm/backends/detection.js'
)
const tasksModule = await import('../utils/tasks.js')
const notifierModule = await import('../services/notifier.js')
const consumerScopeModule = await import('../utils/swarm/consumerScope.js')
const leaderPermissionBridgeModule = await import(
  '../utils/swarm/leaderPermissionBridge.js'
)
const swarmPermissionPollerModule = await import('./useSwarmPermissionPoller.js')

// mock.module replaces exports process-wide and outlives this file, so every
// module mocked below is put back afterwards from these untouched copies.
// Otherwise later files in one `bun test` run (the coverage gate runs all of
// src in a single process) see this file's fake mailbox, team file and tasks.
const originalModules: Array<[string, Record<string, unknown>]> = [
  ['usehooks-ts', { ...useHooksTsModule }],
  ['../state/AppState.js', { ...appStateModule }],
  ['../ink/useTerminalNotification.js', { ...terminalNotificationModule }],
  ['../services/notifier.js', { ...notifierModule }],
  ['../utils/teammate.js', { ...teammateModule }],
  ['../utils/teammateContext.js', { ...teammateContextModule }],
  ['../utils/swarm/backends/registry.js', { ...backendRegistryModule }],
  ['../utils/swarm/backends/detection.js', { ...backendDetectionModule }],
  ['../utils/tasks.js', { ...tasksModule }],
  ['../utils/teammateMailbox.js', { ...mailboxModule }],
  ['../utils/swarm/consumerScope.js', { ...consumerScopeModule }],
  ['../utils/swarm/leaderPermissionBridge.js', { ...leaderPermissionBridgeModule }],
  ['./useSwarmPermissionPoller.js', { ...swarmPermissionPollerModule }],
]

let intervalCallback: (() => void) | undefined
let state: AppState
let unreadMessages: TeammateMessage[] = []
let teamFileReadCount = 0
let submitted: string[] = []
// C-ORDER observations: local acceptance/queueing must precede the read mark.
let handlerEvents: string[] = []
let isTeamLeadRole = true
let isTeammateRole = false
let agentNameValue: string | undefined
let hasPermissionWaiter = true
let hasSandboxWaiter = true
const processedPermissionResponses: string[] = []
const processedSandboxResponses: string[] = []
let onSubmit: (formatted: string) => boolean = () => true
// While set, every inbox read waits for it, like a slow disk.
let readGate: Promise<void> | undefined

const readUnread = mock(async () => {
  await readGate
  return unreadMessages.filter(message => !message.read)
})
const markReadByIdentity = mock(
  async (
    _agentName: string,
    _teamName: string | undefined,
    delivered: readonly TeammateMessage[],
  ) => {
    handlerEvents.push('mark')
    const identities = new Set(
      delivered.map(mailboxModule.getMailboxMessageIdentity),
    )
    unreadMessages = unreadMessages.map(message =>
      !message.read &&
      identities.has(mailboxModule.getMailboxMessageIdentity(message))
        ? { ...message, read: true }
        : message,
    )
    return true
  },
)
const removeTeammate = mock(async () => true)
const killPane = mock(async () => true)
const writeToMailbox = mock(async () => true)
let leaderQueueAvailable = true
let toolUseConfirmQueue: Array<{
  onAbort: () => void
  onAllow: (input: Record<string, unknown>, updates: unknown[]) => void
  onReject: (feedback?: string) => void
}> = []
const notifications: Array<{ message: string }> = []
const processedPermissionParams: Array<Record<string, unknown>> = []
// The hook claims receipts inside its own withConsumerScope commit, so the
// primitive it calls is claimMailboxMessages. Keep the same in-memory model.
const claimMailbox = mock(async (
  _agentName: string,
  _teamName: string | undefined,
  candidates: readonly TeammateMessage[],
) => {
  handlerEvents.push('claim')
  await markReadByIdentity('team-lead', 'review-team', candidates)
  return [...candidates]
})

const store = {
  getState: () => state,
  setState: (updater: (previous: AppState) => AppState) => {
    state = updater(state)
  },
  subscribe: () => () => {},
}

mock.module('usehooks-ts', () => ({
  ...useHooksTsModule,
  useInterval: (callback: () => void) => {
    intervalCallback = callback
  },
}))

mock.module('../state/AppState.js', () => ({
  ...appStateModule,
  useAppStateStore: () => store,
  useSetAppState: () => store.setState,
  useAppState: (selector: (current: AppState) => unknown) => selector(state),
}))

mock.module('../ink/useTerminalNotification.js', () => ({
  ...terminalNotificationModule,
  useTerminalNotification: () => async () => {},
}))

mock.module('../services/notifier.js', () => ({
  sendNotification: async (options: { message: string }) => {
    notifications.push({ message: options.message })
  },
}))

mock.module('../utils/teammate.js', () => ({
  ...teammateModule,
  getAgentName: () => agentNameValue,
  isPlanModeRequired: () => false,
  isTeamLead: () => isTeamLeadRole,
  isTeammate: () => isTeammateRole,
}))

mock.module('../utils/teammateContext.js', () => ({
  ...teammateContextModule,
  isInProcessTeammate: () => false,
}))

mock.module('../utils/swarm/teamHelpers.js', () => ({
  ...teamHelpersModule,
  readTeamFileAsync: async () => {
    teamFileReadCount += 1
    if (teamFileReadCount === 1) return null
    return {
      leadAgentId: 'team-lead@review-team',
      members: [
        {
          agentId: 'team-lead@review-team',
          name: 'team-lead',
          tmuxPaneId: '',
          backendType: 'in-process',
        },
        {
          agentId: 'worker-id',
          name: 'worker',
          tmuxPaneId: '%trusted',
          backendType: 'tmux',
        },
      ],
    }
  },
  removeTeammateFromTeamFile: removeTeammate,
  setMemberMode: async () => true,
}))

mock.module('../utils/swarm/backends/registry.js', () => ({
  ...backendRegistryModule,
  ensureBackendsRegistered: async () => {},
  getBackendByType: () => ({ killPane }),
}))

mock.module('../utils/swarm/backends/detection.js', () => ({
  ...backendDetectionModule,
  isInsideTmux: async () => true,
}))

mock.module('../utils/tasks.js', () => ({
  ...tasksModule,
  unassignTeammateTasks: async () => ({
    notificationMessage: 'worker has shut down.',
  }),
}))

mock.module('../utils/teammateMailbox.js', () => ({
  ...mailboxModule,
  readUnreadMessages: readUnread,
  claimMailboxMessages: claimMailbox,
  markMessagesAsReadByIdentity: markReadByIdentity,
  writeToMailbox: writeToMailbox,
}))

// The hook's own behaviour (batching, queueing, overlapping polls) is what this
// file covers; the instance check lives in consumerScope and is exercised
// against real team files in its own tests. Keep the seam explicit so a missing
// scope is still observable here.
let scopeStatus: 'current' | 'stale' | 'unbound' = 'current'
const readScoped = mock(async (_scope: unknown) => ({
  status: scopeStatus,
  ...(scopeStatus === 'current' ? { value: await readUnread() } : {}),
}))
const markScopedRead = mock(async (
  _scope: unknown,
  delivered: readonly TeammateMessage[],
) => ({
  status: scopeStatus,
  ...(scopeStatus === 'current'
    ? { value: await markReadByIdentity('team-lead', 'review-team', delivered) }
    : {}),
}))
const claimScoped = mock(async (
  _scope: unknown,
  candidates: readonly TeammateMessage[],
) => {
  if (scopeStatus !== 'current') return { status: scopeStatus }
  handlerEvents.push('claim')
  await markReadByIdentity('team-lead', 'review-team', candidates)
  return { status: 'claimed', messages: [...candidates] }
})
// The hook claims receipts inside its own withConsumerScope commit, so the
// primitive it calls is claimMailboxMessages. Keep the same in-memory model.
// Second fence: the hook performs each commit in its own withConsumerScope.
let scopedCallCount = 0
let rejectScopedCallAt: number | undefined
const withScopedCheck = mock(async (
  scope: unknown,
  accept: (scope: unknown, team: unknown) => unknown,
) => {
  scopedCallCount += 1
  if (rejectScopedCallAt === scopedCallCount) {
    scopeStatus = 'stale'
    return { status: 'stale' as const }
  }
  return scopeStatus === 'current'
    ? { status: 'current' as const, value: await accept(scope, { name: 'review-team' }) }
    : { status: scopeStatus }
})
mock.module('./useSwarmPermissionPoller.js', () => ({
  ...swarmPermissionPollerModule,
  hasPermissionCallback: () => hasPermissionWaiter,
  hasSandboxPermissionCallback: () => hasSandboxWaiter,
  processMailboxPermissionResponse: (params: Record<string, unknown>) => {
    handlerEvents.push('process-permission')
    processedPermissionResponses.push(params.requestId as string)
    processedPermissionParams.push(params)
    return true
  },
  processSandboxPermissionResponse: (params: { requestId: string }) => {
    handlerEvents.push('process-sandbox')
    processedSandboxResponses.push(params.requestId)
    return true
  },
}))
mock.module('../utils/swarm/leaderPermissionBridge.js', () => ({
  ...leaderPermissionBridgeModule,
  getLeaderToolUseConfirmQueue: () =>
    leaderQueueAvailable
      ? (update: (queue: unknown[]) => unknown[]) => {
          handlerEvents.push('queue')
          toolUseConfirmQueue = update(toolUseConfirmQueue) as typeof toolUseConfirmQueue
          return toolUseConfirmQueue
        }
      : undefined,
}))
mock.module('../utils/swarm/consumerScope.js', () => ({
  ...consumerScopeModule,
  claimScopedMailbox: claimScoped,
  readScopedMailbox: readScoped,
  markScopedMailboxRead: markScopedRead,
  withConsumerScope: withScopedCheck,
  mutateScopedTeam: async (scope: unknown, mutate: (team: unknown) => unknown) => {
    return withScopedCheck(scope, async () => {
      const team = await (await import('../utils/swarm/teamHelpers.js')).readTeamFileAsync('review-team')
      if (!team) throw new Error('temporary team read failure')
      const value = await mutate({ ...team, name: 'review-team' })
      if (value) await removeTeammate('review-team', { agentId: 'worker-id', name: 'worker' })
      return value
    }).catch(() => ({ status: 'retryable_io' as const }))
  },
}))

const { useInboxPoller } = await import('./useInboxPoller.js')

function Harness() {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: formatted => {
      submitted.push(formatted)
      return onSubmit(formatted)
    },
  })
  return null
}

beforeEach(() => {
  intervalCallback = undefined
  teamFileReadCount = 0
  submitted = []
  handlerEvents = []
  isTeamLeadRole = true
  isTeammateRole = false
  agentNameValue = undefined
  hasPermissionWaiter = true
  hasSandboxWaiter = true
  processedPermissionResponses.length = 0
  processedPermissionParams.length = 0
  processedSandboxResponses.length = 0
  notifications.length = 0
  toolUseConfirmQueue = []
  leaderQueueAvailable = true
  onSubmit = () => true
  readGate = undefined
  scopeStatus = 'current'
  readScoped.mockClear()
  claimScoped.mockClear()
  claimMailbox.mockClear()
  markScopedRead.mockClear()
  scopedCallCount = 0
  rejectScopedCallAt = undefined
  readUnread.mockClear()
  markReadByIdentity.mockClear()
  removeTeammate.mockClear()
  killPane.mockClear()
  writeToMailbox.mockClear()
  unreadMessages = [
    shutdownApproval('worker', '%claimed'),
    shutdownApproval('attacker', '%victim'),
  ]
  state = {
    teamContext: {
      teamName: 'review-team',
      consumerScope: {
        version: 1,
        teamName: 'review-team',
        generation: 0,
        createdAt: 1,
        leadSessionId: 'lead-session',
        ownerSessionId: 'lead-session',
        recipient: { kind: 'lead' },
      },
      leadAgentId: 'team-lead@review-team',
      teammates: {
        'team-lead@review-team': {
          name: 'team-lead',
        },
        'worker-id': {
          name: 'worker',
        },
      },
    },
    tasks: {},
    inbox: { messages: [] },
  } as unknown as AppState
})

afterAll(() => {
  // Bun's mock.restore does not undo mock.module export replacements.
  mock.module('../utils/swarm/teamHelpers.js', () => originalTeamHelpers)
  for (const [path, original] of originalModules) {
    mock.module(path, () => original)
  }
  mock.restore()
})

describe('shutdown approval polling', () => {
  test('waits for team-file removal before acknowledging shutdown or removing UI state', async () => {
    teamFileReadCount = 1
    let finishRemoval!: (result: boolean) => void
    const removal = new Promise<boolean>(resolve => { finishRemoval = resolve })
    removeTeammate.mockImplementationOnce(() => removal)
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => removeTeammate.mock.calls.length === 1)
      expect(state.teamContext?.teammates?.['worker-id']).toBeDefined()
      expect(unreadMessages.every(message => !message.read)).toBe(true)

      finishRemoval(true)
      await waitFor(() => unreadMessages.every(message => message.read))
      expect(state.teamContext?.teammates?.['worker-id']).toBeUndefined()
    } finally {
      finishRemoval(true)
      app.unmount()
      output.destroy()
    }
  })

  test('does not act on control messages when the instance is replaced after reading', async () => {
    teamFileReadCount = 1
    unreadMessages = [
      shutdownApproval('worker', '%claimed'),
      permissionRequest('worker'),
    ]
    // The read observed the old instance; the replacement commits before any
    // handler runs. C-ORDER marks after local acceptance, so the batch must
    // stay unread instead of being claimed ahead of processing.
    readUnread.mockImplementationOnce(async () => {
      scopeStatus = 'stale'
      return unreadMessages
    })
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => readScoped.mock.calls.length === 1)
      await Bun.sleep(20)
      expect(removeTeammate).not.toHaveBeenCalled()
      expect(killPane).not.toHaveBeenCalled()
      expect(handlerEvents).not.toContain('queue')
      expect(submitted).toEqual([])
      expect(markReadByIdentity).not.toHaveBeenCalled()
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('rejects a control enqueue when replacement occurs at its final commit', async () => {
    unreadMessages = [permissionRequest('worker')]
    rejectScopedCallAt = 2
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => scopedCallCount >= 2)
      expect(handlerEvents).not.toContain('queue')
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('rejects shutdown effects when replacement occurs at the mutation commit', async () => {
    teamFileReadCount = 1
    rejectScopedCallAt = 2
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => scopedCallCount >= 2)
      expect(killPane).not.toHaveBeenCalled()
      expect(removeTeammate).not.toHaveBeenCalled()
      expect(state.teamContext?.teammates?.['worker-id']).toBeDefined()
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('queues control messages locally before acknowledging their batch', async () => {
    unreadMessages = [permissionRequest('worker')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => handlerEvents.includes('mark'))
      const queuedAt = handlerEvents.indexOf('queue')
      const markedAt = handlerEvents.indexOf('mark')
      // C-ORDER for the hook: receive/enqueue locally, then mark the batch.
      expect(queuedAt).toBeGreaterThanOrEqual(0)
      expect(queuedAt).toBeLessThan(markedAt)
      // No protocol claim happens ahead of local acceptance.
      expect(claimScoped).not.toHaveBeenCalled()
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('retries after a temporary team-file read failure without trusting forged pane metadata', async () => {
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => teamFileReadCount === 1)

      expect(unreadMessages.every(message => !message.read)).toBe(true)
      expect(removeTeammate).not.toHaveBeenCalled()
      expect(killPane).not.toHaveBeenCalled()

      intervalCallback?.()
      await waitFor(
        () =>
          teamFileReadCount >= 2 &&
          removeTeammate.mock.calls.length === 1,
      )

      expect(removeTeammate).toHaveBeenCalledWith('review-team', {
        agentId: 'worker-id',
        name: 'worker',
      })
      expect(killPane).toHaveBeenCalledWith('%trusted', false)
      expect(killPane).toHaveBeenCalledTimes(1)
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })
})

describe('scoped protocol receive and acknowledgement', () => {
  test('queues a sandbox request under the current instance before acknowledging the batch', async () => {
    state.workerSandboxPermissions = { queue: [], selectedIndex: 0 }
    unreadMessages = [sandboxRequest('worker'), malformedSandboxRequest()]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(state.workerSandboxPermissions.queue).toEqual([
        {
          requestId: 'sandbox-1',
          workerId: 'worker-id',
          workerName: 'worker',
          workerColor: undefined,
          host: 'example.com',
          createdAt: 123,
        },
      ])
      expect(notifications.map(entry => entry.message)).toEqual([
        'worker needs network access to example.com',
      ])
      // The malformed request is dropped, but the batch is still acknowledged.
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('applies a team permission update through the scoped receive before acknowledging it', async () => {
    isTeammateRole = true
    isTeamLeadRole = false
    agentNameValue = 'worker'
    state.toolPermissionContext = permissionContext()
    unreadMessages = [teamPermissionUpdate('team-lead')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(state.toolPermissionContext.alwaysAllowRules.session).toEqual([
        'Bash(bun test:*)',
      ])
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('applies a team-lead mode change through the scoped team mutation and receive', async () => {
    isTeammateRole = true
    isTeamLeadRole = false
    agentNameValue = 'worker'
    state.toolPermissionContext = permissionContext()
    // The first team-file read is the mutation's own; seed the counter so it
    // returns the trusted team instead of a transient read failure.
    teamFileReadCount = 1
    unreadMessages = [modeSetRequest('team-lead', 'acceptEdits')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(state.toolPermissionContext.mode).toBe('acceptEdits')
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('leaves a mode change unread when the scoped team mutation is refused', async () => {
    isTeammateRole = true
    isTeamLeadRole = false
    agentNameValue = 'worker'
    state.toolPermissionContext = permissionContext()
    // Call #2 is the scoped team mutation, where the replacement lands.
    rejectScopedCallAt = 2
    unreadMessages = [modeSetRequest('team-lead', 'acceptEdits')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => scopedCallCount >= 2)
      await Bun.sleep(20)

      expect(state.toolPermissionContext.mode).toBe('default')
      expect(markReadByIdentity).not.toHaveBeenCalled()
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('writes a plan approval before acknowledging the request under the same scope', async () => {
    state.toolPermissionContext = permissionContext()
    unreadMessages = [planApprovalRequest('worker', 'plan-1')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(writeToMailbox).toHaveBeenCalledTimes(1)
      const [recipient, envelope, teamName] = writeToMailbox.mock.calls[0]!
      expect(recipient).toBe('worker')
      expect(teamName).toBe('review-team')
      expect(JSON.parse((envelope as { text: string }).text)).toMatchObject({
        type: 'plan_approval_response',
        requestId: 'plan-1',
        approved: true,
      })
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toContain('plan_approval_request')
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('retains a permission request unread when the leader confirm queue is unavailable', async () => {
    leaderQueueAvailable = false
    unreadMessages = [permissionRequest('worker')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => readScoped.mock.calls.length === 1)
      await Bun.sleep(20)

      expect(handlerEvents).not.toContain('queue')
      expect(toolUseConfirmQueue).toEqual([])
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('sends every leader resolution through the scoped receive', async () => {
    unreadMessages = [permissionRequest('worker')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(
        () =>
          markReadByIdentity.mock.calls.length === 1 &&
          toolUseConfirmQueue.length === 1,
      )
      const entry = toolUseConfirmQueue[0]!
      entry.onAllow({ command: 'ls' }, [])
      entry.onReject('not allowed')
      entry.onAbort()

      await waitFor(() => writeToMailbox.mock.calls.length === 3)
      expect(
        writeToMailbox.mock.calls.map(call =>
          JSON.parse((call[1] as { text: string }).text),
        ),
      ).toEqual([
        expect.objectContaining({ subtype: 'success' }),
        expect.objectContaining({ subtype: 'error', error: 'not allowed' }),
        expect.objectContaining({ subtype: 'error' }),
      ])
    } finally {
      app.unmount()
      output.destroy()
    }
  })
})

describe('teammate message delivery', () => {
  test('does not read or deliver without a bound consumer scope', async () => {
    delete state.teamContext!.consumerScope
    unreadMessages = [chat('alice', 'report')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => intervalCallback !== undefined)
      intervalCallback?.()
      await Bun.sleep(20)
      expect(readScoped).not.toHaveBeenCalled()
      expect(submitted).toEqual([])
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('does not deliver a batch invalidated after reading', async () => {
    unreadMessages = [chat('alice', 'report')]
    readUnread.mockImplementationOnce(async () => {
      scopeStatus = 'stale'
      return unreadMessages
    })
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => readScoped.mock.calls.length === 1)
      await Bun.sleep(20)
      expect(submitted).toEqual([])
      expect(markReadByIdentity).not.toHaveBeenCalled()
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('discards an invalidated queued batch without submitting or acknowledging it', async () => {
    scopeStatus = 'stale'
    unreadMessages = []
    state.inbox.messages = [{
      id: 'stale-queued', from: 'worker', text: 'old batch',
      timestamp: '2026-10-03T00:00:00.000Z', status: 'pending',
      consumerScope: state.teamContext?.consumerScope,
    }]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => state.inbox.messages.length === 0)
      expect(submitted).toEqual([])
      expect(markReadByIdentity).not.toHaveBeenCalled()
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('acknowledges exactly the delivered batch', async () => {
    unreadMessages = [chat('alice', 'report')]
    onSubmit = () => {
      // A teammate writes while this poll is still delivering.
      unreadMessages = [...unreadMessages, chat('bob', 'late result')]
      return true
    }
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toContain('report')
      expect(markReadByIdentity.mock.calls[0]?.[2]).toEqual([
        chat('alice', 'report'),
      ])
      expect(
        unreadMessages.filter(message => !message.read).map(m => m.text),
      ).toEqual(['late result'])
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('delivers mail queued during a busy turn with the shared envelope', async () => {
    unreadMessages = []
    state = {
      ...state,
      inbox: {
        messages: [
          {
            id: 'queued-1',
            from: 'worker',
            text: 'Finished the migration',
            timestamp: '2026-10-03T00:00:00.000Z',
            status: 'pending',
            consumerScope: state.teamContext?.consumerScope,
            summary: 'migration "done"',
          },
        ],
      },
    } as AppState
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => submitted.length === 1)

      expect(submitted[0]).toBe(
        '<teammate-message teammate_id="worker" summary="migration &quot;done&quot;" id="queued-1">\n' +
          'Finished the migration\n' +
          '</teammate-message>',
      )
      expect(state.inbox.messages).toEqual([])
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('keeps each queued envelope id when a busy turn releases a batch', async () => {
    unreadMessages = []
    state = {
      ...state,
      inbox: {
        messages: [
          {
            id: 'queued-1',
            from: 'user',
            text: 'status?',
            timestamp: '2026-10-03T00:00:00.000Z',
            status: 'pending',
            consumerScope: state.teamContext?.consumerScope,
          },
          {
            id: 'queued-2',
            from: 'task-list',
            text: 'ready',
            timestamp: '2026-10-03T00:00:01.000Z',
            status: 'pending',
            consumerScope: state.teamContext?.consumerScope,
          },
        ],
      },
    } as AppState
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => submitted.length === 1)

      // One prompt, two envelopes, two correlations: the second id must not be
      // dropped because the first one was formatted.
      expect(submitted[0]).toContain('id="queued-1"')
      expect(submitted[0]).toContain('id="queued-2"')
      expect(state.inbox.messages).toEqual([])
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('does not deliver a batch twice when polls overlap', async () => {
    unreadMessages = [chat('alice', 'report')]
    let openGate!: () => void
    readGate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => readUnread.mock.calls.length === 1)
      // The next interval tick fires while the first poll is still reading.
      intervalCallback?.()
      intervalCallback?.()
      openGate()
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)
      intervalCallback?.()
      await waitFor(() => readUnread.mock.calls.length === 2)
      await Bun.sleep(20)

      expect(submitted).toHaveLength(1)
      expect(markReadByIdentity).toHaveBeenCalledTimes(1)
    } finally {
      openGate()
      app.unmount()
      output.destroy()
    }
  })
})

describe('permission receipt claim ordering', () => {
  beforeEach(() => {
    isTeammateRole = true
    isTeamLeadRole = false
    agentNameValue = 'worker'
  })

  test('claims a permission response before processing it', async () => {
    unreadMessages = [permissionResponse('team-lead', 'perm-1')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => processedPermissionResponses.length === 1)
      expect(claimMailbox).toHaveBeenCalledTimes(1)
      expect(claimMailbox.mock.calls[0]?.[2]).toEqual([
        permissionResponse('team-lead', 'perm-1'),
      ])
      expect(handlerEvents.indexOf('claim')).toBeLessThan(
        handlerEvents.indexOf('process-permission'),
      )
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('claims a sandbox permission response before processing it', async () => {
    unreadMessages = [sandboxResponse('team-lead', 'sandbox-1')]
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => processedSandboxResponses.length === 1)
      expect(claimMailbox).toHaveBeenCalledTimes(1)
      expect(handlerEvents.indexOf('claim')).toBeLessThan(
        handlerEvents.indexOf('process-sandbox'),
      )
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('does not process a permission response when the instance is replaced before its claim', async () => {
    unreadMessages = [permissionResponse('team-lead', 'perm-1')]
    // Call #1 is the post-read batch fence (passes); call #2 is the receipt
    // claim commit, where the replacement lands. The handler must not run.
    rejectScopedCallAt = 2
    const output = new PassThrough()
    const app = render(<Harness />, { stdout: output, stderr: output, exitOnCtrlC: false })
    try {
      await waitFor(() => scopedCallCount >= 2)
      await Bun.sleep(20)
      expect(claimMailbox).not.toHaveBeenCalled()
      expect(processedPermissionResponses).toEqual([])
      expect(markReadByIdentity).not.toHaveBeenCalled()
      expect(unreadMessages.every(message => !message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })
})

function permissionContext(): AppState['toolPermissionContext'] {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as AppState['toolPermissionContext']
}

function chat(from: string, text: string): TeammateMessage {
  return {
    id: `mailbox-${from}-${text}`,
    from,
    text,
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function permissionRequest(from: string): TeammateMessage {
  return {
    id: `permission-${from}`,
    from,
    text: JSON.stringify({
      type: 'permission_request',
      request_id: 'perm-1',
      agent_id: from,
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      description: 'run tests',
      input: { command: 'bun test' },
    }),
    timestamp: new Date().toISOString(),
    read: false,
  }
}

function permissionResponse(from: string, requestId: string): TeammateMessage {
  return {
    id: `permission-response-${requestId}`,
    from,
    text: JSON.stringify({
      type: 'permission_response',
      request_id: requestId,
      subtype: 'success',
      response: {},
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function sandboxResponse(from: string, requestId: string): TeammateMessage {
  return {
    id: `sandbox-response-${requestId}`,
    from,
    text: JSON.stringify({
      type: 'sandbox_permission_response',
      requestId,
      host: 'example.com',
      allow: true,
      timestamp: '2026-10-03T00:00:00.000Z',
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function sandboxRequest(from: string): TeammateMessage {
  return {
    id: `sandbox-request-${from}`,
    from,
    text: JSON.stringify({
      type: 'sandbox_permission_request',
      requestId: 'sandbox-1',
      workerId: 'worker-id',
      workerName: from,
      hostPattern: { host: 'example.com' },
      createdAt: 123,
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function malformedSandboxRequest(): TeammateMessage {
  return {
    id: 'sandbox-request-malformed',
    from: 'worker',
    text: JSON.stringify({
      type: 'sandbox_permission_request',
      requestId: 'sandbox-2',
      workerId: 'worker-id',
      workerName: 'worker',
      hostPattern: {},
      createdAt: 124,
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function teamPermissionUpdate(from: string): TeammateMessage {
  return {
    id: `team-permission-update-${from}`,
    from,
    text: JSON.stringify({
      type: 'team_permission_update',
      permissionUpdate: {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'bun test:*' }],
        behavior: 'allow',
        destination: 'session',
      },
      directoryPath: '/tmp/project',
      toolName: 'Bash',
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function modeSetRequest(from: string, mode: string): TeammateMessage {
  return {
    id: `mode-set-${mode}`,
    from,
    text: JSON.stringify({ type: 'mode_set_request', mode, from }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function planApprovalRequest(from: string, requestId: string): TeammateMessage {
  return {
    id: `plan-approval-${requestId}`,
    from,
    text: JSON.stringify({
      type: 'plan_approval_request',
      from,
      timestamp: '2026-10-03T00:00:00.000Z',
      planFilePath: '/tmp/plan.md',
      planContent: 'Run the tests.',
      requestId,
    }),
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

function shutdownApproval(
  from: string,
  paneId: string,
): TeammateMessage {
  return {
    from,
    text: JSON.stringify({
      type: 'shutdown_approved',
      requestId: `shutdown-${from}`,
      from,
      timestamp: new Date().toISOString(),
      paneId,
      backendType: 'tmux',
    }),
    timestamp: new Date().toISOString(),
    read: false,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for inbox poller')
    }
    await Bun.sleep(10)
  }
}
