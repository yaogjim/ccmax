/**
 * whisper-local TranscriptionProvider — normalize inbound audio to PCM WAV
 * with ffmpeg, then run a whisper.cpp-compatible CLI to transcribe it.
 *
 * Zero credentials, fully offline. Both executables are external
 * dependencies by design (docs/internals/im-media-pipeline.md §5 Phase 3):
 * nothing is bundled with ccmax, and nothing is ever downloaded.
 *
 * Binary discovery (same rule for the whisper engine and the decoder):
 *  1. An explicitly configured command (`stt.whisperPath` / a `decodeCommand`
 *     option). An absolute path (or one containing a separator) is used
 *     verbatim and must be executable; a bare name is searched on the
 *     search paths.
 *  2. Otherwise the first executable candidate on the search paths. The
 *     engine probes `whisper-cli`, `whisper-cpp` in that order (deliberately
 *     excluding generic names like `main` and the Python `whisper` console
 *     script); the decoder only probes `ffmpeg`.
 *
 * Only whisper.cpp-compatible CLIs are supported; the Python `whisper`
 * package is never probed.
 *
 * Duration policy: the pipeline owns the duration limit and passes it in as
 * `input.maxDurationSeconds` (default 300). Byte size is never treated as a
 * duration proxy. The decode pass is capped with ffmpeg `-t (limit + 1)` so a
 * malformed multi-hour container cannot be fully decoded before we even look
 * at it — the extra second is deliberate, so a too-long input still produces
 * more than the limit and gets rejected rather than silently truncated. The
 * normalized WAV is then measured from its header, and its declared `data`
 * length is checked against the bytes actually present; anything above the
 * limit is rejected as `too_long`.
 *
 * Output policy: transcription text is read from a private per-job
 * `.txt` output file (`-otxt -of …`), never scraped from stdout, and only
 * after a size check, so a runaway engine cannot exhaust memory. stdout and
 * stderr are bounded diagnostics only; exceeding the bound kills the process
 * and fails the job (a truncated capture must not become a partial result).
 *
 * Cancellation: `input.signal` is wired to the child process. On abort (or
 * the provider's own spawn timeout) the whole process tree is terminated,
 * the close event is awaited, the private temp dir is removed, and the call
 * settles with `cancelled`. Nothing here throws past `transcribe`.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from './types.js'

/**
 * Candidate engine executable names probed on the search paths. The Python
 * `whisper` console script is deliberately excluded: ccmax supports only
 * whisper.cpp-compatible CLIs.
 */
const ENGINE_BINARY_CANDIDATES = ['whisper-cli', 'whisper-cpp'] as const

// 仅引导中文识别，不保证简体或纠错；不在识别后转换字形。
export const DEFAULT_WHISPER_PROMPT = '以下是普通话的简体中文转录。'

/** Default model location relative to the adapter config dir. */
export const DEFAULT_WHISPER_MODEL_DIR = 'whisper'
export const DEFAULT_WHISPER_MODEL_FILE = 'ggml-base.bin'

/** Default decoder used to normalize input into PCM WAV. */
export const DEFAULT_DECODE_COMMAND = 'ffmpeg'

/**
 * Fallback duration cap when a caller bypasses the pipeline and omits
 * `maxDurationSeconds`. The pipeline normally supplies its own value (300);
 * this mirrors it rather than defining a second policy.
 */
const DEFAULT_MAX_DURATION_SECONDS = 300

/** Per-spawn hard kill guard, independent of the pipeline's own timeout. */
const DEFAULT_SPAWN_TIMEOUT_MS = 120_000

/** Diagnostic capture bounds — real hard limits, not advisory. */
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

/**
 * Bound on the transcript output file. The file is stat-ed before it is read,
 * so a runaway engine cannot make the adapter allocate unbounded memory.
 */
const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024

/** Grace period between SIGTERM and SIGKILL when terminating a process tree. */
const KILL_GRACE_MS = 2000

/**
 * MIME whitelist. Everything here is fed through ffmpeg, so this only needs
 * to reject obviously non-audio payloads (and audio containers we do not
 * claim to decode). Formats outside the set degrade via the pipeline's
 * `unsupported_format` path instead of burning a doomed spawn.
 */
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
])

const MIME_SUFFIXES: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a',
}

export interface WhisperLocalOptions {
  /** Explicit engine executable path or bare command name. Empty → PATH probing. */
  command?: string
  /** ggml model file path (`~` expanded). Empty → the default location. */
  model?: string
  /** Directories searched for a bare command name. Defaults to $PATH. */
  searchPaths?: string[]
  /** Audio decoder used to normalize input. Default `ffmpeg`. */
  decodeCommand?: string
  /** 仅中文识别使用的 initial prompt；空白默认 DEFAULT_WHISPER_PROMPT。 */
  prompt?: string
  /** Hard kill guard for each spawn. Default 120s. */
  spawnTimeoutMs?: number
  /** Bound on captured stdout bytes before the process is killed. */
  maxStdoutBytes?: number
  /** Bound on captured stderr bytes before the process is killed. */
  maxStderrBytes?: number
  /** Bound on the transcript output file before it is read. Default 64 KiB. */
  maxTranscriptBytes?: number
}

/**
 * The duration ceiling forwarded by the pipeline. A missing, non-positive or
 * non-finite value falls back to the default rather than being interpolated
 * into an ffmpeg `-t` argument.
 */
function resolveMaxDurationSeconds(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return DEFAULT_MAX_DURATION_SECONDS
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function defaultWhisperModelPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, DEFAULT_WHISPER_MODEL_DIR, DEFAULT_WHISPER_MODEL_FILE)
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Windows PATH lookups need the extension appended; POSIX does not. */
const EXECUTABLE_SUFFIXES = process.platform === 'win32'
  ? ['', '.exe', '.cmd', '.bat']
  : ['']

function probeNameInDirs(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of EXECUTABLE_SUFFIXES) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function resolveExecutable(
  command: string | undefined,
  candidates: readonly string[],
  searchPaths: string[] | undefined,
): string | null {
  const dirs = searchPaths ?? (process.env.PATH ?? '').split(path.delimiter)
  const explicit = command?.trim()
  const names: string[] = explicit ? [explicit] : [...candidates]

  for (const name of names) {
    const looksLikePath = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
    if (looksLikePath) {
      // Explicit path: use verbatim — no guessing at sibling names.
      return isExecutable(name) ? name : null
    }
    const found = probeNameInDirs(name, dirs)
    if (found) return found
    // An explicit bare command that is not on the search paths stays a miss;
    // probed candidates simply move on to the next name.
    if (explicit) return null
  }
  return null
}

/** Resolve the whisper binary per the documented discovery order. */
export function resolveWhisperBinary(
  opts: Pick<WhisperLocalOptions, 'command' | 'searchPaths'> = {},
): string | null {
  return resolveExecutable(opts.command, ENGINE_BINARY_CANDIDATES, opts.searchPaths)
}

/** Resolve the audio decoder (default ffmpeg) per the same discovery order. */
export function resolveDecodeBinary(
  opts: Pick<WhisperLocalOptions, 'decodeCommand' | 'searchPaths'> = {},
): string | null {
  return resolveExecutable(
    opts.decodeCommand?.trim() || DEFAULT_DECODE_COMMAND,
    [DEFAULT_DECODE_COMMAND],
    opts.searchPaths,
  )
}

/**
 * Environment handed to spawned executables: a small allowlist, never the
 * adapter's full environment. Provider tokens (`TELEGRAM_BOT_TOKEN`,
 * `ANTHROPIC_API_KEY`, …) and other secrets must not leak into a child
 * process. PATH/HOME/TMP plus the Windows-required variables are kept so the
 * binaries can locate their own runtime.
 */
function childEnv(): NodeJS.ProcessEnv {
  const allow =
    process.platform === 'win32'
      ? [
          'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'COMSPEC', 'ComSpec',
          'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
          'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
        ]
      : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function tmpSuffixFor(input: TranscriptionInput): string {
  const ext = input.fileName ? path.extname(input.fileName) : ''
  if (ext) return ext
  return MIME_SUFFIXES[input.mimeType.toLowerCase().split(';')[0]!.trim()] ?? ''
}

function normalizeMime(mimeType: string): string {
  return mimeType.toLowerCase().split(';')[0]!.trim()
}

/**
 * whisper.cpp English-only models are named `ggml-<size>.en.bin`. They cannot
 * serve a Chinese transcription, so the configuration is refused up front
 * instead of producing nonsense. Only the configured file name is inspected;
 * the model file itself is never opened.
 */
function isEnglishOnlyModel(modelPath: string): boolean {
  const base = path.basename(modelPath).toLowerCase()
  return base.endsWith('.en.bin') || base.includes('.en.')
}

function isChineseLanguage(language: string): boolean {
  return language.toLowerCase().startsWith('zh')
}

type ProcessOutcome =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'error'; error: string }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'overflow'; stream: 'stdout' | 'stderr' }

interface RunProcessOptions {
  signal?: AbortSignal
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

/**
 * Spawn `command` without a shell, capture bounded diagnostics, and settle
 * only after the child has closed. On abort, timeout or overflow the whole
 * process tree is terminated (POSIX process group; on Windows this is a
 * best-effort direct-child kill) and the caller waits for `close`.
 */
function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ kind: 'cancelled' })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let cancelled = false
    let timedOut = false
    let overflow: 'stdout' | 'stderr' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
        shell: false,
        // POSIX: a new process group lets us signal the whole tree.
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      resolve({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
      return
    }

    const killTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // Already gone.
        }
      }
      if (signal !== 'SIGKILL' && killTimer === undefined) {
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
        killTimer.unref?.()
      }
    }

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onAbort = (): void => {
      if (settled) return
      cancelled = true
      killTree('SIGTERM')
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killTree('SIGTERM')
      }, options.timeoutMs)
      timer.unref?.()
    }

    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (stream === 'stdout') {
        stdoutBytes += chunk.length
        if (stdoutBytes > options.maxStdoutBytes) {
          overflow = 'stdout'
          killTree('SIGKILL')
          return
        }
        stdoutChunks.push(chunk)
      } else {
        stderrBytes += chunk.length
        if (stderrBytes > options.maxStderrBytes) {
          overflow = 'stderr'
          killTree('SIGKILL')
          return
        }
        stderrChunks.push(chunk)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'))

    child.on('error', (err) => {
      settle({ kind: 'error', error: err.message })
    })

    child.on('close', (code) => {
      // Decode once from the accumulated buffers: a multi-byte UTF-8
      // sequence split across chunks is only safe to decode as a whole.
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (cancelled) settle({ kind: 'cancelled' })
      else if (timedOut) settle({ kind: 'timeout' })
      else if (overflow) settle({ kind: 'overflow', stream: overflow })
      else settle({ kind: 'exit', code, stdout, stderr })
    })
  })
}

/**
 * Real duration of a PCM WAV file, measured from the `fmt ` byte rate and
 * the `data` chunk size. The declared `data` length is checked against the
 * bytes actually present, so a header claiming 12 s while only 44 bytes exist
 * is treated as corrupt rather than as a long file. Returns null when the
 * file is not a usable, self-consistent WAV.
 */
async function readWavDurationSeconds(file: string): Promise<number | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const fileSize = (await handle.stat()).size
    const riff = Buffer.alloc(12)
    const header = await handle.read(riff, 0, 12, 0)
    if (header.bytesRead < 12) return null
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }
    let offset = 12
    let byteRate = 0
    for (;;) {
      const chunkHeader = Buffer.alloc(8)
      const read = await handle.read(chunkHeader, 0, 8, offset)
      if (read.bytesRead < 8) break
      const id = chunkHeader.toString('ascii', 0, 4)
      const size = chunkHeader.readUInt32LE(4)
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 40))
        const fmtRead = await handle.read(fmt, 0, fmt.length, offset + 8)
        if (fmtRead.bytesRead >= 12) byteRate = fmt.readUInt32LE(8)
      } else if (id === 'data') {
        const dataStart = offset + 8
        const available = fileSize - dataStart
        // Header and reality must agree: a claimed length larger than the
        // bytes on disk is a corrupt/truncated file, not a long recording.
        if (size <= 0 || available < size || byteRate <= 0) return null
        return size / byteRate
      }
      offset += 8 + size + (size % 2)
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

type TranscriptRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'too_large' }

/**
 * Read the engine's transcript output file, bounded by `maxBytes`. The size
 * check happens before the read, so an oversized file is refused instead of
 * loaded into memory.
 */
async function readTranscript(file: string, maxBytes: number): Promise<TranscriptRead> {
  try {
    const stat = await fs.promises.stat(file)
    if (stat.size > maxBytes) return { kind: 'too_large' }
    const text = await fs.promises.readFile(file, 'utf8')
    // Re-check the real byte length: the file could have grown between the
    // stat and the read.
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { kind: 'too_large' }
    return { kind: 'text', text }
  } catch {
    return { kind: 'missing' }
  }
}

export class WhisperLocalProvider implements TranscriptionProvider {
  readonly id = 'whisper-local'

  constructor(private readonly options: WhisperLocalOptions = {}) {}

  supported(mimeType: string): boolean {
    return SUPPORTED_MIME_TYPES.has(normalizeMime(mimeType))
  }

  private runOptions(input: TranscriptionInput): RunProcessOptions {
    return {
      signal: input.signal,
      timeoutMs: this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
      maxStdoutBytes: this.options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    }
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (input.signal?.aborted) {
      return { ok: false, reason: 'cancelled', detail: 'cancelled before start' }
    }

    const binary = resolveWhisperBinary(this.options)
    if (!binary) {
      const requested = this.options.command?.trim()
      return {
        ok: false,
        reason: 'unavailable',
        detail: `whisper executable not found${
          requested ? ` at ${requested}` : ''
        }; install a whisper.cpp-compatible CLI or set stt.whisperPath`,
      }
    }
    const model = this.options.model?.trim()
      ? expandHome(this.options.model.trim())
      : defaultWhisperModelPath()
    if (!isFile(model)) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `whisper model not found at ${model}; set stt.whisperModel`,
      }
    }
    const language = input.languageHint?.trim() || 'zh'
    // Refuse an English-only model before any spawn: a zh request against a
    // `.en` model is a configuration error, not a transcription to degrade.
    if (isChineseLanguage(language) && isEnglishOnlyModel(model)) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `whisper model ${path.basename(model)} is English-only but the requested language is ${language}; configure a multilingual model`,
      }
    }
    const decoder = resolveDecodeBinary(this.options)
    if (!decoder) {
      const requested = this.options.decodeCommand?.trim()
      return {
        ok: false,
        reason: 'unavailable',
        detail: `audio decoder not found${
          requested ? ` at ${requested}` : ''
        }; install ffmpeg or set stt.ffmpegPath`,
      }
    }

    // Private per-job directory: input, normalized WAV and the output text
    // file live here and are removed in every exit path.
    let dir: string
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccmax-stt-'))
    } catch (err) {
      return { ok: false, reason: 'provider_error', detail: errorMessage(err) }
    }

    try {
      const inputFile = path.join(dir, `input${tmpSuffixFor(input)}`)
      const wavFile = path.join(dir, 'audio.wav')
      try {
        await fs.promises.writeFile(inputFile, input.buffer)
      } catch (err) {
        return { ok: false, reason: 'provider_error', detail: errorMessage(err) }
      }

      // 1. Normalize to 16 kHz mono 16-bit PCM WAV. This is the only path
      //    that reads the raw inbound container; the engine only ever sees
      //    PCM WAV. `-t (limit + 1)` bounds the decode: a container that
      //    claims (or hides) an hour of audio is not decoded in full before
      //    the duration check. The deliberate +1 second is what makes an
      //    over-limit input still measure above the limit, so it is rejected
      //    rather than cut to a "successful" short transcript. A missing,
      //    non-positive or non-finite caller value falls back to the default
      //    rather than producing a nonsense `-t` argument.
      const maxDuration = resolveMaxDurationSeconds(input.maxDurationSeconds)
      const decode = await runProcess(
        decoder,
        ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputFile, '-t', String(maxDuration + 1), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wavFile],
        this.runOptions(input),
      )
      if (decode.kind === 'cancelled') return cancelledResult()
      if (decode.kind === 'timeout') {
        return { ok: false, reason: 'provider_error', detail: 'audio decode timed out' }
      }
      if (decode.kind === 'overflow') {
        return { ok: false, reason: 'provider_error', detail: 'audio decode produced too much output' }
      }
      if (decode.kind === 'error') {
        return { ok: false, reason: 'unavailable', detail: `audio decoder failed to start: ${decode.error}` }
      }
      if (decode.code !== 0) {
        return {
          ok: false,
          reason: 'invalid_audio',
          detail: decode.stderr.trim().slice(0, 300) || 'audio could not be decoded',
        }
      }

      // 2. Validate the *real* duration from the WAV itself. Bytes are not a
      //    duration, the header must match the bytes on disk, and a long file
      //    is rejected, never truncated.
      const durationSeconds = await readWavDurationSeconds(wavFile)
      if (durationSeconds === null) {
        return { ok: false, reason: 'invalid_audio', detail: 'normalized audio has no usable WAV data' }
      }
      if (durationSeconds > maxDuration) {
        return {
          ok: false,
          reason: 'too_long',
          detail: `audio is ${durationSeconds.toFixed(1)}s, above the ${maxDuration}s limit`,
        }
      }

      // A signal that aborted while we were decoding must not reach another
      // spawn: the caller has already been told the work is over.
      if (input.signal?.aborted) return cancelledResult()

      // 3. Transcribe. Text comes from the explicit `.txt` output file, not
      //    from stdout.
      const outPrefix = path.join(dir, 'transcript')
      const chinese = isChineseLanguage(language)
      // whisper.cpp 的语言表使用 zh；配置中的中文地域别名在此归一。
      const args = ['-m', model, '-f', wavFile, '-l', chinese ? 'zh' : language, '-nt', '-otxt', '-of', outPrefix]
      if (chinese) args.push('--prompt', this.options.prompt?.trim() || DEFAULT_WHISPER_PROMPT)
      const run = await runProcess(
        binary,
        args,
        this.runOptions(input),
      )
      if (run.kind === 'cancelled') return cancelledResult()
      if (run.kind === 'timeout') {
        return { ok: false, reason: 'provider_error', detail: 'whisper timed out' }
      }
      if (run.kind === 'overflow') {
        // A truncated capture must never become a partial transcript.
        return { ok: false, reason: 'provider_error', detail: `whisper ${run.stream} exceeded the capture limit` }
      }
      if (run.kind === 'error') {
        return { ok: false, reason: 'unavailable', detail: `whisper failed to start: ${run.error}` }
      }
      if (run.code !== 0) {
        return {
          ok: false,
          reason: 'provider_error',
          detail: `whisper exited with ${run.code}: ${run.stderr.trim().slice(0, 300) || '(no stderr)'}`,
        }
      }

      const read = await readTranscript(
        `${outPrefix}.txt`,
        this.options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
      )
      if (read.kind === 'missing') {
        return { ok: false, reason: 'invalid_audio', detail: 'whisper produced no transcript file' }
      }
      if (read.kind === 'too_large') {
        // Refused before reading, so a runaway engine cannot exhaust memory.
        return {
          ok: false,
          reason: 'provider_error',
          detail: `whisper transcript output exceeded ${this.options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES} bytes`,
        }
      }
      if (read.text.trim() === '') {
        // Never hallucinate content for silence/undecodable audio.
        return { ok: false, reason: 'invalid_audio', detail: 'empty transcript' }
      }
      const text = read.text.trim()
      return { ok: true, text, language }
    } catch (err) {
      return { ok: false, reason: 'provider_error', detail: errorMessage(err) }
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function cancelledResult(): TranscriptionResult {
  return { ok: false, reason: 'cancelled', detail: 'cancelled' }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}