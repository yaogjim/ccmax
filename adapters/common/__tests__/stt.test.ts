import { describe, expect, it, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../config.js'
import type { AdapterConfig } from '../config.js'
import { resolveConfiguredTranscriber, sttLanguageHint } from '../stt.js'

/**
 * STT 配置解析与 provider 选择器测试。hermetic：CLAUDE_CONFIG_DIR 指向
 * 临时目录，环境变量用后恢复；不触网、不读真实 ~/.claude。
 */

const ENV_KEYS = [
  'CC_STT_PROVIDER',
  'CC_STT_WHISPER_PATH',
  'CC_STT_WHISPER_MODEL',
  'CC_STT_WHISPER_PROMPT',
  'CC_STT_FFMPEG_PATH',
  'CC_STT_LANGUAGE',
  'CLAUDE_CONFIG_DIR',
] as const

const savedEnv: Record<string, string | undefined> = {}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
    delete savedEnv[key]
  }
})

function saveAndClearEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
}

function withConfigDir(write?: (dir: string) => void): string {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-config-'))
  if (write) write(configDir)
  if (!('CLAUDE_CONFIG_DIR' in savedEnv)) {
    savedEnv['CLAUDE_CONFIG_DIR'] = process.env.CLAUDE_CONFIG_DIR
  }
  process.env.CLAUDE_CONFIG_DIR = configDir
  return configDir
}

describe('loadConfig — stt section', () => {
  it('no config → provider off, empty fields (equivalent to pre-STT behavior)', () => {
    saveAndClearEnv()
    const dir = withConfigDir()
    try {
      const config = loadConfig()
      expect(config.stt).toEqual({
        provider: '',
        whisperPath: '',
        whisperModel: '',
        whisperPrompt: '',
        ffmpegPath: '',
        language: '',
      })
      expect(resolveConfiguredTranscriber(config)).toBeUndefined()
      expect(sttLanguageHint(config)).toBe('zh')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('file config: stt.provider = whisper-local selects the local provider', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({
          stt: { provider: 'whisper-local', whisperPath: '/opt/whisper-cli', whisperModel: '~/models/ggml-small.bin' },
        }),
      )
    })
    try {
      const config = loadConfig()
      expect(config.stt.provider).toBe('whisper-local')
      expect(config.stt.whisperPath).toBe('/opt/whisper-cli')
      expect(config.stt.whisperModel).toBe('~/models/ggml-small.bin')
      const transcriber = resolveConfiguredTranscriber(config)
      expect(transcriber?.id).toBe('whisper-local')
      // Does not throw during construction; binary probing happens at transcribe.
      expect(typeof transcriber?.supported).toBe('function')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('env overrides file for every stt field', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({
          stt: { provider: 'whisper-local', whisperPath: '/from-file', ffmpegPath: '/ffmpeg-from-file' },
        }),
      )
    })
    try {
      const configPath = path.join(dir, 'adapters.json')
      const before = fs.readFileSync(configPath)
      process.env.CC_STT_PROVIDER = 'whisper-local'
      process.env.CC_STT_WHISPER_PATH = '/from-env'
      process.env.CC_STT_WHISPER_MODEL = '/model-env'
      process.env.CC_STT_FFMPEG_PATH = '/ffmpeg-from-env'
      process.env.CC_STT_LANGUAGE = 'en'
      const config = loadConfig()
      expect(config.stt.whisperPath).toBe('/from-env')
      expect(config.stt.whisperModel).toBe('/model-env')
      expect(config.stt.ffmpegPath).toBe('/ffmpeg-from-env')
      expect(config.stt.language).toBe('en')
      expect(sttLanguageHint(config)).toBe('en')
      // Env overlay is runtime-only: loadConfig must not rewrite adapters.json.
      expect(fs.readFileSync(configPath)).toEqual(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a blank CC_STT_* env var falls through to the file instead of clobbering it', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'whisper-local', whisperPath: '/from-file', ffmpegPath: '/ffmpeg-from-file' } }),
      )
    })
    try {
      process.env.CC_STT_WHISPER_PATH = '   '
      process.env.CC_STT_FFMPEG_PATH = ''
      const config = loadConfig()
      expect(config.stt.whisperPath).toBe('/from-file')
      expect(config.stt.ffmpegPath).toBe('/ffmpeg-from-file')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unknown provider value falls back to off instead of pretending', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'openai-compat' } }),
      )
    })
    try {
      const originalWarn = console.warn
      console.warn = () => {}
      try {
        const config = loadConfig()
        expect(config.stt.provider).toBe('')
        expect(resolveConfiguredTranscriber(config)).toBeUndefined()
      } finally {
        console.warn = originalWarn
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a bare provider without credentials still constructs (probe happens per transcribe)', () => {
    saveAndClearEnv()
    const dir = withConfigDir()
    try {
      process.env.CC_STT_PROVIDER = 'whisper-local'
      const config = loadConfig()
      expect(config.stt.provider).toBe('whisper-local')
      expect(resolveConfiguredTranscriber(config)?.id).toBe('whisper-local')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression fixtures for user-edited JSON. Before this guard, an object in
  // `stt.whisperPath` flowed straight into `WhisperLocalProvider`, which calls
  // `.trim()` on it during `transcribe` → `TypeError: command.trim is not a
  // function`. The loader must coerce every field to a string at the boundary.
  it('legacy file without an stt section still loads (pre-STT releases)', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({
          serverUrl: 'ws://127.0.0.1:3456',
          telegram: { botToken: 'legacy-token', allowedUsers: [1], pairedUsers: [] },
          pairing: { code: 'ABCDEF', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
        }),
      )
    })
    try {
      const configPath = path.join(dir, 'adapters.json')
      const before = fs.readFileSync(configPath)
      const config = loadConfig()
      expect(config.stt).toEqual({
        provider: '',
        whisperPath: '',
        whisperModel: '',
        whisperPrompt: '',
        ffmpegPath: '',
        language: '',
      })
      // Unrelated legacy fields keep loading as before.
      expect(config.telegram.botToken).toBe('legacy-token')
      expect(resolveConfiguredTranscriber(config)).toBeUndefined()
      // Forward-compat at the load boundary: do not rewrite a pre-STT file.
      expect(fs.readFileSync(configPath)).toEqual(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-string stt fields are diagnosed and dropped instead of crashing', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({
          stt: {
            provider: 'whisper-local',
            whisperPath: { path: '/opt/whisper-cli' },
            whisperModel: ['~/models/ggml-base.bin'],
            whisperPrompt: { text: '不是字符串' },
            ffmpegPath: 42,
            language: { code: 'zh' },
          },
        }),
      )
    })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const config = loadConfig()
      expect(config.stt).toEqual({
        provider: 'whisper-local',
        whisperPath: '',
        whisperModel: '',
        whisperPrompt: '',
        ffmpegPath: '',
        language: '',
      })
      // Every bad field names itself so the user can fix it.
      for (const field of ['whisperPath', 'whisperModel', 'whisperPrompt', 'ffmpegPath', 'language']) {
        expect(warnings.some((line) => line.includes(`stt.${field}`))).toBe(true)
      }
      // The chain that used to throw: object → provider → `.trim()`.
      expect(typeof config.stt.whisperPath).toBe('string')
      expect(resolveConfiguredTranscriber(config)?.id).toBe('whisper-local')
      expect(sttLanguageHint(config)).toBe('zh')
    } finally {
      console.warn = originalWarn
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('diagnoses a non-object stt section instead of crashing', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: 'whisper-local' }),
      )
    })
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const config = loadConfig()
      expect(config.stt.provider).toBe('')
    } finally {
      console.warn = originalWarn
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names an unsupported provider so a typo is diagnosable', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'whisper-lcoal' } }),
      )
    })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const config = loadConfig()
      expect(config.stt.provider).toBe('')
      expect(warnings.some((line) => line.includes('whisper-lcoal'))).toBe(true)
    } finally {
      console.warn = originalWarn
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stt.ffmpegPath / CC_STT_FFMPEG_PATH reach the provider as decodeCommand', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'whisper-local', ffmpegPath: '/from-file/ffmpeg' } }),
      )
    })
    try {
      const fromFile = loadConfig()
      expect(fromFile.stt.ffmpegPath).toBe('/from-file/ffmpeg')
      expect(providerOptions(fromFile).decodeCommand).toBe('/from-file/ffmpeg')

      process.env.CC_STT_FFMPEG_PATH = '/from-env/ffmpeg'
      const fromEnv = loadConfig()
      expect(fromEnv.stt.ffmpegPath).toBe('/from-env/ffmpeg')
      expect(providerOptions(fromEnv).decodeCommand).toBe('/from-env/ffmpeg')

      // The whisper engine path/model travel on their own options.
      expect(providerOptions(fromFile).command).toBeUndefined()
      expect(providerOptions(fromFile).model).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('旧 stt 无 whisperPrompt 时只做加载默认，不重写文件', () => {
    saveAndClearEnv()
    const dir = withConfigDir(configDir => {
      fs.writeFileSync(path.join(configDir, 'adapters.json'), JSON.stringify({
        stt: { provider: 'whisper-local', futureOption: { keep: true } },
        futureTopLevel: { keep: true },
      }))
    })
    try {
      const file = path.join(dir, 'adapters.json')
      const before = fs.readFileSync(file)
      const config = loadConfig()
      expect(config.stt.whisperPrompt).toBe('')
      expect(providerOptions(config).prompt).toBe('')
      expect(fs.readFileSync(file)).toEqual(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('whisperPrompt 文件配置和环境覆盖传入 provider，空白环境回退且不落盘', () => {
    saveAndClearEnv()
    const dir = withConfigDir(configDir => {
      fs.writeFileSync(path.join(configDir, 'adapters.json'), JSON.stringify({
        stt: { provider: 'whisper-local', whisperPrompt: ' 文件引导 ', futureOption: 1 },
      }))
    })
    try {
      const file = path.join(dir, 'adapters.json')
      const before = fs.readFileSync(file)
      expect(providerOptions(loadConfig()).prompt).toBe('文件引导')
      process.env.CC_STT_WHISPER_PROMPT = ' 环境引导 '
      const config = loadConfig()
      expect(config.stt.whisperPrompt).toBe('环境引导')
      expect(providerOptions(config).prompt).toBe('环境引导')
      process.env.CC_STT_WHISPER_PROMPT = '  '
      expect(providerOptions(loadConfig()).prompt).toBe('文件引导')
      expect(fs.readFileSync(file)).toEqual(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a region-qualified language code but rejects arbitrary text', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'whisper-local', language: 'zh-CN' } }),
      )
    })
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      expect(loadConfig().stt.language).toBe('zh-CN')
      expect(sttLanguageHint(loadConfig())).toBe('zh-CN')

      fs.writeFileSync(
        path.join(dir, 'adapters.json'),
        JSON.stringify({ stt: { provider: 'whisper-local', language: 'zh -x /etc/passwd' } }),
      )
      const config = loadConfig()
      expect(config.stt.language).toBe('')
      expect(sttLanguageHint(config)).toBe('zh')
    } finally {
      console.warn = originalWarn
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores unknown top-level keys and unknown stt subfields', () => {
    saveAndClearEnv()
    const dir = withConfigDir((configDir) => {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({
          stt: { provider: 'whisper-local', whisperPath: '/opt/whisper-cli', futureOption: { a: 1 } },
          futureTopLevel: { nested: true },
        }),
      )
    })
    try {
      const config = loadConfig()
      expect(config.stt.provider).toBe('whisper-local')
      expect(config.stt.whisperPath).toBe('/opt/whisper-cli')
      // Unknown keys are not surfaced on the typed config.
      expect('futureOption' in config.stt).toBe(false)
      expect('futureTopLevel' in config).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** The provider keeps its resolved options on a private field; reach in so the
 *  selector's wiring (ffmpegPath → decodeCommand) is asserted without spawning. */
function providerOptions(config: AdapterConfig): {
  command?: string
  model?: string
  decodeCommand?: string
  prompt?: string
} {
  const provider = resolveConfiguredTranscriber(config)
  return (provider as unknown as {
    options: { command?: string; model?: string; decodeCommand?: string; prompt?: string }
  }).options
}