/** Only team workers are scripted here; the permission smoke keeps its existing mock CLI. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastConversationEntryUuid } from '../../agent-flow/mockToolTurn'

const args = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (process.env.CC_HAHA_TEAM_WORKER !== '1') {
  await import('../../../../src/server/__tests__/fixtures/mock-sdk-cli')
} else {
  // Import the same mailbox read/ack/formatter the CLI uses, under the runner's
  // disposable HOME. Never invent an echo for text not actually delivered here.
  const { readMailboxHistory, formatTeammateMessage } = await import('../../../../src/utils/teammateMailbox')
  const { listTasks, getCanonicalTeamTaskListId } = await import('../../../../src/utils/tasks')
  const { applyTaskDeliveryAction } = await import('../../../../src/utils/taskDelivery')
  const configDir = process.env.CLAUDE_CONFIG_DIR
  const sessionId = arg('--session-id') || arg('--resume')
  const teamName = arg('--team-name')
  const member = arg('--agent-name')
  const parentSessionId = arg('--parent-session-id')
  const sdkUrl = arg('--sdk-url')
  if (!configDir || !sessionId || !teamName || !member || !parentSessionId || !sdkUrl || !process.env.MOCK_SDK_TEAM_WORKER_AUDIT) throw new Error('Team smoke worker requires sandbox config, audit and SDK identity')
  const project = readdirSync(join(configDir, 'projects')).find(directory => existsSync(join(configDir, 'projects', directory, `${parentSessionId}.jsonl`)))
  if (!project) throw new Error('Worker has no real parent transcript')
  const transcript = join(configDir, 'projects', project, `${sessionId}.jsonl`)
  const history = existsSync(transcript) ? readFileSync(transcript, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  if (args.includes('--resume') && history.length === 0) throw new Error('Resumed worker has no saved conversation')
  const audit = (phase: string, extra: Record<string, unknown> = {}) => {
    appendFileSync(process.env.MOCK_SDK_TEAM_WORKER_AUDIT!, JSON.stringify({ phase, member, sessionId, pid: process.pid, model: arg('--model'), baseUrl: process.env.ANTHROPIC_BASE_URL, ...extra }) + '\n')
  }
  audit('boot', { resume: args.includes('--resume'), historyEntries: history.length, historyTail: history.at(-1)?.uuid })
  mkdirSync(join(configDir, 'projects', project), { recursive: true })
  if (!existsSync(transcript)) writeFileSync(transcript, '')
  const ws = new WebSocket(sdkUrl)
  const emit = (payload: Record<string, unknown>) => ws.send(JSON.stringify({ ...payload, session_id: sessionId }) + '\n')
  const append = (type: 'user' | 'assistant', uuid: string, text: string) => {
    const parentUuid = lastConversationEntryUuid(readFileSync(transcript, 'utf8'))
    appendFileSync(transcript, JSON.stringify({ type, uuid, parentUuid, sessionId, cwd: process.cwd(), isSidechain: false, timestamp: new Date().toISOString(), message: { role: type, ...(type === 'assistant' ? { model: arg('--model') } : {}), content: [{ type: 'text', text }] } }) + '\n')
  }
  let turns = Promise.resolve()
  ws.addEventListener('open', () => emit({ type: 'system', subtype: 'init', model: arg('--model'), slash_commands: [] }))
  ws.addEventListener('close', () => process.exit(0))
  ws.addEventListener('message', event => {
    for (const line of String(event.data).split('\n').filter(Boolean)) {
      const frame = JSON.parse(line)
      if (frame.type === 'control_request') {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
        if (frame.request?.subtype === 'interrupt') emit({ type: 'result', subtype: 'success', is_error: false, result: 'Interrupted', usage: { input_tokens: 0, output_tokens: 0 } })
      }
      if (frame.type !== 'user') continue
      turns = turns.then(async () => {
        const text = (frame.message?.content ?? []).filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n')
        audit('release', { text })
        emit({ type: 'stream_event', event: { type: 'message_start' } })
        const delivered = (await readMailboxHistory(member, teamName)).filter(message => message.id && text.includes(`id="${message.id}"`))
        const direct = delivered.filter(message => message.from === 'user')
        const gate = process.env.MOCK_SDK_TEAM_ECHO_GATE
        if (direct.length > 0 && gate) while (existsSync(gate)) await Bun.sleep(50)
        // The production supervisor owns the ACK. Observe it; never mark the
        // fixture's own success, which could conceal a missing production ACK.
        const deadline = Date.now() + 10_000
        while (delivered.length > 0) {
          const inbox = await readMailboxHistory(member, teamName)
          if (delivered.every(message => inbox.some(entry => entry.id === message.id && entry.read === true))) break
          if (Date.now() > deadline) throw new Error('Production supervisor did not ACK its delivered batch')
          await Bun.sleep(50)
        }
        for (const message of direct) {
          append('user', `echo-${message.id}`, formatTeammateMessage(message))
          audit('ack', { messageId: message.id, from: message.from, text: message.text })
        }
        if (direct.length === 0) append('user', frame.uuid || crypto.randomUUID(), text)
        for (const task of await listTasks(getCanonicalTeamTaskListId(teamName))) {
          if (task.owner !== member || task.subject !== 'P3 dynamic delivery') continue
          const latest = task.delivery?.submissions.at(-1)
          if (!latest || latest.review?.decision === 'return') {
            const version = (latest?.version ?? 0) + 1
            const result = await applyTaskDeliveryAction(teamName, task.id, member, { action: 'submit', requestId: `p3-${task.id}-v${version}`, expectedRevision: task.delivery?.revision ?? 0, version, artifact: `artifact:p3-v${version}.txt`, criteria: version === 1 ? 'draft checklist' : 'checklist includes rollback' })
            audit('submit', { taskId: task.id, version, revision: result.task.delivery?.revision })
          }
        }
        const reply = direct.length > 0 ? `Ack: ${direct.map(message => message.text).join('; ')}` : 'Smoke worker is waiting for instructions.'
        append('assistant', crypto.randomUUID(), reply)
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
        emit({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: 0, output_tokens: 0 } })
      }).catch(error => { audit('error', { error: String(error) }); console.error(error); process.exit(1) })
    }
  })
}
