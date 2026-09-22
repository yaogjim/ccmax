import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  OPENAI_CODEX_OAUTH_PORT,
  OPENAI_CODEX_REDIRECT_PATH,
} from './client.js'
import { OpenAIOAuthService } from './index.js'
import {
  clearOpenAIOAuthTokenCache,
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
} from './storage.js'

function mockJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function assertBrandedListenerHtml(
  body: string,
  kind: 'success' | 'failed',
): void {
  expect(body).toContain(
    `ccmax OpenAI Authorization ${kind === 'success' ? 'Successful' : 'Failed'}`,
  )
  expect(body).toContain('return to ccmax')
  expect(body).not.toContain('Claude Code Haha')
  expect(body).not.toContain('cc-haha')
}

async function driveListenerCallback(service: OpenAIOAuthService): Promise<{
  flowResult: Promise<
    | { ok: true; tokens: unknown }
    | { ok: false; error: unknown }
  >
  callbackBody: Promise<string>
}> {
  let resolveCallbackBody!: (value: Promise<string>) => void
  const callbackBodyReady = new Promise<Promise<string>>(resolve => {
    resolveCallbackBody = resolve
  })

  // Attach settlement handlers immediately so token-exchange rejection never
  // becomes an unhandled rejection while the callback response is still open.
  const flowResult = service
    .startOAuthFlow(
      async url => {
        const state = new URL(url).searchParams.get('state')
        if (!state) {
          throw new Error('authorize URL missing state')
        }

        resolveCallbackBody(
          fetch(
            `http://localhost:${OPENAI_CODEX_OAUTH_PORT}${OPENAI_CODEX_REDIRECT_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`,
          ).then(async response => {
            expect(response.status).toBe(200)
            expect(response.headers.get('content-type') ?? '').toContain(
              'text/html',
            )
            return await response.text()
          }),
        )
      },
      { skipBrowserOpen: true },
    )
    .then(
      tokens => ({ ok: true as const, tokens }),
      (error: unknown) => ({ ok: false as const, error }),
    )

  const callbackBody = await callbackBodyReady
  return { flowResult, callbackBody }
}

describe('OpenAIOAuthService listener brand pages', () => {
  let tmpDir: string
  let tokenPath: string
  let originalTokenFile: string | undefined
  let originalConfigDir: string | undefined
  let originalHome: string | undefined
  let originalUserProfile: string | undefined
  let originalFetch: typeof fetch
  let service: OpenAIOAuthService

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openai-oauth-listener-'))
    tokenPath = path.join(tmpDir, 'openai-oauth.json')
    originalTokenFile = process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY]
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalFetch = globalThis.fetch

    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
    process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY] = tokenPath
    clearOpenAIOAuthTokenCache()
    service = new OpenAIOAuthService()
  })

  afterEach(async () => {
    service.cleanup()
    globalThis.fetch = originalFetch
    restoreEnv(OPENAI_CODEX_OAUTH_FILE_ENV_KEY, originalTokenFile)
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('HOME', originalHome)
    restoreEnv('USERPROFILE', originalUserProfile)
    clearOpenAIOAuthTokenCache()
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('success callback page brands ccmax and not legacy display names', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'openai-access-token',
            refresh_token: 'openai-refresh-token',
            expires_in: 3600,
            id_token: mockJwt({
              email: 'test@example.com',
              'https://api.openai.com/auth': {
                chatgpt_account_id: 'acct_123',
              },
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const { flowResult, callbackBody } = await driveListenerCallback(service)
    const [result, body] = await Promise.all([flowResult, callbackBody])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.tokens).toMatchObject({
      accessToken: 'openai-access-token',
      refreshToken: 'openai-refresh-token',
    })
    assertBrandedListenerHtml(body, 'success')
  })

  test('token-exchange failure page brands ccmax and still rejects the flow', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return new Response('exchange denied', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const { flowResult, callbackBody } = await driveListenerCallback(service)
    const [result, body] = await Promise.all([flowResult, callbackBody])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.error).toBeInstanceOf(Error)
    expect(String((result.error as Error).message)).toContain(
      'OpenAI token exchange failed: 400',
    )
    assertBrandedListenerHtml(body, 'failed')
  })
})