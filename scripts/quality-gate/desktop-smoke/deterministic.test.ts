import { describe, expect, test } from 'bun:test'
import { seedDesktopUiTeamPlan } from './team-plan'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_UI_SMOKE_ALLOW_SELECTOR,
  DESKTOP_UI_SMOKE_ATTENTION_PROBE,
  DESKTOP_UI_SMOKE_ATTENTION_TAB,
  DESKTOP_UI_SMOKE_IDLE_PROBE,
  DESKTOP_UI_SMOKE_LOCALE,
  DESKTOP_UI_SMOKE_RELOAD_DELAY_MS,
  DESKTOP_UI_SMOKE_REPLY,
  DESKTOP_UI_SMOKE_RUNNING_LABEL,
  DESKTOP_UI_SMOKE_TOOL_NAME,
  buildDesktopUiSmokeBootstrap,
  buildDesktopUiSmokePrompt,
  describeDesktopUiSmokePrerequisites,
  inspectDesktopUiSmokeHistory,
  seedDesktopUiSmokeProvider,
} from './deterministic'

describe('deterministic desktop UI smoke setup', () => {
  test('pins the locale so the approval button label is stable for every contributor', () => {
    const bootstrap = buildDesktopUiSmokeBootstrap('session-1')

    expect(bootstrap).toContain(`localStorage.setItem('cc-haha-locale', "${DESKTOP_UI_SMOKE_LOCALE}")`)
    expect(bootstrap).toContain('cc-haha-open-tabs')
    expect(bootstrap).toContain('session-1')
    // No per-session runtime is pinned: the lane uses its isolated active provider.
    expect(bootstrap).toContain("localStorage.removeItem('cc-haha-session-runtime')")
  })

  test('matches the approval button the desktop actually renders', () => {
    const dialog = readFileSync('desktop/src/components/chat/PermissionDialog.tsx', 'utf8')
    const english = readFileSync('desktop/src/i18n/locales/en.ts', 'utf8')

    // The selector is derived from the production aria-label and the pinned locale;
    // if either changes, this test fails before the lane starts timing out.
    expect(dialog).toContain("aria-label={`${t('permission.allow')}: ${permissionContext}`}")
    expect(english).toContain("'permission.allow': 'Allow'")
    expect(DESKTOP_UI_SMOKE_ALLOW_SELECTOR).toBe('button[aria-label^="Allow: "]')
  })

  test('matches the waiting-tab marker the desktop actually renders', () => {
    const tabBar = readFileSync('desktop/src/components/layout/TabBar.tsx', 'utf8')
    const mark = readFileSync('desktop/src/components/layout/SessionAttentionMark.tsx', 'utf8')
    const english = readFileSync('desktop/src/i18n/locales/en.ts', 'utf8')

    // Same idea as the approval button above: the selectors are derived from the
    // production markup, so a rename fails here before the lane times out waiting.
    expect(tabBar).toContain('data-testid="tab-bar"')
    expect(tabBar).toContain("data-attention={needsAttention ? 'true' : 'false'}")
    expect(mark).toContain('role="img"')
    expect(english).toContain("'tabs.sessionRunning': 'Session running'")
    expect(DESKTOP_UI_SMOKE_ATTENTION_TAB).toBe('[data-testid="tab-bar"] [data-attention="true"]')
    expect(DESKTOP_UI_SMOKE_ATTENTION_PROBE).toContain(DESKTOP_UI_SMOKE_ATTENTION_TAB)
    expect(DESKTOP_UI_SMOKE_ATTENTION_PROBE).toContain('[role="img"]')
    // The probe must also reject a tab that carries the running dot.
    expect(DESKTOP_UI_SMOKE_ATTENTION_PROBE).toContain('!tab.querySelector(\'[aria-label="Session running"]\')')
  })

  test('asks the mock runtime to write inside the fixture copy only', () => {
    const projectDir = '/tmp/fixture-copy'
    const { target, prompt } = buildDesktopUiSmokePrompt(projectDir)

    expect(target).toBe(join(projectDir, 'ui-smoke-output.txt'))
    expect(prompt.startsWith('MOCK_TOOL ')).toBe(true)
    const payload = JSON.parse(prompt.slice('MOCK_TOOL '.length))
    expect(payload.tool).toBe(DESKTOP_UI_SMOKE_TOOL_NAME)
    expect(payload.write.path).toBe(target)
    expect(payload.write.content).toBe('written-through-the-desktop-ui')
    // The lane must persist the turn: without this the reload asserts nothing.
    expect(payload.persist).toBe(true)
    expect(payload.reply).toBe(DESKTOP_UI_SMOKE_REPLY)
  })

  test('seeds only fake providers inside the sandbox', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cc-haha-ui-smoke-provider-'))
    try {
      seedDesktopUiSmokeProvider(configDir)
      const index = JSON.parse(readFileSync(join(configDir, 'cc-haha', 'providers.json'), 'utf8'))
      expect(index.activeId).toBe('desktop-ui-smoke-provider')
      expect(index.providers).toHaveLength(2)
      expect(index.providers[0]).toMatchObject({
        apiKey: 'desktop-ui-smoke-fake-key',
        baseUrl: 'http://127.0.0.1:1',
      })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('seeds a pending plan with no child workers before browser approval', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cc-haha-team-review-smoke-'))
    try {
      const plan = seedDesktopUiTeamPlan(configDir, 'leader-session', '/tmp/disposable-project')
      const config = JSON.parse(readFileSync(join(configDir, 'teams', plan.teamName, 'config.json'), 'utf8'))
      expect(plan.state).toBe('review_pending')
      expect(plan.approvedSnapshot).toBeUndefined()
      expect(plan.members).toHaveLength(2)
      expect(config.members.map((member: { name: string }) => member.name)).toEqual(['team-lead'])
      expect(plan.tasks.every(task => plan.members.some(member => member.id === task.ownerId))).toBe(true)
      expect(JSON.parse(readFileSync(join(configDir, 'teams', plan.teamName, 'plan.json'), 'utf8'))).toEqual(plan)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('skips with an actionable reason instead of failing when prerequisites are missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-haha-ui-smoke-prereq-'))
    try {
      expect(describeDesktopUiSmokePrerequisites(empty)).toContain('desktop dependencies')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('runs the real UI against the mock runtime with a sandboxed config dir', () => {
    const source = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')

    expect(source).toContain('src/server/__tests__/fixtures/mock-sdk-cli.ts')
    expect(source).toContain('CLAUDE_CLI_PATH')
    expect(source).toContain('seedProviders: false')
    expect(source).toContain('seedDesktopUiSmokeProvider(sandbox.configDir)')
    expect(source).toContain('...sandbox.env')
    expect(source).toContain('applyUserStateGuard')
    // The lane must answer the permission through the UI. Flipping the global
    // permission mode is what made the old smoke both unsafe and blind to the
    // approval screen.
    expect(source).toContain(DESKTOP_UI_SMOKE_ALLOW_SELECTOR)
    expect(source).toContain("['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, prompt]")
    expect(source).toContain("['click', DESKTOP_SMOKE_RUN_SELECTOR]")
    // No global permission-mode switch: the old smoke PUT bypassPermissions on the
    // settings API, which both skipped the approval screen and mutated user state.
    expect(source).not.toContain('/api/permissions/mode')
    expect(source).not.toContain('setPermissionMode')
    expect(source).toContain('before the permission dialog was answered')
  })

  test('persists the tool turn and asserts the reloaded history, not just the file', () => {
    const source = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')

    // The gap this closes: the live cards are replaced by the empty history the
    // mock never wrote. The lane must opt into persistence and then prove the
    // desktop's own `/messages` response still carries the tool turn.
    expect(source).toContain('persist: true')
    expect(source).toContain('/messages?mode=full')
    expect(source).toContain('inspectDesktopUiSmokeHistory')
    expect(source).toContain('DESKTOP_UI_SMOKE_RELOAD_DELAY_MS')
    // The reload has to wait long enough that a file-write-race cannot pass it.
    expect(DESKTOP_UI_SMOKE_RELOAD_DELAY_MS).toBeGreaterThanOrEqual(2000)
    // The history is read only after the tool completed, and the delayed reload
    // sits between the file-write poll and the history fetch — not before both.
    const filePoll = source.indexOf('the approved tool to write the fixture file')
    expect(source.indexOf('Bun.sleep(DESKTOP_UI_SMOKE_RELOAD_DELAY_MS)')).toBeGreaterThan(filePoll)
    expect(source.indexOf('history-after-completion.json')).toBeGreaterThan(filePoll)
    // The post-completion reload is what turns the assertion into a history check.
    expect(source.indexOf('reloaded-content.txt')).toBeGreaterThan(source.indexOf('history-after-completion.json'))
  })

  test('proves the reloaded history carries tool_use, tool_result and the reply', () => {
    const history = {
      messages: [
        { id: 'user-1', type: 'user', content: [{ type: 'text', text: 'MOCK_TOOL {"tool":"Write"}' }] },
        {
          id: 'asst-1',
          type: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Write', input: { file_path: '/tmp/out.txt' } }],
        },
        {
          id: 'result-1',
          type: 'tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'wrote ui-smoke-output.txt', is_error: false }],
        },
        { id: 'asst-2', type: 'assistant', content: [{ type: 'text', text: 'wrote ui-smoke-output.txt' }] },
      ],
    }

    const inspected = inspectDesktopUiSmokeHistory(history)
    expect(inspected.hasToolUse).toBe(true)
    expect(inspected.hasToolResult).toBe(true)
    expect(inspected.hasReply).toBe(true)
    expect(inspected.toolUseId).toBe('toolu_abc')
  })

  test('rejects a history that kept the tool_use but lost its result or reply', () => {
    const noResult = inspectDesktopUiSmokeHistory({
      messages: [
        { id: 'asst-1', type: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Write', input: {} }] },
      ],
    })
    expect(noResult.hasToolUse).toBe(true)
    expect(noResult.hasToolResult).toBe(false)
    expect(noResult.hasReply).toBe(false)

    // A history that renders the cards but not the assistant reply must not pass.
    const noReply = inspectDesktopUiSmokeHistory({
      messages: [
        { id: 'asst-1', type: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Write', input: {} }] },
        { id: 'r', type: 'tool_result', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'wrote ui-smoke-output.txt' }] },
      ],
    })
    expect(noReply.hasToolResult).toBe(true)
    expect(noReply.hasReply).toBe(false)
  })

  test('does not mistake an unrelated tool_result for the mock tool turn', () => {
    const inspected = inspectDesktopUiSmokeHistory({
      messages: [
        { id: 'a', type: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_other', name: 'Read', input: {} }] },
        { id: 'b', type: 'tool_result', content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'file body' }] },
      ],
    })
    expect(inspected.toolUseId).toBeNull()
    expect(inspected.hasToolResult).toBe(false)
  })

  test('polls the real history instead of sleeping a fixed window before one fetch', () => {
    const source = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')

    // The race this replaces: a fixed `Bun.sleep` then a single fetch, which could
    // read an empty history if the turn had not been ingested yet. Completion is now
    // polled until the whole tool turn is present.
    expect(source).toContain('the persisted tool turn to reach /messages')
    expect(source.indexOf('const historyResponse = await fetch')).toBe(-1)

    const filePoll = source.indexOf('the approved tool to write the fixture file')
    const historyPoll = source.indexOf('the persisted tool turn to reach /messages')
    const idleProbe = source.indexOf("'--fn', DESKTOP_UI_SMOKE_IDLE_PROBE")
    const reloadDelay = source.indexOf('Bun.sleep(DESKTOP_UI_SMOKE_RELOAD_DELAY_MS)')
    // The lane reloads twice (once after the bootstrap, once after the turn); the
    // post-completion one is the last.
    const reload = source.lastIndexOf("browserStep(['reload'])")

    expect(historyPoll).toBeGreaterThan(filePoll)
    // History is confirmed first, then the DOM is checked idle, then the settle
    // delay, then the reload — never a bare sleep as the completion gate.
    expect(idleProbe).toBeGreaterThan(historyPoll)
    expect(reloadDelay).toBeGreaterThan(idleProbe)
    expect(reload).toBeGreaterThan(reloadDelay)
  })

  test('proves UI completion from the rendered DOM, not from the just-written file', () => {
    // The tool writes the fixture *before* the turn's terminal frame, so the file
    // existing is not evidence the UI finished. The idle probe reads the real tab
    // strip and waits for the running dot to clear.
    expect(DESKTOP_UI_SMOKE_IDLE_PROBE).toContain('[data-testid="tab-bar"]')
    expect(DESKTOP_UI_SMOKE_IDLE_PROBE).toContain(`!strip.querySelector('[aria-label="${DESKTOP_UI_SMOKE_RUNNING_LABEL}"]')`)
    // It must not key off the fixture file the tool just wrote.
    expect(DESKTOP_UI_SMOKE_IDLE_PROBE).not.toContain('ui-smoke-output')
    expect(DESKTOP_UI_SMOKE_IDLE_PROBE).not.toContain('written-through-the-desktop-ui')

    const source = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')
    expect(source).toContain("browserStep(['wait', '--fn', DESKTOP_UI_SMOKE_IDLE_PROBE]")
  })

  test('derives the running label from the production locale, not a literal guess', () => {
    const english = readFileSync('desktop/src/i18n/locales/en.ts', 'utf8')
    expect(english).toContain("'tabs.sessionRunning': 'Session running'")
    expect(DESKTOP_UI_SMOKE_RUNNING_LABEL).toBe('Session running')
  })
})
