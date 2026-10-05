import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { adaptersApi } from './adapters'

describe('adaptersApi telegram public', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves nested public editable fields without owner, pairing, or generation', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({})
    const patch = {
      telegram: {
        public: {
          enabled: true,
          botToken: '****oken',
        },
      },
    }

    await adaptersApi.updateConfig(patch)

    expect(put).toHaveBeenCalledWith('/api/adapters', patch)
    expect(JSON.stringify(put.mock.calls[0]?.[1])).not.toContain('ownerUserId')
    expect(JSON.stringify(put.mock.calls[0]?.[1])).not.toContain('generation')
    expect(JSON.stringify(put.mock.calls[0]?.[1])).not.toMatch(/"pairing"/)
  })

  it('generates public pairing on the public endpoint, not the legacy pairing field', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      code: 'ABC234',
      expiresAt: 1,
      createdAt: 1,
    })
    const put = vi.spyOn(api, 'put').mockResolvedValue({})

    await adaptersApi.generateTelegramPublicPairing()

    expect(post).toHaveBeenCalledWith('/api/adapters/telegram/public/pairing', {})
    expect(put).not.toHaveBeenCalled()
    expect(post.mock.calls.some(([path]) => path === '/api/adapters' || path.includes('/pairing/claim'))).toBe(false)
  })

  it('resets the public operator on the public pairing path', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ telegram: { public: { enabled: true } } })

    await adaptersApi.resetTelegramPublicPairing()

    expect(del).toHaveBeenCalledWith('/api/adapters/telegram/public/pairing')
  })

  it('loads public runtime status and encodes subscription paths', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ generation: 1, running: false, subscriptions: [], deliveries: [] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ generation: 1, running: false, subscriptions: [], deliveries: [] })
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ generation: 1, running: false, subscriptions: [], deliveries: [] })

    await adaptersApi.getTelegramPublicStatus()
    await adaptersApi.addTelegramPublicSubscription('sess/one')
    await adaptersApi.removeTelegramPublicSubscription('sess/one')

    expect(get).toHaveBeenCalledWith('/api/telegram/public/status')
    expect(post).toHaveBeenCalledWith('/api/telegram/public/subscriptions', { sessionId: 'sess/one' })
    expect(del).toHaveBeenCalledWith('/api/telegram/public/subscriptions/sess%2Fone')
  })
})