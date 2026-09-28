import { useCallback, useEffect, useRef, useState } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { parseRunOutput } from '../../lib/parseRunOutput'
import { tasksApi } from '../../api/tasks'
import type {
  NotificationDeliveryChannel,
  NotificationDeliveryRecord,
  TaskNotificationConfig,
  TaskRun,
} from '../../types/task'
import {
  deriveChannelNotificationStatus,
  NOTIFICATION_CHANNEL_IDS,
  type ChannelNotificationStatus,
  type DeliveriesLoadState,
} from './runNotificationStatus'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'

function RunOutput({ run }: { run: TaskRun }) {
  const t = useTranslation()

  // Show error prominently if present. The `/20` + `/28` alpha fills this used
  // are exactly what Safari 15 WebView refuses to parse, so on the desktop
  // shell the box rendered as bare red text with no panel around it.
  if (run.error) {
    return (
      <ErrorState
        size="sm"
        className="mt-3"
        title={t('common.error')}
        detail={
          <span className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{run.error}</span>
        }
      />
    )
  }

  const text = parseRunOutput(run.output || '')

  if (!text) {
    return (
      <Card radius="lg" padding="none" className="mt-3 px-[18px] py-3 text-xs italic text-[var(--color-text-tertiary)]">
        {run.sessionId ? t('tasks.outputHintSession') : t('tasks.noOutputText')}
      </Card>
    )
  }

  // The handoff's "summary card": a bordered sheet on the page ground rather
  // than a tinted inset, so the commit hashes inside it read as badges against
  // a surface instead of two greys stacked on each other.
  return (
    <Card radius="lg" padding="none" className="mt-3 max-h-48 overflow-y-auto px-[22px] py-[18px]">
      <MarkdownRenderer
        content={text}
        variant="compact"
        className="break-words"
      />
    </Card>
  )
}

type Props = {
  taskId: string
  onClose: () => void
  refreshKey?: number
}

const STATUS_CONFIG: Record<string, { icon: string; color: string }> = {
  running:   { icon: 'sync',         color: 'var(--color-warning)' },
  completed: { icon: 'check_circle', color: 'var(--color-success)' },
  failed:    { icon: 'error',        color: 'var(--color-error)' },
  timeout:   { icon: 'timer_off',    color: 'var(--color-error)' },
}

const CHANNEL_LABEL_KEY: Record<NotificationDeliveryChannel, TranslationKey> = {
  telegram: 'settings.adapters.platform.telegram',
  feishu: 'settings.adapters.platform.feishu',
}

function statusLabelKey(status: ChannelNotificationStatus): TranslationKey {
  switch (status.kind) {
    case 'loading': return 'tasks.delivery.loading'
    case 'unavailable': return 'tasks.delivery.unavailable'
    case 'notConfigured':
      if (status.reason === 'noRecipients') return 'tasks.delivery.noRecipients'
      if (status.reason === 'channelInactive') return 'tasks.delivery.channelInactive'
      return 'tasks.delivery.notConfigured'
    case 'notSent': return 'tasks.delivery.notSent'
    case 'sending': return 'tasks.delivery.sending'
    case 'delivered': return 'tasks.delivery.delivered'
    case 'partial': return 'tasks.delivery.partial'
    case 'failed': return 'tasks.delivery.failed'
    case 'indeterminate': return 'tasks.delivery.indeterminate'
  }
}

/** A recorded failure or uncertainty outranks a partial success; only an
 *  all-delivered set may be green. */
function statusTone(status: ChannelNotificationStatus): Tone {
  switch (status.kind) {
    case 'delivered': return 'success'
    case 'failed': return 'danger'
    case 'partial': return 'warning'
    case 'indeterminate': return 'warning'
    case 'unavailable': return 'warning'
    case 'sending': return 'info'
    default: return 'neutral'
  }
}

/** What the panel has stored for one run's delivery fetch. */
type DeliveriesState = {
  status: DeliveriesLoadState
  deliveries: NotificationDeliveryRecord[]
}

/**
 * Whether the task is configured to send at least one IM notification. Only
 * then is a terminal run with no delivery record yet a race — the server writes
 * the `pending` row only once it enqueues the send — rather than a final
 * "not sent". Reuses the config logic the badge renders with, so the decision to
 * poll and the displayed status cannot disagree.
 */
function expectsImDelivery(notification: TaskNotificationConfig | undefined): boolean {
  if (!notification) return false
  return NOTIFICATION_CHANNEL_IDS.some((channel) =>
    deriveChannelNotificationStatus({
      channel,
      records: [],
      notification,
      runStatus: 'completed',
      loadState: 'loaded',
    }).kind !== 'notConfigured')
}

/**
 * A `pending` record is written immediately before the send and settles only
 * when the platform answers, so it is provisional for as long as it lasts.
 */
function hasPendingDelivery(state: DeliveriesState | undefined): boolean {
  return state?.status === 'loaded'
    && state.deliveries.some((record) => record.outcome === 'pending')
}

/**
 * An empty answer is provisional only while the task expects an IM send: the run
 * row can flip to terminal before the notification is enqueued. With no usable
 * target nothing will ever be written, so "not sent" is already final.
 */
function isAwaitingFirstDelivery(
  state: DeliveriesState | undefined,
  expectsIm: boolean,
): boolean {
  return expectsIm && state?.status === 'loaded' && state.deliveries.length === 0
}

/**
 * Whether the stored answer may still be replaced by a later fetch. Caching a
 * provisional answer would pin "Sending"/"Not sent" on the row even after the
 * send succeeded. A `loading` entry already has a request in flight, and an
 * `error` will not answer differently on a retry, so neither counts.
 */
function shouldRecheckDeliveries(state: DeliveriesState | undefined, expectsIm: boolean): boolean {
  return hasPendingDelivery(state) || isAwaitingFirstDelivery(state, expectsIm)
}

function statusCounts(status: ChannelNotificationStatus): Array<{ key: TranslationKey; count: number }> {
  const parts: Array<{ key: TranslationKey; count: number }> =
    status.kind === 'partial'
      ? [
        { key: 'tasks.delivery.countDelivered', count: status.delivered },
        { key: 'tasks.delivery.countFailed', count: status.failed },
        { key: 'tasks.delivery.countIndeterminate', count: status.indeterminate },
      ]
      : status.kind === 'failed'
        ? [
          { key: 'tasks.delivery.countFailed', count: status.failed },
          { key: 'tasks.delivery.countIndeterminate', count: status.indeterminate },
        ]
        : status.kind === 'delivered'
          ? [{ key: 'tasks.delivery.countDelivered', count: status.delivered }]
          : status.kind === 'indeterminate'
            ? [{ key: 'tasks.delivery.countIndeterminate', count: status.indeterminate }]
            : []
  return parts.filter((part) => part.count > 0)
}

/**
 * Per-channel notification outcome for one run. Both IM channels are always
 * shown, because "nothing was sent" and "the task has no target configured" are
 * different facts a reader needs told apart — and neither is success.
 */
function RunNotificationStatus({
  run,
  records,
  loadState,
  notification,
}: {
  run: TaskRun
  records: NotificationDeliveryRecord[]
  loadState: DeliveriesLoadState
  notification: TaskNotificationConfig | undefined
}) {
  const t = useTranslation()
  return (
    <div
      className="mt-3 border-t border-[var(--color-border-separator)] pt-2.5"
      role="group"
      aria-label={t('tasks.delivery.title')}
    >
      <div className="text-[12.5px] font-bold text-[var(--color-text-secondary)]">
        {t('tasks.delivery.title')}
      </div>
      <div className="mt-1.5 space-y-1.5">
        {NOTIFICATION_CHANNEL_IDS.map((channel) => {
          const status = deriveChannelNotificationStatus({
            channel,
            records,
            notification,
            runStatus: run.status,
            loadState,
          })
          const counts = statusCounts(status)
          return (
            <div key={channel} className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-[13px] text-[var(--color-text-primary)]">
                {t(CHANNEL_LABEL_KEY[channel])}
              </span>
              <Badge
                tone={statusTone(status)}
                size="sm"
                data-testid={`run-delivery-${channel}`}
              >
                {t(statusLabelKey(status))}
              </Badge>
              {counts.length > 0 && (
                <span className="text-[12.5px] tabular-nums text-[var(--color-text-tertiary)]">
                  {counts.map((part) => t(part.key, { count: part.count })).join(' · ')}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function TaskRunsPanel({ taskId, onClose, refreshKey }: Props) {
  const t = useTranslation()
  const { fetchTaskRuns, fetchTaskRunDetail } = useTaskStore()
  const connectToSession = useChatStore((s) => s.connectToSession)
  const openTab = useTabStore((s) => s.openTab)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<{
    runId: string
    status: 'loading' | 'error'
  } | null>(null)
  const [deliveriesByRun, setDeliveriesByRun] = useState<Record<string, DeliveriesState>>({})
  const requestGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const deliveriesGeneration = useRef(0)
  const selectedRunId = useRef<string | null>(null)
  const currentTaskId = useRef(taskId)
  const mounted = useRef(true)
  const detailAbortController = useRef<AbortController | null>(null)
  const deliveriesAbortController = useRef<AbortController | null>(null)
  // The task's own notification config decides "not configured"; the run's
  // records decide the delivered/failed/indeterminate outcome.
  const notification = useTaskStore((s) => s.tasks.find((item) => item.id === taskId)?.notification)
  // Whether an empty delivery answer for this task is a race worth re-checking,
  // or already the final "nothing was sent".
  const expectsIm = expectsImDelivery(notification)

  const openSession = (sessionId: string, taskName?: string) => {
    openTab(sessionId, taskName || 'Task Run')
    connectToSession(sessionId)
  }

  const cancelDetailRequest = useCallback(() => {
    detailAbortController.current?.abort()
    detailAbortController.current = null
  }, [])

  /**
   * Dropping the `loading` entries is what makes a later expand re-fetch: an
   * aborted request never settles, so leaving it as `loading` would strand the
   * row on a placeholder forever.
   */
  const cancelDeliveriesRequest = useCallback(() => {
    deliveriesAbortController.current?.abort()
    deliveriesAbortController.current = null
    deliveriesGeneration.current += 1
    if (!mounted.current) return
    setDeliveriesByRun((current) => {
      const next: typeof current = {}
      for (const [runId, state] of Object.entries(current)) {
        if (state.status !== 'loading') next[runId] = state
      }
      return next
    })
  }, [])

  const loadDeliveries = useCallback(async (runId: string) => {
    deliveriesAbortController.current?.abort()
    const controller = new AbortController()
    deliveriesAbortController.current = controller
    const generation = ++deliveriesGeneration.current
    const requestedTaskId = taskId
    setDeliveriesByRun((current) => {
      // Keep the previous answer visible while a re-check is in flight. Flipping
      // back to `loading` would blank the provisional/settled signal the poll
      // keys on, and since every re-check would then restart the poll window a
      // provisional answer could never age out.
      if (current[runId]) return current
      return { ...current, [runId]: { status: 'loading', deliveries: [] } }
    })
    try {
      const { deliveries } = await tasksApi.getRunDeliveries(runId, { signal: controller.signal })
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentTaskId.current !== requestedTaskId ||
        deliveriesGeneration.current !== generation
      ) return
      setDeliveriesByRun((current) => ({
        ...current,
        [runId]: { status: 'loaded', deliveries },
      }))
    } catch {
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentTaskId.current !== requestedTaskId ||
        deliveriesGeneration.current !== generation
      ) return
      // A failed request must surface as unknown, not as "not sent".
      setDeliveriesByRun((current) => ({
        ...current,
        [runId]: { status: 'error', deliveries: [] },
      }))
    } finally {
      if (deliveriesAbortController.current === controller) {
        deliveriesAbortController.current = null
      }
    }
  }, [taskId])

  const refresh = useCallback(() => {
    const generation = ++requestGeneration.current
    fetchTaskRuns(taskId, { limit: 100, summaryOnly: true }).then((r) => {
      if (generation !== requestGeneration.current) return
      setRuns((current) => {
        const previousById = new Map(current.map(run => [run.id, run]))
        return r.map((run) => {
          const previous = previousById.get(run.id)
          return {
            ...run,
            ...(run.output === undefined && previous?.output !== undefined
              ? { output: previous.output }
              : {}),
            ...(run.error === undefined && previous?.error !== undefined
              ? { error: previous.error }
              : {}),
          }
        })
      })
      const selectedId = selectedRunId.current
      if (selectedId && r.some(run =>
        run.id === selectedId && (!!run.output || !!run.error),
      )) {
        cancelDetailRequest()
        detailGeneration.current += 1
        setDetailState(null)
      }
      setLoading(false)
    }).catch(() => {
      if (generation === requestGeneration.current) setLoading(false)
    })
  }, [cancelDetailRequest, fetchTaskRuns, taskId])

  const loadDetail = async (run: TaskRun) => {
    cancelDetailRequest()
    const controller = new AbortController()
    detailAbortController.current = controller
    const requestedTaskId = taskId
    const requestedDetailGeneration = detailGeneration.current + 1
    detailGeneration.current = requestedDetailGeneration
    selectedRunId.current = run.id
    setDetailState({ runId: run.id, status: 'loading' })
    try {
      const detail = await fetchTaskRunDetail(run.id, { signal: controller.signal })
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentTaskId.current !== requestedTaskId ||
        detailGeneration.current !== requestedDetailGeneration ||
        selectedRunId.current !== run.id
      ) return
      setRuns((current) => current.map((item) => {
        if (item.id !== detail.id || item.taskId !== requestedTaskId) return item
        if (item.output || item.error) return item
        return detail
      }))
      setDetailState(null)
    } catch {
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentTaskId.current === requestedTaskId &&
        detailGeneration.current === requestedDetailGeneration &&
        selectedRunId.current === run.id
      ) {
        setDetailState({ runId: run.id, status: 'error' })
      }
    } finally {
      if (detailAbortController.current === controller) {
        detailAbortController.current = null
      }
    }
  }

  const toggleOutput = (run: TaskRun) => {
    if (expandedId === run.id) {
      cancelDetailRequest()
      cancelDeliveriesRequest()
      selectedRunId.current = null
      detailGeneration.current += 1
      setDetailState(null)
      setExpandedId(null)
      return
    }
    cancelDetailRequest()
    cancelDeliveriesRequest()
    selectedRunId.current = run.id
    setDetailState(null)
    setExpandedId(run.id)
    if (!run.output && !run.error && (run.hasOutput || run.hasError)) {
      void loadDetail(run)
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelDetailRequest()
      cancelDeliveriesRequest()
      selectedRunId.current = null
      detailGeneration.current += 1
    }
  }, [cancelDeliveriesRequest, cancelDetailRequest])

  useEffect(() => {
    cancelDetailRequest()
    cancelDeliveriesRequest()
    currentTaskId.current = taskId
    selectedRunId.current = null
    detailGeneration.current += 1
    setDetailState(null)
    setExpandedId(null)
  }, [cancelDeliveriesRequest, cancelDetailRequest, taskId])

  // Load the run's notification deliveries once it is terminal. A running run
  // has nothing queued yet; the poll flips it to terminal and this effect then
  // fetches, so the status never claims a result that has not settled.
  //
  // Only a settled answer is cached. The first fetch can land before the server
  // has written anything (or while the send is still `pending`), and caching
  // that answer would pin "Sending"/"Not sent" on the row even after the send
  // succeeded. A later list refresh re-asks while the stored answer is
  // provisional; once it is final the effect stops, so a settled run is not
  // re-fetched on every poll. The stored value is read through a ref rather than
  // a dependency because recording the answer must not itself re-trigger the
  // fetch that produced it.
  const expandedRun = runs.find((run) => run.id === expandedId) ?? null
  const deliveriesByRunRef = useRef(deliveriesByRun)
  deliveriesByRunRef.current = deliveriesByRun
  useEffect(() => {
    if (!expandedRun) return
    if (expandedRun.status === 'running') return
    const stored = deliveriesByRunRef.current[expandedRun.id]
    if (stored && !shouldRecheckDeliveries(stored, expectsIm)) return
    void loadDeliveries(expandedRun.id)
  }, [expandedRun, expectsIm, loadDeliveries])

  // Initial fetch + re-fetch when refreshKey changes
  useEffect(() => {
    setLoading(true)
    refresh()
    return () => { requestGeneration.current += 1 }
  }, [refresh, refreshKey])

  // Auto-poll while any run is "running", shortly after a manual trigger, or
  // while the expanded run's delivery answer is still provisional. The last case
  // needs no external refreshKey: opening a run that finished moments ago can
  // legitimately see `pending` or an empty list, and without the poll nothing
  // would ever ask again, so the row would sit on "Sending"/"Not sent" forever.
  //
  // Uses faster 1s polling for the first 10s after refreshKey changes, then 3s.
  const hasRunning = runs.some((r) => r.status === 'running')
  const storedDeliveries = expandedId ? deliveriesByRun[expandedId] : undefined
  const recheckPending = hasPendingDelivery(storedDeliveries)
  const awaitingFirst = isAwaitingFirstDelivery(storedDeliveries, expectsIm)
  useEffect(() => {
    if (!hasRunning && !recheckPending && !awaitingFirst && refreshKey === 0) return
    // Start with fast polling (1s) to give snappy feedback after "Run Now"
    let interval = 1000
    let timer = setInterval(refresh, interval)
    // After 10s, switch to slower 3s polling if still running
    const slowDown = setTimeout(() => {
      clearInterval(timer)
      // A `pending` send settles on the platform's own schedule, so keep asking
      // until it does; an empty answer is only re-checked inside this window.
      if (hasRunning || recheckPending) {
        timer = setInterval(refresh, 3000)
      }
    }, 10000)
    // If nothing is running or pending and initial window passes, stop entirely
    const stopTimer = hasRunning || recheckPending ? undefined : setTimeout(() => clearInterval(timer), 12000)
    return () => {
      clearInterval(timer)
      clearTimeout(slowDown)
      if (stopTimer) clearTimeout(stopTimer)
    }
  }, [awaitingFirst, hasRunning, recheckPending, taskId, refreshKey, refresh])

  return (
    // A drawer under its row, not a card inside it: the border-top continues
    // the list's own separator and the fill is the next surface layer down.
    <div className="border-t border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pb-1.5 pt-3.5">
        <span className="text-[14.5px] font-bold text-[var(--color-text-primary)]">{t('tasks.logsTitle')}</span>
        <IconButton
          icon={<span className="material-symbols-outlined text-[16px]">close</span>}
          label={t('tasks.close')}
          size="xs"
          tone="muted"
          onClick={onClose}
        />
      </div>

      {/* Content */}
      <div className="max-h-64 overflow-y-auto px-5 pb-4">
        {loading ? (
          // Same 16px brand spinner in the same `py-6` box; the label goes from
          // an `aria-label` on the SVG to an `aria-live` region, so the wait is
          // announced rather than only readable on focus.
          <LoadingState size="sm" label={t('common.loading')} labelHidden />
        ) : runs.length === 0 ? (
          <EmptyState variant="plain" size="sm" description={t('tasks.noLogs')} />
        ) : (
          <div className="divide-y divide-[var(--color-border-separator)]">
            {runs.map((run) => {
              const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.failed!
              const isExpanded = expandedId === run.id
              return (
                <div key={run.id} className="py-2.5">
                  <div className="flex items-center gap-[11px]">
                    {/* Status icon */}
                    <span
                      aria-hidden="true"
                      className={`material-symbols-outlined shrink-0 text-[17px] ${run.status === 'running' ? 'animate-spin' : ''}`}
                      style={{ color: cfg.color, fontVariationSettings: "'FILL' 1" }}
                    >
                      {cfg.icon}
                    </span>

                    {/* Status text */}
                    <span className="text-[13.5px] font-bold" style={{ color: cfg.color }}>
                      {t(`tasks.runStatus.${run.status}` as any)} {/* dynamic key */}
                    </span>

                    {/* Time — mono, so timestamps line up down the column */}
                    <span className="font-mono text-[13px] tabular-nums text-[var(--color-text-secondary)]">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>

                    {/* Duration */}
                    {run.durationMs != null && (
                      <span className="text-[13px] text-[var(--color-text-tertiary)]">
                        {t('tasks.duration', { s: Math.round(run.durationMs / 1000) })}
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                      {/* Open session — only after run completes (session is empty while running) */}
                      {run.sessionId && run.status !== 'running' && (
                        <Button
                          variant="link"
                          size="sm"
                          icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">north_east</span>}
                          iconPosition="end"
                          onClick={() => openSession(run.sessionId!, run.taskName)}
                        >
                          {t('tasks.openSession')}
                        </Button>
                      )}

                      {/* Summary toggle */}
                      {(run.output || run.error || run.hasOutput || run.hasError) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={isExpanded}
                          onClick={() => { void toggleOutput(run) }}
                        >
                          {isExpanded ? t('tasks.hideOutput') : t('tasks.viewOutput')}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expanded output + per-channel notification status */}
                  {isExpanded && (
                    <>
                      {(run.output || run.error) ? (
                        <RunOutput run={run} />
                      ) : detailState?.runId === run.id && detailState.status === 'loading' ? (
                        <Card radius="lg" padding="none" className="mt-3 px-[18px] py-3 text-xs text-[var(--color-text-tertiary)]">
                          {t('common.loading')}
                        </Card>
                      ) : detailState?.runId === run.id && detailState.status === 'error' ? (
                        <ErrorState
                          size="sm"
                          className="mt-3"
                          title={t('common.error')}
                          onRetry={() => { void loadDetail(run) }}
                          retryLabel={t('common.retry')}
                        />
                      ) : (
                        <RunOutput run={run} />
                      )}
                      <RunNotificationStatus
                        run={run}
                        records={deliveriesByRun[run.id]?.deliveries ?? []}
                        loadState={deliveriesByRun[run.id]?.status ?? 'loading'}
                        notification={notification}
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
