import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import type { NcShareMount } from '../services/nc-share-mount-resolver.service'
import { buildNcPropResponse } from './nc-prop-builder'
import { buildShareMountPropResponse, rawurlencodeSegment } from './nc-share-mount-response'

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

describe('buildShareMountPropResponse — divergence from the PROPFIND prop set', () => {
  const HREF_BASE = '/remote.php/dav/files/bob/'

  // Mount-root entries are synthesized here rather than by buildNcPropResponse,
  // so the two prop sets can drift silently. This case is the tripwire: it names
  // the ONE prop the mount root does not carry, so adding or dropping any other
  // prop on either side fails here instead of in a client.
  //
  // `oc:favorite` is that prop, and its absence is a real divergence, not a
  // decision: NC clients read a missing `oc:favorite` as not-favorited, so a
  // starred share-mount root shows unstarred at the home listing while the same
  // folder shows starred when PROPFINDed directly. Tracked by #488 — when it is
  // fixed, move the key out of MOUNT_OMITS and into the equality below.
  const MOUNT_OMITS = ['oc:favorite']

  function livePropKeys(): string[] {
    const space = {
      id: 0,
      alias: SPACE_ALIAS.PERSONAL,
      envPermissions: SPACE_ALL_OPERATIONS,
      permissions: SPACE_ALL_OPERATIONS,
      repository: SPACE_REPOSITORY.FILES,
      root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } }
    } as unknown as SpaceEnv
    const dir = new WebDAVFile(
      { id: 9001, name: 'alice-photos', isDir: true, size: 0, ctime: 1_716_891_500_000, mtime: 1_716_891_600_000, mime: '' } as never,
      HREF_BASE
    )
    const r = buildNcPropResponse(dir, space, 'files', false, 'Alice Liddell') as unknown as {
      'd:propstat': { 'd:prop': Record<string, unknown> }
    }
    return Object.keys(r['d:propstat']['d:prop'])
  }

  it('omits oc:favorite — and omits NOTHING ELSE the live PROPFIND path emits for the same folder', () => {
    const mountKeys = Object.keys(
      (buildShareMountPropResponse(mount(), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, unknown> } })['d:propstat']['d:prop']
    )
    expect(mountKeys).not.toContain('oc:favorite')
    expect([...mountKeys].sort()).toEqual([...livePropKeys().filter((k) => !MOUNT_OMITS.includes(k))].sort())
  })
})

describe('buildShareMountPropResponse — mime and timestamp translation', () => {
  const HREF_BASE = '/remote.php/dav/files/bob/'
  const props = (over: Partial<NcShareMount> = {}) =>
    (buildShareMountPropResponse(mount(over), HREF_BASE) as { 'd:propstat': { 'd:prop': Record<string, string> } })['d:propstat']['d:prop']

  // Sync-in stores a mime by replacing only its FIRST '/' with '-'. Turning
  // every dash back into a slash emits `application/vnd.openxmlformats/…` for
  // a .docx, and both clients compare the directEditing mimetype with exact
  // equality — so the Edit affordance silently disappears.
  it('turns only the FIRST dash back into a slash', () => {
    expect(props({ isDir: false, size: 10, mime: 'application-vnd-ms-excel' })['d:getcontenttype']).toBe('application/vnd-ms-excel')
    expect(props({ isDir: false, size: 10, mime: 'text-x-python' })['d:getcontenttype']).toBe('text/x-python')
  })

  it('emits no content-type / content-length for a file mount with no stored mime', () => {
    const p = props({ isDir: false, size: 10, mime: '' })
    expect(p).not.toHaveProperty('d:getcontenttype')
    expect(p).not.toHaveProperty('d:getcontentlength')
  })

  it('never emits content-type / content-length for a folder mount, even if a mime is set', () => {
    const p = props({ isDir: true, mime: 'image-jpeg' })
    expect(p).not.toHaveProperty('d:getcontenttype')
    expect(p).not.toHaveProperty('d:getcontentlength')
  })

  // mtime is stored in MILLISECONDS. d:getlastmodified is the field that keeps
  // a date rather than being divided down to seconds, so a unit slip here shows
  // up as a 1970 date on the client rather than as an error.
  it('renders the ms mtime as an RFC1123 date', () => {
    expect(props()['d:getlastmodified']).toBe(new Date(1_716_891_600_000).toUTCString())
  })

  it('clamps a non-finite or negative mtime to the epoch rather than emitting "Invalid Date"', () => {
    expect(props({ mtime: Number.NaN as number })['d:getlastmodified']).toBe(new Date(0).toUTCString())
    expect(props({ mtime: -1 })['d:getlastmodified']).toBe(new Date(0).toUTCString())
  })

  it('keys the etag on the same clamped mtime it reports', () => {
    expect(props({ mtime: Number.NaN as number })['d:getetag']).toBe('"9001-0"')
  })

  it('never claims a preview for a mount root (the home listing has no thumbnail for it)', () => {
    expect(props()['nc:has-preview']).toBe('false')
  })

  it('emits oc:comments-unread and nc:is-encrypted in the integer form', () => {
    expect(props()['oc:comments-unread']).toBe('0')
    expect(props()['nc:is-encrypted']).toBe('0')
  })
})

describe('rawurlencodeSegment', () => {
  // sabre/dav encodes with PHP rawurlencode, which differs from JS
  // encodeURIComponent on exactly five ASCII characters. iOS reconciles its
  // offline cache on byte-for-byte href equality, so the five matter.
  it.each([
    ['!', '%21'],
    ["'", '%27'],
    ['(', '%28'],
    [')', '%29'],
    ['*', '%2A']
  ])('escapes %s, which encodeURIComponent leaves bare', (raw, encoded) => {
    expect(encodeURIComponent(raw)).toBe(raw)
    expect(rawurlencodeSegment(raw)).toBe(encoded)
  })

  it('leaves the unreserved set alone', () => {
    expect(rawurlencodeSegment('abcXYZ019-_.~')).toBe('abcXYZ019-_.~')
  })

  it('encodes a slash, so an alias can never break out of its own href segment', () => {
    expect(rawurlencodeSegment('a/b')).toBe('a%2Fb')
  })
})
