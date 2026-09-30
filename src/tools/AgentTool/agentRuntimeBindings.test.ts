import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getOriginalCwd,
  setFlagSettingsPath,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

// Managed (policy) settings come from MDM/registry/remote/a system path, none of
// which can be redirected into a temp dir. Only that one source and the
// strictPluginOnlyCustomization answer are faked; user/project/local/flag
// below are real files read by the real reader.
let policySettings: Record<string, unknown> | null = null
let agentsSurfaceLocked = false
const actualSettings = await import('../../utils/settings/settings.js')
const actualPolicy = await import('../../utils/settings/pluginOnlyPolicy.js')
// bun's mock.module rewrites the already-loaded module's exports in place, so
// the real function must be captured first or the wrapper would call itself.
const realSettingsModule = { ...actualSettings }
mock.module('../../utils/settings/settings.js', () => ({
  ...realSettingsModule,
  getSettingsForSource: (source: string, root?: string) =>
    source === 'policySettings'
      ? policySettings
      : realSettingsModule.getSettingsForSource(source as never, root),
}))
mock.module('../../utils/settings/pluginOnlyPolicy.js', () => ({
  ...actualPolicy,
  isRestrictedToPluginOnly: (surface: string) =>
    surface === 'agents' ? agentsSurfaceLocked : false,
}))

const { resolveAgentRuntimeBinding, resolveAgentRuntimeBindings } =
  await import('./agentRuntimeBindings.js')

afterAll(() => {
  // mock.module is process-wide in bun; put the real modules back.
  mock.module('../../utils/settings/settings.js', () => realSettingsModule)
  mock.module('../../utils/settings/pluginOnlyPolicy.js', () => actualPolicy)
})

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalCwd = getOriginalCwd()

let tmpDir: string
let configDir: string
let projectDir: string

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  resetSettingsCache()
}

const userFile = () => path.join(configDir, 'settings.json')

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-bindings-'))
  configDir = path.join(tmpDir, 'config')
  projectDir = path.join(tmpDir, 'project')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  setOriginalCwd(projectDir)
  policySettings = null
  agentsSurfaceLocked = false
  resetSettingsCache()
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  setOriginalCwd(originalCwd)
  setFlagSettingsPath(undefined)
  resetSettingsCache()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const binding = { niuma: { providerId: 'deepseek-1', modelId: 'deepseek-flash' } }

describe('agent runtime bindings resolver', () => {
  test('reads a user-level binding with its source', () => {
    writeJson(userFile(), { agentRuntimeBindings: binding })

    expect(resolveAgentRuntimeBinding('niuma')).toEqual({
      providerId: 'deepseek-1',
      modelId: 'deepseek-flash',
      source: 'userSettings',
    })
    // agentType is case-sensitive.
    expect(resolveAgentRuntimeBinding('Niuma')).toBeUndefined()
  })

  test('a settings file without the key behaves exactly as before', () => {
    // Old fixture: written before the key existed.
    writeJson(userFile(), { model: 'opus', permissions: { allow: ['Bash(ls)'] } })

    expect(resolveAgentRuntimeBindings().size).toBe(0)
  })

  test('project, local and flag settings cannot declare a binding', () => {
    writeJson(path.join(projectDir, '.claude', 'settings.json'), {
      agentRuntimeBindings: binding,
    })
    writeJson(path.join(projectDir, '.claude', 'settings.local.json'), {
      agentRuntimeBindings: binding,
    })
    const flagFile = path.join(tmpDir, 'flag.json')
    writeJson(flagFile, { agentRuntimeBindings: binding })
    setFlagSettingsPath(flagFile)
    resetSettingsCache()

    expect(resolveAgentRuntimeBindings().size).toBe(0)
  })

  test('a project file cannot override the user binding either', () => {
    writeJson(userFile(), { agentRuntimeBindings: binding })
    writeJson(path.join(projectDir, '.claude', 'settings.json'), {
      agentRuntimeBindings: {
        niuma: { providerId: 'attacker', modelId: 'evil' },
      },
    })

    expect(resolveAgentRuntimeBinding('niuma')?.providerId).toBe('deepseek-1')
  })

  test('policy settings win over user settings', () => {
    writeJson(userFile(), { agentRuntimeBindings: binding })
    policySettings = {
      agentRuntimeBindings: {
        niuma: { providerId: 'corp', modelId: 'corp-model' },
      },
    }

    expect(resolveAgentRuntimeBinding('niuma')).toEqual({
      providerId: 'corp',
      modelId: 'corp-model',
      source: 'policySettings',
    })
  })

  test('user bindings are dropped when agents are locked to plugins, policy ones stay', () => {
    writeJson(userFile(), { agentRuntimeBindings: binding })
    policySettings = {
      agentRuntimeBindings: {
        managed: { providerId: 'corp', modelId: 'corp-model' },
      },
    }
    agentsSurfaceLocked = true

    const resolved = resolveAgentRuntimeBindings()
    expect(resolved.has('niuma')).toBe(false)
    expect(resolved.get('managed')?.source).toBe('policySettings')
  })

  test('ignores entries that lack a provider or a model', () => {
    writeJson(userFile(), {
      agentRuntimeBindings: {
        a: { providerId: 'p' },
        b: { modelId: 'm' },
        c: 'nope',
        d: { providerId: '  ', modelId: 'm' },
        ok: { providerId: ' p ', modelId: ' m ' },
      },
    })

    const resolved = resolveAgentRuntimeBindings()
    expect([...resolved.keys()]).toEqual(['ok'])
    // Whitespace is trimmed, matching the schema.
    expect(resolved.get('ok')).toMatchObject({ providerId: 'p', modelId: 'm' })
  })

  test('a malformed key degrades to no bindings without dropping the file', () => {
    writeJson(userFile(), { model: 'opus', agentRuntimeBindings: 'nope' })

    expect(resolveAgentRuntimeBindings().size).toBe(0)
    // Unrelated settings survive.
    expect(realSettingsModule.getSettingsForSource('userSettings')?.model).toBe(
      'opus',
    )
  })
})
