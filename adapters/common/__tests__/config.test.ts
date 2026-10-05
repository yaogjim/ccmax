import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getConfiguredWorkDir, loadConfig, resolveAllowedProjectRoots } from '../config.js'

describe('adapter config defaults', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalAdapterDefaultWorkDir = process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
  const originalAdapterDefaultProjectDir = process.env.ADAPTER_DEFAULT_PROJECT_DIR
  const originalDingtalkPermissionCardTemplateId = process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID
  const originalPwd = process.env.PWD

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('CLAUDE_ADAPTER_DEFAULT_WORK_DIR', originalAdapterDefaultWorkDir)
    restoreEnv('ADAPTER_DEFAULT_PROJECT_DIR', originalAdapterDefaultProjectDir)
    restoreEnv('DINGTALK_PERMISSION_CARD_TEMPLATE_ID', originalDingtalkPermissionCardTemplateId)
    restoreEnv('PWD', originalPwd)
  })

  it('uses the user shell working directory when no default project is configured', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
      process.env.PWD = workDir

      const config = loadConfig()

      expect(config.telegram.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.feishu.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.dingtalk.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.whatsapp.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.wechat)).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('keeps the explicit default project ahead of the platform default work dir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ defaultProjectDir }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = workDir

      const config = loadConfig()

      expect(getConfiguredWorkDir(config, config.wechat)).toBe(defaultProjectDir)
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(defaultProjectDir)
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(defaultProjectDir)
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.dingtalk.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.whatsapp.defaultWorkDir).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('accepts ADAPTER_DEFAULT_PROJECT_DIR as a sidecar-friendly default work dir override', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.ADAPTER_DEFAULT_PROJECT_DIR = defaultProjectDir
      delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
      delete process.env.PWD

      const config = loadConfig()

      expect(getConfiguredWorkDir(config, config.wechat)).toBe(fs.realpathSync(defaultProjectDir))
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(fs.realpathSync(defaultProjectDir))
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(fs.realpathSync(defaultProjectDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
    }
  })

  it('loads DingTalk permission card template id from file or env', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ dingtalk: { permissionCardTemplateId: 'file-template' } }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID
      expect(loadConfig().dingtalk.permissionCardTemplateId).toBe('file-template')

      process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID = 'env-template'
      expect(loadConfig().dingtalk.permissionCardTemplateId).toBe('env-template')
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('loads WhatsApp auth dir from file or env', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const originalWhatsAppAuthDir = process.env.WHATSAPP_AUTH_DIR
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ whatsapp: { authDir: '~/custom-whatsapp-auth', accountJid: '15551234567@s.whatsapp.net' } }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.WHATSAPP_AUTH_DIR
      expect(loadConfig().whatsapp.authDir).toBe(path.join(os.homedir(), 'custom-whatsapp-auth'))
      expect(loadConfig().whatsapp.accountJid).toBe('15551234567@s.whatsapp.net')

      process.env.WHATSAPP_AUTH_DIR = path.join(configDir, 'wa-auth')
      expect(loadConfig().whatsapp.authDir).toBe(path.join(configDir, 'wa-auth'))
    } finally {
      restoreEnv('WHATSAPP_AUTH_DIR', originalWhatsAppAuthDir)
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe('resolveAllowedProjectRoots', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalEnvRoots = process.env.ADAPTER_ALLOWED_PROJECT_ROOTS
  const originalAdapterDefaultWorkDir = process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
  const originalPwd = process.env.PWD
  const home = fs.realpathSync(os.homedir())

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('ADAPTER_ALLOWED_PROJECT_ROOTS', originalEnvRoots)
    restoreEnv('CLAUDE_ADAPTER_DEFAULT_WORK_DIR', originalAdapterDefaultWorkDir)
    restoreEnv('PWD', originalPwd)
  })

  function withConfig<T>(file: Record<string, unknown>, run: (configDir: string) => T): T {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    try {
      fs.writeFileSync(path.join(configDir, 'adapters.json'), JSON.stringify(file))
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.ADAPTER_ALLOWED_PROJECT_ROOTS
      return run(configDir)
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  }

  // The #1191 regression: `defaultProjectDir` is the default work dir for NEW
  // sessions, not the boundary. Deriving the only allowed root from it hid every
  // other project from /projects on all five IM channels.
  it('does not collapse the boundary onto the configured default project', () => {
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    try {
      withConfig({ defaultProjectDir }, () => {
        const config = loadConfig()
        for (const platform of [config.telegram, config.feishu, config.wechat, config.dingtalk, config.whatsapp]) {
          const roots = resolveAllowedProjectRoots(config, platform)
          expect(roots).not.toEqual([fs.realpathSync(defaultProjectDir)])
          expect(roots).toContain(home)
          expect(roots).toContain(fs.realpathSync(defaultProjectDir))
        }
      })
    } finally {
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
    }
  })

  it('defaults to the home directory so sibling projects stay reachable', () => {
    withConfig({}, () => {
      const config = loadConfig()
      expect(resolveAllowedProjectRoots(config, config.feishu)).toContain(home)
    })
  })

  it('uses explicitly configured global roots instead of the default', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-a-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-b-'))
    try {
      withConfig({ allowedProjectRoots: [rootA, rootB] }, () => {
        const config = loadConfig()
        expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([
          fs.realpathSync(rootA),
          fs.realpathSync(rootB),
        ])
      })
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true })
      fs.rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('lets a platform narrow the global roots', () => {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-global-'))
    const feishuRoot = fs.mkdtempSync(path.join(globalRoot, 'feishu-'))
    try {
      withConfig({ allowedProjectRoots: [globalRoot], feishu: { allowedProjectRoots: [feishuRoot] } }, () => {
        const config = loadConfig()
        expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([fs.realpathSync(feishuRoot)])
        // Other platforms keep the global roots.
        expect(resolveAllowedProjectRoots(config, config.telegram)).toEqual([fs.realpathSync(globalRoot)])
      })
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true })
    }
  })

  // A relative entry would resolve against the sidecar's cwd — "/" for a
  // GUI-launched app — making the boundary depend on how the app was started.
  it('rejects relative roots', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-'))
    try {
      withConfig({ allowedProjectRoots: ['..', 'relative/path', realRoot] }, () => {
        const config = loadConfig()
        expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([fs.realpathSync(realRoot)])
      })
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true })
    }
  })

  it('does not warn about duplicates as if they were missing', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      withConfig({ allowedProjectRoots: [realRoot, realRoot, '~', os.homedir()] }, () => {
        const config = loadConfig()
        expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([
          fs.realpathSync(realRoot),
          home,
        ])
      })
      expect(warnings.filter((line) => line.includes('do not exist') || line.includes('does not exist')))
        .toEqual([])
    } finally {
      console.warn = originalWarn
      fs.rmSync(realRoot, { recursive: true, force: true })
    }
  })

  it('expands ~ and drops entries that do not exist', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-root-'))
    try {
      withConfig({ allowedProjectRoots: [realRoot, path.join(os.tmpdir(), 'definitely-missing-root'), '~'] }, () => {
        const config = loadConfig()
        expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([fs.realpathSync(realRoot), home])
      })
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true })
    }
  })

  // Failing closed here would brick every IM command on a typo. The pairing gate
  // is the primary authorization control; these roots are defense-in-depth.
  it('falls back to the default when no configured root exists', () => {
    withConfig({ allowedProjectRoots: [path.join(os.tmpdir(), 'missing-a'), path.join(os.tmpdir(), 'missing-b')] }, () => {
      const config = loadConfig()
      const roots = resolveAllowedProjectRoots(config, config.feishu)
      expect(roots).toContain(home)
      expect(roots.length).toBeGreaterThan(0)
    })
  })

  it('reads roots from ADAPTER_ALLOWED_PROJECT_ROOTS for standalone runs', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-env-root-a-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-env-root-b-'))
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = [rootA, rootB].join(path.delimiter)

      const config = loadConfig()
      expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([
        fs.realpathSync(rootA),
        fs.realpathSync(rootB),
      ])
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true })
      fs.rmSync(rootB, { recursive: true, force: true })
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('lets the env override win over both file scopes', () => {
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-env-root-'))
    const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-file-root-'))
    try {
      withConfig(
        { allowedProjectRoots: [fileRoot], feishu: { allowedProjectRoots: [fileRoot] } },
        () => {
          process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = envRoot
          const config = loadConfig()
          expect(resolveAllowedProjectRoots(config, config.feishu)).toEqual([fs.realpathSync(envRoot)])
          expect(resolveAllowedProjectRoots(config, config.telegram)).toEqual([fs.realpathSync(envRoot)])
        },
      )
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
      fs.rmSync(fileRoot, { recursive: true, force: true })
    }
  })
})

describe('telegram public entry config', () => {
  const originalHome = process.env.HOME
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalXdg = process.env.XDG_CONFIG_HOME
  const originalTmpdir = process.env.TMPDIR
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN
  let root = ''

  function isolate(): { configDir: string; configPath: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-public-config-'))
    const home = path.join(root, 'home')
    const configDir = path.join(root, 'claude')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(configDir, { recursive: true })
    fs.mkdirSync(path.join(root, 'xdg'), { recursive: true })
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
    process.env.TMPDIR = path.join(root, 'tmp')
    delete process.env.TELEGRAM_BOT_TOKEN
    return { configDir, configPath: path.join(configDir, 'adapters.json') }
  }

  afterEach(() => {
    restoreEnv('HOME', originalHome)
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('XDG_CONFIG_HOME', originalXdg)
    restoreEnv('TMPDIR', originalTmpdir)
    restoreEnv('TELEGRAM_BOT_TOKEN', originalTelegramToken)
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('defaults public to disabled without writing a file when config is empty', () => {
    const { configPath } = isolate()
    const config = loadConfig()
    expect(config.telegram.public).toEqual({
      enabled: false,
      botToken: '',
      ownerUserId: null,
      pairing: { code: null, expiresAt: null, createdAt: null },
      allowedProjectRoots: [],
      generation: 0,
    })
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('keeps old telegram fields and does not write public into an old fixture', () => {
    const { configPath } = isolate()
    const fixture = {
      pairing: { code: 'ABC234', expiresAt: 9_999_999_999_000, createdAt: 1 },
      telegram: {
        botToken: 'exclusive-token',
        allowedUsers: [111],
        pairedUsers: [{ userId: 111, displayName: 'Owner', pairedAt: 1 }],
        defaultWorkDir: '/tmp/work',
        allowedProjectRoots: ['/tmp/work'],
        futureExclusive: 'keep-me',
      },
      futureRoot: { keep: true },
    }
    const raw = JSON.stringify(fixture)
    fs.writeFileSync(configPath, raw)
    const before = fs.statSync(configPath)

    const config = loadConfig()

    expect(config.telegram.botToken).toBe('exclusive-token')
    expect(config.telegram.allowedUsers).toEqual([111])
    expect(config.telegram.pairedUsers).toEqual([{ userId: 111, displayName: 'Owner', pairedAt: 1 }])
    expect(config.telegram.defaultWorkDir).toBe('/tmp/work')
    expect(config.pairing.code).toBe('ABC234')
    expect(config.telegram.public.enabled).toBe(false)
    expect(config.telegram.public.botToken).toBe('')
    expect(config.telegram.public.ownerUserId).toBeNull()
    expect(config.telegram.public.generation).toBe(0)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(raw)
    expect(fs.statSync(configPath).mtimeMs).toBe(before.mtimeMs)
  })

  it('loads an explicit public block without inheriting the exclusive token from env', () => {
    const { configPath } = isolate()
    process.env.TELEGRAM_BOT_TOKEN = 'env-exclusive-token'
    fs.writeFileSync(configPath, JSON.stringify({
      telegram: {
        botToken: 'file-exclusive',
        public: {
          enabled: true,
          botToken: 'public-token',
          ownerUserId: 42,
          generation: 3,
          pairing: { code: 'PUB123', expiresAt: 8, createdAt: 7 },
          allowedProjectRoots: ['/tmp/public'],
        },
      },
    }))

    const config = loadConfig()
    expect(config.telegram.botToken).toBe('env-exclusive-token')
    expect(config.telegram.public.enabled).toBe(true)
    expect(config.telegram.public.botToken).toBe('public-token')
    expect(config.telegram.public.ownerUserId).toBe(42)
    expect(config.telegram.public.generation).toBe(3)
    expect(config.telegram.public.pairing).toEqual({ code: 'PUB123', expiresAt: 8, createdAt: 7 })
    expect(config.telegram.public.allowedProjectRoots).toEqual(['/tmp/public'])
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
