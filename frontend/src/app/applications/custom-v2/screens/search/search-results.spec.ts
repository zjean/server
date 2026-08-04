// The search screen's pure half. Each of these can be wrong in a way that renders
// perfectly: a highlight range that drops a character, a group key that merges two
// spaces, a time bucket that includes the future.
//
// No TestBed and no component — these are functions over data, which is exactly
// why they were split out of the component in the first place.

import { describe, expect, it } from 'vitest'
import type { FileContentModel } from '../../../files/models/file-content.model'
import { applyFacets, groupBySpace, highlight, isSharesKey, markSegments, spaceKey, spaceLabel, typeFacets } from './search-results'

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)
const day = 86_400_000

const row = (over: Partial<FileContentModel> = {}): FileContentModel =>
  ({
    id: 1,
    path: 'files/personal/Documents',
    name: 'notes.md',
    mime: 'text-markdown',
    size: 10,
    mtime: NOW,
    matches: [],
    ...over
  }) as FileContentModel

describe('spaceKey', () => {
  it('is the repository AND the alias, so a space and a share of the same name stay apart', () => {
    expect(spaceKey('files/design/Assets')).toBe('files/design')
    expect(spaceKey('shares/design/Assets')).toBe('shares/design')
    expect(spaceKey('files/design/design/design')).toBe('files/design')
  })

  it('survives a space root with no subfolder', () => {
    expect(spaceKey('files/personal')).toBe('files/personal')
  })
})

describe('groupBySpace', () => {
  const label = (k: string) => k

  it('groups by space and keeps every row', () => {
    const rows = [row({ id: 1, path: 'files/personal/A' }), row({ id: 2, path: 'files/team/B' }), row({ id: 3, path: 'files/personal/C' })]
    const groups = groupBySpace(rows, label)
    expect(groups.map((g) => g.key)).toEqual(['files/personal', 'files/team'])
    expect(groups[0].rows.map((r) => r.id)).toEqual([1, 3])
    expect(groups.flatMap((g) => g.rows)).toHaveLength(3)
  })

  // The backend orders by relevance, so the best match must stay at the top of the
  // page. Sorting groups alphabetically would file it under whatever letter its
  // space starts with.
  it('orders groups by first appearance, not alphabetically', () => {
    const groups = groupBySpace([row({ path: 'files/zulu/A' }), row({ path: 'files/alpha/B' })], label)
    expect(groups.map((g) => g.key)).toEqual(['files/zulu', 'files/alpha'])
  })

  it('returns nothing for no rows', () => {
    expect(groupBySpace([], label)).toEqual([])
  })
})

describe('spaceLabel', () => {
  const spaces = [{ alias: 'team', name: 'Product Team' }]

  it('names the personal space', () => {
    expect(spaceLabel('files/personal', spaces)).toBe('Personal')
  })

  it('prefers the space name and falls back to the alias', () => {
    expect(spaceLabel('files/team', spaces)).toBe('Product Team')
    expect(spaceLabel('files/unknown', spaces)).toBe('unknown')
    expect(spaceLabel('shares/team', spaces)).toBe('Product Team')
  })

  // A directly-shared single file has a one-segment parent path (`shares`), so
  // there is no alias to look up. It rendered as a group header with a glyph and no
  // words at all until this was handled.
  it('names the repository when a root-level file has no alias', () => {
    expect(spaceLabel('shares', spaces)).toBe('Shared')
    expect(spaceLabel('files', spaces)).toBe('Personal')
  })
})

// The backend highlights full-text matches itself, so a snippet arrives WITH markup
// in it. Rendering it as text printed "<mark>Notes</mark>" on screen; binding it as
// innerHTML (which classic does) renders unescaped file content as UI.
describe('markSegments', () => {
  it('splits on the server markers and flags the marked runs', () => {
    expect(markSegments('a <mark>Notes</mark> b')).toEqual([
      { text: 'a ', hit: false },
      { text: 'Notes', hit: true },
      { text: ' b', hit: false }
    ])
  })

  it('handles several markers and a snippet that starts with one', () => {
    expect(markSegments('<mark>x</mark> y <mark>z</mark>')).toEqual([
      { text: 'x', hit: true },
      { text: ' y ', hit: false },
      { text: 'z', hit: true }
    ])
  })

  it('passes an unmarked snippet through as one run', () => {
    expect(markSegments('nothing here')).toEqual([{ text: 'nothing here', hit: false }])
  })

  it('never loses a character', () => {
    const cases = ['<mark>a</mark>bc', 'a<mark>b</mark>c', 'abc', '<mark>abc</mark>', 'a <MARK>B</MARK> c']
    for (const c of cases) {
      expect(
        markSegments(c)
          .map((s) => s.text)
          .join('')
      ).toBe(c.replace(/<\/?mark>/gi, ''))
    }
  })

  // Any other markup in the content stays TEXT — that is the whole point of
  // returning segments rather than binding innerHTML.
  it('leaves other markup as literal text', () => {
    expect(markSegments('<img onerror="x"> <mark>hit</mark>')).toEqual([
      { text: '<img onerror="x"> ', hit: false },
      { text: 'hit', hit: true }
    ])
  })
})

describe('isSharesKey', () => {
  it('distinguishes a share from a space', () => {
    expect(isSharesKey('shares/team')).toBe(true)
    expect(isSharesKey('files/team')).toBe(false)
  })
})

describe('typeFacets', () => {
  it('lists each glyph family once, in first-seen order', () => {
    const facets = typeFacets([row({ mime: 'text-markdown' }), row({ mime: 'image-jpeg' }), row({ mime: 'text-plain' }), row({ mime: 'image-png' })])
    // markdown and plain text both map to `doc`, so the two of them are one facet.
    expect(facets).toEqual(['doc', 'image'])
  })

  it('is empty for no rows', () => {
    expect(typeFacets([])).toEqual([])
  })
})

describe('applyFacets', () => {
  const rows = [
    row({ id: 1, mime: 'text-markdown', mtime: NOW - 2 * 3600_000 }),
    row({ id: 2, mime: 'image-jpeg', mtime: NOW - 3 * day }),
    row({ id: 3, mime: 'image-png', mtime: NOW - 60 * day })
  ]

  it('passes everything through when both facets are off', () => {
    expect(applyFacets(rows, 'all', 'any', NOW)).toHaveLength(3)
  })

  it('filters by glyph family', () => {
    expect(applyFacets(rows, 'image', 'any', NOW).map((r) => r.id)).toEqual([2, 3])
  })

  it('filters by age, inclusive of the boundary', () => {
    expect(applyFacets(rows, 'all', 'today', NOW).map((r) => r.id)).toEqual([1])
    expect(applyFacets(rows, 'all', 'week', NOW).map((r) => r.id)).toEqual([1, 2])
    expect(applyFacets(rows, 'all', 'month', NOW).map((r) => r.id)).toEqual([1, 2])
    expect(applyFacets([row({ id: 9, mtime: NOW - day })], 'all', 'today', NOW).map((r) => r.id)).toEqual([9])
  })

  it('combines both facets', () => {
    expect(applyFacets(rows, 'image', 'week', NOW).map((r) => r.id)).toEqual([2])
  })

  // `mtime` is client-controlled — a sync client can set it — so a row can sit in
  // the future. A filter hides what does not match; it is not the place to hide
  // what looks odd.
  it('keeps a row whose mtime is in the future', () => {
    expect(applyFacets([row({ id: 7, mtime: NOW + 10 * day })], 'all', 'today', NOW).map((r) => r.id)).toEqual([7])
  })
})

describe('highlight', () => {
  const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

  it('never loses or duplicates a character', () => {
    const source = 'Versioning spec — final v2.md'
    for (const q of ['version', 'v2', 'spec final', 'zzz', '', '  ']) {
      expect(text(highlight(source, q))).toBe(source)
    }
  })

  it('flags a case-insensitive match', () => {
    expect(highlight('Versioning', 'version')).toEqual([
      { text: 'Version', hit: true },
      { text: 'ing', hit: false }
    ])
  })

  it('flags every occurrence, not just the first', () => {
    const segs = highlight('spec spec', 'spec')
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['spec', 'spec'])
  })

  it('treats each whitespace-separated term independently', () => {
    const segs = highlight('retention policy', 'policy retention')
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['retention', 'policy'])
  })

  // The bug a slice-and-concat implementation has: 'ver' matches inside
  // 'version', and the two ranges overlap. Marking characters then coalescing
  // cannot double-count.
  it('coalesces overlapping terms into one run', () => {
    expect(highlight('versioning', 'ver version')).toEqual([
      { text: 'version', hit: true },
      { text: 'ing', hit: false }
    ])
  })

  it('returns one unflagged run for an empty query or empty text', () => {
    expect(highlight('notes.md', '')).toEqual([{ text: 'notes.md', hit: false }])
    expect(highlight('', 'notes')).toEqual([{ text: '', hit: false }])
  })

  it('flags the whole string when it is entirely a match', () => {
    expect(highlight('notes', 'notes')).toEqual([{ text: 'notes', hit: true }])
  })
})
