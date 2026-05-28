import type { NcShareMount } from '../services/nc-share-mount-resolver.service'
import { buildShareMountPropResponse } from './nc-share-mount-response'

function mount(over: Partial<NcShareMount> = {}): NcShareMount {
  return {
    shareId: 42,
    alias: 'alice-photos',
    name: "Alice's Photos",
    fileId: 9001,
    isDir: true,
    size: 0,
    // Realistic ms-since-epoch timestamps — a future refactor that mixes ms
    // and seconds would produce visibly-broken RFC1123 dates (1970-XX or
    // 56000-XX) and break the tests rather than the iOS client.
    ctime: 1_716_891_500_000,
    mtime: 1_716_891_600_000,
    mime: '',
    permissions: 'a:d:m',
    owner: { id: 1, login: 'alice', fullName: 'Alice Liddell' },
    ...over
  }
}

describe('buildShareMountPropResponse', () => {
  const HREF_BASE = '/remote.php/dav/files/bob/'

  it("includes 'S' in oc:permissions (the iOS shared-with-me-folder badge signal)", () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['oc:permissions']).toMatch(/^S[A-Z]*$/)
  })

  it("emits nc:mount-type='shared' (informational, mirrors real NC)", () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['nc:mount-type']).toBe('shared')
  })

  it('emits the donor login as oc:owner-id (not the requester) and donor fullName as display-name', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['oc:owner-id']).toBe('alice')
    expect(r['d:propstat']['d:prop']['oc:owner-display-name']).toBe('Alice Liddell')
  })

  it('falls back to login when fullName is empty', () => {
    const r = buildShareMountPropResponse(mount({ owner: { id: 1, login: 'alice', fullName: '' } }), HREF_BASE) as {
      'd:propstat': { 'd:prop': Record<string, string> }
    }
    expect(r['d:propstat']['d:prop']['oc:owner-display-name']).toBe('alice')
  })

  it('uses the underlying file id as oc:fileid / oc:id (for cache consistency with PROPFIND inside the mount)', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['oc:fileid']).toBe('9001')
    expect(r['d:propstat']['d:prop']['oc:id']).toBe('00000000000000009001syncin')
  })

  it('builds the href as <hrefBase><alias>/ — trailing slash because a mount is always a collection', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:href': string }
    expect(r['d:href']).toBe('/remote.php/dav/files/bob/alice-photos/')
  })

  it('URL-encodes the alias in the href so non-ASCII names round-trip', () => {
    const r = buildShareMountPropResponse(mount({ alias: 'pôt commun' }), HREF_BASE) as { 'd:href': string }
    expect(r['d:href']).toBe('/remote.php/dav/files/bob/p%C3%B4t%20commun/')
  })

  it("encodes the rawurlencode-extra characters (!'()*) so aliases like \"Alice's Photos\" round-trip identically to real NC's sabre/dav", () => {
    const r = buildShareMountPropResponse(mount({ alias: "Alice's (best) photos!" }), HREF_BASE) as { 'd:href': string }
    // JS encodeURIComponent leaves !'()* alone; sabre's rawurlencode escapes them.
    expect(r['d:href']).toBe('/remote.php/dav/files/bob/Alice%27s%20%28best%29%20photos%21/')
  })

  it('emits an empty <oc:share-types> — share-types is "shared by me", not "received by me"', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['oc:share-types']).toBe('')
  })

  it('emits a strong ETag (no W/ prefix — iOS would treat it as a thumbnail-path component otherwise)', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['d:getetag']).toMatch(/^"\d+-\d+"$/)
    expect(r['d:propstat']['d:prop']['d:getetag']).not.toMatch(/W\//)
  })

  it('emits d:resourcetype as a collection for a folder mount', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, unknown> } }
    expect(r['d:propstat']['d:prop']['d:resourcetype']).toEqual({ 'd:collection': '' })
  })

  it('emits resourcetype as the empty string for a single-file mount, plus content-type / content-length', () => {
    const r = buildShareMountPropResponse(mount({ isDir: false, size: 12345, mime: 'image-jpeg' }), HREF_BASE) as {
      'd:propstat': { 'd:prop': Record<string, string> }
    }
    expect(r['d:propstat']['d:prop']['d:resourcetype']).toBe('')
    expect(r['d:propstat']['d:prop']['d:getcontenttype']).toBe('image/jpeg')
    expect(r['d:propstat']['d:prop']['d:getcontentlength']).toBe('12345')
  })

  it('returns a 200 OK propstat status (mounts are always represented as live entries)', () => {
    const r = buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:status': string } }
    expect(r['d:propstat']['d:status']).toBe('HTTP/1.1 200 OK')
  })

  it('passes mount.size through to oc:size so a computed folder size renders in the iOS info pane', () => {
    const r = buildShareMountPropResponse(mount({ size: 999_999 }), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(r['d:propstat']['d:prop']['oc:size']).toBe('999999')
  })

  it('clamps a missing or non-positive oc:size to 0', () => {
    const a = buildShareMountPropResponse(mount({ size: undefined as unknown as number }), HREF_BASE) as {
      'd:propstat': { 'd:prop': Record<string, string> }
    }
    const b = buildShareMountPropResponse(mount({ size: -42 }), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } }
    expect(a['d:propstat']['d:prop']['oc:size']).toBe('0')
    expect(b['d:propstat']['d:prop']['oc:size']).toBe('0')
  })
})
