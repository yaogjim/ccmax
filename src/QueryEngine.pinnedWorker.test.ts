import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'query-pinned-worker-'))
const originalEnv = { ...process.env }
const previousMacro = (globalThis as any).MACRO
;(globalThis as any).MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1' }, originalEnv))
const originals = {
  query: { ...await import('./query.js') },
  input: { ...await import('./utils/processUserInput/processUserInput.js') },
  storage: { ...await import('./utils/sessionStorage.js') },
  context: { ...await import('./utils/queryContext.js') },
}
let inputOptions: any
let writes: any[] = []
mock.module('./utils/queryContext.js', () => ({ ...originals.context, fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) }))
mock.module('./utils/processUserInput/processUserInput.js', () => ({ ...originals.input, processUserInput: async (options: any) => {
  inputOptions = options
  return { messages: [{ type: 'user', uuid: options.uuid ?? crypto.randomUUID(), isMeta: true, timestamp: new Date().toISOString(), message: { role: 'user', content: options.input } }], shouldQuery: true, allowedTools: [] }
} }))
mock.module('./utils/sessionStorage.js', () => ({ ...originals.storage,
  recordTranscript: async (messages: any[]) => { writes = [...messages] },
}))
mock.module('./query.js', () => ({ ...originals.query, query: async function* () {
  throw new Error('fixture query boundary reached')
} }))
const { QueryEngine } = await import('./QueryEngine.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')

function engine() {
  let state = getDefaultAppState()
  return new QueryEngine({ cwd: home, tools: [], commands: [], mcpClients: [], agents: [], readFileCache: new Map() as any,
    customSystemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state, setAppState: update => { state = update(state) },
  })
}

beforeEach(() => { inputOptions = undefined; writes = [] })
afterAll(() => {
  mock.module('./query.js', () => originals.query)
  mock.module('./utils/processUserInput/processUserInput.js', () => originals.input)
  mock.module('./utils/sessionStorage.js', () => originals.storage)
  mock.module('./utils/queryContext.js', () => originals.context)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

async function submit(prompt: string) {
  const iterator = engine().submitMessage(prompt)
  try { await iterator.next() } catch {} finally { await iterator.return(undefined as never).catch(() => {}) }
}

test('a pinned agent worker never interprets slash commands in its task', async () => {
  process.env.CC_HAHA_PINNED_AGENT_WORKER = '1'
  try {
    await submit('/switch')
    expect(inputOptions).toMatchObject({ input: '/switch', skipSlashCommands: true })
  } finally { delete process.env.CC_HAHA_PINNED_AGENT_WORKER }
})

test('an ordinary session still interprets slash commands', async () => {
  delete process.env.CC_HAHA_PINNED_AGENT_WORKER
  await submit('/switch')
  expect(inputOptions.skipSlashCommands).toBe(false)
})
