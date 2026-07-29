// Pins the folder-readme detection rule.
//
// Precedence is the part that needs a unit test rather than a browser check.
// Design §11 case 3 could not build a fixture for it at all: this host's
// filesystem (macOS APFS, default case-insensitive) collapses 'README.md' and
// 'readme.md' into one directory entry, so two of the three names can never
// coexist in one folder there — and the same is true of any case-insensitive
// deployment. Precedence therefore only matters on case-sensitive hosts (typical
// Linux), where it went unobserved. A pure function over an array has no such
// limit, so the ordering is verified here directly.
//
// The isDir exclusion is the other rule worth pinning: a *directory* named
// README.md is legal, and upstream guards the same case
// (nextcloud/text WorkspaceService.php, getMimeType() !== DIRECTORY_MIMETYPE).

import { describe, expect, it } from 'vitest'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { FOLDER_README_NAMES, pickFolderReadme } from './folder-readme'

function entry(id: number, name: string, isDir = false): FileProps {
  return {
    id,
    name,
    isDir,
    mime: isDir ? 'directory' : 'text-markdown',
    size: isDir ? 4096 : 120,
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_000_000
  } as FileProps
}

const OTHER_ROWS = [entry(90, 'notes.txt'), entry(91, 'images', true)]

describe('FOLDER_README_NAMES', () => {
  // Upstream's SUPPORTED_STATIC_FILENAMES order, minus the hidden and
  // l10n-translated entries (design §2). The order IS the precedence contract
  // pickFolderReadme implements, so pin it rather than only testing through the
  // function — a reordering here is a behaviour change, not a refactor.
  it("is NC's list in NC's order", () => {
    expect(FOLDER_README_NAMES).toEqual(['Readme.md', 'README.md', 'readme.md'])
  })

  it('excludes the hidden and translated variants NC supports', () => {
    expect(FOLDER_README_NAMES).not.toContain('.Readme.md')
    expect(FOLDER_README_NAMES).not.toContain('Leesmij.md')
  })
})

describe('pickFolderReadme — each name alone', () => {
  it.each(FOLDER_README_NAMES)('finds %s on its own', (name) => {
    const readme = entry(1, name)
    expect(pickFolderReadme([...OTHER_ROWS, readme])).toBe(readme)
  })

  it('finds the readme wherever it sits in the listing', () => {
    const readme = entry(1, 'Readme.md')
    expect(pickFolderReadme([readme, ...OTHER_ROWS])).toBe(readme)
    expect(pickFolderReadme([...OTHER_ROWS, readme])).toBe(readme)
  })
})

// The cases §11 recorded as NOT TESTED, unobservable on a case-insensitive host.
describe('pickFolderReadme — precedence when several coexist', () => {
  it('prefers Readme.md over README.md', () => {
    const first = entry(1, 'Readme.md')
    const second = entry(2, 'README.md')
    expect(pickFolderReadme([second, first])).toBe(first)
  })

  it('prefers Readme.md over readme.md', () => {
    const first = entry(1, 'Readme.md')
    const third = entry(3, 'readme.md')
    expect(pickFolderReadme([third, first])).toBe(first)
  })

  it('prefers README.md over readme.md', () => {
    const second = entry(2, 'README.md')
    const third = entry(3, 'readme.md')
    expect(pickFolderReadme([third, second])).toBe(second)
  })

  it('picks Readme.md when all three coexist, regardless of listing order', () => {
    const first = entry(1, 'Readme.md')
    const second = entry(2, 'README.md')
    const third = entry(3, 'readme.md')
    expect(pickFolderReadme([third, second, first])).toBe(first)
    expect(pickFolderReadme([first, second, third])).toBe(first)
    expect(pickFolderReadme([second, third, first])).toBe(first)
  })

  // Precedence is by NAME, not by position: the list order wins even when the
  // lower-precedence name is the only one that would be found by a naive
  // "first row whose name is in the list" scan over the listing.
  it('is decided by the name list, not by listing position', () => {
    const second = entry(2, 'README.md')
    const first = entry(1, 'Readme.md')
    const picked = pickFolderReadme([...OTHER_ROWS, second, first])
    expect(picked?.name).toBe('Readme.md')
  })

  // A directory shadowing the higher-precedence name must not suppress the real
  // readme sitting under a lower-precedence one — the isDir exclusion has to be
  // per-candidate, not a single early exit.
  it('falls through a DIRECTORY named Readme.md to a real README.md', () => {
    const dir = entry(1, 'Readme.md', true)
    const real = entry(2, 'README.md')
    expect(pickFolderReadme([dir, real])).toBe(real)
  })
})

describe('pickFolderReadme — exclusions', () => {
  it('excludes a directory named README.md', () => {
    expect(pickFolderReadme([...OTHER_ROWS, entry(1, 'README.md', true)])).toBe(null)
  })

  it.each(FOLDER_README_NAMES)('excludes a directory named %s', (name) => {
    expect(pickFolderReadme([entry(1, name, true)])).toBe(null)
  })

  // Exact-case comparison, matching upstream. These near-misses stay ordinary
  // rows in the listing.
  it.each(['ReadMe.md', 'readMe.md', 'README.MD', 'Readme.markdown', 'Readme', 'readme.md.bak', 'sub/Readme.md'])('does not match %s', (name) => {
    expect(pickFolderReadme([entry(1, name)])).toBe(null)
  })

  it('returns null when no candidate is present', () => {
    expect(pickFolderReadme(OTHER_ROWS)).toBe(null)
  })

  it('returns null for an empty listing', () => {
    expect(pickFolderReadme([])).toBe(null)
  })
})
