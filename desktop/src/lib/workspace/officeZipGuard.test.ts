// @vitest-environment node
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OFFICE_ZIP_LIMITS,
  OfficeZipError,
  inspectOfficeZip,
  type OfficeZipLimits,
} from './officeZipGuard'

/**
 * "It stopped early" is a claim about work, not about time. The two tests that make it used
 * to assert a wall-clock bound, which a busy or coverage-instrumented run fails with nothing
 * wrong — the same walk simply takes ten times as long. So fflate is wrapped here to count the
 * work instead: the bytes the guard inflates, and the directory entries its filter is shown.
 */
const { zipProbe } = vi.hoisted(() => ({
  zipProbe: {
    countingInflation: false,
    inflatedBytes: 0,
    countingFilters: false,
    filteredEntries: 0,
  },
}))

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>()
  class CountingInflate extends actual.Inflate {
    constructor(onData: (chunk: Uint8Array, final: boolean) => void) {
      super((chunk, final) => {
        if (zipProbe.countingInflation) zipProbe.inflatedBytes += chunk.length
        onData(chunk, final)
      })
    }
  }
  return {
    ...actual,
    Inflate: CountingInflate,
    unzipSync: (data: Uint8Array, options?: Parameters<typeof actual.unzipSync>[1]) => {
      const filter = options?.filter
      if (!filter || !zipProbe.countingFilters) return actual.unzipSync(data, options)
      return actual.unzipSync(data, {
        ...options,
        filter: (file) => {
          zipProbe.filteredEntries += 1
          return filter(file)
        },
      })
    },
  }
})

const KIB = 1024
const MIB = 1024 * KIB

/** Limits small enough to break with fixtures that fit in a test. */
const TIGHT: OfficeZipLimits = {
  maxEntries: 4,
  maxEntryBytes: 64 * KIB,
  maxTotalBytes: 128 * KIB,
  ratioFloorBytes: 32 * KIB,
  maxRatio: 50,
}

/** Files of `size` zero bytes: they deflate to almost nothing, like the archives this guards against. */
const zeros = (size: number) => new Uint8Array(size)

function zipOf(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files)
}

function rejection(bytes: Uint8Array, limits: OfficeZipLimits): OfficeZipError {
  try {
    inspectOfficeZip(bytes, limits)
  } catch (error) {
    if (error instanceof OfficeZipError) return error
    throw error
  }
  throw new Error('expected the archive to be refused')
}

/**
 * The bomb the second pass exists for: one 32 MiB entry that deflates to ~32 KiB. Built once
 * here because compressing 32 MiB is pure setup — inside a test body it is heavy enough to
 * count against the per-test timeout of the coverage run rather than the file's collection.
 */
const ZERO_BOMB = zipOf({ 'a.bin': zeros(32 * MIB) })

describe('inspectOfficeZip', () => {
  it('lets an ordinary document through and says what it found', () => {
    const docx = zipOf({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8('<w:document>'.repeat(20)),
      'word/media/image1.png': new Uint8Array(4 * KIB).map((_, index) => (index * 7) % 251),
    })

    const summary = inspectOfficeZip(docx)

    expect(summary.entries).toBe(3)
    expect(summary.uncompressedBytes).toBe(8 + 12 * 20 + 4 * KIB)
  })

  describe('what is not an archive', () => {
    it.each([
      ['text', strToU8('this is not a zip')],
      ['nothing', new Uint8Array(0)],
      ['a few stray bytes', new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
    ])('refuses %s', (_label, bytes) => {
      expect(rejection(bytes, TIGHT).reason).toBe('not-a-zip')
    })

    it('refuses an archive cut off before its table of contents, which is how a half-written file looks', () => {
      const whole = zipOf({ 'a.xml': strToU8('x'.repeat(2000)), 'b.xml': strToU8('y'.repeat(2000)) })

      expect(rejection(whole.slice(0, Math.floor(whole.length / 2)), DEFAULT_OFFICE_ZIP_LIMITS).reason).toBe('not-a-zip')
    })
  })

  describe('what promises to be enormous', () => {
    it('refuses too many files', () => {
      const many = zipOf(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}.xml`, strToU8('x')])))

      expect(rejection(many, TIGHT).reason).toBe('too-many-entries')
    })

    it('accepts exactly as many files as allowed', () => {
      const exact = zipOf(Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`f${index}.xml`, strToU8('x')])))

      expect(inspectOfficeZip(exact, TIGHT).entries).toBe(4)
    })

    it('refuses one file that inflates past the per-file limit, however small it is compressed', () => {
      const bomb = zipOf({ 'word/media/huge.bmp': zeros(200 * KIB) })
      expect(bomb.length).toBeLessThan(2 * KIB) // the whole point: it looks harmless

      expect(rejection(bomb, TIGHT).reason).toBe('entry-too-large')
    })

    it('refuses many files that are each fine but together are not', () => {
      const together = zipOf({ 'a.bin': zeros(60 * KIB), 'b.bin': zeros(60 * KIB), 'c.bin': zeros(60 * KIB) })

      expect(rejection(together, TIGHT).reason).toBe('too-large')
    })

    it('refuses a large archive that inflates hundreds of times over', () => {
      // Under the per-file and total limits, over the floor, and compressed to nothing.
      const limits: OfficeZipLimits = { ...TIGHT, maxEntryBytes: MIB, maxTotalBytes: 4 * MIB, ratioFloorBytes: 100 * KIB, maxRatio: 20 }
      const squeezed = zipOf({ 'a.bin': zeros(300 * KIB) })

      expect(rejection(squeezed, limits).reason).toBe('suspicious-ratio')
    })

    it('does not mind a small archive that compresses well: a blank bitmap is not an attack', () => {
      const limits: OfficeZipLimits = { ...TIGHT, ratioFloorBytes: 100 * KIB, maxRatio: 20 }
      const smallAndRegular = zipOf({ 'blank.bmp': zeros(50 * KIB) })

      expect(inspectOfficeZip(smallAndRegular, limits).entries).toBe(1)
    })

    it('says which file broke the limit', () => {
      const bomb = zipOf({ 'ok.xml': strToU8('x'), 'word/media/huge.bmp': zeros(200 * KIB) })

      expect(rejection(bomb, TIGHT).message).toContain('word/media/huge.bmp')
    })
  })

  describe('an archive that lies about its sizes', () => {
    /**
     * The same archive with the declared size of every file — or of `only` — rewritten, in the
     * table of contents and the local headers alike.
     */
    function declaring(archive: Uint8Array, size: number, only?: string): Uint8Array {
      const lying = archive.slice()
      const view = new DataView(lying.buffer)
      const nameAt = (start: number, length: number) => new TextDecoder().decode(lying.subarray(start, start + length))
      for (let at = 0; at + 4 <= lying.length; at += 1) {
        const signature = view.getUint32(at, true)
        if (signature === 0x04034b50 && (!only || nameAt(at + 30, view.getUint16(at + 26, true)) === only)) {
          view.setUint32(at + 22, size, true)
        }
        if (signature === 0x02014b50 && (!only || nameAt(at + 46, view.getUint16(at + 28, true)) === only)) {
          view.setUint32(at + 24, size, true)
        }
      }
      return lying
    }

    it('is caught by what its files really inflate to, not by what it says they do', () => {
      // 200 KiB in well under 2 KiB, declared as 100 bytes: within every limit on paper.
      const lying = declaring(zipOf({ 'word/media/huge.bmp': zeros(200 * KIB) }), 100)

      const failure = rejection(lying, TIGHT)

      expect(failure.reason).toBe('entry-too-large')
      expect(failure.message).toContain('word/media/huge.bmp')
    })

    it('is counted across its files: the total is stopped mid-file, not after the file that broke it', () => {
      // The second file says 10 bytes and holds 100 KiB, which would take the total past its limit.
      const limits: OfficeZipLimits = { ...TIGHT, maxEntryBytes: MIB, maxTotalBytes: 150 * KIB, ratioFloorBytes: MIB, maxRatio: 500 }
      const lying = declaring(zipOf({ 'a.bin': zeros(100 * KIB), 'b.bin': zeros(100 * KIB) }), 10, 'b.bin')

      expect(rejection(lying, limits).reason).toBe('too-large')
    })

    it('is refused for a size that is not the one it declares, even when both are within the limits', () => {
      const lying = declaring(zipOf({ 'word/document.xml': strToU8('x'.repeat(2000)) }), 100)

      const failure = rejection(lying, DEFAULT_OFFICE_ZIP_LIMITS)

      expect(failure.reason).toBe('size-mismatch')
      expect(failure.message).toContain('word/document.xml')
    })

    it('is stopped at the limit, not after inflating everything it holds', () => {
      const lying = declaring(ZERO_BOMB, 100)
      const limits: OfficeZipLimits = { ...DEFAULT_OFFICE_ZIP_LIMITS, maxEntryBytes: 256 * KIB }

      zipProbe.countingInflation = true
      zipProbe.inflatedBytes = 0
      try {
        expect(rejection(lying, limits).reason).toBe('entry-too-large')
      } finally {
        zipProbe.countingInflation = false
      }

      // The guard inflates in 16 KiB steps and stops as soon as the output passes the 256 KiB
      // entry limit, so it must not have produced the whole 32 MiB the entry holds. One step of
      // this 1000:1 archive already inflates to ~16 MiB, which is as much as a step can be
      // blamed for: what the assertion rules out is walking the entry to the end.
      expect(zipProbe.inflatedBytes).toBeLessThan(32 * MIB)
    })

    it('does not trouble an honest archive, whatever it holds or how it is stored', () => {
      const files = {
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8('<w:document>'.repeat(5000)),
        'word/media/image1.png': new Uint8Array(20 * KIB).map((_, index) => (index * 7) % 251),
        'word/empty.xml': new Uint8Array(0),
      }

      expect(inspectOfficeZip(zipSync(files), DEFAULT_OFFICE_ZIP_LIMITS).entries).toBe(4)
      // Stored, not deflated: nothing in them can grow.
      expect(inspectOfficeZip(zipSync(files, { level: 0 }), DEFAULT_OFFICE_ZIP_LIMITS).entries).toBe(4)
    })
  })

  describe('what it leaves to the parser', () => {
    it('lets through a file whose data will not inflate, since the parser is the one to say so', () => {
      const archive = zipOf({ 'word/document.xml': strToU8('<w:document>'.repeat(500)) })
      // Ruin the compressed data itself, leaving the table of contents at the end alone.
      const ruined = archive.slice()
      for (let index = 40; index < 80; index += 1) ruined[index] = 0xff

      // Unpacking it fails; looking at it does not, and the failure is reported by whatever unpacks it.
      expect(() => unzipSync(ruined)).toThrow()
      expect(inspectOfficeZip(ruined, DEFAULT_OFFICE_ZIP_LIMITS).entries).toBe(1)
    })

    it('lets through an archive whose layout it cannot follow, leaving that check to the declared sizes', () => {
      const archive = zipOf({ 'a.xml': strToU8('x'.repeat(2000)) })
      // The local header of the one file no longer says what it is; the table of contents, which
      // the declared sizes come from, is untouched.
      const strange = archive.slice()
      new DataView(strange.buffer).setUint32(0, 0, true)

      expect(inspectOfficeZip(strange, DEFAULT_OFFICE_ZIP_LIMITS).entries).toBe(1)
    })
  })

  describe('what it does not do', () => {

    it('stops walking the table of contents at the first broken limit', () => {
      const many = zipOf(Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`f${index}.xml`, strToU8('x')])))
      const limits: OfficeZipLimits = { ...DEFAULT_OFFICE_ZIP_LIMITS, maxEntries: 10 }

      zipProbe.countingFilters = true
      zipProbe.filteredEntries = 0
      try {
        expect(rejection(many, limits).reason).toBe('too-many-entries')
      } finally {
        zipProbe.countingFilters = false
      }

      // The directory holds 3000 entries; the walk is shown one past the ten it is allowed and
      // then stops, rather than reading the rest of the table of contents.
      expect(zipProbe.filteredEntries).toBeLessThanOrEqual(limits.maxEntries + 1)
    })
  })

  it('has defaults a large but honest document clears, and that stop the archives that matter', () => {
    const { maxEntries, maxEntryBytes, maxTotalBytes } = DEFAULT_OFFICE_ZIP_LIMITS

    // A 30 MiB thesis with its figures: thousands of parts and hundreds of MiB inflated is normal.
    expect(maxEntries).toBeGreaterThanOrEqual(5_000)
    expect(maxTotalBytes).toBeGreaterThanOrEqual(256 * MIB)
    // But not unbounded: the page has to hold whatever comes out.
    expect(maxEntryBytes).toBeLessThanOrEqual(maxTotalBytes)
    expect(maxTotalBytes).toBeLessThanOrEqual(1024 * MIB)
  })
})
