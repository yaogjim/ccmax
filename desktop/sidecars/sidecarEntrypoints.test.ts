import { describe, expect, it, vi } from 'vitest'

import { runCli } from './sidecarEntrypoints'

describe('runCli', () => {
  it('loads the CLI entrypoint before calling its main function', async () => {
    const main = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const loadCli = vi.fn(async () => ({ main }))

    await runCli(loadCli)

    expect(loadCli).toHaveBeenCalledOnce()
    expect(main).toHaveBeenCalledOnce()
  })
})
