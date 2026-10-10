/**
 * The mock runtime must persist a normal tool turn to the session JSONL.
 *
 * `MOCK_TOOL` streams `tool_use → can_use_tool → permission_request → tool_result →
 * result` and touches the fixture file, but writes no transcript. The desktop shows
 * the live cards, then refetches `/messages` once the turn completes and replaces
 * them with the empty history on disk. Nothing proved that, because the only
 * observable the smoke asserted was the file the tool wrote.
 *
 * These are pure-function tests over the transcript shape the fixture writes: a real
 * user entry, a real assistant `tool_use` entry, and a real user `tool_result`
 * entry, chained by uuid/parentUuid like the CLI writes them. The mock CLI imports
 * the builder so its protocol output and its transcript cannot drift.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMockToolTranscript,
  lastConversationEntryUuid,
  persistMockToolTranscript,
  shouldEmitMockToolReplyFrame,
  toolResultEntryId,
} from './mockToolTurn'

describe('mock tool transcript', () => {
  const base = {
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: '/tmp/mock-tool-project',
    prompt: 'MOCK_TOOL {"tool":"Write"}',
    toolUseId: 'toolu_abcdef0123456789abcd',
    toolName: 'Write',
    input: { file_path: '/tmp/mock-tool-project/out.txt', content: 'hello' },
    resultContent: 'wrote out.txt',
    isError: false,
    timestamp: '2026-10-09T00:00:00.000Z',
  }

  test('links user → assistant tool_use → user tool_result through a real parentUuid chain', () => {
    const entries = buildMockToolTranscript(base)

    expect(entries.map((entry) => entry.type)).toEqual(['user', 'assistant', 'user'])
    const [user, assistant, result] = entries

    expect(user.parentUuid).toBeNull()
    expect(user.uuid).toBeString()
    expect(assistant.parentUuid).toBe(user.uuid)
    expect(result.parentUuid).toBe(assistant.uuid)
    // No duplicate ids: the chain only walks if every hop is distinct.
    expect(new Set(entries.map((entry) => entry.uuid)).size).toBe(3)
  })

  test('carries the tool_use id from the streaming block so the result can resolve it', () => {
    const [, assistant, result] = buildMockToolTranscript(base)

    const toolUse = assistant.message.content.find((block) => block.type === 'tool_use')
    expect(toolUse).toMatchObject({ type: 'tool_use', id: base.toolUseId, name: 'Write' })
    expect(toolUse?.input).toEqual(base.input)
    expect(result.message.content).toEqual([
      { type: 'tool_result', tool_use_id: base.toolUseId, content: base.resultContent, is_error: false },
    ])
  })

  test('makes entryToMessage classify the turn as tool_use plus tool_result', () => {
    const [, assistant, result] = buildMockToolTranscript(base)
    // Mirrors sessionService.entryToMessage: an assistant turn with a tool_use block
    // is a `tool_use` message, and a user turn with a tool_result block is a
    // `tool_result` message. Those are exactly the two cards the desktop renders.
    expect(assistant.message.content.some((block) => block.type === 'tool_use')).toBe(true)
    expect(result.message.content.some((block) => block.type === 'tool_result')).toBe(true)
  })

  test('marks a failed tool result as an error without changing the chain', () => {
    const entries = buildMockToolTranscript({ ...base, isError: true, resultContent: 'exit code 1' })
    const result = entries[2]
    expect(result.message.content[0]).toMatchObject({ is_error: true, content: 'exit code 1' })
    expect(result.parentUuid).toBe(entries[1].uuid)
  })

  test('appends the reply as a final assistant text entry chained after the result', () => {
    const entries = buildMockToolTranscript({ ...base, reply: 'wrote out.txt' })

    expect(entries.map(entry => entry.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const reply = entries[3]
    expect(reply.parentUuid).toBe(entries[2].uuid)
    expect(reply.message.content).toEqual([{ type: 'text', text: 'wrote out.txt' }])
    // Four distinct ids: a reused uuid would cut the chain.
    expect(new Set(entries.map(entry => entry.uuid)).size).toBe(4)
  })

  test('omits the reply entry when the turn has no reply text', () => {
    expect(buildMockToolTranscript(base)).toHaveLength(3)
  })

  test('uses the prompt uuid as the user entry id when one is supplied', () => {
    const entries = buildMockToolTranscript({ ...base, promptUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(entries[0].uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    // A supplied prompt uuid must not collide with the result id.
    expect(toolResultEntryId(entries)).toBe(entries[2].uuid)
  })

  test('stamps the session id and cwd on every entry', () => {
    for (const entry of buildMockToolTranscript(base)) {
      expect(entry.sessionId).toBe(base.sessionId)
      expect(entry.cwd).toBe(base.cwd)
    }
  })
})

describe('mock tool reply frame gating', () => {
  test('does not stream the reply frame unless the turn opts into persistence', () => {
    // Regression: the plain MOCK_TOOL protocol must keep its historical frame
    // sequence. Emitting the assistant frame by default changed the wire protocol
    // for every existing prompt that carries a `reply` (e.g. the side-chat tool
    // turn), so the frame is only part of the opt-in persisted turn.
    expect(shouldEmitMockToolReplyFrame({ allowed: true, reply: 'wrote out.txt' })).toBe(false)
    expect(shouldEmitMockToolReplyFrame({ allowed: true, reply: 'wrote out.txt', persist: true })).toBe(true)
  })

  test('never streams the frame for a denied or failing turn', () => {
    expect(shouldEmitMockToolReplyFrame({ allowed: false, reply: 'x', persist: true })).toBe(false)
    expect(shouldEmitMockToolReplyFrame({ allowed: true, failWith: 'exit 1', reply: 'x', persist: true })).toBe(false)
  })

  test('treats an absent or empty reply as no frame', () => {
    expect(shouldEmitMockToolReplyFrame({ allowed: true, persist: true })).toBe(false)
    expect(shouldEmitMockToolReplyFrame({ allowed: true, persist: true, reply: '' })).toBe(false)
  })

  test('the fixture decides the frame through the shared predicate', () => {
    const fixture = readFileSync('src/server/__tests__/fixtures/mock-sdk-cli.ts', 'utf8')
    expect(fixture).toContain('shouldEmitMockToolReplyFrame(')
    // The gate must read the caller's opt-in, never default it on.
    expect(fixture).toContain('persist: step.persist')
  })
})

describe('mock tool transcript tail chaining', () => {
  const entry = (type: string, uuid: string) => JSON.stringify({ type, uuid })

  test('returns the last user/assistant uuid and skips trailing metadata', () => {
    // Metadata records are not part of the conversation; chaining a new turn to
    // their uuid would detach it from the real chain.
    const raw = [entry('user', 'u1'), entry('assistant', 'a1'), entry('session-meta', 'meta-last')].join('\n') + '\n'
    expect(lastConversationEntryUuid(raw)).toBe('a1')
  })

  test('returns null when there is no conversational entry', () => {
    expect(lastConversationEntryUuid('')).toBeNull()
    expect(lastConversationEntryUuid(`${entry('session-meta', 'm1')}\n`)).toBeNull()
  })

  const sessionId = '11111111-2222-3333-4444-555555555555'
  const turnBase = {
    sessionId,
    cwd: '/tmp/mock-tool-project',
    toolName: 'Write',
    input: {},
    isError: false,
    timestamp: '2026-10-09T00:00:00.000Z',
  }

  function setup() {
    const configDir = mkdtempSync(join(tmpdir(), 'mock-tool-chain-'))
    const directory = join(configDir, 'projects', 'mock-project')
    mkdirSync(directory, { recursive: true })
    return { configDir, file: join(directory, `${sessionId}.jsonl`) }
  }

  test('chains two consecutive persisted turns into one walkable chain', async () => {
    const { configDir, file } = setup()
    try {
      const seedUuid = 'earlier-user-entry'
      writeFileSync(file, `${entry('user', seedUuid)}\n`)
      const turnA = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL a', toolUseId: 'toolu_a', resultContent: 'ok a' })
      const turnB = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL b', toolUseId: 'toolu_b', resultContent: 'ok b' })

      expect(await persistMockToolTranscript(configDir, sessionId, turnA)).toBe(true)
      expect(await persistMockToolTranscript(configDir, sessionId, turnB)).toBe(true)

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const aFirst = lines.find((row) => row.uuid === turnA[0].uuid)
      const bFirst = lines.find((row) => row.uuid === turnB[0].uuid)
      // Turn A chains to the transcript it was appended onto; turn B chains to A,
      // instead of both restarting at null.
      expect(aFirst.parentUuid).toBe(seedUuid)
      expect(bFirst.parentUuid).toBe(turnA[turnA.length - 1].uuid)
      expect(bFirst.parentUuid).not.toBeNull()

      const byUuid = new Map(lines.map((row) => [row.uuid, row]))
      let cursor = bFirst
      const walked: string[] = []
      while (cursor?.parentUuid) {
        cursor = byUuid.get(cursor.parentUuid)
        walked.push(cursor.uuid)
      }
      expect(cursor.uuid).toBe(seedUuid)
      expect(walked.length).toBeGreaterThanOrEqual(4)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('skips a metadata tail when chaining the next turn', async () => {
    const { configDir, file } = setup()
    try {
      writeFileSync(file, '')
      const turnA = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL a', toolUseId: 'toolu_a', resultContent: 'ok a', reply: 'done a' })
      await persistMockToolTranscript(configDir, sessionId, turnA)
      const metadataUuid = 'meta-after-turn'
      writeFileSync(file, readFileSync(file, 'utf8') + `${entry('session-meta', metadataUuid)}\n`)
      const turnB = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL b', toolUseId: 'toolu_b', resultContent: 'ok b' })
      await persistMockToolTranscript(configDir, sessionId, turnB)

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const bFirst = lines.find((row) => row.uuid === turnB[0].uuid)
      expect(bFirst.parentUuid).toBe(turnA[turnA.length - 1].uuid)
      expect(bFirst.parentUuid).not.toBe(metadataUuid)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('leaves the first turn of an empty transcript rooted at null', async () => {
    const { configDir, file } = setup()
    try {
      writeFileSync(file, '')
      const turn = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL a', toolUseId: 'toolu_a', resultContent: 'ok a' })
      await persistMockToolTranscript(configDir, sessionId, turn)
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      expect(lines[0].parentUuid).toBeNull()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('reports false when no transcript file exists for the session', async () => {
    const { configDir } = setup()
    try {
      const turn = buildMockToolTranscript({ ...turnBase, prompt: 'MOCK_TOOL a', toolUseId: 'toolu_a', resultContent: 'ok a' })
      expect(await persistMockToolTranscript(configDir, 'missing-session', turn)).toBe(false)
      expect(await persistMockToolTranscript(undefined, sessionId, turn)).toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})