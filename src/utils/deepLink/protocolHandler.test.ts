import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const launchInTerminal = mock(
  async (
    _executablePath: string,
    _action: {
      query?: string
      cwd?: string
      repo?: string
      lastFetchMs?: number
    },
  ): Promise<boolean> => true,
)

const terminalLauncherModule = await import('./terminalLauncher.js')

mock.module('./terminalLauncher.js', () => ({
  ...terminalLauncherModule,
  launchInTerminal,
}))

const { handleDeepLinkUri } = await import('./protocolHandler.js')

const ACTION_URI_SUFFIX = 'open?q=fix+tests&cwd=/tmp/ccmax-deep-link'

beforeEach(() => {
  launchInTerminal.mockClear()
  launchInTerminal.mockImplementation(async () => true)
})

afterAll(() => {
  mock.restore()
})

describe('handleDeepLinkUri', () => {
  test('launches the same terminal arguments for ccmax:// and claude-cli://', async () => {
    const primary = await handleDeepLinkUri(`ccmax://${ACTION_URI_SUFFIX}`)
    const legacy = await handleDeepLinkUri(`claude-cli://${ACTION_URI_SUFFIX}`)

    expect(primary).toBe(0)
    expect(legacy).toBe(0)
    expect(launchInTerminal).toHaveBeenCalledTimes(2)

    const [firstPath, firstAction] = launchInTerminal.mock.calls[0] ?? []
    const [secondPath, secondAction] = launchInTerminal.mock.calls[1] ?? []
    expect(firstPath).toBe(process.execPath)
    expect(secondPath).toBe(process.execPath)
    expect(firstAction).toEqual({
      query: 'fix tests',
      cwd: '/tmp/ccmax-deep-link',
      repo: undefined,
      lastFetchMs: undefined,
    })
    expect(secondAction).toEqual(firstAction)
  })

  test('rejects an unknown action before launching a terminal', async () => {
    const exitCode = await handleDeepLinkUri('ccmax://not-open?q=hello')

    expect(exitCode).toBe(1)
    expect(launchInTerminal).not.toHaveBeenCalled()
  })
})
