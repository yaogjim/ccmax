import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { adapterService } from './adapterService.js'
import { ApiError } from '../middleware/errorHandler.js'

let root = ''
let configDir = ''
const previous = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMPDIR: process.env.TMPDIR,
}

function restoreEnv(key: keyof typeof previous, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function readStored(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(configDir, 'adapters.json'), 'utf-8'))
}

describe('adapterService telegram public config', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-public-service-'))
    const home = path.join(root, 'home')
    configDir = path.join(root, 'claude')
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(path.join(root, 'xdg'), { recursive: true })
    await fs.mkdir(path.join(root, 'tmp'), { recursive: true })
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
    process.env.TMPDIR = path.join(root, 'tmp')
  })

  afterEach(async () => {
    restoreEnv('HOME', previous.HOME)
    restoreEnv('CLAUDE_CONFIG_DIR', previous.CLAUDE_CONFIG_DIR)
    restoreEnv('XDG_CONFIG_HOME', previous.XDG_CONFIG_HOME)
    restoreEnv('TMPDIR', previous.TMPDIR)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('masks the public token and pairing code on read, and keeps the real values on masked save', async () => {
    await adapterService.updateConfig({
      telegram: {
        botToken: 'exclusive-secret-token',
        public: { enabled: true, botToken: 'public-secret-token' },
      },
    })

    const masked = await adapterService.getConfig()
    expect(masked.telegram?.botToken).toBe('****oken')
    expect(masked.telegram?.public?.botToken).toBe('****oken')

    const generated = await adapterService.generateTelegramPublicPairing()
    const maskedAfterPairing = await adapterService.getConfig()
    expect(maskedAfterPairing.telegram?.public?.pairing?.code).toBe('******')
    expect(generated.code).not.toBe('******')

    await adapterService.updateConfig({
      telegram: {
        botToken: masked.telegram?.botToken,
        allowedUsers: [7],
        public: { botToken: masked.telegram?.public?.botToken, enabled: true },
      },
    })

    const stored = await readStored()
    expect(stored.telegram.botToken).toBe('exclusive-secret-token')
    expect(stored.telegram.public.botToken).toBe('public-secret-token')
    expect(stored.telegram.allowedUsers).toEqual([7])
    expect(stored.telegram.public.enabled).toBe(true)
    expect(stored.telegram.public.pairing.code).toBe(generated.code)
  })

  it('preserves unknown fields and does not clear the other Telegram entry on nested patches', async () => {
    await fs.writeFile(path.join(configDir, 'adapters.json'), JSON.stringify({
      futureRoot: { keep: 'root' },
      pairing: { code: 'OLD123', expiresAt: 9, createdAt: 8 },
      telegram: {
        botToken: 'exclusive-token',
        futureExclusive: 'keep-exclusive',
        public: {
          enabled: true,
          botToken: 'public-token',
          generation: 2,
          futurePublic: { keep: true },
          pairing: { code: 'PUB001', expiresAt: 11, createdAt: 10, futurePair: 'keep' },
        },
      },
    }, null, 2) + '\n')

    await adapterService.updateConfig({
      telegram: { allowedUsers: [111], public: { enabled: false } },
    })

    const afterExclusive = await readStored()
    expect(afterExclusive.futureRoot).toEqual({ keep: 'root' })
    expect(afterExclusive.pairing).toEqual({ code: 'OLD123', expiresAt: 9, createdAt: 8 })
    expect(afterExclusive.telegram.botToken).toBe('exclusive-token')
    expect(afterExclusive.telegram.futureExclusive).toBe('keep-exclusive')
    expect(afterExclusive.telegram.allowedUsers).toEqual([111])
    expect(afterExclusive.telegram.public).toMatchObject({
      enabled: false,
      botToken: 'public-token',
      generation: 2,
      futurePublic: { keep: true },
      pairing: { code: 'PUB001', expiresAt: 11, createdAt: 10, futurePair: 'keep' },
    })

    await adapterService.updateConfig({
      telegram: { public: { allowedProjectRoots: ['/tmp/public'] } },
    })
    const afterPublic = await readStored()
    expect(afterPublic.telegram.botToken).toBe('exclusive-token')
    expect(afterPublic.telegram.allowedUsers).toEqual([111])
    expect(afterPublic.telegram.futureExclusive).toBe('keep-exclusive')
    expect(afterPublic.telegram.public.botToken).toBe('public-token')
    expect(afterPublic.telegram.public.allowedProjectRoots).toEqual(['/tmp/public'])
    expect(afterPublic.telegram.public.futurePublic).toEqual({ keep: true })
  })

  it('rejects configuring the public token to the exclusive token', async () => {
    await adapterService.updateConfig({
      telegram: { botToken: 'same-token', public: { botToken: 'other-token' } },
    })
    await expect(adapterService.updateConfig({
      telegram: { public: { botToken: 'same-token' } },
    })).rejects.toBeInstanceOf(ApiError)

    await expect(adapterService.updateConfig({
      telegram: { botToken: 'other-token' },
    })).rejects.toBeInstanceOf(ApiError)

    const stored = await readStored()
    expect(stored.telegram.botToken).toBe('same-token')
    expect(stored.telegram.public.botToken).toBe('other-token')
  })

  it('increments generation and clears the public pairing code when the public token actually changes', async () => {
    await adapterService.updateConfig({
      telegram: { botToken: 'exclusive-token', public: { botToken: 'public-v1' } },
    })
    const first = await readStored()
    expect(first.telegram.public.generation).toBe(1)

    const pairing = await adapterService.generateTelegramPublicPairing()
    await adapterService.updateConfig({
      telegram: { public: { botToken: 'public-v1', enabled: true } },
    })
    const unchanged = await readStored()
    expect(unchanged.telegram.public.generation).toBe(1)
    expect(unchanged.telegram.public.pairing.code).toBe(pairing.code)
    expect(unchanged.telegram.public.enabled).toBe(true)

    await adapterService.updateConfig({
      telegram: { public: { botToken: 'public-v2' } },
    })
    const changed = await readStored()
    expect(changed.telegram.public.generation).toBe(2)
    expect(changed.telegram.public.pairing).toEqual({ code: null, expiresAt: null, createdAt: null })
    expect(changed.telegram.public.enabled).toBe(true)
    expect(changed.telegram.botToken).toBe('exclusive-token')
  })

  it('keeps public pairing independent of the legacy pairing field', async () => {
    await adapterService.updateConfig({
      pairing: { code: 'OLD123', expiresAt: Date.now() + 60_000, createdAt: 1 },
      telegram: { botToken: 'exclusive-token' },
    })
    const generated = await adapterService.generateTelegramPublicPairing()
    const stored = await readStored()
    expect(stored.pairing.code).toBe('OLD123')
    expect(stored.telegram.public.pairing.code).toBe(generated.code)
    expect(stored.telegram.public.pairing.code).not.toBe('OLD123')
  })

  it('lets only one concurrent claim occupy the owner, and repeat claims cannot replace them', async () => {
    await adapterService.updateConfig({
      telegram: { public: { botToken: 'public-token' } },
    })
    const { code } = await adapterService.generateTelegramPublicPairing()

    const results = await Promise.allSettled([
      adapterService.claimTelegramPublicPairing(code, 1001),
      adapterService.claimTelegramPublicPairing(code, 1002),
    ])
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ ownerUserId: number; generation: number }> =>
      result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(fulfilled[0]!.value.ownerUserId === 1001 || fulfilled[0]!.value.ownerUserId === 1002).toBe(true)
    expect(fulfilled[0]!.value.generation).toBe(2)

    const stored = await readStored()
    expect(stored.telegram.public.ownerUserId).toBe(fulfilled[0]!.value.ownerUserId)
    expect(stored.telegram.public.pairing.code).toBeNull()

    await expect(adapterService.claimTelegramPublicPairing(code, 1003)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect((await readStored()).telegram.public.ownerUserId).toBe(fulfilled[0]!.value.ownerUserId)
  })

  it('rejects an expired public pairing code and leaves owner unset', async () => {
    await fs.writeFile(path.join(configDir, 'adapters.json'), JSON.stringify({
      telegram: {
        public: {
          botToken: 'public-token',
          pairing: { code: 'EXPIRE', expiresAt: Date.now() - 1, createdAt: 1 },
        },
      },
    }))

    await expect(adapterService.claimTelegramPublicPairing('EXPIRE', 2001)).rejects.toMatchObject({
      statusCode: 400,
    })
    const stored = await readStored()
    expect(stored.telegram.public.ownerUserId).toBeUndefined()
  })

  it('rejects non-positive userIds and regular patches that try to set the owner', async () => {
    await adapterService.updateConfig({
      telegram: { public: { botToken: 'public-token' } },
    })
    const { code } = await adapterService.generateTelegramPublicPairing()

    await expect(adapterService.claimTelegramPublicPairing(code, 0)).rejects.toMatchObject({ statusCode: 400 })
    await expect(adapterService.claimTelegramPublicPairing(code, -5)).rejects.toMatchObject({ statusCode: 400 })
    await expect(adapterService.updateConfig({
      telegram: { public: { ownerUserId: 9 } },
    })).rejects.toMatchObject({ statusCode: 400 })

    const stored = await readStored()
    expect(stored.telegram.public.ownerUserId).toBeUndefined()
    expect(stored.telegram.public.pairing.code).toBe(code)
  })

  it('increments generation and clears owner plus code on reset', async () => {
    await adapterService.updateConfig({
      telegram: { public: { botToken: 'public-token' } },
    })
    const { code } = await adapterService.generateTelegramPublicPairing()
    await adapterService.claimTelegramPublicPairing(code, 3001)
    const before = await readStored()
    expect(before.telegram.public.ownerUserId).toBe(3001)
    expect(before.telegram.public.generation).toBe(2)
    await expect(adapterService.generateTelegramPublicPairing()).rejects.toMatchObject({ statusCode: 409 })

    await adapterService.resetTelegramPublicPairing()
    const after = await readStored()
    expect(after.telegram.public.ownerUserId).toBeUndefined()
    expect(after.telegram.public.pairing).toEqual({ code: null, expiresAt: null, createdAt: null })
    expect(after.telegram.public.generation).toBe(3)
    expect(after.telegram.public.botToken).toBe('public-token')
  })
})