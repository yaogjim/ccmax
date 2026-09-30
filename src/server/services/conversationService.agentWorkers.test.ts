import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService, type AgentWorkerStart } from './conversationService.js'
import { ProviderService } from './providerService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'agent-workers-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(home, { recursive: true, force: true })
})

const worker: AgentWorkerStart = {
  parentSessionId: 'parent',
  agentType: 'niuma',
  runId: 'run-1',
  systemPrompt: 'You are niuma, a worker.',
  tools: ['Read', 'Grep'],
  agentDefinition: { disallowedTools: ['Bash'], maxTurns: 3 },
}

function argsFor(options: Record<string, unknown>) {
  const service = new ConversationService() as any
  service.resolveCliArgs = (args: string[]) => args
  return service.buildSessionCliArgs('child', 'ws://127.0.0.1/sdk/child?token=fake', false, options) as string[]
}

test('pinned worker args carry the agent preset but no team identity or team tools', () => {
  const args = argsFor({ model: 'deepseek-flash', providerId: 'provider-b', agentWorker: worker })

  // Team identity is what makes the CLI look for a team file and mailbox.
  for (const flag of ['--agent-id', '--agent-name', '--team-name', '--parent-session-id']) {
    expect(args).not.toContain(flag)
  }
  expect(args).not.toContain('--no-session-persistence')
  expect(args[args.indexOf('--agent') + 1]).toBe('niuma')
  const agent = JSON.parse(args[args.indexOf('--agents') + 1]!).niuma
  expect(agent.prompt).toBe('You are niuma, a worker.')
  expect(agent.model).toBe('deepseek-flash')
  expect(agent.tools).toEqual(['Read', 'Grep'])
  expect(agent.disallowedTools).toEqual(['Bash'])
  expect(typeof agent.description).toBe('string')
  expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash')
  expect(args[args.indexOf('--max-turns') + 1]).toBe('3')
  // Exactly the agent's own tools: SendMessage/Task* only exist to talk to a team.
  expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep')
  expect(args[args.indexOf('--model') + 1]).toBe('deepseek-flash')
})

test('pinned worker without an allowlist or with a wildcard does not restrict --tools', () => {
  expect(argsFor({ agentWorker: { ...worker, tools: undefined } })).not.toContain('--tools')
  expect(argsFor({ agentWorker: { ...worker, tools: ['*'] } })).not.toContain('--tools')
  const bare = argsFor({ agentWorker: { ...worker, agentDefinition: undefined } })
  expect(bare).not.toContain('--disallowedTools')
  expect(bare).not.toContain('--max-turns')
})

test('ordinary and team sessions are unaffected by the pinned worker branch', () => {
  const ordinary = argsFor({})
  expect(ordinary).not.toContain('--agent')
  expect(ordinary).not.toContain('--agents')
  const team = argsFor({ teamWorker: { parentSessionId: 'p', teamName: 't', memberId: 'm', name: 'reader', systemPrompt: 's', tools: ['Read'] } })
  expect(team[team.indexOf('--team-name') + 1]).toBe('t')
  expect(team[team.indexOf('--tools') + 1]).toContain('SendMessage')
})

function sse(text: string) {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
    + ev('message_stop', { type: 'message_stop' })
}

// The feasibility gate for the whole pinned-agent design: the *real* CLI (not a
// fixture) must start from these args and finish a turn without any team file,
// team identity or worktree. Loopback upstream and fake credentials only.
test('the real CLI runs a pinned worker to a result with no team file, on the pinned provider only', async () => {
  delete process.env.NODE_ENV // bun test sets "test", which the CLI treats as a non-interactive dry environment
  const upstream: Array<{ path: string; model?: string; credential: string | null; tools: string[]; system: string }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: any = await request.json().catch(() => ({}))
    upstream.push({ path: new URL(request.url).pathname, model: body.model, credential: request.headers.get('x-api-key') || request.headers.get('authorization'), tools: (body.tools ?? []).map((tool: any) => tool.name), system: JSON.stringify(body.system ?? '') })
    return new Response(sse('pinned worker ok'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const service = new ConversationService()
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, bridgeServer) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return bridgeServer.upgrade(request, { data: { id } }) ? undefined : new Response('bad', { status: 400 })
    },
    websocket: { open(ws) { service.attachSdkConnection(ws.data.id, ws) }, message(ws, message) { service.handleSdkPayload(ws.data.id, String(message)) }, close(ws) { service.detachSdkConnection(ws.data.id, ws) } },
  })
  try {
    const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'B', baseUrl: server.url.toString().replace(/\/$/, ''), apiKey: 'fake-b', models: { main: 'deepseek-flash', sonnet: 'deepseek-flash', opus: 'deepseek-flash', haiku: 'deepseek-flash' } })
    const id = crypto.randomUUID()
    await service.startSession(id, home, `ws://127.0.0.1:${bridge.port}/sdk/${id}?token=fixture`, {
      providerId: provider.id, model: 'deepseek-flash',
      agentWorker: { ...worker, tools: ['Read'], agentDefinition: { maxTurns: 2 } },
    })
    await service.requestControl(id, { subtype: 'set_model', model: 'deepseek-flash' }, 20_000)
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pinned worker produced no result')), 60_000)
      service.onOutput(id, message => { if (message.type === 'result') { clearTimeout(timer); resolve(message) } })
      void service.sendMessage(id, 'do the task')
    })
    expect(result.is_error).toBe(false)
    expect(result.result).toBe('pinned worker ok')

    // Only the model call reaches the pinned provider, with its credential, its
    // model, the agent's prompt and the agent's own tools (no team tools).
    const call = upstream.find(entry => entry.path === '/v1/messages')!
    expect(call.model).toBe('deepseek-flash')
    expect(call.credential).toBe('Bearer fake-b')
    expect(call.tools).toEqual(['Read'])
    expect(call.system).toContain('You are niuma, a worker.')

    // No team was created, and the session works in the requested directory.
    await expect(stat(join(home, 'teams'))).rejects.toThrow()
    expect(service.getSessionWorkDir(id)).toBe(home)
    // The transcript is tagged so the session list hides it.
    const projects = join(home, 'projects')
    const transcripts = (await readdir(projects, { recursive: true })).filter(entry => String(entry).endsWith(`${id}.jsonl`))
    expect(transcripts).toHaveLength(1)
    expect(await readFile(join(projects, String(transcripts[0])), 'utf-8')).toContain('"entrypoint":"claude-desktop-pinned-agent"')
  } finally {
    await service.stopAllSessionsAndWait(2000)
    bridge.stop(true)
    server.stop(true)
  }
}, 90_000)

test('a pinned worker start does not consult the session launch record or persist parent-style metadata', async () => {
  const service = new ConversationService() as any
  let launchLookups = 0
  const { sessionService } = await import('./sessionService.js')
  const original = sessionService.getSessionLaunchInfo.bind(sessionService)
  sessionService.getSessionLaunchInfo = async (...args: any[]) => { launchLookups++; return original(...args) }
  service.resolveCliArgs = () => [process.execPath, '-e', 'setTimeout(()=>{},20000)']
  try {
    await service.startSession('pinned-child', home, 'ws://127.0.0.1:1/sdk/pinned-child?token=t', { agentWorker: worker })
    expect(launchLookups).toBe(0)
    expect(service.sessions.get('pinned-child').agentWorker).toEqual(worker)
    expect(service.sessions.get('pinned-child').teamWorker).toBeUndefined()
  } finally {
    sessionService.getSessionLaunchInfo = original
    service.stopSession('pinned-child')
  }
})

test('a worker child sets the pinned-agent environment and drops inherited subagent overrides', async () => {
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'wrong-inherited-model'
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max'
  const service = new ConversationService() as any
  let captured: NodeJS.ProcessEnv | undefined
  const spawn = Bun.spawn
  ;(Bun as any).spawn = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
    captured = options.env
    return spawn([process.execPath, '-e', 'setTimeout(()=>{},20000)'], options as any)
  }
  service.resolveCliArgs = (args: string[]) => args
  try {
    await service.startSession('env-child', home, 'ws://127.0.0.1:1/sdk/env-child?token=t', { agentWorker: { ...worker, agentDefinition: { source: 'plugin', omitClaudeMd: true } } })
  } finally {
    ;(Bun as any).spawn = spawn
    service.stopSession('env-child')
  }
  expect(captured?.CC_HAHA_TEAM_WORKER).toBe('1')
  expect(captured?.CC_HAHA_PINNED_AGENT_WORKER).toBe('1')
  expect(captured?.CC_HAHA_TEAM_WORKER_PRESET_TYPE).toBe('niuma')
  expect(captured?.CC_HAHA_TEAM_WORKER_PRESET_SOURCE).toBe('plugin')
  expect(captured?.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD).toBe('1')
  expect(captured?.CC_HAHA_TRANSCRIPT_ENTRYPOINT).toBe('claude-desktop-pinned-agent')
  expect(captured?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
  expect(captured?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(captured?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined()
})

test('ordinary sessions never get the pinned-agent environment', async () => {
  const service = new ConversationService() as any
  const env = await service.buildChildEnv(home, 'ws://127.0.0.1/sdk/a?token=a', {})
  expect(env.CC_HAHA_PINNED_AGENT_WORKER).toBeUndefined()
  expect(env.CC_HAHA_TEAM_WORKER).toBeUndefined()
})

function harness() {
  const service = new ConversationService() as any
  const responses: any[] = []
  const parentOutput: any[] = []
  const killed: string[] = []
  service.killProcess = (id: string) => killed.push(id)
  const state = () => ({ pendingPermissionRequests: new Map(), pendingControlRequests: new Map(), sdkMessages: [], outputCallbacks: [] as Array<(m: any) => void>, pendingOutbound: [] as string[] })
  const child = { ...state(), agentWorker: worker, sdkSocket: { send: (message: string) => responses.push(JSON.parse(message)) } }
  return { service, responses, parentOutput, killed, state, child }
}

const permissionRequest = { type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/x' }, tool_use_id: 'tu-1' } }

test('a pinned worker permission request is relayed to the parent under the agent identity, and the parent answers it', () => {
  const { service, responses, parentOutput, state, child } = harness()
  service.sessions.set('parent', { ...state(), outputCallbacks: [(message: any) => parentOutput.push(message)] })
  service.sessions.set('child', child)

  service.handleSdkPayload('child', JSON.stringify(permissionRequest))

  expect(parentOutput).toHaveLength(1)
  expect(parentOutput[0].request.agent_id).toBe('niuma@run-1')
  expect(parentOutput[0].request.display_name).toBe('niuma')
  expect(parentOutput[0].request.tool_name).toBe('Read')
  expect(service.getPendingPermissionRequests('parent')).toEqual([
    { requestId: 'perm-1', toolName: 'Read', toolUseId: 'tu-1', input: { file_path: '/x' }, displayName: 'niuma', agentId: 'niuma@run-1' },
  ])
  expect(service.getPendingPermissionToolName('parent', 'perm-1')).toBe('Read')

  expect(service.respondToPermission('parent', 'perm-1', true, undefined, { file_path: '/x' })).toBe(true)
  expect(responses).toHaveLength(1)
  expect(responses[0].response.request_id).toBe('perm-1')
  expect(responses[0].response.response.behavior).toBe('allow')
  expect(child.pendingPermissionRequests.size).toBe(0)
})

test('a pinned worker permission request is refused at once when the parent no longer exists', () => {
  const { service, responses, state, child } = harness()
  const seen: any[] = []
  child.outputCallbacks.push(message => seen.push(message))
  service.sessions.set('child', child)

  service.handleSdkPayload('child', JSON.stringify(permissionRequest))

  expect(responses).toHaveLength(1)
  expect(responses[0].response.request_id).toBe('perm-1')
  expect(responses[0].response.response.behavior).toBe('deny')
  expect(String(responses[0].response.response.message)).toContain('parent session')
  // Nothing is left pending, so it cannot be answered twice or replayed later.
  expect(child.pendingPermissionRequests.size).toBe(0)
  expect(seen).toEqual([])
  void state
})

test('a team worker with no parent still waits instead of being refused (behavior preserved)', () => {
  const { service, responses, state } = harness()
  const teamChild = { ...state(), teamWorker: { parentSessionId: 'gone', teamName: 't', memberId: 'm', name: 'reader', systemPrompt: 's' }, sdkSocket: { send: (message: string) => responses.push(JSON.parse(message)) } }
  service.sessions.set('child', teamChild)
  service.handleSdkPayload('child', JSON.stringify(permissionRequest))
  expect(responses).toEqual([])
  expect(teamChild.pendingPermissionRequests.size).toBe(1)
})

test('stopping the parent stops its pinned workers and cancels their relayed approvals', () => {
  const { service, parentOutput, killed, state, child } = harness()
  service.sessions.set('parent', { ...state(), outputCallbacks: [(message: any) => parentOutput.push(message)] })
  child.pendingPermissionRequests.set('approval', { toolName: 'Bash', input: {} })
  service.sessions.set('child', child)
  service.sessions.set('other', { ...state(), agentWorker: { ...worker, parentSessionId: 'someone-else' } })

  service.stopSession('parent')

  expect(killed).toEqual(['child', 'parent'])
  expect(service.hasSession('child')).toBe(false)
  expect(service.hasSession('other')).toBe(true)
  expect(parentOutput).toContainEqual({ type: 'control_cancel_request', request_id: 'approval' })
})

test('stopSessionAndWait stops pinned workers of the parent first', async () => {
  const { service, state, child } = harness()
  const stopped: string[] = []
  service.stopProcessAndWait = async (id: string) => { stopped.push(id) }
  service.sessions.set('parent', state())
  service.sessions.set('child', child)

  await service.stopSessionAndWait('parent', 50)

  expect(stopped).toEqual(['child', 'parent'])
  expect(service.hasSession('child')).toBe(false)
})

test('a parent CLI process exit stops its pinned workers', async () => {
  const { service, killed, state, child } = harness()
  const proc = {} as any
  service.sessions.set('parent', { ...state(), proc, startupPending: true })
  service.sessions.set('child', child)

  await service.handleProcessExit('parent', proc, 137)

  expect(killed).toEqual(['child'])
  expect(service.hasSession('child')).toBe(false)
})

test('interrupting the parent stops its pinned workers', () => {
  const { service, killed, state, child } = harness()
  service.sessions.set('parent', state())
  service.sessions.set('child', child)
  service.sendInterrupt('parent')
  expect(killed).toContain('child')
})
