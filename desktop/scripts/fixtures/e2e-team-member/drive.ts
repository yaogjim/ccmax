#!/usr/bin/env bun
/**
 * Committed deterministic smoke for the team member tab (REL-003 / S1.3) and the
 * artifact review panel (S3.3).
 *
 * The unit suites cover the projection, but the S1.3 question is a browser one:
 * does an interjection typed into the *real* member tab reach the mailbox with the
 * same id the pending bubble is keyed by, and does the durable echo settle exactly
 * that bubble instead of merging it with an identical second send?
 *
 * S3.3 adds the second question the component tests cannot answer: does the
 * delivery panel rendered inside the real task drawer drive the real review
 * protocol? The lane seeds one task whose artifact v1 is awaiting review, returns
 * it from the browser (empty reason rejected, real reason committed), has the
 * *owner* submit v2 through the production `applyTaskDeliveryAction` rather than
 * through the UI, accepts v2 from the browser, and then reloads to prove the
 * version history survives. A separately seeded, already-deleted team proves an
 * archived snapshot renders its history read-only, and a member seeded with
 * `initialStartPending` proves the standby state renders.
 *
 * S3.3 read-only adds the record the protocol cannot read: a task seeded with a
 * `delivery` schema newer than this server's. The lane asserts the drawer states
 * the neutral read-only reason, renders no version history and no accept/return
 * action anywhere, never shows either marker from the raw record, and leaves the
 * file byte- and mtime-identical across opening it, reloading, and opening again.
 *
 * This lane boots the real server and the real desktop Vite bundle against a
 * throwaway HOME, a fake provider that points at a closed port, and a scripted
 * member runtime. There is no provider call, no network, and no real team. The
 * member runtime is the only fake: the server writes the same mailbox envelope a
 * real teammate CLI would poll, and this script appends the transcript rows that
 * CLI would append. Everything the assertions read is the product's own rendering.
 *
 * Gates: while `<workRoot>/hold-echo` exists the member runtime does not echo, so
 * the pending bubble is observed in exactly one state instead of racing a timer.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyUserStateGuard, createQualityGateSandbox } from '../../../../scripts/quality-gate/sandbox'
import {
  agentBrowserCommand,
  buildDesktopSmokeBrowserEnv,
  cleanupAgentBrowserSession,
  cleanupBrowserProfileProcesses,
  DESKTOP_SMOKE_COMPOSER_SELECTOR,
  getPort,
  pipeToFile,
  removeDesktopSmokeTree,
  resolveAgentBrowserExecutable,
  resolveDesktopViteExecutable,
  runLoggedCommand,
  stopDesktopSmokeProcess,
  waitForHttp,
} from '../../../../scripts/quality-gate/desktop-smoke/execute'

const ROOT = resolve(import.meta.dir, '../../../..')
const LOCALE = 'en'
const TEAM_NAME = 'smoke-member-team'
const MEMBER_NAME = 'builder'
const MEMBER_AGENT_ID = `builder@${TEAM_NAME}`
const LEAD_AGENT_ID = `team-lead@${TEAM_NAME}`
const MEMBER_SESSION_ID = 'smoke-member-session-1'
const SMOKE_PROVIDER_ID = 'desktop-ui-smoke-provider'
const SMOKE_MODEL_ID = 'desktop-ui-smoke-model'

/** S3.3: a roster member approved but never started, so the board must say standby. */
const PLANNER_NAME = 'planner'
const PLANNER_AGENT_ID = `planner@${TEAM_NAME}`

/** S3.3: the task whose artifact history the browser drives. */
const TASK_SUBJECT = 'Publish the release checklist'
const TASK_DESCRIPTION = 'Write the checklist, then hand it to the user for independent review.'
const TASK_ARTIFACT_V1 = 'artifact: docs/release-checklist-v1.md (draft, no rollback section)'
const TASK_CRITERIA_V1 = 'checklist covers rollout and rollback'
const TASK_ARTIFACT_V2 = 'artifact: docs/release-checklist-v2.md (adds the rollback section)'
const TASK_CRITERIA_V2 = 'checklist covers rollout and rollback, rollback steps verified'
const TASK_RETURN_REASON = 'No rollback section, so this version cannot be accepted.'

/** S3.3: a second team that was already deleted before the browser opened. */
const ARCHIVE_TEAM_NAME = 'smoke-archived-team'
const ARCHIVE_TASK_SUBJECT = 'Archived checklist review'
const ARCHIVE_ARTIFACT = 'artifact: docs/archived-checklist.md (final draft)'
const ARCHIVE_CRITERIA = 'checklist covers rollout and rollback'

/**
 * S3.3 read-only: a task whose on-disk delivery record comes from a newer
 * schema. No production action can produce one, so the fixture writes the
 * record by hand: the question is what the product does with a history it
 * cannot interpret. The two markers exist only inside that record, which makes
 * "did it leak" a substring test against the DOM and the API response.
 */
const UNSUPPORTED_TASK_SUBJECT = 'Legacy checklist handoff'
const UNSUPPORTED_TASK_DESCRIPTION = 'Carried over from a newer release; its delivery record cannot be read here.'
const UNSUPPORTED_RAW_MARKER = 'raw-unsupported-payload'
const UNSUPPORTED_HIDDEN_ARTIFACT = 'hidden-artifact-not-shown'

/** Locale-pinned labels; the lane sets `cc-haha-locale` before reloading. */
const SEND_LABEL = 'Send'
const MEMBER_CONVERSATION = '[data-testid="team-member-conversation"]'
const TEAM_STRIP = '[data-testid="agent-teams-strip"]'
const MEMBER_CARD = `[data-testid="agent-teams-canvas-member-${MEMBER_AGENT_ID}"]`
/**
 * The lead session stays mounted (inert) under the member tab, so the plain
 * `[data-composer-editor]` selector matches two editors and the CLI's strict
 * locator refuses to pick one. The lead lives in `[data-testid="session-tab-panel"]`
 * and the active member page renders beside it, so excluding that subtree names
 * exactly the member composer.
 */
const MEMBER_COMPOSER = `[data-composer-editor]:not([data-testid="session-tab-panel"] [data-composer-editor])`
const MEMBER_SEND = `button[aria-label="${SEND_LABEL}"]:not([data-testid="session-tab-panel"] button[aria-label="${SEND_LABEL}"])`

/** S3.3 surfaces, all rendered by the product's own task drawer. */
const TASK_DETAIL = '[data-testid="agent-teams-task-detail"]'
const DELIVERY_PANEL = '[data-testid="agent-teams-task-delivery"]'
const DELIVERY_DISABLED = '[data-testid="agent-teams-delivery-disabled"]'
const DELIVERY_UNSUPPORTED = '[data-testid="agent-teams-delivery-unsupported"]'
const taskCard = (taskId: string) => `[data-testid="agent-teams-canvas-task-${taskId}"]`
const memberCard = (agentId: string) => `[data-testid="agent-teams-canvas-member-${agentId}"]`
const MEMBER_PAGE_BACK_NAME = 'Back to team overview'

/**
 * Locale-pinned delivery labels. The lane pins `cc-haha-locale` to `en` before
 * every reload, so these are the exact strings the panel renders.
 */
const DELIVERY_LABELS = {
  accept: 'Accept',
  return: 'Return',
  submitReturn: 'Return this version',
  cancel: 'Cancel',
  reasonRequired: 'A reason is required to return this version.',
  awaitingReview: 'Awaiting review',
  accepted: 'Accepted',
  returned: 'Returned',
  archived: 'This archived snapshot cannot be reviewed.',
  unsupported: 'Delivery history is unsupported or damaged; this task is read-only.',
  emptyHistory: 'No artifact has been submitted for review.',
  notStarted: 'Not started · starts on demand',
} as const

/**
 * A team page in the real product always has the lead's own turn behind it. A
 * zero-message session renders the new-session hero instead of the chat header,
 * and the hero deliberately has no team strip, so the fixture records one
 * ordinary lead exchange before the browser opens.
 */
const LEAD_SEED_PROMPT = 'prepare the team smoke'
const LEAD_SEED_REPLY = 'Team is ready.'

const FIRST_TEXT = 'please review the patch'
const REPEATED_TEXT = 'same text twice'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>

type ConversationProbe = {
  found: boolean
  keys: string[]
  /** Bubbles keyed by a client send id: still waiting for the durable echo. */
  pending: number
  /** Bubbles keyed by an `echo-<send id>` transcript row: settled by identity. */
  settled: number
  text: string
}

/**
 * What the artifact review panel actually rendered. `buttons` is the panel's own
 * action set, so an archived or already-reviewed version must render none.
 * `detailButtons` is every button in the drawer, so "no accept/return" cannot be
 * satisfied by rendering the actions outside the section.
 */
type DeliveryProbe = {
  found: boolean
  taskId: string | null
  hasSection: boolean
  panelText: string
  versions: Array<{ version: number; text: string }>
  buttons: string[]
  detailButtons: string[]
  disabledReason: string | null
  hasUnsupported: boolean
  unsupportedText: string
  hasReasonField: boolean
  reasonValue: string
  alert: string | null
}

type TaskRecord = {
  status?: string
  delivery?: {
    revision?: number
    submissions?: Array<{
      version?: number
      artifact?: string
      criteria?: string
      owner?: string
      review?: { decision?: string; reviewer?: string; reason?: string }
    }>
    receipts?: Array<{ requestId?: string }>
    notices?: Array<{ recipient?: string; delivered?: boolean }>
  }
}


function parseJsonOutput(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // agent-browser may prefix the value with a check mark on some commands.
    const start = trimmed.indexOf('{')
    if (start < 0) return undefined
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      return undefined
    }
  }
}

async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`)
}

/**
 * Runs production task/delivery code against the sandbox config dir.
 *
 * The fixture seeds and re-submits inside the same throwaway HOME the server
 * uses, so the product's own `applyTaskDeliveryAction` writes the delivery
 * record. It is never re-implemented here: the submit that produces v2 has to
 * hit the same validation, revision and receipt rules the browser's review then
 * reads back. The environment is restored afterwards so the browser and server
 * child processes keep the env they were spawned with.
 */
async function withSandboxEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The on-disk task record the server serves to the workbench snapshot. */
function taskRecordPath(configDir: string, teamName: string, taskId: string) {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-')
  return join(configDir, 'tasks', sanitize(teamName), `${sanitize(taskId)}.json`)
}

/**
 * Creates a synthetic task and submits its first artifact version as the owner.
 * Uses the production task store and delivery protocol, so the record the
 * browser later reviews is the one the product would have written.
 */
async function seedTaskWithDelivery(options: {
  env: Record<string, string>
  teamName: string
  owner: string
  subject: string
  description: string
  artifact: string
  criteria: string
  requestId: string
}): Promise<{ taskListId: string; taskId: string; revision: number }> {
  return withSandboxEnv(options.env, async () => {
    const tasks = await import('../../../../src/utils/tasks')
    const delivery = await import('../../../../src/utils/taskDelivery')
    const taskListId = tasks.getCanonicalTeamTaskListId(options.teamName)
    const taskId = await tasks.createTask(taskListId, {
      subject: options.subject,
      description: options.description,
      owner: options.owner,
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })
    const submitted = await delivery.applyTaskDeliveryAction(options.teamName, taskId, options.owner, {
      action: 'submit',
      requestId: options.requestId,
      expectedRevision: 0,
      version: 1,
      artifact: options.artifact,
      criteria: options.criteria,
    })
    return { taskListId, taskId, revision: submitted.task.delivery?.revision ?? 0 }
  })
}

/**
 * The owner publishing a new version outside the UI. The browser drives the
 * user's side of the protocol only; a teammate's submit never comes from a
 * click, so this is the one step that has to call the production action
 * directly instead of pretending the user did it.
 */
async function submitNextDeliveryVersion(options: {
  env: Record<string, string>
  teamName: string
  taskId: string
  owner: string
  expectedRevision: number
  version: number
  artifact: string
  criteria: string
  requestId: string
}): Promise<number> {
  return withSandboxEnv(options.env, async () => {
    const { applyTaskDeliveryAction } = await import('../../../../src/utils/taskDelivery')
    const result = await applyTaskDeliveryAction(options.teamName, options.taskId, options.owner, {
      action: 'submit',
      requestId: options.requestId,
      expectedRevision: options.expectedRevision,
      version: options.version,
      artifact: options.artifact,
      criteria: options.criteria,
    })
    return result.task.delivery?.revision ?? -1
  })
}

/**
 * Seeds a task whose delivery record the running server cannot interpret, the
 * way a record written by a newer release arrives: a real task in the team's
 * task box, a `delivery` schema this server does not know, and a marker that
 * must never surface. No production action can produce this record, so the
 * `delivery` field is replaced by hand after the production task store has
 * created the task -- everything else about the file is what the product wrote.
 *
 * The returned bytes and mtime are the baseline the lane re-checks after the
 * browser has opened and reloaded the drawer: reading an unreadable history must
 * not rewrite it.
 */
async function seedUnsupportedDeliveryTask(options: {
  env: Record<string, string>
  configDir: string
  teamName: string
  owner: string
  subject: string
  description: string
}): Promise<{ taskId: string; path: string; error: string; bytes: string; mtimeMs: number }> {
  return withSandboxEnv(options.env, async () => {
    const tasks = await import('../../../../src/utils/tasks')
    const { TASK_DELIVERY_UNSUPPORTED_ERROR } = await import('../../../../src/shared/taskDelivery')
    const taskListId = tasks.getCanonicalTeamTaskListId(options.teamName)
    const taskId = await tasks.createTask(taskListId, {
      subject: options.subject,
      description: options.description,
      owner: options.owner,
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })
    const path = taskRecordPath(options.configDir, options.teamName, taskId)
    if (!existsSync(path)) {
      throw new Error(`the production task store did not write ${path}`)
    }
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const bytes = JSON.stringify({
      ...current,
      delivery: {
        // A newer schema, with a whole history behind it that this server must
        // refuse to guess at.
        schemaVersion: 99,
        revision: 7,
        futureField: UNSUPPORTED_RAW_MARKER,
        submissions: [{
          version: 1,
          artifact: UNSUPPORTED_HIDDEN_ARTIFACT,
          criteria: 'legacy criteria from a newer release',
          owner: options.owner,
          submittedAt: 1,
        }],
        receipts: [],
        notices: [],
      },
    }, null, 2) + '\n'
    writeFileSync(path, bytes)
    return { taskId, path, error: TASK_DELIVERY_UNSUPPORTED_ERROR, bytes, mtimeMs: statSync(path).mtimeMs }
  })
}

/**
 * Reads the rendered task drawer: version history, action set, disabled state,
 * and whether the panel stated an unreadable history instead of rendering one.
 */
function deliveryProbeExpression() {
  return `(() => {
    const panel = document.querySelector(${JSON.stringify(TASK_DETAIL)})
    if (!panel) return { found: false }
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const section = panel.querySelector(${JSON.stringify(DELIVERY_PANEL)})
    const versions = [...panel.querySelectorAll('[data-testid^="agent-teams-delivery-version-"]')].map((node) => ({
      version: Number((node.getAttribute('data-testid') || '').replace('agent-teams-delivery-version-', '')),
      text: normalize(node.innerText),
    }))
    const buttons = section ? [...section.querySelectorAll('button')].map((node) => normalize(node.innerText)) : []
    const detailButtons = [...panel.querySelectorAll('button')].map((node) => (
      normalize(node.getAttribute('aria-label') || node.innerText)
    ))
    const disabled = section ? section.querySelector(${JSON.stringify(DELIVERY_DISABLED)}) : null
    const unsupported = section ? section.querySelector(${JSON.stringify(DELIVERY_UNSUPPORTED)}) : null
    const textarea = section ? section.querySelector('textarea') : null
    const alert = section ? section.querySelector('[role="alert"]') : null
    return {
      found: true,
      taskId: panel.getAttribute('data-task-id'),
      hasSection: Boolean(section),
      panelText: normalize(panel.innerText),
      versions,
      buttons,
      detailButtons,
      disabledReason: disabled ? disabled.getAttribute('data-disabled-reason') : null,
      hasUnsupported: Boolean(unsupported),
      unsupportedText: unsupported ? normalize(unsupported.textContent) : '',
      hasReasonField: Boolean(textarea),
      reasonValue: textarea ? textarea.value : '',
      alert: alert ? normalize(alert.textContent) : null,
    }
  })()`
}

/**
 * Substring evidence for "the raw record never reached the page". The markers
 * exist only inside the damaged task file, so any hit means the desktop rendered
 * or embedded something it was never sent.
 */
function leakProbeExpression(markers: string[]) {
  return `(() => {
    const html = document.documentElement.outerHTML
    const text = (document.body && document.body.innerText) || ''
    const found = ${JSON.stringify(markers)}.filter((marker) => html.includes(marker) || text.includes(marker))
    return { found, htmlLength: html.length, textLength: text.length }
  })()`
}

/**
 * The panel's buttons carry no test ids, so they are named the way a screen
 * reader names them: the exact accessible name inside the delivery section.
 * The CLI's XPath support is advertised but does not resolve, so the semantic
 * role locator is what actually finds a labelled button.
 */
function deliveryButtonArgs(label: string) {
  return ['find', 'role', 'button', 'click', '--name', label, '--exact']
}

const deliveryReasonFieldSelector = `${DELIVERY_PANEL} textarea`

function seedProvider(configDir: string) {
  const dir = join(configDir, 'cc-haha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({
    activeId: SMOKE_PROVIDER_ID,
    providers: [{
      id: SMOKE_PROVIDER_ID,
      presetId: 'custom',
      name: 'Team member smoke (isolated)',
      apiKey: 'team-member-smoke-fake-key',
      // Closed port: any provider call fails immediately instead of reaching out.
      baseUrl: 'http://127.0.0.1:1',
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: { main: SMOKE_MODEL_ID, haiku: SMOKE_MODEL_ID, sonnet: SMOKE_MODEL_ID, opus: SMOKE_MODEL_ID },
    }],
    providerOrder: [SMOKE_PROVIDER_ID],
  }, null, 2) + '\n')
}

export function conversationProbeExpression() {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(MEMBER_CONVERSATION)})
    if (!root) return { found: false, keys: [], pending: 0, settled: 0, text: '' }
    const keys = [...root.querySelectorAll('[data-chat-render-item-key]')]
      .map(node => node.getAttribute('data-chat-render-item-key') || '')
      .filter(Boolean)
    return {
      found: true,
      keys,
      pending: keys.filter(key => key.startsWith('msg-')).length,
      settled: keys.filter(key => key.startsWith('echo-msg-')).length,
      text: root.innerText || '',
    }
  })()`
}

async function main() {
  const rootDir = process.env.E2E_TEAM_MEMBER_ROOT ? resolve(process.env.E2E_TEAM_MEMBER_ROOT) : ROOT
  const artifactDir = process.argv.includes('--artifact-dir')
    ? resolve(String(process.argv[process.argv.indexOf('--artifact-dir') + 1]))
    : join(rootDir, 'artifacts', 'e2e-team-member')
  mkdirSync(artifactDir, { recursive: true })

  if (!resolveDesktopViteExecutable(rootDir)) {
    throw new Error('desktop Vite executable is missing; install desktop dependencies first')
  }
  if (!resolveAgentBrowserExecutable()) {
    throw new Error('agent-browser is not installed; see desktop/scripts/e2e-*-agent-browser.sh')
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'e2e-team-member-'))
  const holdEchoPath = join(workRoot, 'hold-echo')
  const holdReplyPath = join(workRoot, 'hold-reply')
  const browserProfileDir = join(workRoot, 'browser-profile')
  // The session list derives the workspace path by decoding the transcript's
  // project directory name, which encodes `/` as `-`. A workDir containing a
  // literal `-` therefore decodes to a different path and the session silently
  // disappears from `/api/sessions` (and with it the sidebar and tab restore).
  // The smoke needs the session to be listable, so its workspace is dash-free.
  const tmpRoot = process.platform === 'win32'
    ? tmpdir()
    : (tmpdir().includes('-') ? '/tmp' : tmpdir())
  const projectDir = join(tmpRoot, `teamsmoke${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(projectDir, { recursive: true })
  // The archived-team scenario needs a lead session of its own: the team has no
  // teammates left, so it cannot share the member team's roster.
  const archivedProjectDir = join(tmpRoot, `teamsmokearchive${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(archivedProjectDir, { recursive: true })

  const serverLogPath = join(artifactDir, 'server.log')
  const viteLogPath = join(artifactDir, 'vite.log')
  const browserLogPath = join(artifactDir, 'browser.log')
  const observationPath = join(artifactDir, 'dom-observations.jsonl')
  rmSync(observationPath, { force: true })
  rmSync(serverLogPath, { force: true })
  rmSync(viteLogPath, { force: true })
  rmSync(browserLogPath, { force: true })

  const sandbox = createQualityGateSandbox({
    label: 'e2e-team-member',
    seedProviders: false,
    envOverrides: { CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1' },
  })
  seedProvider(sandbox.configDir)

  const serverPort = await getPort()
  const vitePort = await getPort()
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const appUrl = `http://localhost:${vitePort}`
  const sessionName = `e2e-team-member-${serverPort}-${vitePort}`
  const browserEnv = buildDesktopSmokeBrowserEnv(sessionName, browserProfileDir)

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const browserStep: BrowserStep = (args, options = {}) => runLoggedCommand(agentBrowserCommand(args), {
    cwd: rootDir,
    env: browserEnv,
    logPath: browserLogPath,
    timeoutMs: options.timeoutMs ?? 30_000,
    allowFailure: options.allowFailure,
    maxLogChars: 6_000,
  })

  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(serverPort)], {
    cwd: rootDir,
    env: { ...sandbox.env, SERVER_PORT: String(serverPort) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void pipeToFile(server.stdout, serverLogPath)
  void pipeToFile(server.stderr, serverLogPath)

  const viteExecutable = resolveDesktopViteExecutable(rootDir)!
  const vite = Bun.spawn([viteExecutable, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: join(rootDir, 'desktop'),
    env: { ...process.env, VITE_DESKTOP_SERVER_URL: baseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void pipeToFile(vite.stdout, viteLogPath)
  void pipeToFile(vite.stderr, viteLogPath)

  const observations: Array<Record<string, unknown>> = []
  const record = (phase: string, payload: Record<string, unknown>) => {
    const entry = { at: new Date().toISOString(), runId, phase, ...payload }
    observations.push(entry)
    appendFileSync(observationPath, JSON.stringify(entry) + '\n')
  }
  const fail = (message: string): never => {
    record('failure', { message })
    throw new Error(message)
  }

  const browserEval = async (expression: string) => {
    const result = await browserStep(['eval', expression], { timeoutMs: 20_000 })
    return parseJsonOutput(`${result.stdout}${result.stderr}`)
  }
  const probe = async (): Promise<ConversationProbe> => {
    const value = await browserEval(conversationProbeExpression()) as Partial<ConversationProbe> | undefined
    return {
      found: value?.found === true,
      keys: Array.isArray(value?.keys) ? value!.keys!.map(String) : [],
      pending: Number(value?.pending ?? 0),
      settled: Number(value?.settled ?? 0),
      text: typeof value?.text === 'string' ? value.text : '',
    }
  }
  const readInbox = (): Array<{ id?: string; from?: string; text?: string }> => {
    const path = join(sandbox.configDir, 'teams', TEAM_NAME, 'inboxes', `${MEMBER_NAME}.json`)
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const screenshot = (name: string) => browserStep(['screenshot', join(artifactDir, name)], { allowFailure: true })
  const conversationText = async () => {
    const value = await browserStep(['get', 'text', MEMBER_CONVERSATION], { timeoutMs: 15_000, allowFailure: true })
    return `${value.stdout}${value.stderr}`
  }
  /**
   * What the page actually looked like when a step timed out. The wait-based
   * steps fail without saying which surface rendered instead, and "no strip"
   * has three very different causes (empty hero, no team discovered, tab not
   * restored), so the lane records the counts that tell them apart.
   */
  const domSnapshot = async () => browserEval(`(() => {
    const count = (selector) => document.querySelectorAll(selector).length
    return {
      text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 1500),
      strip: count(${JSON.stringify(TEAM_STRIP)}),
      composer: count('[data-composer-editor]'),
      memberComposer: count(${JSON.stringify(MEMBER_COMPOSER)}),
      memberConversation: count(${JSON.stringify(MEMBER_CONVERSATION)}),
      emptyHero: count('[data-testid="empty-session-hero"]'),
      sessionPanels: count('[data-testid="session-tab-panel"]'),
    }
  })()`)
  const editorIsEmpty = async () => {
    const value = await browserEval(`(() => {
      const editor = document.querySelector(${JSON.stringify(MEMBER_COMPOSER)})
      return { text: (editor?.textContent ?? '').trim() }
    })()`) as { text?: string } | undefined
    return (value?.text ?? '') === ''
  }

  const sendToMember = async (text: string) => {
    if (!await editorIsEmpty()) fail(`the member composer was not empty before sending "${text}"`)
    await browserStep(['type', MEMBER_COMPOSER, text], { timeoutMs: 20_000 })
    await browserStep(['click', MEMBER_SEND], { timeoutMs: 20_000 })
    // The server appends the envelope; the bubble is keyed by its id, so the
    // assertion below is what proves the id round trip.
    const inbox = await poll(async () => readInbox(), entries => entries.some(entry => entry.text === text),
      `the mailbox envelope for "${text}"`)
    return inbox
  }

  const openMemberTab = async (): Promise<'workbench-ui' | 'store-fallback'> => {
    // Real click chain: session header strip -> workbench -> member card ->
    // inspector's "View <name> execution".
    try {
      await browserStep(['wait', TEAM_STRIP], { timeoutMs: 25_000 })
      await browserStep(['click', TEAM_STRIP], { timeoutMs: 15_000 })
      await browserStep(['wait', MEMBER_CARD], { timeoutMs: 25_000 })
      await browserStep(['click', MEMBER_CARD], { timeoutMs: 15_000 })
      // The CLI has no `:has-text` pseudo-class; its semantic locator is the
      // documented way to click a button by accessible name.
      await browserStep(
        ['find', 'role', 'button', 'click', '--name', `View ${MEMBER_NAME} execution`],
        { timeoutMs: 20_000 },
      )
      record('entry', { path: 'workbench-ui' })
      return 'workbench-ui'
    } catch (error) {
      record('entry', {
        path: 'store-fallback',
        reason: error instanceof Error ? error.message : String(error),
        dom: await domSnapshot().catch(() => null),
      })
      return 'store-fallback'
    }
  }

  /**
   * Seeds the tab and locale state the app restores from. Both the canonical
   * `ccmax-*` key and the legacy `cc-haha-*` key are written: the app reads
   * canonical-first, and it writes the canonical key itself as soon as any tab
   * changes, so a legacy-only write is silently outranked after the first step.
   */
  const bootstrap = (leadSessionId: string) => {
    const tabs = JSON.stringify({
      openTabs: [{ sessionId: leadSessionId, title: 'Team Member Smoke', type: 'session' }],
      activeTabId: leadSessionId,
    })
    return [
      `localStorage.setItem('ccmax-locale', ${JSON.stringify(LOCALE)})`,
      `localStorage.setItem('cc-haha-locale', ${JSON.stringify(LOCALE)})`,
      `localStorage.setItem('ccmax-open-tabs', ${JSON.stringify(tabs)})`,
      `localStorage.setItem('cc-haha-open-tabs', ${JSON.stringify(tabs)})`,
      `localStorage.removeItem('ccmax-session-runtime')`,
      `localStorage.removeItem('cc-haha-session-runtime')`,
    ].join(';')
  }

  const deliveryProbe = async (): Promise<DeliveryProbe> => {
    const value = await browserEval(deliveryProbeExpression()) as Partial<DeliveryProbe> | undefined
    return {
      found: value?.found === true,
      taskId: typeof value?.taskId === 'string' ? value.taskId : null,
      hasSection: value?.hasSection === true,
      panelText: typeof value?.panelText === 'string' ? value.panelText : '',
      versions: Array.isArray(value?.versions)
        ? value!.versions!.map(entry => ({ version: Number(entry.version), text: String(entry.text) }))
        : [],
      buttons: Array.isArray(value?.buttons) ? value!.buttons!.map(String) : [],
      detailButtons: Array.isArray(value?.detailButtons) ? value!.detailButtons!.map(String) : [],
      disabledReason: typeof value?.disabledReason === 'string' ? value.disabledReason : null,
      hasUnsupported: value?.hasUnsupported === true,
      unsupportedText: typeof value?.unsupportedText === 'string' ? value.unsupportedText : '',
      hasReasonField: value?.hasReasonField === true,
      reasonValue: typeof value?.reasonValue === 'string' ? value.reasonValue : '',
      alert: typeof value?.alert === 'string' ? value.alert : null,
    }
  }
  const leakProbe = async (markers: string[]) => {
    const value = await browserEval(leakProbeExpression(markers)) as { found?: unknown } | undefined
    return Array.isArray(value?.found) ? value!.found!.map(String) : ['unreadable-probe']
  }

  /**
   * Puts the board on screen through the real entry points, and only the board
   * that belongs to `teamName`.
   *
   * After a reload the persisted tabs decide what is showing: the app may
   * briefly render another session while `restoreTabs` resolves, and the member
   * page covers the lead session (its sticky header swallows clicks aimed at the
   * team strip). So the member page's own back button is the first route, and
   * the team strip is clicked only once its `title` names this team — otherwise
   * a stale session's strip would open the wrong workbench.
   */
  const openWorkbenchFor = async (leadSessionId: string, teamName: string) => {
    const workbenchViewport = '[data-testid="agent-teams-office-viewport"]'
    const teamStrip = `${TEAM_STRIP}[title="${teamName}"]`
    const has = (selector: string) => browserEval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    const clickStrip = async () => {
      await browserStep(['wait', teamStrip], { timeoutMs: 25_000 })
      await browserStep(['click', teamStrip], { timeoutMs: 20_000 })
    }
    if (await has(workbenchViewport) === true) {
      record('workbench-entry', { via: 'already-open' })
      return
    }
    const attempts: Array<{ label: string; run: () => Promise<unknown> }> = []
    if (await has(MEMBER_CONVERSATION) === true) {
      attempts.push({
        label: 'member-back',
        run: () => browserStep(
          ['find', 'role', 'button', 'click', '--name', MEMBER_PAGE_BACK_NAME, '--exact'],
          { timeoutMs: 20_000 },
        ),
      })
    }
    attempts.push({ label: 'lead-session-strip', run: clickStrip })
    attempts.push({
      label: 'reload-lead-session',
      run: async () => {
        await browserStep(['eval', bootstrap(leadSessionId)], { timeoutMs: 15_000 })
        await browserStep(['reload'], { timeoutMs: 30_000 })
        await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], { timeoutMs: 30_000 })
        await clickStrip()
      },
    })
    for (const attempt of attempts) {
      await attempt.run().catch((error: unknown) => {
        record('workbench-entry-attempt', {
          via: attempt.label,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      const opened = await poll(
        async () => has(workbenchViewport),
        value => value === true,
        `the workbench after ${attempt.label}`,
        15_000,
      ).catch(() => false)
      if (opened === true) {
        record('workbench-entry', { via: attempt.label })
        return
      }
    }
    const strips = await browserEval(`(() => ({
      strips: [...document.querySelectorAll(${JSON.stringify(TEAM_STRIP)})].map((node) => ({
        title: node.getAttribute('title'),
        visible: Boolean(node.offsetParent),
      })),
      url: location.href,
      text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
    }))()`)
    record('workbench-entry-failure', { teamName, strips })
    fail(`the workbench for team "${teamName}" could not be opened from the current tab`)
  }

  /** Opens one task card and waits for the drawer's review panel to render. */
  const selectTask = async (id: string) => {
    await browserStep(['wait', taskCard(id)], { timeoutMs: 30_000 })
    await browserStep(['click', taskCard(id)], { timeoutMs: 20_000 })
    await browserStep(['wait', `${TASK_DETAIL}[data-task-id="${id}"]`], { timeoutMs: 25_000 })
    return poll(deliveryProbe, value => value.found && value.hasSection, `the review panel for task ${id}`)
  }

  const clickDeliveryButton = async (label: string) => {
    await browserStep(deliveryButtonArgs(label), { timeoutMs: 20_000 })
  }

  /**
   * The version list scrolls independently, so a two-version history would be
   * cut off in the screenshot even though the assertions read it in full.
   */
  const scrollDeliveryHistory = async () => browserEval(`(() => {
    const list = document.querySelector(${JSON.stringify(`${TASK_DETAIL} ${DELIVERY_PANEL} ol`)})
    if (!list) return false
    list.scrollTop = list.scrollHeight
    return true
  })()`)

  try {
    await waitForHttp(`${baseUrl}/health`, 60_000)
    await waitForHttp(appUrl, 90_000)

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    if (!created.ok) throw new Error(`POST /api/sessions failed: ${created.status} ${await created.text()}`)
    const lead = await created.json() as { sessionId: string }

    // The team is seeded the way a completed approval leaves it: a roster with a
    // member that has its own session id, and an inbox the server writes into.
    const teamDir = join(sandbox.configDir, 'teams', TEAM_NAME)
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true })
    const createdAt = Date.now()
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify({
      name: TEAM_NAME,
      createdAt,
      leadSessionId: lead.sessionId,
      leadAgentId: LEAD_AGENT_ID,
      reviewRequired: false,
      members: [
        { agentId: LEAD_AGENT_ID, name: 'team-lead', agentType: 'team-lead', joinedAt: createdAt, cwd: projectDir, tmuxPaneId: '', subscriptions: [] },
        {
          agentId: MEMBER_AGENT_ID,
          name: MEMBER_NAME,
          agentType: 'engineer',
          joinedAt: createdAt,
          cwd: projectDir,
          tmuxPaneId: '',
          subscriptions: [],
          sessionId: MEMBER_SESSION_ID,
          isActive: false,
        },
        {
          // Approved, given an address, never started: the board must render
          // this member as standby rather than as an idle process.
          agentId: PLANNER_AGENT_ID,
          name: PLANNER_NAME,
          agentType: 'engineer',
          joinedAt: createdAt,
          cwd: projectDir,
          tmuxPaneId: '',
          subscriptions: [],
          isActive: false,
          initialStartPending: true,
        },
      ],
    }, null, 2) + '\n')
    writeFileSync(join(teamDir, 'inboxes', `${MEMBER_NAME}.json`), '[]\n')

    // The member transcript must live in the project directory the server
    // created for the lead session. Any other directory decodes to a workspace
    // path that does not exist, which changes the sidebar's project-history
    // signature and makes `/api/sessions?view=sidebar` answer
    // PROJECT_HISTORY_CHANGED for the rest of the run.
    const projectsRoot = join(sandbox.configDir, 'projects')
    const projectDirName = readdirSync(projectsRoot).find(name => (
      existsSync(join(projectsRoot, name, `${lead.sessionId}.jsonl`))
    ))
    if (!projectDirName) {
      throw new Error(`the server did not create a project directory for session ${lead.sessionId}`)
    }
    // Give the lead one ordinary exchange first: a zero-message session renders
    // the new-session hero, and the hero has no chat header (so no team strip).
    const leadTranscriptPath = join(projectsRoot, projectDirName, `${lead.sessionId}.jsonl`)
    const seedTimestamp = new Date().toISOString()
    const seedUserUuid = `seed-user-${runId}`
    appendFileSync(leadTranscriptPath, [
      JSON.stringify({
        type: 'user',
        uuid: seedUserUuid,
        parentUuid: null,
        sessionId: lead.sessionId,
        isSidechain: false,
        cwd: projectDir,
        timestamp: seedTimestamp,
        userType: 'external',
        message: { role: 'user', content: [{ type: 'text', text: LEAD_SEED_PROMPT }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `seed-assistant-${runId}`,
        parentUuid: seedUserUuid,
        sessionId: lead.sessionId,
        isSidechain: false,
        cwd: projectDir,
        timestamp: seedTimestamp,
        message: {
          id: `msg_seed_${runId}`,
          type: 'message',
          role: 'assistant',
          model: 'mock-team-lead',
          content: [{ type: 'text', text: LEAD_SEED_REPLY }],
        },
      }),
    ].join('\n') + '\n')
    const transcriptPath = join(projectsRoot, projectDirName, `${MEMBER_SESSION_ID}.jsonl`)
    writeFileSync(transcriptPath, '')
    const memberJournalPath = join(artifactDir, 'mock-member.jsonl')
    rmSync(memberJournalPath, { force: true })

    record('setup', {
      baseUrl,
      appUrl,
      configDir: sandbox.configDir,
      projectDir,
      leadTranscript: leadTranscriptPath,
      memberTranscript: transcriptPath,
      inbox: join(teamDir, 'inboxes', `${MEMBER_NAME}.json`),
    })

    // ── S3.3 seed: one task whose artifact v1 is awaiting independent review ─
    // Written by the production task store and delivery protocol in the same
    // sandbox HOME the server reads, so the panel below reviews a real record.
    const seeded = await seedTaskWithDelivery({
      env: sandbox.env,
      teamName: TEAM_NAME,
      owner: MEMBER_NAME,
      subject: TASK_SUBJECT,
      description: TASK_DESCRIPTION,
      artifact: TASK_ARTIFACT_V1,
      criteria: TASK_CRITERIA_V1,
      requestId: `seed-submit-${runId}`,
    })
    const taskId = seeded.taskId
    const taskPath = taskRecordPath(sandbox.configDir, TEAM_NAME, taskId)
    const readTaskRecord = (): TaskRecord | null => {
      if (!existsSync(taskPath)) return null
      try {
        return JSON.parse(readFileSync(taskPath, 'utf8')) as TaskRecord
      } catch {
        return null
      }
    }
    const seededRecord = readTaskRecord()
    if (seededRecord?.delivery?.submissions?.[0]?.version !== 1) {
      fail(`the seeded task ${taskId} has no artifact v1: ${JSON.stringify(seededRecord)}`)
    }
    if (seededRecord.delivery.revision !== seeded.revision) {
      fail(`the seeded delivery revision ${seededRecord.delivery.revision} does not match the commit ${seeded.revision}`)
    }
    record('delivery-seed', { taskId, taskPath, revision: seeded.revision, record: seededRecord })

    // ── S3.3 seed: a task whose delivery record this server cannot interpret ─
    // A record from a newer release. The desktop must state the neutral reason
    // and offer nothing; the file must be left exactly as written.
    const unsupportedSeed = await seedUnsupportedDeliveryTask({
      env: sandbox.env,
      configDir: sandbox.configDir,
      teamName: TEAM_NAME,
      owner: MEMBER_NAME,
      subject: UNSUPPORTED_TASK_SUBJECT,
      description: UNSUPPORTED_TASK_DESCRIPTION,
    })
    if (!unsupportedSeed.bytes.includes(UNSUPPORTED_RAW_MARKER)) {
      fail('the seeded unsupported record does not carry its own marker')
    }
    const unsupportedWorkbench = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(TEAM_NAME)}/workbench`)
    if (!unsupportedWorkbench.ok) {
      throw new Error(`GET workbench failed: ${unsupportedWorkbench.status} ${await unsupportedWorkbench.text()}`)
    }
    const unsupportedBody = await unsupportedWorkbench.json() as {
      tasks?: Array<{ id?: string; deliveryError?: string; delivery?: { submissions?: unknown[] } }>
    }
    const projectedUnsupported = unsupportedBody.tasks?.find(candidate => candidate.id === unsupportedSeed.taskId)
    if (!projectedUnsupported) {
      fail(`the workbench does not carry the unsupported task ${unsupportedSeed.taskId}`)
    }
    if (projectedUnsupported.deliveryError !== unsupportedSeed.error) {
      fail(`the workbench projected deliveryError "${projectedUnsupported.deliveryError}"`)
    }
    if ((projectedUnsupported.delivery?.submissions ?? []).length !== 0) {
      fail('the workbench projected an unreadable history as submissions')
    }
    const projectedJson = JSON.stringify(unsupportedBody)
    for (const marker of [UNSUPPORTED_RAW_MARKER, UNSUPPORTED_HIDDEN_ARTIFACT]) {
      if (projectedJson.includes(marker)) fail(`the workbench response leaked "${marker}"`)
    }
    record('unsupported-seed', {
      taskId: unsupportedSeed.taskId,
      path: unsupportedSeed.path,
      deliveryError: projectedUnsupported.deliveryError,
      projectedTask: projectedUnsupported,
    })

    // ── S3.3 seed: a team that is already deleted, so its snapshot is archived
    // A second lead session owns it; the browser opens that session later and
    // must find the history read-only.
    const archivedCreated = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: archivedProjectDir }),
    })
    if (!archivedCreated.ok) {
      throw new Error(`POST /api/sessions (archived) failed: ${archivedCreated.status} ${await archivedCreated.text()}`)
    }
    const archivedLead = await archivedCreated.json() as { sessionId: string }
    const archivedTeamDir = join(sandbox.configDir, 'teams', ARCHIVE_TEAM_NAME)
    mkdirSync(join(archivedTeamDir, 'inboxes'), { recursive: true })
    const archivedCreatedAt = Date.now()
    writeFileSync(join(archivedTeamDir, 'config.json'), JSON.stringify({
      name: ARCHIVE_TEAM_NAME,
      createdAt: archivedCreatedAt,
      leadSessionId: archivedLead.sessionId,
      leadAgentId: `team-lead@${ARCHIVE_TEAM_NAME}`,
      reviewRequired: false,
      members: [{
        agentId: `team-lead@${ARCHIVE_TEAM_NAME}`,
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: archivedCreatedAt,
        cwd: archivedProjectDir,
        tmuxPaneId: '',
        subscriptions: [],
        // A deleted team is only allowed when the lead never ran and no
        // teammate remains registered.
        isActive: false,
      }],
    }, null, 2) + '\n')
    const archivedSeed = await seedTaskWithDelivery({
      env: sandbox.env,
      teamName: ARCHIVE_TEAM_NAME,
      owner: 'team-lead',
      subject: ARCHIVE_TASK_SUBJECT,
      description: 'This team is deleted before the browser opens it.',
      artifact: ARCHIVE_ARTIFACT,
      criteria: ARCHIVE_CRITERIA,
      requestId: `seed-archive-${runId}`,
    })
    const archivedProjectDirName = readdirSync(projectsRoot).find(name => (
      existsSync(join(projectsRoot, name, `${archivedLead.sessionId}.jsonl`))
    ))
    if (!archivedProjectDirName) {
      throw new Error(`the server did not create a project directory for session ${archivedLead.sessionId}`)
    }
    const archivedTranscriptPath = join(projectsRoot, archivedProjectDirName, `${archivedLead.sessionId}.jsonl`)
    appendFileSync(archivedTranscriptPath, [
      JSON.stringify({
        type: 'user',
        uuid: `archive-user-${runId}`,
        parentUuid: null,
        sessionId: archivedLead.sessionId,
        isSidechain: false,
        cwd: archivedProjectDir,
        timestamp: seedTimestamp,
        userType: 'external',
        message: { role: 'user', content: [{ type: 'text', text: LEAD_SEED_PROMPT }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `archive-assistant-${runId}`,
        parentUuid: `archive-user-${runId}`,
        sessionId: archivedLead.sessionId,
        isSidechain: false,
        cwd: archivedProjectDir,
        timestamp: seedTimestamp,
        message: {
          id: `msg_archive_${runId}`,
          type: 'message',
          role: 'assistant',
          model: 'mock-team-lead',
          content: [{ type: 'text', text: LEAD_SEED_REPLY }],
        },
      }),
    ].join('\n') + '\n')
    // Archive the snapshot first (getWorkbench does that), then delete the team
    // through the real API so the only remaining trace is the archive.
    const archivedWorkbench = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(ARCHIVE_TEAM_NAME)}/workbench`)
    if (!archivedWorkbench.ok) {
      throw new Error(`GET archived workbench failed: ${archivedWorkbench.status} ${await archivedWorkbench.text()}`)
    }
    const deleted = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(ARCHIVE_TEAM_NAME)}`, { method: 'DELETE' })
    if (!deleted.ok) {
      throw new Error(`DELETE ${ARCHIVE_TEAM_NAME} failed: ${deleted.status} ${await deleted.text()}`)
    }
    const archivedTimeline = await fetch(
      `${baseUrl}/api/teams/session/${encodeURIComponent(archivedLead.sessionId)}/workbench`,
    )
    if (!archivedTimeline.ok) {
      throw new Error(`GET archived timeline failed: ${archivedTimeline.status} ${await archivedTimeline.text()}`)
    }
    const archivedBody = await archivedTimeline.json() as {
      source?: string
      snapshots?: Array<{
        deletedAt?: string
        tasks?: Array<{ id: string; delivery?: { submissions?: Array<{ version?: number }> } }>
      }>
    }
    const archivedLatest = archivedBody.snapshots?.at(-1)
    if (!archivedLatest?.deletedAt) {
      fail(`the archived timeline did not mark the snapshot deleted: ${JSON.stringify(archivedBody).slice(0, 600)}`)
    }
    const archivedTask = archivedLatest.tasks?.find(task => task.id === archivedSeed.taskId)
    if (archivedTask?.delivery?.submissions?.at(0)?.version !== 1) {
      fail('the archived snapshot does not carry the awaiting-review artifact v1')
    }
    record('archive-seed', {
      teamName: ARCHIVE_TEAM_NAME,
      sessionId: archivedLead.sessionId,
      taskId: archivedSeed.taskId,
      source: archivedBody.source,
      deletedAt: archivedLatest.deletedAt,
    })

    // Scripted member runtime: poll the real mailbox file, append the row a
    // teammate CLI would append, then answer the turn before taking the next one.
    const seen = new Set<string>()
    const queue: Array<{ id: string; text: string }> = []
    let draining = false
    const appendRow = (row: Record<string, unknown>) => {
      appendFileSync(transcriptPath, JSON.stringify(row) + '\n')
      appendFileSync(memberJournalPath, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
    }
    const gate = async (path: string, label: string) => {
      if (!existsSync(path)) return
      record('gate', { holding: label })
      while (existsSync(path)) await Bun.sleep(150)
      record('gate', { released: label })
    }
    const drain = async () => {
      if (draining || queue.length === 0) return
      draining = true
      try {
        while (queue.length > 0) {
          await gate(holdEchoPath, 'echo')
          const item = queue.shift()!
          appendRow({
            type: 'user',
            uuid: `echo-${item.id}`,
            sessionId: MEMBER_SESSION_ID,
            message: {
              role: 'user',
              content: `<teammate-message teammate_id="user" id="${item.id}">${item.text}</teammate-message>`,
            },
            timestamp: new Date().toISOString(),
          })
          record('member', { echoed: item.id })
          await gate(holdReplyPath, 'reply')
          appendRow({
            type: 'assistant',
            uuid: `reply-${item.id}`,
            parentUuid: `echo-${item.id}`,
            sessionId: MEMBER_SESSION_ID,
            message: {
              role: 'assistant',
              model: 'mock-member',
              content: [{ type: 'text', text: `Ack: ${item.text}` }],
            },
            timestamp: new Date().toISOString(),
          })
          record('member', { replied: item.id })
        }
      } finally {
        draining = false
      }
    }
    const inboxTimer = setInterval(() => {
      for (const entry of readInbox()) {
        if (!entry.id || entry.from !== 'user' || seen.has(entry.id)) continue
        seen.add(entry.id)
        queue.push({ id: entry.id, text: entry.text ?? '' })
        record('member', { queued: entry.id })
      }
      void drain()
    }, 200)

    await browserStep(['open', appUrl], { timeoutMs: 30_000 })
    await browserStep(['eval', bootstrap(lead.sessionId)], { timeoutMs: 15_000 })
    await browserStep(['reload'], { timeoutMs: 30_000 })
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], { timeoutMs: 30_000 })

    const entryPath = await openMemberTab()
    if (entryPath === 'store-fallback') {
      fail('the member tab could not be opened through the workbench UI (see the recorded reason)')
    }
    await browserStep(['wait', MEMBER_CONVERSATION], { timeoutMs: 30_000 })
    await browserStep(['wait', MEMBER_COMPOSER], { timeoutMs: 30_000 })

    const empty = await probe()
    if (!empty.found) fail('the member conversation never rendered')
    if (empty.keys.length !== 0) fail(`a fresh member tab already had ${empty.keys.length} render items`)
    record('initial', { probe: empty })
    await screenshot('00-member-tab.png')

    // ── 1. pending bubble is keyed by the id that reaches the mailbox ────────
    writeFileSync(holdEchoPath, '')
    await sendToMember(FIRST_TEXT)
    const newEnvelope = readInbox().find(entry => entry.text === FIRST_TEXT)
    if (!newEnvelope?.id) fail('the mailbox envelope carried no id')
    if (newEnvelope.from !== 'user') fail(`the mailbox envelope sender was "${newEnvelope.from}"`)
    const mailboxId = newEnvelope.id
    const pending = await poll(probe, value => value.pending === 1, 'the pending interjection bubble')
    if (pending.keys.length !== 1) fail(`the pending send rendered ${pending.keys.length} items instead of 1`)
    if (pending.keys[0] !== mailboxId) {
      fail(`the pending bubble key "${pending.keys[0]}" is not the mailbox id "${mailboxId}"`)
    }
    if (!pending.text.includes(FIRST_TEXT)) fail('the pending bubble did not render the sent text')
    if (pending.text.includes('teammate-message')) fail('the pending bubble rendered the raw envelope markup')
    if (readFileSync(transcriptPath, 'utf8').trim() !== '') {
      fail('the member transcript changed before the echo gate was released')
    }
    record('pending', { mailboxId, probe: pending })
    await screenshot('01-pending-bubble.png')

    // ── 2. the durable echo settles that bubble by id, not by content ────────
    writeFileSync(holdReplyPath, '')
    rmSync(holdEchoPath, { force: true })
    const settled = await poll(probe, value => value.settled === 1 && value.pending === 0,
      'the echo to settle the pending bubble')
    if (settled.keys.length !== 1) fail(`settling added or removed bubbles: ${settled.keys.length} items`)
    if (settled.keys[0] !== `echo-${mailboxId}`) {
      fail(`the settled bubble key "${settled.keys[0]}" is not "echo-${mailboxId}"`)
    }
    if (!settled.text.includes(FIRST_TEXT)) fail('the settled bubble lost the sent text')
    const firstTextOccurrences = settled.text.split(FIRST_TEXT).length - 1
    if (firstTextOccurrences !== 1) {
      fail(`the settled send rendered ${firstTextOccurrences} times instead of once`)
    }
    record('settled', { probe: settled, expectedKey: `echo-${mailboxId}` })
    await screenshot('02-pending-settled.png')

    rmSync(holdReplyPath, { force: true })
    await poll(probe, value => value.keys.length === 2, 'the member reply to render')
    const replied = await probe()
    if (!replied.text.includes(`Ack: ${FIRST_TEXT}`)) fail('the member reply never rendered')
    record('reply', { probe: replied })

    // ── 3. two identical sends stay two sends ───────────────────────────────
    writeFileSync(holdEchoPath, '')
    const beforeRepeated = readInbox().length
    await sendToMember(REPEATED_TEXT)
    await sendToMember(REPEATED_TEXT)
    const repeatedEnvelopes = await poll(
      async () => readInbox().slice(beforeRepeated).filter(entry => entry.text === REPEATED_TEXT),
      entries => entries.length === 2,
      'both identical sends to reach the mailbox',
    )
    const repeatedIds = repeatedEnvelopes.map(entry => entry.id ?? '')
    if (repeatedIds[0] === repeatedIds[1]) {
      fail(`both identical sends reused the id "${repeatedIds[0]}"`)
    }
    const twinPending = await poll(probe, value => value.pending === 2, 'both pending bubbles')
    if (twinPending.pending !== 2) fail(`expected 2 pending bubbles, saw ${twinPending.pending}`)
    for (const id of repeatedIds) {
      if (!twinPending.keys.includes(id)) fail(`pending bubble "${id}" is missing from ${JSON.stringify(twinPending.keys)}`)
    }
    record('twin-pending', { ids: repeatedIds, probe: twinPending })
    await screenshot('03-two-pending-identical.png')

    rmSync(holdEchoPath, { force: true })
    const allSettled = await poll(
      probe,
      value => value.pending === 0 && value.keys.length === 6,
      'both identical sends to settle without merging',
      90_000,
    )
    for (const id of repeatedIds) {
      if (!allSettled.keys.includes(`echo-${id}`)) fail(`echo-${id} never rendered`)
    }
    const userBubbles = allSettled.keys.filter(key => key.startsWith('echo-msg-'))
    if (userBubbles.length !== 3) fail(`expected 3 settled user bubbles, saw ${userBubbles.length}`)
    const repeatedOccurrences = allSettled.text.split(REPEATED_TEXT).length - 1
    // Two sends and their two replies.
    if (repeatedOccurrences !== 4) {
      fail(`"${REPEATED_TEXT}" rendered ${repeatedOccurrences} times instead of 4 (two sends, two replies)`)
    }
    record('all-settled', { probe: allSettled, keys: allSettled.keys })
    await screenshot('04-two-settled.png')

    // ── 4. a full reload replays the same durable sequence ──────────────────
    const settledKeys = allSettled.keys
    await browserStep(['reload'], { timeoutMs: 30_000 })
    // tabs are persisted, so the reload may come back on the member tab. Only
    // walk the workbench a second time when it did not.
    const restored = await browserEval(`(() => Boolean(document.querySelector(${JSON.stringify(MEMBER_CONVERSATION)})))`)
    let reopenedVia: 'restored-tab' | 'workbench-ui' = 'restored-tab'
    if (restored !== true) {
      await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], { timeoutMs: 30_000 })
      reopenedVia = await openMemberTab()
      if (reopenedVia === 'store-fallback') {
        fail('the member tab could not be reopened through the workbench UI after reload')
      }
    }
    record('reload-entry', { path: reopenedVia })
    await browserStep(
      ['wait', `${MEMBER_CONVERSATION} [data-chat-render-item-key]`],
      { timeoutMs: 30_000 },
    )
    const replayed = await poll(probe, value => value.keys.length === settledKeys.length,
      'the reloaded member conversation to replay')
    if (replayed.pending !== 0) fail(`the reloaded conversation still shows ${replayed.pending} pending bubbles`)
    if (JSON.stringify(replayed.keys) !== JSON.stringify(settledKeys)) {
      fail(`replay order changed:\n before ${JSON.stringify(settledKeys)}\n after  ${JSON.stringify(replayed.keys)}`)
    }
    if (!replayed.text.includes(`Ack: ${REPEATED_TEXT}`)) fail('the reloaded conversation lost a member reply')
    record('reloaded', { probe: replayed })
    await screenshot('05-after-reload-replay.png')

    // ── 5. S3.3: the review panel drives the real delivery protocol ─────────
    await openWorkbenchFor(lead.sessionId, TEAM_NAME)
    await browserStep(['wait', taskCard(taskId)], { timeoutMs: 30_000 })
    const board = await browserEval(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim()
      const standby = document.querySelector(${JSON.stringify(memberCard(PLANNER_AGENT_ID))})
      const owner = document.querySelector(${JSON.stringify(memberCard(MEMBER_AGENT_ID))})
      return {
        standbyState: standby ? standby.getAttribute('data-member-state') : null,
        standbyText: standby ? normalize(standby.innerText) : '',
        ownerState: owner ? owner.getAttribute('data-member-state') : null,
      }
    })()`) as { standbyState?: string | null; standbyText?: string; ownerState?: string | null } | undefined
    if (board?.standbyState !== 'standby') {
      fail(`the initialStartPending member rendered "${board?.standbyState}" instead of "standby"`)
    }
    if (!(board.standbyText ?? '').includes(DELIVERY_LABELS.notStarted)) {
      fail(`the standby member did not render "${DELIVERY_LABELS.notStarted}": ${board?.standbyText}`)
    }
    if (board.ownerState === 'standby') fail('the owner with an artifact awaiting review was rendered as standby')
    record('standby-member', { probe: board })
    await screenshot('06-board-standby-member.png')

    // ── 5a. the seeded v1 renders as awaiting independent review ───────────
    const firstView = await selectTask(taskId)
    if (firstView.taskId !== taskId) fail(`the drawer opened task "${firstView.taskId}" instead of "${taskId}"`)
    if (firstView.versions.length !== 1) {
      fail(`expected one artifact version in the drawer, saw ${JSON.stringify(firstView.versions)}`)
    }
    const version1 = firstView.versions[0]!
    if (version1.version !== 1) fail(`the first version rendered as v${version1.version}`)
    for (const expected of [DELIVERY_LABELS.awaitingReview, TASK_ARTIFACT_V1, TASK_CRITERIA_V1, MEMBER_NAME]) {
      if (!version1.text.includes(expected)) {
        fail(`the v1 card is missing "${expected}": ${version1.text}`)
      }
    }
    if (JSON.stringify(firstView.buttons) !== JSON.stringify([DELIVERY_LABELS.accept, DELIVERY_LABELS.return])) {
      fail(`an awaiting v1 must offer accept+return, saw ${JSON.stringify(firstView.buttons)}`)
    }
    if (firstView.disabledReason !== null) fail(`a live snapshot reported disabled reason "${firstView.disabledReason}"`)
    record('delivery-v1-awaiting-review', { probe: firstView })
    await screenshot('07-delivery-v1-awaiting.png')

    // ── 5b. returning requires a reason, and nothing is committed without it ─
    await clickDeliveryButton(DELIVERY_LABELS.return)
    const form = await poll(deliveryProbe, value => value.hasReasonField, 'the return form')
    if (JSON.stringify(form.buttons) !== JSON.stringify([DELIVERY_LABELS.submitReturn, DELIVERY_LABELS.cancel])) {
      fail(`the return form offered ${JSON.stringify(form.buttons)}`)
    }
    if (form.reasonValue !== '') fail('the return form opened with a reason already filled in')
    const revisionBeforeRejection = readTaskRecord()?.delivery?.revision
    await clickDeliveryButton(DELIVERY_LABELS.submitReturn)
    const rejected = await poll(deliveryProbe, value => value.alert === DELIVERY_LABELS.reasonRequired,
      'the reason-required error')
    if (!rejected.hasReasonField) fail('the return form closed after rejecting the empty reason')
    await Bun.sleep(500)
    const afterRejection = readTaskRecord()
    if (afterRejection?.delivery?.revision !== revisionBeforeRejection) {
      fail(`the server committed a return without a reason (revision ${revisionBeforeRejection} -> ${afterRejection?.delivery?.revision})`)
    }
    if (afterRejection?.delivery?.submissions?.[0]?.review !== undefined) {
      fail('the v1 review was written even though the reason was empty')
    }
    if (rejected.versions[0]?.text.includes(DELIVERY_LABELS.returned)) {
      fail('the v1 card already claims it was returned before a reason was given')
    }
    record('delivery-reason-required', { probe: rejected, revision: revisionBeforeRejection })
    await screenshot('08-return-requires-reason.png')

    // ── 5c. a real reason commits the return ───────────────────────────────
    await browserStep(['type', deliveryReasonFieldSelector, TASK_RETURN_REASON], { timeoutMs: 20_000 })
    await clickDeliveryButton(DELIVERY_LABELS.submitReturn)
    const returned = await poll(
      deliveryProbe,
      value => value.versions.length === 1 && value.versions[0]!.text.includes(DELIVERY_LABELS.returned),
      'the returned v1 badge',
    )
    if (!returned.versions[0]!.text.includes(TASK_RETURN_REASON)) {
      fail(`the returned version lost its reason: ${returned.versions[0]!.text}`)
    }
    if (returned.buttons.length !== 0) {
      fail(`a reviewed version must not keep review actions, saw ${JSON.stringify(returned.buttons)}`)
    }
    const returnedRecord = await poll(
      async () => readTaskRecord(),
      value => value?.delivery?.submissions?.[0]?.review?.decision === 'return',
      'the server to commit the return',
    )
    const returnReview = returnedRecord!.delivery!.submissions![0]!.review!
    if (returnReview.reviewer !== 'user') fail(`the return was recorded for reviewer "${returnReview.reviewer}"`)
    if (returnReview.reason !== TASK_RETURN_REASON) fail(`the stored return reason is "${returnReview.reason}"`)
    if (returnedRecord!.status !== 'in_progress') {
      fail(`a returned task must stay in progress, saw "${returnedRecord!.status}"`)
    }
    const revisionAfterReturn = returnedRecord!.delivery!.revision!
    if (revisionAfterReturn !== (revisionBeforeRejection ?? 0) + 1) {
      fail(`the return did not advance the delivery revision (${revisionBeforeRejection} -> ${revisionAfterReturn})`)
    }
    record('delivery-returned', { probe: returned, revision: revisionAfterReturn, task: returnedRecord })
    await screenshot('09-delivery-v1-returned.png')

    // ── 5d. the owner publishes v2 through the production protocol ─────────
    // A teammate's submit is never a click in this UI, so the lane calls the
    // same `applyTaskDeliveryAction` the teammate's tool call would.
    const revisionAfterSubmit = await submitNextDeliveryVersion({
      env: sandbox.env,
      teamName: TEAM_NAME,
      taskId,
      owner: MEMBER_NAME,
      expectedRevision: revisionAfterReturn,
      version: 2,
      artifact: TASK_ARTIFACT_V2,
      criteria: TASK_CRITERIA_V2,
      requestId: `owner-submit-v2-${runId}`,
    })
    const submittedRecord = await poll(
      async () => readTaskRecord(),
      value => value?.delivery?.submissions?.length === 2,
      'the v2 submit to reach the task record',
    )
    const version2Record = submittedRecord!.delivery!.submissions![1]!
    if (version2Record.version !== 2) fail(`the owner submitted v${version2Record.version} instead of v2`)
    if (version2Record.owner !== MEMBER_NAME) fail(`v2 was submitted by "${version2Record.owner}"`)
    if (version2Record.review !== undefined) fail('the fresh v2 already carries a review')
    if (revisionAfterSubmit !== revisionAfterReturn + 1) {
      fail(`the v2 submit did not advance the revision (${revisionAfterReturn} -> ${revisionAfterSubmit})`)
    }
    record('owner-submit-v2', { revision: revisionAfterSubmit, submission: version2Record })

    await browserStep(['reload'], { timeoutMs: 30_000 })
    await openWorkbenchFor(lead.sessionId, TEAM_NAME)
    await selectTask(taskId)
    const afterOwnerSubmit = await poll(
      deliveryProbe,
      value => value.versions.length === 2 && value.versions[1]!.text.includes(DELIVERY_LABELS.awaitingReview),
      'v2 to render as awaiting review',
    )
    if (!afterOwnerSubmit.versions[0]!.text.includes(DELIVERY_LABELS.returned)) {
      fail('the reloaded history lost the earlier return decision')
    }
    if (!afterOwnerSubmit.versions[1]!.text.includes(TASK_ARTIFACT_V2)) {
      fail('the v2 card does not render the owner’s new artifact')
    }
    if (JSON.stringify(afterOwnerSubmit.buttons) !== JSON.stringify([DELIVERY_LABELS.accept, DELIVERY_LABELS.return])) {
      fail(`an awaiting v2 must offer accept+return, saw ${JSON.stringify(afterOwnerSubmit.buttons)}`)
    }
    record('delivery-v2-awaiting-review', { probe: afterOwnerSubmit })
    await scrollDeliveryHistory()
    await screenshot('10-delivery-v2-awaiting.png')

    // ── 5e. accepting v2 is the user's independent receipt ─────────────────
    await clickDeliveryButton(DELIVERY_LABELS.accept)
    const accepted = await poll(
      deliveryProbe,
      value => value.versions.length === 2 && value.versions[1]!.text.includes(DELIVERY_LABELS.accepted),
      'the accepted v2 badge',
    )
    if (accepted.buttons.length !== 0) {
      fail(`an accepted version must not keep review actions, saw ${JSON.stringify(accepted.buttons)}`)
    }
    const acceptedRecord = await poll(
      async () => readTaskRecord(),
      value => value?.delivery?.submissions?.[1]?.review?.decision === 'accept',
      'the server to commit the acceptance',
    )
    const acceptReview = acceptedRecord!.delivery!.submissions![1]!.review!
    if (acceptReview.reviewer !== 'user') fail(`the acceptance was recorded for reviewer "${acceptReview.reviewer}"`)
    if (acceptedRecord!.status !== 'completed') {
      fail(`an accepted task must be completed, saw "${acceptedRecord!.status}"`)
    }
    if (acceptedRecord!.delivery!.submissions![0]!.review?.reason !== TASK_RETURN_REASON) {
      fail('accepting v2 rewrote the earlier return reason')
    }
    const revisionAfterAccept = acceptedRecord!.delivery!.revision!
    if (revisionAfterAccept !== revisionAfterSubmit + 1) {
      fail(`the acceptance did not advance the revision (${revisionAfterSubmit} -> ${revisionAfterAccept})`)
    }
    record('delivery-accepted', { probe: accepted, revision: revisionAfterAccept, task: acceptedRecord })
    await scrollDeliveryHistory()
    await screenshot('11-delivery-v2-accepted.png')

    // ── 5f. the history survives a full reload ─────────────────────────────
    await browserStep(['reload'], { timeoutMs: 30_000 })
    await openWorkbenchFor(lead.sessionId, TEAM_NAME)
    await selectTask(taskId)
    const history = await poll(
      deliveryProbe,
      value => value.versions.length === 2 && value.versions[1]!.text.includes(DELIVERY_LABELS.accepted),
      'the reloaded delivery history',
    )
    if (!history.versions[0]!.text.includes(DELIVERY_LABELS.returned) || !history.versions[0]!.text.includes(TASK_RETURN_REASON)) {
      fail(`the reloaded v1 lost its return decision: ${history.versions[0]!.text}`)
    }
    if (!history.versions[1]!.text.includes(DELIVERY_LABELS.accepted) || !history.versions[1]!.text.includes(TASK_ARTIFACT_V2)) {
      fail(`the reloaded v2 lost its acceptance: ${history.versions[1]!.text}`)
    }
    if (history.buttons.length !== 0) fail(`the reloaded reviewed task still offers ${JSON.stringify(history.buttons)}`)
    record('delivery-history', { probe: history })
    await scrollDeliveryHistory()
    await screenshot('12-delivery-history-after-reload.png')

    // ── 5g. an unreadable delivery history is stated, never rendered ────────
    // A record from a newer release. The drawer must say why it is read-only,
    // offer no review action at all, never show the record, and leave the file
    // exactly as it was written.
    const unsupportedCard = taskCard(unsupportedSeed.taskId)
    const readUnsupportedRecord = () => ({
      bytes: readFileSync(unsupportedSeed.path, 'utf8'),
      mtimeMs: statSync(unsupportedSeed.path).mtimeMs,
    })
    // Reload first so no drawer is open over the board: the two task cards share
    // one canvas, and a drawer left open from step 5f could cover the other card.
    await browserStep(['reload'], { timeoutMs: 30_000 })
    await openWorkbenchFor(lead.sessionId, TEAM_NAME)
    await browserStep(['wait', unsupportedCard], { timeoutMs: 30_000 })
    await browserStep(['click', unsupportedCard], { timeoutMs: 20_000 })
    await browserStep(['wait', `${TASK_DETAIL}[data-task-id="${unsupportedSeed.taskId}"]`], { timeoutMs: 25_000 })
    await browserStep(['wait', DELIVERY_UNSUPPORTED], { timeoutMs: 25_000 })
    const unsupportedView = await poll(deliveryProbe, value => value.hasUnsupported,
      'the read-only notice for the unreadable history')
    if (unsupportedView.taskId !== unsupportedSeed.taskId) {
      fail(`the drawer opened task "${unsupportedView.taskId}" instead of "${unsupportedSeed.taskId}"`)
    }
    if (unsupportedView.unsupportedText !== DELIVERY_LABELS.unsupported) {
      fail(`the read-only reason read "${unsupportedView.unsupportedText}"`)
    }
    if (!unsupportedView.panelText.includes(UNSUPPORTED_TASK_SUBJECT)) {
      fail(`the drawer did not open the unreadable task: ${unsupportedView.panelText.slice(0, 300)}`)
    }
    if (unsupportedView.versions.length !== 0) {
      fail(`an unreadable history rendered ${unsupportedView.versions.length} versions`)
    }
    if (unsupportedView.buttons.length !== 0) {
      fail(`an unreadable history offered ${JSON.stringify(unsupportedView.buttons)}`)
    }
    for (const label of [DELIVERY_LABELS.accept, DELIVERY_LABELS.return, DELIVERY_LABELS.submitReturn]) {
      if (unsupportedView.detailButtons.includes(label)) {
        fail(`the drawer rendered a "${label}" action for an unreadable history`)
      }
    }
    if (unsupportedView.hasReasonField) fail('an unreadable history opened a return form')
    if (unsupportedView.disabledReason !== null) {
      fail(`an unreadable history reported the disabled reason "${unsupportedView.disabledReason}"`)
    }
    if (unsupportedView.panelText.includes(DELIVERY_LABELS.emptyHistory)) {
      fail('an unreadable history was rendered as a reviewable empty history')
    }
    const unsupportedLeaks = await leakProbe([UNSUPPORTED_RAW_MARKER, UNSUPPORTED_HIDDEN_ARTIFACT])
    if (unsupportedLeaks.length !== 0) {
      fail(`the page leaked the unreadable record: ${JSON.stringify(unsupportedLeaks)}`)
    }
    const afterOpen = readUnsupportedRecord()
    if (afterOpen.bytes !== unsupportedSeed.bytes) fail('opening the unreadable task rewrote its record on disk')
    if (afterOpen.mtimeMs !== unsupportedSeed.mtimeMs) {
      fail(`opening the unreadable task touched its record (mtime ${unsupportedSeed.mtimeMs} -> ${afterOpen.mtimeMs})`)
    }
    record('delivery-unsupported-read-only', {
      probe: unsupportedView,
      leaks: unsupportedLeaks,
      path: unsupportedSeed.path,
      mtimeMs: afterOpen.mtimeMs,
    })
    await screenshot('14-delivery-unsupported-read-only.png')

    // A reload re-reads the same file from disk: same notice, nothing offered,
    // and still byte- and mtime-identical.
    await browserStep(['reload'], { timeoutMs: 30_000 })
    await openWorkbenchFor(lead.sessionId, TEAM_NAME)
    await browserStep(['wait', unsupportedCard], { timeoutMs: 30_000 })
    await browserStep(['click', unsupportedCard], { timeoutMs: 20_000 })
    await browserStep(['wait', `${TASK_DETAIL}[data-task-id="${unsupportedSeed.taskId}"]`], { timeoutMs: 25_000 })
    await browserStep(['wait', DELIVERY_UNSUPPORTED], { timeoutMs: 25_000 })
    const reloadedUnsupported = await poll(deliveryProbe, value => value.hasUnsupported,
      'the read-only notice to survive a reload')
    if (reloadedUnsupported.unsupportedText !== DELIVERY_LABELS.unsupported) {
      fail(`the reloaded read-only reason read "${reloadedUnsupported.unsupportedText}"`)
    }
    if (reloadedUnsupported.versions.length !== 0 || reloadedUnsupported.buttons.length !== 0) {
      fail(`the reloaded unreadable history offered ${JSON.stringify({
        versions: reloadedUnsupported.versions,
        buttons: reloadedUnsupported.buttons,
      })}`)
    }
    const afterReloadOpen = readUnsupportedRecord()
    if (afterReloadOpen.bytes !== unsupportedSeed.bytes || afterReloadOpen.mtimeMs !== unsupportedSeed.mtimeMs) {
      fail(`reloading the unreadable task rewrote its record (mtime ${unsupportedSeed.mtimeMs} -> ${afterReloadOpen.mtimeMs})`)
    }
    const reloadedLeaks = await leakProbe([UNSUPPORTED_RAW_MARKER, UNSUPPORTED_HIDDEN_ARTIFACT])
    if (reloadedLeaks.length !== 0) {
      fail(`the reloaded page leaked the unreadable record: ${JSON.stringify(reloadedLeaks)}`)
    }
    record('delivery-unsupported-after-reload', {
      probe: reloadedUnsupported,
      leaks: reloadedLeaks,
      mtimeMs: afterReloadOpen.mtimeMs,
    })

    // ── 6. an archived snapshot shows its history read-only ────────────────
    await browserStep(['eval', bootstrap(archivedLead.sessionId)], { timeoutMs: 15_000 })
    await browserStep(['reload'], { timeoutMs: 30_000 })
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], { timeoutMs: 30_000 })
    await openWorkbenchFor(archivedLead.sessionId, ARCHIVE_TEAM_NAME)
    await selectTask(archivedSeed.taskId)
    const archivedView = await poll(deliveryProbe, value => value.disabledReason !== null,
      'the archived read-only notice')
    if (archivedView.disabledReason !== 'archived') {
      fail(`the deleted team rendered disabled reason "${archivedView.disabledReason}" instead of "archived"`)
    }
    if (archivedView.buttons.length !== 0) {
      fail(`an archived snapshot must not offer review actions, saw ${JSON.stringify(archivedView.buttons)}`)
    }
    if (!archivedView.panelText.includes(DELIVERY_LABELS.archived)) {
      fail(`the archived notice text is missing: ${archivedView.panelText.slice(0, 300)}`)
    }
    if (archivedView.versions.length !== 1 || !archivedView.versions[0]!.text.includes(DELIVERY_LABELS.awaitingReview)) {
      fail(`the archived snapshot lost its artifact history: ${JSON.stringify(archivedView.versions)}`)
    }
    record('archived-read-only', { probe: archivedView, sessionId: archivedLead.sessionId })
    await screenshot('13-archived-read-only.png')

    const summary = {
      result: 'passed',
      runId,
      entryPath: 'workbench-ui',
      desktopPath: `${appUrl} -> team member tab ([data-testid="team-member-conversation"]) and task drawer ([data-testid="agent-teams-task-delivery"])`,
      assertions: [
        'pending bubble key === mailbox envelope id',
        'durable echo settles that exact bubble (key becomes echo-<id>) without adding a bubble',
        'identical second/third sends get distinct ids and settle separately (3 user, 3 reply bubbles)',
        'full reload replays the same six render items in the same order with no pending left',
        'the seeded artifact v1 renders as awaiting review with accept+return and no disabled notice',
        'returning with an empty reason renders the reason-required error and commits nothing to the task record',
        'returning with a reason stores decision=return, reviewer=user and the exact reason, and keeps the task in progress',
        'the owner submitting v2 through applyTaskDeliveryAction renders as a second awaiting version after reload',
        'accepting v2 stores decision=accept, marks the task completed, keeps the v1 return reason, and clears the actions',
        'a full reload replays both versions with their decisions and the return reason',
        'a member seeded with initialStartPending renders standby with "Not started · starts on demand"',
        'a deleted team\'s archived snapshot renders its history with reason=archived and no review actions',
        'a task whose delivery schema this server cannot read renders the neutral read-only reason and no version history',
        'that task offers no accept/return action anywhere in the drawer and never opens a return form',
        'the unreadable record\'s raw payload appears in neither the workbench response nor the page',
        'opening and reloading the unreadable task leaves its on-disk record byte- and mtime-identical',
      ],
      ids: {
        first: mailboxId,
        repeated: repeatedIds,
        task: taskId,
        archivedTask: archivedSeed.taskId,
        unsupportedTask: unsupportedSeed.taskId,
      },
      revisions: {
        seeded: seeded.revision,
        returned: revisionAfterReturn,
        submitted: revisionAfterSubmit,
        accepted: revisionAfterAccept,
      },
      observations: observations.length,
    }
    writeFileSync(join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    clearInterval(inboxTimer)

    const guard = applyUserStateGuard({ status: 'passed' as const, error: undefined }, sandbox, artifactDir)
    if (guard.status !== 'passed') throw new Error(guard.error ?? 'real user state was modified')
    console.log(`[e2e-team-member] PASSED artifacts=${artifactDir}`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await screenshot('failure.png').catch(() => undefined)
    const dom = await domSnapshot().catch(() => null)
    record('failure-dom', { dom })
    writeFileSync(join(artifactDir, 'failure.json'), JSON.stringify({
      result: 'failed',
      runId,
      message,
      dom,
      observations,
    }, null, 2) + '\n')
    console.error(`[e2e-team-member] FAILED: ${message}`)
    console.error(`[e2e-team-member] artifacts=${artifactDir}`)
    return 1
  } finally {
    await browserStep(['close'], { timeoutMs: 10_000, allowFailure: true }).catch(() => undefined)
    await cleanupAgentBrowserSession(sessionName, browserLogPath)
    cleanupBrowserProfileProcesses(browserProfileDir, browserLogPath)
    await Promise.all([
      stopDesktopSmokeProcess(server, 'server', serverLogPath),
      stopDesktopSmokeProcess(vite, 'Vite', viteLogPath),
    ])
    sandbox.cleanup()
    removeDesktopSmokeTree(workRoot)
    removeDesktopSmokeTree(projectDir)
    removeDesktopSmokeTree(archivedProjectDir)
  }
}

const exitCode = await main()
process.exit(exitCode)