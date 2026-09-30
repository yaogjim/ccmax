import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentRuntimeModelError,
  describeAgentRuntime,
  resolveAgentRuntimeModel,
} from './agentRuntimeModel.js'
import { ProviderService } from './providerService.js'

let home: string
let originalEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'agent-runtime-model-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

async function addProvider(models: Record<string, string>) {
  return new ProviderService().addProvider({
    presetId: 'custom',
    name: 'Vendor',
    baseUrl: 'http://127.0.0.1:32111',
    apiKey: 'fake-key',
    models,
  } as any)
}

const fullModels = {
  main: 'v-main',
  sonnet: 'v-sonnet',
  opus: 'v-opus',
  haiku: 'v-haiku',
}

describe('resolveAgentRuntimeModel', () => {
  test('maps aliases through the provider, treating default as main', async () => {
    const provider = await addProvider(fullModels)
    const service = new ProviderService()

    expect(
      (await resolveAgentRuntimeModel(service, { providerId: provider.id, modelId: 'opus' })).modelId,
    ).toBe('v-opus')
    expect(
      (await resolveAgentRuntimeModel(service, { providerId: provider.id, modelId: 'default' })).modelId,
    ).toBe('v-main')
    const literal = await resolveAgentRuntimeModel(service, {
      providerId: provider.id,
      modelId: ' deepseek-flash ',
    })
    expect(literal.modelId).toBe('deepseek-flash')
    expect(literal.provider?.id).toBe(provider.id)
  })

  test('normalizes a claude-official model and returns no provider', async () => {
    const resolved = await resolveAgentRuntimeModel(new ProviderService(), {
      providerId: 'claude-official',
      modelId: 'claude-sonnet-4-5',
    })
    expect(resolved.provider).toBeNull()
    expect(resolved.modelId).toBe('claude-sonnet-4-5')
  })

  test('classifies failures with a stable code', async () => {
    const provider = await addProvider({ ...fullModels, haiku: '', sonnet: '', opus: '' })
    const service = new ProviderService()
    const codeOf = async (runtime: { providerId: string; modelId: string }) => {
      try {
        await resolveAgentRuntimeModel(service, runtime, 'agent niuma')
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRuntimeModelError)
        return { code: (error as AgentRuntimeModelError).code, message: (error as Error).message }
      }
      throw new Error('expected a rejection')
    }

    expect((await codeOf({ providerId: 'gone', modelId: 'x' })).code).toBe('provider_missing')
    expect(await codeOf({ providerId: provider.id, modelId: 'fable' })).toEqual({
      code: 'model_unresolvable',
      message: 'Provider has no mapping for fable',
    })
    expect(await codeOf({ providerId: provider.id, modelId: 'inherit' })).toEqual({
      code: 'model_unresolvable',
      message: 'Choose a concrete model for agent niuma',
    })
    expect((await codeOf({ providerId: provider.id, modelId: 'a b' })).code).toBe('model_unresolvable')
    // A third-party id must not leak into the managed Claude login.
    expect((await codeOf({ providerId: 'claude-official', modelId: 'deepseek-flash' })).code).toBe(
      'model_unresolvable',
    )
  })
})

describe('describeAgentRuntime', () => {
  test('never throws and names the provider when valid', async () => {
    const provider = await addProvider(fullModels)
    const service = new ProviderService()

    expect(await describeAgentRuntime(service, { providerId: provider.id, modelId: 'sonnet' })).toEqual({
      status: 'valid',
      providerName: 'Vendor',
      resolvedModelId: 'v-sonnet',
    })
    expect(await describeAgentRuntime(service, { providerId: 'gone', modelId: 'x' })).toEqual({
      status: 'provider_missing',
    })
    expect(
      (await describeAgentRuntime(service, { providerId: 'claude-official', modelId: 'claude-opus-4-1' })).providerName,
    ).toBe('Claude')
  })
})
