/**
 * Adapter 配置加载
 *
 * 优先级：环境变量 > ~/.claude/adapters.json > 默认值
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code: string | null
  expiresAt: number | null
  createdAt: number | null
}

export type TelegramPublicConfig = {
  enabled: boolean
  botToken: string
  ownerUserId: number | null
  pairing: PairingState
  allowedProjectRoots: string[]
  generation: number
}

export type TelegramConfig = {
  botToken: string
  allowedUsers: number[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
  public: TelegramPublicConfig
}

export type FeishuConfig = {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  /** `lark` for international tenants, whose APIs live on open.larksuite.com. */
  domain: 'feishu' | 'lark'
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  streamingCard: boolean
  allowedProjectRoots: string[]
}

export type WechatConfig = {
  accountId: string
  botToken: string
  baseUrl: string
  userId: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

export type DingtalkConfig = {
  clientId: string
  clientSecret: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  endpoint: string
  permissionCardTemplateId: string
  allowedProjectRoots: string[]
}

export type WhatsAppConfig = {
  accountJid: string
  authDir: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

/** Enterprise WeChat (企业微信) AI bot — QR-provisioned botId/secret over the
 *  官方 WebSocket 长连接 (`@wecom/aibot-node-sdk`). */
export type WecomConfig = {
  botId: string
  secret: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

/** QQ Open Platform bot — QR-provisioned appId/appSecret over the WS gateway. */
export type QQConfig = {
  appId: string
  appSecret: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

/** Slack app in Socket Mode — `xoxb-` bot token plus `xapp-` app-level token. */
export type SlackConfig = {
  botToken: string
  appToken: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

/** Speech-to-text settings for the inbound voice pipeline. Absent provider
 *  (`provider: ''`) means no transcription: every voice message degrades to
 *  a file reference with a notice — exactly the pre-STT behavior. */
export type SttConfig = {
  /** The only implemented provider. Anything else (including the reserved
   *  'openai-compat' id and typos) resolves to `''` with a warning. */
  provider: '' | 'whisper-local'
  /** Local Whisper executable path (or bare name found on $PATH). */
  whisperPath: string
  /** ggml model file path; empty → ~/.claude/whisper/ggml-base.bin. */
  whisperModel: string
  /** Audio decoder used to normalize inbound audio; empty → probe `ffmpeg`
   *  on $PATH. Forwarded to the provider as its `decodeCommand`. */
  ffmpegPath: string
  /** 中文 initial prompt；空白或缺省使用 provider 默认引导词。 */
  whisperPrompt?: string
  /** Extra language hint forwarded to the provider; empty → 'zh'. */
  language: string
}

export type AdapterConfig = {
  serverUrl: string
  defaultProjectDir: string
  pairing: PairingState
  allowedProjectRoots: string[]
  stt: SttConfig
  telegram: TelegramConfig
  feishu: FeishuConfig
  wechat: WechatConfig
  dingtalk: DingtalkConfig
  whatsapp: WhatsAppConfig
  wecom: WecomConfig
  qq: QQConfig
  slack: SlackConfig
}

export type AdapterPlatformConfig =
  | TelegramConfig
  | FeishuConfig
  | WechatConfig
  | DingtalkConfig
  | WhatsAppConfig
  | WecomConfig
  | QQConfig
  | SlackConfig

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function loadFile(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[Config] Failed to parse ${getConfigPath()}, using defaults`)
    }
    return {}
  }
}

export function loadConfig(): AdapterConfig {
  const file = loadFile()
  const tg = file.telegram ?? {}
  const fs_ = file.feishu ?? {}
  const wc = file.wechat ?? {}
  const dt = file.dingtalk ?? {}
  const wa = file.whatsapp ?? {}
  const wecom = file.wecom ?? {}
  const qq = file.qq ?? {}
  const slack = file.slack ?? {}
  const stt = readSttSection(file.stt)
  const pairing = file.pairing ?? {}
  const fallbackWorkDir = resolveUserDefaultWorkDir()
  const whatsappAuthDir = resolveConfiguredPath(
    process.env.WHATSAPP_AUTH_DIR || wa.authDir || defaultWhatsAppAuthDir(),
  )

  return {
    serverUrl: process.env.ADAPTER_SERVER_URL || file.serverUrl || 'ws://127.0.0.1:3456',
    defaultProjectDir: file.defaultProjectDir || '',
    pairing: {
      code: pairing.code ?? null,
      expiresAt: pairing.expiresAt ?? null,
      createdAt: pairing.createdAt ?? null,
    },
    // File scope only. ADAPTER_ALLOWED_PROJECT_ROOTS is applied by
    // resolveAllowedProjectRoots so this field keeps one meaning.
    allowedProjectRoots: readProjectRoots(file.allowedProjectRoots),
    // Priority: env > ~/.claude/adapters.json > default ('' = STT off).
    // Only whisper-local exists; an unknown provider value falls back to ''
    // (with a warning) so a typo cannot masquerade as "configured but
    // silently broken". A non-empty env var wins; an empty one falls through
    // to the file so a blank `CC_STT_*` does not clobber the user's config.
    // Every field is coerced to a trimmed string at this boundary: the file
    // is user-edited JSON, and a non-string (e.g. an object in `whisperPath`)
    // would otherwise reach a child-process argv and crash on `.trim()`.
    stt: {
      provider: normalizeSttProvider(pickSttValue('CC_STT_PROVIDER', stt.provider)),
      whisperPath: readSttString(pickSttValue('CC_STT_WHISPER_PATH', stt.whisperPath), 'whisperPath'),
      whisperModel: readSttString(pickSttValue('CC_STT_WHISPER_MODEL', stt.whisperModel), 'whisperModel'),
      whisperPrompt: readSttString(pickSttValue('CC_STT_WHISPER_PROMPT', stt.whisperPrompt), 'whisperPrompt'),
      ffmpegPath: readSttString(pickSttValue('CC_STT_FFMPEG_PATH', stt.ffmpegPath), 'ffmpegPath'),
      language: readSttLanguage(pickSttValue('CC_STT_LANGUAGE', stt.language)),
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || tg.botToken || '',
      allowedUsers: tg.allowedUsers ?? [],
      pairedUsers: tg.pairedUsers ?? [],
      defaultWorkDir: tg.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(tg.allowedProjectRoots),
      public: readTelegramPublic(tg.public),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID || fs_.appId || '',
      appSecret: process.env.FEISHU_APP_SECRET || fs_.appSecret || '',
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || fs_.encryptKey || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || fs_.verificationToken || '',
      domain: (process.env.FEISHU_DOMAIN || fs_.domain) === 'lark' ? 'lark' : 'feishu',
      allowedUsers: fs_.allowedUsers ?? [],
      pairedUsers: fs_.pairedUsers ?? [],
      defaultWorkDir: fs_.defaultWorkDir || fallbackWorkDir,
      streamingCard: fs_.streamingCard ?? false,
      allowedProjectRoots: readProjectRoots(fs_.allowedProjectRoots),
    },
    wechat: {
      accountId: process.env.WECHAT_ACCOUNT_ID || wc.accountId || '',
      botToken: process.env.WECHAT_BOT_TOKEN || wc.botToken || '',
      baseUrl: process.env.WECHAT_BASE_URL || wc.baseUrl || 'https://ilinkai.weixin.qq.com',
      userId: process.env.WECHAT_USER_ID || wc.userId || '',
      allowedUsers: wc.allowedUsers ?? [],
      pairedUsers: wc.pairedUsers ?? [],
      defaultWorkDir: wc.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(wc.allowedProjectRoots),
    },
    dingtalk: {
      clientId: process.env.DINGTALK_CLIENT_ID || dt.clientId || '',
      clientSecret: process.env.DINGTALK_CLIENT_SECRET || dt.clientSecret || '',
      allowedUsers: dt.allowedUsers ?? [],
      pairedUsers: dt.pairedUsers ?? [],
      defaultWorkDir: dt.defaultWorkDir || fallbackWorkDir,
      endpoint: process.env.DINGTALK_STREAM_ENDPOINT || dt.endpoint || 'https://api.dingtalk.com',
      permissionCardTemplateId: process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID || dt.permissionCardTemplateId || '',
      allowedProjectRoots: readProjectRoots(dt.allowedProjectRoots),
    },
    whatsapp: {
      accountJid: process.env.WHATSAPP_ACCOUNT_JID || wa.accountJid || '',
      authDir: whatsappAuthDir,
      allowedUsers: wa.allowedUsers ?? [],
      pairedUsers: wa.pairedUsers ?? [],
      defaultWorkDir: wa.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(wa.allowedProjectRoots),
    },
    wecom: {
      botId: process.env.WECOM_BOT_ID || wecom.botId || '',
      secret: process.env.WECOM_BOT_SECRET || wecom.secret || '',
      allowedUsers: wecom.allowedUsers ?? [],
      pairedUsers: wecom.pairedUsers ?? [],
      defaultWorkDir: wecom.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(wecom.allowedProjectRoots),
    },
    qq: {
      appId: process.env.QQ_APP_ID || qq.appId || '',
      appSecret: process.env.QQ_APP_SECRET || qq.appSecret || '',
      allowedUsers: qq.allowedUsers ?? [],
      pairedUsers: qq.pairedUsers ?? [],
      defaultWorkDir: qq.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(qq.allowedProjectRoots),
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || slack.botToken || '',
      appToken: process.env.SLACK_APP_TOKEN || slack.appToken || '',
      allowedUsers: slack.allowedUsers ?? [],
      pairedUsers: slack.pairedUsers ?? [],
      defaultWorkDir: slack.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(slack.allowedProjectRoots),
    },
  }
}

export function getConfiguredWorkDir(config: AdapterConfig, platformConfig: AdapterPlatformConfig): string {
  return config.defaultProjectDir || platformConfig.defaultWorkDir
}

// ---------------------------------------------------------------------------
// STT field coercion
//
// `adapters.json` is user-edited JSON: any field can hold any JSON type. These
// helpers form the single boundary where the raw value becomes a provider
// argument, so a malformed field is diagnosed and dropped instead of being
// forwarded to a spawned process and crashing on `.trim()`.
// ---------------------------------------------------------------------------

/** `stt` must be an object; anything else is diagnosed and treated as absent. */
function readSttSection(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  console.warn(`[Config] Ignoring stt: expected an object but the file has ${typeLabel(value)}`)
  return {}
}

/** A non-empty env value wins over the file; an empty/blank env falls through. */
function pickSttValue(envKey: string, fileValue: unknown): unknown {
  const fromEnv = process.env[envKey]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return fileValue
}

function readSttString(value: unknown, field: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    console.warn(`[Config] Ignoring stt.${field}: expected a string but the file has ${typeLabel(value)}`)
    return ''
  }
  return value.trim()
}

/** Language tokens interpolate into a whisper `-l <lang>` argv entry, so only a
 *  plain language code is accepted; anything else is dropped with a warning. */
const STT_LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/

function readSttLanguage(value: unknown): string {
  const raw = readSttString(value, 'language')
  if (!raw) return ''
  if (!STT_LANGUAGE_PATTERN.test(raw)) {
    console.warn(`[Config] Ignoring stt.language ${JSON.stringify(raw)}: not a valid language code`)
    return ''
  }
  return raw
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function normalizeSttProvider(value: unknown): SttConfig['provider'] {
  if (value === undefined || value === null || value === '') return ''
  if (value === 'whisper-local') return 'whisper-local'
  console.warn(
    `[Config] Unsupported stt.provider ${JSON.stringify(value)}; STT is off ` +
      `(only "whisper-local" is implemented)`,
  )
  return ''
}

/**
 * Resolve the directories an IM adapter is allowed to reach.
 *
 * This is deliberately NOT derived from `defaultWorkDir` (#1191). That field is
 * documented as the *default* work dir for new IM sessions, not a boundary, and
 * using it as the sole allowed root broke both directions:
 *
 *   - configured → /projects listed only that one project, and picking any other
 *     recent project by name or path failed;
 *   - blank      → it falls back to PWD/cwd(), which for a Finder-launched .app
 *     is "/", so the boundary silently allowed the entire filesystem.
 *
 * Precedence: ADAPTER_ALLOWED_PROJECT_ROOTS > platform-specific roots > global
 * roots > default (home ∪ default work dir). The pairing gate is the primary
 * authorization control; these roots are defense-in-depth, so a misconfigured
 * value falls back to the default with a warning instead of bricking the bot.
 *
 * Explicitly configured roots are honoured verbatim — if someone types "/" they
 * own the machine and mean it. The *default* branch refuses to inherit such a
 * root, because that is how the boundary silently became vacuous before.
 */
export function resolveAllowedProjectRoots(
  config: AdapterConfig,
  platformConfig: AdapterPlatformConfig,
): string[] {
  // Env wins over both file scopes, matching how every other field in this
  // module resolves.
  const configured = readEnvProjectRoots()
    ?? (platformConfig.allowedProjectRoots.length > 0
      ? platformConfig.allowedProjectRoots
      : config.allowedProjectRoots)

  if (configured.length > 0) {
    const candidates = configured.map(resolveExistingDirectory)
    // Count the misses before dedup — duplicates are not missing directories.
    const missing = candidates.filter((value) => !value).length
    const resolved = dedupePaths(candidates)
    if (resolved.length > 0) {
      if (missing > 0) {
        console.warn(
          missing === 1
            ? '[Config] Ignoring 1 allowedProjectRoots entry that does not exist'
            : `[Config] Ignoring ${missing} allowedProjectRoots entries that do not exist`,
        )
      }
      return resolved
    }
    console.warn(
      '[Config] None of the configured allowedProjectRoots exist; ' +
      'falling back to the default roots (home directory + default project dir)',
    )
  }

  const home = resolveExistingDirectory(os.homedir())
  const defaults = dedupePaths([
    home,
    // Only inherit the default work dir as a boundary when it is a real project
    // directory. "/" and "/Users" reach every project on the machine, so taking
    // them from the PWD/cwd() fallback would make the boundary meaningless.
    usableAsBoundary(resolveExistingDirectory(getConfiguredWorkDir(config, platformConfig))),
  ])
  if (defaults.length > 0) return defaults
  // Only reachable if the home directory itself does not resolve. The adapter
  // client drops unresolvable roots, so this is a best effort, not a guarantee.
  return [os.homedir()]
}

/**
 * Directories the IM boundary must never inherit implicitly: a filesystem root,
 * or any strict ancestor of the home directory (`/`, `/Users`, `/home`).
 */
function usableAsBoundary(dir: string | null): string | null {
  if (!dir) return null
  if (path.parse(dir).root === dir) return null
  return isStrictAncestor(dir, os.homedir()) ? null : dir
}

function isStrictAncestor(candidate: string, target: string): boolean {
  const relative = path.relative(candidate, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The work dir a new IM session starts in, paired with the boundary it must sit
 * inside. Resolving them together is the point: the two are configured
 * separately, and a default project outside the allowed roots would otherwise
 * make every `/new` (and every first message in a fresh chat) fail the client's
 * own boundary check.
 */
export function resolveAdapterWorkspace(
  config: AdapterConfig,
  platformConfig: AdapterPlatformConfig,
): { defaultWorkDir: string; allowedProjectRoots: string[] } {
  const allowedProjectRoots = resolveAllowedProjectRoots(config, platformConfig)
  const configured = resolveExistingDirectory(getConfiguredWorkDir(config, platformConfig))

  if (configured && isPathWithinRoots(configured, allowedProjectRoots)) {
    return { defaultWorkDir: configured, allowedProjectRoots }
  }

  const fallback = allowedProjectRoots[0] ?? os.homedir()
  if (configured) {
    console.warn(
      `[Config] Default project ${configured} is outside the allowed project roots; ` +
      `new sessions will start in ${fallback}`,
    )
  }
  return { defaultWorkDir: fallback, allowedProjectRoots }
}

function isPathWithinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function readProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Public Telegram entry. Absent or malformed `telegram.public` resolves to
 * disabled-in-memory defaults and never writes the config file.
 */
function readTelegramPublic(value: unknown): TelegramPublicConfig {
  const pub = isPlainObject(value) ? value : {}
  const pairing = isPlainObject(pub.pairing) ? pub.pairing : {}
  return {
    enabled: pub.enabled === true,
    botToken: typeof pub.botToken === 'string' ? pub.botToken : '',
    ownerUserId: readPositiveInteger(pub.ownerUserId),
    pairing: {
      code: typeof pairing.code === 'string' ? pairing.code : null,
      expiresAt: pairing.expiresAt === null ? null : readNonNegativeInteger(pairing.expiresAt),
      createdAt: pairing.createdAt === null ? null : readNonNegativeInteger(pairing.createdAt),
    },
    allowedProjectRoots: readProjectRoots(pub.allowedProjectRoots),
    generation: readNonNegativeInteger(pub.generation) ?? 0,
  }
}

function readEnvProjectRoots(): string[] | null {
  const raw = process.env.ADAPTER_ALLOWED_PROJECT_ROOTS?.trim()
  if (!raw) return null
  const roots = readProjectRoots(raw.split(path.delimiter))
  // A delimiter-only value (an unset "$A:$B" in a launcher script) must not read
  // as "the env configured an empty boundary" and discard the file config.
  return roots.length > 0 ? roots : null
}

function dedupePaths(values: (string | null)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function resolveUserDefaultWorkDir(): string {
  const candidates = [
    process.env.ADAPTER_DEFAULT_PROJECT_DIR,
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR,
    process.env.PWD,
    process.cwd(),
  ]

  for (const candidate of candidates) {
    // A GUI-launched sidecar inherits cwd "/" (Electron passes no cwd), which is
    // useless as a place to start a session and unusable as a boundary.
    const resolved = usableAsBoundary(resolveExistingDirectory(candidate))
    if (resolved) return resolved
  }

  return resolveExistingDirectory(os.homedir()) ?? os.homedir()
}

function resolveExistingDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed

  // Relative entries would resolve against the sidecar's cwd ("/" for a packaged
  // app), making the boundary depend on how the app was launched.
  if (!path.isAbsolute(expanded)) return null

  try {
    const realPath = fs.realpathSync(expanded)
    return fs.statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return null
  }
}

function defaultWhatsAppAuthDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'whatsapp-auth', 'default')
}

function resolveConfiguredPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return defaultWhatsAppAuthDir()
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed
  return path.resolve(expanded)
}
