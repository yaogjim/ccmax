import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCcHahaDir,
  getClaudeConfigHomeDir,
  getForkOwnedDir,
  readForkEnv,
  resolveForkOwnedDir,
} from './envUtils.js'

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'CCMAX_LOCAL_INDEX',
  'CC_HAHA_LOCAL_INDEX',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

let tempRoot: string | undefined

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'env-utils-'))
  setEnv('CLAUDE_CONFIG_DIR', join(tempRoot, 'claude-config'))
  setEnv('CCMAX_LOCAL_INDEX', undefined)
  setEnv('CC_HAHA_LOCAL_INDEX', undefined)
})

afterEach(() => {
  restoreEnv()
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

describe('readForkEnv', () => {
  test('prefers CCMAX_* when only CCMAX is set', () => {
    setEnv('CCMAX_LOCAL_INDEX', 'on')
    expect(readForkEnv('LOCAL_INDEX')).toBe('on')
  })

  test('falls back to CC_HAHA_* when only legacy is set', () => {
    setEnv('CC_HAHA_LOCAL_INDEX', 'shadow')
    expect(readForkEnv('LOCAL_INDEX')).toBe('shadow')
  })

  test('prefers CCMAX_* when both are set', () => {
    setEnv('CCMAX_LOCAL_INDEX', 'on')
    setEnv('CC_HAHA_LOCAL_INDEX', 'off')
    expect(readForkEnv('LOCAL_INDEX')).toBe('on')
  })

  test('returns undefined when neither is set', () => {
    expect(readForkEnv('LOCAL_INDEX')).toBeUndefined()
  })
})

describe('getForkOwnedDir / getCcHahaDir', () => {
  test('getForkOwnedDir returns …/ccmax under CLAUDE_CONFIG_DIR', () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    expect(getForkOwnedDir()).toBe(join(configDir, 'ccmax'))
  })

  test('getCcHahaDir still returns …/cc-haha under CLAUDE_CONFIG_DIR', () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    expect(getCcHahaDir()).toBe(join(configDir, 'cc-haha'))
  })

  test('both follow CLAUDE_CONFIG_DIR changes', () => {
    const next = join(tempRoot!, 'other-config')
    setEnv('CLAUDE_CONFIG_DIR', next)
    expect(getClaudeConfigHomeDir()).toBe(next.normalize('NFC'))
    expect(getForkOwnedDir()).toBe(join(next, 'ccmax'))
    expect(getCcHahaDir()).toBe(join(next, 'cc-haha'))
  })
})

describe('resolveForkOwnedDir', () => {
  test('uses ccmax when only the primary directory exists', () => {
    const primary = getForkOwnedDir()
    mkdirSync(primary, { recursive: true })
    expect(resolveForkOwnedDir()).toBe(primary)
  })

  test('falls back to cc-haha when only the legacy directory exists', () => {
    const legacy = getCcHahaDir()
    mkdirSync(legacy, { recursive: true })
    expect(resolveForkOwnedDir()).toBe(legacy)
  })

  test('prefers ccmax when both directories exist', () => {
    const primary = getForkOwnedDir()
    const legacy = getCcHahaDir()
    mkdirSync(primary, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    expect(resolveForkOwnedDir()).toBe(primary)
  })

  test('defaults to ccmax when neither directory exists', () => {
    const primary = getForkOwnedDir()
    expect(resolveForkOwnedDir()).toBe(primary)
  })
})