/**
 * Which team/member instance a consumer is allowed to act for.
 *
 * Inboxes are addressed by team + agent name, and both outlive nothing: a
 * deleted team can be recreated under the same name and a member can be
 * replaced by one with the same name. A name therefore says where mail goes,
 * never who may collect it. This module carries the second half: the creation
 * tuple plus the member instance a runtime was bound to when it started or was
 * legitimately restored.
 *
 * Scopes are issued by creation, trusted registration and verified recovery
 * only. Consumers may check a scope, never mint or upgrade one from whatever
 * the current team file happens to say.
 */

import { readFile } from 'node:fs/promises'
import {
  getCanonicalTeamTaskListId,
  readTaskListLifecycleState,
  withTaskListLifecycleLock,
} from '../tasks.js'
import { getErrnoCode } from '../errors.js'
import {
  claimMailboxMessages,
  markMessagesAsReadByIdentity,
  readUnreadMessages,
  type TeammateMessage,
} from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { getTeamFilePath, replaceTeamFileAsync, type TeamFile, withTeamFileLock } from './teamHelpers.js'
import { isPaneBackend } from './backends/types.js'

export type ConsumerBackend = 'in-process' | 'pane' | 'process'

export type ConsumerRecipient =
  | { kind: 'lead' }
  | {
      kind: 'member'
      backend: ConsumerBackend
      agentName: string
      /** Per-registration identity; name and agentId are reusable addresses. */
      memberInstanceId: string
      /** Required for process members: the worker session this instance owns. */
      memberSessionId?: string
    }

export type ConsumerScope = {
  version: 1
  teamName: string
  /** Canonical task-list lifecycle generation for this team incarnation. */
  generation: number
  createdAt: number
  leadSessionId: string
  /**
   * The session this consumer actually runs in: the lead session, a pane or
   * worker session, or an in-process teammate's parent session.
   */
  ownerSessionId: string
  recipient: ConsumerRecipient
}

export type ParsedConsumerScope =
  | { status: 'bound'; scope: ConsumerScope }
  | { status: 'unbound' }
  | { status: 'unsupported' }

export type ScopeCheck<T> =
  | { status: 'current'; value: T }
  | { status: 'stale' | 'unbound' | 'unsupported' | 'retryable_io' }

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

function parseRecipient(raw: unknown): ConsumerRecipient | null {
  if (typeof raw !== 'object' || raw === null) return null
  const recipient = raw as Record<string, unknown>
  if (recipient.kind === 'lead') return { ...recipient, kind: 'lead' }
  if (recipient.kind !== 'member') return null
  if (
    !nonEmpty(recipient.agentName) ||
    !nonEmpty(recipient.memberInstanceId) ||
    (recipient.backend !== 'in-process' &&
      recipient.backend !== 'pane' &&
      recipient.backend !== 'process')
  ) {
    return null
  }
  if (recipient.backend === 'process' && !nonEmpty(recipient.memberSessionId)) {
    return null
  }
  if (
    recipient.memberSessionId !== undefined &&
    !nonEmpty(recipient.memberSessionId)
  ) {
    return null
  }
  return {
    ...recipient,
    kind: 'member',
    backend: recipient.backend,
    agentName: recipient.agentName,
    memberInstanceId: recipient.memberInstanceId,
    ...(recipient.memberSessionId !== undefined
      ? { memberSessionId: recipient.memberSessionId }
      : {}),
  }
}

/**
 * Reads a scope from an untrusted carrier (disk metadata, a control message,
 * an environment variable). Anything this build cannot interpret is refused:
 * a scope is never repaired from the current team, and an unknown version is
 * not treated as "old but harmless".
 */
export function parseConsumerScope(raw: unknown): ParsedConsumerScope {
  if (raw === undefined || raw === null) return { status: 'unbound' }
  if (typeof raw === 'string') {
    try {
      return parseConsumerScope(JSON.parse(raw))
    } catch {
      return { status: 'unsupported' }
    }
  }
  if (typeof raw !== 'object') return { status: 'unsupported' }
  const candidate = raw as Record<string, unknown>
  // A record without a version belongs to a writer that predates scopes.
  if (candidate.version === undefined) return { status: 'unbound' }
  if (candidate.version !== 1) return { status: 'unsupported' }
  if (
    !nonEmpty(candidate.teamName) ||
    !nonEmpty(candidate.leadSessionId) ||
    !nonEmpty(candidate.ownerSessionId) ||
    typeof candidate.generation !== 'number' ||
    !Number.isInteger(candidate.generation) ||
    candidate.generation < 0 ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return { status: 'unsupported' }
  }
  const recipient = parseRecipient(candidate.recipient)
  if (!recipient) return { status: 'unsupported' }
  return {
    status: 'bound',
    scope: {
      ...candidate,
      version: 1,
      teamName: candidate.teamName,
      generation: candidate.generation,
      createdAt: candidate.createdAt,
      leadSessionId: candidate.leadSessionId,
      ownerSessionId: candidate.ownerSessionId,
      recipient,
    },
  }
}

/**
 * Stable identity key. Two scopes are the same consumer when every field
 * matches; comparing serialized objects would depend on key order.
 */
export function consumerScopeKey(scope: ConsumerScope): string {
  const recipient = scope.recipient.kind === 'lead'
    ? ['lead']
    : ['member', scope.recipient.backend, scope.recipient.agentName,
        scope.recipient.memberInstanceId, scope.recipient.memberSessionId ?? null]
  return JSON.stringify([
    scope.version,
    scope.teamName,
    scope.generation,
    scope.createdAt,
    scope.leadSessionId,
    scope.ownerSessionId,
    recipient,
  ])
}

export function sameConsumerScope(
  left: ConsumerScope | undefined,
  right: ConsumerScope | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    consumerScopeKey(left) === consumerScopeKey(right)
}

async function readTeamFileStrict(teamName: string): Promise<TeamFile | null> {
  try {
    return JSON.parse(await readFile(getTeamFilePath(teamName), 'utf-8')) as TeamFile
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  }
}

function memberIsCurrent(team: TeamFile, scope: ConsumerScope): boolean {
  if (scope.recipient.kind === 'lead') {
    return scope.ownerSessionId === scope.leadSessionId
  }
  const { backend, agentName, memberInstanceId, memberSessionId } = scope.recipient
  const matches = team.members.filter(member =>
    member.name === agentName && member.consumerInstanceId === memberInstanceId)
  if (matches.length !== 1) return false
  const member = matches[0]!
  if (backend === 'pane') {
    return member.backendType !== undefined && isPaneBackend(member.backendType) &&
      member.sessionId === scope.ownerSessionId
  }
  if ((member.backendType ?? 'process') !== backend) return false
  if (backend === 'process') return member.sessionId === memberSessionId && memberSessionId === scope.ownerSessionId
  return true
}

async function scopeIsCurrent(scope: ConsumerScope): Promise<ScopeCheck<TeamFile>> {
  const taskListId = getCanonicalTeamTaskListId(scope.teamName)
  const lifecycle = await readTaskListLifecycleState(taskListId)
  const identity = lifecycle.activeIdentity
  if (
    lifecycle.deleted ||
    lifecycle.generation !== scope.generation ||
    !identity ||
    identity.teamName !== scope.teamName ||
    identity.createdAt !== scope.createdAt ||
    identity.leadSessionId !== scope.leadSessionId
  ) {
    return { status: 'stale' }
  }
  const team = await readTeamFileStrict(scope.teamName)
  if (
    !team ||
    team.name !== scope.teamName ||
    team.createdAt !== scope.createdAt ||
    team.leadSessionId !== scope.leadSessionId
  ) {
    return { status: 'stale' }
  }
  if (!memberIsCurrent(team, scope)) return { status: 'stale' }
  return { status: 'current', value: team }
}

/**
 * Runs `action` only while the scope still names the live instance.
 *
 * Lock order is lifecycle → config, the same order creation, deletion and
 * member replacement use, so a replacement either commits before this check
 * (and the action never runs) or waits for it (and the action is legitimately
 * the old instance's). `action` must not await the network, a model turn or a
 * retry loop: everything that can be prepared outside is prepared outside.
 */
export async function withConsumerScope<T>(
  rawScope: unknown,
  action: (scope: ConsumerScope, team: TeamFile) => T | Promise<T>,
  options: { expectedOwnerSessionId?: string } = {},
): Promise<ScopeCheck<T>> {
  const parsed = parseConsumerScope(rawScope)
  if (parsed.status !== 'bound') return { status: parsed.status }
  const scope = parsed.scope
  if (
    options.expectedOwnerSessionId !== undefined &&
    options.expectedOwnerSessionId !== scope.ownerSessionId
  ) {
    return { status: 'stale' }
  }
  const taskListId = getCanonicalTeamTaskListId(scope.teamName)
  try {
    return await withTaskListLifecycleLock(taskListId, async () => {
      let checked: ScopeCheck<TeamFile>
      try {
        checked = await scopeIsCurrent(scope)
      } catch (error) {
        // A team directory that vanished under us is a replaced instance, not
        // an I/O failure to retry against the new one.
        if (getErrnoCode(error) === 'ENOENT') return { status: 'stale' }
        return { status: 'retryable_io' }
      }
      if (checked.status !== 'current') return checked
      try {
        return await withTeamFileLock(scope.teamName, async () => {
          let rechecked: ScopeCheck<TeamFile>
          try {
            rechecked = await scopeIsCurrent(scope)
          } catch (error) {
            if (getErrnoCode(error) === 'ENOENT') return { status: 'stale' }
            return { status: 'retryable_io' }
          }
          if (rechecked.status !== 'current') return rechecked
          return { status: 'current', value: await action(scope, rechecked.value) }
        })
      } catch (error) {
        if (getErrnoCode(error) === 'ENOENT') return { status: 'stale' }
        return { status: 'retryable_io' }
      }
    })
  } catch {
    return { status: 'retryable_io' }
  }
}

/** 在已验证的生命周期和配置锁内提交，不重新进入配置锁。 */
export async function mutateScopedTeam<T>(
  rawScope: unknown,
  mutate: (team: TeamFile, scope: ConsumerScope) => T | Promise<T>,
  options: { expectedOwnerSessionId?: string } = {},
): Promise<ScopeCheck<T>> {
  return withConsumerScope(rawScope, async (scope, team) => {
    const before = JSON.stringify(team, null, 2)
    const value = await mutate(team, scope)
    const after = JSON.stringify(team, null, 2)
    if (after !== before) await replaceTeamFileAsync(scope.teamName, after)
    return value
  }, options)
}

/** 旧运行者的延迟回滚只能移除它自己预留的实例。 */
export async function removeScopedMember(
  scope: ConsumerScope | undefined,
  agentId: string,
): Promise<ScopeCheck<boolean>> {
  return mutateScopedTeam(scope, (team, current) => {
    if (current.recipient.kind !== 'member') return false
    const recipient = current.recipient
    const index = team.members.findIndex(member => member.agentId === agentId &&
      member.name === recipient.agentName && member.consumerInstanceId === recipient.memberInstanceId)
    if (index === -1) return false
    team.members.splice(index, 1)
    return true
  })
}

/**
 * Builds the scope for a member that a trusted registration just committed.
 * Callers must already hold the registration's write lock; this only packages
 * the identity they committed.
 */
export function memberConsumerScope(input: {
  team: Pick<TeamFile, 'name' | 'createdAt' | 'leadSessionId'>
  generation: number
  ownerSessionId: string
  backend: ConsumerBackend
  agentName: string
  memberInstanceId: string
  memberSessionId?: string
}): ConsumerScope {
  return {
    version: 1,
    teamName: input.team.name,
    generation: input.generation,
    createdAt: input.team.createdAt,
    leadSessionId: input.team.leadSessionId ?? '',
    ownerSessionId: input.ownerSessionId,
    recipient: {
      kind: 'member',
      backend: input.backend,
      agentName: input.agentName,
      memberInstanceId: input.memberInstanceId,
      ...(input.memberSessionId !== undefined
        ? { memberSessionId: input.memberSessionId }
        : {}),
    },
  }
}

export function leadConsumerScope(input: {
  team: Pick<TeamFile, 'name' | 'createdAt' | 'leadSessionId'>
  generation: number
  ownerSessionId: string
}): ConsumerScope {
  return {
    version: 1,
    teamName: input.team.name,
    generation: input.generation,
    createdAt: input.team.createdAt,
    leadSessionId: input.team.leadSessionId ?? '',
    ownerSessionId: input.ownerSessionId,
    recipient: { kind: 'lead' },
  }
}

/**
 * Mailbox address this consumer owns. The name is where mail is delivered;
 * the scope is what proves this runtime may collect it.
 */
export function consumerInboxName(scope: ConsumerScope): string {
  return scope.recipient.kind === 'lead'
    ? TEAM_LEAD_NAME
    : scope.recipient.agentName
}

/**
 * Reads the consumer's unread messages, but only while the scope still names
 * the live team and member. History reads (readMailboxHistory) are not gated:
 * looking at what a team already received never grants consumption.
 */
export async function readScopedMailbox(
  scope: ConsumerScope,
): Promise<ScopeCheck<TeammateMessage[]>> {
  return withConsumerScope(scope, (current, team) =>
    readUnreadMessages(consumerInboxName(current), team.name))
}

/**
 * Claims exactly the candidates the caller read. A scope that was replaced
 * between the read and the claim refuses: the batch belongs to the old inbox
 * and must not archive anything in the new one.
 */
export type ScopedMailboxClaim =
  | { status: 'claimed'; messages: TeammateMessage[] }
  | { status: 'stale' | 'unbound' | 'unsupported' | 'retryable_io' | 'commit_uncertain' }

export async function claimScopedMailbox(
  scope: ConsumerScope,
  candidates: readonly TeammateMessage[],
): Promise<ScopedMailboxClaim> {
  const result = await withConsumerScope(scope, (current, team) =>
    claimMailboxMessages(consumerInboxName(current), team.name, candidates))
  if (result.status !== 'current') return result
  // 邮箱先写 history 再写 live；失败不能声称没有任何持久化副作用。
  return result.value === undefined
    ? { status: 'commit_uncertain' }
    : { status: 'claimed', messages: result.value }
}

/** Marks delivered messages read under the same instance check as a claim. */
export async function markScopedMailboxRead(
  scope: ConsumerScope,
  delivered: readonly TeammateMessage[],
): Promise<ScopeCheck<boolean>> {
  return withConsumerScope(scope, (current, team) =>
    markMessagesAsReadByIdentity(consumerInboxName(current), team.name, delivered))
}
