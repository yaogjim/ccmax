import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../../Tool.js'

const home = await mkdtemp(join(tmpdir(), 'team-permission-probe-'))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
globalThis.fetch = (() => { throw new Error('Probe forbids network/model calls') }) as typeof fetch
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { hasPermissionsToUseTool } = await import('../permissions.js')
let checks = 0
const tool = {
  name: 'FixturePermissionTool', inputSchema: { parse: (input: unknown) => input },
  checkPermissions: async () => {
    checks++
    return { behavior: 'ask', message: 'fixture permission check' }
  },
  requiresUserInteraction: () => false,
} as unknown as Tool
async function evaluate(mode: ToolPermissionContext['mode'], bypass = false, deny = false) {
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: {
      ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: bypass,
      ...(deny ? { alwaysDenyRules: { session: ['FixturePermissionTool'] } } : {}),
    } }),
    setAppState: () => { throw new Error('Unexpected state mutation in non-auto fixture') },
  } as unknown as ToolUseContext
  return hasPermissionsToUseTool(tool, {}, context, {} as never, 'fixture-permission-call')
}
try {
  const rows = []
  for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'] as const) {
    for (const bypass of [false, true]) {
      const result = await evaluate(mode, bypass)
      const denied = await evaluate(mode, bypass, true)
      assert.equal(denied.behavior, 'deny')
      rows.push({ mode, bypass, behavior: result.behavior, explicitDeny: denied.behavior })
    }
  }
  assert.equal(rows.find(row => row.mode === 'plan' && row.bypass)?.behavior, 'allow')
  assert.equal(rows.find(row => row.mode === 'dontAsk')?.behavior, 'deny')
  const before = checks
  await evaluate('default')
  await evaluate('plan')
  assert.equal(checks - before, 2)
  console.log(JSON.stringify({ scenario: 'real-permission-entry-with-fake-tool', rows,
    toolChecksForTwoContextEvaluation: checks - before,
    automaticSafeIntersectionProven: false,
    coverage: 'non-auto modes, synthetic ask tool, explicit deny; no classifier, approval hook or production tool purity claim' }))
} finally {
  await rm(home, { recursive: true, force: true })
}
