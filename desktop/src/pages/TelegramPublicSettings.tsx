import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import {
  adaptersApi,
  type TelegramPublicDelivery,
  type TelegramPublicStatus,
} from '@/api/adapters'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyButton } from '@/components/ui/CopyButton'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { useAdapterStore } from '@/stores/adapterStore'
import { TelegramPublicSubscriptions } from '@/pages/TelegramPublicSubscriptions'

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

  const configurationId = useId()
  const [configurationOpen, setConfigurationOpen] = useState(!enabledSaved || !hasOwner)
  const [enabled, setEnabled] = useState(enabledSaved)
  const [botToken, setBotToken] = useState(publicConfig?.botToken ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const [actionError, setActionError] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [pendingReset, setPendingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [statusSnapshot, setStatusSnapshot] = useState<{
    ownerUserId: number | undefined
    generation: number | undefined
    value: TelegramPublicStatus
  } | null>(null)
  // 操作者或配置代次变化后，不把旧订阅和投递状态带入新的身份。
  const status = enabledSaved && statusSnapshot?.ownerUserId === ownerUserId && statusSnapshot?.generation === generation
    ? statusSnapshot?.value ?? null
    : null
  const [statusError, setStatusError] = useState('')
  const [isStatusLoading, setIsStatusLoading] = useState(false)
  const statusRequest = useRef(0)

  useEffect(() => {
    setEnabled(publicConfig?.enabled === true)
    setBotToken(publicConfig?.botToken ?? '')
  }, [publicConfig?.enabled, publicConfig?.botToken])

  const refreshStatus = useCallback(async () => {
    // 保存或重置后的回调可能来自旧渲染，始终以已保存配置发起刷新。
    const savedPublicConfig = useAdapterStore.getState().config.telegram?.public
    if (savedPublicConfig?.enabled !== true) {
      statusRequest.current += 1
      setStatusSnapshot(null)
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
      setStatusSnapshot({ ownerUserId: savedPublicConfig.ownerUserId, generation: savedPublicConfig.generation, value: next })
    } catch (err) {
      if (requestId !== statusRequest.current) return
      setStatusSnapshot(null)
      setStatusError(errorMessage(err, t('settings.adapters.telegramPublic.runtimeUnavailable')))
    } finally {
      if (requestId === statusRequest.current) setIsStatusLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus, enabledSaved, ownerUserId, generation])

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
      setConfigurationOpen(true)
      await fetchConfig()
      await refreshStatus()
    } catch (err) {
      setActionError(errorMessage(err, t('settings.adapters.telegramPublic.saveError')))
    } finally {
      setIsResetting(false)
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
    <section aria-labelledby="telegram-public-title" className="space-y-5">
      <div>
        <h3 id="telegram-public-title" className="text-base font-semibold text-[var(--color-text-primary)]">
          {t('settings.adapters.publicSubscriptionsTab')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
          {t('settings.adapters.telegramPublic.intro')}
        </p>
      </div>

      <div className="space-y-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.adapters.telegramPublic.title')}
          </h4>
          <Button variant="ghost" size="sm" disabled={!enabledSaved} loading={isStatusLoading} onClick={() => void refreshStatus()} icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}>
            {t('settings.adapters.telegramPublic.refreshStatus')}
          </Button>
        </div>
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

      <div className="rounded-[var(--radius-xl)] border border-[var(--color-border)] overflow-hidden">
        <Button
          variant="ghost"
          block
          className="justify-between"
          aria-expanded={configurationOpen}
          aria-controls={configurationId}
          icon={<ChevronDown className={`h-4 w-4 transition-transform ${configurationOpen ? 'rotate-180' : ''}`} aria-hidden="true" />}
          iconPosition="end"
          onClick={() => setConfigurationOpen(!configurationOpen)}
        >
          {t('settings.adapters.telegramPublic.configuration')}
        </Button>
        <div id={configurationId} hidden={!configurationOpen} className="space-y-4 border-t border-[var(--color-border)] p-4">
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
          <Button onClick={() => void handleSave()} loading={isSaving}>
            {saveStatus === 'saved' ? t('settings.adapters.telegramPublic.saved') : t('settings.adapters.telegramPublic.save')}
          </Button>

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
        </div>
      </div>

      {actionError && <ErrorState size="sm" title={actionError} />}

      <div className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] p-4">
        <TelegramPublicSubscriptions
          key={`${ownerUserId ?? 'unpaired'}:${generation ?? 0}`}
          subscriptions={subscriptions}
          canManage={hasOwner && enabledSaved}
          loading={hasOwner && isStatusLoading}
          statusError={hasOwner ? statusError : ''}
          onError={setActionError}
          onChanged={refreshStatus}
        />
      </div>

      <div className="space-y-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
        <p>{t('settings.adapters.telegramPublic.accessHint')}</p>
        <p>{t('settings.adapters.telegramPublic.targetingHint')}</p>
        <p>{t('settings.adapters.telegramPublic.mediaHint')}</p>
      </div>

      {hasOwner && (
        <div className="space-y-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] p-4">
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
                    <span className="break-all text-[var(--color-text-secondary)]">
                      {delivery.error || delivery.id}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
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