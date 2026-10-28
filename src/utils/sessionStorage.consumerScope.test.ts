import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { switchSession } from '../bootstrap/state.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import {
  captureTranscriptBinding, flushSessionStorage, getAgentTranscriptPath, getTranscriptPath, loadTranscriptFromFile,
  readAgentMetadata, recordTranscript, resetProjectForTesting, writeAgentMetadata,
} from './sessionStorage.js'

const originalEnv = { ...process.env }
let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'transcript-scope-'))
  const env = createSandboxedTestEnvironment(home, { TEST_ENABLE_SESSION_PERSISTENCE: '1' })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  switchSession(asSessionId('11111111-1111-4111-8111-111111111111'))
  resetProjectForTesting()
})
afterAll(async () => {
  await flushSessionStorage()
  resetProjectForTesting()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

const scope = {
  version: 1 as const, teamName: 'fixture', generation: 1, createdAt: 10,
  leadSessionId: '11111111-1111-4111-8111-111111111111',
  ownerSessionId: '11111111-1111-4111-8111-111111111111', recipient: { kind: 'lead' as const },
}

test('transcript captures binding before asynchronous persistence and preserves future fields', async () => {
  const captured = { ...scope, futureField: { keep: true } }
  const message = {
    type: 'user', uuid: '22222222-2222-4222-8222-222222222222',
    message: { role: 'user', content: 'fixture' },
  } as Message
  const pending = recordTranscript([message], { consumerScope: captured } as never)
  captured.generation = 2
  await pending
  await flushSessionStorage()
  const entries = (await readFile(getTranscriptPath(), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(entries.find(entry => entry.uuid === message.uuid)?.consumerScope).toEqual({
    ...scope, futureField: { keep: true },
  })
})

test('compaction and reload preserve the explicit binding rather than current writer identity', async () => {
  const boundary = {
    type: 'system', subtype: 'compact_boundary', uuid: '33333333-3333-4333-8333-333333333333',
    timestamp: '2026-10-27T00:00:00Z', content: 'Compacted', level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 100 },
  } as Message
  const summary = {
    type: 'user', uuid: '44444444-4444-4444-8444-444444444444',
    timestamp: '2026-10-27T00:00:01Z', message: { role: 'user', content: 'summary' },
    isCompactSummary: true,
  } as Message
  captureTranscriptBinding([boundary, summary], { ...scope, futureField: 'retained' })
  await recordTranscript([boundary, summary], { consumerScope: { ...scope, generation: 99 } })
  await flushSessionStorage()
  const loaded = await loadTranscriptFromFile(getTranscriptPath())
  expect(loaded.messages.map(message => (message as unknown as { consumerScope: unknown }).consumerScope)).toEqual([
    { ...scope, futureField: 'retained' }, { ...scope, futureField: 'retained' },
  ])
})

test('explicit undefined binding persists an unbound barrier instead of falling back to older identity', async () => {
  const message = { type: 'user', uuid: '55555555-5555-4555-8555-555555555555', timestamp: '2026-10-27T00:00:02Z', message: { role: 'user', content: 'legacy carrier' }, consumerScope: undefined } as Message
  await recordTranscript([message], { consumerScope: scope })
  await flushSessionStorage()
  const loaded = await loadTranscriptFromFile(getTranscriptPath())
  expect((loaded.messages.at(-1) as unknown as { consumerScope: unknown }).consumerScope).toBeNull()
})

test('updating old metadata preserves unknown fields and the original consumer binding', async () => {
  const id = asAgentId('fixture-member')
  await writeAgentMetadata(id, { agentType: 'general-purpose' })
  const metadataPath = getAgentTranscriptPath(id).replace(/\.jsonl$/, '.meta.json')
  await writeFile(metadataPath, JSON.stringify({ agentType: 'general-purpose', future: { enabled: true }, consumerScope: { ...scope, futureScope: true, recipient: { ...scope.recipient, futureRecipient: true } }, parentSessionId: scope.ownerSessionId }))
  await writeAgentMetadata(id, { agentType: 'general-purpose', description: 'follow-up', consumerScope: scope })
  expect(await readAgentMetadata(id)).toEqual({
    agentType: 'general-purpose', future: { enabled: true }, consumerScope: { ...scope, futureScope: true, recipient: { ...scope.recipient, futureRecipient: true } },
    parentSessionId: scope.ownerSessionId, description: 'follow-up',
  })
})
