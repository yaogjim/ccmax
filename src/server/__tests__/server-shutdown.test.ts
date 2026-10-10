import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startBackgroundIndexesInPriorityOrder,
  stopServerRuntimeForShutdown,
} from '../index.js'
import { conversationService } from '../services/conversationService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { teamWatcher } from '../services/teamWatcher.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'
import { searchContentCoordinator } from '../services/localIndex/searchContentCoordinator.js'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * `process.exit()` never waits for promises, and `stopServerRuntimeForShutdown`
 * stops the indexes before it reaches the CLI kill, so the `exit` handler used
 * to orphan every running CLI subprocess. Reproduced with a real child process:
 * a dummy CLI child is registered as an active session, the parent exits, and
 * the child must not survive it.
 */
test('process exit kills active CLI subprocesses instead of orphaning them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmax-exit-cleanup-'))
  const heartbeat = join(root, 'heartbeat.txt')
  const indexPath = fileURLToPath(new URL('../index.ts', import.meta.url))
  const servicePath = fileURLToPath(new URL('../services/conversationService.ts', import.meta.url))
  const script = [
    `const { spawn } = await import('node:child_process')`,
    `const { appendFileSync, existsSync } = await import('node:fs')`,
    `const { conversationService } = await import(${JSON.stringify(servicePath)})`,
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
      `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 50)`,
    )}], { stdio: 'ignore' })`,
    `const deadline = Date.now() + 5_000`,
    `while (!existsSync(${JSON.stringify(heartbeat)}) \u0026\u0026 Date.now() \u003c deadline) {`,
    `  await new Promise(resolve => setTimeout(resolve, 20))`,
    `}`,
    `conversationService.sessions.set('exit-cleanup-session', {`,
    `  sessionId: 'exit-cleanup-session',`,
    `  proc: child,`,
    `  pendingPermissionRequests: new Map(),`,
    `  pendingControlRequests: new Map(),`,
    `  teamWorker: false,`,
    `})`,
    `await import(${JSON.stringify(indexPath)})`,
    `console.log('CHILD_PID ' + child.pid)`,
    `process.exit(0)`,
  ].join('\n')

  let childPid = 0
  try {
    const host = Bun.spawn([process.execPath, '-e', script], {
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [output, errors, exitCode] = await Promise.all([
      new Response(host.stdout).text(),
      new Response(host.stderr).text(),
      host.exited,
    ])
    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' })

    childPid = Number(/CHILD_PID (\d+)/.exec(output)?.[1])
    expect(childPid).toBeGreaterThan(0)
    // The dummy CLI was running when the parent exited.
    expect(statSync(heartbeat).size).toBeGreaterThan(0)

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && isProcessAlive(childPid)) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(isProcessAlive(childPid)).toBe(false)

    // And it is really gone, not merely paused.
    const frozenSize = statSync(heartbeat).size
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(statSync(heartbeat).size).toBe(frozenSize)
  } finally {
    if (childPid > 0 && isProcessAlive(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test('server shutdown stops background schedulers before waiting for CLI sessions', async () => {
  const calls: string[] = []
  const originalTeamStop = teamWatcher.stop.bind(teamWatcher)
  const originalCronStop = cronScheduler.stop.bind(cronScheduler)
  const originalGetActiveSessions = conversationService.getActiveSessions.bind(conversationService)
  const originalStopAllSessionsAndWait = conversationService.stopAllSessionsAndWait.bind(conversationService)
  const originalLocalIndexStop = localIndexCoordinator.stop.bind(localIndexCoordinator)
  const originalSearchContentStop = searchContentCoordinator.stop.bind(searchContentCoordinator)

  try {
    teamWatcher.stop = (() => {
      calls.push('teamWatcher.stop')
    }) as typeof teamWatcher.stop
    cronScheduler.stop = (() => {
      calls.push('cronScheduler.stop')
    }) as typeof cronScheduler.stop
    conversationService.getActiveSessions = (() => ['active-session']) as typeof conversationService.getActiveSessions
    conversationService.stopAllSessionsAndWait = (async () => {
      calls.push('conversationService.stopAllSessionsAndWait')
    }) as typeof conversationService.stopAllSessionsAndWait
    localIndexCoordinator.stop = (async () => {
      calls.push('localIndexCoordinator.stop')
    }) as typeof localIndexCoordinator.stop
    searchContentCoordinator.stop = (async () => {
      calls.push('searchContentCoordinator.stop')
    }) as typeof searchContentCoordinator.stop

    await stopServerRuntimeForShutdown({ waitForCli: true })

    expect(calls).toEqual([
      'teamWatcher.stop',
      'cronScheduler.stop',
      'localIndexCoordinator.stop',
      'searchContentCoordinator.stop',
      'conversationService.stopAllSessionsAndWait',
    ])
  } finally {
    teamWatcher.stop = originalTeamStop
    cronScheduler.stop = originalCronStop
    conversationService.getActiveSessions = originalGetActiveSessions
    conversationService.stopAllSessionsAndWait = originalStopAllSessionsAndWait
    localIndexCoordinator.stop = originalLocalIndexStop
    searchContentCoordinator.stop = originalSearchContentStop
  }
})

test('cold-start indexing lets the session-list projection settle before search backfill', async () => {
  const calls: string[] = []
  let state = 'building'
  let now = 0

  await startBackgroundIndexesInPriorityOrder({
    startPrimary: async () => {
      calls.push('primary.start')
    },
    getPrimaryState: () => state,
    startSearch: async () => {
      calls.push('search.start')
    },
    wait: async () => {
      calls.push('wait')
      state = 'ready'
      now += 1
    },
    now: () => now,
    maxPrimaryWaitMs: 10,
  })

  expect(calls).toEqual(['primary.start', 'wait', 'search.start'])
})

test('shutdown cancellation prevents a delayed search backfill from starting', async () => {
  const controller = new AbortController()
  let searchStarts = 0

  await startBackgroundIndexesInPriorityOrder({
    startPrimary: async () => {},
    getPrimaryState: () => 'building',
    startSearch: async () => {
      searchStarts += 1
    },
    wait: async () => {
      controller.abort()
    },
    now: () => 0,
    maxPrimaryWaitMs: 10,
    signal: controller.signal,
  })

  expect(searchStarts).toBe(0)
})
