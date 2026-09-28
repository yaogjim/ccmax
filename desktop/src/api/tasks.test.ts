import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from './client'
import { tasksApi } from './tasks'

describe('tasksApi', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('serializes the terminal completion floor with summary pagination', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(tasksApi.getRecentRuns(50, {
      cursor: 'next page',
      summaryOnly: true,
      completedAfterMs: 1_777_766_430_000,
    })).resolves.toEqual({ runs: [] })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/scheduled-tasks/runs?limit=50&cursor=next+page&summaryOnly=true&completedAfterMs=1777766430000',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('reads per-recipient delivery records for one run', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deliveries: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(tasksApi.getRunDeliveries('run-42')).resolves.toEqual({ deliveries: [] })

    // The run id is the path segment the server filters on; a wrong shape here
    // would silently return every run's deliveries.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/scheduled-tasks/runs/run-42/deliveries',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
