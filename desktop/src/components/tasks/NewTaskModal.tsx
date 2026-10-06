import { useState, useEffect, useMemo } from 'react'
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
import type { CronTask, NotificationRecipientSpec, TelegramEntrypoint } from '@/types/task'
import type { PairedUser } from '../../types/adapter'

type NotificationChannel = 'desktop' | 'telegram' | 'feishu'

type ImChannel = 'telegram' | 'feishu'

/**
 * The desktop owner picks one of three Telegram routes; the stored value is the
 * list `notification.telegramEntrypoints`.
 */
type TelegramRoute = 'dedicated' | 'public' | 'both'

/**
 * Map a stored entrypoint list onto the single route control. An absent list
 * means the original dedicated-only behavior, so a task stored before the
 * option existed opens as dedicated.
 */
function telegramRouteOf(entrypoints: TelegramEntrypoint[] | undefined): TelegramRoute {
  const set = new Set(entrypoints ?? ['dedicated'])
  const dedicated = set.has('dedicated')
  const isPublic = set.has('public')
  if (dedicated && isPublic) return 'both'
  if (isPublic) return 'public'
  return 'dedicated'
}

function entrypointsForRoute(route: TelegramRoute): TelegramEntrypoint[] {
  if (route === 'both') return ['dedicated', 'public']
  if (route === 'public') return ['public']
  return ['dedicated']
}

/** Stable reference so the recipient-sync effect does not rerun every render. */
const NO_PAIRED_USERS: PairedUser[] = []

/**
 * Map a stored recipient spec back to a paired user id. The server matches
 * `{ userId }`, `{ displayName }` or a bare id, so an edit form has to try all
 * three before deciding the old recipient no longer exists.
 *
 * This is the original resolution, kept for the dedicated route and for Feishu.
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

/**
 * Read the identifier a stored recipient spec carries, if any. The server
 * accepts a bare id or `{ userId }`, so this is the only part of a stored spec
 * that identifies an account.
 *
 * This is for the public/both routes only. A spec that carries just a
 * `displayName` has no identity, and on those routes matching it against the
 * current pairings by name would silently re-point an old task at whoever bears
 * that name now — the current owner, on the public route. Such a task therefore
 * opens with no recipient selected and the save is refused until the owner is
 * picked explicitly. The dedicated route keeps `recipientIdOf`'s original
 * id-or-name resolution.
 */
function storedRecipientId(spec: NotificationRecipientSpec | undefined): string {
  if (spec === undefined) return ''
  if (typeof spec === 'string' || typeof spec === 'number') return String(spec)
  if (typeof spec.userId === 'string' || typeof spec.userId === 'number') return String(spec.userId)
  return ''
}

/** The name a stored spec displays, used only to label an unavailable option. */
function storedRecipientDisplayName(spec: NotificationRecipientSpec | undefined): string {
  if (spec && typeof spec === 'object' && typeof spec.displayName === 'string') {
    return spec.displayName
  }
  return ''
}

/** Build the explicit one-element recipient list the server expects. */
function recipientSpecFor(id: string, pairedUsers: PairedUser[]): NotificationRecipientSpec[] {
  const match = pairedUsers.find((user) => String(user.userId) === id)
  if (!match) return []
  // The server rejects a recipient whose `displayName` is empty, and the
  // synthesized public owner has no name unless it is also dedicated-paired, so
  // the field is written only when there is a name to write.
  return typeof match.displayName === 'string' && match.displayName.trim().length > 0
    ? [{ userId: match.userId, displayName: match.displayName }]
    : [{ userId: match.userId }]
}

/**
 * A recipient only counts as chosen when it is one of the channel's current
 * candidates, so a stale or hand-edited id can never be saved back as an empty
 * recipient list.
 */
function isCurrentRecipient(id: string, candidates: PairedUser[]): boolean {
  return id.length > 0 && candidates.some((user) => String(user.userId) === id)
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

/**
 * The public/both routes add the stored target to the shared option list when it
 * is no longer a current candidate, labelled as unavailable. It is shown rather
 * than replaced — the edit form never hides what the task actually sends to —
 * and it is never auto-replaced: re-picking the recipient is the user's explicit
 * authorization for a new target.
 */
function publicRouteRecipientOptions(
  candidates: PairedUser[],
  placeholder: string,
  selected: string,
  storedDisplayName: string,
  unavailableLabel: string,
) {
  const options = recipientOptions(candidates, placeholder)
  if (selected.length > 0 && !isCurrentRecipient(selected, candidates)) {
    const label = storedDisplayName
      ? `${storedDisplayName} (${selected}) · ${unavailableLabel}`
      : `${selected} · ${unavailableLabel}`
    options.splice(1, 0, { value: selected, label })
  }
  return options
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
  const publicConfig = adapterConfig.telegram?.public
  const publicEnabled = publicConfig?.enabled === true
  const publicHasToken =
    typeof publicConfig?.botToken === 'string' && publicConfig.botToken.trim().length > 0
  const publicOwnerId =
    typeof publicConfig?.ownerUserId === 'number'
    && Number.isSafeInteger(publicConfig.ownerUserId)
    && publicConfig.ownerUserId > 0
      ? publicConfig.ownerUserId
      : null
  const publicAvailable = publicEnabled && publicHasToken && publicOwnerId !== null
  const dedicatedTelegramAvailable = !!(
    adapterConfig.telegram?.botToken && telegramPairedUsers.length > 0
  )

  // Notification targets are resolved server-side against `pairedUsers` only —
  // `allowedUsers` is an access allowlist, not a send-to list. A channel with no
  // paired user can never deliver, so it is not offered. Telegram also counts as
  // configured when the public Bot is enabled with its own token and a valid
  // owner, because a public-only task sends to that owner without the dedicated
  // Bot being configured at all.
  const isFeishuConfigured = !!(adapterConfig.feishu?.appId && adapterConfig.feishu?.appSecret
    && feishuPairedUsers.length > 0)
  const isTelegramConfigured = dedicatedTelegramAvailable || publicAvailable

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
  const [telegramRoute, setTelegramRoute] = useState<TelegramRoute>(
    telegramRouteOf(editTask?.notification?.telegramEntrypoints),
  )
  const [telegramRecipient, setTelegramRecipient] = useState('')
  const [feishuRecipient, setFeishuRecipient] = useState('')
  // Set once the user picks or clears the Telegram recipient on a public/both
  // task: from then on no refresh may change the value behind them. The
  // dedicated route and Feishu keep their original fill-in behavior.
  const [telegramRecipientTouched, setTelegramRecipientTouched] = useState(false)
  const [recipientError, setRecipientError] = useState(false)
  // Blank means "no explicit per-task value": the server falls back to
  // CC_HAHA_TASK_TIMEOUT_MS, then the 600s default. A task stored without the
  // field therefore loads as an empty input, exactly like a fresh one.
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    formatCronTaskTimeoutSeconds(editTask?.timeoutMs),
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Whether the *stored* task uses one of the new public/both routes. Only then
  // does the recipient handling below depart from the original dedicated path.
  const storedTelegramUsesPublicRoute =
    telegramRouteOf(editTask?.notification?.telegramEntrypoints) !== 'dedicated'

  // Older tasks stored a channel without any recipient (the server used to
  // broadcast). The pairing list loads asynchronously, so resolve the stored
  // recipient into a select value once it is available instead of silently
  // starting blank and dropping the old target on save.
  //
  // A task stored on the dedicated route keeps that original resolution and the
  // original fill-in. The public/both routes are new and stricter: only the
  // stored id counts, and once the user has touched the select nothing re-applies
  // it. Feishu is unchanged.
  useEffect(() => {
    if (!open) return
    const storedTelegram = editTask?.notification?.recipients?.telegram?.[0]
    if (storedTelegram !== undefined) {
      if (storedTelegramUsesPublicRoute) {
        if (!telegramRecipientTouched) {
          const stored = storedRecipientId(storedTelegram)
          if (stored) setTelegramRecipient(stored)
        }
      } else {
        const resolved = recipientIdOf(storedTelegram, telegramPairedUsers)
        setTelegramRecipient((current) => current || resolved)
      }
    }
    const storedFeishu = editTask?.notification?.recipients?.feishu?.[0]
    if (storedFeishu !== undefined) {
      const resolved = recipientIdOf(storedFeishu, feishuPairedUsers)
      setFeishuRecipient((current) => current || resolved)
    }
  }, [
    open,
    editTask,
    telegramPairedUsers,
    feishuPairedUsers,
    storedTelegramUsesPublicRoute,
    telegramRecipientTouched,
  ])

  // The public Bot has no separate recipient: its target is the single public
  // owner. For a public-only route the owner need not appear in the dedicated
  // `pairedUsers`, so the owner record is built independently; for the both
  // routes the owner must also be dedicated-paired, and only then is it offered.
  const publicOwnerUser = useMemo<PairedUser | null>(() => {
    if (publicOwnerId === null) return null
    const paired = telegramPairedUsers.find((user) => String(user.userId) === String(publicOwnerId))
    return {
      userId: publicOwnerId,
      displayName: paired?.displayName ?? '',
      pairedAt: paired?.pairedAt ?? 0,
    }
  }, [publicOwnerId, telegramPairedUsers])

  const telegramRecipientUsers = useMemo<PairedUser[]>(() => {
    if (telegramRoute === 'dedicated') return telegramPairedUsers
    const owner = publicOwnerUser
    if (!owner) return []
    if (telegramRoute === 'public') return [owner]
    const ownerPaired = telegramPairedUsers.find(
      (user) => String(user.userId) === String(owner.userId),
    )
    return ownerPaired ? [ownerPaired] : []
  }, [telegramRoute, publicOwnerUser, telegramPairedUsers])

  // The dedicated route keeps the original option list. The public/both routes
  // keep a stored target that is no longer a current candidate visible, marked
  // unavailable. Feishu is unchanged.
  const telegramRecipientOptions = telegramRoute === 'dedicated'
    ? recipientOptions(telegramRecipientUsers, t('newTask.recipientPlaceholder'))
    : publicRouteRecipientOptions(
        telegramRecipientUsers,
        t('newTask.recipientPlaceholder'),
        telegramRecipient,
        storedRecipientDisplayName(editTask?.notification?.recipients?.telegram?.[0]),
        t('newTask.recipientUnavailable'),
      )

  // A public route that cannot deliver right now is called out rather than
  // silently retargeted: disabled Bot or missing token, no owner, or (for the
  // both routes) an owner who is not also dedicated-paired.
  const telegramRouteIssue: 'publicDisabled' | 'noOwner' | 'ownerRequired' | null =
    !notifyEnabled || !notifyChannels.includes('telegram') || telegramRoute === 'dedicated'
      ? null
      : !publicEnabled || !publicHasToken
        ? 'publicDisabled'
        : publicOwnerId === null
          ? 'noOwner'
          : telegramRecipientUsers.length === 0
            ? 'ownerRequired'
            : null

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
    telegramRouteIssue === null &&
    timeoutParse.kind !== 'invalid'

  // Every selected IM channel needs an explicit target. A missing one is
  // reported on save, never silently sent to everyone. The public/both routes
  // additionally require the chosen target to still be a current candidate, so a
  // stale stored id cannot be saved back as an empty recipient list. The
  // dedicated route and Feishu keep their original check.
  const missingRecipient = notifyEnabled && (
    (notifyChannels.includes('telegram')
      && (telegramRoute === 'dedicated'
        ? !telegramRecipient
        : !isCurrentRecipient(telegramRecipient, telegramRecipientUsers))) ||
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
        recipients.telegram = recipientSpecFor(telegramRecipient, telegramRecipientUsers)
      }
      if (notifyChannels.includes('feishu')) {
        recipients.feishu = recipientSpecFor(feishuRecipient, feishuPairedUsers)
      }
      const hasRecipients = Object.keys(recipients).length > 0
      // The default dedicated route is written as an absent field, so a saved
      // task serializes exactly like a file that predates the option.
      const telegramEntrypoints = notifyChannels.includes('telegram') && telegramRoute !== 'dedicated'
        ? entrypointsForRoute(telegramRoute)
        : undefined
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
          ? {
              enabled: true,
              channels: notifyChannels,
              ...(telegramEntrypoints ? { telegramEntrypoints } : {}),
              ...(hasRecipients ? { recipients } : {}),
            }
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
                <SelectField<TelegramRoute>
                  containerClassName="max-w-sm"
                  label={t('newTask.telegramRouteLabel')}
                  value={telegramRoute}
                  onChange={setTelegramRoute}
                  options={[
                    { value: 'dedicated', label: t('newTask.telegramRouteDedicated') },
                    { value: 'public', label: t('newTask.telegramRoutePublic') },
                    { value: 'both', label: t('newTask.telegramRouteBoth') },
                  ]}
                />
              )}
              {notifyChannels.includes('telegram') && (
                <SelectField
                  containerClassName="max-w-sm"
                  label={`${t('settings.adapters.telegram')} · ${t('newTask.recipientLabel')}`}
                  value={telegramRecipient}
                  onChange={(value) => {
                    // Only the public/both routes record that the user has made a
                    // choice; the dedicated route keeps its original fill-in.
                    if (telegramRoute !== 'dedicated') setTelegramRecipientTouched(true)
                    setTelegramRecipient(value)
                  }}
                  options={telegramRecipientOptions}
                />
              )}

              {telegramRouteIssue && (
                <Badge
                  tone="warning"
                  size="sm"
                  wrap
                  bordered
                  pill={false}
                  role="alert"
                  icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">warning</span>}
                >
                  {t(
                    telegramRouteIssue === 'publicDisabled'
                      ? 'newTask.telegramRoutePublicDisabled'
                      : telegramRouteIssue === 'noOwner'
                        ? 'newTask.telegramRouteNoOwner'
                        : 'newTask.telegramRouteOwnerRequired',
                  )}
                </Badge>
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
