import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { LocalAttachment } from '../attachment-types.js'
import { enrichAndAssemble, DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS } from '../pipeline.js'
import { FakeTranscriptionProvider } from '../transcribe/fake.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-test-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

/** Stage a real file in the temp dir so `path` refs point at real bytes. */
async function makeLocal(
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

function makeVoice(name: string, bytes = 'OGGBYTES', overrides: Partial<LocalAttachment> = {}) {
  return makeLocal(name, bytes, { mediaKind: 'voice', ...overrides })
}

function makeImage(bytes: string): LocalAttachment {
  return {
    kind: 'image',
    name: 'shot.png',
    path: path.join(tmpRoot, 'shot.png'),
    size: Buffer.byteLength(bytes),
    mimeType: 'image/png',
    buffer: Buffer.from(bytes),
  }
}

describe('enrichAndAssemble — success path', () => {
  it('merges a voice transcript into text; the voice is fully represented by it', async () => {
    const voice = await makeVoice('voice-abc.ogg')
    const provider = new FakeTranscriptionProvider([
      { result: { ok: true, text: '  今天天气不错  ' } },
    ])
    const result = await enrichAndAssemble([voice], '帮我看看这段话', { transcriber: provider })

    expect(result.text).toBe('帮我看看这段话\n\n🎤 语音转写（voice-abc.ogg）：\n今天天气不错')
    // A transcribed voice is fully represented by its transcript — the
    // original audio path is never handed downstream.
    expect(result.attachments).toEqual([])
    expect(result.transcripts).toEqual([{ name: 'voice-abc.ogg', text: '今天天气不错', language: undefined }])
    expect(result.cancelled).toBe(false)
    // The success notice carries the actual plain transcript text.
    expect(result.notices).toEqual(['📝 语音转写「voice-abc.ogg」：今天天气不错'])
  })

  it('works with empty original text (voice-only message)', async () => {
    const voice = await makeVoice('voice-1.ogg', 'AA')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '纯语音内容' } }])
    const result = await enrichAndAssemble([voice], '', { transcriber: provider })
    expect(result.text).toBe('🎤 语音转写（voice-1.ogg）：\n纯语音内容')
    expect(result.attachments).toEqual([])
  })

  it('fires the success receipt through onNotice, in message order', async () => {
    const voice = await makeVoice('voice-receipt.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '回执检查' } }])
    const seen: string[] = []
    const { notices } = await enrichAndAssemble([voice], '', {
      transcriber: provider,
      onNotice: (n) => seen.push(n),
    })
    expect(notices).toEqual(['📝 语音转写「voice-receipt.ogg」：回执检查'])
    expect(seen).toEqual(notices)
  })

  it('transcribes multiple voices in message order and forwards language hint', async () => {
    const a = await makeVoice('voice-a.ogg', 'A')
    const b = await makeVoice('voice-b.ogg', 'B')
    const provider = new FakeTranscriptionProvider([
      { result: { ok: true, text: '第一段' } },
      { result: { ok: true, text: '第二段', language: 'zh' } },
    ])
    const result = await enrichAndAssemble([a, b], '两段语音', {
      transcriber: provider,
      languageHint: 'zh',
    })
    expect(result.text).toBe(
      '两段语音\n\n🎤 语音转写（voice-a.ogg）：\n第一段\n\n🎤 语音转写（voice-b.ogg）：\n第二段',
    )
    expect(provider.calls.map((c) => c.fileName)).toEqual(['voice-a.ogg', 'voice-b.ogg'])
    expect(provider.calls.every((c) => c.languageHint === 'zh')).toBe(true)
    expect(result.transcripts.map((t) => t.text)).toEqual(['第一段', '第二段'])
  })

  it('forwards the duration ceiling and an abort signal to the provider', async () => {
    const voice = await makeVoice('voice-iface.ogg', 'V', { durationSeconds: 12 })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'ok' } }])
    await enrichAndAssemble([voice], '', { transcriber: provider, maxDurationSeconds: 42 })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.maxDurationSeconds).toBe(42)
    expect(provider.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults the forwarded duration ceiling to 300', async () => {
    const voice = await makeVoice('voice-default.ogg', 'V')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'ok' } }])
    await enrichAndAssemble([voice], '', { transcriber: provider })
    expect(provider.calls[0]?.maxDurationSeconds).toBe(DEFAULT_MAX_TRANSCRIBE_DURATION_SECONDS)
  })

  it('leaves non-voice attachments untouched and passes them through', async () => {
    const image = makeImage('PNGDATA')
    const pdf: LocalAttachment = {
      kind: 'file',
      name: 'report.pdf',
      path: path.join(tmpRoot, 'report.pdf'),
      size: 8,
      mimeType: 'application/pdf',
      buffer: Buffer.from('PDFBYTES'),
    }
    const provider = new FakeTranscriptionProvider()
    const result = await enrichAndAssemble([image, pdf], '看下这个', { transcriber: provider })
    expect(result.text).toBe('看下这个')
    expect(result.attachments).toEqual([
      { type: 'image', name: 'shot.png', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' },
      { type: 'file', name: 'report.pdf', path: pdf.path, mimeType: 'application/pdf' },
    ])
    expect(result.notices).toEqual([])
    expect(provider.calls).toHaveLength(0)
  })

  it('mixes: image passes through inline while voice is transcribed', async () => {
    const image = makeImage('IMG')
    const voice = await makeVoice('voice-mix.ogg', 'OGG')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '混合消息的语音' } }])
    const result = await enrichAndAssemble([voice, image], 'caption', { transcriber: provider })
    expect(result.text).toBe('caption\n\n🎤 语音转写（voice-mix.ogg）：\n混合消息的语音')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.type).toBe('image')
  })

  it('returns an empty message for empty input', async () => {
    const result = await enrichAndAssemble([], '  ')
    expect(result.text).toBe('')
    expect(result.attachments).toEqual([])
    expect(result.notices).toEqual([])
    expect(result.transcripts).toEqual([])
    expect(result.cancelled).toBe(false)
  })
})

describe('enrichAndAssemble — candidacy is explicit (mediaKind only)', () => {
  it('does not auto-transcribe mediaKind "audio"', async () => {
    const audio = await makeLocal('audio-clip.ogg', 'A')
    // `mediaKind` is a closed union in the protocol. Assign it dynamically to
    // stand in for a platform that sends an out-of-contract value: candidacy
    // must stay explicit, so anything but 'voice' is a plain file.
    Object.assign(audio, { mediaKind: 'audio' })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'should not run' } }])
    const result = await enrichAndAssemble([audio], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(0)
    expect(result.notices).toEqual([])
    expect(result.attachments).toEqual([
      { type: 'file', name: 'audio-clip.ogg', path: audio.path, mimeType: 'audio/ogg' },
    ])
  })

  it('does not infer voice from an audio MIME without the marker', async () => {
    const plain = await makeLocal('music.mp3', 'MP3', { mimeType: 'audio/mpeg' })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'should not run' } }])
    const result = await enrichAndAssemble([plain], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(0)
    expect(result.attachments[0]?.type).toBe('file')
  })

  it('an unknown mediaKind passes through untouched', async () => {
    const other = await makeLocal('clip.webm', 'W', {
      mimeType: 'audio/webm',
      mediaKind: 'video' as LocalAttachment['mediaKind'],
    })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'should not run' } }])
    const result = await enrichAndAssemble([other], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(0)
    expect(result.attachments[0]?.type).toBe('file')
  })
})

describe('enrichAndAssemble — duration gate', () => {
  it('rejects a voice whose reported duration exceeds the default ceiling, without calling the provider', async () => {
    const long = await makeVoice('voice-long.ogg', 'SMALL', { durationSeconds: 301 })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'unused' } }])
    const result = await enrichAndAssemble([long], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(0)
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.notices).toEqual(['🎧 语音过长已跳过转写，「voice-long.ogg」已作为文件转交'])
  })

  it('accepts a voice exactly at the ceiling', async () => {
    const voice = await makeVoice('voice-edge.ogg', 'V', { durationSeconds: 300 })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '还在范围内' } }])
    const result = await enrichAndAssemble([voice], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(1)
    expect(result.text).toContain('还在范围内')
  })

  it('honors a custom ceiling', async () => {
    const voice = await makeVoice('voice-custom.ogg', 'V', { durationSeconds: 20 })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'unused' } }])
    const result = await enrichAndAssemble([voice], '', {
      transcriber: provider,
      maxDurationSeconds: 10,
    })
    expect(provider.calls).toHaveLength(0)
    expect(result.notices.length).toBe(1)
  })

  it('never treats byte size as a duration (a tiny-but-long voice is gate by duration)', async () => {
    const tiny = await makeVoice('voice-tiny.ogg', 'X', { durationSeconds: 400 })
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'unused' } }])
    const result = await enrichAndAssemble([tiny], '', { transcriber: provider })
    expect(provider.calls).toHaveLength(0)
    expect(result.attachments).toHaveLength(1)
  })
})

describe('enrichAndAssemble — degradation paths', () => {
  it('no provider configured: voice degrades to file ref with a visible notice', async () => {
    const voice = await makeVoice('voice-x.ogg', 'OO')
    const result = await enrichAndAssemble([voice], '文字部分')
    expect(result.text).toBe('文字部分')
    expect(result.attachments).toEqual([
      { type: 'file', name: 'voice-x.ogg', path: voice.path, mimeType: 'audio/ogg' },
    ])
    expect(result.notices).toEqual(['🎧 语音转写未配置，「voice-x.ogg」已作为文件转交'])
  })

  it('provider returns a failure: degraded with a reason-specific notice', async () => {
    const voice = await makeVoice('voice-err.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([
      { result: { ok: false, reason: 'provider_error', detail: 'boom' } },
    ])
    const result = await enrichAndAssemble([voice], '正文', { transcriber: provider })
    expect(result.text).toBe('正文')
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.notices).toEqual(['🎧 语音转写失败，「voice-err.ogg」已作为文件转交'])
  })

  it('maps the new reasons (unavailable / invalid_audio / cancelled) to distinct notices', async () => {
    const cases: Array<[string, string]> = [
      ['unavailable', '🎧 语音转写引擎不可用，「n」已作为文件转交'],
      ['invalid_audio', '🎧 语音音频无法解码，「n」已作为文件转交'],
      ['cancelled', '🎧 语音转写已取消，「n」已作为文件转交'],
      ['unsupported_format', '🎧 语音格式暂不支持转写，「n」已作为文件转交'],
      ['too_long', '🎧 语音过长已跳过转写，「n」已作为文件转交'],
      ['no_credentials', '🎧 语音转写服务未配置凭据，「n」已作为文件转交'],
    ]
    for (const [reason, expected] of cases) {
      const voice = await makeVoice('n', 'OO')
      const provider = new FakeTranscriptionProvider([
        { result: { ok: false, reason: reason as 'unavailable' } },
      ])
      const result = await enrichAndAssemble([voice], '', { transcriber: provider })
      expect(result.notices).toEqual([expected])
    }
  })

  it('provider rejects (throws) instead of returning a result: degrade without crashing', async () => {
    const voice = await makeVoice('voice-throw.ogg', 'OO')
    const provider = {
      id: 'throwing',
      supported: () => true,
      transcribe: async (): Promise<never> => {
        throw new Error('network gone')
      },
    }
    const result = await enrichAndAssemble([voice], '正文', { transcriber: provider })
    expect(result.text).toBe('正文')
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.notices).toEqual(['🎧 语音转写失败，「voice-throw.ogg」已作为文件转交'])
  })

  it('unsupported mime (provider.supported === false): degraded with notice', async () => {
    const voice = await makeVoice('voice-odd.webm', 'OO', { mimeType: 'audio/webm' })
    const provider = new FakeTranscriptionProvider([
      { supportedMimes: ['audio/ogg'], result: { ok: true, text: 'unused' } },
    ])
    const { notices } = await enrichAndAssemble([voice], '', { transcriber: provider })
    expect(notices).toEqual(['🎧 音频格式暂不支持转写，「voice-odd.webm」已作为文件转交'])
  })

  it('empty transcript: audio kept, notice says nothing recognized', async () => {
    const voice = await makeVoice('voice-silence.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '   ' } }])
    const result = await enrichAndAssemble([voice], '正文', { transcriber: provider })
    expect(result.text).toBe('正文')
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.transcripts).toEqual([])
    expect(result.notices).toEqual(['🎧 语音未能识别出内容，「voice-silence.ogg」已作为文件转交'])
  })

  it('统一换行但保留否定、数字、路径和原始 provider 结果', async () => {
    const voice = await makeVoice('normalization.ogg', 'OGG')
    const raw = '  不要删除 120 个文件\r\n/Users/fixture/a.ts\r保留 FooBar  '
    const scripted = { ok: true as const, text: raw }
    const provider = new FakeTranscriptionProvider([{ result: scripted }])
    const result = await enrichAndAssemble([voice], '', { transcriber: provider })
    const normalized = '不要删除 120 个文件\n/Users/fixture/a.ts\n保留 FooBar'
    expect(result.transcripts[0]?.text).toBe(normalized)
    expect(result.text).toBe(`🎤 语音转写（normalization.ogg）：\n${normalized}`)
    expect(scripted.text).toBe(raw)
  })

  it('one failing voice does not block a later voice in the same message', async () => {
    const bad = await makeVoice('voice-bad.ogg', 'B')
    const good = await makeVoice('voice-good.ogg', 'G')
    const provider = new FakeTranscriptionProvider([
      { result: { ok: false, reason: 'provider_error' } },
      { result: { ok: true, text: '第二条成功' } },
    ])
    const result = await enrichAndAssemble([bad, good], '混合', { transcriber: provider })
    expect(result.text).toBe('混合\n\n🎤 语音转写（voice-good.ogg）：\n第二条成功')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.name).toBe('voice-bad.ogg')
    expect(result.notices).toEqual([
      '🎧 语音转写失败，「voice-bad.ogg」已作为文件转交',
      '📝 语音转写「voice-good.ogg」：第二条成功',
    ])
  })

  it('a throwing onNotice callback never blocks the message', async () => {
    const voice = await makeVoice('voice-cb.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: '不阻塞' } }])
    const result = await enrichAndAssemble([voice], '', {
      transcriber: provider,
      onNotice: () => {
        throw new Error('sink exploded')
      },
    })
    expect(result.text).toContain('不阻塞')
    expect(result.notices).toEqual(['📝 语音转写「voice-cb.ogg」：不阻塞'])
  })
})

describe('enrichAndAssemble — timeout and cancellation', () => {
  it('a hung provider is aborted by the timeout and degrades with a timeout notice', async () => {
    const voice = await makeVoice('voice-slow.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([
      { waitForAbort: true, result: { ok: false, reason: 'cancelled' } },
    ])
    const started = Date.now()
    const result = await enrichAndAssemble([voice], '正文', {
      transcriber: provider,
      transcribeTimeoutMs: 20,
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.text).toBe('正文')
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.notices).toEqual(['🎧 语音转写超时，「voice-slow.ogg」已作为文件转交'])
    // The provider saw a signal that actually aborted (real cancellation,
    // not just a race the pipeline walked away from).
    expect(provider.calls[0]?.signal?.aborted).toBe(true)
  })

  it('does not hang when a provider ignores the signal and settles late', async () => {
    const voice = await makeVoice('voice-ignore.ogg', 'OO')
    const provider = {
      id: 'ignores-signal',
      supported: () => true,
      transcribe: (): Promise<never> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('late')), 50)
        }),
    }
    const result = await enrichAndAssemble([voice], '正文', {
      transcriber: provider,
      transcribeTimeoutMs: 10,
    })
    expect(result.notices).toEqual(['🎧 语音转写超时，「voice-ignore.ogg」已作为文件转交'])
    // Let the late rejection land: it must not become an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80))
  })

  it('waits for the aborted provider to finish cleaning up before returning', async () => {
    const voice = await makeVoice('voice-cleanup.ogg', 'OO')
    let release: (() => void) | undefined
    const provider = {
      id: 'slow-cleanup',
      supported: () => true,
      transcribe: (input: { signal?: AbortSignal }): Promise<{ ok: false; reason: 'cancelled' }> =>
        new Promise((resolve) => {
          const finish = () => {
            // Simulate real child-process teardown: resolve only after a
            // delay that starts when the signal aborts.
            setTimeout(() => resolve({ ok: false, reason: 'cancelled' }), 60)
          }
          if (input.signal?.aborted) finish()
          else input.signal?.addEventListener('abort', finish, { once: true })
        }),
    }
    const started = Date.now()
    const result = await enrichAndAssemble([voice], '正文', {
      transcriber: provider,
      transcribeTimeoutMs: 10,
    })
    // The pipeline must have waited for the provider's cleanup promise.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    expect(result.notices).toEqual(['🎧 语音转写超时，「voice-cleanup.ogg」已作为文件转交'])
  })

  it('a provider that throws synchronously degrades instead of crashing', async () => {
    const voice = await makeVoice('voice-sync-throw.ogg', 'OO')
    const provider = {
      id: 'sync-throw',
      supported: () => true,
      transcribe: (): Promise<never> => {
        throw new Error('sync boom')
      },
    }
    const result = await enrichAndAssemble([voice], '正文', { transcriber: provider })
    expect(result.text).toBe('正文')
    expect(result.attachments[0]?.type).toBe('file')
    expect(result.notices).toEqual(['🎧 语音转写失败，「voice-sync-throw.ogg」已作为文件转交'])
  })

  it('a pre-aborted caller signal returns cancelled with the original text and no notices', async () => {
    const voice = await makeVoice('voice-pre.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([{ result: { ok: true, text: 'unused' } }])
    const controller = new AbortController()
    controller.abort()
    const result = await enrichAndAssemble([voice], '原始文字', {
      transcriber: provider,
      signal: controller.signal,
    })
    expect(result).toEqual({
      text: '原始文字',
      attachments: [],
      notices: [],
      transcripts: [],
      cancelled: true,
    })
    expect(provider.calls).toHaveLength(0)
  })

  it('an abort mid-flight returns cancelled, emits no notices and does not deliver', async () => {
    const voice = await makeVoice('voice-mid.ogg', 'OO')
    const provider = new FakeTranscriptionProvider([
      { waitForAbort: true, result: { ok: false, reason: 'cancelled' } },
    ])
    const controller = new AbortController()
    const pending = enrichAndAssemble([voice], '原始文字', {
      transcriber: provider,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.text).toBe('原始文字')
    expect(result.attachments).toEqual([])
    expect(result.notices).toEqual([])
    expect(provider.calls[0]?.signal?.aborted).toBe(true)
  })

  it('cancellation between two voices stops before transcribing the second', async () => {
    const a = await makeVoice('voice-1st.ogg', 'A')
    const b = await makeVoice('voice-2nd.ogg', 'B')
    const controller = new AbortController()
    const provider = new FakeTranscriptionProvider([
      { result: { ok: true, text: 'first' } },
      { result: { ok: true, text: 'second' } },
    ])
    const result = await enrichAndAssemble([a, b], 'text', {
      transcriber: provider,
      signal: controller.signal,
      onNotice: () => controller.abort(),
    })
    expect(result.cancelled).toBe(true)
    expect(provider.calls.map((c) => c.fileName)).toEqual(['voice-1st.ogg'])
  })
})