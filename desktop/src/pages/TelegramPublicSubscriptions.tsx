import { useEffect, useState } from 'react'
import { adaptersApi, type TelegramPublicSubscription } from '@/api/adapters'
import { sessionsApi } from '@/api/sessions'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { SearchField } from '@/components/ui/SearchField'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import type { SessionListItem } from '@/types/session'

const PAGE_SIZE = 10

function Pager({ page, pages, busy = false, onPrevious, onNext }: {
  page: number
  pages?: number
  busy?: boolean
  onPrevious?: () => void
  onNext?: () => void
}) {
  const t = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-[var(--color-text-secondary)]">
        {pages === undefined ? t('settings.adapters.telegramPublic.pageNumber', { page }) : t('settings.adapters.telegramPublic.pageOf', { page, pages })}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={busy || !onPrevious} onClick={onPrevious}>
          {t('settings.adapters.telegramPublic.previousPage')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || !onNext} onClick={onNext}>
          {t('settings.adapters.telegramPublic.nextPage')}
        </Button>
      </div>
    </div>
  )
}

export function TelegramPublicSubscriptions({ subscriptions, canManage, loading, statusError, onChanged, onError }: {
  subscriptions: TelegramPublicSubscription[]
  canManage: boolean
  loading: boolean
  statusError: string
  onChanged: () => Promise<void>
  onError: (message: string) => void
}) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [page, setPage] = useState(1)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [projectsError, setProjectsError] = useState('')
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [candidateProject, setCandidateProject] = useState('')
  const [candidatePage, setCandidatePage] = useState(1)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<SessionListItem[]>([])
  const [candidateTotal, setCandidateTotal] = useState(0)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidatesError, setCandidatesError] = useState('')
  const [reload, setReload] = useState(0)
  const subscribedIds = new Set(subscriptions.map((row) => row.sessionId))
  const subscriptionProjects = [...new Set(subscriptions.map((row) => row.project).filter(Boolean))].sort()
  const needle = query.trim().toLocaleLowerCase()
  const filtered = subscriptions.filter((row) => (!project || row.project === project)
    && (!needle || [row.title, row.project, row.sessionId, row.shortId].some((value) => value.toLocaleLowerCase().includes(needle))))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visiblePage = Math.min(page, pages)

  useEffect(() => {
    setPage((current) => Math.min(current, pages))
  }, [pages])

  useEffect(() => {
    if (!pickerOpen || !canManage) return
    const controller = new AbortController()
    setProjectsLoading(true)
    setProjectsError('')
    void sessionsApi.list({ view: 'sidebar', perProjectLimit: 1 }, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      setProjects((result.projects ?? []).map((row) => row.projectRoot).sort())
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setProjectsError(err instanceof Error ? err.message : t('settings.adapters.telegramPublic.sessionsLoadError'))
    }).finally(() => {
      if (!controller.signal.aborted) setProjectsLoading(false)
    })
    return () => controller.abort()
  }, [pickerOpen, canManage, reload, t])

  const cursor = cursors[candidatePage - 1]
  useEffect(() => {
    if (!pickerOpen || !canManage) return
    const controller = new AbortController()
    setCandidatesLoading(true)
    setCandidatesError('')
    setCandidates([])
    const request = candidateProject
      ? sessionsApi.listProjectHistory({ projectRoot: candidateProject, limit: PAGE_SIZE, cursor }, { signal: controller.signal })
      : sessionsApi.list({ limit: PAGE_SIZE, offset: (candidatePage - 1) * PAGE_SIZE }, { signal: controller.signal })
    void request.then((result) => {
      if (controller.signal.aborted) return
      if ('total' in result) {
        setCandidateTotal(result.total)
        const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
        if (candidatePage > lastPage) {
          setCandidatePage(lastPage)
          return
        }
      }
      setCandidates(result.sessions)
      setNextCursor('nextCursor' in result ? result.nextCursor : null)
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setCandidatesError(err instanceof Error ? err.message : t('settings.adapters.telegramPublic.sessionsLoadError'))
    }).finally(() => {
      if (!controller.signal.aborted) setCandidatesLoading(false)
    })
    return () => controller.abort()
  }, [pickerOpen, canManage, candidateProject, candidatePage, cursor, reload, t])

  async function changeSubscription(id: string, remove = false) {
    const trimmed = id.trim()
    if (!canManage || pendingId || !trimmed) return
    setPendingId(trimmed)
    onError('')
    try {
      if (remove) await adaptersApi.removeTelegramPublicSubscription(trimmed)
      else await adaptersApi.addTelegramPublicSubscription(trimmed)
      if (!remove && sessionId.trim() === trimmed) setSessionId('')
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('settings.adapters.telegramPublic.saveError'))
    } finally {
      setPendingId(null)
    }
  }

  function selectCandidateProject(value: string) {
    setCandidateProject(value)
    setCandidatePage(1)
    setCursors([undefined])
    setNextCursor(null)
  }

  function retryCandidates() {
    // 重建项目快照，避免游标失效后反复请求同一无效页。
    if (candidateProject) selectCandidateProject(candidateProject)
    setReload((current) => current + 1)
  }

  const candidatePages = Math.max(1, Math.ceil(candidateTotal / PAGE_SIZE))
  const hasNext = candidateProject ? Boolean(nextCursor) : candidatePage < candidatePages

  return (
    <section aria-label={t('settings.adapters.telegramPublic.subscriptions')} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.adapters.telegramPublic.subscriptions')}</h4>
        <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={!canManage} aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}>
          {t(pickerOpen ? 'settings.adapters.telegramPublic.closePicker' : 'settings.adapters.telegramPublic.chooseSessions')}
        </Button>
      </div>
      <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.telegramPublic.subscriptionHint')}</p>
      {!canManage && <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.adapters.telegramPublic.manageRequiresOwner')}</p>}

      {pickerOpen && canManage && (
        <section aria-label={t('settings.adapters.telegramPublic.chooseSessions')} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <SelectField label={t('settings.adapters.telegramPublic.projectFilter')} value={candidateProject} onChange={selectCandidateProject}
            options={[{ value: '', label: t('settings.adapters.telegramPublic.allProjects') }, ...projects.map((value) => ({ value, label: value }))]} disabled={projectsLoading} />
          {projectsError && <ErrorState size="sm" title={projectsError} onRetry={() => setReload(reload + 1)} retryLabel={t('common.retry')} />}
          {candidatesLoading ? <p className="text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</p>
            : candidatesError ? <ErrorState size="sm" title={candidatesError} onRetry={retryCandidates} retryLabel={t('common.retry')} />
              : candidates.length === 0 ? <EmptyState variant="inline" size="sm" description={t('settings.adapters.telegramPublic.noSessions')} />
                : <ul className="space-y-2">
                  {candidates.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--color-text-primary)]" title={row.title || row.id}>{row.title || row.id}</div>
                        <div className="break-all text-xs text-[var(--color-text-tertiary)]">{row.projectRoot || row.workDir || row.projectPath}</div>
                        <div className="break-all text-xs text-[var(--color-text-tertiary)]">{row.id}</div>
                      </div>
                      {subscribedIds.has(row.id) ? <Badge size="xs" tone="success">{t('settings.adapters.telegramPublic.alreadySubscribed')}</Badge>
                        : <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={pendingId !== null} loading={pendingId === row.id} onClick={() => void changeSubscription(row.id)}>{t('settings.adapters.telegramPublic.addSubscription')}</Button>}
                    </li>
                  ))}
                </ul>}
          <Pager page={candidatePage} pages={candidateProject ? undefined : candidatePages} busy={candidatesLoading || Boolean(candidatesError)}
            onPrevious={candidatePage > 1 ? () => setCandidatePage(candidatePage - 1) : undefined}
            onNext={hasNext ? () => {
              if (candidateProject && nextCursor) setCursors((current) => [...current.slice(0, candidatePage), nextCursor])
              setCandidatePage(candidatePage + 1)
            } : undefined} />
        </section>
      )}

      {subscriptions.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <SearchField label={t('settings.adapters.telegramPublic.searchSubscriptions')} clearLabel={t('common.clearSearch')} value={query}
            onChange={(value) => { setQuery(value); setPage(1) }} containerClassName="min-w-0 basis-48 flex-1" />
          <SelectField label={t('settings.adapters.telegramPublic.projectFilter')} value={project} onChange={(value) => { setProject(value); setPage(1) }}
            options={[{ value: '', label: t('settings.adapters.telegramPublic.allProjects') }, ...[...new Set([...subscriptionProjects, ...(project ? [project] : [])])].map((value) => ({ value, label: value || t('chat.sessionNoProject') }))]}
            containerClassName="min-w-0 basis-48 flex-1" size="md" />
        </div>
      )}
      {loading ? <p className="text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</p>
        : statusError ? null
          : subscriptions.length === 0 ? <EmptyState variant="inline" size="sm" description={t('settings.adapters.telegramPublic.noSubscriptions')} />
            : <>
              <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.adapters.telegramPublic.subscriptionCount', { count: filtered.length })}</p>
              {filtered.length === 0 ? <EmptyState variant="inline" size="sm" description={t('settings.adapters.telegramPublic.noMatchingSubscriptions')} />
                : <ul className="space-y-2">
                  {filtered.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE).map((row) => (
                    <li key={row.sessionId} className="flex items-center justify-between gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--color-text-primary)]" title={row.title || row.sessionId}>{row.title || row.sessionId}</div>
                        <div className="break-all text-xs text-[var(--color-text-tertiary)]">{row.shortId} · {row.project}</div>
                        <div className="break-all text-xs text-[var(--color-text-tertiary)]">{row.sessionId}</div>
                      </div>
                      <Button variant="danger-outline" size="sm" className="shrink-0 whitespace-nowrap" disabled={!canManage || pendingId !== null} loading={pendingId === row.sessionId}
                        onClick={() => void changeSubscription(row.sessionId, true)}>{t('settings.adapters.telegramPublic.unsubscribe')}</Button>
                    </li>
                  ))}
                </ul>}
              <Pager page={visiblePage} pages={pages} onPrevious={visiblePage > 1 ? () => setPage(visiblePage - 1) : undefined}
                onNext={visiblePage < pages ? () => setPage(visiblePage + 1) : undefined} />
            </>}

      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
        <Input label={t('settings.adapters.telegramPublic.sessionIdPlaceholder')} value={sessionId} onChange={(event) => setSessionId(event.target.value)}
          placeholder={t('settings.adapters.telegramPublic.sessionIdPlaceholder')} containerClassName="min-w-0 basis-64 flex-1" />
        <Button variant="secondary" onClick={() => void changeSubscription(sessionId)} loading={pendingId !== null && pendingId === sessionId.trim()}
          disabled={!canManage || pendingId !== null || !sessionId.trim() || subscribedIds.has(sessionId.trim())}>{t('settings.adapters.telegramPublic.addSubscription')}</Button>
      </div>
    </section>
  )
}