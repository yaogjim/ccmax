import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as lockfile from '../../utils/lockfile.js'
import {
  NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  NotificationDeliveryStore,
  getNotificationDeliveryStorePath,
  normalizeNotificationDeliveryStore,
  type NotificationDeliveryRecord,
} from './notificationDeliveryStore.js'

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

/**
 * The pre-versioned delivery log: a bare JSON array of records with no
 * `schemaVersion` wrapper and no `attempts` on each entry. Written by an
 * earlier build, it must keep loading after the versioned store ships.
 */
const LEGACY_DELIVERY_LOG_FIXTURE = [
  {
    deliveryId: 'legacy-1',
    runId: 'run-legacy',
    taskId: 'task-legacy',
    channel: 'telegram',
    recipientId: '111',
    outcome: 'delivered',
    createdAt: '2026-01-01T00:00:00.000Z',
    futureField: { keep: true },
  },
  {
    deliveryId: 'legacy-2',
    runId: 'run-legacy',
    taskId: 'task-legacy',
    channel: 'feishu',
    recipientId: 'ou_legacy',
    outcome: 'failed',
    error: 'http 500',
    createdAt: '2026-01-01T00:00:01.000Z',
  },
]

describe('notificationDeliveryStore path resolution', () => {
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
  })

  test('resolves inside the fork-owned config directory, never the repository', () => {
    process.env.CLAUDE_CONFIG_DIR = '/temporary/config-dir'
    expect(getNotificationDeliveryStorePath()).toBe(
      path.join('/temporary/config-dir', 'ccmax', 'notification-deliveries.json'),
    )
    expect(getNotificationDeliveryStorePath('/other').startsWith('/other')).toBe(true)
  })
})

describe('notificationDeliveryStore migration', () => {
  test('upgrades the pre-versioned bare-array fixture without losing unknown fields', () => {
    const migrated = normalizeNotificationDeliveryStore(LEGACY_DELIVERY_LOG_FIXTURE)

    expect(migrated.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(migrated.records).toHaveLength(2)

    const first = migrated.records[0]!
    expect(first.deliveryId).toBe('legacy-1')
    expect(first.channel).toBe('telegram')
    expect(first.outcome).toBe('delivered')
    // 旧记录没有平台回执，迁移不得凭空补造。
    expect(first.messageId).toBeUndefined()
    // A legacy record predates the retry counter; default it instead of dropping the record.
    expect(first.attempts).toBe(1)
    // Unknown fields survive a forward migration.
    expect((first as Record<string, unknown>).futureField).toEqual({ keep: true })

    expect(migrated.records[1]!.error).toBe('http 500')
    expect(migrated.records[1]!.attempts).toBe(1)
  })

  test('normalizes a versioned file and drops records that cannot be identified', () => {
    const migrated = normalizeNotificationDeliveryStore({
      schemaVersion: 0,
      records: [
        { deliveryId: 'ok', runId: 'r', taskId: 't', channel: 'telegram', recipientId: '1', outcome: 'delivered' },
        { runId: 'r', taskId: 't', recipientId: 'no-channel' },
        { deliveryId: 'unknown-outcome', runId: 'r', taskId: 't', channel: 'feishu', recipientId: '2', outcome: '???' },
        'not-an-object',
      ],
    })

    expect(migrated.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(migrated.records.map((record) => record.deliveryId)).toEqual(['ok', 'unknown-outcome'])
    expect(migrated.records[1]!.outcome).toBe('failed')
  })

  test('recovers a corrupt file as an empty versioned store instead of throwing', () => {
    expect(normalizeNotificationDeliveryStore('{not json').records).toEqual([])
    expect(normalizeNotificationDeliveryStore(null).schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
  })

  // Regression: the public task notification adds an optional
  // `telegramEntrypoint` tag. A record written before it existed must still
  // load and be treated as dedicated (undefined) — never guessed as public.
  test('reads a legacy record without telegramEntrypoint as dedicated and keeps a valid tag', () => {
    const migrated = normalizeNotificationDeliveryStore([
      {
        deliveryId: 'legacy-entry',
        runId: 'r',
        taskId: 't',
        channel: 'telegram',
        recipientId: '111',
        outcome: 'delivered',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        deliveryId: 'public-entry',
        runId: 'r',
        taskId: 't',
        channel: 'telegram',
        recipientId: '111',
        outcome: 'delivered',
        telegramEntrypoint: 'public',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        deliveryId: 'bogus-entry',
        runId: 'r',
        taskId: 't',
        channel: 'telegram',
        recipientId: '111',
        outcome: 'delivered',
        telegramEntrypoint: 'nonsense',
        createdAt: '2026-01-01T00:00:02.000Z',
      },
    ])

    const byId = new Map(migrated.records.map((record) => [record.deliveryId, record]))
    expect(byId.get('legacy-entry')!.telegramEntrypoint).toBeUndefined()
    expect(byId.get('public-entry')!.telegramEntrypoint).toBe('public')
    expect(byId.get('bogus-entry')!.telegramEntrypoint).toBeUndefined()
  })
})

describe('notificationDeliveryStore persistence', () => {
  let tmpDir: string
  let storePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-store-'))
    storePath = path.join(tmpDir, 'notification-deliveries.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('appends versioned records to a brand new file and reads them back', async () => {
    const store = new NotificationDeliveryStore(storePath)
    const record: NotificationDeliveryRecord = {
      schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
      deliveryId: 'd1',
      runId: 'run-1',
      taskId: 'task-1',
      channel: 'telegram',
      recipientId: '111',
      outcome: 'delivered',
      attempts: 1,
      createdAt: '2026-09-26T00:00:00.000Z',
    }

    await store.append([record])

    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
      schemaVersion: number
      records: Array<Record<string, unknown>>
    }
    expect(onDisk.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(onDisk.records).toHaveLength(1)
    expect(onDisk.records[0]!.deliveryId).toBe('d1')

    const readBack = await store.read()
    expect(readBack.records).toHaveLength(1)
    expect(readBack.records[0]!.outcome).toBe('delivered')
  })

  test('keeps only the newest records when the log grows past the bound', async () => {
    const store = new NotificationDeliveryStore(storePath, { maxRecords: 3 })
    for (let index = 0; index < 5; index += 1) {
      await store.append([
        {
          schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
          deliveryId: `d${index}`,
          runId: 'run-1',
          taskId: 'task-1',
          channel: 'telegram',
          recipientId: String(index),
          outcome: 'delivered',
          attempts: 1,
          createdAt: new Date(index * 1000).toISOString(),
        },
      ])
    }

    const readBack = await store.read()
    expect(readBack.records.map((record) => record.deliveryId)).toEqual(['d2', 'd3', 'd4'])
  })

  test('loads a legacy on-disk fixture and rewrites it in the versioned shape', async () => {
    await fs.writeFile(storePath, JSON.stringify(LEGACY_DELIVERY_LOG_FIXTURE), 'utf-8')
    const store = new NotificationDeliveryStore(storePath)

    const readBack = await store.read()
    expect(readBack.records).toHaveLength(2)
    expect(readBack.records[0]!.attempts).toBe(1)

    await store.append([
      {
        schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
        deliveryId: 'd-new',
        runId: 'run-new',
        taskId: 'task-new',
        channel: 'feishu',
        recipientId: 'ou_new',
        outcome: 'indeterminate',
        attempts: 3,
        createdAt: '2026-09-26T00:00:00.000Z',
      },
    ])

    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
      schemaVersion: number
      records: Array<{ deliveryId: string }>
    }
    expect(onDisk.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(onDisk.records.map((record) => record.deliveryId)).toEqual(['legacy-1', 'legacy-2', 'd-new'])
  })

  test('survives a crash and reload without losing an in-flight pending record', async () => {
    // The pre-crash build wrote a pending marker before sending. Reloading in a
    // fresh process must keep it, because nobody can prove whether the platform
    // actually received the message.
    await fs.writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
        records: [{
          schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
          deliveryId: 'inflight',
          runId: 'run-1',
          taskId: 'task-1',
          channel: 'telegram',
          recipientId: '111',
          outcome: 'pending',
          attempts: 0,
          createdAt: '2026-09-26T00:00:00.000Z',
          futureField: { keep: 'me' },
        }],
      }, null, 2),
      'utf-8',
    )

    const readBack = await new NotificationDeliveryStore(storePath).read()
    expect(readBack.records[0]!.outcome).toBe('pending')
    expect((readBack.records[0] as Record<string, unknown>).futureField).toEqual({ keep: 'me' })
  })
})

describe('notificationDeliveryStore pending + settlement', () => {
  let tmpDir: string
  let storePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-pending-'))
    storePath = path.join(tmpDir, 'notification-deliveries.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function pendingInput(deliveryId: string, recipientId = '111') {
    return {
      deliveryId,
      runId: 'run-1',
      taskId: 'task-1',
      channel: 'telegram' as const,
      recipientId,
      recipientDisplayName: `user-${recipientId}`,
      createdAt: '2026-09-26T00:00:00.000Z',
    }
  }

  test('enqueues a pending record before any network send, with zero attempts', async () => {
    const store = new NotificationDeliveryStore(storePath)

    const result = await store.enqueuePending([pendingInput('d1')])

    expect(result.enqueued).toEqual(['d1'])
    expect(result.skipped).toEqual([])

    const pending = await store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.deliveryId).toBe('d1')
    expect(pending[0]!.outcome).toBe('pending')
    expect(pending[0]!.attempts).toBe(0)
  })

  test('treats the delivery id as an idempotency key so a re-enqueue never duplicates', async () => {
    const store = new NotificationDeliveryStore(storePath)

    await store.enqueuePending([pendingInput('d1')])
    const second = await store.enqueuePending([pendingInput('d1')])

    expect(second.enqueued).toEqual([])
    expect(second.skipped).toEqual(['d1'])
    expect(await store.listPending()).toHaveLength(1)
  })

  test('settles a pending record by delivery id and preserves unknown fields', async () => {
    const store = new NotificationDeliveryStore(storePath)
    await store.enqueuePending([pendingInput('d1')])

    const settled = await store.settle('d1', {
      outcome: 'indeterminate',
      attempts: 3,
      errorCode: 'timeout',
      error: 'sendMessage timed out',
    })

    expect(settled).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
      records: Array<Record<string, unknown>>
    }
    expect(onDisk.records[0]!.outcome).toBe('indeterminate')
    expect(onDisk.records[0]!.attempts).toBe(3)
    expect(onDisk.records[0]!.errorCode).toBe('timeout')
    expect(onDisk.records[0]!.recipientDisplayName).toBe('user-111')
    expect(await store.listPending()).toHaveLength(0)
  })

  test('reports a settlement for an unknown delivery id instead of inventing a record', async () => {
    const store = new NotificationDeliveryStore(storePath)
    expect(await store.settle('missing', { outcome: 'delivered', attempts: 1 })).toBe(false)
    expect(await store.read()).toMatchObject({ records: [] })
  })

  test('recovers pending records as indeterminate after restart instead of claiming exactly-once delivery', async () => {
    const first = new NotificationDeliveryStore(storePath)
    await first.enqueuePending([pendingInput('d1'), pendingInput('d2', '222')])

    // A fresh instance models a process restart that never observed the outcome.
    const recovered = await new NotificationDeliveryStore(storePath).recoverPending()

    expect(recovered.map((record) => record.deliveryId).sort()).toEqual(['d1', 'd2'])
    expect(recovered.every((record) => record.outcome === 'indeterminate')).toBe(true)
    expect(recovered.every((record) => record.errorCode === 'unconfirmed_after_restart')).toBe(true)

    const store = new NotificationDeliveryStore(storePath)
    expect(await store.listPending()).toHaveLength(0)
    const all = await store.list()
    expect(all.every((record) => record.outcome === 'indeterminate')).toBe(true)
  })
})

describe('notificationDeliveryStore query for the frontend', () => {
  let tmpDir: string
  let storePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-query-'))
    storePath = path.join(tmpDir, 'notification-deliveries.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const base = {
    schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    attempts: 1,
  }

  test('filters delivery records by run, task and outcome for a status view', async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
        records: [
          { ...base, deliveryId: 'a', runId: 'run-1', taskId: 'task-1', channel: 'telegram', recipientId: '111', outcome: 'delivered', createdAt: '2026-09-26T00:00:00.000Z' },
          { ...base, deliveryId: 'b', runId: 'run-1', taskId: 'task-1', channel: 'telegram', recipientId: '222', outcome: 'failed', createdAt: '2026-09-26T00:00:01.000Z' },
          { ...base, deliveryId: 'c', runId: 'run-2', taskId: 'task-2', channel: 'feishu', recipientId: 'ou_1', outcome: 'delivered', createdAt: '2026-09-26T00:00:02.000Z' },
        ],
      }, null, 2),
      'utf-8',
    )
    const store = new NotificationDeliveryStore(storePath)

    expect((await store.list({ runId: 'run-1' })).map((record) => record.deliveryId)).toEqual(['b', 'a'])
    expect((await store.list({ taskId: 'task-2' })).map((record) => record.deliveryId)).toEqual(['c'])
    expect((await store.list({ outcome: 'failed' })).map((record) => record.deliveryId)).toEqual(['b'])
    expect((await store.list()).map((record) => record.deliveryId)).toEqual(['c', 'b', 'a'])
  })

  test('returns the newest records first with an explicit limit for the desktop panel', async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
        records: [
          { ...base, deliveryId: 'old', runId: 'run-1', taskId: 'task-1', channel: 'telegram', recipientId: '1', outcome: 'delivered', createdAt: '2026-09-26T00:00:00.000Z' },
          { ...base, deliveryId: 'new', runId: 'run-1', taskId: 'task-1', channel: 'telegram', recipientId: '2', outcome: 'delivered', createdAt: '2026-09-26T00:00:02.000Z' },
          { ...base, deliveryId: 'mid', runId: 'run-1', taskId: 'task-1', channel: 'telegram', recipientId: '3', outcome: 'delivered', createdAt: '2026-09-26T00:00:01.000Z' },
        ],
      }, null, 2),
      'utf-8',
    )

    const listed = await new NotificationDeliveryStore(storePath).list({ limit: 2 })
    expect(listed.map((record) => record.deliveryId)).toEqual(['new', 'mid'])
  })
})

describe('notificationDeliveryStore concurrent mutation', () => {
  let tmpDir: string
  let storePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-concurrent-'))
    storePath = path.join(tmpDir, 'notification-deliveries.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function pendingInput(deliveryId: string) {
    return {
      deliveryId,
      runId: 'run-1',
      taskId: 'task-1',
      channel: 'telegram' as const,
      recipientId: '111',
      createdAt: '2026-09-26T00:00:00.000Z',
    }
  }

  async function readRecordIds(filePath: string): Promise<string[]> {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as {
      records: Array<{ deliveryId: string }>
    }
    return parsed.records.map((record) => record.deliveryId)
  }

  test('persists every delivery when two enqueues race on one store instance', async () => {
    // Regression: each enqueue used to do its own unlocked read-modify-write,
    // so both concurrent calls reported "enqueued" while the later atomic
    // rename overwrote the earlier row and only one landed on disk.
    const store = new NotificationDeliveryStore(storePath)

    const [first, second] = await Promise.all([
      store.enqueuePending([pendingInput('d1')]),
      store.enqueuePending([pendingInput('d2')]),
    ])

    expect(first.enqueued).toEqual(['d1'])
    expect(second.enqueued).toEqual(['d2'])
    expect((await readRecordIds(storePath)).sort()).toEqual(['d1', 'd2'])
  })

  test('never duplicates an id when the same delivery is enqueued concurrently', async () => {
    const store = new NotificationDeliveryStore(storePath)

    const results = await Promise.all([
      store.enqueuePending([pendingInput('dup')]),
      store.enqueuePending([pendingInput('dup')]),
    ])

    expect(results.flatMap((result) => result.enqueued)).toEqual(['dup'])
    expect(results.flatMap((result) => result.skipped)).toEqual(['dup'])
    expect((await readRecordIds(storePath)).filter((id) => id === 'dup')).toHaveLength(1)
  })

  test('serializes concurrent enqueues across two instances sharing one path', async () => {
    const firstStore = new NotificationDeliveryStore(storePath)
    const secondStore = new NotificationDeliveryStore(storePath)

    const [first, second] = await Promise.all([
      firstStore.enqueuePending([pendingInput('x1')]),
      secondStore.enqueuePending([pendingInput('x2')]),
    ])

    expect(first.enqueued).toEqual(['x1'])
    expect(second.enqueued).toEqual(['x2'])
    expect((await readRecordIds(storePath)).sort()).toEqual(['x1', 'x2'])
  })

  test('holds the shared file lock while migrating a legacy file on read', async () => {
    // A read of a legacy file rewrites it in the versioned shape. That
    // migration must take the same on-disk lock as `mutate`, or it can clobber
    // a concurrent append. Holding the lock externally must therefore block the
    // read until it is released.
    await fs.writeFile(storePath, JSON.stringify(LEGACY_DELIVERY_LOG_FIXTURE), 'utf-8')
    const store = new NotificationDeliveryStore(storePath)

    const release = await lockfile.lock(storePath, { realpath: false })
    let readResolved = false
    const readPromise = store.read().then((value) => {
      readResolved = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readResolved).toBe(false)

    await release()
    const migrated = await readPromise
    expect(migrated.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(migrated.records.map((record) => record.deliveryId)).toEqual(['legacy-1', 'legacy-2'])
  })

  test('keeps both rows when a read-time migration races a concurrent append', async () => {
    await fs.writeFile(storePath, JSON.stringify(LEGACY_DELIVERY_LOG_FIXTURE), 'utf-8')
    const store = new NotificationDeliveryStore(storePath)

    await Promise.all([
      store.read(),
      store.append([
        {
          schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
          deliveryId: 'd-new',
          runId: 'run-new',
          taskId: 'task-new',
          channel: 'feishu',
          recipientId: 'ou_new',
          outcome: 'delivered',
          attempts: 1,
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      ]),
    ])

    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as {
      schemaVersion: number
      records: Array<{ deliveryId: string }>
    }
    expect(onDisk.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION)
    expect(onDisk.records.map((record) => record.deliveryId)).toEqual([
      'legacy-1',
      'legacy-2',
      'd-new',
    ])
  })
})