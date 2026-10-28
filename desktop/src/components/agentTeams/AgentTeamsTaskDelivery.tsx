import { useEffect, useId, useRef, useState } from 'react'
import { Check, Undo2 } from 'lucide-react'

import { teamsApi, type TaskDeliveryReviewAction } from '@/api/teams'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import type { TeamWorkbenchSnapshot, TeamWorkbenchTask } from '@/types/team'

type Submission = NonNullable<TeamWorkbenchTask['delivery']>['submissions'][number]

type PendingReview = {
  action: TaskDeliveryReviewAction['action']
  requestId: string
  reason?: string
}

/**
 * A retried HTTP request must reuse its id so the server dedupes the commit.
 * The id is regenerated only when the action or the return reason changes,
 * because the server fingerprints both.
 */
function createReviewRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random
    ? `delivery-review-${random}`
    : `delivery-review-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function reviewTone(submission: Submission): Tone {
  if (!submission.review) return 'warning'
  return submission.review.decision === 'accept' ? 'success' : 'danger'
}

function reviewLabel(submission: Submission, t: ReturnType<typeof useTranslation>): string {
  if (!submission.review) return t('agentTeams.delivery.pendingReview')
  return submission.review.decision === 'accept'
    ? t('agentTeams.delivery.accepted')
    : t('agentTeams.delivery.returned')
}

function submissionTime(value: number): string {
  return new Date(value).toLocaleString()
}

/**
 * Artifact acceptance for one team task. The user is the independent reviewer:
 * the panel only shows actions for the latest version that has no review, and
 * it never sends anything except the accept/return the user pressed. Returning
 * always carries a reason; accepting is a protocol receipt, not a model turn.
 * A history the server could not read is stated as read-only and reviewed by
 * nobody: its stored record is not shown, because it is not this protocol's.
 */
export function AgentTeamsTaskDelivery({
  task,
  snapshot,
  onReviewed,
}: {
  task: TeamWorkbenchTask
  snapshot: TeamWorkbenchSnapshot
  onReviewed: () => void | Promise<void>
}) {
  const t = useTranslation()
  const delivery = task.delivery
  /**
   * A history the server could not interpret is not an empty one. The reason is
   * the only fact available, so the panel states it and offers no review at all
   * rather than presenting the placeholder empty history as reviewable.
   */
  const unsupported = task.deliveryError !== undefined
  const submissions = unsupported ? [] : delivery?.submissions ?? []
  const latest = submissions.at(-1)
  const reviewable = !unsupported && latest !== undefined && latest.review === undefined
  const archived = Boolean(snapshot.deletedAt)
  const leadSessionId = snapshot.team.leadSessionId
  const incarnationId = snapshot.team.incarnationId
  const identity = leadSessionId && incarnationId
    ? { leadSessionId, incarnationId }
    : undefined
  const blocked = unsupported || archived || identity === undefined || !reviewable

  const [mode, setMode] = useState<TaskDeliveryReviewAction['action'] | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inflight, setInflight] = useState(false)
  const pendingRef = useRef<PendingReview | null>(null)
  const reasonId = useId()

  const signature = `${task.id}\u0000${delivery?.revision ?? 0}\u0000${latest?.version ?? 0}`

  useEffect(() => {
    // A fresh revision or version invalidates both a failed retry and an open
    // return form; replaying the old request would only be rejected.
    pendingRef.current = null
    setMode(null)
    setReason('')
    setReasonError(null)
    setError(null)
  }, [signature])

  const closeForm = () => {
    pendingRef.current = null
    setMode(null)
    setReason('')
    setReasonError(null)
    setError(null)
  }

  const runReview = async (action: TaskDeliveryReviewAction['action'], rawReason?: string) => {
    if (!identity || !latest || inflight || latest.review) return
    const normalizedReason = action === 'return' ? (rawReason ?? '').trim() : undefined
    if (action === 'return' && !normalizedReason) {
      setReasonError(t('agentTeams.delivery.reasonRequired'))
      return
    }

    const previous = pendingRef.current
    if (
      !previous ||
      previous.action !== action ||
      previous.reason !== normalizedReason
    ) {
      pendingRef.current = {
        action,
        requestId: createReviewRequestId(),
        ...(normalizedReason ? { reason: normalizedReason } : {}),
      }
    }
    const pending = pendingRef.current!

    setInflight(true)
    setReasonError(null)
    setError(null)
    const expectedRevision = delivery?.revision ?? 0
    const actionInput: TaskDeliveryReviewAction = action === 'accept'
      ? {
          action: 'accept',
          requestId: pending.requestId,
          expectedRevision,
          version: latest.version,
        }
      : {
          action: 'return',
          requestId: pending.requestId,
          expectedRevision,
          version: latest.version,
          reason: normalizedReason!,
        }
    try {
      await teamsApi.reviewTaskDelivery(
        snapshot.team.name,
        task.id,
        identity,
        actionInput,
      )
      pendingRef.current = null
      setMode(null)
      setReason('')
      await onReviewed()
    } catch (err) {
      // The pending action stays so Retry can reuse its requestId.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInflight(false)
    }
  }

  const changeReason = (value: string) => {
    setReason(value)
    setReasonError(null)
    // An edited reason is a different action; a stale id would fingerprint as
    // a conflicting duplicate server-side.
    if (pendingRef.current?.action === 'return' && pendingRef.current.reason !== value.trim()) {
      pendingRef.current = null
    }
  }

  const retry = () => {
    const pending = pendingRef.current
    if (!pending) return
    void runReview(pending.action, pending.reason)
  }

  return (
    <section
      data-testid="agent-teams-task-delivery"
      aria-label={t('agentTeams.delivery.title')}
      className="mt-3 border-t border-[var(--color-border)] pt-3"
    >
      <h4 className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
        {t('agentTeams.delivery.title')}
      </h4>

      {unsupported ? (
        <p
          data-testid="agent-teams-delivery-unsupported"
          className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]"
        >
          {t('agentTeams.delivery.unsupported')}
        </p>
      ) : submissions.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          {t('agentTeams.delivery.empty')}
        </p>
      ) : (
        <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
          {submissions.map((submission) => (
            <li
              key={submission.version}
              data-testid={`agent-teams-delivery-version-${submission.version}`}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] font-normal tabular-nums">
                  {t('agentTeams.delivery.version', { version: submission.version })}
                </span>
                <Badge size="xs" tone={reviewTone(submission)}>
                  {reviewLabel(submission, t)}
                </Badge>
              </div>
              <dl className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-relaxed">
                <dt className="text-[var(--color-text-tertiary)]">{t('agentTeams.delivery.artifact')}</dt>
                <dd className="whitespace-pre-wrap break-words text-[var(--color-text-primary)]">
                  {submission.artifact}
                </dd>
                <dt className="text-[var(--color-text-tertiary)]">{t('agentTeams.delivery.criteria')}</dt>
                <dd className="whitespace-pre-wrap break-words text-[var(--color-text-primary)]">
                  {submission.criteria}
                </dd>
                <dt className="text-[var(--color-text-tertiary)]">{t('agentTeams.delivery.owner')}</dt>
                <dd className="break-words text-[var(--color-text-secondary)]">{submission.owner}</dd>
                <dt className="text-[var(--color-text-tertiary)]">{t('agentTeams.delivery.submittedAt')}</dt>
                <dd className="text-[var(--color-text-secondary)]">{submissionTime(submission.submittedAt)}</dd>
                {submission.review ? (
                  <>
                    <dt className="text-[var(--color-text-tertiary)]">
                      {t('agentTeams.delivery.reviewer')}
                    </dt>
                    <dd className="break-words text-[var(--color-text-secondary)]">
                      {submission.review.reviewer}
                    </dd>
                    {submission.review.decision === 'return' && submission.review.reason ? (
                      <>
                        <dt className="text-[var(--color-text-tertiary)]">
                          {t('agentTeams.delivery.returnReason')}
                        </dt>
                        <dd className="whitespace-pre-wrap break-words text-[var(--color-text-primary)]">
                          {submission.review.reason}
                        </dd>
                      </>
                    ) : null}
                  </>
                ) : null}
              </dl>
            </li>
          ))}
        </ol>
      )}

      {unsupported ? null : archived ? (
        <p
          data-testid="agent-teams-delivery-disabled"
          data-disabled-reason="archived"
          className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]"
        >
          {t('agentTeams.delivery.archived')}
        </p>
      ) : identity === undefined ? (
        <p
          data-testid="agent-teams-delivery-disabled"
          data-disabled-reason="missing-identity"
          className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]"
        >
          {t('agentTeams.delivery.missingIdentity')}
        </p>
      ) : null}

      {reviewable && !blocked ? (
        mode === 'return' ? (
          <div className="mt-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2.5">
            <TextArea
              id={reasonId}
              label={t('agentTeams.delivery.reasonLabel')}
              placeholder={t('agentTeams.delivery.reasonPlaceholder')}
              value={reason}
              rows={3}
              required
              disabled={inflight}
              error={reasonError ?? undefined}
              onChange={(event) => changeReason(event.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={inflight}
                icon={<Undo2 size={12} aria-hidden="true" />}
                onClick={() => void runReview('return', reason)}
              >
                {t('agentTeams.delivery.submitReturn')}
              </Button>
              <Button variant="ghost" size="sm" disabled={inflight} onClick={closeForm}>
                {t('agentTeams.delivery.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={inflight}
              icon={<Check size={12} aria-hidden="true" />}
              onClick={() => void runReview('accept')}
            >
              {t('agentTeams.delivery.accept')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={inflight}
              icon={<Undo2 size={12} aria-hidden="true" />}
              onClick={() => {
                pendingRef.current = null
                setError(null)
                setReasonError(null)
                setReason('')
                setMode('return')
              }}
            >
              {t('agentTeams.delivery.return')}
            </Button>
          </div>
        )
      ) : null}

      {error ? (
        <ErrorState
          className="mt-2"
          size="sm"
          title={t('agentTeams.delivery.failed')}
          detail={error}
          {...(pendingRef.current
            ? { onRetry: retry, retryLabel: t('agentTeams.delivery.retry') }
            : {})}
        />
      ) : null}
    </section>
  )
}