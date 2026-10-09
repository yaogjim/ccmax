import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import type { UpdateProxyMode } from '../../types/settings'
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer'
import { useUpdateStore } from '../../stores/updateStore'
import { formatBytes } from '../../lib/formatBytes'
import { getDesktopHost } from '../../lib/desktopHost'
import { BrandSeal } from '../../components/composite/BrandSeal'
import { isValidHttpProxyUrl } from '../settings/shared'

/**
 * The About panel: product identity and the app-update card.
 *
 * The GitHub repo, releases, issues, author and social entries were removed
 * from this panel; `isValidHttpProxyUrl` stayed in `./shared`, since the
 * General panel needs it too. See `docs/agents/upstream-removals.md`.
 */

export function AboutSettings() {
  const t = useTranslation()
  const [version, setVersion] = useState('')
  const updateProxy = useSettingsStore((s) => s.updateProxy)
  const setUpdateProxy = useSettingsStore((s) => s.setUpdateProxy)
  const updateStatus = useUpdateStore((s) => s.status)
  const availableVersion = useUpdateStore((s) => s.availableVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const progressPercent = useUpdateStore((s) => s.progressPercent)
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes)
  const totalBytes = useUpdateStore((s) => s.totalBytes)
  const error = useUpdateStore((s) => s.error)
  const checkedAt = useUpdateStore((s) => s.checkedAt)
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates)
  const installUpdate = useUpdateStore((s) => s.installUpdate)
  const initialize = useUpdateStore((s) => s.initialize)
  const [showUpdateProxyAdvanced, setShowUpdateProxyAdvanced] = useState(false)
  const [updateProxyDraft, setUpdateProxyDraft] = useState(updateProxy)
  const [updateProxySaveError, setUpdateProxySaveError] = useState<string | null>(null)
  const [isSavingUpdateProxy, setIsSavingUpdateProxy] = useState(false)

  useEffect(() => {
    let cancelled = false

    getDesktopHost().app.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value)
      })
      .catch(() => {
        if (!cancelled) setVersion('')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    setUpdateProxyDraft(updateProxy)
    setUpdateProxySaveError(null)
  }, [updateProxy])

  const checkedAtText =
    checkedAt
      ? new Date(checkedAt).toLocaleString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })
      : null
  const updateProxyModes: Array<{ value: UpdateProxyMode; label: string; description: string }> = [
    {
      value: 'system',
      label: t('update.proxyModeSystem'),
      description: t('update.proxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('update.proxyModeManual'),
      description: t('update.proxyModeManualDescription'),
    },
  ]
  const manualProxyUrl = updateProxyDraft.url.trim()
  const manualProxyError =
    updateProxyDraft.mode === 'manual' && !manualProxyUrl
      ? t('update.proxyUrlRequired')
      : updateProxyDraft.mode === 'manual' && !isValidHttpProxyUrl(manualProxyUrl)
        ? t('update.proxyUrlInvalid')
        : null
  const updateProxyDirty =
    updateProxyDraft.mode !== updateProxy.mode ||
    updateProxyDraft.url.trim() !== updateProxy.url.trim()

  const saveUpdateProxy = async () => {
    if (manualProxyError) {
      setUpdateProxySaveError(manualProxyError)
      return
    }

    setIsSavingUpdateProxy(true)
    setUpdateProxySaveError(null)
    try {
      await setUpdateProxy({
        mode: updateProxyDraft.mode,
        url: manualProxyUrl,
      })
    } catch (error) {
      setUpdateProxySaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingUpdateProxy(false)
    }
  }

  const hasKnownProgress = typeof totalBytes === 'number' && totalBytes > 0
  const downloadedText = formatBytes(downloadedBytes)
  const updateDescription = (() => {
    if (updateStatus === 'checking') return t('update.checking')
    if (error) return t('update.failed', { error })
    if (updateStatus === 'downloading') {
      return hasKnownProgress
        ? t('update.progress', { progress: String(progressPercent) })
        : t('update.progressBytes', { downloaded: downloadedText })
    }
    if (updateStatus === 'downloaded') return t('update.downloaded')
    if (updateStatus === 'installing') return t('update.installing')
    if (updateStatus === 'restarting') return t('update.restarting')
    if (updateStatus === 'available' && availableVersion) return t('update.newVersion', { version: availableVersion })
    if (updateStatus === 'up-to-date') return t('update.upToDate', { version: version || t('update.currentVersionUnknown') })
    return t('update.idle')
  })()

  const selectedUpdateProxyMode = updateProxyModes.find((mode) => mode.value === updateProxyDraft.mode)

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader title={t('settings.tab.about')} />

      <SettingsGroup className="mt-7">
        {/* Product identity */}
        <SettingsBlock className="flex items-center gap-4 py-4">
          <BrandSeal size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-[var(--color-text-primary)]">ccmax</div>
            {version && (
              <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
                {t('settings.about.version')} {version}
              </div>
            )}
          </div>
        </SettingsBlock>
      </SettingsGroup>

      <SettingsSection
        title={t('settings.about.updates')}
        description={t('settings.about.updatesDesc')}
        action={(
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void checkForUpdates()}
            loading={updateStatus === 'checking'}
          >
            {t('update.checkNow')}
          </Button>
        )}
      >
        <SettingsGroup>
          <SettingsRow
            title={(
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{t('settings.about.version')}</span>
                <span className="font-mono text-xs font-normal text-[var(--color-text-secondary)]">
                  {version || t('update.currentVersionUnknown')}
                </span>
                {availableVersion && (
                  <Badge tone="info" size="sm">
                    {t('update.availableLabel')} {availableVersion}
                  </Badge>
                )}
              </span>
            )}
            description={(
              <>
                <span className={`block ${error ? 'text-[var(--color-error)]' : ''}`}>{updateDescription}</span>
                {checkedAtText && (
                  <span className="mt-0.5 block">{t('update.checkedAt', { time: checkedAtText })}</span>
                )}
              </>
            )}
          >
            {availableVersion && (
              <Button
                size="base"
                onClick={() => void installUpdate()}
                loading={updateStatus === 'downloading' || updateStatus === 'installing' || updateStatus === 'restarting'}
                disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
              >
                {updateStatus === 'downloaded'
                  ? t('update.installAndRestart')
                  : updateStatus === 'installing'
                    ? t('update.installing')
                    : updateStatus === 'restarting'
                      ? t('update.restarting')
                      : t('update.now')}
              </Button>
            )}
          </SettingsRow>

          {(updateStatus === 'downloading' || updateStatus === 'restarting') && (
            <SettingsBlock>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-container-high)]">
                {hasKnownProgress || updateStatus === 'restarting' ? (
                  <div
                    className="h-full bg-[var(--color-info)] transition-all duration-300"
                    style={{ width: `${Math.min(progressPercent, 100)}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--color-info)]" />
                )}
              </div>
              {!hasKnownProgress && updateStatus === 'downloading' && downloadedBytes > 0 && (
                <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {downloadedText}
                </p>
              )}
            </SettingsBlock>
          )}

          {releaseNotes && availableVersion && (
            <SettingsBlock>
              <div className="text-xs font-semibold text-[var(--color-text-tertiary)]">
                {t('update.releaseNotes')}
              </div>
              <div className="mt-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2">
                <MarkdownRenderer
                  content={releaseNotes}
                  variant="document"
                  className="text-[13px] leading-6 text-[var(--color-text-secondary)] [&_h1]:text-[15px] [&_h2]:text-sm [&_h3]:text-[13px] [&_p]:text-[13px] [&_p]:leading-6"
                />
              </div>
            </SettingsBlock>
          )}

          <div>
            <button
              type="button"
              onClick={() => setShowUpdateProxyAdvanced((value) => !value)}
              className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              aria-expanded={showUpdateProxyAdvanced}
            >
              <span>{t('update.proxyAdvanced')}</span>
              {showUpdateProxyAdvanced
                ? <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
                : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />}
            </button>

            {showUpdateProxyAdvanced && (
              <div className="space-y-3 px-4 pb-4">
                <SegmentedControl<UpdateProxyMode>
                  label={t('update.proxyAdvanced')}
                  layout="fill"
                  size="sm"
                  value={updateProxyDraft.mode}
                  onChange={(mode) => {
                    setUpdateProxyDraft((current) => ({ ...current, mode }))
                    setUpdateProxySaveError(null)
                  }}
                  items={updateProxyModes.map(({ value, label }) => ({ value, label }))}
                />
                {selectedUpdateProxyMode && (
                  <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{selectedUpdateProxyMode.description}</p>
                )}

                {updateProxyDraft.mode === 'manual' && (
                  <div>
                    <Input
                      id="update-proxy-url"
                      label={t('update.proxyUrl')}
                      size="md"
                      className="font-mono text-xs"
                      value={updateProxyDraft.url}
                      placeholder="http://127.0.0.1:7890"
                      autoComplete="off"
                      aria-invalid={manualProxyError ? true : undefined}
                      onChange={(event) => {
                        setUpdateProxyDraft((current) => ({ ...current, url: event.target.value }))
                        setUpdateProxySaveError(null)
                      }}
                    />
                    <p className={`mt-1 text-xs leading-[1.5] ${manualProxyError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {manualProxyError ?? t('update.proxyUrlHint')}
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                    {t('update.proxyScopeHint')}
                  </p>
                  <Button
                    size="base"
                    variant="secondary"
                    className="shrink-0 whitespace-nowrap"
                    disabled={!updateProxyDirty || !!manualProxyError || isSavingUpdateProxy}
                    loading={isSavingUpdateProxy}
                    onClick={() => void saveUpdateProxy()}
                  >
                    {t('update.proxySave')}
                  </Button>
                </div>

                {updateProxySaveError && (
                  <p className="text-xs leading-[1.5] text-[var(--color-error)]">
                    {updateProxySaveError}
                  </p>
                )}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </div>
  )
}
