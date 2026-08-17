import { describe, expect, it } from 'vitest'
import { FILE_ORIGIN_ICONS, FILE_ORIGIN_LABELS, fileLocationPath, fileOriginOf } from './file-origin'

describe('fileOriginOf', () => {
  it('reads a file with neither id as personal', () => {
    expect(fileOriginOf({ shareId: 0, spaceId: 0 })).toBe('personal')
  })

  it('reads a space id as space', () => {
    expect(fileOriginOf({ shareId: 0, spaceId: 7 })).toBe('space')
  })

  it('reads a share id as share', () => {
    expect(fileOriginOf({ shareId: 1, spaceId: 0 })).toBe('share')
  })

  // The precedence case, and the reason the order is not arbitrary: a file
  // reached through a share carries both ids. FileRecentModel's icon expression
  // resolves the same way, so label and icon cannot disagree.
  it('prefers share over space when the file carries both', () => {
    expect(fileOriginOf({ shareId: 1, spaceId: 7 })).toBe('share')
  })

  it('treats absent fields as personal rather than throwing', () => {
    expect(fileOriginOf({})).toBe('personal')
  })

  it('treats null ids as personal', () => {
    expect(fileOriginOf({ shareId: null, spaceId: null })).toBe('personal')
  })
})

describe('fileLocationPath', () => {
  it('passes a nested path through unchanged', () => {
    expect(fileLocationPath('product-team/Roadmap')).toBe('product-team/Roadmap')
  })

  // Empty is a real answer, not a failure: the file sits at a repository root.
  // The caller substitutes the origin label, because a row showing nothing where
  // its siblings show a path reads as a rendering fault.
  it('returns empty for an empty path', () => {
    expect(fileLocationPath('')).toBe('')
  })

  it('returns empty for null', () => {
    expect(fileLocationPath(null)).toBe('')
  })

  it('returns empty for undefined', () => {
    expect(fileLocationPath(undefined)).toBe('')
  })

  // `showedPath` is built by joining a sliced split, so a root file can arrive as
  // '/' rather than ''. Both have to reach the same fallback.
  it('returns empty for a path that is only slashes', () => {
    expect(fileLocationPath('/')).toBe('')
  })

  it('trims surrounding slashes', () => {
    expect(fileLocationPath('/Projects/')).toBe('Projects')
  })
})

describe('the origin tables', () => {
  it('labels all three origins', () => {
    expect(Object.keys(FILE_ORIGIN_LABELS).sort()).toEqual(['personal', 'share', 'space'])
  })

  // Paired with the labels rather than checked alone: an origin with a glyph and
  // no label renders an unnamed mark, which is the accessibility half of the bug.
  it('gives every labelled origin an icon', () => {
    expect(Object.keys(FILE_ORIGIN_ICONS).sort()).toEqual(Object.keys(FILE_ORIGIN_LABELS).sort())
  })

  // Pins the left nav's vocabulary. If one of these is changed, the row's origin
  // mark stops matching the sidebar entry the file lives under, which is the only
  // thing that makes an icon-only origin legible.
  it('uses the same marks the left nav uses for these destinations', () => {
    expect(FILE_ORIGIN_ICONS).toEqual({ personal: 'folder', space: 'box', share: 'share' })
  })
})
