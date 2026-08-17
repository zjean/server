// Pins the bucket ladder's boundaries.
//
// Worth pinning rather than eyeballing, because every boundary here is an
// off-by-one waiting to happen and none of them fails a build: a wrong bound
// renders a plausible-looking list under a slightly wrong header, which is
// invisible in review and in a screenshot. The five-rung ladder replaced a
// three-rung one whose bottom rung was unbounded — see date-buckets.ts.
//
// No TestBed and no Angular here: these are pure functions, so a plain import is
// the whole harness.

import { describe, expect, it } from 'vitest'
import { DATE_BUCKET_LABELS, DATE_BUCKET_ORDER, dateBucketOf, groupByDateBucket } from './date-buckets'

// A fixed "now" so every case reads as an absolute claim. 2026-08-17T14:30 local.
const NOW = new Date(2026, 7, 17, 14, 30, 0).getTime()
const startOfToday = new Date(2026, 7, 17).getTime()
const DAY = 24 * 60 * 60 * 1000

describe('dateBucketOf', () => {
  it('files this morning under today', () => {
    expect(dateBucketOf(new Date(2026, 7, 17, 9, 0).getTime(), NOW)).toBe('today')
  })

  it('files the first instant of today under today, not yesterday', () => {
    expect(dateBucketOf(startOfToday, NOW)).toBe('today')
  })

  it('files the last instant before midnight under yesterday', () => {
    expect(dateBucketOf(startOfToday - 1, NOW)).toBe('yesterday')
  })

  it('files exactly one day before the start of today under yesterday', () => {
    expect(dateBucketOf(startOfToday - DAY, NOW)).toBe('yesterday')
  })

  it('files two days back under thisWeek', () => {
    expect(dateBucketOf(startOfToday - 2 * DAY, NOW)).toBe('thisWeek')
  })

  it('holds thisWeek to six days back inclusive', () => {
    expect(dateBucketOf(startOfToday - 6 * DAY, NOW)).toBe('thisWeek')
  })

  it('drops to thisMonth one day past the week window', () => {
    expect(dateBucketOf(startOfToday - 7 * DAY, NOW)).toBe('thisMonth')
  })

  it('holds thisMonth to 29 days back inclusive', () => {
    expect(dateBucketOf(startOfToday - 29 * DAY, NOW)).toBe('thisMonth')
  })

  it('drops to earlier one day past the month window', () => {
    expect(dateBucketOf(startOfToday - 30 * DAY, NOW)).toBe('earlier')
  })

  // The case that motivated the wider ladder: the fixture data on the dev
  // instance is a single import roughly a fortnight old, and under the old
  // three-rung ladder every row of it landed in the unbounded bottom bucket.
  it('files a fortnight-old row under thisMonth rather than earlier', () => {
    expect(dateBucketOf(startOfToday - 14 * DAY, NOW)).toBe('thisMonth')
  })

  describe('values that are not ordinary past instants', () => {
    it('files a future timestamp under today rather than earlier', () => {
      // Reachable in production: mtime is client-supplied, so a skewed device
      // clock dates rows ahead of the server.
      expect(dateBucketOf(startOfToday + 3 * DAY, NOW)).toBe('today')
    })

    it('files NaN under earlier instead of throwing', () => {
      expect(dateBucketOf(Number.NaN, NOW)).toBe('earlier')
    })

    it('files Infinity under earlier, because it is not a usable instant', () => {
      expect(dateBucketOf(Number.POSITIVE_INFINITY, NOW)).toBe('earlier')
    })
  })
})

describe('groupByDateBucket', () => {
  interface Row {
    id: number
    mtime: number
  }
  const msOf = (r: Row) => r.mtime

  it('returns nothing for an empty list', () => {
    expect(groupByDateBucket([], msOf, NOW)).toEqual([])
  })

  it('emits only the buckets that have items', () => {
    const rows: Row[] = [
      { id: 1, mtime: startOfToday + 1000 },
      { id: 2, mtime: startOfToday - 40 * DAY }
    ]
    expect(groupByDateBucket(rows, msOf, NOW).map((b) => b.key)).toEqual(['today', 'earlier'])
  })

  it('emits buckets newest-first regardless of the input order', () => {
    const rows: Row[] = [
      { id: 1, mtime: startOfToday - 40 * DAY }, // earlier, arrives first
      { id: 2, mtime: startOfToday + 1000 }, // today, arrives last
      { id: 3, mtime: startOfToday - 3 * DAY } // thisWeek
    ]
    expect(groupByDateBucket(rows, msOf, NOW).map((b) => b.key)).toEqual(['today', 'thisWeek', 'earlier'])
  })

  it('preserves the incoming order within a bucket', () => {
    // The caller has already sorted by recency; grouping must not re-sort.
    const rows: Row[] = [
      { id: 1, mtime: startOfToday - 2 * DAY },
      { id: 2, mtime: startOfToday - 5 * DAY },
      { id: 3, mtime: startOfToday - 3 * DAY }
    ]
    const [week] = groupByDateBucket(rows, msOf, NOW)
    expect(week.key).toBe('thisWeek')
    expect(week.items.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('labels each bucket with its i18n key, untranslated', () => {
    const rows: Row[] = [{ id: 1, mtime: startOfToday + 1000 }]
    expect(groupByDateBucket(rows, msOf, NOW)[0].label).toBe('Today')
  })

  it('loses no items across buckets', () => {
    const rows: Row[] = [
      { id: 1, mtime: startOfToday + 1000 },
      { id: 2, mtime: startOfToday - DAY },
      { id: 3, mtime: startOfToday - 3 * DAY },
      { id: 4, mtime: startOfToday - 10 * DAY },
      { id: 5, mtime: startOfToday - 100 * DAY },
      { id: 6, mtime: Number.NaN }
    ]
    const grouped = groupByDateBucket(rows, msOf, NOW)
    expect(
      grouped
        .flatMap((b) => b.items)
        .map((r) => r.id)
        .sort()
    ).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('the bucket tables', () => {
  it('labels every key in the order table', () => {
    for (const key of DATE_BUCKET_ORDER) {
      expect(DATE_BUCKET_LABELS[key]).toBeTruthy()
    }
  })

  // Guards the pairing rather than the contents: a key added to one table and not
  // the other yields a bucket with an empty header, which renders as a stray gap.
  it('has an order entry for every label', () => {
    expect([...DATE_BUCKET_ORDER].sort()).toEqual(Object.keys(DATE_BUCKET_LABELS).sort())
  })
})
