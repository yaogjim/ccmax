/**
 * Swarm Initialization Hook
 *
 * Initializes swarm features: teammate hooks and context.
 * Handles both fresh spawns and resumed teammate sessions.
 *
 * This hook is conditionally loaded to allow dead code elimination when swarms are disabled.
 */

import { useEffect } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { restoreTranscriptConsumerScope } from '../utils/swarm/reconnection.js'
import { initializeTeammateHooks } from '../utils/swarm/teammateInit.js'
import { logError } from '../utils/log.js'
import { getDynamicTeamContext } from '../utils/teammate.js'

type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * Hook that initializes swarm features when ENABLE_AGENT_SWARMS is true.
 *
 * Handles both:
 * - Resumed teammate sessions (from --resume or /resume) where teamName/agentName
 *   are stored in transcript messages
 * - Fresh spawns where context is read from environment variables
 */
export function useSwarmInitialization(
  setAppState: SetAppState,
  initialMessages: Message[] | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) return
    if (!isAgentSwarmsEnabled()) return
    const issuedScope = process.env.CC_HAHA_TEAM_CONSUMER_SCOPE
    delete process.env.CC_HAHA_TEAM_CONSUMER_SCOPE
    // Session restoration owns transcript binding (and fork refusal). Never
    // reinterpret names or source messages here after it has made that decision.
    const rawScope = issuedScope ?? getDynamicTeamContext()?.consumerScope
    let cancelled = false
    void (async () => {
      const result = await restoreTranscriptConsumerScope([{ consumerScope: rawScope }], getSessionId(), teamContext => {
        if (!cancelled) setAppState(prev => ({ ...prev, teamContext }))
      })
      if (cancelled || result.status !== 'current') return
      const context = getDynamicTeamContext()
      if (context?.agentId && context.agentName) {
        await initializeTeammateHooks(setAppState, getSessionId(), {
          teamName: context.teamName, agentId: context.agentId, agentName: context.agentName,
          consumerScope: context.consumerScope,
        })
      }
    })().catch(logError)
    return () => { cancelled = true }
  }, [setAppState, initialMessages, enabled])
}
