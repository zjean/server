import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { describe, expect, it } from 'vitest'
import { isFileWriteable } from './file-writeable'

// Permission strings are COLON-separated (SPACE_PERMS_SEP), not comma-separated.
// Written with commas, every intersection here silently yields '' and the cases
// pass or fail for the wrong reason — which is how this file was first written.
const ALL = 'a:m:d'
const NO_MODIFY = 'a:d'

function row(props: Partial<FileProps> = {}): FileProps {
  return { name: 'Readme.md', path: 'files/personal', isDir: false, mime: 'text/markdown', size: 12, ...props } as FileProps
}

describe('isFileWriteable', () => {
  it('is false without a file — a caller with nothing loaded must not offer an editor', () => {
    expect(isFileWriteable(null, ALL)).toBe(false)
    expect(isFileWriteable(undefined, ALL)).toBe(false)
  })

  it('requires MODIFY', () => {
    expect(isFileWriteable(row(), ALL)).toBe(true)
    expect(isFileWriteable(row(), NO_MODIFY)).toBe(false)
  })

  it('is false for empty permissions — the value the caller passes for trash', () => {
    expect(isFileWriteable(row(), '')).toBe(false)
  })

  // MODIFY is the single character 'm', and classic tests it with a substring
  // match rather than by splitting. That is only safe because no other operation
  // is spelled with an 'm'. Pinned here so adding one cannot silently grant write.
  it('does not read MODIFY out of another operation', () => {
    expect(isFileWriteable(row(), 'a:d:si:so')).toBe(false)
  })

  it("intersects the row's own root permissions when present — the narrower grant wins", () => {
    // A root row at a space's top level: the space grants MODIFY, the root does not.
    expect(isFileWriteable(row({ root: { permissions: NO_MODIFY } as FileProps['root'] }), ALL)).toBe(false)
    // …and the other way round: the root grants MODIFY, the space does not.
    expect(isFileWriteable(row({ root: { permissions: ALL } as FileProps['root'] }), NO_MODIFY)).toBe(false)
    expect(isFileWriteable(row({ root: { permissions: 'a:m' } as FileProps['root'] }), ALL)).toBe(true)
  })

  it('ignores an absent or empty root permission string rather than intersecting to nothing', () => {
    // Ordinary rows inside a folder carry no `root` at all (only
    // spaces-browser.service.ts::updateRootFile sets it), and the browse response
    // has already intersected for them. Treating that as "no permissions" would
    // make every file in every space read-only.
    expect(isFileWriteable(row({ root: undefined }), ALL)).toBe(true)
    expect(isFileWriteable(row({ root: { permissions: '' } as FileProps['root'] }), ALL)).toBe(true)
  })

  it('rejects an exclusive lock even with MODIFY', () => {
    expect(isFileWriteable(row({ lock: { isExclusive: true } as FileProps['lock'] }), ALL)).toBe(false)
  })

  it('allows a shared lock — Collabora and OnlyOffice take those, and they co-edit', () => {
    expect(isFileWriteable(row({ lock: { isExclusive: false } as FileProps['lock'] }), ALL)).toBe(true)
  })
})
