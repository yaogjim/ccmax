import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { computeNextCronRun, cronToHuman, parseCronExpression } from '../../utils/cron.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import {
  callLocalScheduledTasksApi,
  describeLocalScheduledTaskApiError,
  isLocalScheduledTaskApiAvailable,
} from './client.js'
import {
  LOCAL_SCHEDULED_TASK_DESCRIPTION,
  LOCAL_SCHEDULED_TASK_TOOL_NAME,
  buildLocalScheduledTaskPrompt,
} from './prompt.js'

// ─── Bounds on model-supplied data ───────────────────────────────────────────
//
// Tool arguments are untrusted. Every field is length-bounded and every
// collection is count-bounded before anything is sent to the local server,
// which re-validates the notification recipients against its own pairing
// records. Bounding here keeps a malformed payload from reaching disk at all.

const MAX_ID_LENGTH = 64
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const MAX_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_CRON_LENGTH = 128
const MAX_PROMPT_LENGTH = 20_000
const MAX_MODEL_LENGTH = 200
const MAX_PROVIDER_ID_LENGTH = 200
const MAX_PATH_LENGTH = 4_096

const NOTIFICATION_CHANNELS = ['desktop', 'telegram', 'feishu'] as const
const MAX_RECIPIENTS_PER_CHANNEL = 20
const MAX_RECIPIENT_LENGTH = 128

const recipientSchema = z.union([
  z.number().int(),
  z.string().min(1).max(MAX_RECIPIENT_LENGTH),
  z.strictObject({
    userId: z.union([
      z.number().int(),
      z.string().min(1).max(MAX_RECIPIENT_LENGTH),
    ]),
    displayName: z.string().min(1).max(MAX_RECIPIENT_LENGTH).optional(),
  }),
])

const recipientsSchema = z.strictObject({
  telegram: z.array(recipientSchema).max(MAX_RECIPIENTS_PER_CHANNEL).optional(),
  feishu: z.array(recipientSchema).max(MAX_RECIPIENTS_PER_CHANNEL).optional(),
})

const notificationSchema = z.strictObject({
  enabled: semanticBoolean(z.boolean()),
  channels: z
    .array(z.enum(NOTIFICATION_CHANNELS))
    .min(1)
    .max(NOTIFICATION_CHANNELS.length),
  /**
   * Explicit destinations. The server resolves each one against its own
   * paired-account records and refuses unknown or ambiguous targets; it never
   * expands a missing target into a broadcast. Identifiers are only passed
   * through here, never trusted.
   */
  recipients: recipientsSchema.optional(),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'create',
        'list',
        'get',
        'update',
        'enable',
        'disable',
        'delete',
        'run',
      ])
      .describe(
        'Operation to perform. "create" needs cron and prompt; "get", "update", "enable", "disable", "delete", and "run" all need an existing task id.',
      ),
    id: z
      .string()
      .max(MAX_ID_LENGTH)
      .optional()
      .describe('Task id as returned by a previous create or list. Required for everything except create and list.'),
    name: z.string().max(MAX_NAME_LENGTH).optional().describe('Short human-readable task name.'),
    description: z
      .string()
      .max(MAX_DESCRIPTION_LENGTH)
      .optional()
      .describe('Longer description of what the task does.'),
    cron: z
      .string()
      .max(MAX_CRON_LENGTH)
      .optional()
      .describe(
        'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "30 9 * * 1-5" = 9:30am on weekdays). Required for create.',
      ),
    prompt: z
      .string()
      .max(MAX_PROMPT_LENGTH)
      .optional()
      .describe('The prompt to run when the task fires. Required for create.'),
    enabled: semanticBoolean(z.boolean().optional()).describe(
      'Whether the task is active. Omit to inherit the default (enabled).',
    ),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      'true = fire on every cron match; false = fire once, then stop.',
    ),
    permanent: semanticBoolean(z.boolean().optional()).describe(
      'true = never auto-expire the task.',
    ),
    model: z
      .string()
      .max(MAX_MODEL_LENGTH)
      .optional()
      .describe('Model to use for this task. Omit to use the app default.'),
    providerId: z
      .string()
      .max(MAX_PROVIDER_ID_LENGTH)
      .nullable()
      .optional()
      .describe('Provider id to run the task with. Omit to use the app default.'),
    folderPath: z
      .string()
      .max(MAX_PATH_LENGTH)
      .optional()
      .describe('Absolute working directory for the task. Omit to run in the user home directory; pass the current project path explicitly when needed.'),
    useWorktree: semanticBoolean(z.boolean().optional()).describe(
      'Run the task in an isolated git worktree.',
    ),
    notification: notificationSchema
      .optional()
      .describe(
        'Where to report the task result. Omit unless the user asked to be notified somewhere specific.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const taskSummarySchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    cron: z.string().optional(),
    prompt: z.string().optional(),
    enabled: z.boolean().optional(),
    recurring: z.boolean().optional(),
    folderPath: z.string().optional(),
    model: z.string().optional(),
    lastFiredAt: z.string().optional(),
    /** Computed locally from the cron expression; not stored by the server. */
    nextRunAt: z.string().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    message: z.string(),
    task: taskSummarySchema().optional(),
    tasks: z.array(taskSummarySchema()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type LocalScheduledTaskOutput = z.infer<OutputSchema>

// ─── Input validation ────────────────────────────────────────────────────────

const MUTABLE_FIELDS = [
  'name',
  'description',
  'cron',
  'prompt',
  'enabled',
  'recurring',
  'permanent',
  'model',
  'providerId',
  'folderPath',
  'useWorktree',
  'notification',
] as const

function validateCronExpression(cron: string): ValidationResult {
  const fields = parseCronExpression(cron)
  if (!fields) {
    return {
      result: false,
      message: `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
      errorCode: 1,
    }
  }
  if (computeNextCronRun(fields, new Date()) === null) {
    return {
      result: false,
      message: `Cron expression '${cron}' does not match any calendar date in the next year.`,
      errorCode: 2,
    }
  }
  return { result: true }
}

function validateActionRequirements(input: Input): ValidationResult {
  const requiresExistingTask =
    input.action === 'get' ||
    input.action === 'update' ||
    input.action === 'enable' ||
    input.action === 'disable' ||
    input.action === 'delete' ||
    input.action === 'run'

  if (requiresExistingTask) {
    const id = input.id?.trim()
    if (!id) {
      return {
        result: false,
        message: `The '${input.action}' action requires an 'id' from a previous create or list.`,
        errorCode: 3,
      }
    }
    if (!TASK_ID_PATTERN.test(id)) {
      return {
        result: false,
        message: `'${id}' is not a valid task id.`,
        errorCode: 4,
      }
    }
  } else if (input.id !== undefined && !TASK_ID_PATTERN.test(input.id.trim())) {
    return {
      result: false,
      message: `'${input.id}' is not a valid task id.`,
      errorCode: 4,
    }
  }

  if (input.action === 'create') {
    if (!input.cron?.trim()) {
      return {
        result: false,
        message: "The 'create' action requires a 'cron' expression.",
        errorCode: 5,
      }
    }
    if (!input.prompt?.trim()) {
      return {
        result: false,
        message: "The 'create' action requires a 'prompt'.",
        errorCode: 6,
      }
    }
  }

  if (input.action === 'update') {
    const changed = MUTABLE_FIELDS.some(field => input[field] !== undefined)
    if (!changed) {
      return {
        result: false,
        message: "The 'update' action requires at least one field to change.",
        errorCode: 7,
      }
    }
  }

  if (input.cron !== undefined) {
    return validateCronExpression(input.cron)
  }

  return { result: true }
}

/**
 * Parse and validate. `call` re-parses too so a direct invocation (as in
 * tests, or any future caller that bypasses the tool pipeline) cannot smuggle
 * an unbounded payload through.
 */
function parseAndValidate(raw: unknown): { input: Input } | { error: string } {
  const parsed = inputSchema().safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      error: first
        ? `Invalid arguments: ${first.path.join('.') || '(root)'} — ${first.message}`
        : 'Invalid arguments.',
    }
  }
  const validation = validateActionRequirements(parsed.data)
  if (!validation.result) return { error: validation.message }
  return { input: parsed.data }
}

// ─── Serialization ───────────────────────────────────────────────────────────

type RawTask = Record<string, unknown>

function nextRunAtFor(cron: unknown): string | undefined {
  if (typeof cron !== 'string') return undefined
  const fields = parseCronExpression(cron)
  if (!fields) return undefined
  const next = computeNextCronRun(fields, new Date())
  return next ? next.toISOString() : undefined
}

function summarizeTask(raw: unknown): z.infer<ReturnType<typeof taskSummarySchema>> | null {
  if (!raw || typeof raw !== 'object') return null
  const task = raw as RawTask
  if (typeof task.id !== 'string') return null
  const nextRunAt = nextRunAtFor(task.cron)
  return {
    id: task.id,
    ...(typeof task.name === 'string' ? { name: task.name } : {}),
    ...(typeof task.description === 'string' ? { description: task.description } : {}),
    ...(typeof task.cron === 'string' ? { cron: task.cron } : {}),
    ...(typeof task.prompt === 'string' ? { prompt: task.prompt } : {}),
    ...(typeof task.enabled === 'boolean' ? { enabled: task.enabled } : {}),
    ...(typeof task.recurring === 'boolean' ? { recurring: task.recurring } : {}),
    ...(typeof task.folderPath === 'string' ? { folderPath: task.folderPath } : {}),
    ...(typeof task.model === 'string' ? { model: task.model } : {}),
    ...(typeof task.lastFiredAt === 'string' ? { lastFiredAt: task.lastFiredAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  }
}

function describeSchedule(cron: unknown): string {
  if (typeof cron !== 'string') return 'unknown schedule'
  return parseCronExpression(cron) ? cronToHuman(cron) : `'${cron}'`
}

function responseTask(payload: unknown): RawTask | null {
  if (!payload || typeof payload !== 'object') return null
  const task = (payload as RawTask).task
  return task && typeof task === 'object' ? (task as RawTask) : null
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export const LocalScheduledTaskTool = buildTool({
  name: LOCAL_SCHEDULED_TASK_TOOL_NAME,
  searchHint: 'schedule, list, edit, or run local tasks on this machine',
  maxResultSizeChars: 100_000,
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
  isConcurrencySafe(input) {
    return input.action === 'list' || input.action === 'get'
  },
  isReadOnly(input) {
    return input.action === 'list' || input.action === 'get'
  },
  isDestructive(input) {
    return input.action === 'delete'
  },
  toAutoClassifierInput(input) {
    return `${input.action}${input.id ? ` ${input.id}` : ''}${input.cron ? ` ${input.cron}` : ''}`
  },
  async description() {
    return LOCAL_SCHEDULED_TASK_DESCRIPTION
  },
  async prompt() {
    return buildLocalScheduledTaskPrompt()
  },
  async validateInput(input): Promise<ValidationResult> {
    return validateActionRequirements(input)
  },
  async call(rawInput) {
    const prepared = parseAndValidate(rawInput)
    if ('error' in prepared) throw new Error(prepared.error)
    const input = prepared.input

    try {
      switch (input.action) {
        case 'list': {
          const payload = await callLocalScheduledTasksApi<{ tasks?: unknown[] }>({
            method: 'GET',
            segments: [],
          })
          const tasks = (payload.tasks ?? [])
            .map(summarizeTask)
            .filter((task): task is NonNullable<typeof task> => task !== null)
          return {
            data: {
              action: 'list',
              message:
                tasks.length === 0
                  ? 'No scheduled tasks.'
                  : `${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}.`,
              tasks,
            },
          }
        }

        case 'get': {
          const id = input.id!.trim()
          // The local API has no single-task GET; list and select.
          const payload = await callLocalScheduledTasksApi<{ tasks?: unknown[] }>({
            method: 'GET',
            segments: [],
          })
          const match = (payload.tasks ?? []).find(
            candidate =>
              candidate !== null &&
              typeof candidate === 'object' &&
              (candidate as RawTask).id === id,
          )
          const task = summarizeTask(match)
          return {
            data: {
              action: 'get',
              message: task
                ? `Task ${id} (${describeSchedule(task.cron)}).`
                : `No scheduled task with id '${id}'.`,
              ...(task ? { task } : {}),
            },
          }
        }

        case 'create': {
          const body: Record<string, unknown> = {
            cron: input.cron!.trim(),
            prompt: input.prompt!,
          }
          if (input.name !== undefined) body.name = input.name
          if (input.description !== undefined) body.description = input.description
          if (input.enabled !== undefined) body.enabled = input.enabled
          if (input.recurring !== undefined) body.recurring = input.recurring
          if (input.permanent !== undefined) body.permanent = input.permanent
          if (input.model !== undefined) body.model = input.model
          if (input.providerId !== undefined) body.providerId = input.providerId
          if (input.folderPath !== undefined) body.folderPath = input.folderPath
          if (input.useWorktree !== undefined) body.useWorktree = input.useWorktree
          if (input.notification !== undefined) body.notification = input.notification

          const payload = await callLocalScheduledTasksApi<unknown>({
            method: 'POST',
            segments: [],
            body,
          })
          const task = summarizeTask(responseTask(payload))
          if (!task) {
            throw new Error('The local desktop server did not return the created task.')
          }
          return {
            data: {
              action: 'create',
              message: `Created scheduled task ${task.id} (${describeSchedule(task.cron)}).`,
              task,
            },
          }
        }

        case 'update': {
          const id = input.id!.trim()
          const body: Record<string, unknown> = {}
          for (const field of MUTABLE_FIELDS) {
            if (input[field] !== undefined) body[field] = input[field]
          }
          const payload = await callLocalScheduledTasksApi<unknown>({
            method: 'PUT',
            segments: [id],
            body,
          })
          const task = summarizeTask(responseTask(payload))
          return {
            data: {
              action: 'update',
              message: `Updated scheduled task ${id}${
                task ? ` (${describeSchedule(task.cron)})` : ''
              }.`,
              ...(task ? { task } : {}),
            },
          }
        }

        case 'enable':
        case 'disable': {
          const id = input.id!.trim()
          const enabled = input.action === 'enable'
          const payload = await callLocalScheduledTasksApi<unknown>({
            method: 'PUT',
            segments: [id],
            body: { enabled },
          })
          const task = summarizeTask(responseTask(payload))
          return {
            data: {
              action: input.action,
              message: `Scheduled task ${id} is now ${enabled ? 'enabled' : 'disabled'}.`,
              ...(task ? { task } : {}),
            },
          }
        }

        case 'delete': {
          const id = input.id!.trim()
          await callLocalScheduledTasksApi<unknown>({
            method: 'DELETE',
            segments: [id],
          })
          return {
            data: {
              action: 'delete',
              message: `Deleted scheduled task ${id}.`,
            },
          }
        }

        case 'run': {
          const id = input.id!.trim()
          await callLocalScheduledTasksApi<unknown>({
            method: 'POST',
            segments: [id, 'run'],
          })
          return {
            data: {
              action: 'run',
              message: `Started an immediate run of scheduled task ${id}. Its schedule is unchanged.`,
            },
          }
        }
      }
    } catch (error) {
      throw new Error(describeLocalScheduledTaskApiError(error))
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines: string[] = [output.message]
    if (output.tasks && output.tasks.length > 0) {
      for (const task of output.tasks) {
        const state = task.enabled === false ? 'disabled' : 'enabled'
        const next = task.nextRunAt ? `, next run ${task.nextRunAt}` : ''
        lines.push(
          `- ${task.id}${task.name ? ` [${task.name}]` : ''} — ${describeSchedule(task.cron)} (${state}${next})`,
        )
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
  renderToolUseMessage(input) {
    return `${LOCAL_SCHEDULED_TASK_TOOL_NAME}: ${input.action ?? ''}${
      input.id ? ` ${input.id}` : ''
    }`
  },
} satisfies ToolDef<InputSchema, LocalScheduledTaskOutput>)