import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function getUpdateSession() {
  const store = globalThis as Record<string, unknown>
  return store.__macUpdateSession ??= {
    setProxy: vi.fn(async () => {}),
    fetch: vi.fn(),
  }
}

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  session: { fromPartition: () => getUpdateSession() },
}))

describe('macOS replacement download', () => {
  // Electron mock 由 Vitest 隔离；Bun 的全局 mock 会污染其他服务测试。
  it.skipIf('Bun' in globalThis)('downloads the matching zip, verifies bytes and removes a corrupt payload', async () => {
    const { createMacReplaceBackend } = await import('./macReplaceUpdate')
    const root = mkdtempSync(join(tmpdir(), 'ccmax-download-test-'))
    const payload = Buffer.from('synthetic update archive')
    const updateSession = getUpdateSession() as { fetch: ReturnType<typeof vi.fn>, setProxy: ReturnType<typeof vi.fn> }
    const backend = createMacReplaceBackend({ bundlePath: join(root, 'ccmax.app'), arch: 'arm64', cacheDir: root, logPath: join(root, 'update.log') })
    const asset = { url: 'https://example.com/ccmax-arm64.zip', sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length }
    try {
      updateSession.fetch.mockImplementation(async () => new Response(payload))
      const progress: unknown[] = []
      const result = await backend.download({ files: [asset], proxy: 'http://127.0.0.1:7890', onProgress: value => progress.push(value) })
      expect(readFileSync(result.path)).toEqual(payload)
      expect(updateSession.fetch).toHaveBeenCalledWith(asset.url)
      expect(updateSession.setProxy).toHaveBeenCalledWith({ proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '<local>' })
      expect(progress.at(-1)).toEqual({ transferred: payload.length, total: payload.length })

      await expect(backend.download({ files: [{ ...asset, sha512: 'wrong' }], onProgress: () => {} })).rejects.toThrow('sha512')
      expect(existsSync(result.path)).toBe(false)
      await expect(backend.download({ files: [{ url: asset.url }], onProgress: () => {} })).rejects.toThrow('sha512')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
