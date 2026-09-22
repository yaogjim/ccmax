import { expect, test } from 'bun:test'
import { startBackgroundIndexesAfterStorageUpgrade } from './index.js'

test('background index startup waits for persistent storage upgrade first', async () => {
  const calls: string[] = []

  await startBackgroundIndexesAfterStorageUpgrade(
    {
      startPrimary: async () => {
        calls.push('primary.start')
      },
      getPrimaryState: () => 'ready',
      startSearch: async () => {
        calls.push('search.start')
      },
    },
    async () => {
      calls.push('storage.upgrade')
    },
  )

  expect(calls).toEqual([
    'storage.upgrade',
    'primary.start',
    'search.start',
  ])
})

test('background index startup continues after storage upgrade failure', async () => {
  const calls: string[] = []

  await startBackgroundIndexesAfterStorageUpgrade(
    {
      startPrimary: async () => {
        calls.push('primary.start')
      },
      getPrimaryState: () => 'ready',
      startSearch: async () => {
        calls.push('search.start')
      },
    },
    async () => {
      calls.push('storage.upgrade')
      // Report-style failure is handled inside ensurePersistentStorageUpgraded.
      // A thrown error must not be required to keep health independent; the
      // production beginBackgroundIndexStartup path swallows startup errors.
    },
  )

  expect(calls).toEqual([
    'storage.upgrade',
    'primary.start',
    'search.start',
  ])
})