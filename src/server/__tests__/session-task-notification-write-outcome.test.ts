/**
 * The strict task-notification append: a caller that has an in-flight process
 * (a scheduled run) must be able to tell a real transcript write apart from a
 * silent no-op, and must never be told a line landed when it did not.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'

const NOTIFICATION_TYPE = 'cc-haha-task-notification'

describe('strict task notification writes', () => {
  let configDir = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmax-strict-notification-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    await fs.mkdir(path.join(configDir, 'projects'), { recursive: true })
    resetSettingsCache()
  })

  afterEach(async () => {
    mock.restore()
    resetSettingsCache()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  async function writeTranscript(sessionId: string, workDir: string): Promise<string> {
    return await writeTranscriptAt(transcriptPathFor(sessionId, workDir), workDir)
  }

  async function writeTranscriptAt(transcriptPath: string, workDir: string): Promise<string> {
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir,
        timestamp: '2026-10-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )
    return transcriptPath
  }

  function transcriptPathFor(sessionId: string, workDir: string): string {
    const projectDir = path.join(configDir, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'))
    return path.join(projectDir, `${sessionId}.jsonl`)
  }

  async function readNotifications(transcriptPath: string): Promise<Array<Record<string, unknown>>> {
    const raw = await fs.readFile(transcriptPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.type === NOTIFICATION_TYPE)
  }

  const terminalNotification = {
    taskId: 'background-1',
    toolUseId: 'toolu_background_1',
    status: 'completed' as const,
    summary: 'done',
    result: 'payload',
    timestamp: '2026-10-01T00:00:05.000Z',
  }

  /**
   * Intercept the JSONL append handle a task-notification write uses, so a test
   * can decide what that append does: hang, land, or fail. Every other file
   * access passes straight through.
   */
  function interceptNotificationAppend(
    intercept: (
      data: unknown,
      realWriteFile: (data: unknown, options?: unknown) => Promise<void>,
      options: { signal?: AbortSignal },
    ) => Promise<void>,
  ): void {
    const realOpen = fs.open
    spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      if (typeof args[1] !== 'number' || (args[1] & constants.O_APPEND) === 0) return handle
      const realWriteFile = handle.writeFile.bind(handle)
      spyOn(handle, 'writeFile').mockImplementation((data, options) =>
        intercept(
          data,
          (nextData, nextOptions) =>
            realWriteFile(nextData as never, nextOptions as never) as Promise<void>,
          (options ?? {}) as { signal?: AbortSignal },
        ),
      )
      return handle
    })
  }

  it('reports a real append as written and lands exactly one entry', async () => {
    const sessionId = crypto.randomUUID()
    const transcriptPath = await writeTranscript(sessionId, '/tmp/strict-written')
    const service = new SessionService()

    const outcome = await service.appendSessionTaskNotificationStrict(
      sessionId,
      terminalNotification,
    )

    expect(outcome).toEqual({ status: 'written' })
    expect(await readNotifications(transcriptPath)).toEqual([
      {
        type: NOTIFICATION_TYPE,
        isMeta: true,
        taskNotification: terminalNotification,
        timestamp: '2026-10-01T00:00:05.000Z',
      },
    ])
  })

  it('reports disabled instead of success when persistence is off', async () => {
    const sessionId = crypto.randomUUID()
    const transcriptPath = await writeTranscript(sessionId, '/tmp/strict-disabled')
    setSessionSettingsCache({ settings: { cleanupPeriodDays: 0 }, errors: [] })
    const service = new SessionService()

    expect(await service.appendSessionTaskNotificationStrict(sessionId, terminalNotification))
      .toEqual({ status: 'disabled' })
    expect(await readNotifications(transcriptPath)).toEqual([])
  })

  it('reports not-ready for a missing transcript and never recreates the file', async () => {
    const sessionId = crypto.randomUUID()
    const service = new SessionService()

    expect(await service.appendSessionTaskNotificationStrict(sessionId, terminalNotification))
      .toEqual({ status: 'not-ready' })
    expect(await service.findSessionFile(sessionId)).toBeNull()
  })

  it('waits a bounded time for a transcript the CLI has not written yet', async () => {
    const sessionId = crypto.randomUUID()
    const service = new SessionService()

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    const transcriptPath = await writeTranscript(sessionId, '/tmp/strict-late-transcript')

    expect(await append).toEqual({ status: 'written' })
    expect(await readNotifications(transcriptPath)).toHaveLength(1)
  })

  it('reports a failed write instead of a silent success', async () => {
    const sessionId = crypto.randomUUID()
    const transcriptPath = await writeTranscript(sessionId, '/tmp/strict-failed-write')
    interceptNotificationAppend(() => Promise.reject(new Error('disk full')))
    const service = new SessionService()

    const outcome = await service.appendSessionTaskNotificationStrict(
      sessionId,
      terminalNotification,
    )

    expect(outcome).toEqual({ status: 'failed', error: 'disk full' })
    expect(await readNotifications(transcriptPath)).toEqual([])
  })

  it('reports cancelled when a transcript clear races the append', async () => {
    const sessionId = crypto.randomUUID()
    const transcriptPath = await writeTranscript(sessionId, '/tmp/strict-clear-race')
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    interceptNotificationAppend((_data, _write, { signal }) => {
      markStarted()
      return new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    const service = new SessionService()

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await started
    await service.clearSessionTranscript(sessionId, '/tmp/strict-clear-race')

    expect(await append).toEqual({ status: 'cancelled' })
    expect(await readNotifications(transcriptPath)).toEqual([])
  })

  it('reports cancelled, not not-ready, when a clear lands while the append waits for a missing transcript', async () => {
    // The append spends its bounded retry window looking for a transcript that
    // does not exist yet. A clear that lands in that window is the reason it
    // never appears, so the caller must be told the write was cancelled —
    // `not-ready` would invite it to treat the terminal state as merely delayed.
    const sessionId = crypto.randomUUID()
    const workDir = '/tmp/ccmax-strict-clear-during-wait'
    const service = new SessionService()

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    await service.clearSessionTranscript(sessionId, workDir)

    expect(await append).toEqual({ status: 'cancelled' })
    // The cleared transcript is a fresh generation and holds no terminal state.
    const cleared = await service.findSessionFile(sessionId)
    expect(cleared).not.toBeNull()
    expect(await readNotifications(cleared!.filePath)).toEqual([])
  })

  it('keeps exactly one entry when a clear races a landed append and then fails to replace the file', async () => {
    // The clear's replacement write fails, so the original transcript — with the
    // append already in it — is still on disk. The clear only restores what it
    // actually interrupted, so re-appending here would duplicate the terminal.
    const sessionId = crypto.randomUUID()
    const workDir = '/tmp/ccmax-strict-failed-clear-race'
    const transcriptPath = await writeTranscript(sessionId, workDir)
    let markLanded!: () => void
    const landed = new Promise<void>((resolve) => {
      markLanded = resolve
    })
    let release!: () => void
    const releaseAppend = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new SessionService()
    interceptNotificationAppend(async (data, write) => {
      await write(data)
      markLanded()
      await releaseAppend
    })

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await landed
    spyOn(fs, 'writeFile').mockImplementation(() =>
      Promise.reject(new Error('transcript replacement failed')),
    )
    const clear = service.clearSessionTranscript(sessionId, workDir)
    release()

    await expect(clear).rejects.toThrow('transcript replacement failed')
    expect(await append).toEqual({ status: 'cancelled' })
    expect(await readNotifications(transcriptPath)).toEqual([
      {
        type: NOTIFICATION_TYPE,
        isMeta: true,
        taskNotification: terminalNotification,
        timestamp: '2026-10-01T00:00:05.000Z',
      },
    ])
  })

  it('never writes the old terminal state into a transcript recreated under the same id after a delete', async () => {
    // A delete is the other owner of this barrier. Without it, an append still
    // inside its missing-file retry window would find the recreated transcript
    // and write a terminal state that belongs to the previous generation.
    const workDir = '/tmp/ccmax-strict-delete-recreate'
    await fs.mkdir(workDir, { recursive: true })
    const service = new SessionService()
    const { sessionId } = await service.createSession(workDir)
    const created = await service.findSessionFile(sessionId)
    expect(created).not.toBeNull()
    const transcriptPath = created!.filePath
    // The transcript is gone while the session id is still known: the window the
    // strict append spends retrying.
    await fs.rm(transcriptPath)

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    await service.deleteSession(sessionId)
    await writeTranscriptAt(transcriptPath, workDir)

    expect(await append).toEqual({ status: 'cancelled' })
    expect(await readNotifications(transcriptPath)).toEqual([])
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('never writes the old terminal state into a transcript recreated under the same id after deleteSessionFile', async () => {
    // The manual "Run Now" flow deletes its placeholder transcript through
    // `deleteSessionFile`, so that is a second delete entry point the barrier
    // has to cover — including when the file is already gone, which is exactly
    // the state an append retrying a missing transcript is waiting in.
    const workDir = '/tmp/ccmax-strict-delete-file-recreate'
    await fs.mkdir(workDir, { recursive: true })
    const service = new SessionService()
    const { sessionId } = await service.createSession(workDir)
    const created = await service.findSessionFile(sessionId)
    expect(created).not.toBeNull()
    const transcriptPath = created!.filePath
    await fs.rm(transcriptPath)

    const append = service.appendSessionTaskNotificationStrict(sessionId, terminalNotification)
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    await service.deleteSessionFile(sessionId)
    await writeTranscriptAt(transcriptPath, workDir)

    expect(await append).toEqual({ status: 'cancelled' })
    expect(await readNotifications(transcriptPath)).toEqual([])
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('still persists a notification into the transcript the CLI writes after its placeholder was deleted', async () => {
    // The barrier a delete raises is transient: once the delete is done, the
    // generation the CLI creates next is the current one, and its terminal
    // states must land normally.
    const workDir = '/tmp/ccmax-strict-placeholder-delete'
    await fs.mkdir(workDir, { recursive: true })
    const service = new SessionService()
    const { sessionId } = await service.createSession(workDir)
    const placeholder = await service.findSessionFile(sessionId)
    expect(placeholder).not.toBeNull()

    // What the manual run does: create the session, drop the placeholder, and
    // let the CLI create the real transcript under the same path.
    await service.deleteSessionFile(sessionId)
    expect(await service.findSessionFile(sessionId)).toBeNull()

    const transcriptPath = await writeTranscriptAt(placeholder!.filePath, workDir)
    const outcome = await service.appendSessionTaskNotificationStrict(
      sessionId,
      terminalNotification,
    )

    expect(outcome).toEqual({ status: 'written' })
    expect(await readNotifications(transcriptPath)).toHaveLength(1)
    await fs.rm(workDir, { recursive: true, force: true })
  })
})