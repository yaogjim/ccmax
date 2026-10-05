/**
 * Adapter Service — 读写 IM Adapter 配置文件
 *
 * 配置文件：~/.claude/adapters.json
 * 原子写入：先写临时文件，再 rename
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { generatePairingCode } from '../../../adapters/common/pairing.js'
import { ApiError } from '../middleware/errorHandler.js'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code?: string | null
  expiresAt?: number | null
  createdAt?: number | null
}

export type TelegramPublicFileConfig = {
  enabled?: boolean
  botToken?: string
  ownerUserId?: number
  pairing?: PairingState
  allowedProjectRoots?: string[]
  generation?: number
}

export type AdapterFileConfig = {
  serverUrl?: string
  defaultProjectDir?: string
  allowedProjectRoots?: string[]
  pairing?: PairingState
  telegram?: {
    botToken?: string
    allowedUsers?: number[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    public?: TelegramPublicFileConfig
  }
  feishu?: {
    appId?: string
    appSecret?: string
    encryptKey?: string
    verificationToken?: string
    domain?: 'feishu' | 'lark'
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    streamingCard?: boolean
  }
  wechat?: {
    accountId?: string
    botToken?: string
    baseUrl?: string
    userId?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  dingtalk?: {
    clientId?: string
    clientSecret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    endpoint?: string
    permissionCardTemplateId?: string
  }
  whatsapp?: {
    accountJid?: string
    authDir?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  wecom?: {
    botId?: string
    secret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  qq?: {
    appId?: string
    appSecret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  slack?: {
    botToken?: string
    appToken?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
}

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

function isMasked(value: string | undefined): boolean {
  return !!value && value.startsWith('****')
}

const CLEARED_PAIRING: PairingState = { code: null, expiresAt: null, createdAt: null }
const PUBLIC_PAIRING_TTL_MS = 60 * 60 * 1000

function nextPublicGeneration(current: number | undefined): number {
  return (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

class AdapterService {
  private updateQueue: Promise<void> = Promise.resolve()

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.updateQueue.then(task)
    this.updateQueue = run.then(() => {}, () => {})
    return run
  }

  /** 读取原始配置（不脱敏） */
  async getRawConfig(): Promise<AdapterFileConfig> {
    try {
      const raw = await fs.readFile(getConfigPath(), 'utf-8')
      return JSON.parse(raw) as AdapterFileConfig
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      console.error('[AdapterService] Failed to read adapter config:', err)
      throw ApiError.internal('Failed to read adapter config')
    }
  }

  /** 读取配置（敏感字段脱敏） */
  async getConfig(): Promise<AdapterFileConfig> {
    const config = await this.getRawConfig()
    if (config.telegram?.botToken) {
      config.telegram.botToken = maskSecret(config.telegram.botToken)
    }
    if (config.telegram?.public?.botToken) {
      config.telegram.public.botToken = maskSecret(config.telegram.public.botToken)
    }
    if (config.telegram?.public?.pairing?.code) {
      config.telegram.public.pairing.code = '******'
    }
    if (config.feishu) {
      if (config.feishu.appSecret) config.feishu.appSecret = maskSecret(config.feishu.appSecret)
      if (config.feishu.encryptKey) config.feishu.encryptKey = maskSecret(config.feishu.encryptKey)
      if (config.feishu.verificationToken) config.feishu.verificationToken = maskSecret(config.feishu.verificationToken)
    }
    if (config.wechat?.botToken) {
      config.wechat.botToken = maskSecret(config.wechat.botToken)
    }
    if (config.dingtalk?.clientSecret) {
      config.dingtalk.clientSecret = maskSecret(config.dingtalk.clientSecret)
    }
    if (config.wecom?.secret) {
      config.wecom.secret = maskSecret(config.wecom.secret)
    }
    if (config.qq?.appSecret) {
      config.qq.appSecret = maskSecret(config.qq.appSecret)
    }
    if (config.slack) {
      if (config.slack.botToken) config.slack.botToken = maskSecret(config.slack.botToken)
      if (config.slack.appToken) config.slack.appToken = maskSecret(config.slack.appToken)
    }
    if (config.pairing?.code) {
      config.pairing.code = '******'
    }
    return config
  }

  /** 更新配置（浅合并，敏感字段如果是脱敏值则保留原值） */
  async updateConfig(patch: Partial<AdapterFileConfig>): Promise<void> {
    return this.enqueue(() => this.applyConfigPatch(patch))
  }

  /**
   * Generate a public-entry pairing code. Independent of the legacy shared
   * `pairing` field. Refuses to mint a code while an owner is already set.
   */
  async generateTelegramPublicPairing(): Promise<{ code: string; expiresAt: number; createdAt: number }> {
    return this.enqueue(async () => {
      const current = await this.getRawConfig()
      const publicConfig = { ...current.telegram?.public }
      if (typeof publicConfig.ownerUserId === 'number') {
        throw ApiError.conflict('Telegram public owner is already set; reset pairing first')
      }
      const code = generatePairingCode()
      const createdAt = Date.now()
      const expiresAt = createdAt + PUBLIC_PAIRING_TTL_MS
      await this.writeConfig({
        ...current,
        telegram: {
          ...current.telegram,
          public: {
            ...publicConfig,
            pairing: { code, expiresAt, createdAt },
          },
        },
      })
      return { code, expiresAt, createdAt }
    })
  }

  /**
   * Clear the public owner. Increments generation and invalidates any
   * outstanding pairing code so old buttons / mappings can be dropped.
   */
  async resetTelegramPublicPairing(): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.getRawConfig()
      const publicConfig = { ...current.telegram?.public }
      delete publicConfig.ownerUserId
      await this.writeConfig({
        ...current,
        telegram: {
          ...current.telegram,
          public: {
            ...publicConfig,
            pairing: { ...CLEARED_PAIRING },
            generation: nextPublicGeneration(current.telegram?.public?.generation),
          },
        },
      })
    })
  }

  /**
   * Atomically occupy the single public owner slot. Requires a private-chat
   * positive integer userId, an unexpired code, and no owner yet.
   */
  async claimTelegramPublicPairing(
    code: string,
    userId: number,
  ): Promise<{ ownerUserId: number; generation: number }> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw ApiError.badRequest('userId must be a positive integer')
      }
      const input = code.trim().toUpperCase()
      if (!input) {
        throw ApiError.badRequest('Pairing code expired or invalid')
      }
      const current = await this.getRawConfig()
      const publicConfig = current.telegram?.public ?? {}
      if (typeof publicConfig.ownerUserId === 'number') {
        throw ApiError.conflict('Telegram public owner is already set')
      }
      const pairing = publicConfig.pairing ?? {}
      const storedCode = typeof pairing.code === 'string' ? pairing.code.trim().toUpperCase() : ''
      if (!storedCode || typeof pairing.expiresAt !== 'number' || Date.now() > pairing.expiresAt) {
        throw ApiError.badRequest('Pairing code expired or invalid')
      }
      if (input !== storedCode) {
        throw ApiError.badRequest('Pairing code expired or invalid')
      }
      const generation = nextPublicGeneration(publicConfig.generation)
      await this.writeConfig({
        ...current,
        telegram: {
          ...current.telegram,
          public: {
            ...publicConfig,
            ownerUserId: userId,
            pairing: { ...CLEARED_PAIRING },
            generation,
          },
        },
      })
      return { ownerUserId: userId, generation }
    })
  }

  private async applyConfigPatch(patch: Partial<AdapterFileConfig>): Promise<void> {
    const current = await this.getRawConfig()

    // 保留已存储的密钥（如果前端传回的是脱敏值）
    if (patch.telegram && isMasked(patch.telegram.botToken)) {
      patch.telegram.botToken = current.telegram?.botToken
    }
    if (patch.telegram?.public && isMasked(patch.telegram.public.botToken)) {
      patch.telegram.public.botToken = current.telegram?.public?.botToken
    }
    if (patch.feishu) {
      if (isMasked(patch.feishu.appSecret)) patch.feishu.appSecret = current.feishu?.appSecret
      if (isMasked(patch.feishu.encryptKey)) patch.feishu.encryptKey = current.feishu?.encryptKey
      if (isMasked(patch.feishu.verificationToken)) patch.feishu.verificationToken = current.feishu?.verificationToken
    }
    if (patch.wechat && isMasked(patch.wechat.botToken)) {
      patch.wechat.botToken = current.wechat?.botToken
    }
    if (patch.dingtalk && isMasked(patch.dingtalk.clientSecret)) {
      patch.dingtalk.clientSecret = current.dingtalk?.clientSecret
    }
    if (patch.wecom && isMasked(patch.wecom.secret)) {
      patch.wecom.secret = current.wecom?.secret
    }
    if (patch.qq && isMasked(patch.qq.appSecret)) {
      patch.qq.appSecret = current.qq?.appSecret
    }
    if (patch.slack) {
      if (isMasked(patch.slack.botToken)) patch.slack.botToken = current.slack?.botToken
      if (isMasked(patch.slack.appToken)) patch.slack.appToken = current.slack?.appToken
    }
    if (patch.pairing && isMasked(patch.pairing.code ?? undefined)) {
      patch.pairing.code = current.pairing?.code
    }

    const patchPublic = patch.telegram?.public
    if (patchPublic) {
      if (hasOwn(patchPublic, 'ownerUserId')) {
        throw ApiError.badRequest('telegram.public.ownerUserId can only be set via public pairing')
      }
      if (hasOwn(patchPublic, 'pairing')) {
        throw ApiError.badRequest('telegram.public.pairing can only be changed via public pairing endpoints')
      }
      if (hasOwn(patchPublic, 'generation')) {
        throw ApiError.badRequest('telegram.public.generation is managed by the server')
      }
    }

    const exclusiveToken = patch.telegram && hasOwn(patch.telegram, 'botToken')
      ? patch.telegram.botToken
      : current.telegram?.botToken
    const publicToken = patchPublic && hasOwn(patchPublic, 'botToken')
      ? patchPublic.botToken
      : current.telegram?.public?.botToken
    if (exclusiveToken && publicToken && exclusiveToken === publicToken) {
      throw ApiError.badRequest('telegram.public.botToken must differ from telegram.botToken')
    }

    const mergedTelegram = patch.telegram
      ? {
          ...current.telegram,
          ...patch.telegram,
          ...(patchPublic
            ? { public: { ...current.telegram?.public, ...patchPublic } }
            : {}),
        }
      : current.telegram

    if (patchPublic && mergedTelegram?.public) {
      const previousToken = current.telegram?.public?.botToken
      const nextToken = mergedTelegram.public.botToken
      if (previousToken !== nextToken) {
        mergedTelegram.public.generation = nextPublicGeneration(current.telegram?.public?.generation)
        mergedTelegram.public.pairing = { ...CLEARED_PAIRING }
      }
    }

    const merged: AdapterFileConfig = {
      ...current,
      ...patch,
      telegram: mergedTelegram,
      feishu: patch.feishu ? { ...current.feishu, ...patch.feishu } : current.feishu,
      wechat: patch.wechat ? { ...current.wechat, ...patch.wechat } : current.wechat,
      dingtalk: patch.dingtalk ? { ...current.dingtalk, ...patch.dingtalk } : current.dingtalk,
      whatsapp: patch.whatsapp ? { ...current.whatsapp, ...patch.whatsapp } : current.whatsapp,
      wecom: patch.wecom ? { ...current.wecom, ...patch.wecom } : current.wecom,
      qq: patch.qq ? { ...current.qq, ...patch.qq } : current.qq,
      slack: patch.slack ? { ...current.slack, ...patch.slack } : current.slack,
      pairing: patch.pairing !== undefined ? { ...current.pairing, ...patch.pairing } : current.pairing,
    }

    await this.writeConfig(merged)
  }

  private async writeConfig(data: AdapterFileConfig): Promise<void> {
    const filePath = getConfigPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    const tmpFile = `${filePath}.tmp.${crypto.randomUUID()}`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmpFile, filePath)
      await fs.chmod(filePath, 0o600).catch(() => {})
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      console.error('[AdapterService] Failed to write adapter config:', err)
      throw ApiError.internal('Failed to write adapter config')
    }
  }
}

export const adapterService = new AdapterService()
