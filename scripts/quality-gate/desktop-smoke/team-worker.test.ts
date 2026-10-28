import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out: ${label}`)
}

test('mock SDK echo requires the delivered envelope id and production ACK, then resumes its own history', async () => {
  const sandbox = createQualityGateSandbox({ label: 'p3-worker-protocol', seedProviders: false })
  const team = 'protocol-team'
  const project = join(sandbox.configDir, 'projects', 'fixture')
  const transcript = join(project, 'worker-session.jsonl')
  const audit = join(sandbox.configDir, 'worker-audit.jsonl')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'lead-session.jsonl'), '')
  const frames: Array<Record<string, any>> = []
  let socket: { send: (message: string) => unknown } | undefined
  const sdk = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('WebSocket only', { status: 400 }) },
    websocket: { open(ws) { socket = ws }, message(_ws, data) { for (const line of String(data).split('\n').filter(Boolean)) frames.push(JSON.parse(line)) } },
  })
  const command = ['bun', 'run', resolve('scripts/quality-gate/desktop-smoke/fixtures/team-worker.ts'), '--sdk-url', `ws://127.0.0.1:${sdk.port}`, '--team-name', team, '--agent-name', 'builder', '--parent-session-id', 'lead-session', '--model', 'fake-loopback-model']
  const env = { ...sandbox.env, CC_HAHA_TEAM_WORKER: '1', MOCK_SDK_TEAM_WORKER_AUDIT: audit }
  let worker: ReturnType<typeof Bun.spawn> | undefined
  const mailboxAction = async (action: 'write' | 'ack') => {
    const script = `const m = await import('./src/utils/teammateMailbox.ts'); ${action === 'write'
      ? `await m.writeToMailbox('builder', { id: 'msg-protocol-id', from: 'user', text: 'same text', timestamp: new Date().toISOString() }, '${team}')`
      : `await m.markMessagesAsReadByIdentity('builder', '${team}', await m.readUnreadMessages('builder', '${team}'))`}`
    const proc = Bun.spawn(['bun', '-e', script], { cwd: process.cwd(), env: sandbox.env, stdout: 'pipe', stderr: 'pipe' })
    const stderr = new Response(proc.stderr).text()
    expect(await proc.exited, await stderr).toBe(0)
  }
  const readTranscript = () => existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''
  try {
    await mailboxAction('write')
    worker = Bun.spawn([...command, '--session-id', 'worker-session'], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' })
    await until(() => frames.some(frame => frame.subtype === 'init'), 'worker SDK init')
    socket!.send(JSON.stringify({ type: 'user', uuid: 'real-input-uuid', message: { role: 'user', content: [{ type: 'text', text: '<teammate-message teammate_id="user" id="msg-protocol-id">same text</teammate-message>' }] } }))
    await until(() => frames.some(frame => frame.type === 'stream_event'), 'worker received real input frame')
    await Bun.sleep(100)
    expect(readTranscript()).not.toContain('echo-msg-protocol-id')
    // Only this test stands in for the supervisor; the standard lane observes
    // production supervisor ACK and never calls this mark operation itself.
    await mailboxAction('ack')
    await until(() => frames.some(frame => frame.type === 'result'), 'worker result after production mailbox ACK')
    const rows = readTranscript().trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0].uuid).toBe('echo-msg-protocol-id')
    expect(rows[0].message.content[0].text).toContain('id="msg-protocol-id"')
    expect(rows[1].parentUuid).toBe(rows[0].uuid)
    expect(rows[1].message.content[0].text).toBe('Ack: same text')
    const firstTail = rows[1].uuid
    worker.kill()
    await worker.exited
    frames.length = 0
    worker = Bun.spawn([...command, '--resume', 'worker-session'], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' })
    await until(() => frames.some(frame => frame.subtype === 'init'), 'resumed SDK init')
    const events = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(event => event.phase === 'boot')).toMatchObject([
      { resume: false, historyEntries: 0 }, { resume: true, historyEntries: 2, historyTail: firstTail },
    ])
    socket!.send(JSON.stringify({ type: 'user', uuid: 'next-frame', message: { role: 'user', content: [{ type: 'text', text: 'Continue without inventing a mailbox echo' }] } }))
    await until(() => frames.some(frame => frame.type === 'result'), 'resumed worker result')
    const continued = readTranscript().trim().split('\n').map(line => JSON.parse(line))
    expect(continued[2].uuid).toBe('next-frame')
    expect(continued[2].parentUuid).toBe(firstTail)
    expect(continued.filter(row => row.uuid.startsWith('echo-'))).toHaveLength(1)
  } finally {
    if (worker) { worker.kill(); await worker.exited }
    sdk.stop(true)
    sandbox.cleanup()
  }
}, 30_000)
