// Pins the visible/absolute vs tooltip/relative split, and the year rule.
//
// The point of the split is that the VISIBLE string differentiates rows. A test
// that only checked "some string comes out" would pass on the old behaviour,
// where sixteen rows rendered the same words — so the load-bearing case here is
// the one asserting that two different days produce two different labels.

import { describe, expect, it } from 'vitest'
import { formatTimestamp } from './format-timestamp'

const NOW = new Date(2026, 7, 17, 14, 30, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

describe('formatTimestamp', () => {
  describe('values with no instant to show', () => {
    it('returns null for null', () => {
      expect(formatTimestamp(null, NOW)).toBeNull()
    })

    it('returns null for undefined', () => {
      expect(formatTimestamp(undefined, NOW)).toBeNull()
    })

    it('returns null for an empty string', () => {
      expect(formatTimestamp('', NOW)).toBeNull()
    })

    it('returns null for an unparseable string rather than "Invalid Date"', () => {
      expect(formatTimestamp('not a date', NOW)).toBeNull()
    })

    // 0 is a real instant, not an absence. Written as its own case because a
    // falsiness check would swallow it, and that is the likely regression.
    it('formats epoch 0 instead of discarding it as falsy', () => {
      const out = formatTimestamp(0, NOW)
      expect(out).not.toBeNull()
      expect(out!.label).toContain('1970')
    })
  })

  describe('the visible label', () => {
    it('omits the year inside the current year', () => {
      const out = formatTimestamp(new Date(2026, 7, 3, 9, 0).getTime(), NOW)!
      expect(out.label).toBe('3 Aug')
    })

    it('shows the year outside the current year', () => {
      const out = formatTimestamp(new Date(2025, 7, 3, 9, 0).getTime(), NOW)!
      expect(out.label).toBe('3 Aug 2025')
    })

    // The whole reason the component exists: distinct days must read as distinct
    // strings. Under `| amTimeAgo` both of these rendered "14 days ago".
    it('gives two different days two different labels', () => {
      const a = formatTimestamp(NOW - 14 * DAY, NOW)!
      const b = formatTimestamp(NOW - 15 * DAY, NOW)!
      expect(a.label).not.toBe(b.label)
    })

    it('is a date rather than a relative phrase', () => {
      const out = formatTimestamp(NOW - 14 * DAY, NOW)!
      expect(out.label).not.toMatch(/ago/)
    })
  })

  describe('the tooltip', () => {
    it('carries the relative phrasing the label gives up', () => {
      const out = formatTimestamp(NOW - 14 * DAY, NOW)!
      expect(out.tooltip).toMatch(/ago/)
    })

    it('also carries an absolute date and time, for rows too old to place', () => {
      const out = formatTimestamp(new Date(2025, 0, 9, 13, 45).getTime(), NOW)!
      expect(out.tooltip).toContain('2025')
      // localizedFormat's LLL includes a time; assert a clock separator is present
      // rather than a specific rendering, which is locale-dependent.
      expect(out.tooltip).toMatch(/\d:\d{2}/)
    })
  })

  describe('the machine-readable value', () => {
    it('emits an ISO 8601 instant for <time datetime>', () => {
      const at = new Date(2026, 7, 3, 9, 0).getTime()
      expect(formatTimestamp(at, NOW)!.iso).toBe(new Date(at).toISOString())
    })
  })

  describe('string inputs', () => {
    // Regression: dayjs handed an all-digits string runs it through Date parsing
    // rather than reading it as epoch millis, so this case returned '4 Feb 1791'
    // — a plausible-looking date that no build or type check would have flagged.
    it('reads an all-digits string as epoch millis, not as a date string', () => {
      const at = new Date(2026, 7, 3, 9, 0).getTime()
      expect(formatTimestamp(String(at), NOW)!.label).toBe('3 Aug')
    })

    // The other half of that fix: coercing every numeric-looking string would
    // have been fine, but coercing ISO strings would not, so the guard is
    // digits-only and this pins the side that must NOT be coerced.
    it('still parses a genuine ISO 8601 string', () => {
      expect(formatTimestamp('2026-08-03T09:00:00.000Z', NOW)!.label).toContain('Aug')
    })

    it('reads a negative all-digits string as a pre-epoch instant', () => {
      expect(formatTimestamp('-86400000', NOW)!.label).toBe('31 Dec 1969')
    })
  })
})
