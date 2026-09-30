import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { pinnedAgentService, type PinnedAgentService } from '../services/pinnedAgentService.js'

export const PINNED_AGENT_RUN_PATH = '/api/pinned-agent/run'

export function isPinnedAgentRunPath(pathname: string): boolean {
  return pathname === PINNED_AGENT_RUN_PATH
}

/**
 * POST /api/pinned-agent/run: run one agent inside a hidden worker pinned to
 * the runtime the user configured, streaming NDJSON events (`started`,
 * `progress`..., exactly one `result`).
 *
 * `callerSessionId` must come from the authenticated SDK token by the host
 * router; the body never names a session.
 */
export async function handlePinnedAgentApi(
  req: Request,
  callerSessionId: string,
  service: PinnedAgentService = pinnedAgentService,
): Promise<Response> {
  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw ApiError.badRequest('A JSON object is required')
    }
    const run = await service.start(callerSessionId, body, req.signal)
    const iterator = run.events[Symbol.asyncIterator]()
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
      },
      // The consumer went away (fetch aborted, connection dropped): stop the worker.
      async cancel() {
        await run.cancel()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
