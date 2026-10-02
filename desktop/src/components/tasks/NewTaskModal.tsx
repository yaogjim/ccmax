import { useState, useEffect } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAdapterStore } from '../../stores/adapterStore'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { Button } from '@/components/ui/Button'
import { PromptEditor } from './PromptEditor'
import { DayOfWeekPicker } from './DayOfWeekPicker'
import { useTranslation } from '../../i18n'
import { describeCron, isValidCron, parseCron, type FrequencyKey } from '../../lib/cronDescribe'
import {
  CRON_TASK_TIMEOUT_DEFAULT_SECONDS,
  CRON_TASK_TIMEOUT_ENV_VAR,
  CRON_TASK_TIMEOUT_MAX_SECONDS,
  formatCronTaskTimeoutSeconds,
  parseCronTaskTimeoutSeconds,
} from '../../lib/cronTaskTimeout'
import { getSessionSeedWorkDir } from '../../lib/sessionWorkspace'
import type { CronTask, NotificationRecipientSpec } from '../../types/task'
import type { PairedUser } from '../../types/adapter'

type NotificationChannel = 'desktop' | 'telegram' | 'feishu'

type ImChannel = 'telegram' | 'feishu'

/** Stable reference so the recipient-sync effect does not rerun every render. */
const NO_PAIRED_USERS: PairedUser[] = []

/**
 * Map a stored recipient spec back to a paired user id. The server matches
 * `{ userId }`, `{ displayName }` or a bare id, so an edit form has to try all
 * three before deciding the old recipient no longer exists.
 */
function recipientIdOf(
  spec: NotificationRecipientSpec | undefined,
  pairedUsers: PairedUser[],
): string {
  if (spec === undefined) return ''
  for (const user of pairedUsers) {
    const id = String(user.userId)
    if (typeof spec === 'string' || typeof spec === 'number') {
      if (id === String(spec)) return id
      continue
    }
    if (typeof spec.userId === 'string' || typeof spec.userId === 'number') {
      if (id === String(spec.userId)) return id
      continue
    }
    if (typeof spec.displayName === 'string' && spec.displayName.trim().length > 0) {
      if (user.displayName === spec.displayName) return id
    }
  }
  return ''
}

/** Build the explicit one-element recipient list the server expects. */
function recipientSpecFor(id: string, pairedUsers: PairedUser[]): NotificationRecipientSpec[] {
  const match = pairedUsers.find((user) => String(user.userId) === id)
  return match ? [{ userId: match.userId, displayName: match.displayName }] : []
}

function recipientOptions(pairedUsers: PairedUser[], placeholder: string) {
  return [
    { value: '', label: placeholder },
    ...pairedUsers.map((user) => ({
      value: String(user.userId),
      label: user.displayName ? `${user.displayName} (${String(user.userId)})` : String(user.userId),
    })),
  ]
}

type Props = {
  open: boolean
  onClose: () => void
  editTask?: CronTask
}

const MINUTE_INTERVALS = [5, 10, 15, 20, 30]
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12]
const MINUTE_OFFSETS = [0, 15, 30, 45]

function buildCron(
  freq: FrequencyKey,
  time: string,
  opts: {
    minuteInterval: number
    hourInterval: number
    minuteOffset: number
    selectedDays: number[]
    monthDay: number
    customCron: string
  },
): string {
  const [hours, minutes] = time.split(':').map(Number)
  switch (freq) {
    case 'everyNMinutes':
      return `*/${opts.minuteInterval} * * * *`
    case 'everyNHours':
      return `${opts.minuteOffset} */${opts.hourInterval} * * *`
    case 'daily':
      return `${minutes} ${hours} * * *`
    case 'weekdays':
      return `${minutes} ${hours} * * 1-5`
    case 'specificDays':
      return `${minutes} ${hours} * * ${[...opts.selectedDays].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${minutes} ${hours} ${opts.monthDay} * *`
    case 'customCron':
      return opts.customCron.trim()
  }
}

export function NewTaskModal({ open, onClose, editTask }: Props) {
  const t = useTranslation()
  const { createTask, updateTask } = useTaskStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const defaultWorkDir = getSessionSeedWorkDir(activeSession) || ''
  const adapterConfig = useAdapterStore((s) => s.config)
  const fetchAdapterConfig = useAdapterStore((s) => s.fetchConfig)

  useEffect(() => {
    if (open) fetchAdapterConfig()
  }, [open])

  const telegramPairedUsers = adapterConfig.telegram?.pairedUsers ?? NO_PAIRED_USERS
  const feishuPairedUsers = adapterConfig.feishu?.pairedUsers ?? NO_PAIRED_USERS

  // Notification targets are resolved server-side against `pairedUsers` only —
  // `allowedUsers` is an access allowlist, not a send-to list. A channel with no
  // paired user can never deliver, so it is not offered.
  const isFeishuConfigured = !!(adapterConfig.feishu?.appId && adapterConfig.feishu?.appSecret
    && feishuPairedUsers.length > 0)
  const isTelegramConfigured = !!(adapterConfig.telegram?.botToken
    && telegramPairedUsers.length > 0)

  const isEdit = !!editTask
  const parsed = editTask ? parseCron(editTask.cron) : null

  const FREQUENCY_OPTIONS: Array<{ value: FrequencyKey; label: string }> = [
    { value: 'everyNMinutes', label: t('newTask.everyNMinutes') },
    { value: 'everyNHours',   label: t('newTask.everyNHours') },
    { value: 'daily',         label: t('newTask.daily') },
    { value: 'weekdays',      label: t('newTask.weekdays') },
    { value: 'specificDays',  label: t('newTask.specificDays') },
    { value: 'monthly',       label: t('newTask.monthly') },
    { value: 'customCron',    label: t('newTask.customCron') },
  ]

  const [name, setName] = useState(editTask?.name || '')
  const [description, setDescription] = useState(editTask?.description || '')
  const [prompt, setPrompt] = useState(editTask?.prompt || '')
  const [frequency, setFrequency] = useState<FrequencyKey>(parsed?.frequency || 'daily')
  const [time, setTime] = useState(parsed?.time || '09:00')
  const [model, setModel] = useState(editTask?.model || '')
  const [providerId, setProviderId] = useState<string | null | undefined>(editTask?.providerId)
  const [folderPath, setFolderPath] = useState(editTask?.folderPath || defaultWorkDir)
  const [useWorktree, setUseWorktree] = useState(editTask?.useWorktree || false)
  const [notifyEnabled, setNotifyEnabled] = useState(editTask?.notification?.enabled || false)
  const [notifyChannels, setNotifyChannels] = useState<NotificationChannel[]>(editTask?.notification?.channels || [])
  const [telegramRecipient, setTelegramRecipient] = useState('')
  const [feishuRecipient, setFeishuRecipient] = useState('')
  const [recipientError, setRecipientError] = useState(false)
  // Blank means "no explicit per-task value": the server falls back to
  // CC_HAHA_TASK_TIMEOUT_MS, then the 600s default. A task stored without the
  // field therefore loads as an empty input, exactly like a fresh one.
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    formatCronTaskTimeoutSeconds(editTask?.timeoutMs),
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Older tasks stored a channel without any recipient (the server used to
  // broadcast). The pairing list loads asynchronously, so resolve the stored
  // recipient into a select value once it is available instead of silently
  // starting blank and dropping the old target on save.
  useEffect(() => {
    if (!open) return
    const storedTelegram = editTask?.notification?.recipients?.telegram?.[0]
    if (storedTelegram !== undefined) {
      const resolved = recipientIdOf(storedTelegram, telegramPairedUsers)
      setTelegramRecipient((current) => current || resolved)
    }
    const storedFeishu = editTask?.notification?.recipients?.feishu?.[0]
    if (storedFeishu !== undefined) {
      const resolved = recipientIdOf(storedFeishu, feishuPairedUsers)
      setFeishuRecipient((current) => current || resolved)
    }
  }, [open, editTask, telegramPairedUsers, feishuPairedUsers])

  // Enhanced scheduling state
  const [minuteInterval, setMinuteInterval] = useState(parsed?.minuteInterval || 15)
  const [hourInterval, setHourInterval] = useState(parsed?.hourInterval || 1)
  const [minuteOffset, setMinuteOffset] = useState(parsed?.minuteOffset || 0)
  const [selectedDays, setSelectedDays] = useState<number[]>(parsed?.selectedDays || [1])
  const [monthDay, setMonthDay] = useState(parsed?.monthDay || 1)
  const [customCron, setCustomCron] = useState(parsed?.customCron || '0 9 * * *')

  const showTime = ['daily', 'weekdays', 'specificDays', 'monthly'].includes(frequency)

  const cronValue = buildCron(frequency, time, {
    minuteInterval, hourInterval, minuteOffset, selectedDays, monthDay, customCron,
  })

  const timeoutParse = parseCronTaskTimeoutSeconds(timeoutSeconds)
  // Only surface the error once the user typed something unusable — a blank
  // field is the documented "use the default" state, not a mistake.
  const timeoutError = timeoutParse.kind === 'invalid'
    ? t('newTask.timeoutInvalid', { max: CRON_TASK_TIMEOUT_MAX_SECONDS })
    : undefined

  const canSubmit =
    name.trim() &&
    description.trim() &&
    prompt.trim() &&
    (frequency !== 'customCron' || isValidCron(customCron)) &&
    (frequency !== 'specificDays' || selectedDays.length > 0) &&
    (!notifyEnabled || notifyChannels.length > 0) &&
    timeoutParse.kind !== 'invalid'

  // Every selected IM channel needs an explicit target. A missing one is
  // reported on save, never silently sent to everyone.
  const missingRecipient = notifyEnabled && (
    (notifyChannels.includes('telegram') && !telegramRecipient) ||
    (notifyChannels.includes('feishu') && !feishuRecipient)
  )

  const handleSubmit = async () => {
    if (!canSubmit) return
    if (missingRecipient) {
      setRecipientError(true)
      return
    }
    setRecipientError(false)
    setIsSubmitting(true)
    try {
      const recipients: Partial<Record<ImChannel, NotificationRecipientSpec[]>> = {}
      if (notifyChannels.includes('telegram')) {
        recipients.telegram = recipientSpecFor(telegramRecipient, telegramPairedUsers)
      }
      if (notifyChannels.includes('feishu')) {
        recipients.feishu = recipientSpecFor(feishuRecipient, feishuPairedUsers)
      }
      const hasRecipients = Object.keys(recipients).length > 0
      const basePayload = {
        name: name.trim(),
        description: description.trim(),
        cron: cronValue,
        prompt: prompt.trim(),
        model: model || undefined,
        providerId,
        permissionMode: 'bypassPermissions',
        folderPath: folderPath.trim() || undefined,
        useWorktree: useWorktree || undefined,
        notification: notifyEnabled && notifyChannels.length > 0
          ? { enabled: true, channels: notifyChannels, ...(hasRecipients ? { recipients } : {}) }
          : undefined,
      }
      if (isEdit) {
        // An empty field on an existing task is an explicit clear: send `null`
        // so a previously saved value is removed instead of being left behind.
        await updateTask(editTask!.id, {
          ...basePayload,
          timeoutMs: timeoutParse.kind === 'valid' ? timeoutParse.ms : null,
        })
      } else {
        // A new task with a blank field carries no timeoutMs at all, so the
        // environment variable and built-in default resolve it server-side.
        await createTask({
          ...basePayload,
          enabled: true,
          recurring: true,
          ...(timeoutParse.kind === 'valid' ? { timeoutMs: timeoutParse.ms } : {}),
        })
      }
      onClose()
    } catch (err) {
      console.error(`Failed to ${isEdit ? 'update' : 'create'} task:`, err)
    } finally {
      setIsSubmitting(false)
    }
  }

  const cronPreview = frequency === 'customCron' && customCron.trim() && !isValidCron(customCron)
    ? t('newTask.invalidCron')
    : describeCron(cronValue, t)

  return (
    <Modal
      open={open}
      onClose={onClose}
      // 760px, per the handoff: the prompt editor's embedded toolbar puts a
      // permission chip, a folder chip and a model picker on one line, which
      // wraps into three rows at the 560px default.
      width={760}
      title={isEdit ? t('tasks.editTitle') : t('newTask.title')}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-4">
          {/* The human-readable schedule reads as the sentence the buttons are
              about to commit to, so it sits with them rather than in the body. */}
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-secondary)]">schedule</span>
          <span className="min-w-0 text-[13.5px] text-[var(--color-text-secondary)]">{cronPreview}</span>
          <div className="ml-auto flex shrink-0 gap-2.5">
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={!canSubmit} loading={isSubmitting}>
              {isEdit ? t('tasks.saveChanges') : t('newTask.create')}
            </Button>
          </div>
        </div>
      }
    >
      {/* Info banner */}
      <Card radius="md" surface="low" padding="none" className="mb-5 flex items-center gap-2.5 px-[15px] py-[11px]">
        <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-secondary)]">info</span>
        <span className="text-[13.5px] text-[var(--color-text-secondary)]">
          {t('newTask.localWarning')}
        </span>
      </Card>

      <div className="flex flex-col gap-4">
        <Input
          label={t('newTask.name')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newTask.namePlaceholder')}
        />

        <Input
          label={t('newTask.description')}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('newTask.descPlaceholder')}
        />

        {/* Prompt editor with embedded controls */}
        <PromptEditor
          value={prompt}
          onChange={setPrompt}
          placeholder={t('newTask.promptPlaceholder')}
          modelId={model}
          onModelChange={setModel}
          providerId={providerId}
          onProviderIdChange={setProviderId}
          folderPath={folderPath}
          onFolderPathChange={setFolderPath}
          useWorktree={useWorktree}
          onUseWorktreeChange={setUseWorktree}
        />

        {/* Frequency, with the time of day beside it — the handoff pairs
            「每天」and「09:00」on one line because they are one sentence.
            The selects are `SelectField` rather than bare `<select>`: all seven
            native selects in the app shipped nameless, and the hand-rolled
            chevron needed `appearance-none` plus an absolutely positioned icon
            to reproduce what the platform control draws for free. */}
        <div className="flex flex-wrap items-end gap-2.5">
          <SelectField<FrequencyKey>
            containerClassName="min-w-[220px] flex-1"
            label={t('newTask.frequency')}
            value={frequency}
            onChange={setFrequency}
            options={FREQUENCY_OPTIONS}
          />

          {/* Time picker — shown for daily, weekdays, specificDays, monthly.
              Named by `aria-label` rather than a visible label: the handoff puts
              one「频率」heading over both controls, and a second caption here
              would break that pairing. Same treatment `SelectField` gives its
              own `labelHidden` fields. */}
          {showTime && (
            <input
              type="time"
              aria-label={t('newTask.time')}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-10 w-40 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 font-mono text-sm tabular-nums text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)]"
            />
          )}
        </div>

        {/* Sub-controls based on frequency */}
        {frequency === 'everyNMinutes' && (
          <SelectField
            label={t('newTask.everyNMinutes')}
            labelHidden
            value={String(minuteInterval)}
            onChange={(value) => setMinuteInterval(Number(value))}
            options={MINUTE_INTERVALS.map((n) => ({ value: String(n), label: t('newTask.intervalMinutes', { n }) }))}
          />
        )}

        {frequency === 'everyNHours' && (
          <div className="flex gap-2.5">
            <SelectField
              containerClassName="flex-1"
              label={t('newTask.everyNHours')}
              labelHidden
              value={String(hourInterval)}
              onChange={(value) => setHourInterval(Number(value))}
              options={HOUR_INTERVALS.map((n) => ({ value: String(n), label: t('newTask.intervalHours', { n }) }))}
            />
            <SelectField
              containerClassName="flex-1"
              label={t('newTask.atMinute', { m: '00' })}
              labelHidden
              value={String(minuteOffset)}
              onChange={(value) => setMinuteOffset(Number(value))}
              options={MINUTE_OFFSETS.map((m) => ({
                value: String(m),
                label: t('newTask.atMinute', { m: m.toString().padStart(2, '0') }),
              }))}
            />
          </div>
        )}

        {frequency === 'specificDays' && (
          <DayOfWeekPicker selected={selectedDays} onChange={setSelectedDays} />
        )}

        {frequency === 'monthly' && (
          <SelectField
            label={t('newTask.monthly')}
            labelHidden
            value={String(monthDay)}
            onChange={(value) => setMonthDay(Number(value))}
            options={Array.from({ length: 28 }, (_, i) => i + 1).map((d) => ({
              value: String(d),
              label: t('newTask.onMonthDay', { d }),
            }))}
          />
        )}

        {frequency === 'customCron' && (
          <Input
            aria-label={t('newTask.customCron')}
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder={t('newTask.cronFormatHint')}
            className="font-mono"
            hint={t('newTask.cronFormatHint')}
            // `error` gives the message `role="alert"` and points the field's
            // `aria-describedby` at it; the loose span it replaces was never
            // announced.
            error={customCron.trim() && !isValidCron(customCron) ? t('newTask.invalidCron') : undefined}
          />
        )}

        {/* Per-task run timeout. Deliberately here rather than in General
            settings: the server has no global timeout endpoint, and the value
            belongs to the task it applies to. */}
        <Input
          label={t('newTask.timeoutLabel')}
          value={timeoutSeconds}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
          placeholder={String(CRON_TASK_TIMEOUT_DEFAULT_SECONDS)}
          inputMode="decimal"
          hint={t('newTask.timeoutHint', {
            seconds: CRON_TASK_TIMEOUT_DEFAULT_SECONDS,
            env: CRON_TASK_TIMEOUT_ENV_VAR,
          })}
          error={timeoutError}
        />

        {/* Notification. The three hand-rolled checkboxes here were part of the
            19 across the app that varied in size, accent token and how the
            label was associated; `Checkbox` also carries the disabled styling
            the channel rows were spelling out by hand. */}
        <Card radius="lg" padding="none" className="flex flex-col gap-3 px-[18px] py-[15px]">
          <Checkbox
            label={t('newTask.notifyOnComplete')}
            description={t('newTask.notifyHint')}
            checked={notifyEnabled}
            onChange={(e) => {
              setNotifyEnabled(e.target.checked)
              if (e.target.checked && notifyChannels.length === 0) {
                setNotifyChannels(['desktop'])
              }
            }}
          />
          {notifyEnabled && (
            <div className="flex flex-col gap-2 pl-6">
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox
                  size="sm"
                  label={t('newTask.notifyDesktop')}
                  checked={notifyChannels.includes('desktop')}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'desktop'] : prev.filter((c) => c !== 'desktop'),
                    )
                  }}
                />
                <Checkbox
                  size="sm"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('settings.adapters.feishu')}
                      {!isFeishuConfigured && <Badge tone="warning">{t('newTask.notConfigured')}</Badge>}
                    </span>
                  }
                  checked={notifyChannels.includes('feishu')}
                  disabled={!isFeishuConfigured && !notifyChannels.includes('feishu')}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'feishu'] : prev.filter((c) => c !== 'feishu'),
                    )
                  }}
                />
                <Checkbox
                  size="sm"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('settings.adapters.telegram')}
                      {!isTelegramConfigured && <Badge tone="warning">{t('newTask.notConfigured')}</Badge>}
                    </span>
                  }
                  checked={notifyChannels.includes('telegram')}
                  disabled={!isTelegramConfigured && !notifyChannels.includes('telegram')}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'telegram'] : prev.filter((c) => c !== 'telegram'),
                    )
                  }}
                />
              </div>

              {/* One target per selected IM channel. `SelectField` is a single
                  select on purpose: the server accepts a recipient list, but
                  the desktop owner picks exactly one, and a channel with no
                  paired user never reaches this point. */}
              {notifyChannels.includes('feishu') && (
                <SelectField
                  containerClassName="max-w-sm"
                  label={`${t('settings.adapters.feishu')} · ${t('newTask.recipientLabel')}`}
                  value={feishuRecipient}
                  onChange={setFeishuRecipient}
                  options={recipientOptions(feishuPairedUsers, t('newTask.recipientPlaceholder'))}
                />
              )}
              {notifyChannels.includes('telegram') && (
                <SelectField
                  containerClassName="max-w-sm"
                  label={`${t('settings.adapters.telegram')} · ${t('newTask.recipientLabel')}`}
                  value={telegramRecipient}
                  onChange={setTelegramRecipient}
                  options={recipientOptions(telegramPairedUsers, t('newTask.recipientPlaceholder'))}
                />
              )}

              {recipientError && missingRecipient && (
                <Badge
                  tone="warning"
                  size="sm"
                  wrap
                  bordered
                  pill={false}
                  role="alert"
                  icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">warning</span>}
                >
                  {t('newTask.recipientRequired')}
                </Badge>
              )}

              {notifyChannels.length === 0 && (
                <Badge
                  tone="warning"
                  size="sm"
                  wrap
                  bordered
                  pill={false}
                  role="alert"
                  icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">warning</span>}
                >
                  {t('newTask.noChannelSelected')}
                </Badge>
              )}
            </div>
          )}
        </Card>

        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('newTask.delayNote')}
        </p>
      </div>
    </Modal>
  )
}
