import { useEffect, useState } from 'react'
import { SettingsPageHeader, SettingsSection } from '@/components/settings/SettingsSection'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useTranslation, type TranslationKey } from '../../i18n'
import {
  OPTIONAL_SETTINGS_TABS,
  parseSkillMarketUrl,
  type OptionalSettingsTab,
  useSettingsNavigationStore,
} from '../../stores/settingsNavigationStore'

const MENU_LABELS: Record<OptionalSettingsTab, TranslationKey> = {
  h5Access: 'settings.tab.h5Access',
  terminal: 'settings.tab.terminal',
  adapters: 'settings.tab.adapters',
  pets: 'settings.tab.pets',
  trace: 'settings.tab.trace',
  diagnostics: 'settings.tab.diagnostics',
  about: 'settings.tab.about',
}

export function SystemSettings() {
  const t = useTranslation()
  const preferences = useSettingsNavigationStore((s) => s.preferences)
  const skillMarket = useSettingsNavigationStore((s) => s.skillMarket)
  const saveError = useSettingsNavigationStore((s) => s.saveError)
  const setTabVisible = useSettingsNavigationStore((s) => s.setTabVisible)
  const setSkillMarketVisible = useSettingsNavigationStore((s) => s.setSkillMarketVisible)
  const setSkillMarketUrl = useSettingsNavigationStore((s) => s.setSkillMarketUrl)
  const [marketUrlDraft, setMarketUrlDraft] = useState(skillMarket.url)
  const [marketUrlError, setMarketUrlError] = useState<string | null>(null)

  useEffect(() => {
    setMarketUrlDraft(skillMarket.url)
  }, [skillMarket.url])

  const persistMarketUrl = () => {
    const parsed = parseSkillMarketUrl(marketUrlDraft)
    if (parsed === null) {
      setMarketUrlError('settings.system.marketUrlInvalid')
      return
    }
    setMarketUrlError(null)
    void setSkillMarketUrl(parsed)
  }

  return (
    <div className="w-full min-w-0 max-w-2xl">
      <SettingsPageHeader
        title={t('settings.system.title')}
        description={t('settings.system.description')}
      />
      <SettingsSection
        title={t('settings.system.menusTitle')}
        description={t('settings.system.menusDescription')}
      >
        <div className="divide-y divide-[var(--color-border-separator)] rounded-[var(--radius-xl)] border border-[var(--color-border)]">
          {OPTIONAL_SETTINGS_TABS.map((tab) => (
            <div key={tab} className="px-4 py-3">
              <Switch
                label={t(MENU_LABELS[tab])}
                description={t('settings.system.menuToggleDescription', { menu: t(MENU_LABELS[tab]) })}
                checked={preferences[tab]}
                onChange={(checked) => {
                  void setTabVisible(tab, checked)
                }}
              />
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.system.marketTitle')}
        description={t('settings.system.marketDescription')}
      >
        <div className="divide-y divide-[var(--color-border-separator)] rounded-[var(--radius-xl)] border border-[var(--color-border)]">
          <div className="px-4 py-3">
            <Switch
              label={t('sidebar.market')}
              description={t('settings.system.marketToggleDescription')}
              checked={skillMarket.visible}
              onChange={(checked) => {
                void setSkillMarketVisible(checked)
              }}
            />
          </div>
          <div className="px-4 py-3">
            <Input
              label={t('settings.system.marketUrl')}
              value={marketUrlDraft}
              onChange={(event) => {
                setMarketUrlDraft(event.target.value)
                if (marketUrlError) setMarketUrlError(null)
              }}
              onBlur={persistMarketUrl}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  persistMarketUrl()
                }
              }}
              placeholder={t('settings.system.marketUrlPlaceholder')}
              hint={t('settings.system.marketUrlHint')}
              error={marketUrlError ? t(marketUrlError as TranslationKey) : undefined}
              inputMode="url"
              autoComplete="url"
            />
          </div>
        </div>
        {saveError ? (
          <p className="mt-3 text-sm text-[var(--color-error)]" role="alert">
            {t(saveError as TranslationKey)}
          </p>
        ) : null}
      </SettingsSection>
    </div>
  )
}