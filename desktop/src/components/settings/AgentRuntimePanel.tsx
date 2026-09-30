import { useMemo, useState } from 'react'
import { Cpu, ShieldAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { AgentDefinition, AgentRuntimeStatus } from '../../api/agents'
import { useAgentStore } from '../../stores/agentStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../../constants/openaiOfficialProvider'
import { resolveDefaultRuntimeSelection } from '../../lib/runtimeSelection'
import type { RuntimeSelection } from '../../types/runtime'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { ModelSelector } from '@/components/controls/ModelSelector'

const STATUS_TONE: Record<AgentRuntimeStatus, 'success' | 'warning'> = {
  valid: 'success',
  provider_missing: 'warning',
  model_unresolvable: 'warning',
}

/**
 * `provider · model` for a pinned agent. A provider that no longer exists has no
 * name, and its raw id means nothing to the user, so only the model is shown
 * (the status badge says why the pin is unusable).
 */
export function formatAgentRuntime(runtime: NonNullable<AgentDefinition['runtime']>): string {
  return runtime.providerName ? `${runtime.providerName} · ${runtime.modelId}` : runtime.modelId
}

/**
 * The "Runtime" block of an agent's detail page: where this agent is pinned to
 * run, whether that still works, and the entry points to change it.
 *
 * Any agent can be pinned (built-in, custom or plugin), so this is not gated on
 * `editable`. Only the user's own settings file is written; a binding supplied
 * by managed policy is shown but read-only.
 */
export function AgentRuntimeSection({
  agent,
  onEdit,
  onClear,
  clearing,
  error,
}: {
  agent: AgentDefinition
  onEdit: () => void
  onClear: () => void
  clearing: boolean
  error: string | null
}) {
  const t = useTranslation()
  const runtime = agent.runtime
  const status = agent.runtimeStatus
  const managedBy = runtime && runtime.source !== 'userSettings' ? runtime.source : null

  return (
    <section
      aria-label={t('settings.agents.runtime.title')}
      className="rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-[var(--color-text-tertiary)]" />
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.agents.runtime.title')}
          </h4>
        </div>
        {!managedBy && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onEdit} disabled={clearing}>
              {runtime ? t('settings.agents.runtime.change') : t('settings.agents.runtime.set')}
            </Button>
            {runtime && (
              <Button variant="ghost" size="sm" onClick={onClear} disabled={clearing}>
                {t('settings.agents.runtime.clear')}
              </Button>
            )}
          </div>
        )}
      </div>

      {runtime ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="agent-runtime-value"
              className="break-all font-mono text-[13px] font-semibold text-[var(--color-text-primary)]"
            >
              {formatAgentRuntime(runtime)}
            </span>
            {status && (
              <Badge tone={STATUS_TONE[status]} size="md" bordered>
                {t(`settings.agents.runtime.status.${status}`)}
              </Badge>
            )}
          </div>
          {status && status !== 'valid' && (
            <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-[var(--color-warning)]">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <span>{t('settings.agents.runtime.staleHint')}</span>
            </p>
          )}
          {managedBy && (
            <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
              {t('settings.agents.runtime.managed', { source: t(`settings.agents.source.${managedBy}`) })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t('settings.agents.runtime.unbound')}
        </p>
      )}

      <p className="mt-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
        {t('settings.agents.runtime.description')}
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-[var(--color-error)]">{error}</p>}
    </section>
  )
}

/**
 * Choose the provider and model an agent is pinned to.
 *
 * The provider/model picker is the one Team plans use, so the choices, the
 * hidden-provider handling and the OAuth catalogs stay identical. A typed model
 * id (for a model the provider does not list) overrides the picked model; the
 * provider is still the picked one. The server validates the pair on save and
 * again at launch, so nothing here decides whether it will work.
 */
export function AgentRuntimeModal({
  agent,
  cwd,
  sessionId,
  onClose,
}: {
  agent: AgentDefinition
  cwd?: string
  sessionId?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const setAgentRuntime = useAgentStore((state) => state.setAgentRuntime)
  const isMutating = useAgentStore((state) => state.isMutating)
  const providers = useProviderStore((state) => state.providers)
  const activeId = useProviderStore((state) => state.activeId)
  const activeProviderName = useSettingsStore((state) => state.activeProviderName)
  const currentModelId = useSettingsStore((state) => state.currentModel?.id)

  const existing = agent.runtime
  const [picked, setPicked] = useState<RuntimeSelection | undefined>(() =>
    existing
      ? {
          providerId: existing.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : existing.providerId,
          modelId: existing.modelId,
        }
      : undefined,
  )
  const [manualModel, setManualModel] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  // What the picker shows when nothing was picked is exactly what Save pins, so
  // the field never displays a choice that would not be the one saved.
  const fallbackSelection = useMemo(
    () => resolveDefaultRuntimeSelection(activeId, activeProviderName, providers, currentModelId),
    [activeId, activeProviderName, providers, currentModelId],
  )
  const selection = picked ?? fallbackSelection
  const providerId = selection.providerId ?? CLAUDE_OFFICIAL_PROVIDER_ID
  const modelId = manualModel.trim() || selection.modelId

  const handleSave = async () => {
    setSubmitError(null)
    try {
      await setAgentRuntime(agent, { ...(cwd ? { cwd } : {}), providerId, modelId }, sessionId)
      onClose()
    } catch {
      // Localized like the other agent mutations: the raw server message can
      // carry paths and provider internals.
      setSubmitError(t('settings.agents.runtime.saveError'))
    }
  }

  return (
    <Modal
      open
      onClose={isMutating ? () => {} : onClose}
      title={t('settings.agents.runtime.modalTitle')}
      width={520}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={isMutating}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleSave()} disabled={isMutating || !modelId}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <span className="break-all font-mono text-sm font-semibold text-[var(--color-text-primary)]">
          {agent.agentType}
        </span>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            {t('settings.agents.runtime.selectorLabel')}
          </span>
          <ModelSelector
            appearance="field"
            fluid
            ariaLabel={t('settings.agents.runtime.selectorLabel')}
            runtimeSelection={selection}
            onRuntimeSelectionChange={(next) => {
              setPicked(next)
              setManualModel('')
            }}
          />
        </div>

        <Input
          label={t('settings.agents.runtime.manualModel')}
          value={manualModel}
          placeholder={t('settings.agents.runtime.manualModelPlaceholder')}
          onChange={(event) => setManualModel(event.target.value)}
        />
        <p className="-mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.runtime.manualModelHint')}
        </p>

        <p
          role="note"
          className="flex items-start gap-1.5 rounded-[var(--radius-lg)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-text-primary)]"
        >
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <span>{t('settings.agents.runtime.privacy')}</span>
        </p>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.runtime.scopeHint')}
        </p>
        {submitError && <p role="alert" className="text-sm text-[var(--color-error)]">{submitError}</p>}
      </div>
    </Modal>
  )
}
