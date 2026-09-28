import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SIDE_CHAT_BOUNDARY,
  SIDE_CHAT_PREFIX,
  closeSideChatsForParent,
  getSideChat,
  isSideChatId,
  registerSideChat,
  sideChatSummary,
  type SideChat,
} from './sideChatRegistry.js'

// The registry keys entries by `CLAUDE_CONFIG_DIR`, so every test runs against a
// disposable config home and restores the real environment afterwards.
let directory: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalHome = process.env.HOME

function makeEntry(overrides: Partial<SideChat> = {}): SideChat {
  return {
    sessionId: `${SIDE_CHAT_PREFIX}${crypto.randomUUID()}`,
    parentSessionId: crypto.randomUUID(),
    cliSessionId: crypto.randomUUID(),
    resumePath: '/tmp/parent.jsonl',
    resumeAt: 'parent-message',
    launchInfo: {
      filePath: '',
      projectDir: '/tmp/project',
      workDir: '/tmp/project',
      transcriptMessageCount: 0,
      customTitle: 'Side chat',
      permissionMode: 'default',
      runtimeProviderId: 'provider',
      runtimeModelId: 'model',
      effortLevel: 'high',
    },
    createdAt: new Date().toISOString(),
    started: false,
    closed: false,
    ...overrides,
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'side-chat-registry-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.HOME = directory
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(directory, { recursive: true, force: true })
})

describe('side chat registry', () => {
  test('registers a side chat by id and recognizes only the side prefix', () => {
    const entry = makeEntry()
    registerSideChat(entry)

    expect(getSideChat(entry.sessionId)).toBe(entry)
    expect(SIDE_CHAT_PREFIX).toBe('side-')
    expect(isSideChatId(entry.sessionId)).toBe(true)
    expect(isSideChatId(entry.parentSessionId)).toBe(false)
    expect(getSideChat(crypto.randomUUID())).toBeUndefined()
  })

  test('closes only the open side chats of the requested parent and is idempotent', () => {
    const parentId = crypto.randomUUID()
    const otherParentId = crypto.randomUUID()
    const first = makeEntry({ parentSessionId: parentId })
    const second = makeEntry({ parentSessionId: parentId })
    const unrelated = makeEntry({ parentSessionId: otherParentId })
    const alreadyClosed = makeEntry({ parentSessionId: parentId, closed: true })
    for (const entry of [first, second, unrelated, alreadyClosed]) registerSideChat(entry)

    expect(closeSideChatsForParent(parentId)).toEqual([first.sessionId, second.sessionId])
    expect(getSideChat(first.sessionId)?.closed).toBe(true)
    expect(getSideChat(second.sessionId)?.closed).toBe(true)
    expect(getSideChat(unrelated.sessionId)?.closed).toBe(false)
    // A second close for a deleted parent must not report the same ids again.
    expect(closeSideChatsForParent(parentId)).toEqual([])
  })

  test('isolates stored side chats per CLAUDE_CONFIG_DIR so an id cannot leak across config homes', () => {
    const entry = makeEntry()
    registerSideChat(entry)
    expect(getSideChat(entry.sessionId)).toBe(entry)

    // A different config home must not see, read, or close the first home's chat.
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'other-config-home')
    expect(getSideChat(entry.sessionId)).toBeUndefined()
    expect(closeSideChatsForParent(entry.parentSessionId)).toEqual([])

    process.env.CLAUDE_CONFIG_DIR = directory
    const restored = getSideChat(entry.sessionId)
    expect(restored).toBe(entry)
    expect(restored?.closed).toBe(false)
  })

  test('projects a registered side chat into a session list summary', () => {
    const entry = makeEntry({
      launchInfo: {
        filePath: '',
        projectDir: '/shared/project',
        workDir: '/shared',
        transcriptMessageCount: 0,
        customTitle: 'Side chat',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'vp',
        runtimeModelId: 'vm',
        effortLevel: 'low',
      },
    })
    registerSideChat(entry)

    expect(sideChatSummary(entry)).toEqual({
      id: entry.sessionId,
      title: 'Side chat',
      createdAt: entry.createdAt,
      modifiedAt: entry.createdAt,
      messageCount: 0,
      projectPath: '/shared/project',
      projectRoot: '/shared',
      workDir: '/shared',
      workDirExists: true,
      workspaceState: 'available',
      permissionMode: 'acceptEdits',
      runtimeProviderId: 'vp',
      runtimeModelId: 'vm',
      effortLevel: 'low',
    })
  })

  test('pins the boundary prompt to reference-only inherited context', () => {
    expect(SIDE_CHAT_BOUNDARY).toContain('reference context only')
    expect(SIDE_CHAT_BOUNDARY).toContain('Do not continue the parent')
    expect(SIDE_CHAT_BOUNDARY).toContain('Do not spawn')
  })
})