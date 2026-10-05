import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adaptersApi,
  type TelegramPublicDelivery,
  type TelegramPublicStatus,
} from '@/api/adapters'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyButton } from '@/components/ui/CopyButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { useAdapterStore } from '@/stores/adapterStore'

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback
}

function isIssueDelivery(delivery: TelegramPublicDelivery): boolean {
  const status = delivery.status.trim().toLowerCase()
  return status === 'failed' || status === 'indeterminate'
}

const PAIRING_POLL_MS = 3_000

export function TelegramPublicSettings() {
  const t = useTranslation()
  const config = useAdapterStore((state) => state.config)
  const updateConfig = useAdapterStore((state) => state.updateConfig)
  const fetchConfig = useAdapterStore((state) => state.fetchConfig)
  const publicConfig = config.telegram?.public
  const enabledSaved = publicConfig?.enabled === true
  const ownerUserId = publicConfig?.ownerUserId
  const hasOwner = typeof ownerUserId === 'number'
  const generation = publicConfig?.generation
  const pairingExpiry = publicConfig?.pairing?.expiresAt
  const pairingActive = typeof pairingExpiry === 'number' && Date.now() < pairingExpiry
  const pairingMinutesLeft = pairingActive
    ? Math.max(0, Math.ceil((pairingExpiry - Date.now()) / 60_000))
    : 0

  const [enabled, setEnabled] = useState(enabledSaved)
  const [botToken, setBotToken] = useState(publicConfig?.botToken ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const [actionError, setActionError] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [pendingReset, setPendingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [status, setStatus] = useState<TelegramPublicStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [isStatusLoading, setIsStatusLoading] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [isSubscribing, setIsSubscribing] = useState(false)
  const [unsubscribingId, setUnsubscribingId] = useState<string | null>(null)
  const statusRequest = useRef(0)

  useEffect(() => {
    setEnabled(publicConfig?.enabled === true)
    setBotToken(publicConfig?.botToken ?? '')
  }, [publicConfig?.enabled, publicConfig?.botToken])

  const refreshStatus = useCallback(async () => {
    if (publicConfig?.enabled !== true) {
      statusRequest.current += 1
      setStatus(null)
      setStatusError('')
      setIsStatusLoading(false)
      return
    }
    const requestId = ++statusRequest.current
    setIsStatusLoading(true)
    setStatusError('')
    try {
      const next = await adaptersApi.getTelegramPublicStatus()
      if (requestId !== statusRequest.current) return
      setStatus(next)
    } catch (err) {
      if (requestId !== statusRequest.current) return
      setStatus(null)
      setStatusError(errorMessage(err, t('settings.adapters.telegramPublic.runtimeUnavailable')))
    } finally {
      if (requestId === statusRequest.current) setIsStatusLoading(false)
    }
  }, [publicConfig?.enabled, t])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus, hasOwner, generation])

  useEffect(() => {
    if (hasOwner) return
    const pairingPending = pairingActive || Boolean(pairingCode)
    if (!pairingPending) return
    const timer = window.setInterval(() => {
      void fetchConfig()
    }, PAIRING_POLL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [hasOwner, pairingActive, pairingCode, fetchConfig])

  async function handleSave() {
    setIsSaving(true)
    setSaveStatus('idle')
    setActionError('')
    try {
      await updateConfig({
        telegram: {
          public: {
            enabled,
            botToken,
          },
        },
      })
      setSaveStatus('saved')
      window.setTimeout(() => setSaveStatus('idle'), 2000)
      await refreshStatus()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleGeneratePairing() {
    setIsGenerating(true)
    setActionError('')
    try {
      const pairing = await adaptersApi.generateTelegramPublicPairing()
      setPairingCode(pairing.code)
      await fetchConfig()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleResetOwner() {
    setIsResetting(true)
    setActionError('')
    try {
      await adaptersApi.resetTelegramPublicPairing()
      setPairingCode(null)
      setPendingReset(false)
      await fetchConfig()
      await refreshStatus()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setIsResetting(false)
    }
  }

  async function handleAddSubscription() {
    const nextSessionId = sessionId.trim()
    if (!hasOwner || !nextSessionId) return
    setIsSubscribing(true)
    setActionError('')
    try {
      await adaptersApi.addTelegramPublicSubscription(nextSessionId)
      setSessionId('')
      await refreshStatus()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setIsSubscribing(false)
    }
  }

  async function handleRemoveSubscription(id: string) {
    setUnsubscribingId(id)
    setActionError('')
    try {
      await adaptersApi.removeTelegramPublicSubscription(id)
      await refreshStatus()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setUnsubscribingId(null)
    }
  }

  const running =
    hasOwner &&
    enabledSaved &&
    typeof generation === 'number' &&
    status?.running === true &&
    status.generation === generation
  const issueDeliveries = status?.deliveries.filter(isIssueDelivery) ?? []
  const subscriptions = hasOwner ? status?.subscriptions ?? [] : []

  return (
    <section aria-labelledby="telegram-public-title" className="space-y-4 border-t border-[var(--color-border)] pt-4">
      <div>
        <h3 id="telegram-public-title" className="text-sm font-semibold text-[var(--color-text-primary)]">
          {t('settings.adapters.telegramPublic.title')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
          {t('settings.adapters.telegramPublic.intro')}
        </p>
      </div>

      <Switch
        label={t('settings.adapters.telegramPublic.enable')}
        description={t('settings.adapters.telegramPublic.enableDesc')}
        checked={enabled}
        onChange={setEnabled}
      />

      <Input
        label={t('settings.adapters.telegramPublic.botToken')}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={botToken}
        onChange={(event) => setBotToken(event.target.value)}
        placeholder={t('settings.adapters.telegramPublic.botTokenPlaceholder')}
      />

      <p className="text-xs text-[var(--color-text-tertiary)]">
        {t('settings.adapters.telegramPublic.restartHint')}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void handleSave()} loading={isSaving}>
          {saveStatus === 'saved'
            ? t('settings.adapters.telegramPublic.saved')
            : t('settings.adapters.telegramPublic.save')}
        </Button>
        {saveStatus === 'saved' && (
          <span className="text-sm text-[var(--color-success)]">
            {t('settings.adapters.telegramPublic.saved')}
          </span>
        )}
      </div>

      <div className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot tone={running ? 'success' : hasOwner ? 'warning' : 'neutral'} />
          <span role="status" className="text-sm text-[var(--color-text-primary)]">
            {running
              ? t('settings.adapters.telegramPublic.running')
              : hasOwner
                ? t('settings.adapters.telegramPublic.notRunning')
                : t('settings.adapters.telegramPublic.noOwner')}
          </span>
        </div>
        {hasOwner && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('settings.adapters.telegramPublic.owner')}: {ownerUserId}
          </p>
        )}
        {typeof generation === 'number' && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.adapters.telegramPublic.generation', { generation })}
          </p>
        )}
        {hasOwner && status?.botId != null && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.adapters.telegramPublic.botId', { botId: status.botId })}
          </p>
        )}
        {enabledSaved && statusError && (
          <ErrorState
            size="sm"
            title={t('settings.adapters.telegramPublic.runtimeUnavailable')}
            detail={statusError}
            onRetry={() => void refreshStatus()}
            retryLabel={t('common.retry')}
          />
        )}
        {enabledSaved && isStatusLoading && !status && !statusError && (
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void handleGeneratePairing()}
            loading={isGenerating}
            disabled={hasOwner}
          >
            {pairingCode || pairingActive
              ? t('settings.adapters.telegramPublic.regeneratePairing')
              : t('settings.adapters.telegramPublic.generatePairing')}
          </Button>
          <Button
            variant="danger-outline"
            onClick={() => setPendingReset(true)}
            disabled={isResetting}
          >
            {t('settings.adapters.telegramPublic.resetOwner')}
          </Button>
        </div>
        {pairingCode && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xl font-bold tracking-[0.3em] text-[var(--color-brand)]">
              {pairingCode}
            </span>
            <CopyButton
              text={pairingCode}
              label={t('settings.adapters.telegramPublic.copyCode')}
              copiedLabel={t('common.copied')}
            />
            <span className="text-xs text-[var(--color-text-tertiary)]">
              {t('settings.adapters.telegramPublic.pairingActive', { minutes: 60 })}
            </span>
          </div>
        )}
        {!pairingCode && pairingActive && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.adapters.telegramPublic.pairingActive', { minutes: pairingMinutesLeft })}
          </p>
        )}
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.adapters.telegramPublic.pairingHint')}
        </p>
      </div>

      <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
        {t('settings.adapters.telegramPublic.targetingHint')}
      </p>
      <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
        {t('settings.adapters.telegramPublic.mediaHint')}
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-[var(--color-text-primary)]">
          {t('settings.adapters.telegramPublic.subscriptions')}
        </h4>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.adapters.telegramPublic.subscriptionHint')}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label={t('settings.adapters.telegramPublic.sessionIdPlaceholder')}
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder={t('settings.adapters.telegramPublic.sessionIdPlaceholder')}
            containerClassName="min-w-[16rem] flex-1"
          />
          <Button
            onClick={() => void handleAddSubscription()}
            loading={isSubscribing}
            disabled={!hasOwner || !sessionId.trim()}
          >
            {t('settings.adapters.telegramPublic.addSubscription')}
          </Button>
        </div>
        {hasOwner && subscriptions.length === 0 ? (
          <EmptyState
            variant="inline"
            size="sm"
            description={t('settings.adapters.telegramPublic.noSubscriptions')}
          />
        ) : null}
        {hasOwner && subscriptions.length > 0 ? (
          <ul className="space-y-2">
            {subscriptions.map((subscription) => (
              <li
                key={subscription.sessionId}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--color-text-primary)]">
                    {subscription.title || subscription.sessionId}
                  </div>
                  <div className="truncate text-xs text-[var(--color-text-tertiary)]">
                    {subscription.shortId} · {subscription.project} · {subscription.sessionId}
                  </div>
                </div>
                <Button
                  variant="danger-outline"
                  size="sm"
                  loading={unsubscribingId === subscription.sessionId}
                  onClick={() => void handleRemoveSubscription(subscription.sessionId)}
                >
                  {t('settings.adapters.telegramPublic.unsubscribe')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {hasOwner && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.adapters.telegramPublic.deliveries')}
            </h4>
            {issueDeliveries.length === 0 ? (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('settings.adapters.telegramPublic.noIssueDeliveries')}
              </p>
            ) : (
              <ul className="space-y-1">
                {issueDeliveries.map((delivery) => {
                  const failed = delivery.status.trim().toLowerCase() === 'failed'
                  return (
                    <li key={delivery.id} className="flex items-start gap-2 text-xs">
                      <Badge tone={failed ? 'danger' : 'warning'} size="xs">
                        {failed
                          ? t('settings.adapters.telegramPublic.deliveryFailed')
                          : t('settings.adapters.telegramPublic.deliveryIndeterminate')}
                      </Badge>
                      <span className="text-[var(--color-text-secondary)]">
                        {delivery.error || delivery.id}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {actionError && (
        <ErrorState size="sm" title={actionError} />
      )}

      <ConfirmDialog
        open={pendingReset}
        onClose={() => {
          if (!isResetting) setPendingReset(false)
        }}
        onConfirm={() => void handleResetOwner()}
        title={t('settings.adapters.telegramPublic.resetOwnerConfirm')}
        body={t('settings.adapters.telegramPublic.resetOwnerConfirmBody')}
        confirmLabel={t('settings.adapters.telegramPublic.resetOwner')}
        cancelLabel={t('common.cancel')}
        loading={isResetting}
      />
    </section>
  )
}