/**
 * Notifications REST API — 即时消息投递
 *
 * POST /api/notifications/send — 向一个已配对收件人立即发送一条消息
 *
 * 这是「主动消息」工具后续接入的服务端入口。它与定时任务通知共用同一套
 * 依赖：
 * - 收件人解析：`resolveNotificationRecipient`，只接受在服务端配对记录
 *   （pairedUsers）中唯一命中的目标；`allowedUsers` 是访问白名单，不是发送对象。
 * - 发送器：`sendImmediateMessage`，先写 `pending` 投递记录、再发送、再结算，
 *   凭据在写日志与记录前统一脱敏。
 *
 * 鉴权边界：**仅接受本地 bearer 令牌**（`CC_HAHA_LOCAL_ACCESS_TOKEN`）。
 * 定时任务/通知投递属于本机桌面能力，H5 令牌、Anthropic API Key、远程浏览器
 * 一律不能触达；即使全局中间件在本机场景下放行，这里也会独立再校验一次。
 *
 * Telegram 公共入口：JSON 里的 `sourceSessionId` 只是受信任本机调用方提交的
 * 来源声明，用来做订阅/专属绑定校验，不是授权本身；绝不从 `text` 推断会话。
 */

import { isLocalAccessAuthorized } from '../localAccessAuth.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  sendImmediateMessage,
  type ImmediateMessageResult,
  type NotificationChannel,
  type NotificationRecipientSpec,
  type TelegramMessageEntrypoint,
} from '../services/notificationService.js'

/** Hard cap on an immediate message body, mirroring the task-notification budget. */
const MAX_MESSAGE_TEXT_LENGTH = 4_000
const MAX_TITLE_LENGTH = 120
const MAX_REFERENCE_LENGTH = 200

function isNotificationChannel(value: unknown): value is NotificationChannel {
  return value === 'telegram' || value === 'feishu'
}

function invalidRecipientSpec(): { code: string; message: string } {
  return { code: 'BAD_REQUEST', message: 'recipient must be a non-empty id or { userId | displayName }' }
}

function parseRecipient(value: unknown): NotificationRecipientSpec {
  if (typeof value === 'string' || typeof value === 'number') {
    const label = String(value).trim()
    if (label.length === 0 || label.length > MAX_REFERENCE_LENGTH) throw new ApiError(400, invalidRecipientSpec().message, 'BAD_REQUEST')
    return typeof value === 'number' ? value : label
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const { userId, displayName } = record
    if (typeof userId === 'string' || typeof userId === 'number') {
      const label = String(userId).trim()
      if (label.length === 0 || label.length > MAX_REFERENCE_LENGTH) throw new ApiError(400, invalidRecipientSpec().message, 'BAD_REQUEST')
      return { userId: typeof userId === 'number' ? userId : label }
    }
    if (typeof displayName === 'string') {
      const label = displayName.trim()
      if (label.length === 0 || label.length > MAX_REFERENCE_LENGTH) throw new ApiError(400, invalidRecipientSpec().message, 'BAD_REQUEST')
      return { displayName: label }
    }
  }
  throw new ApiError(400, invalidRecipientSpec().message, 'BAD_REQUEST')
}

function optionalReference(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_REFERENCE_LENGTH) throw ApiError.badRequest(`${field} is too long`)
  return trimmed
}

function parseEntrypoint(value: unknown): TelegramMessageEntrypoint | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'dedicated' || value === 'public') return value
  throw ApiError.badRequest('entrypoint must be dedicated or public')
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json() as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('Request body must be a JSON object')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export async function handleNotificationsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    // Independent of the global middleware: the immediate-send capability is a
    // local desktop credential, never an H5 or provider credential.
    if (!isLocalAccessAuthorized(req)) {
      throw new ApiError(
        401,
        'This endpoint requires the local desktop access token',
        'UNAUTHORIZED',
      )
    }

    const action = segments[2]

    if (req.method === 'POST' && action === 'send') {
      const body = await parseJsonBody(req)

      if (!isNotificationChannel(body.channel)) {
        throw ApiError.badRequest('channel must be one of: telegram, feishu')
      }
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw ApiError.badRequest('text must be a non-empty string')
      }
      if (body.text.length > MAX_MESSAGE_TEXT_LENGTH) {
        throw ApiError.badRequest(`text must be at most ${MAX_MESSAGE_TEXT_LENGTH} characters`)
      }
      if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
        throw ApiError.badRequest('title must be a string')
      }
      if (typeof body.title === 'string' && body.title.length > MAX_TITLE_LENGTH) {
        throw ApiError.badRequest(`title must be at most ${MAX_TITLE_LENGTH} characters`)
      }

      const entrypoint = parseEntrypoint(body.entrypoint)
      if (entrypoint === 'public' && body.channel !== 'telegram') {
        throw ApiError.badRequest('entrypoint public is only valid for telegram')
      }

      const sourceSessionId = optionalReference(body.sourceSessionId, 'sourceSessionId')
      const hasRecipient = body.recipient !== undefined && body.recipient !== null && body.recipient !== ''
      if (!hasRecipient && entrypoint !== 'public') {
        throw new ApiError(400, invalidRecipientSpec().message, 'BAD_REQUEST')
      }

      const input = {
        channel: body.channel,
        ...(hasRecipient ? { recipient: parseRecipient(body.recipient) } : {}),
        text: body.text,
        ...(typeof body.title === 'string' && body.title.trim().length > 0 ? { title: body.title.trim() } : {}),
        ...(optionalReference(body.runId, 'runId') ? { runId: body.runId as string } : {}),
        ...(optionalReference(body.taskId, 'taskId') ? { taskId: body.taskId as string } : {}),
        ...(entrypoint ? { entrypoint } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
      }

      const result = await sendImmediateMessage(input)
      return Response.json(projectResult(result))
    }

    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/notifications${action ? `/${action}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * The service result already only carries redacted error text; re-shaping it
 * here keeps the wire contract explicit instead of leaking future internal
 * fields by accident.
 */
function projectResult(result: ImmediateMessageResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.queued === true ? { queued: true } : {}),
    ...(result.delivery
      ? {
          delivery: {
            channel: result.delivery.channel,
            recipientId: result.delivery.recipientId,
            recipientLabel: result.delivery.recipientLabel,
            outcome: result.delivery.outcome,
            attempts: result.delivery.attempts,
            ...(result.delivery.messageId !== undefined ? { messageId: result.delivery.messageId } : {}),
            ...(result.delivery.errorCode ? { errorCode: result.delivery.errorCode } : {}),
            ...(result.delivery.error ? { error: result.delivery.error } : {}),
          },
        }
      : {}),
    issues: result.issues.map((issue) => ({
      ...(issue.channel ? { channel: issue.channel } : {}),
      code: issue.code,
      message: issue.message,
    })),
    recordPath: result.recordPath,
  }
}