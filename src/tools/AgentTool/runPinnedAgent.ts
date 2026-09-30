import type { UUID } from 'crypto'
import type { PinnedAgentEvent } from '../../shared/pinnedAgent.js'
import type { Message } from '../../types/message.js'
import { asAgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { AbortError } from '../../utils/errors.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { readAgentMetadata, recordSidechainTranscript, writeAgentMetadata, type AgentMetadata } from '../../utils/sessionStorage.js'
import { getSessionBridgeConfig, isSessionBridgeAvailable } from '../SessionCollaborationTool/bridge.js'
import { resolveAgentRuntimeBinding, type AgentRuntimeBinding } from './agentRuntimeBindings.js'

/** Where a pinned agent was actually run. Produced from server events, never self-reported by the agent. */
export type PinnedRuntimeInfo = {
  mode: 'pinned'
  providerId: string
  providerName: string
  requestedModel: string
  status: 'completed'
  warnings: string[]
}

/** Filled in while the stream is consumed, so the caller can report the runtime it observed. */
export type PinnedRunState = {
  runtime?: { providerId: string; providerName: string; requestedModel: string; model: string; workerSessionId: string }
  /** Set once the stream is over (finished, failed or abandoned), whether or not the worker ever started. */
  ended?: boolean
}

export type PinnedRunParams = {
  agentType: string
  /** Frozen definition sent to the server (see `snapshotAgentPreset`). */
  definition: Record<string, unknown>
  prompt: string
  description: string
  toolUseId?: string
  agentId: string
  ownerAgentId?: string
  signal: AbortSignal
  state: PinnedRunState
}

const MAX_ERROR_DETAIL_CHARS = 1_000
const BRIDGE_PATH = '/api/pinned-agent/run'
const PINNED_START_WAIT_MS = 3_000

/**
 * The binding for `agentType`, or undefined when the agent is not pinned (the
 * caller then takes its ordinary in-process path, untouched).
 */
export function resolvePinnedRuntime(agentType: string): AgentRuntimeBinding | undefined {
  return resolveAgentRuntimeBinding(agentType)
}

/** A pinned worker (or team worker) has no UI to answer a nested worker's permission prompts. */
export function isRunningInsideWorker(): boolean {
  return process.env.CC_HAHA_PINNED_AGENT_WORKER === '1' || process.env.CC_HAHA_TEAM_WORKER === '1'
}

/**
 * Reasons a pinned agent cannot be started from this call, or undefined when
 * it can. Every refusal is explicit: a pinned agent must never silently fall
 * back to running on the session's own provider, because the binding exists to
 * control where the task's content is sent.
 */
export function pinnedAgentPreflightError(input: {
  agentType: string
  isForkPath: boolean
  isolation?: string
  cwd?: string
}): string | undefined {
  const { agentType } = input
  if (input.isForkPath) {
    return `Agent "${agentType}" is pinned to a provider and cannot be used as a fork. Name a subagent_type instead.`
  }
  if (isRunningInsideWorker()) {
    return `Agent "${agentType}" is pinned to a provider, but pinned agents cannot be started from a team worker or another pinned agent.`
  }
  if (!isSessionBridgeAvailable()) {
    return `Agent "${agentType}" is pinned to a provider, which needs the desktop app. It cannot run in a plain CLI session; remove the pin in Settings or run it from the desktop app.`
  }
  if (input.isolation) {
    return `Agent "${agentType}" is pinned to a provider and does not support isolation "${input.isolation}". Its worker shares the session's working directory.`
  }
  if (input.cwd) {
    return `Agent "${agentType}" is pinned to a provider and cannot run in a different working directory. Its worker shares the session's working directory.`
  }
  return undefined
}

/**
 * Carry on with a pinned run that a foreground caller has already started
 * consuming. `pending` is the `next()` call that was in flight when the caller
 * switched to the background: its result must not be lost, and the same worker
 * keeps running (a pinned run cannot be restarted from its transcript on
 * another provider). Leaving this generator early closes the original one,
 * which stops the worker.
 */
export async function* continuePinnedRun(
  iterator: AsyncIterator<Message, void>,
  pending: Promise<IteratorResult<Message, void>>,
): AsyncGenerator<Message, void> {
  try {
    let result = await pending
    while (!result.done) {
      yield result.value
      result = await iterator.next()
    }
  } finally {
    await iterator.return?.(undefined).catch(() => {})
  }
}

export function pinnedAgentContinuationMessage(agentType: string): string {
  return `Agent "${agentType}" ran pinned to its own provider and cannot be resumed or sent messages. Start a new Agent call with the full task instead.`
}

/** Set when `metadata` says the agent ran in a pinned worker. Resume and SendMessage must refuse it. */
export function isPinnedAgentMetadata(metadata: Pick<AgentMetadata, 'runtime'> | null | undefined): boolean {
  return metadata?.runtime?.mode === 'pinned'
}

/**
 * Why a message cannot be delivered to (or a resume started for) `agentId`, or
 * undefined when it can. A pinned worker's process is gone once it reports its
 * result, and resuming it in this process would run its transcript on the
 * session's own provider rather than the pinned one.
 */
export async function pinnedAgentContinuationError(agentId: string): Promise<string | undefined> {
  const metadata = await readAgentMetadata(asAgentId(agentId)).catch(() => null)
  return isPinnedAgentMetadata(metadata) ? pinnedAgentContinuationMessage(metadata!.agentType) : undefined
}

export function pinnedModelIgnoredWarning(agentType: string, model: string): string {
  return `The model override "${model}" was ignored: agent "${agentType}" is pinned to its own provider and model.`
}

/**
 * Wait (briefly) for the worker's `started` event, so the launch result of a
 * background run can already say which provider it is on. Returns as soon as
 * the worker has started or the run has ended; on timeout the caller simply
 * omits the runtime, which is only ever a display detail.
 */
export async function waitForPinnedStart(state: PinnedRunState, timeoutMs = PINNED_START_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!state.runtime && !state.ended && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function buildPinnedRuntimeInfo(
  state: PinnedRunState,
  warnings: string[],
): PinnedRuntimeInfo | undefined {
  const runtime = state.runtime
  if (!runtime) return undefined
  return {
    mode: 'pinned',
    providerId: runtime.providerId,
    providerName: runtime.providerName,
    requestedModel: runtime.requestedModel,
    status: 'completed',
    warnings,
  }
}

/** What a background launch can say about a pinned run. `providerName` is only known once the worker reported in. */
export type PinnedLaunchInfo = Omit<PinnedRuntimeInfo, 'providerName' | 'status'> & {
  providerName?: string
  status: 'running'
}

/**
 * The runtime block for a background launch result. It is always present for a
 * pinned agent, because the result must say the agent cannot be continued and
 * carry the warnings whether or not the worker has reported in yet; the
 * provider name (which the desktop badge needs) is added when it is known.
 */
export function buildPinnedLaunchInfo(
  state: PinnedRunState,
  binding: { providerId: string; modelId: string },
  warnings: string[],
): PinnedLaunchInfo {
  const runtime = state.runtime
  return {
    mode: 'pinned',
    providerId: runtime?.providerId ?? binding.providerId,
    ...(runtime ? { providerName: runtime.providerName } : {}),
    requestedModel: runtime?.requestedModel ?? binding.modelId,
    status: 'running',
    warnings,
  }
}

function usageFrom(value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const count = (key: string) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] as number : 0
  return {
    input_tokens: count('input_tokens'),
    output_tokens: count('output_tokens'),
    cache_creation_input_tokens: count('cache_creation_input_tokens'),
    cache_read_input_tokens: count('cache_read_input_tokens'),
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  }
}

async function startupError(response: Response, agentType: string): Promise<Error> {
  // Only the host's structured error is surfaced; a proxy or crash body is not.
  const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
  const detail = body && typeof body.error === 'string' && typeof body.message === 'string'
    ? `: ${body.message.slice(0, MAX_ERROR_DETAIL_CHARS)}`
    : ''
  return new Error(`Pinned agent "${agentType}" could not start (${response.status})${detail}`)
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error('The pinned agent stream sent a malformed event')
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield parse(line)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield parse(buffer.trim())
  } finally {
    // Closing the response is how the server learns to stop the worker.
    await reader.cancel().catch(() => {})
  }
}

/**
 * Drop-in replacement for `runAgent` for an agent pinned to another provider.
 *
 * The work happens in a worker process the desktop server starts with the
 * pinned provider and model; this only carries the task there and turns the
 * worker's activity back into the messages the Agent tool already knows how to
 * finalize, render and persist. Credentials and provider wiring stay in the
 * server. Cancelling `signal` (or abandoning the generator) closes the stream,
 * which stops the worker.
 */
export async function* runPinnedAgent(params: PinnedRunParams): AsyncGenerator<Message, void> {
  const config = getSessionBridgeConfig()
  if (!config) throw new Error('Pinned agents are only available in desktop sessions')
  const { signal } = params

  // The request has its own controller so that leaving the generator early
  // (not only an abort from the caller) tears the connection down; closing the
  // response body alone does not reliably drop it.
  const requestAbort = new AbortController()
  const forwardAbort = () => requestAbort.abort()
  if (signal.aborted) requestAbort.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })

  try {
    yield* streamPinnedRun(params, config, requestAbort.signal)
  } finally {
    signal.removeEventListener('abort', forwardAbort)
    requestAbort.abort()
    params.state.ended = true
  }
}

async function* streamPinnedRun(
  params: PinnedRunParams,
  config: NonNullable<ReturnType<typeof getSessionBridgeConfig>>,
  requestSignal: AbortSignal,
): AsyncGenerator<Message, void> {
  const { agentType, signal, state } = params
  const agentId = asAgentId(params.agentId)

  let lastRecordedUuid: UUID | null = null
  const record = async (message: Message) => {
    await recordSidechainTranscript([message], params.agentId, lastRecordedUuid).catch(error =>
      logForDebugging(`Failed to record pinned agent transcript: ${error}`),
    )
    lastRecordedUuid = message.uuid
  }

  let response: Response
  try {
    response = await fetch(`${config.endpoint}${BRIDGE_PATH}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'X-Session-Id': config.sessionId,
        'Content-Type': 'application/json',
      },
      // The runtime is deliberately not sent: the server reads the binding itself.
      body: JSON.stringify({
        agentType,
        definition: params.definition,
        prompt: params.prompt,
        description: params.description,
        ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
        agentId: params.agentId,
      }),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal.aborted) throw new AbortError()
    throw new Error(`Pinned agent "${agentType}" could not reach the desktop server: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw await startupError(response, agentType)
  if (!response.body) throw new Error(`Pinned agent "${agentType}" returned no stream`)

  await record(createUserMessage({ content: params.prompt }))

  // The newest text-only assistant message is held back one event so that, when
  // the worker's `result` repeats it, the usage lands on that message instead of
  // a duplicate being appended after it.
  let heldText: ReturnType<typeof createAssistantMessage> | undefined
  const heldTextOf = (message: ReturnType<typeof createAssistantMessage>) =>
    message.message.content.length === 1 && message.message.content[0]?.type === 'text'
      ? (message.message.content[0] as { text: string }).text
      : undefined

  let sawResult = false
  try {
    for await (const raw of readNdjson(response.body)) {
      const event = raw as PinnedAgentEvent
      if (event.type === 'started') {
        state.runtime = {
          providerId: event.provider.id,
          providerName: event.provider.name,
          requestedModel: event.requestedModel,
          model: event.model,
          workerSessionId: event.workerSessionId,
        }
        void writeAgentMetadata(agentId, {
          agentType,
          ...(params.description && { description: params.description }),
          ...(params.toolUseId && { toolUseId: params.toolUseId }),
          ...(params.ownerAgentId && { ownerAgentId: params.ownerAgentId }),
          runtime: {
            mode: 'pinned',
            providerId: event.provider.id,
            providerName: event.provider.name,
            requestedModel: event.requestedModel,
            model: event.model,
            workerSessionId: event.workerSessionId,
          },
        }).catch(error => logForDebugging(`Failed to write pinned agent metadata: ${error}`))
      } else if (event.type === 'progress') {
        let message: Message | undefined
        if (event.kind === 'assistant') {
          const content = event.blocks.flatMap(block =>
            block.type === 'text'
              ? [{ type: 'text' as const, text: block.text }]
              : block.type === 'tool_use'
                ? [{ type: 'tool_use' as const, id: block.id, name: block.name, input: block.input }]
                : [],
          )
          if (content.length) message = createAssistantMessage({ content: content as never })
        } else {
          const content = event.blocks.flatMap(block =>
            block.type === 'tool_result'
              ? [{ type: 'tool_result' as const, tool_use_id: block.toolUseId, content: block.text, is_error: block.isError }]
              : [],
          )
          if (content.length) message = createUserMessage({ content })
        }
        if (!message) continue
        if (heldText) {
          await record(heldText)
          yield heldText
          heldText = undefined
        }
        if (message.type === 'assistant' && heldTextOf(message) !== undefined) {
          heldText = message
        } else {
          await record(message)
          yield message
        }
      } else if (event.type === 'result') {
        sawResult = true
        if (!event.ok) {
          if (event.errorCode === 'cancelled') throw new AbortError(event.text)
          if (heldText) {
            await record(heldText)
            yield heldText
            heldText = undefined
          }
          const code = event.errorCode ? ` (${event.errorCode})` : ''
          throw new Error(`Pinned agent "${agentType}" failed${code}: ${event.text || 'no details were reported'}`)
        }
        const usage = usageFrom(event.usage)
        let final = heldText
        if (final && heldTextOf(final) === event.text) {
          final.message.usage = usage as never
        } else {
          if (final) {
            await record(final)
            yield final
          }
          final = createAssistantMessage({ content: event.text, usage: usage as never })
        }
        heldText = undefined
        await record(final)
        yield final
        return
      }
    }
    if (signal.aborted) throw new AbortError()
    if (!sawResult) {
      throw new Error(`Pinned agent "${agentType}" lost its connection to the desktop server before finishing. It may already have made changes; check the working directory before retrying.`)
    }
  } catch (error) {
    if (signal.aborted && !(error instanceof AbortError)) throw new AbortError()
    throw error
  }
}
