import { SettingsPageHeader, SettingsSection } from '@/components/settings/SettingsSection'
import { Switch } from '@/components/ui/Switch'
import { useTranslation, type TranslationKey } from '../../i18n'
import {
  OPTIONAL_SETTINGS_TABS,
  type OptionalSettingsTab,
  useSettingsNavigationStore,
} from '../../stores/settingsNavigationStore'

const MENU_LABELS: Record<OptionalSettingsTab, TranslationKey> = {
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
  const saveError = useSettingsNavigationStore((s) => s.saveError)
  const setTabVisible = useSettingsNavigationStore((s) => s.setTabVisible)

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
        {saveError ? (
          <p className="mt-3 text-sm text-[var(--color-error)]" role="alert">
            {t(saveError as TranslationKey)}
          </p>
        ) : null}
      </SettingsSection>
    </div>
  )
}