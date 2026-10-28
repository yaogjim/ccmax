import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedDesktopUiTeamPlan, assertTeamWorkerBoots, inspectMemberConversation } from './team-plan'

describe('standard team smoke boundaries', () => {
  test('observes real turn status around held Stop before restarting the service', () => {
    const source = readFileSync('scripts/quality-gate/desktop-smoke/team-plan.ts', 'utf8')
    const status = readFileSync('desktop/src/components/chat/StreamingIndicator.tsx', 'utf8')
    expect(status).toContain('data-testid="turn-status-indicator"')
    expect(source.indexOf("const stoppedText =")).toBeLessThan(source.indexOf("['click', 'button[aria-label=\"Stop\"]']"))
    expect(source.indexOf("['wait', thinkingSelector]")).toBeLessThan(source.indexOf("['click', 'button[aria-label=\"Stop\"]']"))
    expect(source.indexOf("record('stop-pending-thinking-cleared'")).toBeLessThan(source.indexOf('await options.restartServer()'))
    expect(source).toContain('Stop invented a mailbox echo or reply for held input')
    const worker = readFileSync('scripts/quality-gate/desktop-smoke/fixtures/team-worker.ts', 'utf8')
    expect(worker).toContain('await readMailboxHistory(member, teamName)')
    expect(worker).not.toContain('markMessagesAsRead')
    expect(worker).not.toContain('claimMailboxMessages')
  })

  test('restarts the owned runner process with the same sandbox and preserves skip evidence', () => {
    const runner = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')
    expect(runner).toContain("await stopDesktopSmokeProcess(server, 'server restart', serverLogPath)")
    expect(runner).toContain('await server.exited')
    expect(runner).toContain('server = startServer()')
    expect(runner).toContain('env: { ...sandbox.env, SERVER_PORT: String(serverPort) }')
    const cli = readFileSync('scripts/quality-gate/desktop-smoke/deterministic-cli.ts', 'utf8')
    expect(cli.indexOf("writeFileSync(join(artifactDir, 'result.json')")).toBeLessThan(cli.indexOf("if (result.status === 'skipped')"))
  })

  test('approval fixture authorizes roles but seeds no tasks, starts, or recovery', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'team-smoke-standby-'))
    try {
      const plan = seedDesktopUiTeamPlan(configDir, 'lead', '/tmp/disposable-project')
      expect(plan.state).toBe('review_pending')
      expect(plan.tasks).toEqual([])
      expect(plan.approvedSnapshot).toBeUndefined()
      expect(plan.launch).toBeUndefined()
      const roster = JSON.parse(readFileSync(join(configDir, 'teams', plan.teamName, 'config.json'), 'utf8'))
      expect(roster.members.map((member: { name: string }) => member.name)).toEqual(['team-lead'])
      expect(roster.pausedAt).toBeUndefined()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('requires one real first boot and a separate resume with the same history', () => {
    const initial = { phase: 'boot', sessionId: 'builder-session', resume: false, historyEntries: 0 }
    expect(() => assertTeamWorkerBoots([initial], 'builder-session', false)).not.toThrow()
    expect(() => assertTeamWorkerBoots([initial, initial], 'builder-session', false)).toThrow('boot')
    expect(() => assertTeamWorkerBoots([initial, { ...initial, resume: true, historyEntries: 4 }], 'builder-session', true)).not.toThrow()
    expect(() => assertTeamWorkerBoots([initial, { ...initial, resume: true, historyEntries: 0 }], 'builder-session', true)).toThrow('history')
    expect(() => assertTeamWorkerBoots([initial, { ...initial, sessionId: 'replacement', resume: true, historyEntries: 4 }], 'builder-session', true)).toThrow('boot')
  })

  test('settles a member send by exact envelope identity, not matching text', () => {
    const messageId = 'msg-identity-1'
    expect(inspectMemberConversation({ keys: [messageId], text: 'same text' }, messageId)).toEqual({ pending: true, settled: false, duplicates: false })
    expect(inspectMemberConversation({ keys: ['echo-msg-other'], text: 'same text' }, messageId).settled).toBe(false)
    expect(inspectMemberConversation({ keys: [`echo-${messageId}`], text: 'same text' }, messageId)).toEqual({ pending: false, settled: true, duplicates: false })
    expect(inspectMemberConversation({ keys: [messageId, `echo-${messageId}`] }, messageId).duplicates).toBe(true)
  })
})
