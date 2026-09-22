import { describe, expect, test } from 'bun:test'
import {
  buildDeepLink,
  DEEP_LINK_PROTOCOL,
  LEGACY_DEEP_LINK_PROTOCOL,
  parseDeepLink,
} from './parseDeepLink.js'

const SAME_ACTION = {
  query: 'fix tests',
  cwd: '/tmp/project',
  repo: 'owner/repo',
} as const

describe('parseDeepLink', () => {
  test('accepts primary ccmax://open and legacy claude-cli://open with the same action', () => {
    const primary = parseDeepLink(
      'ccmax://open?q=fix+tests&cwd=/tmp/project&repo=owner/repo',
    )
    const legacy = parseDeepLink(
      'claude-cli://open?q=fix+tests&cwd=/tmp/project&repo=owner/repo',
    )

    expect(primary).toEqual(SAME_ACTION)
    expect(legacy).toEqual(SAME_ACTION)
  })

  test('accepts scheme forms without a double-slash separator', () => {
    expect(parseDeepLink('ccmax:open?q=hello')).toEqual({ query: 'hello' })
    expect(parseDeepLink('claude-cli:open?q=hello')).toEqual({ query: 'hello' })
  })

  test('rejects unknown schemes including upstream claude:// and cc://', () => {
    for (const uri of [
      'claude://open',
      'claude-dev://open',
      'cc://open',
      'cc+unix://open',
      'cc-haha://open',
      'https://example.com/open',
      'not-a-uri',
    ]) {
      expect(() => parseDeepLink(uri)).toThrow(/expected ccmax:\/\/ or claude-cli:\/\//)
    }
  })

  test('rejects an unknown host/action on both supported schemes', () => {
    expect(() => parseDeepLink('ccmax://prompt?q=hello')).toThrow(
      /Unknown deep link action/,
    )
    expect(() => parseDeepLink('claude-cli://unknown')).toThrow(
      /Unknown deep link action/,
    )
  })

  test('rejects relative cwd and control characters', () => {
    expect(() => parseDeepLink('ccmax://open?cwd=relative/path')).toThrow(
      /absolute path/,
    )
    expect(() => parseDeepLink('ccmax://open?cwd=/tmp/%0aproject')).toThrow(
      /control characters/,
    )
    expect(() => parseDeepLink('ccmax://open?q=hello%0aworld')).toThrow(
      /control characters/,
    )
  })

  test('rejects oversized query/cwd and invalid repo slugs', () => {
    expect(() =>
      parseDeepLink(`ccmax://open?q=${'a'.repeat(5001)}`),
    ).toThrow(/exceeds 5000 characters/)
    expect(() =>
      parseDeepLink(`ccmax://open?cwd=/${'a'.repeat(4096)}`),
    ).toThrow(/exceeds 4096 characters/)
    expect(() => parseDeepLink('ccmax://open?repo=../etc/passwd')).toThrow(
      /owner\/repo/,
    )
    expect(() => parseDeepLink('ccmax://open?repo=owner')).toThrow(/owner\/repo/)
  })

  test('accepts a Windows absolute cwd and treats a blank query as absent', () => {
    expect(parseDeepLink('ccmax://open?cwd=C:/Users/me/project')).toEqual({
      cwd: 'C:/Users/me/project',
    })
    expect(parseDeepLink('ccmax://open?q=+++')).toEqual({})
  })
})

describe('buildDeepLink', () => {
  test('generates only the primary ccmax://open URL', () => {
    const uri = buildDeepLink(SAME_ACTION)

    expect(uri.startsWith('ccmax://open')).toBe(true)
    expect(uri).toContain('q=fix+tests')
    expect(uri).toContain('cwd=%2Ftmp%2Fproject')
    expect(uri).toContain('repo=owner%2Frepo')
    expect(uri).not.toContain('claude-cli')
    expect(DEEP_LINK_PROTOCOL).toBe('ccmax')
    expect(LEGACY_DEEP_LINK_PROTOCOL).toBe('claude-cli')
    expect(parseDeepLink(uri)).toEqual(SAME_ACTION)
  })
})
