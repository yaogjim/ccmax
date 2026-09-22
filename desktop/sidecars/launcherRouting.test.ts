import { describe, expect, it } from 'vitest'

import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

describe('resolveSidecarInvocation', () => {
  it('keeps explicit sidecar modes unchanged', () => {
    expect(
      resolveSidecarInvocation(
        ['server', '--host', '127.0.0.1'],
        '/tmp/claude-sidecar',
        null,
      ),
    ).toEqual({
      mode: 'server',
      restArgs: ['--host', '127.0.0.1'],
      defaultAppRoot: null,
    })
  })

  it('defaults ccmax invocations to cli mode with app root from exec dir', () => {
    expect(
      resolveSidecarInvocation(
        ['plugin', 'install', 'demo'],
        '/Users/demo/.local/bin/ccmax',
        null,
      ),
    ).toEqual({
      mode: 'cli',
      restArgs: ['plugin', 'install', 'demo'],
      defaultAppRoot: '/Users/demo/.local/bin',
    })
  })

  it('defaults legacy claude-haha invocations to the same cli mode', () => {
    expect(
      resolveSidecarInvocation(
        ['plugin', 'install', 'demo'],
        '/Users/demo/.local/bin/claude-haha',
        null,
      ),
    ).toEqual({
      mode: 'cli',
      restArgs: ['plugin', 'install', 'demo'],
      defaultAppRoot: '/Users/demo/.local/bin',
    })
  })

  it('accepts Windows executable names for both primary and legacy commands', () => {
    for (const execPath of [
      'ccmax.exe',
      'claude-haha.exe',
      'C:\\Users\\demo\\.local\\bin\\ccmax.exe',
      'C:\\Users\\demo\\.local\\bin\\claude-haha.exe',
    ]) {
      const result = resolveSidecarInvocation(['mcp', 'list'], execPath, null)
      expect(result.mode).toBe('cli')
      expect(result.restArgs).toEqual(['mcp', 'list'])
    }
  })

  it('does not mis-route unknown executable names into cli mode', () => {
    expect(
      resolveSidecarInvocation(
        ['plugin', 'install', 'demo'],
        '/Users/demo/.local/bin/something-else',
        null,
      ),
    ).toEqual({
      mode: null,
      restArgs: ['plugin', 'install', 'demo'],
      defaultAppRoot: null,
    })
  })
})

describe('parseLauncherArgs', () => {
  it('falls back to the provided default app root', () => {
    expect(
      parseLauncherArgs(['plugin', 'install', 'demo'], '/Users/demo/.local/bin'),
    ).toEqual({
      appRoot: '/Users/demo/.local/bin',
      args: ['plugin', 'install', 'demo'],
    })
  })

  it('lets explicit app root override the default', () => {
    expect(
      parseLauncherArgs(
        ['--app-root', '/tmp/app', 'plugin', 'install', 'demo'],
        '/Users/demo/.local/bin',
      ),
    ).toEqual({
      appRoot: '/tmp/app',
      args: ['plugin', 'install', 'demo'],
    })
  })
})