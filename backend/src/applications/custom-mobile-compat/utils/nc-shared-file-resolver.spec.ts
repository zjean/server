import { resolveSharedFileSegments, type ResolverFileRow } from './nc-shared-file-resolver'

// resolveSharedFileSegments maps a target file id (what NC clients pass to
// /index.php/core/preview?fileId=) to the SHARES url-segments
// (['shares', <alias>, ...relPath]) that SpacesManager.spaceEnv resolves into a
// donor-side realPath. It is the access boundary for shared-file previews:
// it must return segments ONLY when the target is the share root itself or a
// descendant of it, in the same physical storage tree.

const ALICE = 10
const BOB = 11

function row(id: number, path: string, opts: Partial<ResolverFileRow> = {}): ResolverFileRow {
  return { id, path, ownerId: ALICE, spaceId: null, ...opts }
}

describe('resolveSharedFileSegments', () => {
  it('resolves a single-file share when the target IS the share root', () => {
    const target = row(100, 'report.pdf')
    const mounts = [{ alias: 'alice-report', fileId: 100 }]
    const roots = new Map([[100, row(100, 'report.pdf')]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toEqual(['shares', 'alice-report'])
  })

  it('resolves a direct child of a shared folder', () => {
    const target = row(101, 'Photos/vacation.jpg')
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Photos')]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toEqual(['shares', 'alice-photos', 'vacation.jpg'])
  })

  it('resolves a deep descendant of a shared folder', () => {
    const target = row(102, 'Photos/2026/summer/pic.jpg')
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Photos')]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toEqual(['shares', 'alice-photos', '2026', 'summer', 'pic.jpg'])
  })

  it('returns null when the target is not under any mount root', () => {
    const target = row(200, 'Documents/notes.txt')
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Photos')]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toBeNull()
  })

  it('does not treat a sibling prefix as "under" the root (Photos vs Photos-private)', () => {
    const target = row(201, 'Photos-private/secret.jpg')
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Photos')]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toBeNull()
  })

  it('SECURITY: refuses a same-path file that lives in a different owner tree', () => {
    // Bob asks for a file whose path happens to match a path under Alice's
    // shared folder — but it is Bob's own file (or another user's), not part
    // of the share. Personal trees are keyed by ownerId.
    const target = row(300, 'Photos/vacation.jpg', { ownerId: BOB })
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Photos', { ownerId: ALICE })]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toBeNull()
  })

  it('matches space-share files by spaceId regardless of per-file ownerId', () => {
    // In a shared space, the root and the child share a spaceId but may have
    // different per-file owners. spaceId is the physical-tree key here.
    const target = row(400, 'Team/q3/budget.xlsx', { ownerId: BOB, spaceId: 7 })
    const mounts = [{ alias: 'team-space', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Team', { ownerId: ALICE, spaceId: 7 })]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toEqual(['shares', 'team-space', 'q3', 'budget.xlsx'])
  })

  it('SECURITY: refuses a same-path file in a different space', () => {
    const target = row(401, 'Team/q3/budget.xlsx', { spaceId: 99 })
    const mounts = [{ alias: 'team-space', fileId: 100 }]
    const roots = new Map([[100, row(100, 'Team', { spaceId: 7 })]])
    expect(resolveSharedFileSegments(target, mounts, roots)).toBeNull()
  })

  it('returns null when the user has no mounts', () => {
    const target = row(101, 'Photos/vacation.jpg')
    expect(resolveSharedFileSegments(target, [], new Map())).toBeNull()
  })

  it('returns null (skips the mount) when the root row is missing from the lookup', () => {
    const target = row(101, 'Photos/vacation.jpg')
    const mounts = [{ alias: 'alice-photos', fileId: 100 }]
    expect(resolveSharedFileSegments(target, mounts, new Map())).toBeNull()
  })

  it('picks the first matching mount when more than one could contain the target', () => {
    const target = row(101, 'Photos/vacation.jpg')
    const mounts = [
      { alias: 'alice-photos', fileId: 100 },
      { alias: 'other', fileId: 999 }
    ]
    const roots = new Map([
      [100, row(100, 'Photos')],
      [999, row(999, 'Documents')]
    ])
    expect(resolveSharedFileSegments(target, mounts, roots)).toEqual(['shares', 'alice-photos', 'vacation.jpg'])
  })
})
