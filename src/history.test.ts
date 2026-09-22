import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as lockfile from './utils/lockfile.js'
import * as sleepUtils from './utils/sleep.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let testConfigDir: string | null = null

afterEach(async () => {
  mock.restore()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (testConfigDir) {
    await fsPromises.rm(testConfigDir, { recursive: true, force: true })
    testConfigDir = null
  }
})

describe('prompt history persistence', () => {
  test('reconciles partial and fully committed append failures without duplicates', async () => {
    const configDir = await fsPromises.mkdtemp(
      join(tmpdir(), 'cc-haha-history-test-'),
    )
    testConfigDir = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir

    let appendCalls = 0
    let behaviorCalls = 0
    let behavior:
      | 'partial-then-success'
      | 'full-then-error'
      | 'rollback-fails'
      | 'read-fails'
      | 'unexpected-tail' = 'partial-then-success'
    const appendEntered: Deferred[] = []
    const appendSettled: Deferred[] = []
    const flushReleased: Deferred[] = []
    let flushReleases = 0
    let truncateSettled = createDeferred()
    let reconcileReadSettled = createDeferred()
    let retryDelayEntered = createDeferred()
    let retryDelayRelease = createDeferred()
    let retryDelayFinished = createDeferred()
    const realAppendFile = fsPromises.appendFile
    const realReadFile = fsPromises.readFile
    const realTruncate = fsPromises.truncate
    const realSleep = sleepUtils.sleep
    const realLock = lockfile.lock

    const waitForNextAppend = (): Promise<void> =>
      latchAt(appendSettled, appendCalls).promise

    const waitForNextFlushRelease = (): Promise<void> =>
      latchAt(flushReleased, flushReleases).promise

    const armRetryDelay = (): void => {
      retryDelayEntered = createDeferred()
      retryDelayRelease = createDeferred()
      retryDelayFinished = createDeferred()
    }

    const observeRetryDelay = async (): Promise<void> => {
      await retryDelayEntered.promise
      retryDelayRelease.resolve()
      await retryDelayFinished.promise
      await Promise.resolve()
    }

    mock.module('./utils/sleep.js', () => ({
      ...sleepUtils,
      sleep: async (
        ms: number,
        signal?: AbortSignal,
        opts?: Parameters<typeof sleepUtils.sleep>[2],
      ) => {
        if (ms === 500) {
          retryDelayEntered.resolve()
          await retryDelayRelease.promise
          retryDelayFinished.resolve()
          return
        }
        return realSleep(ms, signal, opts)
      },
    }))
    mock.module('./utils/lockfile.js', () => ({
      ...lockfile,
      lock: async (
        ...args: Parameters<typeof lockfile.lock>
      ): ReturnType<typeof lockfile.lock> => {
        const release = await realLock(...args)
        return async () => {
          try {
            await release()
          } finally {
            latchAt(flushReleased, flushReleases).resolve()
            flushReleases += 1
          }
        }
      },
    }))
    mock.module('fs/promises', () => ({
      ...fsPromises,
      appendFile: async (...args: Parameters<typeof fsPromises.appendFile>) => {
        appendCalls += 1
        behaviorCalls += 1
        const invocation = appendCalls - 1
        latchAt(appendEntered, invocation).resolve()
        try {
          if (behavior === 'partial-then-success' && behaviorCalls === 1) {
            const payload = Buffer.from(String(args[1]))
            await realAppendFile(
              args[0],
              payload.subarray(0, Math.floor(payload.length / 2)),
              { mode: 0o600 },
            )
            throw new Error('injected partial append failure')
          }
          if (behavior === 'full-then-error' && behaviorCalls === 1) {
            await realAppendFile(...args)
            throw new Error('injected post-commit append failure')
          }
          if (behavior === 'rollback-fails' && behaviorCalls === 1) {
            const payload = Buffer.from(String(args[1]))
            await realAppendFile(
              args[0],
              payload.subarray(0, Math.floor(payload.length / 2)),
              { mode: 0o600 },
            )
            throw new Error('injected partial append failure')
          }
          if (behavior === 'read-fails' && behaviorCalls === 1) {
            throw new Error('injected append failure before reconciliation read')
          }
          if (behavior === 'unexpected-tail' && behaviorCalls === 1) {
            await realAppendFile(args[0], 'not-a-payload-prefix', {
              mode: 0o600,
            })
            throw new Error('injected append with unexpected tail')
          }
          return await realAppendFile(...args)
        } finally {
          latchAt(appendSettled, invocation).resolve()
        }
      },
      readFile: async (...args: Parameters<typeof fsPromises.readFile>) => {
        try {
          if (behavior === 'read-fails' && behaviorCalls === 1) {
            throw new Error('injected reconciliation read failure')
          }
          return await realReadFile(...args)
        } finally {
          reconcileReadSettled.resolve()
        }
      },
      truncate: async (...args: Parameters<typeof fsPromises.truncate>) => {
        try {
          if (behavior === 'rollback-fails') {
            throw new Error('injected rollback failure')
          }
          return await realTruncate(...args)
        } finally {
          truncateSettled.resolve()
        }
      },
    }))

    const history = await import('./history.js')
    history.clearPendingHistoryEntries()
    const firstPartialDone = waitForNextAppend()
    const firstFlushDone = waitForNextFlushRelease()
    history.addToHistory('FIRST_SENTINEL_你好😀')

    await firstPartialDone
    await truncateSettled.promise
    await firstFlushDone
    const firstRetryDone = waitForNextAppend()
    const firstRetryFlushDone = waitForNextFlushRelease()
    await observeRetryDelay()
    await firstRetryDone
    await firstRetryFlushDone
    const historyPath = join(configDir, 'history.jsonl')

    const contents = await fsPromises.readFile(historyPath, 'utf8')
    expect(contents.match(/FIRST_SENTINEL/g)).toHaveLength(1)

    behavior = 'full-then-error'
    behaviorCalls = 0
    reconcileReadSettled = createDeferred()
    const fullThenErrorDone = waitForNextAppend()
    const fullThenErrorFlushDone = waitForNextFlushRelease()
    history.addToHistory('SECOND_SENTINEL')
    await fullThenErrorDone
    await reconcileReadSettled.promise
    await fullThenErrorFlushDone

    const reconciled = await fsPromises.readFile(historyPath, 'utf8')
    expect(reconciled.match(/FIRST_SENTINEL/g)).toHaveLength(1)
    expect(reconciled.match(/SECOND_SENTINEL/g)).toHaveLength(1)
    for (const line of reconciled.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const realDateNow = Date.now
    Date.now = () => 1_234_567_890
    behavior = 'partial-then-success'
    behaviorCalls = 1
    const sameTimeDone = waitForNextAppend()
    const sameTimeFlushDone = waitForNextFlushRelease()
    try {
      history.addToHistory('SAME_TIME_A')
      history.addToHistory('SAME_TIME_B')
    } finally {
      Date.now = realDateNow
    }
    await sameTimeDone
    await sameTimeFlushDone
    history.removeLastFromHistory()
    const visible: string[] = []
    for await (const entry of history.makeHistoryReader()) {
      if (entry.display.startsWith('SAME_TIME_')) {
        visible.push(entry.display)
      }
    }
    expect(visible).toEqual(['SAME_TIME_A'])

    history.clearPendingHistoryEntries()
    behavior = 'rollback-fails'
    behaviorCalls = 0
    truncateSettled = createDeferred()
    armRetryDelay()
    const rollbackAppendDone = waitForNextAppend()
    const rollbackFlushDone = waitForNextFlushRelease()
    history.addToHistory('POISONED_SENTINEL')
    await rollbackAppendDone
    await truncateSettled.promise
    await rollbackFlushDone
    await observeRetryDelay()
    expect(behaviorCalls).toBe(1)
    const pending: string[] = []
    for await (const entry of history.makeHistoryReader()) {
      if (entry.display === 'POISONED_SENTINEL') {
        pending.push(entry.display)
      }
    }
    expect(pending).toEqual(['POISONED_SENTINEL'])

    history.clearPendingHistoryEntries()
    behavior = 'read-fails'
    behaviorCalls = 0
    reconcileReadSettled = createDeferred()
    armRetryDelay()
    const readFailAppendDone = waitForNextAppend()
    const readFailFlushDone = waitForNextFlushRelease()
    history.addToHistory('READ_FAILURE_SENTINEL')
    await readFailAppendDone
    await reconcileReadSettled.promise
    await readFailFlushDone
    await observeRetryDelay()
    expect(behaviorCalls).toBe(1)

    history.clearPendingHistoryEntries()
    behavior = 'unexpected-tail'
    behaviorCalls = 0
    reconcileReadSettled = createDeferred()
    armRetryDelay()
    const unexpectedTailDone = waitForNextAppend()
    const unexpectedTailFlushDone = waitForNextFlushRelease()
    history.addToHistory('UNEXPECTED_TAIL_SENTINEL')
    await unexpectedTailDone
    await reconcileReadSettled.promise
    await unexpectedTailFlushDone
    await observeRetryDelay()
    expect(behaviorCalls).toBe(1)

    history.clearPendingHistoryEntries()
  })
})

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function latchAt(latches: Deferred[], index: number): Deferred {
  while (latches.length <= index) {
    latches.push(createDeferred())
  }
  return latches[index]!
}