/**
 * Deterministic fake TranscriptionProvider for tests. Never performs IO.
 *
 * Scripted per call: hand it results in `plan` and it returns them in
 * order (the last entry repeats once the plan is exhausted). Also records
 * every input so tests can assert what the pipeline forwarded.
 *
 * A plan entry may set `waitForAbort: true` to simulate a provider that
 * only settles when its `signal` aborts — the deterministic stand-in for a
 * cancelled child process.
 */

import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from './types.js'

export interface FakeTranscriberPlanEntry {
  supportedMimes?: string[]          // undefined → support everything
  result: TranscriptionResult
  /** Resolve as `cancelled` when `input.signal` aborts (never resolves otherwise). */
  waitForAbort?: boolean
}

export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'fake'
  readonly calls: TranscriptionInput[] = []

  constructor(private readonly plan: FakeTranscriberPlanEntry[] = []) {}

  supported(mimeType: string): boolean {
    const entry = this.plan[0]
    if (!entry) return true
    if (!entry.supportedMimes) return true
    return entry.supportedMimes.includes(mimeType)
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    this.calls.push(input)
    const entry = this.plan.shift()
    if (!entry) {
      return { ok: false, reason: 'provider_error', detail: 'fake plan exhausted' }
    }
    if (entry.waitForAbort) {
      const signal = input.signal
      if (!signal) return { ok: false, reason: 'cancelled', detail: 'no signal to wait on' }
      if (signal.aborted) return { ok: false, reason: 'cancelled', detail: 'already aborted' }
      return new Promise<TranscriptionResult>((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve({ ok: false, reason: 'cancelled', detail: 'aborted' }),
          { once: true },
        )
      })
    }
    return entry.result
  }
}