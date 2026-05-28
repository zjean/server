import type { NcShareMount } from '../services/nc-share-mount-resolver.service'
import { buildSharedWithMeRecord } from './nc-ocs-share-record'

function mount(over: Partial<NcShareMount> = {}): NcShareMount {
  return {
    shareId: 42,
    alias: 'alice-photos',
    name: "Alice's Photos",
    fileId: 9001,
    isDir: true,
    size: 0,
    ctime: 1700_000_000_000,
    mtime: 1700_000_500_000,
    mime: '',
    permissions: 'a:d:m',
    owner: { id: 1, login: 'alice', fullName: 'Alice Liddell' },
    ...over
  }
}

const recipient = { login: 'bob', fullName: 'Bob Burns' }

describe('buildSharedWithMeRecord', () => {
  it('reports the donor as both uid_owner and uid_file_owner (Sync-in does not separate them)', () => {
    const r = buildSharedWithMeRecord(mount(), recipient)
    expect(r.uid_owner).toBe('alice')
    expect(r.uid_file_owner).toBe('alice')
    expect(r.displayname_owner).toBe('Alice Liddell')
    expect(r.displayname_file_owner).toBe('Alice Liddell')
  })

  it('reports the recipient as share_with (matches real NC wire format)', () => {
    const r = buildSharedWithMeRecord(mount(), recipient)
    expect(r.share_with).toBe('bob')
    expect(r.share_with_displayname).toBe('Bob Burns')
    expect(r.share_with_displayname_unique).toBe('bob')
  })

  it('uses the underlying file id for item_source/file_source — matches PROPFIND oc:fileid', () => {
    const r = buildSharedWithMeRecord(mount(), recipient)
    expect(r.item_source).toBe(9001)
    expect(r.file_source).toBe(9001)
  })

  it("emits 'folder' / 'file' for item_type", () => {
    expect(buildSharedWithMeRecord(mount({ isDir: true }), recipient).item_type).toBe('folder')
    expect(buildSharedWithMeRecord(mount({ isDir: false }), recipient).item_type).toBe('file')
  })

  it("emits is-mount-root: true and mount-type: 'shared' for incoming shares", () => {
    const r = buildSharedWithMeRecord(mount(), recipient)
    expect(r['is-mount-root']).toBe(true)
    expect(r['mount-type']).toBe('shared')
  })

  it('converts mtime / ctime from milliseconds (Sync-in) to seconds (NC OCS)', () => {
    const r = buildSharedWithMeRecord(mount({ ctime: 1700_000_000_000, mtime: 1700_000_500_000 }), recipient)
    expect(r.stime).toBe(1700_000_000)
    expect(r.item_mtime).toBe(1700_000_500)
  })

  it('emits path and file_target as /<alias> — recipient-relative from home root', () => {
    const r = buildSharedWithMeRecord(mount({ alias: 'team-stuff' }), recipient)
    expect(r.path).toBe('/team-stuff')
    expect(r.file_target).toBe('/team-stuff')
  })

  it('normalizes Sync-in mime ("image-jpeg") to standard form ("image/jpeg")', () => {
    expect(buildSharedWithMeRecord(mount({ mime: 'image-jpeg' }), recipient).mimetype).toBe('image/jpeg')
    expect(buildSharedWithMeRecord(mount({ mime: '' }), recipient).mimetype).toBe('')
  })

  it('derives can_edit and can_delete from the share permission bitmask', () => {
    // 'a:d:m' → add (4) | delete (8) | modify (2) | read (1) = 15
    const r = buildSharedWithMeRecord(mount({ permissions: 'a:d:m' }), recipient)
    expect(r.permissions).toBe(15)
    expect(r.can_edit).toBe(true)
    expect(r.can_delete).toBe(true)
  })

  it('reports can_edit=false and can_delete=false for a read-only share', () => {
    const r = buildSharedWithMeRecord(mount({ permissions: '' }), recipient)
    expect(r.permissions).toBe(1) // read only
    expect(r.can_edit).toBe(false)
    expect(r.can_delete).toBe(false)
  })

  it('falls back to login when donor fullName is empty', () => {
    const r = buildSharedWithMeRecord(mount({ owner: { id: 1, login: 'alice', fullName: '' } }), recipient)
    expect(r.displayname_owner).toBe('alice')
    expect(r.displayname_file_owner).toBe('alice')
  })

  it('falls back to login when recipient fullName is empty', () => {
    const r = buildSharedWithMeRecord(mount(), { login: 'bob', fullName: '' })
    expect(r.share_with_displayname).toBe('bob')
  })

  it("emits share_type=0 (user share) — Sync-in's COMMON shares map to NC's user-share code", () => {
    const r = buildSharedWithMeRecord(mount(), recipient)
    expect(r.share_type).toBe(0)
  })

  it('stamps the share id as a string', () => {
    const r = buildSharedWithMeRecord(mount({ shareId: 4242 }), recipient)
    expect(r.id).toBe('4242')
    // id type — wire format keeps it as a string even for numeric ids.
    expect(typeof r.id).toBe('string')
  })

  it('clamps a missing or non-positive item_size to 0', () => {
    expect(buildSharedWithMeRecord(mount({ size: -7 }), recipient).item_size).toBe(0)
    expect(buildSharedWithMeRecord(mount({ size: 12345 }), recipient).item_size).toBe(12345)
  })
})
