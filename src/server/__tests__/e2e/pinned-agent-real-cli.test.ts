import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

/**
 * The whole chain with real CLI processes and two loopback providers:
 * the session's model (provider A) asks for two pinned niuma runs and one
 * ordinary subagent in a single turn; the pinned runs must reach provider B
 * with the pinned model, the ordinary one must stay on A, and each result
 * must come back to the session.
 */

type Hit = { provider: 'A' | 'B'; model: string; body: any; text: string }

const PARENT_MODEL = 'parent-main'
const PINNED_MODEL = 'pinned-model'
const hits: Hit[] = []

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamOf(model: string, blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>) {
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      parts.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }))
    } else {
      parts.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }))
      parts.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }))
    }
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index }))
  })
  const hasTool = blocks.some(block => block.type === 'tool_use')
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: hasTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }))
  parts.push(sse('message_stop', { type: 'message_stop' }))
  return new Response(parts.join(''), { headers: { 'content-type': 'text/event-stream' } })
}

function textOf(body: any): string {
  return JSON.stringify([body.system ?? '', body.messages ?? []])
}

function lastUserText(body: any): string {
  const last = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user')
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

function startProvider(name: 'A' | 'B') {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (!path.endsWith('/messages')) return Response.json({ data: [] })
      const body = await req.json() as any
      hits.push({ provider: name, model: body.model, body, text: textOf(body) })
      const last = lastUserText(body)
      if (name === 'B') {
        const token = /TASK-[A-Z0-9]+/.exec(last)?.[0] ?? 'none'
        return streamOf(body.model, [{ type: 'text', text: `B-DONE ${token}` }])
      }
      // Provider A: the session's own model, and the ordinary subagent.
      if (last.includes('UNPINNED-TASK')) return streamOf(body.model, [{ type: 'text', text: 'A-SUBAGENT-DONE' }])
      if (last.includes('tool_result')) return streamOf(body.model, [{ type: 'text', text: 'ALL-DONE' }])
      if (last.includes('boot the team')) {
        const call = (id: string, subagent: string, prompt: string) => ({ type: 'tool_use' as const, id, name: 'Agent', input: { description: prompt.slice(0, 20), prompt, subagent_type: subagent } })
        return streamOf(body.model, [
          call('toolu_pin1', 'niuma', 'Do TASK-ONE please'),
          call('toolu_pin2', 'niuma', 'Do TASK-TWO please'),
          call('toolu_plain', 'general-purpose', 'UNPINNED-TASK'),
        ])
      }
      return streamOf(body.model, [{ type: 'text', text: 'ok' }])
    },
  })
}

let home: string
let original: NodeJS.ProcessEnv
let providerA: ReturnType<typeof startProvider>
let providerB: ReturnType<typeof startProvider>
let server: ReturnType<typeof Bun.serve>
let shutdown: (() => Promise<void>) | undefined
let socket: WebSocket | undefined
const events: any[] = []

beforeAll(async () => {
  providerA = startProvider('A')
  providerB = startProvider('B')
  home = await mkdtemp(join(tmpdir(), 'pinned-agent-real-cli-'))
  original = { ...process.env }
  // NODE_ENV=test makes a real CLI exit at start-up; everything else stays sandboxed.
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production',
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)

  const workDir = join(home, 'project')
  await mkdir(workDir)
  await mkdir(join(env.CLAUDE_CONFIG_DIR!, 'agents'), { recursive: true })
  await writeFile(join(env.CLAUDE_CONFIG_DIR!, 'agents', 'niuma.md'), '---\nname: niuma\ndescription: Runs tasks\ntools: ["Read"]\n---\nYou are niuma.\n')

  const { ProviderService } = await import('../../services/providerService.js')
  const providers = new ProviderService()
  const a = await providers.addProvider({ presetId: 'custom', name: 'Provider A', baseUrl: `http://127.0.0.1:${providerA.port}`, apiKey: 'fake-a', models: { main: PARENT_MODEL, sonnet: PARENT_MODEL, opus: PARENT_MODEL, haiku: PARENT_MODEL } } as any)
  await providers.activateProvider(a.id)
  const b = await providers.addProvider({ presetId: 'custom', name: 'Provider B', baseUrl: `http://127.0.0.1:${providerB.port}`, apiKey: 'fake-b', models: { main: PINNED_MODEL, sonnet: PINNED_MODEL, opus: PINNED_MODEL, haiku: PINNED_MODEL } } as any)
  const settingsPath = join(env.CLAUDE_CONFIG_DIR!, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'))
  await writeFile(settingsPath, JSON.stringify({ ...settings, agentRuntimeBindings: { niuma: { providerId: b.id, modelId: PINNED_MODEL } } }))

  const runtime = await import('../../index.js')
  shutdown = runtime.stopServerRuntimeForShutdown
  server = runtime.startServer(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.port}`
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workDir }) })).json() as { sessionId: string }
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${created.sessionId}`)
  socket.addEventListener('message', event => events.push(JSON.parse(String(event.data))))
  await until(() => events.some(event => event.type === 'connected'), 'websocket')
  socket.send(JSON.stringify({ type: 'user_message', content: 'boot the team' }))
}, 30_000)

afterAll(async () => {
  socket?.close()
  await shutdown?.()
  server?.stop(true)
  providerA?.stop(true)
  providerB?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(home, { recursive: true, force: true })
})

async function until(check: () => boolean, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(events.map(event => event.type))}`)
    await Bun.sleep(50)
  }
}

test('two pinned runs reach the pinned provider, the ordinary subagent stays on the session provider, and results come back', async () => {
  await until(() => events.some(event => event.type === 'message_complete'), 'the session turn to finish')

  const toB = hits.filter(hit => hit.provider === 'B')
  const toA = hits.filter(hit => hit.provider === 'A')

  // Both pinned tasks were served by provider B, on the pinned model.
  expect(toB.length).toBeGreaterThanOrEqual(2)
  expect(toB.every(hit => hit.model === PINNED_MODEL)).toBe(true)
  const seenByB = toB.map(hit => lastUserText(hit.body)).join('\n')
  expect(seenByB).toContain('TASK-ONE')
  expect(seenByB).toContain('TASK-TWO')

  // Provider A never saw a pinned task, and never got the pinned model.
  expect(toA.some(hit => hit.text.includes('TASK-ONE') && hit.body.messages.length === 1)).toBe(false)
  expect(toA.every(hit => hit.model !== PINNED_MODEL)).toBe(true)
  // The ordinary subagent ran in-process on provider A.
  expect(toA.some(hit => lastUserText(hit.body).includes('UNPINNED-TASK'))).toBe(true)
  expect(toB.some(hit => hit.text.includes('UNPINNED-TASK'))).toBe(false)

  // Each pinned result came back into the session's own conversation and the
  // session finished on its own provider.
  const followUp = toA.find(hit => hit.text.includes('boot the team') && lastUserText(hit.body).includes('tool_result'))
  expect(followUp).toBeDefined()
  expect(followUp!.text).toContain('B-DONE TASK-ONE')
  expect(followUp!.text).toContain('B-DONE TASK-TWO')
  expect(followUp!.text).toContain('A-SUBAGENT-DONE')

  // The desktop is told where the pinned runs ran; the ordinary one carries no badge.
  const results = events.filter(event => event.type === 'tool_result')
  const badge = (toolUseId: string) => results.find(event => event.toolUseId === toolUseId)?.agentRuntime
  expect(badge('toolu_pin1')).toMatchObject({ providerName: 'Provider B', requestedModel: PINNED_MODEL })
  expect(badge('toolu_pin2')).toMatchObject({ providerName: 'Provider B', requestedModel: PINNED_MODEL })
  expect(badge('toolu_plain')).toBeUndefined()

  // Workers stay hidden and are gone.
  const { conversationService } = await import('../../services/conversationService.js')
  const sessions = (conversationService as unknown as { sessions: Map<string, unknown> }).sessions
  expect(sessions.size).toBe(1)
}, 90_000)
