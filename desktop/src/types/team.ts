// Source: src/server/services/teamService.ts, src/server/ws/events.ts

import type { TaskDelivery } from '../../../src/shared/taskDelivery'

export type TeamSummary = {
  name: string
  memberCount: number
  createdAt?: string
  incarnationId?: string
}

/**
 * Whether a teammate is mid-turn right now, as reported by the server. Distinct
 * from `status`, which says whether the member is still part of the run. Owning
 * an `in_progress` task is evidence of neither: a teammate marks a task started
 * and can then end its turn, and an umbrella task stays open underneath every
 * turn it covers.
 *
 * `stopped` is a member whose process is gone (the user's Stop, a crash, a
 * closed lead). Unlike `exited`, it is still on the team: a message restarts it
 * from its saved conversation.
 */
export type TeamMemberActivity = 'active' | 'idle' | 'exited' | 'stopped' | 'unknown'

/** An automatic continuation the server scheduled after a transient provider failure. */
export type TeamMemberAutoRetry = {
  attempt: number
  max: number
  /** Epoch milliseconds. */
  nextAt: number
}

export type TeamMember = {
  agentId: string
  name?: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  activity?: TeamMemberActivity
  /**
   * The runtime's own statement that this approved member waits for its first
   * ready task: it holds a reserved address but no process, and has never run.
   * It is removed once the member really starts, so it never describes a member
   * that merely finished a turn -- which is what `idle` would claim. A member
   * carrying it is not terminated: there was no process to lose. Payloads that
   * predate the field simply omit it; the board then falls back to roster
   * evidence (see `standbyMember`), so this must stay optional.
   */
  awaitingDependencies?: boolean
  /**
   * The runtime's explicit statement that this member has never run: its
   * approved instructions are held and its first start is a new conversation.
   * Absent on team files written before the field existed — those members had
   * already started, even when their instructions were deferred — so absence
   * must not be read as "never started".
   */
  initialStartPending?: boolean
  /** Why the member's last turn failed. Kept while an automatic retry is pending. */
  lastError?: string
  autoRetry?: TeamMemberAutoRetry
  currentTask?: string
  color?: AgentColor
  sessionId?: string
  model?: string
  providerId?: string | null
  providerName?: string
}

export type TeamDetail = {
  name: string
  incarnationId?: string
  leadAgentId?: string
  leadSessionId?: string
  members: TeamMember[]
  createdAt?: string
  /**
   * How many times the user has stopped this team, as the server recorded it.
   * Absent on a server that does not count Stops; a pending message is then
   * never settled by one.
   */
  stopEpoch?: number
}

export type TeamWorkbenchTask = {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  taskListId: string
  /** Owner submissions and the independent review that settles each version. */
  delivery?: TaskDelivery
  /**
   * Present when the server could not interpret the stored history (a newer
   * schema version, or damage on disk). `delivery` is then the protocol's empty
   * history, so this reason — not the absence of submissions — is what says the
   * task is read-only. The raw record never reaches the desktop.
   */
  deliveryError?: string
}

export type TeamWorkbenchMessage = {
  id: string
  from: string
  to: string | '*'
  recipients: string[]
  kind: 'direct' | 'broadcast' | 'system'
  text: string
  summary?: string
  timestamp: string
  color?: string
  taskId?: string
  protocolType?: string
}

export type TeamWorkbenchSnapshot = {
  version: string
  generatedAt: string
  taskListRevision?: number
  terminalTaskFrameId?: string
  team: TeamDetail
  tasks: TeamWorkbenchTask[]
  messages: TeamWorkbenchMessage[]
  deletedAt?: string
}

export type TeamWorkbenchTimeline = {
  teamName: string
  snapshots: TeamWorkbenchSnapshot[]
  loading: boolean
  error: string | null
}

export type TeamWorkbenchSessionTimeline = {
  sessionId: string
  teamName: string
  incarnationId?: string
  snapshots: TeamWorkbenchSnapshot[]
  source: 'live' | 'archive' | 'transcript'
}

export type AgentColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'

export const AGENT_COLORS: AgentColor[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

export function teamMemberSessionId(agentId: string, incarnationId?: string): string {
  if (!incarnationId) return `team-member:${agentId}`
  return `team-member:${encodeURIComponent(incarnationId)}:${encodeURIComponent(agentId)}`
}

/** Lifecycle message types that should be filtered from agent output display */
export const AGENT_LIFECYCLE_TYPES = new Set([
  'shutdown_approved',
  'shutdown_rejected',
  'shutdown_request',
  'teammate_terminated',
  'idle_notification',
])
