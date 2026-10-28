import { z } from 'zod/v4'

const text = z.string().trim().min(1).max(20_000)
export const taskDeliveryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit'), requestId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(), version: z.number().int().positive(), artifact: text, criteria: text }).strict(),
  z.object({ action: z.literal('accept'), requestId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(), version: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('return'), requestId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(), version: z.number().int().positive(), reason: text }).strict(),
])
export type TaskDeliveryAction = z.infer<typeof taskDeliveryActionSchema>
export const taskDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  submissions: z.array(z.object({
    version: z.number().int().positive(), artifact: text, criteria: text,
    owner: z.string().min(1), submittedAt: z.number(),
    review: z.object({ decision: z.enum(['accept', 'return']), reviewer: z.string().min(1), reason: z.string().optional(), reviewedAt: z.number() }).passthrough().optional(),
  }).passthrough()),
  receipts: z.array(z.object({ requestId: z.string(), fingerprint: z.string() }).passthrough()),
  notices: z.array(z.object({ id: z.string(), recipient: z.string(), text: z.string(), delivered: z.boolean() }).passthrough()),
}).passthrough()
export type TaskDelivery = z.infer<typeof taskDeliverySchema>

/** The protocol's empty history. A task with no reviews is not an accepted artifact. */
export function emptyTaskDelivery(): TaskDelivery {
  return { schemaVersion: 1, revision: 0, submissions: [], receipts: [], notices: [] }
}

/**
 * A delivery written by a newer version, or damaged on disk, is preserved for
 * a human to inspect but never interpreted. The task stays visible and
 * read-only instead of vanishing, and a `completed` status cannot satisfy a
 * dependency while its acceptance history is unreadable.
 */
export const TASK_DELIVERY_UNSUPPORTED_ERROR = 'Task delivery history is unsupported or damaged; this task is read-only'

function failClosedStatus(status: unknown): unknown {
  return status === 'completed' ? 'in_progress' : status
}

/** Old tasks have no delivery history. Reading them never invents an acceptance. */
export function migrateTaskDeliveryRecord(record: Record<string, unknown>): Record<string, unknown> {
  const marked = record.deliveryUnsupported !== undefined || record.deliveryError !== undefined
  if (!marked && record.delivery === undefined) {
    return { ...record, delivery: emptyTaskDelivery() }
  }
  const parsed = marked ? undefined : taskDeliverySchema.safeParse(record.delivery)
  if (parsed?.success) return { ...record, delivery: parsed.data }
  const unsupported = marked ? record.deliveryUnsupported ?? record.delivery : record.delivery
  return {
    ...record,
    // Kept as a valid, empty history so every reader (including the desktop
    // API) still sees the task; the real record lives beside it, in memory
    // only, until a supported version can interpret it.
    delivery: emptyTaskDelivery(),
    deliveryError: TASK_DELIVERY_UNSUPPORTED_ERROR,
    ...(unsupported === undefined ? {} : { deliveryUnsupported: unsupported }),
    status: failClosedStatus(record.status),
  }
}

/** True for a task whose delivery record could not be interpreted. */
export function isTaskDeliveryUnsupported(task: { deliveryError?: string; deliveryUnsupported?: unknown }): boolean {
  return task.deliveryError !== undefined || task.deliveryUnsupported !== undefined
}

export function isTaskAwaitingReview(task: { delivery?: TaskDelivery }): boolean {
  const latest = task.delivery?.submissions.at(-1)
  return latest !== undefined && latest.review === undefined
}