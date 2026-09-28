import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  SELF_SIGNED_DEVELOPMENT_IDENTITY,
  SIDECAR_SIGNING_IDENTIFIER,
  codesignTimestampArgument,
  resolveStableSigningIdentity,
} from './sign-identity'

/** Realistic `security find-identity -v -p codesigning` output. */
const BOTH_IDENTITIES = `  1) 6AB17527A9E2AEB0C596F8D9F7728D215A5C0E57 "Apple Development: dev@example.com (F8ZSJJ78S7)"
  2) 5145958D6E31AD0CD6BBACD804A0B357E3CEDEA7 "Developer ID Application: Example Co., Ltd (D3RS24869F)"
     2 valid identities found`

describe('resolveStableSigningIdentity', () => {
  it('prefers Developer ID even when Apple Development is listed first', () => {
    // TCC grants are keyed to the signing identity. Apple Development certs
    // expire in about a year, and the replacement silently drops the user's
    // Accessibility + Screen Recording grants — so listing order must not
    // decide this.
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES)).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
  })

  it('falls back to Apple Development when no Developer ID exists', () => {
    const onlyDev = `  1) 6AB17527A9E2AEB0C596F8D9F7728D215A5C0E57 "Apple Development: dev@example.com (F8ZSJJ78S7)"
     1 valid identities found`
    expect(resolveStableSigningIdentity(onlyDev)).toBe(
      'Apple Development: dev@example.com (F8ZSJJ78S7)',
    )
  })

  it('returns null when the keychain has no code-signing identity', () => {
    expect(resolveStableSigningIdentity('     0 valid identities found')).toBeNull()
    expect(resolveStableSigningIdentity('')).toBeNull()
  })

  it('honours an explicit override verbatim, ahead of auto-detection', () => {
    // The override is how CI pins a specific cert, and how build-macos-arm64.sh
    // hands the SAME identity to the sidecar and the helper.
    expect(
      resolveStableSigningIdentity(BOTH_IDENTITIES, 'Developer ID Application: Other (AAAAAAAAAA)'),
    ).toBe('Developer ID Application: Other (AAAAAAAAAA)')
  })

  it('resolves a SHA-1 override to its Developer ID common name', () => {
    expect(
      resolveStableSigningIdentity(
        BOTH_IDENTITIES,
        '5145958D6E31AD0CD6BBACD804A0B357E3CEDEA7',
      ),
    ).toBe('Developer ID Application: Example Co., Ltd (D3RS24869F)')
  })

  it('ignores a blank override rather than treating it as "no identity"', () => {
    // An unset env var arrives as '' or a stray space; that must not suppress
    // auto-detection and silently produce an ad-hoc build.
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, '')).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, '   ')).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, null)).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
  })

  it('recognizes the local self-signed development certificate', () => {
    // A machine with no Apple account has no Developer ID and no Apple
    // Development cert, but it can still create the one-time self-signed
    // `cu-helper-dev` cert that native/cu-helper/build.sh already supports.
    // Returning null here produced an ad-hoc build, which cannot satisfy the
    // helper's attestation and silently disables Computer Use.
    const selfSigned = `  1) 1111111111111111111111111111111111111111 "cu-helper-dev"
     1 valid identities found`
    expect(resolveStableSigningIdentity(selfSigned)).toBe('cu-helper-dev')
  })

  it('prefers a real Apple certificate over the self-signed development one', () => {
    // The local fallback must never outrank a distributable identity, or a
    // release machine that happens to also carry `cu-helper-dev` would ship
    // unnotarizable binaries.
    const both = [
      '  1) 1111111111111111111111111111111111111111 "cu-helper-dev"',
      '  2) 5145958D6E31AD0CD6BBACD804A0B357E3CEDEA7 "Developer ID Application: Example Co., Ltd (D3RS24869F)"',
      '     2 valid identities found',
    ].join('\n')
    expect(resolveStableSigningIdentity(both)).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
  })

  it('does not treat an arbitrary self-signed certificate name as the local cert', () => {
    // Only the exact well-known name is accepted; a lookalike must not be
    // picked up, because the name is the only thing distinguishing the shared
    // build identity from someone's unrelated scratch certificate.
    const lookalike = `  1) 3333333333333333333333333333333333333333 "cu-helper-dev-v2"
     1 valid identities found`
    expect(resolveStableSigningIdentity(lookalike)).toBeNull()
  })

  it('does not mistake certificate names for the quoted-name column', () => {
    // Defensive: a cert whose name merely contains a quote-like fragment must
    // not shift which text is treated as the identity.
    const odd = `  1) 2222222222222222222222222222222222222222 "Developer ID Application: A "B" Co (TEAMID1234)"
     1 valid identities found`
    expect(resolveStableSigningIdentity(odd)).toBe(
      'Developer ID Application: A "B" Co (TEAMID1234)',
    )
  })
})

describe('SIDECAR_SIGNING_IDENTIFIER', () => {
  it('matches the identifier ClientAttestation.swift compares against', () => {
    // These two constants are a cross-language contract with no compiler to
    // enforce it: ClientAttestation.swift:26 and cuHelperInstall.ts:46 both
    // hard-code this exact string, and the helper rejects every Computer Use
    // call when the sidecar's real identifier differs.
    expect(SIDECAR_SIGNING_IDENTIFIER).toBe('com.claude-code-haha.desktop.sidecar')
  })
})

describe('macOS build script signing fallback', () => {
  it('continues through missing Apple identities under pipefail to find the self-signed cert', () => {
    // This failed in the real build before sidecars started: grep returned 1
    // for absent Developer ID and `set -euo pipefail` aborted the script.
    const source = readFileSync('scripts/build-macos-arm64.sh', 'utf8')
    const begin = source.indexOf('SELF_SIGNED_NAME="cu-helper-dev"')
    const end = source.indexOf('\nif [[ "${SIGN_BUILD_EFFECTIVE}" == "0"', begin)
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)
    const snippet = source.slice(begin, end)
    const script = `set -euo pipefail
SIGN_BUILD_EFFECTIVE=""
RESOLVED_SIGN_IDENTITY=""
security() { printf '  1) 1111111111111111111111111111111111111111 "cu-helper-dev"\\n     1 valid identities found\\n'; }
${snippet}
printf '%s' "$RESOLVED_SIGN_IDENTITY"
`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('cu-helper-dev')
  })

  it('fails closed instead of silently producing an unusable ad-hoc build when no cert exists', () => {
    const source = readFileSync('scripts/build-macos-arm64.sh', 'utf8')
    const begin = source.indexOf('SELF_SIGNED_NAME="cu-helper-dev"')
    const end = source.indexOf('\necho "[build-macos-arm64] Building sidecars', begin)
    expect(end).toBeGreaterThan(begin)
    const script = `set -euo pipefail
SIGN_BUILD_EFFECTIVE=""
RESOLVED_SIGN_IDENTITY=""
security() { printf '     0 valid identities found\\n'; }
${source.slice(begin, end)}
`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing an incomplete Computer Use build')
  })
})

describe('codesignTimestampArgument', () => {
  it('requires a secure timestamp for Developer ID distribution', () => {
    expect(codesignTimestampArgument('Developer ID Application: Example (TEAMID1234)'))
      .toBe('--timestamp')
  })

  it('keeps local development and ad-hoc signing offline', () => {
    expect(codesignTimestampArgument('Apple Development: Example (TEAMID1234)'))
      .toBe('--timestamp=none')
    expect(codesignTimestampArgument(SELF_SIGNED_DEVELOPMENT_IDENTITY))
      .toBe('--timestamp=none')
    expect(codesignTimestampArgument(null)).toBe('--timestamp=none')
  })
})
