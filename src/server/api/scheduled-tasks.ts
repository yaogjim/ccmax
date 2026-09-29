/**
 * Scheduled Tasks REST API
 *
 * GET    /api/scheduled-tasks           — 获取任务列表
 * POST   /api/scheduled-tasks           — 创建任务
 * GET    /api/scheduled-tasks/runs      — 获取所有任务的最近执行记录
 * GET    /api/scheduled-tasks/runs/:runId/deliveries — 获取该次执行的投递记录
 * GET    /api/scheduled-tasks/:id/runs  — 获取指定任务的执行记录
 * POST   /api/scheduled-tasks/:id/run   — 立即执行指定任务
 * PUT    /api/scheduled-tasks/:id       — 更新任务
 * DELETE /api/scheduled-tasks/:id       — 删除任务
 */

import { CronService, type CronTask } from '../services/cronService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import {
  NotificationDeliveryStore,
  getNotificationDeliveryStorePath,
} from '../services/notificationDeliveryStore.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const cronService = new CronService()

/**
 * Upper bound on how long the manual-run endpoint waits for the run record to
 * land before returning. The task itself keeps running in the background.
 */
const MANUAL_RUN_START_TIMEOUT_MS = 5_000

/**
 * Upper bound on how many delivery rows one run query returns. A single run
 * notifies one recipient per channel, so this only guards against a corrupted
 * or unexpectedly large log.
 */
const MAX_DELIVERIES_PER_RUN = 200

export async function handleScheduledTasksApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const taskId = segments[2] // /api/scheduled-tasks/:id  or "runs"
    const subResource = segments[3] // /api/scheduled-tasks/:id/runs
    const subSubResource = segments[4] // /api/scheduled-tasks/runs/:runId/deliveries

    // ── POST /api/scheduled-tasks/:id/runs/:runId/stop ────────────────
    const runAction = segments[5]
    if (method === 'POST' && taskId && subResource === 'runs' && subSubResource && runAction === 'stop') {
      const run = await cronScheduler.stopRun(taskId, subSubResource)
      return Response.json({ run })
    }
    if (method === 'DELETE' && taskId && subResource === 'runs' && subSubResource && !runAction) {
      await cronScheduler.deleteRun(taskId, subSubResource)
      return Response.json({ ok: true })
    }

    // ── GET /api/scheduled-tasks/runs/:runId/deliveries ──────────────────
    // The delivery journal for one run: which destinations were attempted and
    // how each attempt ended. Unknown runs are a 404 so a caller cannot mistake
    // an empty list for "the run delivered nothing".
    if (method === 'GET' && taskId === 'runs' && subResource && subSubResource === 'deliveries') {
      const run = await cronScheduler.getRunDetail(subResource)
      if (!run) throw ApiError.notFound(`Scheduled run ${subResource} not found`)

      const store = new NotificationDeliveryStore(getNotificationDeliveryStorePath())
      const deliveries = await store.list({ runId: subResource, limit: MAX_DELIVERIES_PER_RUN })
      return Response.json({ runId: subResource, deliveries })
    }

    // ── GET /api/scheduled-tasks/runs/:runId ─────────────────────────────
    if (method === 'GET' && taskId === 'runs' && subResource) {
      const run = await cronScheduler.getRunDetail(subResource)
      if (!run) throw ApiError.notFound(`Scheduled run ${subResource} not found`)
      return Response.json({ run })
    }

    if (method === 'GET' && taskId === 'runs') {
      const url = new URL(req.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const cursor = url.searchParams.get('cursor') || undefined
      const summaryOnly = url.searchParams.get('summaryOnly') === 'true'
      const nonterminalOnly = url.searchParams.get('nonterminalOnly') === 'true'
      const completedAfterParam = url.searchParams.get('completedAfterMs')
      const completedAfterMs = completedAfterParam === null
        ? undefined
        : Number(completedAfterParam)
      if (completedAfterMs !== undefined && (!Number.isFinite(completedAfterMs) || completedAfterMs < 0)) {
        throw ApiError.badRequest('Invalid completedAfterMs parameter')
      }
      if (!cursor && !summaryOnly && !nonterminalOnly && completedAfterMs === undefined) {
        const runs = await cronScheduler.getRecentRuns(limit)
        return Response.json({ runs })
      }
      return Response.json(await cronScheduler.getRunsPage({
        limit,
        cursor,
        summaryOnly,
        nonterminalOnly,
        completedAfterMs,
      }))
    }

    // ── GET /api/scheduled-tasks/:id/runs ────────────────────────────────
    if (method === 'GET' && taskId && subResource === 'runs') {
      const url = new URL(req.url)
      const cursor = url.searchParams.get('cursor') || undefined
      const limitParam = url.searchParams.get('limit')
      const summaryOnly = url.searchParams.get('summaryOnly') === 'true'
      const nonterminalOnly = url.searchParams.get('nonterminalOnly') === 'true'
      const completedAfterParam = url.searchParams.get('completedAfterMs')
      const completedAfterMs = completedAfterParam === null
        ? undefined
        : Number(completedAfterParam)
      if (completedAfterMs !== undefined && (!Number.isFinite(completedAfterMs) || completedAfterMs < 0)) {
        throw ApiError.badRequest('Invalid completedAfterMs parameter')
      }
      if (!cursor && !limitParam && !summaryOnly && !nonterminalOnly && completedAfterMs === undefined) {
        const runs = await cronScheduler.getTaskRuns(taskId)
        return Response.json({ runs })
      }
      const limit = parseInt(limitParam || '50', 10)
      return Response.json(await cronScheduler.getRunsPage({
        taskId,
        limit,
        cursor,
        summaryOnly,
        nonterminalOnly,
        completedAfterMs,
      }))
    }

    // ── GET /api/scheduled-tasks ──────────────────────────────────────────
    if (method === 'GET' && !taskId) {
      const tasks = await cronService.listTasks()
      return Response.json({ tasks })
    }

    // ── POST /api/scheduled-tasks ─────────────────────────────────────────
    if (method === 'POST' && !taskId) {
      const body = await parseJsonBody(req)
      const task = await cronService.createTask({
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        cron: body.cron as string,
        prompt: body.prompt as string,
        enabled: body.enabled !== undefined ? (body.enabled as boolean) : undefined,
        recurring: body.recurring as boolean | undefined,
        permanent: body.permanent as boolean | undefined,
        permissionMode: body.permissionMode as string | undefined,
        model: body.model as string | undefined,
        providerId: body.providerId as string | null | undefined,
        folderPath: body.folderPath as string | undefined,
        useWorktree: body.useWorktree as boolean | undefined,
        notification: body.notification as CronTask['notification'],
      })
      return Response.json({ task }, { status: 201 })
    }

    // ── POST /api/scheduled-tasks/:id/run ──────────────────────────────────
    // Fire-and-forget: start execution in background, return immediately.
    // The frontend polls GET /:id/runs to track progress. We wait for the
    // "running" record to be on disk instead of guessing with a fixed delay, so
    // an immediate poll can always see the run.
    if (method === 'POST' && taskId && subResource === 'run') {
      const tasks = await cronService.listTasks()
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw ApiError.notFound(`Task ${taskId} not found`)

      let markStarted: () => void = () => {}
      const started = new Promise<'started'>((resolve) => {
        markStarted = () => resolve('started')
      })
      const execution = cronScheduler.executeTask(task, {
        createSession: true,
        onRunStarted: markStarted,
      })
      void execution.catch((err) => {
        console.error(`[ScheduledTasks] Manual run failed for task ${taskId}:`, err)
      })
      let startTimer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        started,
        execution.then((run) => run.status === 'running' ? 'busy' : 'finished', () => 'failed'),
        new Promise<'timeout'>((resolve) => {
          startTimer = setTimeout(() => resolve('timeout'), MANUAL_RUN_START_TIMEOUT_MS)
        }),
      ])
      if (startTimer) clearTimeout(startTimer)
      if (outcome === 'busy') throw ApiError.conflict('Task is already running')
      if (outcome === 'failed') throw ApiError.internal('Task could not start')
      if (outcome === 'timeout') throw new ApiError(503, 'Task start has not been confirmed; check runs before retrying', 'START_TIMEOUT')
      return Response.json({ ok: true })
    }

    // ── PUT /api/scheduled-tasks/:id ──────────────────────────────────────
    if (method === 'PUT' && taskId && !subResource) {
      const body = await parseJsonBody(req)
      const task = await cronService.updateTask(taskId, body)
      return Response.json({ task })
    }

    // ── DELETE /api/scheduled-tasks/:id ───────────────────────────────────
    if (method === 'DELETE' && taskId && !subResource) {
      // A live runner must be settled before its task is removed; otherwise it
      // can write a fresh running record after deletion and strand the UI.
      for (const run of await cronScheduler.getTaskRuns(taskId)) {
        if (run.status === 'running') await cronScheduler.stopRun(taskId, run.id)
      }
      await cronScheduler.withTaskIdle(taskId, async () => {
        await cronService.deleteTask(taskId)
        await cronScheduler.deleteTaskRuns(taskId)
      })
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/scheduled-tasks${taskId ? `/${taskId}` : ''}${subResource ? `/${subResource}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
