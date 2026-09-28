import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSideChatsRoute } from './sideChats.js'
import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { closeSideChatsForParent, getSideChat } from '../services/sideChatRegistry.js'

const parentSessionId = crypto.randomUUID()
const routeUrl = 'http://127.0.0.1/api/sessions/parent/side-chats'

// Keep the registry keyed to a disposable config home so nothing touches the
// developer's real `~/.claude` entry namespace, and restore it afterwards.
let directory: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalHome = process.env.HOME
let launchInfoMock: ReturnType<typeof spyOn>
let historyMock: ReturnType<typeof spyOn>
let stopMock: ReturnType<typeof spyOn>

const launchInfo = {
  filePath: '/tmp/sessions/parent.jsonl',
  projectDir: '/tmp/projects/parent',
  workDir: '/tmp/workspace',
  transcriptMessageCount: 2,
  customTitle: null,
}

function entry(id: string, type: 'user' | 'assistant' | 'system') {
  return { id, type, content: id, timestamp: new Date(0).toISOString() }
}

function historyPage(messages: ReturnType<typeof entry>[]) {
  return {
    messages,
    taskNotifications: [],
    page: { nextCursor: null, hasMore: false, historyComplete: true, sourceVersion: 'test', scannedBytes: 0, omittedOversizedEntries: 0 },
  }
}

const post = (body?: string) => new Request(routeUrl, { method: 'POST', body })

async function call(req: Request, parent = parentSessionId, childId?: string): Promise<Response> {
  try {
    return await handleSideChatsRoute(req, parent, childId)
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.statusCode })
    }
    throw error
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'side-chat-api-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.HOME = directory
  launchInfoMock = spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(launchInfo as never)
  historyMock = spyOn(sessionService, 'getSessionHistoryPage').mockResolvedValue(
    historyPage([entry('parent-message', 'user'), entry('parent-reply', 'assistant')]) as never,
  )
  stopMock = spyOn(conversationService, 'stopSessionAndWait').mockResolvedValue(undefined)
})

afterEach(async () => {
  mock.restore()
  closeSideChatsForParent(parentSessionId)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(directory, { recursive: true, force: true })
})

describe('side chat API', () => {
  test('creates an ephemeral side chat pinned to the last non-system parent message', async () => {
    const response = await call(post('{}'))
    expect(response.status).toBe(200)
    const body = await response.json() as { sessionId: string; parentSessionId: string; workDir: string; title: string; ephemeral: boolean }

    expect(body).toEqual({
      sessionId: body.sessionId,
      parentSessionId,
      workDir: launchInfo.workDir,
      title: 'Side chat',
      ephemeral: true,
    })
    expect(body.sessionId).toStartWith('side-')
    expect(launchInfoMock).toHaveBeenCalledWith(parentSessionId)
    expect(historyMock).toHaveBeenCalledWith(parentSessionId, { limit: 100, projectContext: false })

    const stored = getSideChat(body.sessionId)!
    expect(stored.cliSessionId).toBe(body.sessionId.slice('side-'.length))
    expect(stored.resumePath).toBe(launchInfo.filePath)
    expect(stored.resumeAt).toBe('parent-reply')
    expect(stored.closed).toBe(false)
    expect(stored.started).toBe(false)
    // The child must never inherit the parent transcript path as its own file.
    expect(stored.launchInfo.filePath).toBe('')
    expect(stored.launchInfo.customTitle).toBe('Side chat')
  })

  test('skips trailing system messages for the boundary and rejects a session without a conversation', async () => {
    historyMock.mockResolvedValueOnce(
      historyPage([entry('real-user-message', 'user'), entry('system-tail', 'system')]) as never,
    )
    const created = await (await call(post('{}'))).json() as { sessionId: string }
    expect(getSideChat(created.sessionId)?.resumeAt).toBe('real-user-message')

    historyMock.mockResolvedValueOnce(historyPage([entry('system-only', 'system')]) as never)
    const conflict = await call(post('{}'))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'CONFLICT' })
  })

  test('reuses a supplied side chat id idempotently and rejects reuse from another parent', async () => {
    const sideChatId = crypto.randomUUID()
    const first = await (await call(post(JSON.stringify({ sideChatId })))).json() as { sessionId: string }
    const second = await (await call(post(JSON.stringify({ sideChatId })))).json() as { sessionId: string }
    expect(second.sessionId).toBe(first.sessionId)
    // Reuse must not re-fork or re-read the parent transcript.
    expect(launchInfoMock).toHaveBeenCalledTimes(1)
    expect(historyMock).toHaveBeenCalledTimes(1)

    const conflict = await call(post(JSON.stringify({ sideChatId })), crypto.randomUUID())
    expect(conflict.status).toBe(409)
  })

  test('rejects nested side chats and unsupported methods', async () => {
    const nested = await call(post('{}'), `side-${crypto.randomUUID()}`)
    expect(nested.status).toBe(400)

    const listAttempt = await call(new Request(routeUrl, { method: 'GET' }))
    expect(listAttempt.status).toBe(405)

    const created = await (await call(post('{}'))).json() as { sessionId: string }
    const childPost = await call(post('{}'), parentSessionId, created.sessionId)
    expect(childPost.status).toBe(405)
    expect(stopMock).not.toHaveBeenCalled()
  })

  test('closes a side chat only for its owning parent and stops the child on success', async () => {
    const created = await (await call(post('{}'))).json() as { sessionId: string }

    const denied = await call(new Request(routeUrl, { method: 'DELETE' }), crypto.randomUUID(), created.sessionId)
    expect(denied.status).toBe(404)
    expect(getSideChat(created.sessionId)?.closed).toBe(false)
    expect(stopMock).not.toHaveBeenCalled()

    const unknown = await call(new Request(routeUrl, { method: 'DELETE' }), parentSessionId, `side-${crypto.randomUUID()}`)
    expect(unknown.status).toBe(404)

    const closed = await call(new Request(routeUrl, { method: 'DELETE' }), parentSessionId, created.sessionId)
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual({ sessionId: created.sessionId, closed: true })
    expect(getSideChat(created.sessionId)?.closed).toBe(true)
    expect(stopMock).toHaveBeenCalledWith(created.sessionId)
  })

  test('cannot reuse a side chat id after its parent session closes', async () => {
    const sideChatId = crypto.randomUUID()
    const created = await (await call(post(JSON.stringify({ sideChatId })))).json() as { sessionId: string }

    // `conversationService.markSessionDeleted(parent)` closes the parent's side chats.
    closeSideChatsForParent(parentSessionId)
    expect(getSideChat(created.sessionId)?.closed).toBe(true)

    const reuse = await call(post(JSON.stringify({ sideChatId })))
    expect(reuse.status).toBe(409)
    expect(await reuse.json()).toMatchObject({ error: 'CONFLICT' })

    // A deleted parent cannot mint a fresh side chat either.
    launchInfoMock.mockResolvedValueOnce(null as never)
    const afterDelete = await call(post('{}'))
    expect(afterDelete.status).toBe(404)
    expect(await afterDelete.json()).toMatchObject({ error: 'NOT_FOUND' })
  })

  test('rejects oversized, malformed, and non-uuid create bodies before touching the session', async () => {
    expect((await call(post('a'.repeat(1025)))).status).toBe(400)
    expect((await call(post('{'))).status).toBe(400)
    expect((await call(post(JSON.stringify({ sideChatId: 'not-a-uuid' })))).status).toBe(400)
    expect((await call(post(JSON.stringify({ sideChatId: crypto.randomUUID(), extra: true })))).status).toBe(400)

    expect(launchInfoMock).not.toHaveBeenCalled()
    expect(historyMock).not.toHaveBeenCalled()
  })
})
