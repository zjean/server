import { describe, expect, it } from 'vitest'
import { FILE_ORIGIN_ICONS, FILE_ORIGIN_LABELS, fileLocationPath, fileOriginFromPath, fileOriginOf, stripRepositoryPrefix } from './file-origin'

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

// The real constant values, so these cases pin behaviour against the same strings
// production uses rather than against invented ones.
const REPOS = { files: 'files', shares: 'shares' }
const PERSONAL = 'personal'

describe('fileOriginFromPath', () => {
  it('reads the shares repository as share', () => {
    expect(fileOriginFromPath('shares/benchmarks/query.csv', REPOS, PERSONAL)).toBe('share')
  })

  it('reads files/personal as personal', () => {
    expect(fileOriginFromPath('files/personal/Projects/notes.md', REPOS, PERSONAL)).toBe('personal')
  })

  it('reads any other files alias as a space', () => {
    expect(fileOriginFromPath('files/product-team/Roadmap/q3.md', REPOS, PERSONAL)).toBe('space')
  })

  // A folder named `personal` inside a SPACE must not be mistaken for the personal
  // repository: the alias is the second segment, never a deeper one.
  it('does not treat a nested personal folder as the personal repository', () => {
    expect(fileOriginFromPath('files/product-team/personal/notes.md', REPOS, PERSONAL)).toBe('space')
  })

  it('falls back to space for an empty path rather than throwing', () => {
    expect(fileOriginFromPath('', REPOS, PERSONAL)).toBe('space')
  })
})

describe('stripRepositoryPrefix', () => {
  // Two segments for personal, because neither `files` nor `personal` is a folder
  // the user put anything in.
  it('drops both segments of a personal prefix', () => {
    expect(stripRepositoryPrefix('files/personal/Projects/Docs', PERSONAL)).toBe('Projects/Docs')
  })

  // One segment for a space, because the alias IS a container the user recognises.
  it('keeps the space alias and drops only the repository', () => {
    expect(stripRepositoryPrefix('files/product-team/Roadmap', PERSONAL)).toBe('product-team/Roadmap')
  })

  it('keeps the share alias', () => {
    expect(stripRepositoryPrefix('shares/benchmarks/sub', PERSONAL)).toBe('benchmarks/sub')
  })

  it('returns empty at a personal root', () => {
    expect(stripRepositoryPrefix('files/personal', PERSONAL)).toBe('')
  })

  describe('dropLast, for a path ending in the file name', () => {
    it('drops the file name as well as the prefix', () => {
      expect(stripRepositoryPrefix('files/personal/Projects/notes.md', PERSONAL, true)).toBe('Projects')
    })

    it('returns empty for a file sitting at a personal root', () => {
      // The old favorites code returned '/' here, which rendered as a stray slash.
      expect(stripRepositoryPrefix('files/personal/notes.md', PERSONAL, true)).toBe('')
    })

    it('keeps the space alias for a file at a space root', () => {
      expect(stripRepositoryPrefix('files/product-team/q3.md', PERSONAL, true)).toBe('product-team')
    })
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
