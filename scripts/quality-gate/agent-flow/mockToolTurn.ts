/**
 * Pure builder for the transcript a `MOCK_TOOL` turn persists.
 *
 * The fixture (`src/server/__tests__/fixtures/mock-sdk-cli.ts`) streams tool cards
 * but used to write nothing to the session JSONL, so a completed turn's live cards
 * were replaced by an empty history the next time the desktop fetched `/messages`.
 * Keeping the record shape here rather than inline in the fixture lets a unit test
 * pin the uuid/parentUuid/toolUse chain the real renderer depends on, and lets the
 * desktop smoke assert the same shape it fetches back.
 *
 * The shape mirrors what the real CLI writes (`src/utils/sessionStorage.ts`): a user
 * entry, then a one-block assistant entry carrying the `tool_use`, then the user
 * entry carrying its `tool_result`. Entry ids are chained through `parentUuid`, and
 * the `tool_use_id` on the result matches the `id` on the streaming tool block so
 * `entryToMessage` can resolve the pair.
 */

export type MockToolContentBlock = Record<string, unknown>

export type MockToolTranscriptEntry = {
  type: 'user' | 'assistant'
  uuid: string
  parentUuid: string | null
  sessionId: string
  isSidechain: false
  cwd: string
  timestamp: string
  userType?: 'external'
  message: {
    id?: string
    type?: 'message'
    role: 'user' | 'assistant'
    model?: string
    content: MockToolContentBlock[]
  }
}

export type MockToolTranscriptInput = {
  sessionId: string
  cwd: string
  /** The user prompt as it arrived; persisted verbatim like the real CLI does. */
  prompt: string
  /** uuid of the incoming user frame, when the runtime supplied one. */
  promptUuid?: string
  /** Id of the streamed `tool_use` block; the result resolves against it. */
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  resultContent: string
  isError: boolean
  /** Assistant text the turn ends with; persisted as a following assistant entry. */
  reply?: string
  /** ISO timestamp shared by the whole turn. */
  timestamp: string
}

function newUuid(): string {
  return crypto.randomUUID()
}

/**
 * Whether a `MOCK_TOOL` turn streams the closing assistant text frame.
 *
 * The frame belongs to the *opt-in persisted* turn, not the plain protocol. A
 * default prompt (`persist` absent) has to keep the historical wire sequence
 * (`tool_use → can_use_tool → tool_result → result`) that the side-chat protocol
 * and every existing assertion reason about, so the frame only appears when the
 * turn will also write its reply to the transcript. Denied and failing turns never
 * carry it, exactly as before.
 */
export function shouldEmitMockToolReplyFrame(input: {
  /** The approval decision for the streaming `tool_use` block. */
  allowed: boolean
  /** The step asks the tool to fail even when allowed. */
  failWith?: string
  /** The turn opts into transcript persistence. */
  persist?: true
  /** Assistant text the caller supplied. */
  reply?: string
}): boolean {
  return input.allowed &&
    input.failWith === undefined &&
    input.persist === true &&
    typeof input.reply === 'string' &&
    input.reply.length > 0
}

/**
 * uuid of the last conversational entry in a transcript, or null when there is none.
 *
 * A turn appended to an existing transcript must chain its first entry to the
 * previous turn's last `user`/`assistant` entry. Leaving `parentUuid: null` on every
 * turn's first entry cuts the chain the real CLI maintains, so a resume or replay
 * that walks parents dead-ends at the seam. Metadata records (`session-meta`,
 * snapshots, summaries) are skipped: their own `uuid` is not part of the
 * conversation, and chaining to it would detach the new turn from the real chain.
 */
export function lastConversationEntryUuid(raw: string): string | null {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: { type?: unknown; uuid?: unknown }
    try {
      entry = JSON.parse(lines[index]) as { type?: unknown; uuid?: unknown }
    } catch {
      continue
    }
    if ((entry.type === 'user' || entry.type === 'assistant') && typeof entry.uuid === 'string') {
      return entry.uuid
    }
  }
  return null
}

/**
 * Build the JSONL entries for one persisted tool turn.
 *
 * The shape is a user prompt, an assistant entry holding the `tool_use`, the user
 * entry holding its `tool_result`, and — when the turn has a reply — a final
 * assistant text entry. Each entry chains to the previous through `parentUuid`.
 */
export function buildMockToolTranscript(input: MockToolTranscriptInput): MockToolTranscriptEntry[] {
  const userUuid = input.promptUuid || newUuid()
  const assistantUuid = newUuid()
  const resultUuid = newUuid()

  const user: MockToolTranscriptEntry = {
    type: 'user',
    uuid: userUuid,
    parentUuid: null,
    sessionId: input.sessionId,
    isSidechain: false,
    cwd: input.cwd,
    timestamp: input.timestamp,
    userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
  }

  const assistant: MockToolTranscriptEntry = {
    type: 'assistant',
    uuid: assistantUuid,
    parentUuid: userUuid,
    sessionId: input.sessionId,
    isSidechain: false,
    cwd: input.cwd,
    timestamp: input.timestamp,
    message: {
      id: `msg_${newUuid()}`,
      type: 'message',
      role: 'assistant',
      model: 'mock-opus',
      content: [{ type: 'tool_use', id: input.toolUseId, name: input.toolName, input: input.input }],
    },
  }

  const result: MockToolTranscriptEntry = {
    type: 'user',
    uuid: resultUuid,
    parentUuid: assistantUuid,
    sessionId: input.sessionId,
    isSidechain: false,
    cwd: input.cwd,
    timestamp: input.timestamp,
    userType: 'external',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: input.toolUseId,
          content: input.resultContent,
          is_error: input.isError,
        },
      ],
    },
  }

  if (!input.reply) return [user, assistant, result]

  const reply: MockToolTranscriptEntry = {
    type: 'assistant',
    uuid: newUuid(),
    parentUuid: resultUuid,
    sessionId: input.sessionId,
    isSidechain: false,
    cwd: input.cwd,
    timestamp: input.timestamp,
    message: {
      id: `msg_${newUuid()}`,
      type: 'message',
      role: 'assistant',
      model: 'mock-opus',
      content: [{ type: 'text', text: input.reply }],
    },
  }

  return [user, assistant, result, reply]
}

/** Id of the `tool_result` entry in a built transcript, for callers that need it. */
export function toolResultEntryId(entries: readonly MockToolTranscriptEntry[]): string {
  const result = entries.find(entry =>
    entry.message.content.some(block => block.type === 'tool_result'))
  if (!result) throw new Error('built mock tool transcript has no tool_result entry')
  return result.uuid
}

/** Serialize entries as newline-terminated JSONL, the on-disk transcript format. */
export function serializeMockToolTranscript(entries: readonly MockToolTranscriptEntry[]): string {
  return `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
}

/**
 * Locate the JSONL file the server will read for this session and append the turn.
 *
 * The server resolves a transcript by searching every `projects/<dir>/<sessionId>.jsonl`
 * (`sessionService.findSessionFile`), so the fixture does not need to know the
 * sanitized project-dir name — it finds the file the server already created when
 * the session was opened. Returns false when persistence is not configured or the
 * file is not found, so the caller can fall back to streaming-only behavior.
 *
 * The first entry's `parentUuid` is rewritten to the transcript's real tail (see
 * `lastConversationEntryUuid`) so two consecutive mocked turns form one chain
 * instead of each restarting at `null`. A caller that already chained the entries
 * itself is left untouched.
 */
export async function persistMockToolTranscript(
  configDir: string | undefined,
  sessionId: string,
  entries: readonly MockToolTranscriptEntry[],
): Promise<boolean> {
  if (!configDir) return false
  const { readdir, readFile, appendFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const projects = join(configDir, 'projects')
  for (const directory of await readdir(projects).catch(() => [])) {
    const file = join(projects, directory, `${sessionId}.jsonl`)
    let existing: string
    try {
      existing = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const parent = lastConversationEntryUuid(existing)
    const toAppend = parent !== null && entries[0]?.parentUuid === null
      ? [{ ...entries[0], parentUuid: parent }, ...entries.slice(1)]
      : entries
    await appendFile(file, serializeMockToolTranscript(toAppend))
    return true
  }
  return false
}