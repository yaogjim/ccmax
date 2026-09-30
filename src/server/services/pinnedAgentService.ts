import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { PinnedAgentBlock, PinnedAgentErrorCode, PinnedAgentEvent, PinnedAgentUsage } from '../../shared/pinnedAgent.js'
import { teamPlanAgentSnapshotSchema } from '../../shared/teamPlan.js'
import { resolveAgentRuntimeBinding } from '../../tools/AgentTool/agentRuntimeBindings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { ApiError } from '../middleware/errorHandler.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { validateAgentPresetSnapshot } from './agentPresetValidation.js'
import { AgentRuntimeModelError, resolveAgentRuntimeModel } from './agentRuntimeModel.js'
import { ConversationStartupError, conversationService as defaultConversation, type ConversationService } from './conversationService.js'
import { ProviderService } from './providerService.js'

/** Concurrent pinned workers one parent session may have. Excess is refused, never queued. */
export const MAX_PINNED_WORKERS_PER_PARENT = 3

const WATCH_INTERVAL_MS = 250
const CONTROL_TIMEOUT_MS = 30_000
const MAX_PROGRESS_TEXT_CHARS = 4_000
const MAX_TOOL_INPUT_JSON_CHARS = 2_000
const MAX_TOOL_RESULT_CHARS = 2_000

// The runtime (provider + model) is deliberately absent: it comes from the
// user's settings, read here, and can never be chosen by the caller. `.strict()`
// turns any attempt to send one into a 400.
const pinnedAgentRequestSchema = z.object({
  agentType: z.string().trim().min(1).max(200),
  definition: teamPlanAgentSnapshotSchema,
  prompt: z.string().refine(value => value.trim().length > 0, 'prompt must not be empty'),
  description: z.string().optional(),
  toolUseId: z.string().optional(),
  agentId: z.string().optional(),
}).strict()

const RUNTIME_FIELDS = ['providerId', 'modelId', 'provider', 'model', 'runtime'] as const

export type PinnedAgentRunRequest = z.infer<typeof pinnedAgentRequestSchema>

export type { PinnedAgentBlock, PinnedAgentErrorCode, PinnedAgentEvent, PinnedAgentUsage }

export type PinnedAgentRun = {
  workerSessionId: string
  events: AsyncIterable<PinnedAgentEvent>
  /** Stops the worker. Idempotent; a result already delivered wins. */
  cancel(): Promise<void>
}

function createEventQueue<T>() {
  const items: T[] = []
  let closed = false
  let wake: (() => void) | null = null
  return {
    push(item: T) {
      if (closed) return
      items.push(item)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length) {
          yield items.shift()!
          continue
        }
        if (closed) return
        await new Promise<void>(resolve => { wake = resolve })
        wake = null
      }
    },
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text
}

function boundedInput(input: unknown): unknown {
  let json: string | undefined
  try { json = JSON.stringify(input) } catch { json = undefined }
  if (json === undefined || json.length <= MAX_TOOL_INPUT_JSON_CHARS) return input ?? {}
  return { _truncated: true, preview: json.slice(0, MAX_TOOL_INPUT_JSON_CHARS) }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Compact projection of a worker SDK message for the parent's card. Null = not shown. */
export function projectWorkerMessage(message: any): Extract<PinnedAgentEvent, { type: 'progress' }> | null {
  // Messages tagged with a parent tool use belong to the worker's own nested
  // subagents; the card shows the worker's top-level activity only.
  if (!message || message.parent_tool_use_id) return null
  const content = message.message?.content
  if (!Array.isArray(content)) return null
  if (message.type === 'assistant') {
    const blocks: PinnedAgentBlock[] = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        blocks.push({ type: 'text', text: truncate(block.text, MAX_PROGRESS_TEXT_CHARS) })
      } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: boundedInput(block.input) })
      }
    }
    return blocks.length ? { type: 'progress', kind: 'assistant', blocks } : null
  }
  if (message.type === 'user') {
    const blocks: PinnedAgentBlock[] = []
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        blocks.push({ type: 'tool_result', toolUseId: block.tool_use_id, isError: block.is_error === true, text: truncate(toolResultText(block.content), MAX_TOOL_RESULT_CHARS) })
      }
    }
    return blocks.length ? { type: 'progress', kind: 'tool_result', blocks } : null
  }
  return null
}

type Dependencies = {
  conversation?: ConversationService
  providers?: Pick<ProviderService, 'getProvider'>
  maxPerParent?: number
  watchIntervalMs?: number
  /** Requires this callback to answer where a worker connects back; default is the running server. */
  serverPort?: () => number
}

export class PinnedAgentService {
  private readonly conversation: ConversationService
  private readonly providers: Pick<ProviderService, 'getProvider'>
  private readonly maxPerParent: number
  private readonly watchIntervalMs: number
  private readonly serverPort: () => number
  private readonly slots = new Map<string, Set<string>>()

  constructor(deps: Dependencies = {}) {
    this.conversation = deps.conversation ?? defaultConversation
    this.providers = deps.providers ?? new ProviderService()
    this.maxPerParent = deps.maxPerParent ?? MAX_PINNED_WORKERS_PER_PARENT
    this.watchIntervalMs = deps.watchIntervalMs ?? WATCH_INTERVAL_MS
    this.serverPort = deps.serverPort ?? (() => ProviderService.getServerPort())
  }

  activeCount(parentSessionId: string): number {
    return this.slots.get(parentSessionId)?.size ?? 0
  }

  parseRequest(body: unknown): PinnedAgentRunRequest {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const forbidden = RUNTIME_FIELDS.find(field => Object.hasOwn(body, field))
      if (forbidden) {
        throw new ApiError(400, `"${forbidden}" cannot be set on a pinned agent run; its runtime comes from the user's settings`, 'BAD_REQUEST')
      }
    }
    const parsed = pinnedAgentRequestSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw ApiError.badRequest(`Invalid pinned agent request${issue ? `: ${issue.path.join('.') || 'body'} ${issue.message}` : ''}`)
    }
    if (!parsed.data.definition.systemPrompt.trim()) {
      throw ApiError.badRequest('Invalid pinned agent request: definition.systemPrompt must not be empty')
    }
    return parsed.data
  }

  /**
   * Validate, admit and start one pinned worker on behalf of `callerSessionId`,
   * then send it the prompt. Every failure before the first byte of the stream
   * is thrown as an ApiError (and the worker, if started, is stopped); after
   * that, failures are `result` events.
   */
  async start(callerSessionId: string, body: unknown, signal?: AbortSignal): Promise<PinnedAgentRun> {
    const request = this.parseRequest(body)
    const conversation = this.conversation
    if (!conversation.hasSession(callerSessionId)) {
      throw new ApiError(409, 'The calling session is not running', 'PINNED_AGENT_PARENT_UNAVAILABLE')
    }
    // A worker's permission requests are relayed to its parent's UI. A worker
    // has no UI, so a worker-of-a-worker would wait for an answer forever.
    if (conversation.isWorkerSession(callerSessionId)) {
      throw new ApiError(403, 'Pinned agents cannot be started from a team worker or another pinned agent', 'PINNED_AGENT_NESTED')
    }

    // Admission is synchronous with the check, so concurrent requests cannot
    // both slip under the limit while a previous one is still starting.
    const workerSessionId = randomUUID()
    const slots = this.slots.get(callerSessionId) ?? new Set<string>()
    if (slots.size >= this.maxPerParent) {
      throw new ApiError(429, `At most ${this.maxPerParent} pinned agents can run at the same time in one session`, 'PINNED_AGENT_LIMIT')
    }
    slots.add(workerSessionId)
    this.slots.set(callerSessionId, slots)
    const release = () => {
      const current = this.slots.get(callerSessionId)
      current?.delete(workerSessionId)
      if (current && current.size === 0) this.slots.delete(callerSessionId)
    }

    let workerStarted = false
    try {
      const abortIfNeeded = () => {
        if (signal?.aborted) throw new ApiError(499, 'The client closed the request', 'CLIENT_CLOSED_REQUEST')
      }
      abortIfNeeded()

      // The binding is authoritative here: read fresh from settings, never from
      // the request.
      resetSettingsCache()
      const binding = resolveAgentRuntimeBinding(request.agentType)
      if (!binding) {
        throw new ApiError(404, `Agent "${request.agentType}" has no runtime binding. Configure one in Settings, or remove the pin.`, 'PINNED_AGENT_BINDING_MISSING')
      }
      const permissionMode = conversation.getSessionPermissionMode(callerSessionId)
      try {
        validateAgentPresetSnapshot(request.definition, request.agentType, {
          parentPermissionMode: permissionMode,
          workerLabel: 'pinned agent',
          permissionHint: 'adjust the preset or the session permission mode',
        })
      } catch (error) {
        throw ApiError.badRequest(error instanceof Error ? error.message : String(error))
      }
      let resolved
      try {
        resolved = await resolveAgentRuntimeModel(this.providers, binding, `agent ${request.agentType}`)
      } catch (error) {
        if (error instanceof AgentRuntimeModelError) {
          throw new ApiError(409, error.message, error.code === 'provider_missing' ? 'PROVIDER_NOT_FOUND' : 'MODEL_UNRESOLVABLE')
        }
        throw error
      }

      // Same working directory as the parent, no worktree of its own.
      const workDir = conversation.getSessionWorkDir(callerSessionId)
      if (!workDir || !(await stat(workDir).then(entry => entry.isDirectory(), () => false))) {
        throw new ApiError(409, 'The calling session has no usable working directory', 'PINNED_AGENT_PARENT_UNAVAILABLE')
      }

      const { systemPrompt, sourceIdentity: _sourceIdentity, tools, ...preset } = request.definition
      const url = new URL(`ws://127.0.0.1:${this.serverPort()}/sdk/${workerSessionId}`)
      url.searchParams.set('token', randomUUID())
      try {
        workerStarted = true
        await conversation.startSession(workerSessionId, workDir, url.toString(), {
          providerId: binding.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : binding.providerId,
          model: resolved.modelId,
          permissionMode,
          agentWorker: {
            parentSessionId: callerSessionId,
            agentType: request.agentType,
            runId: workerSessionId,
            systemPrompt,
            tools,
            // The agent's own effort and initial prompt do not carry over: the
            // pinned model has its own default effort, and an in-process
            // subagent does not apply initialPrompt either.
            agentDefinition: { ...preset, agentType: request.agentType, initialPrompt: undefined, effort: undefined },
          },
        })
        abortIfNeeded()
        await conversation.requestControl(workerSessionId, { subtype: 'set_model', model: resolved.modelId }, CONTROL_TIMEOUT_MS, signal)
        abortIfNeeded()
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (signal?.aborted) throw new ApiError(499, 'The client closed the request', 'CLIENT_CLOSED_REQUEST')
        const message = error instanceof Error ? error.message : String(error)
        throw new ApiError(502, `The pinned agent could not be started: ${message}`, error instanceof ConversationStartupError ? `PINNED_AGENT_${error.code}` : 'PINNED_AGENT_START_FAILED')
      }

      const queue = createEventQueue<PinnedAgentEvent>()
      let finished = false
      let cancelled = false
      let watch: ReturnType<typeof setInterval> | undefined
      let onOutput: ((message: any) => void) | undefined
      const finish = async (event: Extract<PinnedAgentEvent, { type: 'result' }>) => {
        if (finished) return
        finished = true
        if (watch) clearInterval(watch)
        if (onOutput) conversation.removeOutputCallback(workerSessionId, onOutput)
        // Deliver the outcome first; tearing the process down can take a while.
        queue.push(event)
        queue.close()
        try {
          await conversation.stopSessionAndWait(workerSessionId)
        } catch (error) {
          console.error('[PinnedAgent] Failed to stop worker', error)
        } finally {
          release()
        }
      }
      const cancel = async () => {
        if (finished) return
        cancelled = true
        await finish({ type: 'result', ok: false, errorCode: 'cancelled', text: 'The pinned agent was cancelled. Actions it already took were not undone.' })
      }

      onOutput = (message: any) => {
        if (finished) return
        if (message?.type === 'result') {
          const ok = message.subtype === 'success' && message.is_error !== true
          void finish({
            type: 'result',
            ok,
            text: typeof message.result === 'string' ? message.result : '',
            ...(ok ? {} : { errorCode: conversation.hasSession(workerSessionId) ? 'worker_error' as const : 'worker_exited' as const }),
            ...(message.usage && typeof message.usage === 'object' ? { usage: message.usage as PinnedAgentUsage } : {}),
            ...(typeof message.num_turns === 'number' ? { numTurns: message.num_turns } : {}),
            ...(typeof message.duration_ms === 'number' ? { durationMs: message.duration_ms } : {}),
            ...(typeof message.total_cost_usd === 'number' ? { costUsd: message.total_cost_usd } : {}),
          })
          return
        }
        const progress = projectWorkerMessage(message)
        if (progress) queue.push(progress)
      }
      conversation.onOutput(workerSessionId, onOutput)

      // stopSession() removes the process without a `result`. Notice a worker
      // that vanished (parent stopped, server shutting down, killed) instead of
      // leaving the stream open forever.
      watch = setInterval(() => {
        if (finished) return
        if (!conversation.hasSession(callerSessionId)) conversation.stopSession(workerSessionId)
        if (!conversation.hasSession(workerSessionId)) {
          void finish({ type: 'result', ok: false, errorCode: cancelled ? 'cancelled' : 'worker_stopped', text: 'The pinned agent stopped before producing a result.' })
        }
      }, this.watchIntervalMs)
      watch.unref?.()

      queue.push({
        type: 'started',
        workerSessionId,
        provider: { id: binding.providerId, name: resolved.provider?.name ?? 'Claude' },
        requestedModel: binding.modelId,
        model: resolved.modelId,
        ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
        ...(request.agentId ? { agentId: request.agentId } : {}),
      })

      // Cancellation is wired before the task is sent: sendMessage() awaits
      // network and token refreshes, and a cancel that lands in that window
      // must stop the task from ever being submitted.
      if (signal?.aborted) void cancel()
      else signal?.addEventListener('abort', () => void cancel(), { once: true })

      const sent = await conversation.sendMessage(workerSessionId, request.prompt, undefined, {
        // The last point before the task is written to the worker: a cancelled
        // run, or a parent that has gone away, must not start it.
        canSend: () => !finished && !cancelled && !signal?.aborted && conversation.hasSession(callerSessionId),
      })
      if (!sent) {
        await finish({ type: 'result', ok: false, errorCode: 'worker_error', text: 'The pinned agent did not accept the task.' })
      }
      return { workerSessionId, events: queue, cancel }
    } catch (error) {
      if (workerStarted) {
        try { await conversation.stopSessionAndWait(workerSessionId) } catch { /* already gone */ }
      }
      release()
      throw error
    }
  }
}

export const pinnedAgentService = new PinnedAgentService()
