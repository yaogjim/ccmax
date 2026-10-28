import type { Message } from '../types/message.js'
import { captureTranscriptBinding } from '../utils/sessionStorage.js'

/**
 * Captures the consumer binding for messages that are newly admitted to the
 * transcript at a synchronous append point.
 *
 * `known` holds the objects already present (initial history or a hydrate that
 * registered them). Only objects not in it are captured, so:
 * - a wholesale restore/fork load is never retro-attributed (register it with
 *   `rememberHydratedMessages` instead),
 * - reused tail messages keep their existing binding,
 * - `captureTranscriptBinding` itself leaves any message that already owns a
 *   `consumerScope` field untouched, including an explicit `undefined`.
 */
export function captureNewTranscriptMessages(
  known: WeakSet<object>,
  next: readonly Message[],
  consumerScope: unknown,
): void {
  const fresh: Message[] = []
  for (const message of next) {
    if (!known.has(message)) {
      known.add(message)
      fresh.push(message)
    }
  }
  if (fresh.length > 0) captureTranscriptBinding(fresh, consumerScope)
}

/** Registers a hydrated/restored array without capturing any binding. */
export function rememberHydratedMessages(
  known: WeakSet<object>,
  messages: readonly Message[],
): void {
  for (const message of messages) known.add(message)
}
