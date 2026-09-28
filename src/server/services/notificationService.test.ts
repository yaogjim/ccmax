import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { adapterService, type AdapterFileConfig, type PairedUser } from './adapterService.js'
import type { TaskRun } from './cronScheduler.js'
import {
  NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART,
  NotificationDeliveryStore,
} from './notificationDeliveryStore.js'
import {
  resetNotificationRecoveryStateForTests,
  sendImmediateMessage,
  sendTaskNotification,
  startPendingDeliveryRecovery,
  type NotificationDeliveryReport,
  type NotificationLogger,
  type TaskNotificationInput,
} from './notificationService.js'

type FetchCall = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

type FakeFetch = {
  calls: FetchCall[]
  impl: typeof fetch
}

function telegramUser(userId: number | string, displayName = `user-${userId}`): PairedUser {
  return { userId, displayName, pairedAt: 1_700_000_000_000 }
}

function runFixture(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    taskName: 'Nightly *report* _scan_',
    startedAt: '2026-09-26T00:00:00.000Z',
    completedAt: '2026-09-26T00:00:02.000Z',
    status: 'completed',
    prompt: 'do the thing',
    output: 'Result with `code`, *stars*, <b>tags</b> and _under_scores_',
    durationMs: 1_500,
    exitCode: 0,
    ...overrides,
  }
}

function createFakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): FakeFetch {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { calls, impl }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

describe('notificationService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let rawConfig: AdapterFileConfig
  let configSpy: ReturnType<typeof spyOn>
  let deliveredLogs: string[]
  let logger: NotificationLogger
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalFetch = globalThis.fetch
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-service-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    rawConfig = {}
    configSpy = spyOn(adapterService, 'getRawConfig').mockImplementation(async () => rawConfig)
    deliveredLogs = []
    logger = {
      error: (message) => deliveredLogs.push(`error:${message}`),
      warn: (message) => deliveredLogs.push(`warn:${message}`),
    }
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    configSpy.mockRestore()
    resetNotificationRecoveryStateForTests()
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function options(fake: FakeFetch, extra: Record<string, unknown> = {}) {
    return {
      fetchImpl: fake.impl,
      store: new NotificationDeliveryStore(path.join(tmpDir, 'notification-deliveries.json')),
      timeoutMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      logger,
      ...extra,
    }
  }

  test.each([
    { name: 'system bridge', mode: 'system', manualUrl: '', noProxy: 'localhost', expected: 'http://127.0.0.1:17890' },
    { name: 'manual override', mode: 'manual', manualUrl: 'http://127.0.0.1:17891', noProxy: 'localhost', expected: 'http://127.0.0.1:17891' },
    { name: 'direct', mode: 'direct', manualUrl: '', noProxy: 'localhost', expected: undefined },
    { name: 'system NO_PROXY', mode: 'system', manualUrl: '', noProxy: 'api.telegram.org', expected: undefined },
    { name: 'manual NO_PROXY', mode: 'manual', manualUrl: 'http://127.0.0.1:17891', noProxy: '.telegram.org', expected: undefined },
    { name: 'system NO_PROXY wildcard', mode: 'system', manualUrl: '', noProxy: '*', expected: undefined },
  ] as const)('routes Telegram sendMessage with $name settings', async ({ mode, manualUrl, noProxy, expected }) => {
    const keys = ['CC_HAHA_SYSTEM_PROXY_URL', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy'] as const
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const seen: Array<{ url: string; proxy?: string }> = []
    rawConfig = { telegram: { botToken: 'fixture-token', pairedUsers: [telegramUser(111)] } }
    try {
      process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:17890'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:17892'
      process.env.NO_PROXY = noProxy
      delete process.env.no_proxy
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
        network: { proxy: { mode, url: manualUrl } },
      }))
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const capture = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), proxy: (init as RequestInit & { proxy?: string })?.proxy })
        return fake.impl(input, init)
      }) as typeof fetch
      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake, { fetchImpl: capture }),
      )
      expect(seen).toEqual([{ url: 'https://api.telegram.org/botfixture-token/sendMessage', proxy: expected }])
      expect(fake.calls[0]!.body.chat_id).toBe(111)
      expect(report).toMatchObject({ ok: true, failed: [], indeterminate: [] })
      expect(report.delivered).toHaveLength(1)
    } finally {
      for (const key of keys) restoreEnv(key, previous[key])
    }
  })

  describe('recipient resolution', () => {
    test('never broadcasts to every paired user when no explicit recipients are configured', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111), telegramUser(222)], allowedUsers: [333] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'] },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.delivered).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain('no_recipients_configured')
    })

    test('records a malformed stored channel list as a visible failure', async () => {
      // Older writers persisted `notification` without validating it, so a
      // record can carry an enabled notification with no channel array at all.
      // The delivery path used to read through that value and throw, and the
      // scheduler swallowed the throw into a log line — the run looked
      // successful and no delivery status was ever recorded for it.
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: undefined as unknown as TaskNotificationInput['channels'] },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain('no_recipients_configured')
      const store = new NotificationDeliveryStore(path.join(tmpDir, 'notification-deliveries.json'))
      expect(await store.list()).toHaveLength(0)
    })

    test('keeps a desktop-only channel list neutral instead of reporting a delivery failure', async () => {
      // Desktop notifications are rendered by the app itself; the service has
      // no IM channel to send to and nothing is wrong. Treating that stored
      // config as a missing recipient would make every desktop-only task report
      // a failed delivery.
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['desktop'] },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(true)
      expect(report.issues).toHaveLength(0)
    })

    test('delivers to an explicitly requested user only after the server pairing record verifies it', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111), telegramUser(222)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.body.chat_id).toBe(111)
      expect(report.ok).toBe(true)
      expect(report.delivered).toHaveLength(1)
      expect(report.delivered[0]!.recipientId).toBe('111')
    })

    test('treats an allowedUsers-only identifier as unpaired instead of a notification source', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [], allowedUsers: [333] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [333] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.failed.map((entry) => entry.errorCode)).toEqual(['recipient_not_verified'])
    })

    test('reports an unknown recipient instead of silently sending nothing', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: ['999'] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.failed[0]!.errorCode).toBe('recipient_not_verified')
      expect(deliveredLogs.some((line) => line.startsWith('error:'))).toBe(true)
    })

    test('fails visibly when one recipient label matches several pairing records', async () => {
      rawConfig = {
        telegram: {
          botToken: 'bot-token',
          pairedUsers: [telegramUser(111, 'Alice'), telegramUser(222, 'Alice')],
        },
      }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [{ displayName: 'Alice' }] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.failed.map((entry) => entry.errorCode)).toEqual(['recipient_ambiguous'])
    })

    test('rejects an empty recipient reference', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [{}] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.failed.map((entry) => entry.errorCode)).toEqual(['invalid_recipient'])
    })
  })

  describe('failures are visible', () => {
    test('fails instead of claiming success when Telegram returns a non-2xx response', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: false, description: 'bad request' }, { status: 400 }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake, { maxAttempts: 1 }),
      )

      expect(fake.calls).toHaveLength(1)
      expect(report.ok).toBe(false)
      expect(report.delivered).toHaveLength(0)
      expect(report.failed[0]!.errorCode).toBe('http_error')
      expect(report.failed[0]!.error).toContain('400')
    })

    test('retries a retryable status a bounded number of times and then reports failure', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => new Response('upstream down', { status: 503 }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(3)
      expect(report.failed[0]!.attempts).toBe(3)
      expect(report.failed[0]!.errorCode).toBe('http_error')
      expect(report.ok).toBe(false)
    })

    test('delivers once a transient retryable failure clears within the bound', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      let attempt = 0
      const fake = createFakeFetch(() => {
        attempt += 1
        return attempt < 3
          ? new Response('slow down', { status: 429 })
          : Response.json({ ok: true, result: { message_id: 123 } })
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(3)
      expect(report.ok).toBe(true)
      expect(report.delivered[0]!.attempts).toBe(3)
    })

    test('marks a timed-out send indeterminate instead of a silent success', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => {
        throw abortError()
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(1)
      expect(report.ok).toBe(false)
      expect(report.delivered).toHaveLength(0)
      expect(report.indeterminate[0]!.errorCode).toBe('timeout')
    })

    test('marks an unreachable network after retries as indeterminate', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => {
        throw new Error('ECONNRESET')
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(3)
      expect(report.indeterminate[0]!.errorCode).toBe('network_error')
      expect(report.indeterminate[0]!.attempts).toBe(3)
    })

    test('reports missing credentials as a visible failure instead of skipping', async () => {
      rawConfig = { telegram: { pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain('credentials_missing')
    })

    test('reports an unreadable adapter config as a visible failure', async () => {
      configSpy.mockImplementation(async () => {
        throw new Error('config unreadable')
      })
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain('adapter_config_unreadable')
    })

    test('is a no-op when notifications are disabled or no IM channel is selected', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      expect((await sendTaskNotification(runFixture(), { enabled: false, channels: ['telegram'] }, options(fake))).ok).toBe(true)
      expect((await sendTaskNotification(runFixture(), { enabled: true, channels: ['desktop'] }, options(fake))).ok).toBe(true)
      expect(fake.calls).toHaveLength(0)
    })
  })

  describe('Telegram plain text', () => {
    test('sends without parse_mode so markdown characters cannot break delivery', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      expect(report.ok).toBe(true)
      expect(fake.calls[0]!.url).toBe('https://api.telegram.org/botbot-token/sendMessage')
      expect(fake.calls[0]!.body.parse_mode).toBeUndefined()
      const text = String(fake.calls[0]!.body.text)
      expect(text).not.toContain('**')
      expect(text).toContain('Nightly *report* _scan_')
      expect(text).toContain('Result with `code`, *stars*, <b>tags</b> and _under_scores_')
    })

    test('truncates oversized output before sending', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      await sendTaskNotification(
        runFixture({ output: 'x'.repeat(10_000) }),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake),
      )

      const text = String(fake.calls[0]!.body.text)
      expect(text.length).toBeLessThanOrEqual(4_001)
      expect(text.endsWith('…')).toBe(true)
    })
  })

  describe('Feishu', () => {
    test('delivers an interactive card to a verified open_id', async () => {
      rawConfig = {
        feishu: {
          appId: 'cli_app',
          appSecret: 'secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        },
      }
      const fake = createFakeFetch((call) => {
        if (call.url.includes('tenant_access_token')) {
          return Response.json({ code: 0, tenant_access_token: 'tenant-token' })
        }
        return Response.json({ code: 0, data: { message_id: 'om_1' } })
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['feishu'], recipients: { feishu: ['ou_1'] } },
        options(fake),
      )

      expect(report.ok).toBe(true)
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]!.url).toContain('receive_id_type=open_id')
      expect(fake.calls[1]!.body.receive_id).toBe('ou_1')
      expect(fake.calls[1]!.body.msg_type).toBe('interactive')
      expect(fake.calls[1]!.headers.authorization).toBe('Bearer tenant-token')
    })

    test('fails visibly when Feishu answers HTTP 200 with a business error', async () => {
      rawConfig = {
        feishu: {
          appId: 'cli_app',
          appSecret: 'secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        },
      }
      const fake = createFakeFetch((call) => {
        if (call.url.includes('tenant_access_token')) {
          return Response.json({ code: 0, tenant_access_token: 'tenant-token' })
        }
        return Response.json({ code: 99991663, msg: 'receive_id invalid' })
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['feishu'], recipients: { feishu: ['ou_1'] } },
        options(fake),
      )

      expect(fake.calls).toHaveLength(2)
      expect(report.ok).toBe(false)
      expect(report.failed[0]!.errorCode).toBe('business_error')
      expect(report.failed[0]!.error).toContain('99991663')
    })

    test('fails visibly when the tenant token request is rejected', async () => {
      rawConfig = {
        feishu: {
          appId: 'cli_app',
          appSecret: 'secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        },
      }
      const fake = createFakeFetch(() => Response.json({ code: 10003, msg: 'invalid app_secret' }))

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['feishu'], recipients: { feishu: ['ou_1'] } },
        options(fake, { maxAttempts: 1 }),
      )

      expect(fake.calls).toHaveLength(1)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.code)).toContain('business_error')
      expect(report.delivered).toHaveLength(0)
    })
  })

  describe('delivery records', () => {
    test('persists one versioned record per delivered and failed recipient', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111), telegramUser(222)] } }
      const fake = createFakeFetch((call) =>
        call.body.chat_id === 222
          ? Response.json({ ok: false, description: 'blocked' }, { status: 403 })
          : Response.json({ ok: true, result: { message_id: 123 } }),
      )
      const storePath = path.join(tmpDir, 'notification-deliveries.json')

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111, 222] } },
        options(fake, { store: new NotificationDeliveryStore(storePath), maxAttempts: 1 }),
      )

      expect(report.recordPath).toBe(storePath)
      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
        schemaVersion: number
        records: Array<{ outcome: string; recipientId: string; runId: string }>
      }
      expect(onDisk.schemaVersion).toBe(1)
      expect(onDisk.records).toHaveLength(2)
      expect(onDisk.records.map((record) => record.recipientId).sort()).toEqual(['111', '222'])
      expect(onDisk.records.map((record) => record.outcome).sort()).toEqual(['delivered', 'failed'])
      expect(onDisk.records.every((record) => record.runId === 'run-1')).toBe(true)
    })

    test('fails closed when the pending record cannot be written, and never sends untracked', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const failingStore = {
        filePath: path.join(tmpDir, 'unwritable.json'),
        enqueuePending: async () => {
          throw new Error('disk full')
        },
        settle: async () => true,
        recoverPending: async () => [],
      } as unknown as NotificationDeliveryStore

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake, { store: failingStore }),
      )

      // No pending row means no send: a delivery the store cannot describe must
      // not go out untracked, so it is reported as a visible failure.
      expect(fake.calls).toHaveLength(0)
      expect(report.delivered).toHaveLength(0)
      expect(report.failed[0]!.errorCode).toBe('delivery_record_failed')
      expect(report.issues.map((issue) => issue.code)).toContain('delivery_record_failed')
    })
  })

  test('returns a report instead of throwing so callers cannot silently succeed', async () => {
    rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

    const report: NotificationDeliveryReport = await sendTaskNotification(
      runFixture(),
      { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
      options(fake),
    )

    expect(report.ok).toBe(true)
    expect(typeof report.ok).toBe('boolean')
  })

  test('keeps the two-argument call shape working for the existing scheduler call site', async () => {
    rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
    const notification: TaskNotificationInput = { enabled: true, channels: ['telegram'] }
    const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
    globalThis.fetch = fake.impl

    const report = await sendTaskNotification(runFixture(), notification)

    // No explicit recipients means no broadcast; the reason is visible even with defaults.
    expect(fake.calls).toHaveLength(0)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain('no_recipients_configured')
  })

  // ─── Pending → settle → recover ───────────────────────────────────────────

  describe('delivery journal', () => {
    test('writes a pending row before the network call and settles it to delivered', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'journal-delivered.json')
      let outcomeAtSendTime: unknown
      const fake = createFakeFetch(async () => {
        const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
          records: Array<{ outcome: string }>
        }
        outcomeAtSendTime = onDisk.records[0]?.outcome
        return Response.json({ ok: true, result: { message_id: 123 } })
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake, { store: new NotificationDeliveryStore(storePath) }),
      )

      // The pending row exists while the request is in flight, not only after.
      expect(outcomeAtSendTime).toBe('pending')
      expect(report.delivered).toHaveLength(1)
      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
        records: Array<{ outcome: string; attempts: number; runId: string }>
      }
      expect(onDisk.records).toHaveLength(1)
      expect(onDisk.records[0]!.outcome).toBe('delivered')
      expect(onDisk.records[0]!.attempts).toBe(1)
      expect(onDisk.records[0]!.runId).toBe('run-1')
    })

    test('settles a failed send to failed and an unreachable send to indeterminate', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const failedPath = path.join(tmpDir, 'journal-failed.json')
      const indeterminatePath = path.join(tmpDir, 'journal-indeterminate.json')

      await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(createFakeFetch(() => Response.json({ ok: false }, { status: 400 })), {
          store: new NotificationDeliveryStore(failedPath),
          maxAttempts: 1,
        }),
      )
      await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(createFakeFetch(() => { throw new Error('ECONNRESET') }), {
          store: new NotificationDeliveryStore(indeterminatePath),
        }),
      )

      const failed = JSON.parse(await fs.readFile(failedPath, 'utf-8')) as { records: Array<{ outcome: string }> }
      const indeterminate = JSON.parse(await fs.readFile(indeterminatePath, 'utf-8')) as { records: Array<{ outcome: string }> }
      expect(failed.records[0]!.outcome).toBe('failed')
      expect(indeterminate.records[0]!.outcome).toBe('indeterminate')
    })

    test('does not duplicate the log row when the same run is notified twice', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'journal-idempotent.json')
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const common = { store: new NotificationDeliveryStore(storePath) }
      const notification: TaskNotificationInput = {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [111] },
      }

      await sendTaskNotification(runFixture(), notification, options(fake, common))
      await sendTaskNotification(runFixture(), notification, options(fake, common))

      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as { records: unknown[] }
      // A repeat for the same run must not call the platform again. The
      // persisted delivery id is also the idempotency key, not just a log key.
      expect(onDisk.records).toHaveLength(1)
      expect(fake.calls).toHaveLength(1)
    })

    test('marks a pending row left by a crashed process indeterminate and never resends it', async () => {
      rawConfig = {
        telegram: {
          botToken: 'bot-token',
          pairedUsers: [telegramUser(111), telegramUser(222)],
        },
      }
      const storePath = path.join(tmpDir, 'journal-restart.json')
      const store = new NotificationDeliveryStore(storePath)
      // Simulate the previous process dying mid-send: a pending row is on disk.
      await store.enqueuePending([{
        deliveryId: 'run-old::telegram::111::0',
        runId: 'run-old',
        taskId: 'task-old',
        channel: 'telegram',
        recipientId: '111',
        recipientDisplayName: 'user-111',
        createdAt: '2026-09-26T00:00:00.000Z',
      }])
      resetNotificationRecoveryStateForTests()

      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [222] } },
        options(fake, { store }),
      )

      // Only the new recipient is contacted; the leftover is never resent.
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.body.chat_id).toBe(222)
      expect(report.delivered).toHaveLength(1)

      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
        records: Array<{ runId: string; recipientId: string; outcome: string; errorCode?: string }>
      }
      const leftover = onDisk.records.find((record) => record.runId === 'run-old')
      expect(leftover?.outcome).toBe('indeterminate')
      expect(leftover?.errorCode).toBe(NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART)
    })

    test('recovers leftovers at most once per store so a concurrent send is not mislabelled', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'journal-once.json')
      const store = new NotificationDeliveryStore(storePath)
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const notification: TaskNotificationInput = {
        enabled: true,
        channels: ['telegram'],
        recipients: { telegram: [111] },
      }

      await sendTaskNotification(runFixture(), notification, options(fake, { store }))
      // A second run's pending row appears; a later call must not reclassify
      // the already-settled first row.
      await sendTaskNotification(runFixture({ id: 'run-2' }), notification, options(fake, { store }))

      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
        records: Array<{ outcome: string }>
      }
      expect(onDisk.records).toHaveLength(2)
      expect(onDisk.records.every((record) => record.outcome === 'delivered')).toBe(true)
    })
  })

  // ─── Startup reconciliation ────────────────────────────────────────────────

  describe('startup reconciliation', () => {
    // Regression: recovery used to run only inside the first send. A restart
    // with no further send left the leftover `pending` row untouched, so the
    // desktop panel showed a permanent "sending" entry. The server now
    // reconciles once at startup, before the scheduler or handlers can send.
    test('settles a legacy pending row on startup without any send', async () => {
      const storePath = path.join(tmpDir, 'journal-startup.json')
      const store = new NotificationDeliveryStore(storePath)
      await store.enqueuePending([{
        deliveryId: 'run-old::telegram::111::0',
        runId: 'run-old',
        taskId: 'task-old',
        channel: 'telegram',
        recipientId: '111',
        recipientDisplayName: 'user-111',
        createdAt: '2026-09-26T00:00:00.000Z',
      }])
      resetNotificationRecoveryStateForTests()

      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      globalThis.fetch = fake.impl

      await startPendingDeliveryRecovery({ store, logger })

      // No message is sent at startup: the leftover is classified, never retried.
      expect(fake.calls).toHaveLength(0)
      const records = await store.list()
      expect(records).toHaveLength(1)
      expect(records[0]!.outcome).toBe('indeterminate')
      expect(records[0]!.errorCode).toBe(NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART)
      expect(deliveredLogs.some((line) => line.includes('投递结算为不确定'))).toBe(true)
    })

    test('logs an unreadable store and resolves instead of blocking startup', async () => {
      const failingStore = {
        filePath: path.join(tmpDir, 'journal-startup-failure.json'),
        recoverPending: async () => {
          throw new Error('read-only store')
        },
      } as unknown as NotificationDeliveryStore

      await expect(
        startPendingDeliveryRecovery({ store: failingStore, logger }),
      ).resolves.toBeUndefined()
      expect(deliveredLogs.some((line) => line.includes('遗留投递恢复失败'))).toBe(true)
    })

    test('reconciles at most once so a later send does not mislabel a fresh pending row', async () => {
      const storePath = path.join(tmpDir, 'journal-startup-once.json')
      const store = new NotificationDeliveryStore(storePath)
      await store.enqueuePending([{
        deliveryId: 'run-old::telegram::111::0',
        runId: 'run-old',
        taskId: 'task-old',
        channel: 'telegram',
        recipientId: '111',
        createdAt: '2026-09-26T00:00:00.000Z',
      }])
      resetNotificationRecoveryStateForTests()

      await startPendingDeliveryRecovery({ store, logger })
      // A new send after startup opens its own pending row; the already-run
      // recovery pass must not reclassify it as indeterminate.
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(222)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      await sendTaskNotification(
        runFixture({ id: 'run-new' }),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [222] } },
        options(fake, { store }),
      )

      const records = await store.list()
      const fresh = records.find((record) => record.runId === 'run-new')
      expect(fresh?.outcome).toBe('delivered')
      expect(fake.calls).toHaveLength(1)
    })
  })

  // ─── Credential redaction ─────────────────────────────────────────────────

  describe('credential redaction', () => {
    test('never lets the Telegram bot token reach the log or the persisted error', async () => {
      rawConfig = { telegram: { botToken: 'super-secret-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'redact-telegram.json')
      const fake = createFakeFetch(() => {
        // A transport error that embeds the request URL is the realistic leak:
        // the bot token lives in the path, not in a header, for Telegram.
        throw new Error('connect ECONNREFUSED https://api.telegram.org/botsuper-secret-token/sendMessage')
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['telegram'], recipients: { telegram: [111] } },
        options(fake, { store: new NotificationDeliveryStore(storePath) }),
      )

      expect(report.indeterminate).toHaveLength(1)
      expect(report.indeterminate[0]!.error).not.toContain('super-secret-token')
      expect(deliveredLogs.join('\n')).not.toContain('super-secret-token')

      const raw = await fs.readFile(storePath, 'utf-8')
      expect(raw).not.toContain('super-secret-token')
      expect(raw).toContain('[redacted]')
    })

    test('never lets the Feishu app secret or tenant token reach the log or the record', async () => {
      rawConfig = {
        feishu: {
          appId: 'cli_app',
          appSecret: 'feishu-app-secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        },
      }
      const storePath = path.join(tmpDir, 'redact-feishu.json')
      const fake = createFakeFetch(() => {
        throw new Error('tenant_access_token unreachable; api_secret=feishu-app-secret')
      })

      const report = await sendTaskNotification(
        runFixture(),
        { enabled: true, channels: ['feishu'], recipients: { feishu: ['ou_1'] } },
        options(fake, { store: new NotificationDeliveryStore(storePath) }),
      )

      expect(report.ok).toBe(false)
      expect(JSON.stringify(report)).not.toContain('feishu-app-secret')
      expect(deliveredLogs.join('\n')).not.toContain('feishu-app-secret')
      const raw = await fs.readFile(storePath, 'utf-8')
      expect(raw).not.toContain('feishu-app-secret')
    })
  })

  // ─── Immediate message (the tool-facing send API) ─────────────────────────

  describe('sendImmediateMessage', () => {
    test('delivers plain text to a paired recipient and journals the attempt', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'immediate.json')
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const result = await sendImmediateMessage(
        { channel: 'telegram', recipient: 111, text: 'hello from the tool', runId: 'conv-1' },
        options(fake, { store: new NotificationDeliveryStore(storePath) }),
      )

      expect(result.ok).toBe(true)
      expect(result.delivery?.outcome).toBe('delivered')
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.body.chat_id).toBe(111)
      expect(fake.calls[0]!.body.text).toBe('hello from the tool')
      expect(fake.calls[0]!.body.parse_mode).toBeUndefined()

      const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
        records: Array<{ outcome: string; runId: string; channel: string }>
      }
      expect(onDisk.records).toHaveLength(1)
      expect(onDisk.records[0]!.outcome).toBe('delivered')
      expect(onDisk.records[0]!.runId).toBe('conv-1')
    })

    test('journals separate immediate sends without a run id instead of overwriting the first result', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const storePath = path.join(tmpDir, 'immediate-repeated.json')
      const store = new NotificationDeliveryStore(storePath)
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const send = (text: string) => sendImmediateMessage(
        { channel: 'telegram', recipient: 111, text },
        options(fake, { store }),
      )

      expect((await send('first')).ok).toBe(true)
      expect((await send('second')).ok).toBe(true)
      const records = await store.list()
      expect(fake.calls.map((call) => call.body.text)).toEqual(['first', 'second'])
      expect(records).toHaveLength(2)
      expect(records[0]!.deliveryId).not.toBe(records[1]!.deliveryId)
      expect(records.every((record) => record.outcome === 'delivered')).toBe(true)
    })

    test('does not send or settle a second immediate call with the same explicit run id', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const store = new NotificationDeliveryStore(path.join(tmpDir, 'immediate-duplicate.json'))
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))
      const input = { channel: 'telegram' as const, recipient: 111, text: 'hello', runId: 'same-run' }
      expect((await sendImmediateMessage(input, options(fake, { store }))).ok).toBe(true)
      expect((await sendImmediateMessage(input, options(fake, { store }))).ok).toBe(false)
      expect(fake.calls).toHaveLength(1)
      expect(await store.list()).toHaveLength(1)
    })

    test('refuses an unpaired recipient before any network call', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)], allowedUsers: [999] } }
      const storePath = path.join(tmpDir, 'immediate-unpaired.json')
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const result = await sendImmediateMessage(
        { channel: 'telegram', recipient: 999, text: 'should not send' },
        options(fake, { store: new NotificationDeliveryStore(storePath) }),
      )

      expect(fake.calls).toHaveLength(0)
      expect(result.ok).toBe(false)
      expect(result.delivery?.errorCode).toBe('recipient_not_verified')
      expect(result.delivery?.outcome).toBe('failed')
    })

    test('reports missing credentials instead of pretending the message went out', async () => {
      rawConfig = { telegram: { pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const result = await sendImmediateMessage(
        { channel: 'telegram', recipient: 111, text: 'no bot token' },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(result.ok).toBe(false)
      expect(result.issues.map((issue) => issue.code)).toContain('credentials_missing')
    })

    test('rejects empty content without contacting the platform', async () => {
      rawConfig = { telegram: { botToken: 'bot-token', pairedUsers: [telegramUser(111)] } }
      const fake = createFakeFetch(() => Response.json({ ok: true, result: { message_id: 123 } }))

      const result = await sendImmediateMessage(
        { channel: 'telegram', recipient: 111, text: '   ' },
        options(fake),
      )

      expect(fake.calls).toHaveLength(0)
      expect(result.ok).toBe(false)
    })

    test('sends a Feishu text card to a verified open_id', async () => {
      rawConfig = {
        feishu: {
          appId: 'cli_app',
          appSecret: 'secret',
          pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        },
      }
      const fake = createFakeFetch((call) => {
        if (call.url.includes('tenant_access_token')) {
          return Response.json({ code: 0, tenant_access_token: 'tenant-token' })
        }
        return Response.json({ code: 0, data: { message_id: 'om_1' } })
      })

      const result = await sendImmediateMessage(
        { channel: 'feishu', recipient: 'ou_1', text: 'hi there', title: 'ccmax' },
        options(fake),
      )

      expect(result.ok).toBe(true)
      expect(result.delivery?.outcome).toBe('delivered')
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]!.body.receive_id).toBe('ou_1')
      expect(fake.calls[1]!.body.msg_type).toBe('interactive')
    })
  })
})