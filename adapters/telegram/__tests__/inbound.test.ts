import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { LocalAttachment } from '../../common/attachment/attachment-types.js'
import { FakeTranscriptionProvider } from '../../common/attachment/transcribe/fake.js'
import type { DownloadHint } from '../media.js'
import {
  TELEGRAM_HANDOVER_DONE,
  collectTelegramLocalAttachments,
  assembleTelegramMessage,
  planTelegramOutbound,
  setTelegramTranscriber,
  setTelegramLanguageHint,
  splitTelegramNotices,
} from '../inbound.js'

/**
 * Telegram inbound helper 测试：collect / assemble / plan 的边界接线，见
 * docs/internals/im-media-pipeline.md。
 *
 * 这些用例证明 helper 的组装结果，不证明真实 Telegram 平台、真实模型或
 * grammY 入口全链路。入口行为见 entrypoint-voice.test.ts。
 *
 * Hermetic：不 import entrypoint、不触网、不读真实 Telegram API。下载用
 * fake downloader（内存里 stage 真实临时文件，path 指向真实字节）；转写用
 * FakeTranscriptionProvider。三个断言对应 helper 契约：
 *  1. 转写成功 → text 含转写文本、无音频附件；
 *  2. 未配置 transcriber → 音频作 file 引用 + 降级 notice；
 *  3. provider 失败（too_long / provider_error）→ 降级。
 */

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-inbound-test-'))
})

afterEach(async () => {
  // 恢复模块级注入槽，避免泄漏到其他测试文件（bun test 共享模块缓存）。
  setTelegramTranscriber(undefined)
  setTelegramLanguageHint('zh')
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function stageLocal(
  name: string,
  bytes: string,
  overrides: Partial<LocalAttachment> = {},
): Promise<LocalAttachment> {
  const target = path.join(tmpRoot, name)
  await fs.writeFile(target, bytes)
  return {
    kind: 'file',
    name,
    path: target,
    size: Buffer.byteLength(bytes),
    mimeType: 'audio/ogg',
    buffer: Buffer.from(bytes),
    ...overrides,
  }
}

/** Fake TelegramFileDownloader: writes to the temp dir like the real one,
 *  and classifies kind from the MIME the same way the real service does. */
function makeDownloader(overrides: Record<string, Partial<LocalAttachment>> = {}) {
  return async (fileId: string, hint: DownloadHint): Promise<LocalAttachment> => {
    const name = hint.fileName ?? `${fileId}.bin`
    const mimeType = hint.mimeType ?? 'application/octet-stream'
    const kind: LocalAttachment['kind'] = mimeType.startsWith('image/') ? 'image' : 'file'
    return stageLocal(name, `BYTES:${fileId}`, {
      kind,
      mimeType,
      ...(hint.mediaKind ? { mediaKind: hint.mediaKind } : {}),
      ...(hint.durationSeconds !== undefined ? { durationSeconds: hint.durationSeconds } : {}),
      ...overrides[fileId],
    })
  }
}

/** grammY voice message fixture (only fields collect reads). */
function voiceMessage(fileId = 'voice-fid-1') {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 1, type: 'private' as const },
    voice: {
      file_id: fileId,
      file_unique_id: 'uniq-1',
      duration: 12,
      mime_type: 'audio/ogg',
    },
  }
}

/** grammY photo message fixture. */
function photoMessage(fileId = 'photo-fid-1') {
  return {
    message_id: 2,
    date: 1,
    chat: { id: 1, type: 'private' as const },
    photo: [{ file_id: fileId, file_unique_id: 'puniq', width: 1, height: 1 }],
  }
}

describe('collectTelegramLocalAttachments', () => {
  it('marks voice notes as mediaKind voice with their duration and stages them', async () => {
    const { locals, rejections } = await collectTelegramLocalAttachments(
      voiceMessage() as any,
      { download: makeDownloader() },
    )
    expect(rejections).toEqual([])
    expect(locals).toHaveLength(1)
    expect(locals[0]?.mediaKind).toBe('voice')
    expect(locals[0]?.durationSeconds).toBe(12)
    expect(locals[0]?.name).toBe('voice-uniq-1.ogg')
    expect(locals[0]?.mimeType).toBe('audio/ogg')
  })

  it('leaves ordinary audio files unmarked so they are never transcribed', async () => {
    const msg = {
      message_id: 3,
      date: 1,
      chat: { id: 1, type: 'private' as const },
      audio: { file_id: 'audio-fid', file_unique_id: 'auniq', file_name: 'song.mp3', mime_type: 'audio/mpeg' },
    }
    const { locals } = await collectTelegramLocalAttachments(msg as any, {
      download: makeDownloader(),
    })
    expect(locals).toHaveLength(1)
    expect(locals[0]?.mediaKind).toBeUndefined()
    expect(locals[0]?.name).toBe('song.mp3')
  })

  it('leaves photos without mediaKind (pipeline maps them to inline image refs)', async () => {
    const { locals } = await collectTelegramLocalAttachments(photoMessage() as any, {
      download: makeDownloader(),
    })
    expect(locals).toHaveLength(1)
    expect(locals[0]?.mediaKind).toBeUndefined()
    expect(locals[0]?.mimeType).toBe('image/jpeg')
  })

  it('keeps the size-gate rejection hints working', async () => {
    const big = await makeDownloader({ 'voice-fid-1': { size: 31 * 1024 * 1024 } })
    const { locals, rejections } = await collectTelegramLocalAttachments(
      voiceMessage() as any,
      { download: big },
    )
    expect(locals).toEqual([])
    expect(rejections).toEqual(['📎 文件过大(31.0 MB),请控制在 30 MB 以内'])
  })

  it('reports a download failure as a rejection without staging', async () => {
    const failing = async () => {
      throw new Error('fixture network failure')
    }
    const logError = console.error
    console.error = () => {}
    try {
      const { locals, rejections } = await collectTelegramLocalAttachments(
        voiceMessage() as any,
        { download: failing },
      )
      expect(locals).toEqual([])
      expect(rejections).toEqual(['📎 附件下载失败,请稍后重试'])
    } finally {
      console.error = logError
    }
  })

  it('an aborted signal short-circuits collection without a download or notice', async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort()
    const { locals, rejections } = await collectTelegramLocalAttachments(
      voiceMessage() as any,
      {
        signal: controller.signal,
        download: async (..._args: unknown[]) => {
          calls += 1
          throw new Error('should not run')
        },
      },
    )
    expect(calls).toBe(0)
    expect(locals).toEqual([])
    expect(rejections).toEqual([])
  })

  it('refuses an over-long voice before downloading it and never claims a file was delivered', async () => {
    let downloads = 0
    const { locals, rejections } = await collectTelegramLocalAttachments(
      { ...voiceMessage(), voice: { file_id: 'voice-long', file_unique_id: 'uniq-long', duration: 400, mime_type: 'audio/ogg' } } as any,
      {
        download: async () => {
          downloads += 1
          throw new Error('must not download an over-long voice')
        },
      },
    )
    expect(downloads).toBe(0)
    expect(locals).toEqual([])
    expect(rejections).toEqual([
      '🎧 语音时长 400 秒，超过 300 秒上限，已拒绝转写；该语音未下载，请改发文字或更短的语音。',
    ])
    // Nothing was downloaded, so the notice must not claim delivery.
    expect(rejections[0]).not.toContain('已作为文件转交')
  })

  it('accepts a voice exactly at the duration ceiling', async () => {
    const { locals, rejections } = await collectTelegramLocalAttachments(
      { ...voiceMessage(), voice: { file_id: 'voice-edge', file_unique_id: 'uniq-edge', duration: 300, mime_type: 'audio/ogg' } } as any,
      { download: makeDownloader() },
    )
    expect(rejections).toEqual([])
    expect(locals).toHaveLength(1)
    expect(locals[0]?.durationSeconds).toBe(300)
  })

  it('honours a caller-supplied duration ceiling', async () => {
    let downloads = 0
    const { rejections } = await collectTelegramLocalAttachments(
      voiceMessage() as any,
      {
        maxTranscribeDurationSeconds: 5,
        download: async () => {
          downloads += 1
          throw new Error('must not download')
        },
      },
    )
    expect(downloads).toBe(0)
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain('超过 5 秒上限')
  })
})

describe('splitTelegramNotices', () => {
  it('defers the handover claim until the message actually went out', () => {
    const { degrade, claims, receipts } = splitTelegramNotices([
      '🎧 语音转写未配置，「a.ogg」已作为文件转交',
      '📝 语音转写「a.ogg」：识别内容',
    ])
    // Before the send the notice states the intent; «已作为文件转交» is only
    // true once bridge.sendUserMessage accepted the file.
    expect(degrade).toEqual(['🎧 语音转写未配置，「a.ogg」将作为文件转交'])
    expect(degrade[0]).not.toContain(TELEGRAM_HANDOVER_DONE)
    expect(claims).toEqual(['✅ 语音已作为文件转交：「a.ogg」。'])
    expect(receipts).toEqual(['📝 语音转写「a.ogg」：识别内容'])
  })

  it('leaves a notice without a handover claim untouched and claims nothing', () => {
    const { degrade, claims } = splitTelegramNotices(['🎧 语音时长 400 秒，超过 300 秒上限'])
    expect(degrade).toEqual(['🎧 语音时长 400 秒，超过 300 秒上限'])
    expect(claims).toEqual([])
  })
})

describe('assembleTelegramMessage helper (not a live Telegram or model path)', () => {
  it('1. success: bridge text contains the transcript, no audio attachment', async () => {
    setTelegramTranscriber(
      new FakeTranscriptionProvider([{ result: { ok: true, text: '今天发布推迟到周五' } }]),
    )
    const { locals } = await collectTelegramLocalAttachments(voiceMessage() as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '帮我记一下')
    const { content, attachments } = planTelegramOutbound(enriched)

    // The exact arguments bridge.sendUserMessage would receive; no
    // attachments argument at all once the voice is fully transcribed.
    expect(content).toBe('帮我记一下\n\n🎤 语音转写（voice-uniq-1.ogg）：\n今天发布推迟到周五')
    expect(attachments).toBeUndefined()
    // A successful transcript is real content — no placeholder.
    expect(content).not.toContain('(用户发送了附件)')
  })

  it('1b. voice-only message with a successful transcript never hits the attachment placeholder', async () => {
    setTelegramTranscriber(
      new FakeTranscriptionProvider([{ result: { ok: true, text: '纯语音内容' } }]),
    )
    const { locals } = await collectTelegramLocalAttachments(voiceMessage() as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '')
    const { content, attachments } = planTelegramOutbound(enriched)
    expect(content).toBe('🎤 语音转写（voice-uniq-1.ogg）：\n纯语音内容')
    expect(content).not.toContain('(用户发送了附件)')
    expect(attachments).toBeUndefined()
  })

  it('2. no transcriber configured: audio degrades to a file ref plus a visible notice', async () => {
    const { locals } = await collectTelegramLocalAttachments(voiceMessage() as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '正文')
    const { content, attachments } = planTelegramOutbound(enriched)

    expect(content).toBe('正文')
    expect(attachments).toHaveLength(1)
    expect(attachments![0]!.type).toBe('file')
    expect(attachments![0]!.name).toBe('voice-uniq-1.ogg')
    // The staged file path points at real bytes the agent can read.
    const onDisk = await fs.readFile(attachments![0]!.path!)
    expect(onDisk.toString()).toBe('BYTES:voice-fid-1')
    expect(enriched.notices).toEqual([
      '🎧 语音转写未配置，「voice-uniq-1.ogg」已作为文件转交',
    ])
  })

  it('3a. provider returns too_long: audio kept as file ref with a degrade notice', async () => {
    setTelegramTranscriber(
      new FakeTranscriptionProvider([{ result: { ok: false, reason: 'too_long', detail: '6min' } }]),
    )
    const { locals } = await collectTelegramLocalAttachments(voiceMessage() as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '')
    const { content, attachments } = planTelegramOutbound(enriched)

    expect(content).toBe('(用户发送了附件)') // degrade keeps the message flowing
    expect(attachments).toHaveLength(1)
    expect(attachments![0]!.type).toBe('file')
    expect(enriched.notices).toEqual([
      '🎧 语音过长已跳过转写，「voice-uniq-1.ogg」已作为文件转交',
    ])
  })

  it('3b. provider throws (provider_error): degrade without blocking the message', async () => {
    setTelegramTranscriber(
      new FakeTranscriptionProvider([
        { result: { ok: false, reason: 'provider_error', detail: 'boom' } },
      ]),
    )
    const { locals } = await collectTelegramLocalAttachments(voiceMessage() as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '正文')
    const { content, attachments } = planTelegramOutbound(enriched)

    expect(content).toBe('正文')
    expect(attachments![0]!.type).toBe('file')
    expect(enriched.notices).toEqual([
      '🎧 语音转写失败，「voice-uniq-1.ogg」已作为文件转交',
    ])
  })

  it('mixed voice + photo: image stays inline while the voice is transcribed', async () => {
    setTelegramTranscriber(
      new FakeTranscriptionProvider([{ result: { ok: true, text: '看下这张图' } }]),
    )
    const msg = {
      ...voiceMessage('voice-fid-2'),
      photo: [{ file_id: 'photo-fid-2', file_unique_id: 'p2', width: 1, height: 1 }],
    }
    const { locals } = await collectTelegramLocalAttachments(msg as any, {
      download: makeDownloader(),
    })
    const enriched = await assembleTelegramMessage(locals, '')
    const { content, attachments } = planTelegramOutbound(enriched)

    expect(content).toBe('🎤 语音转写（voice-uniq-1.ogg）：\n看下这张图')
    expect(attachments).toHaveLength(1)
    expect(attachments![0]!.type).toBe('image')
    expect(attachments![0]!.data).toBe(Buffer.from('BYTES:photo-fid-2').toString('base64'))
  })
})