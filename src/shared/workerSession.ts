/**
 * Transcript `entrypoint` values written by hidden worker sessions.
 *
 * A worker is started by the server on behalf of a parent session (an approved
 * team member, or a pinned agent). Its transcript exists on disk, but it must
 * not show up as a session of its own in the session list.
 */
export const TEAM_WORKER_ENTRYPOINT = 'claude-desktop-team-worker'
export const PINNED_AGENT_ENTRYPOINT = 'claude-desktop-pinned-agent'

const HIDDEN_WORKER_ENTRYPOINTS: ReadonlySet<string> = new Set([
  TEAM_WORKER_ENTRYPOINT,
  PINNED_AGENT_ENTRYPOINT,
])

/** Whether a transcript entry's entrypoint marks a hidden worker session. */
export function isHiddenWorkerEntrypoint(entrypoint: unknown): boolean {
  return typeof entrypoint === 'string' && HIDDEN_WORKER_ENTRYPOINTS.has(entrypoint)
}

/**
 * Whether this process is a pinned agent worker.
 *
 * The task a pinned agent receives is plain content, not something to
 * interpret: a leading `/command` could otherwise switch the model the agent
 * was pinned to, or run a command the caller never named.
 */
export function isPinnedAgentWorkerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CC_HAHA_PINNED_AGENT_WORKER === '1'
}
