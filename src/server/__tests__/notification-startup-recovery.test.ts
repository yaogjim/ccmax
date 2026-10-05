/**
 * Regression: a process that dies mid-send leaves a `pending` delivery row on
 * disk. Recovery used to run only inside the first send, so a restart with no
 * further send kept the row pending and the desktop panel showed a permanent
 * "sending" entry. The server must reconcile that row once at startup, and it
 * must do so after the persistent-storage migration — that migration rewrites
 * `ccmax/notification-deliveries.json` without the delivery store's lock, so a
 * pass that ran first can be clobbered back to `pending`.
 *
 * This boots the real server (same shape as the other server-boot tests) with a
 * temporary `CLAUDE_CONFIG_DIR` seeded with the legacy, pre-versioned store, and
 * asserts the row is settled without any send being attempted.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { resetNotificationRecoveryStateForTests } from '../services/notificationService.js'
import { resetPersistentStorageMigrationsForTests } from '../services/persistentStorageMigrations.js'
import {
  NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART,
  NotificationDeliveryStore,
} from '../services/notificationDeliveryStore.js'

describe('notification startup recovery', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmax-notification-startup-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    // Clear the per-process guards so startServer arms a fresh pass and a fresh
    // storage migration for this store file.
    resetNotificationRecoveryStateForTests()
    resetPersistentStorageMigrationsForTests()
  })

  afterEach(async () => {
    resetNotificationRecoveryStateForTests()
    resetPersistentStorageMigrationsForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('settles a legacy pending delivery left by a previous process at startup', async () => {
    const storePath = path.join(tmpDir, 'ccmax', 'notification-deliveries.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    // Old fixture: the pre-versioned bare array with a row that never settled.
    await fs.writeFile(
      storePath,
      JSON.stringify([
        {
          deliveryId: 'run-old::telegram::111::0',
          runId: 'run-old',
          taskId: 'task-old',
          channel: 'telegram',
          recipientId: '111',
          recipientDisplayName: 'user-111',
          outcome: 'pending',
          attempts: 0,
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      ], null, 2) + '\n',
      'utf-8',
    )

    const server = startServer(0, '127.0.0.1')
    try {
      const store = new NotificationDeliveryStore(storePath)
      const deadline = Date.now() + 5_000
      let record: Awaited<ReturnType<typeof store.list>>[number] | undefined
      while (Date.now() < deadline) {
        record = (await store.list()).find((entry) => entry.runId === 'run-old')
        if (record?.outcome === 'indeterminate') break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(record?.outcome).toBe('indeterminate')
      expect(record?.errorCode).toBe(NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART)
    } finally {
      await server.stop(true)
      await stopServerRuntimeForShutdown({ waitForCli: false })
    }
  })

  test('startup recovery of leftover dedicated pending does not call Telegram when public is enabled', async () => {
    const storePath = path.join(tmpDir, 'ccmax', 'notification-deliveries.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(
      storePath,
      JSON.stringify([
        {
          deliveryId: 'run-old::telegram::111::0',
          runId: 'run-old',
          taskId: 'task-old',
          channel: 'telegram',
          recipientId: '111',
          recipientDisplayName: 'user-111',
          outcome: 'pending',
          attempts: 0,
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      ], null, 2) + '\n',
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({
        telegram: {
          botToken: 'fixture-bot-token',
          pairedUsers: [{ userId: 111, displayName: 'Alice', pairedAt: 1 }],
          public: { enabled: true, botToken: 'public-token' },
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        '111': { sessionId: 'sess-bound', workDir: '/tmp', updatedAt: 1 },
      }),
      'utf-8',
    )

    const telegramCalls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('api.telegram.org')) telegramCalls.push(url)
      return Response.json({ ok: true, result: { message_id: 1 } })
    }) as typeof fetch

    const server = startServer(0, '127.0.0.1')
    try {
      const store = new NotificationDeliveryStore(storePath)
      const deadline = Date.now() + 5_000
      let record: Awaited<ReturnType<typeof store.list>>[number] | undefined
      while (Date.now() < deadline) {
        record = (await store.list()).find((entry) => entry.runId === 'run-old')
        if (record?.outcome === 'indeterminate') break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(record?.outcome).toBe('indeterminate')
      expect(record?.errorCode).toBe(NOTIFICATION_DELIVERY_UNCONFIRMED_AFTER_RESTART)
      expect(telegramCalls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      await server.stop(true)
      await stopServerRuntimeForShutdown({ waitForCli: false })
    }
  })
})