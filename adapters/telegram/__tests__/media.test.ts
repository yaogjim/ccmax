import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { TelegramMediaService, TelegramDownloadCancelledError, TelegramDownloadTooLargeError } from '../media.js'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'

let tmpRoot: string
let originalFetch: typeof fetch

function makeMockBot() {
  const fetchMock = mock(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString()
    expect(u).toContain('/file/botFAKE_TOKEN/photos/abc.jpg')
    return new Response(Buffer.from('PHOTODATA'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  })
  ;(globalThis as any).fetch = fetchMock
  return {
    token: 'FAKE_TOKEN',
    api: {
      getFile: mock(async (fileId: string) => ({
        file_id: fileId,
        file_unique_id: 'unique',
        file_path: 'photos/abc.jpg',
      })),
      sendPhoto: mock(async () => ({ message_id: 1 })),
      sendDocument: mock(async () => ({ message_id: 2 })),
    },
    fetchMock,
  }
}

beforeEach(async () => {
  originalFetch = globalThis.fetch
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-test-'))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('TelegramMediaService', () => {
  it('downloadFile fetches the real URL and stores a LocalAttachment', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    const local = await svc.downloadFile('fid_123', 'sess-1', {
      fileName: 'abc.jpg',
      mimeType: 'image/jpeg',
    })
    expect(local.kind).toBe('image')
    expect(local.name).toBe('abc.jpg')
    expect(local.size).toBe('PHOTODATA'.length)
    expect(local.buffer.toString()).toBe('PHOTODATA')
    const onDisk = await fs.readFile(local.path)
    expect(onDisk.toString()).toBe('PHOTODATA')
  })

  it('sendPhoto calls bot.api.sendPhoto with InputFile-like payload', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await svc.sendPhoto(42, Buffer.from('IMG'), 'caption text')
    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1)
    const args = (bot.api.sendPhoto as any).mock.calls[0]
    expect(args[0]).toBe(42)
    // grammY InputFile wraps the buffer; just verify it's an object.
    expect(args[1]).toBeDefined()
    expect(args[2]?.caption).toBe('caption text')
  })

  it('sendDocument calls bot.api.sendDocument', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await svc.sendDocument(42, Buffer.from('DOC'), 'spec.pdf')
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
    const args = (bot.api.sendDocument as any).mock.calls[0]
    expect(args[0]).toBe(42)
    expect(args[1]).toBeDefined()
  })

  it('carries mediaKind voice and the reported duration onto the staged attachment', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    const local = await svc.downloadFile('fid_voice', 'sess-1', {
      fileName: 'voice.ogg',
      mimeType: 'audio/ogg',
      mediaKind: 'voice',
      durationSeconds: 12,
    })
    expect(local.mediaKind).toBe('voice')
    expect(local.durationSeconds).toBe(12)
    expect(local.kind).toBe('file')
  })

  it('rejects a response that exceeds the streaming byte cap', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await expect(svc.downloadFile('fid_big', 'sess-1', {}, { maxBytes: 4 }))
      .rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
  })

  it('pre-checks the Telegram-reported file_size before downloading any bytes', async () => {
    const bot = makeMockBot()
    bot.api.getFile = mock(async (fileId: string) => ({
      file_id: fileId,
      file_unique_id: 'unique',
      file_path: 'photos/abc.jpg',
      file_size: 10_000,
    })) as any
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await expect(svc.downloadFile('fid_oversize', 'sess-1', {}, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
    expect(bot.fetchMock).not.toHaveBeenCalled()
  })

  it('aborts on timeout instead of waiting forever', async () => {
    const bot = makeMockBot()
    ;(globalThis as any).fetch = mock((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await expect(svc.downloadFile('fid_slow', 'sess-1', {}, { timeoutMs: 20 }))
      .rejects.toThrow('timed out')
  })

  it('honours a caller AbortSignal before and during the transfer', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)

    const already = new AbortController()
    already.abort()
    await expect(svc.downloadFile('fid_cancel', 'sess-1', {}, { signal: already.signal }))
      .rejects.toBeInstanceOf(TelegramDownloadCancelledError)

    ;(globalThis as any).fetch = mock((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
    const controller = new AbortController()
    const pending = svc.downloadFile('fid_cancel2', 'sess-1', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(TelegramDownloadCancelledError)
  })

  it('settles promptly when the caller aborts while bot.api.getFile is still pending', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    // grammY gives no way to abort getFile itself, so a caller that gives up
    // must not be held hostage by it (the queue slot behind the download would
    // be stuck until the request returns).
    let settle: ((value: unknown) => void) | undefined
    const bot = {
      token: 'FAKE_TOKEN',
      api: {
        getFile: mock(() => new Promise((resolve) => { settle = resolve })),
        sendPhoto: mock(async () => ({ message_id: 1 })),
        sendDocument: mock(async () => ({ message_id: 2 })),
      },
    }
    const fetchMock = mock(async () => new Response(Buffer.from('x'), { status: 200 }))
    ;(globalThis as any).fetch = fetchMock
    const svc = new TelegramMediaService(bot as any, store)

    const controller = new AbortController()
    const pending = svc.downloadFile('fid_slow_getfile', 'sess-1', {}, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(TelegramDownloadCancelledError)
    // Nothing was fetched and nothing was staged.
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(fs.readdir(tmpRoot)).resolves.toEqual([])
    // Let the abandoned request finish so the test leaves no pending promise.
    settle?.({ file_id: 'fid_slow_getfile', file_unique_id: 'u', file_path: 'photos/abc.jpg' })
  })

  it('times out a bot.api.getFile that never settles even with no caller signal', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    // grammY exposes no signal for getFile, so with no caller signal the
    // deadline is the *only* thing that can end this download. Before the
    // budget covered the metadata call, this request hung the download — and
    // the chat's queue slot behind it — until Telegram answered.
    let getFileCalls = 0
    const bot = {
      token: 'FAKE_TOKEN',
      api: {
        getFile: mock(() => {
          getFileCalls += 1
          return new Promise(() => {})
        }),
        sendPhoto: mock(async () => ({ message_id: 1 })),
        sendDocument: mock(async () => ({ message_id: 2 })),
      },
    }
    const fetchMock = mock(async () => new Response(Buffer.from('x'), { status: 200 }))
    ;(globalThis as any).fetch = fetchMock
    const svc = new TelegramMediaService(bot as any, store)

    const error = await svc.downloadFile('fid_hanging_getfile', 'sess-1', {}, { timeoutMs: 20 })
      .then(() => undefined, (err: unknown) => err as Error)

    expect(error?.message).toBe('[TelegramMedia] download timed out')
    // A deadline is not a user cancellation: the entrypoint stays silent for a
    // cancel but notifies for a failure, so the two must stay distinct.
    expect(error).not.toBeInstanceOf(TelegramDownloadCancelledError)
    expect(getFileCalls).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(fs.readdir(tmpRoot)).resolves.toEqual([])
  })

  it('times out while a hermetic response stream is still pending and stages nothing', async () => {
    const bot = makeMockBot()
    let streamCancelled = false
    // A body that never enqueues and is *not* wired to the fetch abort signal.
    // The real transport aborts its stream, but the contract cannot depend on
    // that: a pending reader.read must be raced with the deadline itself.
    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() { streamCancelled = true },
    })
    ;(globalThis as any).fetch = mock(async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)

    const error = await svc.downloadFile('fid_pending_stream', 'sess-1', {}, { timeoutMs: 20 })
      .then(() => undefined, (err: unknown) => err as Error)

    expect(error?.message).toBe('[TelegramMedia] download timed out')
    expect(error).not.toBeInstanceOf(TelegramDownloadCancelledError)
    // The stuck reader was released rather than left holding the stream.
    expect(streamCancelled).toBe(true)
    await expect(fs.readdir(tmpRoot)).resolves.toEqual([])
  })

  it('reports a caller abort during a pending stream read as a cancellation, not a timeout', async () => {
    const bot = makeMockBot()
    const stream = new ReadableStream<Uint8Array>({ start() {} })
    let fetchStarted!: () => void
    const started = new Promise<void>((resolve) => { fetchStarted = resolve })
    ;(globalThis as any).fetch = mock(async () => {
      fetchStarted()
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    })
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)

    const controller = new AbortController()
    // No short timeout here: the caller's own signal must be what ends this
    // download, and it must be reported as a cancellation.
    const pending = svc.downloadFile('fid_stream_cancel', 'sess-1', {}, { signal: controller.signal })
    await started
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(TelegramDownloadCancelledError)
    await expect(fs.readdir(tmpRoot)).resolves.toEqual([])
  })
})
