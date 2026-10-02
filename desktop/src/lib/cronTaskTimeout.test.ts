import { describe, expect, it } from 'vitest'

import {
  CRON_TASK_TIMEOUT_DEFAULT_MS,
  CRON_TASK_TIMEOUT_MAX_MS,
  formatCronTaskTimeoutSeconds,
  isValidCronTaskTimeoutMs,
  parseCronTaskTimeoutSeconds,
} from './cronTaskTimeout'

describe('cronTaskTimeout', () => {
  it('pins the built-in default at the server contract value', () => {
    expect(CRON_TASK_TIMEOUT_DEFAULT_MS).toBe(600_000)
  })

  describe('isValidCronTaskTimeoutMs', () => {
    it.each([1, 500, 600_000, CRON_TASK_TIMEOUT_MAX_MS])('accepts %i', (ms) => {
      expect(isValidCronTaskTimeoutMs(ms)).toBe(true)
    })

    it.each([0, -1, 1.5, CRON_TASK_TIMEOUT_MAX_MS + 1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects %s',
      (ms) => {
        expect(isValidCronTaskTimeoutMs(ms)).toBe(false)
      },
    )
  })

  describe('parseCronTaskTimeoutSeconds', () => {
    it('treats a blank field as no explicit value', () => {
      expect(parseCronTaskTimeoutSeconds('')).toEqual({ kind: 'empty' })
      expect(parseCronTaskTimeoutSeconds('   ')).toEqual({ kind: 'empty' })
    })

    it('converts whole seconds to milliseconds', () => {
      // The default has to round-trip: the hint advertises 600s.
      expect(parseCronTaskTimeoutSeconds('600')).toEqual({ kind: 'valid', ms: 600_000 })
    })

    it('accepts fractional seconds that are whole milliseconds', () => {
      expect(parseCronTaskTimeoutSeconds('1.5')).toEqual({ kind: 'valid', ms: 1500 })
      expect(parseCronTaskTimeoutSeconds('0.001')).toEqual({ kind: 'valid', ms: 1 })
    })

    it.each(['0', '-5', 'abc', 'Infinity', 'NaN'])('blocks %s as invalid', (input) => {
      expect(parseCronTaskTimeoutSeconds(input).kind).toBe('invalid')
    })

    it('rejects non-decimal numeric forms instead of reading their radix', () => {
      // `Number('0x1F')` is 31 and `Number('1e3')` is 1000, so a bare `Number()`
      // silently accepted literals the seconds field never intends to hold.
      for (const input of ['0x1F', '0X10', '0b101', '0o17', '1e3', '1E3', '.']) {
        expect(parseCronTaskTimeoutSeconds(input).kind).toBe('invalid')
      }
    })

    it('still accepts a leading-dot decimal', () => {
      expect(parseCronTaskTimeoutSeconds('.5')).toEqual({ kind: 'valid', ms: 500 })
    })

    it('blocks values above the millisecond ceiling', () => {
      // 2_147_483.648s is one millisecond past the accepted maximum.
      expect(parseCronTaskTimeoutSeconds('2147483.648')).toEqual({ kind: 'invalid' })
      expect(parseCronTaskTimeoutSeconds('999999999')).toEqual({ kind: 'invalid' })
    })

    it('blocks sub-millisecond precision instead of rounding it', () => {
      // 0.0005s is half a millisecond; silently rounding to 1ms would store a
      // value the user never typed.
      expect(parseCronTaskTimeoutSeconds('0.0005')).toEqual({ kind: 'invalid' })
    })
  })

  describe('formatCronTaskTimeoutSeconds', () => {
    it('renders a stored value back into the seconds field', () => {
      expect(formatCronTaskTimeoutSeconds(90_000)).toBe('90')
      expect(formatCronTaskTimeoutSeconds(1500)).toBe('1.5')
    })

    it('renders an absent value as an empty field', () => {
      expect(formatCronTaskTimeoutSeconds(null)).toBe('')
      expect(formatCronTaskTimeoutSeconds(undefined)).toBe('')
    })
  })
})