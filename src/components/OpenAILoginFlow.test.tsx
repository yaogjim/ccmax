import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../ink.js'
import { OpenAILoginFlow } from './OpenAILoginFlow.js'
import type { OpenAIOAuthTokens } from '../services/openaiAuth/types.js'
import type { NotificationOptions } from '../services/notifier.js'
import type { TerminalNotification } from '../ink/useTerminalNotification.js'

const authModule = await import('../cli/handlers/auth.js')
const notifierModule = await import('../services/notifier.js')
const openAIOAuthModule = await import('../services/openaiAuth/index.js')
const openAIOAuthStorageModule = await import('../services/openaiAuth/storage.js')

const terminal: TerminalNotification = {
  notifyITerm2: () => {},
  notifyKitty: () => {},
  notifyGhostty: () => {},
  notifyBell: () => {},
  progress: () => {},
}

const tokens: OpenAIOAuthTokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  email: 'openai-user@example.com',
}

const sendNotification = mock(
  async (_notif: NotificationOptions, _terminal: TerminalNotification) => {},
)
const installOpenAIOAuthTokens = mock(
  async (_tokensToInstall: OpenAIOAuthTokens) => null,
)
const startOAuthFlow = mock(
  async (authURLHandler: (url: string) => Promise<void>) => {
    await authURLHandler('https://auth.example/openai')
    return tokens
  },
)
const cleanup = mock(() => {})

mock.module('../ink/useTerminalNotification.js', () => ({
  useTerminalNotification: () => terminal,
}))

mock.module('../services/notifier.js', () => ({
  ...notifierModule,
  sendNotification,
}))

mock.module('../cli/handlers/auth.js', () => ({
  ...authModule,
  installOpenAIOAuthTokens,
}))

mock.module('../services/openaiAuth/storage.js', () => ({
  ...openAIOAuthStorageModule,
  getOpenAIOAuthTokens: () => tokens,
}))

mock.module('../services/openaiAuth/index.js', () => ({
  ...openAIOAuthModule,
  OpenAIOAuthService: class {
    startOAuthFlow = startOAuthFlow
    cleanup = cleanup
  },
}))

beforeEach(() => {
  sendNotification.mockClear()
  installOpenAIOAuthTokens.mockClear()
  startOAuthFlow.mockClear()
  cleanup.mockClear()
})

afterAll(() => {
  mock.restore()
})

describe('OpenAILoginFlow', () => {
  test('notifies with the ccmax product name after OpenAI OAuth tokens are installed', async () => {
    const stdout = new PassThrough() as NodeJS.WriteStream
    const stderr = new PassThrough() as NodeJS.WriteStream

    Object.assign(stdout, { columns: 80, rows: 24, isTTY: false })
    Object.assign(stderr, { columns: 80, rows: 24, isTTY: false })

    const app = await render(<OpenAILoginFlow onDone={() => {}} />, {
      stdout,
      stderr,
      debug: false,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await waitFor(() => sendNotification.mock.calls.length === 1)

      expect(startOAuthFlow).toHaveBeenCalledTimes(1)
      expect(installOpenAIOAuthTokens).toHaveBeenCalledWith(tokens)
      expect(sendNotification).toHaveBeenCalledWith(
        {
          message: 'ccmax OpenAI login successful',
          notificationType: 'auth_success',
        },
        terminal,
      )
      expect(sendNotification.mock.calls[0]?.[0].message).not.toContain(
        'Claude Code Haha',
      )
    } finally {
      app.unmount()
      stdout.destroy()
      stderr.destroy()
    }
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for OpenAI login notification')
    }
    await Bun.sleep(10)
  }
}
