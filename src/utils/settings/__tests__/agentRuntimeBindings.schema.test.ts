import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { getSettingsForSource } from '../settings.js'
import { resetSettingsCache } from '../settingsCache.js'

// A malformed optional key must never take the whole settings file down:
// parseSettingsFileUncached drops every setting when the schema throws. Each
// case drives a real file through the real reader.
describe('agentRuntimeBindings settings schema', () => {
  let tmpDir: string
  let projectRoot: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-schema-'))
    projectRoot = path.join(tmpDir, 'project')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readSettings(raw: unknown) {
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'settings.json'),
      typeof raw === 'string' ? raw : JSON.stringify(raw),
    )
    resetSettingsCache()
    return getSettingsForSource('projectSettings', projectRoot)
  }

  it('parses a well-formed binding', async () => {
    const settings = await readSettings({
      agentRuntimeBindings: {
        niuma: { providerId: 'p1', modelId: 'deepseek-flash' },
      },
    })

    expect(settings?.agentRuntimeBindings).toEqual({
      niuma: { providerId: 'p1', modelId: 'deepseek-flash' },
    })
  })

  it('keeps unknown per-binding fields written by a newer client', async () => {
    const settings = await readSettings({
      agentRuntimeBindings: {
        niuma: { providerId: 'p1', modelId: 'm', futureField: { a: 1 } },
      },
    })

    expect(settings?.agentRuntimeBindings?.niuma).toEqual({
      providerId: 'p1',
      modelId: 'm',
      futureField: { a: 1 },
    })
  })

  it('keeps the rest of settings.json when the key is malformed', async () => {
    const settings = await readSettings({
      model: 'opus',
      env: { FOO: '1' },
      agentRuntimeBindings: 'nope',
    })

    expect(settings).not.toBeNull()
    expect(settings?.model).toBe('opus')
    expect(settings?.env).toEqual({ FOO: '1' })
    expect(settings?.agentRuntimeBindings).toBeUndefined()
  })

  it('drops only the malformed entry, keeping its siblings', async () => {
    const settings = await readSettings({
      model: 'opus',
      agentRuntimeBindings: {
        bad: 'sonnet',
        worse: { providerId: 7, modelId: ['x'] },
        good: { providerId: 'p1', modelId: 'm' },
      },
    })

    expect(settings?.model).toBe('opus')
    expect(settings?.agentRuntimeBindings?.bad).toEqual({})
    expect(settings?.agentRuntimeBindings?.worse?.providerId).toBeUndefined()
    expect(settings?.agentRuntimeBindings?.worse?.modelId).toBeUndefined()
    expect(settings?.agentRuntimeBindings?.good).toEqual({
      providerId: 'p1',
      modelId: 'm',
    })
  })

  it('reads a settings file written before the key existed', async () => {
    const settings = await readSettings({
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
    })

    expect(settings?.model).toBe('opus')
    expect(settings?.permissions?.allow).toEqual(['Bash(git status)'])
    expect('agentRuntimeBindings' in (settings ?? {})).toBe(false)
  })
})
