import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import {
  captureNewTranscriptMessages,
  rememberHydratedMessages,
} from './replTranscriptBinding.js'

const oldScope = { version: 1, teamName: 'old-team', generation: 1 }
const newScope = { version: 1, teamName: 'new-team', generation: 2 }

function message(uuid: string, extra: Record<string, unknown> = {}): Message {
  return {
    uuid,
    type: 'user',
    message: { role: 'user', content: uuid },
    ...extra,
  } as unknown as Message
}

function hasOwnScope(value: object): boolean {
  return Object.hasOwn(value, 'consumerScope')
}

describe('synchronous transcript append capture', () => {
  test('captures only newly appended messages with the scope at append time', () => {
    const history = message('history')
    const known = new WeakSet<object>([history])
    const assistant = message('assistant')

    captureNewTranscriptMessages(known, [history, assistant], newScope)

    // Pre-existing history is not retro-attributed, even when it lacks a field.
    expect(hasOwnScope(history)).toBe(false)
    expect((assistant as { consumerScope?: unknown }).consumerScope).toEqual(
      newScope,
    )
  })

  test('uses the current scope per append, keeping already captured messages', () => {
    const known = new WeakSet<object>()
    const first = message('first')
    const second = message('second')

    captureNewTranscriptMessages(known, [first], oldScope)
    // A trusted TeamCreate later in the turn changes the current binding.
    captureNewTranscriptMessages(known, [first, second], newScope)

    expect((first as { consumerScope?: unknown }).consumerScope).toEqual(
      oldScope,
    )
    expect((second as { consumerScope?: unknown }).consumerScope).toEqual(
      newScope,
    )
  })

  test('never overwrites an existing binding, including an own undefined', () => {
    const known = new WeakSet<object>()
    const bound = message('bound', { consumerScope: oldScope })
    const unbound = message('unbound', { consumerScope: undefined })

    captureNewTranscriptMessages(known, [bound, unbound], newScope)

    expect((bound as { consumerScope?: unknown }).consumerScope).toEqual(
      oldScope,
    )
    expect(hasOwnScope(unbound)).toBe(true)
    expect((unbound as { consumerScope?: unknown }).consumerScope).toBeUndefined()
  })

  test('hydration registers restored messages without capturing them', () => {
    const known = new WeakSet<object>()
    const restored = message('restored')

    rememberHydratedMessages(known, [restored])
    // A later append must not retro-attach the restored message either.
    const assistant = message('assistant')
    captureNewTranscriptMessages(known, [restored, assistant], newScope)

    expect(hasOwnScope(restored)).toBe(false)
    expect((assistant as { consumerScope?: unknown }).consumerScope).toEqual(
      newScope,
    )
  })
})
