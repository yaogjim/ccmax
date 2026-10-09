import { Fragment, useCallback, useState, useRef } from 'react'
import { CirclePause, CirclePlay, Clock, Ellipsis, LoaderCircle, Pencil, Play, ScrollText, Trash2 } from 'lucide-react'
import type { CronTask } from '../../types/task'
import { useTaskStore } from '../../stores/taskStore'
import { useTranslation } from '../../i18n'
import { describeCron } from '../../lib/cronDescribe'
import { TaskRunsPanel } from './TaskRunsPanel'
import { NewTaskModal } from './NewTaskModal'
import { ConfirmPopover } from '@/components/tasks/ConfirmPopover'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'

type Props = {
  task: CronTask
  showLogs: boolean
  onToggleLogs: () => void
}

type ConfirmAction = 'run' | 'toggle' | 'delete' | null

export function TaskRow({ task, showLogs, onToggleLogs }: Props) {
  const { deleteTask, updateTask, runTask } = useTaskStore()
  const t = useTranslation()
  const [showEdit, setShowEdit] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // One slot for the last mutation that failed: run, toggle and delete all
  // write here, so a stale toggle error cannot linger next to a fresh run.
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [logsRefreshKey, setLogsRefreshKey] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  // Synchronous reentry guards. `isRunning`/`isDeleting` only become visible on
  // the next render, so a second click dispatched in the same tick would slip
  // past a state-only check and start a duplicate request.
  const runInFlightRef = useRef(false)
  const deleteInFlightRef = useRef(false)

  // `enabled` predates some task files, and the backend treats a missing flag
  // as enabled. Reading `task.enabled` directly rendered every legacy task as
  // paused, with its Run button unavailable.
  const enabled = task.enabled !== false

  // Two overlays with independent open states, so two subscriptions rather
  // than one handler branching on both. The hand-rolled version listened on
  // `mousedown`, which does not fire reliably for touch — on the H5 build
  // tapping outside left this menu open. Escape now closes them too; neither
  // overlay lives inside a dialog, so no propagation guard is needed.
  const closeMenu = useCallback(() => setShowMenu(false), [])
  const closeConfirm = useCallback(() => setConfirmAction(null), [])

  useDismissable({ open: showMenu, refs: [menuRef], onDismiss: closeMenu })
  useDismissable({ open: confirmAction !== null, refs: [confirmRef], onDismiss: closeConfirm })

  const handleRunNow = async () => {
    // Guard before closing the popover: a double click on Confirm would
    // otherwise enqueue two runs.
    if (isRunning || runInFlightRef.current) return
    runInFlightRef.current = true
    setIsRunning(true)
    setActionError(null)
    if (!showLogs) onToggleLogs() // open logs panel (accordion will close others)
    try {
      await runTask(task.id)
      setConfirmAction(null)
      setLogsRefreshKey((k) => k + 1)
    } catch (err) {
      // Previously swallowed into `console.error`, so the row looked like it had
      // accepted the run while nothing happened.
      setActionError(err instanceof Error ? err.message : String(err))
      setConfirmAction(null)
    } finally {
      runInFlightRef.current = false
      setIsRunning(false)
    }
  }

  const handleToggle = async () => {
    // A second click while the first write is still in flight would start a
    // duplicate update; the confirm popover stays mounted until the promise
    // settles, so this guard is what actually blocks the repeat.
    if (isToggling) return
    setIsToggling(true)
    setActionError(null)
    try {
      await updateTask(task.id, { enabled: !enabled })
      setConfirmAction(null)
      setShowMenu(false)
    } catch (err) {
      // Previously the rejection was unhandled and the row stayed silent.
      setActionError(err instanceof Error ? err.message : String(err))
      setConfirmAction(null)
      setShowMenu(false)
    } finally {
      setIsToggling(false)
    }
  }

  const handleDelete = async () => {
    // Delete used to be a floating `deleteTask(id)` call: the rejection never
    // reached the screen, and every confirm click started another request.
    if (isDeleting || deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    setIsDeleting(true)
    setActionError(null)
    try {
      await deleteTask(task.id)
      setConfirmAction(null)
      setShowMenu(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      setConfirmAction(null)
      setShowMenu(false)
    } finally {
      deleteInFlightRef.current = false
      setIsDeleting(false)
    }
  }

  const menuItem = 'flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] transition-colors'

  // One meta line rather than three stacked fragments, per the handoff: the
  // row is scanned for its name and its schedule, and the rest reads as a
  // single caption. Dates sit in tabular mono so they line up down the list;
  // the labels and the free-text description stay in the UI face.
  const meta: Array<{ key: string; label?: string; value: string; mono: boolean }> = [
    { key: 'created', label: t('tasks.createdAt'), value: new Date(task.createdAt).toLocaleDateString(), mono: true },
    ...(task.lastFiredAt
      ? [{ key: 'last', label: t('tasks.lastRunAt'), value: new Date(task.lastFiredAt).toLocaleDateString(), mono: true }]
      : []),
    ...(task.description ? [{ key: 'desc', value: task.description, mono: false }] : []),
  ]

  return (
    <div>
      <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
        {/* Left: status + info */}
        <StatusDot
          tone={enabled ? 'success' : 'neutral'}
          size="md"
          label={enabled ? t('tasks.active') : t('tasks.disabled')}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">{task.name}</div>
          <div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">
            {meta.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 && ' · '}
                {part.label}
                {part.mono
                  ? <span className="font-mono text-[11px] tabular-nums">{part.value}</span>
                  : part.value}
              </Fragment>
            ))}
          </div>
        </div>

        {/* Right: schedule + actions. The schedule is a sentence, not code, so
            it is not set in mono; the raw cron stays on hover. */}
        <Badge title={task.cron} icon={<Clock size={11} strokeWidth={2} aria-hidden="true" />}>
          {describeCron(task.cron, t)}
        </Badge>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* Run Now */}
          <div className="relative" ref={confirmAction === 'run' ? confirmRef : undefined}>
            <IconButton
              icon={isRunning
                ? <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="animate-spin text-[var(--color-info)]" />
                : <Play size={16} strokeWidth={1.75} aria-hidden="true" />}
              label={t('tasks.runNow')}
              showTooltip={enabled}
              size="sm"
              tone="secondary"
              disabled={isRunning || !enabled}
              onClick={() => setConfirmAction(confirmAction === 'run' ? null : 'run')}
            />
            {confirmAction === 'run' && (
              <ConfirmPopover
                message={t('tasks.confirmRun')}
                confirmLabel={t('tasks.runNow')}
                onConfirm={handleRunNow}
                onCancel={() => setConfirmAction(null)}
                cancelLabel={t('common.cancel')}
              />
            )}
          </div>

          {/* View Logs — `pressed` carries both the resting fill and the
              `aria-pressed` state the hand-rolled className could not. The
              tone is the same quiet `secondary` as its neighbours in both
              states; no className color override, since two `text-[…]` values
              would be resolved by stylesheet order. */}
          <IconButton
            icon={<ScrollText size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={t('tasks.viewLogs')}
            size="sm"
            tone="secondary"
            pressed={showLogs}
            onClick={onToggleLogs}
          />

          {/* More menu */}
          <div className="relative" ref={menuRef}>
            <IconButton
              icon={<Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />}
              label={t('tasks.moreActions')}
              size="sm"
              tone="secondary"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              onClick={() => { setShowMenu(!showMenu); setConfirmAction(null) }}
            />

            {showMenu && !confirmAction && (
              <div className="glass-panel absolute right-0 top-full z-[var(--z-dropdown)] mt-1.5 w-44 rounded-[var(--radius-lg)] p-1">
                {/* Edit */}
                <button
                  onClick={() => { setShowMenu(false); setShowEdit(true) }}
                  className={`${menuItem} text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
                >
                  <Pencil size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
                  {t('tasks.edit')}
                </button>

                {/* Toggle */}
                <button
                  onClick={() => setConfirmAction('toggle')}
                  className={`${menuItem} text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
                >
                  {enabled
                    ? <CirclePause size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
                    : <CirclePlay size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />}
                  {enabled ? t('common.disable') : t('common.enable')}
                </button>

                <div className="mx-1 my-1 h-px bg-[var(--color-border)]" />

                {/* Delete — the hover fill was `--color-error-container` at `/18`
                    alpha, which Safari 15 WebView drops; `-soft` is the opaque
                    token for exactly this. */}
                <button
                  onClick={() => setConfirmAction('delete')}
                  className={`${menuItem} text-[var(--color-error)] hover:bg-[var(--color-error-soft)]`}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('common.delete')}
                </button>
              </div>
            )}

            {/* Confirm popovers for menu actions */}
            {confirmAction === 'toggle' && (
              <div ref={confirmRef}>
                <ConfirmPopover
                  message={enabled ? t('tasks.confirmDisable') : t('tasks.confirmEnable')}
                  confirmLabel={enabled ? t('common.disable') : t('common.enable')}
                  onConfirm={handleToggle}
                  onCancel={() => { setConfirmAction(null); setShowMenu(false) }}
                  cancelLabel={t('common.cancel')}
                />
              </div>
            )}
            {confirmAction === 'delete' && (
              <div ref={confirmRef}>
                <ConfirmPopover
                  message={t('tasks.confirmDelete')}
                  confirmLabel={t('common.delete')}
                  onConfirm={handleDelete}
                  onCancel={() => { setConfirmAction(null); setShowMenu(false) }}
                  cancelLabel={t('common.cancel')}
                  confirmVariant="danger"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Run / toggle / delete failure — all three used to end in a silent
          catch or an unhandled rejection, so the row stayed in its old state
          with nothing on screen. */}
      {actionError && (
        <ErrorState
          size="sm"
          className="mx-5 mb-3 mt-1"
          title={t('common.error')}
          detail={actionError}
        />
      )}

      {/* Runs panel — full-bleed inside the list card, so it reads as a drawer
          under the row rather than a second card floating inside it. */}
      {showLogs && (
        <TaskRunsPanel taskId={task.id} onClose={onToggleLogs} refreshKey={logsRefreshKey} />
      )}

      {/* Edit modal */}
      {showEdit && (
        <NewTaskModal open editTask={task} onClose={() => setShowEdit(false)} />
      )}
    </div>
  )
}
