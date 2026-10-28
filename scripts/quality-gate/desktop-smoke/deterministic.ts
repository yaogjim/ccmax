import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runDesktopUiTeamPlanSmoke, TEAM_SMOKE_MODEL, TEAM_SMOKE_PROVIDER } from './team-plan'
import { buildMockToolPrompt } from '../agent-flow/scenarios'
import { applyUserStateGuard, createQualityGateSandbox } from '../sandbox'
import type { LaneResult } from '../types'
import {
  agentBrowserCommand,
  buildDesktopSmokeBrowserEnv,
  cleanupAgentBrowserSession,
  cleanupBrowserProfileProcesses,
  DESKTOP_SMOKE_COMPOSER_SELECTOR,
  DESKTOP_SMOKE_RUN_SELECTOR,
  desktopSmokeAppUrl,
  getPort,
  pipeToFile,
  resolveAgentBrowserExecutable,
  resolveDesktopViteExecutable,
  removeDesktopSmokeTree,
  runLoggedCommand,
  stopDesktopSmokeProcess,
  waitForHttp,
} from './execute'

/**
 * Deterministic desktop UI smoke.
 *
 * The existing agent-browser smoke needs a real provider and answers permissions by
 * flipping the *global* permission mode to bypassPermissions, so the approval UI —
 * the one screen where a wrong render lets a model touch files the user did not
 * agree to — was never exercised by any automated check. This lane drives the same
 * real UI against the repository's mock SDK CLI, so it runs with no provider, no
 * credentials, and no network, and it answers the permission request by clicking
 * the real button.
 */

const FIXTURE = 'scripts/quality-gate/agent-flow/fixtures/workspace'
const TARGET_FILE = 'ui-smoke-output.txt'
const TARGET_CONTENT = 'written-through-the-desktop-ui'
const SMOKE_PROVIDER_ID = 'desktop-ui-smoke-provider'
const SMOKE_MODEL_ID = 'desktop-ui-smoke-model'

/** Locale is pinned so the approval button label is stable across contributors. */
export const DESKTOP_UI_SMOKE_LOCALE = 'en'
export const DESKTOP_UI_SMOKE_ALLOW_SELECTOR = 'button[aria-label^="Allow: "]'

/** The tool the mock turn runs and the name the history is filtered by. */
export const DESKTOP_UI_SMOKE_TOOL_NAME = 'Write'
/** Assistant text the turn ends with; asserted in both history and the reloaded DOM. */
export const DESKTOP_UI_SMOKE_REPLY = `wrote ${TARGET_FILE}`

/**
 * How long to hold the reload after the *persisted* turn is confirmed on disk.
 *
 * This is a settle delay, not the race guard: completion is established by polling
 * `/messages` first (see `executeDeterministicDesktopSmoke`), so a request still in
 * flight can no longer be mistaken for an absent history. The delay only gives the
 * live socket a moment to stop touching the DOM before the page is reloaded.
 */
export const DESKTOP_UI_SMOKE_RELOAD_DELAY_MS = 2_500

/**
 * The tab of a session stopped on a decision only the user can make.
 * `data-attention` is set on the tab by TabBar; the strip is the only place it
 * appears, so the selector is anchored there.
 */
export const DESKTOP_UI_SMOKE_ATTENTION_TAB = '[data-testid="tab-bar"] [data-attention="true"]'

/**
 * True while that tab carries the warning mark and has *not* also been given the
 * running dot. A session parked on a permission card is "running" by chatState
 * too, and the running dot said the one thing that is not true of it.
 */
export const DESKTOP_UI_SMOKE_ATTENTION_PROBE =
  `(() => { const tab = document.querySelector('${DESKTOP_UI_SMOKE_ATTENTION_TAB}'); ` +
  `return !!tab && !!tab.querySelector('[role="img"]') && !tab.querySelector('[aria-label="Session running"]') })()`

/** The accessible label TabBar puts on the running dot; the lane pins English. */
export const DESKTOP_UI_SMOKE_RUNNING_LABEL = 'Session running'

/**
 * True once the session tab strip has no running dot left: the turn the UI was
 * streaming has ended.
 *
 * It reads the rendered DOM, so a just-written fixture file cannot satisfy it. That
 * is the shortcut this probe exists to prevent — the tool writes the file *before*
 * the turn's terminal frame, so "the file exists" is not evidence the UI finished.
 */
export const DESKTOP_UI_SMOKE_IDLE_PROBE =
  `(() => { const strip = document.querySelector('[data-testid="tab-bar"]'); ` +
  `return !!strip && !strip.querySelector('[aria-label="${DESKTOP_UI_SMOKE_RUNNING_LABEL}"]') })()`

export function buildDesktopUiSmokeBootstrap(sessionId: string) {
  return [
    `localStorage.setItem('cc-haha-locale', ${JSON.stringify(DESKTOP_UI_SMOKE_LOCALE)})`,
    `localStorage.setItem('cc-haha-open-tabs', ${JSON.stringify(JSON.stringify({
      openTabs: [{ sessionId, title: 'Desktop UI Smoke', type: 'session' }],
      activeTabId: sessionId,
    }))})`,
    `localStorage.removeItem('cc-haha-session-runtime')`,
  ].join(';')
}

export function buildDesktopUiSmokePrompt(projectDir: string) {
  const target = join(projectDir, TARGET_FILE)
  return {
    target,
    prompt: buildMockToolPrompt({
      tool: DESKTOP_UI_SMOKE_TOOL_NAME,
      input: { file_path: target, content: TARGET_CONTENT },
      write: { path: target, content: TARGET_CONTENT },
      reply: DESKTOP_UI_SMOKE_REPLY,
      // Persist the turn so a reload after it completes still resolves the tool
      // cards and the reply from the real transcript, not from a live frame.
      persist: true,
    }),
  }
}

export type DesktopUiSmokeHistoryInspection = {
  /** A persisted `Write` tool_use block exists. */
  hasToolUse: boolean
  /** A `tool_result` block resolves that exact tool_use id. */
  hasToolResult: boolean
  /** The assistant's closing reply text is present. */
  hasReply: boolean
  /** Id shared by the persisted tool_use and its result. */
  toolUseId: string | null
}

/**
 * Read the tool turn out of a `/messages` response.
 *
 * This checks the *server's* history projection rather than the live stream: the
 * regression was that the turn's cards were replaced by an empty history, so the
 * assertion has to run against what `/messages` returns after the turn finished.
 * Only the mock lane's own `Write` tool_use and its linked result count, so an
 * unrelated tool in the same session cannot satisfy it.
 */
export function inspectDesktopUiSmokeHistory(body: unknown): DesktopUiSmokeHistoryInspection {
  const messages = Array.isArray((body as { messages?: unknown } | null)?.messages)
    ? (body as { messages: Array<{ content?: unknown }> }).messages
    : []
  const blocks = messages.flatMap(message =>
    Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [])

  const toolUse = blocks.find(block =>
    block?.type === 'tool_use' && block?.name === DESKTOP_UI_SMOKE_TOOL_NAME && typeof block.id === 'string')
  const toolUseId = typeof toolUse?.id === 'string' ? toolUse.id : null
  const toolResult = toolUseId === null
    ? undefined
    : blocks.find(block => block?.type === 'tool_result' && block.tool_use_id === toolUseId && block.is_error !== true)
  const hasReply = blocks.some(block =>
    block?.type === 'text' && typeof block.text === 'string' && block.text.includes(DESKTOP_UI_SMOKE_REPLY))

  return {
    hasToolUse: Boolean(toolUse),
    hasToolResult: Boolean(toolResult),
    hasReply,
    toolUseId,
  }
}

export function seedDesktopUiSmokeProvider(configDir: string) {
  const ccHahaDir = join(configDir, 'cc-haha')
  mkdirSync(ccHahaDir, { recursive: true })
  writeFileSync(join(ccHahaDir, 'providers.json'), JSON.stringify({
    activeId: SMOKE_PROVIDER_ID,
    providers: [{
      id: SMOKE_PROVIDER_ID,
      presetId: 'custom',
      name: 'Desktop UI Smoke (isolated)',
      apiKey: 'desktop-ui-smoke-fake-key',
      baseUrl: 'http://127.0.0.1:1',
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: {
        main: SMOKE_MODEL_ID,
        haiku: SMOKE_MODEL_ID,
        sonnet: SMOKE_MODEL_ID,
        opus: SMOKE_MODEL_ID,
      },
    }, {
      id: TEAM_SMOKE_PROVIDER, presetId: 'custom', name: 'Economy UI Smoke (isolated)', apiKey: 'fake-economy-key', baseUrl: 'http://127.0.0.1:2', apiFormat: 'anthropic',
      models: { main: TEAM_SMOKE_MODEL, haiku: TEAM_SMOKE_MODEL, sonnet: TEAM_SMOKE_MODEL, opus: TEAM_SMOKE_MODEL },
    }],
    providerOrder: ['claude-official', 'openai-official', 'grok-official', SMOKE_PROVIDER_ID, TEAM_SMOKE_PROVIDER],
  }, null, 2) + '\n')
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}`)
}

/**
 * The lane needs the `agent-browser` binary and installed desktop dependencies.
 * Neither is required to run the rest of the deterministic gate, so a contributor
 * without them gets an explicit skip instead of a confusing failure.
 */
export function describeDesktopUiSmokePrerequisites(rootDir: string): string | null {
  if (!existsSync(join(rootDir, 'desktop', 'node_modules', '.bin'))) {
    return 'desktop dependencies are not installed (run `bun install` in desktop/)'
  }
  if (!resolveDesktopViteExecutable(rootDir)) {
    return 'desktop Vite executable is missing (reinstall desktop dependencies)'
  }
  const agentBrowserExecutable = resolveAgentBrowserExecutable()
  if (!agentBrowserExecutable) {
    return 'agent-browser is not installed (see https://github.com/anthropics/agent-browser)'
  }
  const probe = Bun.spawnSync([agentBrowserExecutable, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  if (probe.exitCode !== 0) {
    return 'agent-browser is not installed (see https://github.com/anthropics/agent-browser)'
  }
  return null
}

export async function executeDeterministicDesktopSmoke(
  rootDir: string,
  artifactDir: string,
  resultId: string,
  resultTitle: string,
): Promise<LaneResult> {
  const started = Date.now()
  mkdirSync(artifactDir, { recursive: true })

  const missing = describeDesktopUiSmokePrerequisites(rootDir)
  if (missing) {
    return {
      id: resultId,
      title: resultTitle,
      status: 'skipped',
      durationMs: Date.now() - started,
      skipReason: missing,
      artifactDir,
    }
  }

  const serverLogPath = join(artifactDir, 'server.log')
  const viteLogPath = join(artifactDir, 'vite.log')
  const browserLogPath = join(artifactDir, 'browser.log')
  const workRoot = await mkdtemp(join(tmpdir(), 'quality-gate-desktop-ui-smoke-'))
  const projectDir = join(workRoot, 'project')
  const browserProfileDir = join(workRoot, 'browser-profile')
  cpSync(join(rootDir, FIXTURE), projectDir, { recursive: true })

  const serverPort = await getPort()
  const vitePort = await getPort()
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const appUrl = desktopSmokeAppUrl(vitePort)
  const sessionName = `quality-gate-ui-${serverPort}-${vitePort}`
  const browserEnv = buildDesktopSmokeBrowserEnv(sessionName, browserProfileDir)

  const sandbox = createQualityGateSandbox({
    label: 'desktop-ui-smoke',
    seedProviders: false,
    envOverrides: {
      CLAUDE_CLI_PATH: resolve(rootDir, 'scripts/quality-gate/desktop-smoke/fixtures/team-worker.ts'),
      MOCK_SDK_TEAM_ECHO_GATE: join(workRoot, 'hold-team-echo'),
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
      MOCK_SDK_TEAM_WORKER_AUDIT: join(workRoot, 'team-worker-audit.jsonl'),
    },
  })
  seedDesktopUiSmokeProvider(sandbox.configDir)

  // The wrapper delegates non-team sessions to src/server/__tests__/fixtures/mock-sdk-cli.ts.
  const startServer = () => {
    const process = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(serverPort)], {
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...sandbox.env, SERVER_PORT: String(serverPort) },
    })
    void pipeToFile(process.stdout, serverLogPath)
    void pipeToFile(process.stderr, serverLogPath)
    return process
  }
  let server = startServer()
  const restartServer = async () => {
    const oldPid = server.pid
    await stopDesktopSmokeProcess(server, 'server restart', serverLogPath)
    // Do not substitute an in-process rehydrate call for a real process exit.
    await server.exited
    server = startServer()
    await waitForHttp(`${baseUrl}/health`, 30_000)
    const lifecycle = { oldPid, newPid: server.pid }
    appendFileSync(serverLogPath, `\n[quality-gate] Service process restarted ${JSON.stringify(lifecycle)}; sandbox config retained\n`)
    return lifecycle
  }

  const viteExecutable = resolveDesktopViteExecutable(rootDir)
  if (!viteExecutable) {
    throw new Error('desktop Vite executable disappeared after prerequisite checks')
  }
  const vite = Bun.spawn([viteExecutable, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: join(rootDir, 'desktop'),
    env: { ...process.env, VITE_DESKTOP_SERVER_URL: baseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void pipeToFile(vite.stdout, viteLogPath)
  void pipeToFile(vite.stderr, viteLogPath)

  const browserStep = (args: string[], options: { timeoutMs?: number; allowFailure?: boolean } = {}) =>
    runLoggedCommand(agentBrowserCommand(args), {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: options.timeoutMs ?? 30_000,
      allowFailure: options.allowFailure,
      maxLogChars: 8_000,
    })

  const { target, prompt } = buildDesktopUiSmokePrompt(projectDir)

  try {
    await waitForHttp(`${baseUrl}/health`, 30_000)
    await waitForHttp(appUrl, 60_000)

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    if (!created.ok) {
      throw new Error(`POST /api/sessions failed with HTTP ${created.status}: ${await created.text()}`)
    }
    const session = await created.json() as { sessionId: string }

    await browserStep(['open', appUrl])
    await browserStep(['eval', buildDesktopUiSmokeBootstrap(session.sessionId)], { timeoutMs: 15_000 })
    await browserStep(['reload'])
    // The composer is a ProseMirror contenteditable (MentionComposer), not a
    // <textarea> — `[data-composer-editor]` is the attribute the editor sets on
    // its editable node and the same hook composerTestUtils drives.
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR])

    // `type` drives the editor's input path so React and ProseMirror observe the
    // same update as a person typing. `fill` can replace only the DOM text while
    // leaving the editor state empty.
    await browserStep(['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, prompt], { timeoutMs: 20_000 })
    // Click the visible Run control. A standalone `press Enter` command starts a
    // separate agent-browser invocation and does not reliably preserve the
    // contenteditable focus on Windows.
    await browserStep(['click', DESKTOP_SMOKE_RUN_SELECTOR], { timeoutMs: 15_000 })

    // The permission dialog is the point of this lane: nothing may touch the
    // fixture until the real button is clicked.
    await pollUntil(async () => {
      const probe = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
      return `${probe.stdout}${probe.stderr}`.includes('Allow')
    }, 60_000, 'the permission dialog to render')

    if (existsSync(target)) {
      throw new Error('the tool wrote the fixture file before the permission dialog was answered')
    }
    await browserStep(['screenshot', join(artifactDir, 'permission-dialog.png')], { allowFailure: true })
    // While the dialog is open the session's tab has to say the session is
    // waiting on the person, not running, and has to stop saying it once the
    // request is answered. A marker derived from anything but the open request
    // gets one of those two wrong.
    await browserStep(['wait', '--fn', DESKTOP_UI_SMOKE_ATTENTION_PROBE], { timeoutMs: 15_000 })
    await browserStep(['click', DESKTOP_UI_SMOKE_ALLOW_SELECTOR], { timeoutMs: 20_000 })
    await browserStep(['wait', '--fn', `!document.querySelector('${DESKTOP_UI_SMOKE_ATTENTION_TAB}')`], { timeoutMs: 20_000 })

    await pollUntil(
      async () => existsSync(target) && readFileSync(target, 'utf8') === TARGET_CONTENT,
      60_000,
      'the approved tool to write the fixture file',
    )

    // The file on disk is the tool's side effect, not proof the turn finished: the
    // UI can still be streaming, and the server may still be ingesting the turn. So
    // this only checks that the live frame rendered the tool call, never that the
    // turn is complete.
    const finalText = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
    const rendered = `${finalText.stdout}${finalText.stderr}`
    writeFileSync(join(artifactDir, 'final-content.txt'), rendered)
    if (!rendered.includes(TARGET_FILE)) {
      throw new Error(`the UI never rendered the tool call for ${TARGET_FILE}`)
    }
    await browserStep(['screenshot', join(artifactDir, 'final.png')], { allowFailure: true })

    // The turn's live cards proved nothing on their own: the regression was that
    // fetching history after the turn replaced them with an empty transcript. Poll
    // the server's own history projection until the tool_use, its linked
    // tool_result and the reply are all present — that is the durable proof the
    // turn reached disk, and it removes the fixed-sleep race.
    let historyBody: unknown = undefined
    await pollUntil(async () => {
      const response = await fetch(`${baseUrl}/api/sessions/${session.sessionId}/messages?mode=full`)
      if (!response.ok) return false
      const body = await response.json()
      const inspected = inspectDesktopUiSmokeHistory(body)
      if (inspected.hasToolUse && inspected.hasToolResult && inspected.hasReply) {
        historyBody = body
        return true
      }
      return false
    }, 60_000, 'the persisted tool turn to reach /messages')
    writeFileSync(join(artifactDir, 'history-after-completion.json'), JSON.stringify(historyBody, null, 2) + '\n')
    const history = inspectDesktopUiSmokeHistory(historyBody)
    if (!history.hasToolUse || !history.hasToolResult || !history.hasReply) {
      throw new Error(
        `the persisted history is missing part of the tool turn ` +
        `(tool_use=${history.hasToolUse}, tool_result=${history.hasToolResult}, reply=${history.hasReply}); ` +
        `the mock runtime must opt into persisting the turn with the real uuid/toolUse chain.`,
      )
    }

    // Completion has to be visible in the UI itself, not inferred from the file: a
    // just-written file says nothing about the turn the tab is still streaming. Wait
    // until the running dot is gone, which only happens on the terminal frame.
    await browserStep(['wait', '--fn', DESKTOP_UI_SMOKE_IDLE_PROBE], { timeoutMs: 30_000 })

    // Settle, then reload against the confirmed history. The delay is no longer the
    // race guard — the history poll is — so a request in flight cannot mask it.
    await Bun.sleep(DESKTOP_UI_SMOKE_RELOAD_DELAY_MS)
    if (!existsSync(target) || readFileSync(target, 'utf8') !== TARGET_CONTENT) {
      throw new Error('the written fixture file disappeared before the reload check')
    }

    await browserStep(['reload'])
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], { timeoutMs: 30_000 })
    const reloadedText = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
    const reloaded = `${reloadedText.stdout}${reloadedText.stderr}`
    writeFileSync(join(artifactDir, 'reloaded-content.txt'), reloaded)
    if (!reloaded.includes(TARGET_FILE) || !reloaded.includes(DESKTOP_UI_SMOKE_REPLY)) {
      throw new Error(
        `the reloaded UI lost the tool turn (tool card=${reloaded.includes(TARGET_FILE)}, ` +
        `reply=${reloaded.includes(DESKTOP_UI_SMOKE_REPLY)}); history did not render the persisted cards.`,
      )
    }
    await browserStep(['screenshot', join(artifactDir, 'reloaded.png')], { allowFailure: true })

    await runDesktopUiTeamPlanSmoke({
      configDir: sandbox.configDir, sessionId: session.sessionId, projectDir, baseUrl, artifactDir,
      auditPath: join(workRoot, 'team-worker-audit.jsonl'), echoGatePath: join(workRoot, 'hold-team-echo'), browserStep, restartServer,
      assignTask: async () => {
        const result = await runLoggedCommand(['bun', 'run', 'scripts/quality-gate/desktop-smoke/fixtures/assign-task.ts', 'desktop-ui-review-team', 'builder'], {
          cwd: rootDir, env: sandbox.env, logPath: serverLogPath, timeoutMs: 30_000,
        })
        return JSON.parse(result.stdout.trim()).taskId as string
      },
    })

    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'passed' as const,
      durationMs: Date.now() - started,
      artifactDir,
    }, sandbox, artifactDir)
  } catch (error) {
    await browserStep(['screenshot', join(artifactDir, 'failure.png')], { allowFailure: true }).catch(() => {})
    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'failed' as const,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    }, sandbox, artifactDir)
  } finally {
    await browserStep(['close'], { timeoutMs: 10_000, allowFailure: true }).catch(() => {})
    await cleanupAgentBrowserSession(sessionName, browserLogPath)
    cleanupBrowserProfileProcesses(browserProfileDir, browserLogPath)
    appendFileSync(browserLogPath, `\n[quality-gate] Removed browser profile ${browserProfileDir}\n`)
    await Promise.all([
      stopDesktopSmokeProcess(server, 'server', serverLogPath),
      stopDesktopSmokeProcess(vite, 'Vite', viteLogPath),
    ])
    removeDesktopSmokeTree(workRoot)
    sandbox.cleanup()
  }
}
