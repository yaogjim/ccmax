/**
 * Telegram public channel REST API.
 *
 * POST   /api/telegram/public/runtime            注册已核验的实际 Bot 身份
 * DELETE /api/telegram/public/runtime            注销内存运行态（保留持久化身份）
 * POST   /api/telegram/public/update             转发入站 Telegram update
 * GET    /api/telegram/public/status             订阅与投递状态
 * POST   /api/telegram/public/subscriptions      本地桌面加入订阅
 * DELETE /api/telegram/public/subscriptions/:id  本地桌面取消订阅
 *
 * 主控会把这些路由限定为本地凭据；本文件只负责解析与调用服务。
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getTelegramPublicService } from '../services/telegramPublicService.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON')
  }
  if (!isRecord(body)) throw ApiError.badRequest('Request body must be a JSON object')
  return body
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer`)
  }
  return value
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw ApiError.badRequest(`${field} must be a non-negative integer`)
  }
  return value
}

export async function handleTelegramPublicApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (segments[2] !== 'public') {
      return Response.json({ error: 'Not Found', message: 'Unknown Telegram API resource' }, { status: 404 })
    }
    const action = segments[3]
    const service = getTelegramPublicService()

    if (action === 'runtime' && segments.length === 4) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      }
      const body = await parseJsonBody(req)
      const botId = readPositiveInteger(body.botId, 'botId')
      const generation = readNonNegativeInteger(body.generation, 'generation')
      if (req.method === 'DELETE') {
        return Response.json(await service.deregisterRuntime({ botId, generation }))
      }
      return Response.json(await service.registerRuntime({ botId, generation }))
    }

    if (action === 'update' && segments.length === 4) {
      if (req.method !== 'POST') throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      const body = await parseJsonBody(req)
      const botId = readPositiveInteger(body.botId, 'botId')
      const generation = readNonNegativeInteger(body.generation, 'generation')
      if (!('update' in body)) throw ApiError.badRequest('update is required')
      const result = await service.handleUpdate({ botId, generation, update: body.update })
      return Response.json(result)
    }

    if (action === 'status' && segments.length === 4) {
      if (req.method !== 'GET') throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      return Response.json(await service.getStatus())
    }

    if (action === 'subscriptions') {
      if (segments.length === 4 && req.method === 'POST') {
        const body = await parseJsonBody(req)
        if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
          throw ApiError.badRequest('sessionId is required')
        }
        return Response.json(await service.subscribe(body.sessionId))
      }
      if (segments.length === 5 && req.method === 'DELETE') {
        const sessionId = decodeURIComponent(segments[4] ?? '')
        await service.unsubscribe(sessionId)
        return Response.json({ ok: true })
      }
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }

    return Response.json({ error: 'Not Found', message: `Unknown Telegram public endpoint` }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}