import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  callLocalDesktopApi,
  describeLocalScheduledTaskApiError,
  isLocalScheduledTaskApiAvailable,
} from './client.js'
import {
  LOCAL_MESSAGE_SEND_DESCRIPTION,
  LOCAL_MESSAGE_SEND_TOOL_NAME,
  buildLocalMessageSendPrompt,
} from './LocalMessageSendTool.prompt.js'

/**
 * The one local route this tool may ever reach. It is fixed in code, never
 * model-supplied, so the internal bearer token cannot be redirected to any
 * other path — and the model cannot ask for an arbitrary URL or a different
 * host. The route is the desktop's immediate-send API, which re-verifies the
 * recipient against its own paired-account records.
 */
const LOCAL_NOTIFICATIONS_SEND_PATH = '/api/notifications/send'

/**
 * The immediate-send API only accepts these two IM channels. `desktop` is not a
 * sendable destination here, and there is deliberately no "everyone" option.
 */
const MESSAGE_CHANNELS = ['telegram', 'feishu'] as const

const MAX_RECIPIENT_LENGTH = 128
/** Matches the server-side cap in `src/server/api/notifications.ts`. */
const MAX_TEXT_LENGTH = 4_000

// ─── Input schema ────────────────────────────────────────────────────────────
//
// Tool arguments are untrusted. `recipient` is required with no default, so a
// missing target can never silently expand into a broadcast; the server still
// re-checks it against paired accounts before anything is sent.

const recipientObjectSchema = z
  .strictObject({
    userId: z
      .union([z.number().int(), z.string().min(1).max(MAX_RECIPIENT_LENGTH)])
      .optional(),
    displayName: z.string().min(1).max(MAX_RECIPIENT_LENGTH).optional(),
  })
  .refine(value => value.userId !== undefined || value.displayName !== undefined, {
    message: 'A recipient object needs a userId or a displayName.',
  })

const recipientSchema = z.union([
  z.number().int(),
  z.string().min(1).max(MAX_RECIPIENT_LENGTH),
  recipientObjectSchema,
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    recipient: recipientSchema.describe(
      'The single person to message right now: a platform user id (e.g. 111 or "ou_abc"), or an object like { "userId": 111 } or { "displayName": "Alice" }. Required — there is no default recipient and no broadcast. The server verifies it against the accounts paired with this app and rejects unknown or ambiguous targets.',
    ),
    channel: z
      .enum(MESSAGE_CHANNELS)
      .describe('Which platform to send through: "telegram" or "feishu". Required.'),
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT_LENGTH)
      .describe('The exact message body to deliver, as the user wants it sent. Required.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    channel: z.enum(MESSAGE_CHANNELS),
    recipientId: z.string(),
    recipientLabel: z.string(),
    outcome: z.literal('delivered'),
    attempts: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type LocalMessageSendOutput = z.infer<OutputSchema>

// ─── Validation ──────────────────────────────────────────────────────────────

function recipientLabelOf(input: Input): string {
  const recipient = input?.recipient
  if (typeof recipient === 'string' || typeof recipient === 'number') return String(recipient)
  if (recipient && typeof recipient === 'object') {
    if (typeof recipient.userId === 'string' || typeof recipient.userId === 'number') {
      return String(recipient.userId)
    }
    if (typeof recipient.displayName === 'string') return recipient.displayName
  }
  return ''
}

function validateMessageInput(input: Input): ValidationResult {
  if (input.text.trim().length === 0) {
    return { result: false, message: 'The message text must not be empty.', errorCode: 1 }
  }

  const recipient = input.recipient
  if (typeof recipient === 'string' && recipient.trim().length === 0) {
    return { result: false, message: 'The recipient must not be empty.', errorCode: 2 }
  }
  if (typeof recipient === 'object' && recipient !== null && !Array.isArray(recipient)) {
    if (recipient.userId === undefined && recipient.displayName === undefined) {
      return {
        result: false,
        message: 'The recipient needs a userId or a displayName.',
        errorCode: 3,
      }
    }
    if (typeof recipient.userId === 'string' && recipient.userId.trim().length === 0) {
      return { result: false, message: 'The recipient userId must not be empty.', errorCode: 4 }
    }
    if (typeof recipient.displayName === 'string' && recipient.displayName.trim().length === 0) {
      return { result: false, message: 'The recipient displayName must not be empty.', errorCode: 5 }
    }
  }

  return { result: true }
}

function parseMessageInput(raw: unknown): { input: Input } | { error: string } {
  const parsed = inputSchema().safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      error: first
        ? `Invalid arguments: ${first.path.join('.') || '(root)'} — ${first.message}`
        : 'Invalid arguments.',
    }
  }
  const validation = validateMessageInput(parsed.data)
  if (!validation.result) return { error: validation.message }
  return { input: parsed.data }
}

// ─── Wire response ───────────────────────────────────────────────────────────
//
// The send API answers 200 even when delivery fails, with `ok: false` and a
// reason. That is a real failure and must surface as an error, never a
// fabricated success.

type LocalSendIssue = { channel?: unknown; code?: unknown; message?: unknown }
type LocalSendDelivery = {
  channel?: unknown
  recipientId?: unknown
  recipientLabel?: unknown
  outcome?: unknown
  attempts?: unknown
  error?: unknown
  errorCode?: unknown
}
type LocalSendResponse = {
  ok?: unknown
  delivery?: LocalSendDelivery
  issues?: LocalSendIssue[]
}

function firstIssueMessage(response: LocalSendResponse): string | undefined {
  for (const issue of response.issues ?? []) {
    if (issue && typeof issue.message === 'string' && issue.message.trim().length > 0) {
      return issue.message.trim()
    }
  }
  return undefined
}

function describeSendFailure(response: LocalSendResponse | undefined): string {
  const delivery = response?.delivery
  if (delivery && typeof delivery.error === 'string' && delivery.error.trim().length > 0) {
    return `The message was not delivered: ${delivery.error.trim()}`
  }
  const issue = response ? firstIssueMessage(response) : undefined
  if (issue) return `The message was not delivered: ${issue}`
  if (delivery && typeof delivery.errorCode === 'string' && delivery.errorCode.length > 0) {
    return `The message was not delivered (${delivery.errorCode}).`
  }
  return 'The message was not delivered.'
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export const LocalMessageSendTool = buildTool({
  name: LOCAL_MESSAGE_SEND_TOOL_NAME,
  searchHint: 'send a message to a paired contact on this machine',
  maxResultSizeChars: 4_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * Visible only inside the desktop app, which is the only process that can
   * provide a trusted loopback origin and the matching internal token.
   */
  isEnabled() {
    return isLocalScheduledTaskApiAvailable()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return `send ${input.channel} message to ${recipientLabelOf(input)}`
  },
  async description() {
    return LOCAL_MESSAGE_SEND_DESCRIPTION
  },
  async prompt() {
    return buildLocalMessageSendPrompt()
  },
  async validateInput(input): Promise<ValidationResult> {
    // Re-parse here as well as in `call`: a caller that bypasses the pipeline
    // must not be able to smuggle an unbounded payload through.
    const parsed = inputSchema().safeParse(input)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return {
        result: false,
        message: first
          ? `Invalid arguments: ${first.path.join('.') || '(root)'} — ${first.message}`
          : 'Invalid arguments.',
        errorCode: 6,
      }
    }
    return validateMessageInput(parsed.data)
  },
  async call(rawInput) {
    const prepared = parseMessageInput(rawInput)
    if ('error' in prepared) throw new Error(prepared.error)
    const input = prepared.input

    let response: LocalSendResponse
    try {
      response = await callLocalDesktopApi<LocalSendResponse>({
        path: LOCAL_NOTIFICATIONS_SEND_PATH,
        method: 'POST',
        body: {
          channel: input.channel,
          recipient: input.recipient,
          text: input.text,
        },
      })
    } catch (error) {
      // A transport, auth, or HTTP failure stays a real error: the model is
      // never told a message went out when the request did not succeed.
      throw new Error(describeLocalScheduledTaskApiError(error))
    }

    if (!response || response.ok !== true) {
      throw new Error(describeSendFailure(response))
    }

    const delivery = response.delivery
    if (
      !delivery ||
      delivery.outcome !== 'delivered' ||
      typeof delivery.recipientId !== 'string' ||
      delivery.recipientId.length === 0
    ) {
      throw new Error(describeSendFailure(response))
    }

    const recipientId = delivery.recipientId
    const recipientLabel =
      typeof delivery.recipientLabel === 'string' && delivery.recipientLabel.trim().length > 0
        ? delivery.recipientLabel
        : recipientId
    const attempts =
      typeof delivery.attempts === 'number' && Number.isFinite(delivery.attempts)
        ? delivery.attempts
        : 0

    return {
      data: {
        message: `Delivered a ${input.channel} message to ${recipientLabel}.`,
        channel: input.channel,
        recipientId,
        recipientLabel,
        outcome: 'delivered' as const,
        attempts,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.message} (channel: ${output.channel}, recipient: ${output.recipientLabel})`,
    }
  },
  renderToolUseMessage(input) {
    return `${LOCAL_MESSAGE_SEND_TOOL_NAME}: ${input.channel ?? ''}${
      input.recipient !== undefined ? ` → ${recipientLabelOf(input as Input)}` : ''
    }`
  },
} satisfies ToolDef<InputSchema, LocalMessageSendOutput>)