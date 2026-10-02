import { api } from './client'
import type {
  CronTask,
  CreateTaskInput,
  NotificationDeliveryRecord,
  TaskRun,
  TaskUpdateInput,
} from '../types/task'

type TasksResponse = { tasks: CronTask[] }
type TaskResponse = { task: CronTask }
type RunsResponse = {
  runs: TaskRun[]
  nextCursor?: string
  revision?: number
  revisionToken?: string
  reset?: boolean
}
type RunsOptions = {
  limit?: number
  cursor?: string
  summaryOnly?: boolean
  nonterminalOnly?: boolean
  completedAfterMs?: number
}

function runsQuery(options: RunsOptions): string {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.summaryOnly) params.set('summaryOnly', 'true')
  if (options.nonterminalOnly) params.set('nonterminalOnly', 'true')
  if (options.completedAfterMs !== undefined) {
    params.set('completedAfterMs', String(options.completedAfterMs))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const tasksApi = {
  list() {
    return api.get<TasksResponse>('/api/scheduled-tasks', { timeout: 15_000 })
  },

  create(input: CreateTaskInput) {
    return api.post<TaskResponse>('/api/scheduled-tasks', input)
  },

  update(id: string, updates: TaskUpdateInput) {
    return api.put<TaskResponse>(`/api/scheduled-tasks/${id}`, updates)
  },

  delete(id: string) {
    return api.delete<{ ok: true }>(`/api/scheduled-tasks/${id}`)
  },

  runTask(id: string) {
    return api.post<{ ok: true }>(`/api/scheduled-tasks/${id}/run`, {})
  },

  stopRun(taskId: string, runId: string) {
    return api.post<{ run: TaskRun }>(`/api/scheduled-tasks/${taskId}/runs/${runId}/stop`, {})
  },

  deleteRun(taskId: string, runId: string) {
    return api.delete<{ ok: true }>(`/api/scheduled-tasks/${taskId}/runs/${runId}`)
  },

  getRecentRuns(limit = 50, options: Omit<RunsOptions, 'limit'> = {}) {
    return api.get<RunsResponse>(`/api/scheduled-tasks/runs${runsQuery({ ...options, limit })}`)
  },

  getTaskRuns(taskId: string, options: RunsOptions = {}) {
    return api.get<RunsResponse>(`/api/scheduled-tasks/${taskId}/runs${runsQuery(options)}`)
  },

  getRunDetail(runId: string, options?: { signal?: AbortSignal }) {
    return api.get<{ run: TaskRun }>(`/api/scheduled-tasks/runs/${runId}`, options)
  },

  /**
   * Per-recipient notification delivery records for one run. The server exposes
   * the persisted outcomes (`pending`/`delivered`/`failed`/`indeterminate`) so
   * the panel can show Telegram and Feishu status separately. There is
   * deliberately no client-side guess: an empty list means nothing was queued,
   * and a failed request is reported as unknown rather than "not sent".
   */
  getRunDeliveries(runId: string, options?: { signal?: AbortSignal }) {
    return api.get<{ deliveries: NotificationDeliveryRecord[] }>(
      `/api/scheduled-tasks/runs/${runId}/deliveries`,
      options,
    )
  },
}
