/**
 * Visibility gate for LocalScheduledTask on an IM (Telegram) session.
 *
 * A Telegram natural-language turn reaches the CLI through an ordinary
 * `/ws/<sessionId>` client socket: the adapter sidecar sends `user_message`,
 * the server calls `ensureCliSessionStarted`, and `conversationService`
 * spawns the CLI. The tool is only visible inside that CLI when its child env
 * carries BOTH the loopback desktop origin (derived from the SDK url) and the
 * process-scoped internal token.
 *
 * These tests pin that contract without a model, a real Telegram connection,
 * or the developer's real config: the SDK url is the exact shape
 * `buildSdkWebSocketUrl(ws, sessionId)` produces, and the token is a fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationService } from '../../server/services/conversationService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'
import {
  DESKTOP_SERVER_URL_ENV,
  LOCAL_ACCESS_TOKEN_ENV,
  isLocalScheduledTaskApiAvailable,
  resolveLocalScheduledTaskBaseUrl,
} from './client.js'
import { LocalScheduledTaskTool } from './LocalScheduledTaskTool.js'

// Fixture credential. Never the developer's real token.
const FIXTURE_TOKEN = 'fixture-telegram-session-token'

/**
 * Exactly what `src/server/ws/handler.ts#buildSdkWebSocketUrl` builds for a
 * client socket: `ws://<loopback host>:<port>/sdk/<sessionId>?token=<uuid>`.
 * The `token` query param is the SDK handshake token, not the local API token.
 */
function telegramSessionSdkUrl(port = 34_561, sessionId = 'telegram-tg-42'): string {
  return `ws://127.0.0.1:${port}/sdk/${sessionId}?token=11111111-2222-3333-4444-555555555555`
}

const TRACKED_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CC_HAHA_DISABLE_TERMINAL_SHELL_ENV',
  LOCAL_ACCESS_TOKEN_ENV,
  DESKTOP_SERVER_URL_ENV,
] as const

let tmpDir: string
const originalEnv: Record<string, string | undefined> = {}

async function buildSessionChildEnv(sdkUrl: string): Promise<Record<string, string>> {
  const service = new ConversationService() as any
  return (await service.buildChildEnv(os.tmpdir(), sdkUrl)) as Record<string, string>
}

function withChildEnv<T>(childEnv: Record<string, string>, run: () => T): T {
  const saved = {
    url: process.env[DESKTOP_SERVER_URL_ENV],
    token: process.env[LOCAL_ACCESS_TOKEN_ENV],
  }
  try {
    if (childEnv[DESKTOP_SERVER_URL_ENV] === undefined) delete process.env[DESKTOP_SERVER_URL_ENV]
    else process.env[DESKTOP_SERVER_URL_ENV] = childEnv[DESKTOP_SERVER_URL_ENV]
    if (childEnv[LOCAL_ACCESS_TOKEN_ENV] === undefined) delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    else process.env[LOCAL_ACCESS_TOKEN_ENV] = childEnv[LOCAL_ACCESS_TOKEN_ENV]
    return run()
  } finally {
    if (saved.url === undefined) delete process.env[DESKTOP_SERVER_URL_ENV]
    else process.env[DESKTOP_SERVER_URL_ENV] = saved.url
    if (saved.token === undefined) delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    else process.env[LOCAL_ACCESS_TOKEN_ENV] = saved.token
  }
}

beforeEach(async () => {
  for (const key of TRACKED_ENV) originalEnv[key] = process.env[key]
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-session-visibility-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  // Keep the login-shell env capture out of this test: it is unrelated and
  // spawns a shell on hosts without a TTY.
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  delete process.env[DESKTOP_SERVER_URL_ENV]
  resetTerminalShellEnvironmentCacheForTests()
})

afterEach(async () => {
  for (const key of TRACKED_ENV) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  resetTerminalShellEnvironmentCacheForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('LocalScheduledTask visibility on a Telegram client session', () => {
  test('a desktop-hosted Telegram session gets the loopback origin and the internal token', async () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN

    const childEnv = await buildSessionChildEnv(telegramSessionSdkUrl())
    const desktopServerUrl = childEnv[DESKTOP_SERVER_URL_ENV]

    // ws://127.0.0.1:34561/sdk/... -> http://127.0.0.1:34561
    expect(desktopServerUrl).toBe('http://127.0.0.1:34561')
    expect(resolveLocalScheduledTaskBaseUrl(childEnv)).toBe('http://127.0.0.1:34561')
    // The internal credential is inherited from the server process, not the
    // SDK handshake token in the url.
    expect(childEnv[LOCAL_ACCESS_TOKEN_ENV]).toBe(FIXTURE_TOKEN)

    // With exactly this child env, the tool is visible to the model.
    expect(isLocalScheduledTaskApiAvailable(childEnv)).toBe(true)
    expect(withChildEnv(childEnv, () => LocalScheduledTaskTool.isEnabled())).toBe(true)
  })

  test('without a desktop host the token is absent and the tool stays invisible', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]

    const childEnv = await buildSessionChildEnv(telegramSessionSdkUrl())

    // The origin is still derived, but without the credential the tool must
    // stay off: a plain CLI / adapter with no desktop host never gets it.
    expect(childEnv[DESKTOP_SERVER_URL_ENV]).toBe('http://127.0.0.1:34561')
    expect(childEnv[LOCAL_ACCESS_TOKEN_ENV]).toBeUndefined()
    expect(isLocalScheduledTaskApiAvailable(childEnv)).toBe(false)
    expect(withChildEnv(childEnv, () => LocalScheduledTaskTool.isEnabled())).toBe(false)
  })

  test('a non-loopback session origin disables the tool even with a token', async () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = FIXTURE_TOKEN

    // A server bound to a LAN address advertises that address in the SDK url,
    // and the client deliberately refuses to send the bearer token off-loopback.
    const childEnv = await buildSessionChildEnv(
      'ws://192.168.1.20:34561/sdk/telegram-tg-42?token=11111111-2222-3333-4444-555555555555',
    )

    expect(childEnv[DESKTOP_SERVER_URL_ENV]).toBe('http://192.168.1.20:34561')
    expect(resolveLocalScheduledTaskBaseUrl(childEnv)).toBeNull()
    expect(isLocalScheduledTaskApiAvailable(childEnv)).toBe(false)
    expect(withChildEnv(childEnv, () => LocalScheduledTaskTool.isEnabled())).toBe(false)
  })
})