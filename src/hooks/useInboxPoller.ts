import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { getAllBaseTools } from '../tools.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentName,
  getConsumerScope,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  claimMailboxMessages,
  formatTeammateMessages,
  getTrustedShutdownApproval,
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  isTrustedTeamLeaderMessage,
  type TeammateMessage,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import {
  consumerInboxName,
  markScopedMailboxRead,
  mutateScopedTeam,
  readScopedMailbox,
  sameConsumerScope,
  withConsumerScope,
  type ConsumerScope,
} from '../utils/swarm/consumerScope.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * Get the agent name to poll for messages.
 * - In-process teammates return undefined (they use waitForNextPromptOrShutdown instead)
 * - Process-based teammates use their CLAUDE_CODE_AGENT_NAME
 * - Team leads use their name from teamContext.teammates
 * - Standalone sessions return undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // In-process teammates should NOT use useInboxPoller - they have their own
  // polling mechanism via waitForNextPromptOrShutdown() in inProcessRunner.ts.
  // Using useInboxPoller would cause message routing issues since in-process
  // teammates share the same React context and AppState with the leader.
  //
  // Note: This can be called when the leader's REPL re-renders while an
  // in-process teammate's AsyncLocalStorage context is active (due to shared
  // setAppState). We return undefined to gracefully skip polling rather than
  // throwing, since this is a normal occurrence during concurrent execution.
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // Team lead polls using their agent name (not ID)
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // Look up the lead's name from teammates map
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000

/**
 * Claims one receipt and runs its synchronous handler inside the same
 * lifecycle→config commit. There is no microtask window between the claim and
 * the handler: if the instance was replaced, neither the claim nor the handler
 * runs. The handler must stay synchronous (no network, model turn or yield).
 */
async function claimAndHandleReceipt(
  scope: ConsumerScope,
  message: TeammateMessage,
  handle: () => void,
): Promise<'handled' | 'deferred' | 'retryable_io'> {
  const result = await withConsumerScope(scope, async (current, team) => {
    const claimed = await claimMailboxMessages(
      consumerInboxName(current),
      team.name,
      [message],
    )
    if (!claimed || claimed.length === 0) return 'deferred' as const
    handle()
    return 'handled' as const
  })
  if (result.status === 'current') return result.value
  return result.status === 'retryable_io' ? 'retryable_io' : 'deferred'
}

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  // Returns true if submission succeeded, false if rejected (e.g., query already running)
  // Dead code elimination: parameter named onSubmitMessage to avoid "teammate" string in external builds
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * Polls the teammate inbox for new messages and submits them as turns.
 *
 * This hook:
 * 1. Polls every 1s for unread messages (teammates or team leads)
 * 2. When idle: submits messages immediately as a new turn
 * 3. When busy: queues messages in AppState.inbox for UI display, delivers when turn ends
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // Assign to original name for clarity within the function
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxMessageCount = useAppState(s => s.inbox.messages.length)
  const terminal = useTerminalNotification()
  const pollInFlightRef = useRef(false)

  const pollInbox = useCallback(async () => {
    if (!enabled) return

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return
    // The scope is the instance this session was bound to at creation or a
    // verified restore. Without one there is nothing trustworthy to consume
    // for: the current team file would happily describe a same-named
    // replacement, and its inbox is not this session's to read.
    const scope = getConsumerScope(currentAppState.teamContext)
    if (!scope) {
      logForDebugging('[InboxPoller] No consumer scope bound; skipping automatic inbox reads')
      return
    }

    const read = await readScopedMailbox(scope)
    if (read.status !== 'current') {
      if (read.status !== 'stale') {
        logForDebugging(`[InboxPoller] Mailbox read refused: ${read.status}`)
      }
      return
    }
    const unread = read.value
    if (unread.length === 0) return

    // C-ORDER for the hook: receive or queue locally first, then mark. Nothing
    // is claimed ahead of the handlers. Re-check the instance once here so a
    // replacement that committed during the read neither acts on this batch
    // nor marks it read; the final acceptance and mark check again.
    const currentInstance = await withConsumerScope(scope, () => true)
    if (currentInstance.status !== 'current') {
      logForDebugging(
        `[InboxPoller] Mailbox batch no longer current (${currentInstance.status}); leaving it unread`,
      )
      return
    }

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    const deferredProtocolReceipts: TeammateMessage[] = []
    // Ordinary protocol handlers receive first, then acknowledge. Every final
    // local effect revalidates under the same short lifecycle/config commit.
    const receiveProtocol = async (messages: TeammateMessage[], action: () => void | Promise<void>) => {
      const result = await withConsumerScope(scope, action)
      if (result.status !== 'current') {
        deferredProtocolReceipts.push(...messages)
        logForDebugging(`[InboxPoller] Protocol receive refused: ${result.status}; leaving unread`)
        return false
      }
      return true
    }

    // Check for plan approval responses and transition out of plan mode if approved
    // Security: Only accept approval responses from the team lead
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        // Verify the message is from the team lead to prevent teammates from forging approvals
        if (approvalResponse && msg.from === 'team-lead') {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            // Use leader's permission mode if provided, otherwise default
            const targetMode = approvalResponse.permissionMode ?? 'default'

            // Transition out of plan mode
            const received = await receiveProtocol([msg], () => { setAppState(prev => ({
              ...prev,
              toolPermissionContext: applyPermissionUpdate(
                prev.toolPermissionContext,
                {
                  type: 'setMode',
                  mode: toExternalPermissionMode(targetMode),
                  destination: 'session',
                },
              ),
            })) })
            if (!received) continue

            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else if (approvalResponse) {
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    let deferShutdownApprovals = false
    // Permission/sandbox responses are the contract exception to receive→mark:
    // they are only acted on after their own scoped claim succeeds. A response
    // whose claim refused stays unread instead of being archived with the rest
    // of this batch.

    // Helper to mark messages as read in the inbox file.
    // Called after messages are successfully delivered or reliably queued.
    // Acknowledges exactly this poll's batch: anything that arrived after the
    // read stays unread for the next poll.
    const markRead = async () => {
      const processed = (
        deferShutdownApprovals
          ? unread.filter(message => !isShutdownApproved(message.text))
          : unread
      ).filter(message => !deferredProtocolReceipts.includes(message))
      const marked = await markScopedMailboxRead(scope, processed)
      if (marked.status !== 'current') {
        // Never acknowledge into a replacement inbox: the batch belongs to the
        // scope this poll read, and that instance is gone.
        logForDebugging(`[InboxPoller] Mailbox acknowledgement refused: ${marked.status}`)
      }
    }

    // Separate permission messages from regular teammate messages
    const permissionRequests: TeammateMessage[] = []
    const permissionResponses: TeammateMessage[] = []
    const sandboxPermissionRequests: TeammateMessage[] = []
    const sandboxPermissionResponses: TeammateMessage[] = []
    const shutdownRequests: TeammateMessage[] = []
    const shutdownApprovals: TeammateMessage[] = []
    const teamPermissionUpdates: TeammateMessage[] = []
    const modeSetRequests: TeammateMessage[] = []
    const planApprovalRequests: TeammateMessage[] = []
    const regularMessages: TeammateMessage[] = []

    for (const m of unread) {
      const permReq = isPermissionRequest(m.text)
      const permResp = isPermissionResponse(m.text)
      const sandboxReq = isSandboxPermissionRequest(m.text)
      const sandboxResp = isSandboxPermissionResponse(m.text)
      const shutdownReq = isShutdownRequest(m.text)
      const shutdownApproval = isShutdownApproved(m.text)
      const teamPermUpdate = isTeamPermissionUpdate(m.text)
      const modeSetReq = isModeSetRequest(m.text)
      const planApprovalReq = isPlanApprovalRequest(m.text)

      if (permReq) {
        permissionRequests.push(m)
      } else if (permResp) {
        permissionResponses.push(m)
      } else if (sandboxReq) {
        sandboxPermissionRequests.push(m)
      } else if (sandboxResp) {
        sandboxPermissionResponses.push(m)
      } else if (shutdownReq) {
        shutdownRequests.push(m)
      } else if (shutdownApproval) {
        shutdownApprovals.push(m)
      } else if (teamPermUpdate) {
        teamPermissionUpdates.push(m)
      } else if (modeSetReq) {
        modeSetRequests.push(m)
      } else if (planApprovalReq) {
        planApprovalRequests.push(m)
      } else {
        regularMessages.push(m)
      }
    }

    // Handle permission requests (leader side) - route to ToolUseConfirmQueue
    if (
      permissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
      )

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const m of permissionRequests) {
        const parsed = isPermissionRequest(m.text)
        if (!parsed) continue

        if (setToolUseConfirmQueue) {
          // Route through the standard ToolUseConfirmQueue so tmux workers
          // get the same tool-specific UI (BashPermissionRequest, FileEditToolDiff, etc.)
          // as in-process teammates.
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.tool_use_id,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // No-op for tmux workers (no classifier auto-approval)
            },
            onAbort() {
              void receiveProtocol([m], async () => { await sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              ) })
            },
            onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
            ) {
              void receiveProtocol([m], async () => { await sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              ) })
            },
            onReject(feedback?: string) {
              void receiveProtocol([m], async () => { await sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              ) })
            },
            async recheckPermission() {
              // No-op for tmux workers — permission state is on the worker side
            },
          }

          // Deduplicate: if acknowledging failed on a prior poll,
          // the same message will be re-read — skip if already queued.
          await receiveProtocol([m], () => {
              setToolUseConfirmQueue(queue => {
                if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
                  return queue
                }
                return [...queue, entry]
            })
            })
          } else {
            deferredProtocolReceipts.push(m)
            logForDebugging(
              `[InboxPoller] ToolUseConfirmQueue unavailable, retaining permission request from ${parsed.agent_id}`,
            )
          }
        }

        // Send desktop notification for the first request
        const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
        if (firstParsed && !isLoading && !focusedInputDialog) {
          await receiveProtocol(permissionRequests, () => { void sendNotification(
            {
              message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          ) })
        }
      }

      // Handle permission responses (worker side) - invoke registered callbacks
      if (permissionResponses.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
        )

        for (const m of permissionResponses) {
          if (!isTrustedTeamLeaderMessage(m)) continue

          const parsed = isPermissionResponse(m.text)
          if (!parsed) continue

          if (hasPermissionCallback(parsed.request_id)) {
            // Contract exception: a permission response is processed only after
            // its own scoped claim succeeds, and the handler runs in that same
            // short commit. Awaiting a claim and then handling afterwards would
            // leave a microtask window outside the lock.
            const outcome = await claimAndHandleReceipt(scope, m, () => {
              logForDebugging(
                `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
              )
              if (parsed.subtype === 'success') {
                processMailboxPermissionResponse({
                  requestId: parsed.request_id,
                  decision: 'approved',
                  updatedInput: parsed.response?.updated_input,
                  permissionUpdates: parsed.response?.permission_updates,
                })
              } else {
                processMailboxPermissionResponse({
                  requestId: parsed.request_id,
                  decision: 'rejected',
                  feedback: parsed.error,
                })
              }
            })
            if (outcome !== 'handled') {
              deferredProtocolReceipts.push(m)
              logForDebugging(
                `[InboxPoller] Permission response left unread: claim ${outcome}`,
              )
            }
          }
        }
      }

      // Handle sandbox permission requests (leader side) - add to workerSandboxPermissions queue
      if (
        sandboxPermissionRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
        )

        const newSandboxRequests: Array<{
          requestId: string
          workerId: string
          workerName: string
          workerColor?: string
          host: string
          createdAt: number
        }> = []

        for (const m of sandboxPermissionRequests) {
          const parsed = isSandboxPermissionRequest(m.text)
          if (!parsed) continue

          // Validate required nested fields to prevent crashes from malformed messages
          if (!parsed.hostPattern?.host) {
            logForDebugging(
              `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
            )
            continue
          }

          newSandboxRequests.push({
            requestId: parsed.requestId,
            workerId: parsed.workerId,
            workerName: parsed.workerName,
            workerColor: parsed.workerColor,
            host: parsed.hostPattern.host,
            createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        const received = await receiveProtocol(sandboxPermissionRequests, () => {
          setAppState(prev => ({
            ...prev,
            workerSandboxPermissions: {
              ...prev.workerSandboxPermissions,
              queue: [
                ...prev.workerSandboxPermissions.queue,
                ...newSandboxRequests,
              ],
            },
        }))
        })

        // Send desktop notification for the first new request
        const firstRequest = newSandboxRequests[0]
        if (received && firstRequest && !isLoading && !focusedInputDialog) {
          await receiveProtocol(sandboxPermissionRequests, () => { void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          ) })
        }
      }
    }

    // Handle sandbox permission responses (worker side) - invoke registered callbacks
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const m of sandboxPermissionResponses) {
        if (!isTrustedTeamLeaderMessage(m)) continue

        const parsed = isSandboxPermissionResponse(m.text)
        if (!parsed) continue

        // Check if we have a registered callback for this request
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          // Same contract exception as permission responses: claim and run the
          // synchronous handler in one short commit, otherwise leave unread.
          const outcome = await claimAndHandleReceipt(scope, m, () => {
            logForDebugging(
              `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
            )

            // Process the response using the exported function
            processSandboxPermissionResponse({
              requestId: parsed.requestId,
              host: parsed.host,
              allow: parsed.allow,
            })

            // Clear the pending sandbox request indicator
            setAppState(prev => ({
              ...prev,
              pendingSandboxRequest: null,
            }))
          })
          if (outcome !== 'handled') {
            deferredProtocolReceipts.push(m)
            logForDebugging(
              `[InboxPoller] Sandbox permission response left unread: claim ${outcome}`,
            )
          }
        }
      }
    }

    // Handle team permission updates (teammate side) - apply permission to context
    if (teamPermissionUpdates.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
      )

      for (const m of teamPermissionUpdates) {
        if (!isTrustedTeamLeaderMessage(m)) continue

        const parsed = isTeamPermissionUpdate(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse team permission update: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        // Validate required nested fields to prevent crashes from malformed messages
        if (
          !parsed.permissionUpdate?.rules ||
          !parsed.permissionUpdate?.behavior
        ) {
          logForDebugging(
            `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
          )
          continue
        }

        // Apply the permission update to the teammate's context
        logForDebugging(
          `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
        )
        logForDebugging(
          `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
        )

        await receiveProtocol([m], () => {
          setAppState(prev => {
            const updated = applyPermissionUpdate(prev.toolPermissionContext, {
              type: 'addRules',
              rules: parsed.permissionUpdate.rules,
              behavior: parsed.permissionUpdate.behavior,
              destination: 'session',
            })
            logForDebugging(
              `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
            )
            return {
              ...prev,
              toolPermissionContext: updated,
            }
        })
        })
      }
    }

    // Handle mode set requests (teammate side) - team lead changing teammate's mode
    if (modeSetRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`,
      )

      for (const m of modeSetRequests) {
        // Only accept mode changes from team-lead
        if (m.from !== TEAM_LEAD_NAME) {
          logForDebugging(
            `[InboxPoller] Ignoring mode set request from non-team-lead: ${m.from}`,
          )
          continue
        }

        const parsed = isModeSetRequest(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse mode set request: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        const targetMode = permissionModeFromString(parsed.mode)
        logForDebugging(
          `[InboxPoller] Applying mode change from team-lead: ${targetMode}`,
        )

        const changed = await mutateScopedTeam(scope, team => {
          const member = team.members.find(member => member.name === getAgentName())
          if (member) member.mode = targetMode
        })
        if (changed.status !== 'current') {
          deferredProtocolReceipts.push(m)
          continue
        }
        await receiveProtocol([m], () => {
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdate(
              prev.toolPermissionContext,
              {
                type: 'setMode',
                mode: toExternalPermissionMode(targetMode),
                destination: 'session',
              },
            ),
        }))
        })
      }
    }

    // Handle plan approval requests (leader side) - auto-approve and write response to teammate inbox
    if (
      planApprovalRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit =
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const m of planApprovalRequests) {
        const parsed = isPlanApprovalRequest(m.text)
        if (!parsed) continue

        // Write approval response to teammate's inbox
        const approvalResponse = {
          type: 'plan_approval_response',
          requestId: parsed.requestId,
          approved: true,
          timestamp: new Date().toISOString(),
          permissionMode: modeToInherit,
        }

        const received = await receiveProtocol([m], async () => {
          await writeToMailbox(
            m.from,
            {
              from: TEAM_LEAD_NAME,
              text: jsonStringify(approvalResponse),
              timestamp: new Date().toISOString(),
            },
            teamName,
          )

          // Update in-process teammate task state if applicable
          const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
          if (taskId) {
            handlePlanApprovalResponse(
              taskId,
              {
                type: 'plan_approval_response',
                requestId: parsed.requestId,
                approved: true,
                timestamp: new Date().toISOString(),
                permissionMode: modeToInherit,
              },
              setAppState,
            )
          }

        })
        if (!received) continue

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // Still pass through as a regular message so the model has context
        // about what the teammate is doing, but the approval is already sent
        regularMessages.push(m)
      }
    }

    // Handle shutdown requests (teammate side) - preserve JSON for UI rendering
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
      )

      // Pass through shutdown requests - the UI component will render them nicely
      // and the model will receive instructions via the tool prompt documentation
      for (const m of shutdownRequests) {
        regularMessages.push(m)
      }
    }

    // Handle shutdown approvals (leader side) - kill the teammate's pane
    if (
      shutdownApprovals.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
      )

      // Backend discovery is preparation, not authority to act. Resolve it
      // outside the commit, then re-read the trusted target under both locks.
      await ensureBackendsRegistered()
      const insideTmux = await isInsideTmux()
      for (const m of shutdownApprovals) {
        const removed = await mutateScopedTeam(scope, async team => {
          const parsed = getTrustedShutdownApproval(m, team.members)
          if (!parsed) return undefined
          if (parsed.paneId && parsed.backendType) {
            try {
              const backend = getBackendByType(parsed.backendType as PaneBackendType)
              const success = await backend?.killPane(parsed.paneId, !insideTmux)
              logForDebugging(`[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.name}: ${success}`)
            } catch (error) {
              logForDebugging(`[InboxPoller] Failed to kill pane for ${parsed.name}: ${error}`)
            }
          }
          // Mutate this already-locked file, never enter the config lock again.
          team.members = team.members.filter(member => member.agentId !== parsed.agentId)
          const { notificationMessage } = await unassignTeammateTasks(
            team.name, parsed.agentId, parsed.name, 'shutdown',
          )
          return { parsed, notificationMessage }
        })
        if (removed.status !== 'current') {
          deferShutdownApprovals = true
          logForDebugging(`[InboxPoller] Shutdown commit refused: ${removed.status}; leaving unread`)
          break
        }
        if (!removed.value) continue
        const { parsed, notificationMessage } = removed.value
        const teammateToRemove = parsed.name
        const teammateId = parsed.agentId
        const received = await receiveProtocol([m], () => {
            setAppState(prev => {
              if (!prev.teamContext?.teammates) return prev
              if (!(teammateId in prev.teamContext.teammates)) return prev
              const { [teammateId]: _, ...remainingTeammates } =
                prev.teamContext.teammates

              // Mark the teammate's task as completed so hasRunningTeammates
              // becomes false and the spinner stops. Without this, out-of-process
              // (tmux) teammate tasks stay status:'running' forever because
              // only in-process teammates have a runner that sets 'completed'.
              const updatedTasks = { ...prev.tasks }
              for (const [tid, task] of Object.entries(updatedTasks)) {
                if (
                  isInProcessTeammateTask(task) &&
                  task.identity.agentId === teammateId
                ) {
                  updatedTasks[tid] = {
                    ...task,
                    status: 'completed' as const,
                    endTime: Date.now(),
                  }
                }
              }

              return {
                ...prev,
                tasks: updatedTasks,
                teamContext: {
                  ...prev.teamContext,
                  teammates: remainingTeammates,
                },
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                      consumerScope: scope,
                    },
                  ],
                },
              }
            })
        })
        if (!received) continue

        // Pass through for UI rendering - the component will render it nicely
        regularMessages.push(m)
      }
    }

    // Process regular teammate messages (existing logic)
    if (regularMessages.length === 0) {
      // No regular messages, but we may have processed non-regular messages
      // (permissions, shutdown requests, etc.) above — mark those as read.
      await markRead()
      return
    }

    // Format messages with XML wrapper for Claude (include color if available)
    // Transform plan approval requests to include instructions for Claude
    const formatted = formatTeammateMessages(regularMessages)

    // Helper to queue messages in AppState for later delivery
    const queueMessages = () => {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map(m => ({
              // Keep the mailbox envelope id so the queued turn carries the
              // same correlation the live path would have delivered.
              id: m.id ?? randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              consumerScope: scope,
              color: m.color,
              summary: m.summary,
            })),
          ],
        },
      }))
    }

    const accepted = await withConsumerScope(scope, () => {
      if (!sameConsumerScope(getConsumerScope(store.getState().teamContext), scope)) return false
      // 最终交接必须同步完成；格式化与磁盘读取不等同于接纳输入。
      if (!isLoading && !focusedInputDialog) {
        if (!onSubmitTeammateMessage(formatted)) queueMessages()
      } else {
        queueMessages()
      }
      return true
    })
    if (accepted.status !== 'current' || !accepted.value) return

    // Mark messages as read only after they have been successfully delivered
    // or reliably queued in AppState. This prevents permanent message loss
    // when the session is busy — if we crash before this point, the messages
    // will be re-read on the next poll cycle instead of being silently dropped.
    await markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  // The interval fires every second whether or not the previous poll has
  // finished. A poll that is still delivering has not acknowledged its batch
  // yet, so an overlapping poll would read and deliver the same messages again.
  const poll = useCallback(async () => {
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true
    try {
      await pollInbox()
    } finally {
      pollInFlightRef.current = false
    }
  }, [pollInbox])

  // When session becomes idle, deliver any pending messages and clean up processed ones
  useEffect(() => {
    if (!enabled) return

    // Skip if busy or in a dialog
    if (isLoading || focusedInputDialog) {
      return
    }

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const pendingMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'pending',
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // Clean up processed messages (they were already delivered mid-turn as attachments)
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    // No pending messages to deliver
    if (pendingMessages.length === 0) return

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    let cancelled = false
    void (async () => {
      // 延迟项只使用入队时绑定的身份，禁止继承当前同名团队的身份。
      const scope = pendingMessages[0]?.consumerScope
      if (!scope) return
      const batch = pendingMessages.filter(m => sameConsumerScope(m.consumerScope, scope))
      const formatted = formatTeammateMessages(batch)
      const submittedIds = new Set(batch.map(m => m.id))
      const result = await withConsumerScope(scope, () => {
        if (cancelled || !sameConsumerScope(getConsumerScope(store.getState().teamContext), scope)) return false
        if (!onSubmitTeammateMessage(formatted)) return false
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
          },
        }))
        return true
      })
      if (result.status === 'stale' || result.status === 'unsupported' || result.status === 'unbound') {
        logForDebugging(
          `[InboxPoller] Dropping queued batch for a ${result.status} consumer scope`,
        )
        setAppState(prev => ({
          ...prev,
          inbox: { messages: prev.inbox.messages.filter(m => !batch.includes(m)) },
        }))
      } else if (result.status === 'current' && result.value === false) {
        // Stop/rejection keeps the already-claimed local batch for the same
        // scope; it is retried after the instance is current again.
        logForDebugging(
          '[InboxPoller] Queued batch not accepted; retaining it for the same scope',
        )
      } else if (result.status === 'retryable_io') {
        logForDebugging(
          '[InboxPoller] Scope recheck failed with retryable I/O; retaining the queued batch',
        )
      }
    })()
    return () => { cancelled = true }
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    inboxMessageCount,
    store,
  ])

  // Poll if running as a teammate or as a team lead
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // Initial poll on mount (only once)
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // Use store.getState() to avoid dependency on appState object
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, poll, store])
}
