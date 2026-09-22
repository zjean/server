import { describe, expect, it } from 'vitest'
import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SHARE_TYPE } from '../../shares/constants/shares'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { buildNcDeletedResponse, buildNcPropResponse } from './nc-prop-builder'

// Every prop this builder emits is a wire contract with a stock NC client, and
// several of them are typed the OPPOSITE way to their neighbours — `oc:favorite`
// is the integer "1"/"0" while `nc:has-preview` is the word "true"/"false",
// because Android parses the first with an exact `"1" ==` compare and the second
// with `Boolean.valueOf`. Prose in a comment cannot fail a build; these can.

const FIXED_MTIME = 1_716_891_600_000 // 2024-05-28T09:00:00Z, in ms — Sync-in's storage unit

function file(over: Partial<Record<string, unknown>> = {}): WebDAVFile {
  return new WebDAVFile(
    {
      id: 100,
      name: 'pic.jpg',
      isDir: false,
      size: 1234,
      ctime: FIXED_MTIME,
      mtime: FIXED_MTIME,
      mime: 'image-jpeg',
      ...over
    } as never,
    '/remote.php/dav/files/alice/'
  )
}

function spaceEnv(over: Partial<Record<string, unknown>> = {}): SpaceEnv {
  return {
    id: 0,
    alias: SPACE_ALIAS.PERSONAL,
    envPermissions: SPACE_ALL_OPERATIONS,
    permissions: SPACE_ALL_OPERATIONS,
    repository: SPACE_REPOSITORY.FILES,
    root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } },
    ...over
  } as unknown as SpaceEnv
}

const space = spaceEnv()

interface Built {
  'd:href': string
  'd:propstat': { 'd:prop': Record<string, unknown>; 'd:status': string }
}

function props(...args: Parameters<typeof buildNcPropResponse>): Record<string, unknown> {
  return (buildNcPropResponse(...args) as unknown as Built)['d:propstat']['d:prop']
}

describe('buildNcPropResponse — boolean-ish props are independently typed', () => {
  // The two live side by side deliberately: one word-form, one integer-form, in
  // the same response. A "tidy-up" that unifies them breaks one client each way.
  it('emits nc:has-preview as the WORD form and oc:favorite as the INTEGER form, in the same response', () => {
    const p = props(file(), space, 'files', false, 'Alice', undefined, undefined, true)
    expect(p['nc:has-preview']).toBe('true')
    expect(p['oc:favorite']).toBe('1')
  })

  it('emits the negatives the same way — "false" for has-preview, "0" for favorite', () => {
    const p = props(file({ mime: 'application-pdf' }), space, 'files', false, 'Alice', undefined, undefined, false)
    expect(p['nc:has-preview']).toBe('false')
    expect(p['oc:favorite']).toBe('0')
  })

  it('defaults oc:favorite to "0" when the isFavorite argument is omitted', () => {
    expect(props(file(), space, 'files', false, 'Alice')['oc:favorite']).toBe('0')
  })

  it('treats the stored `image-jpeg` mime spelling as previewable (Sync-in stores the slash as a dash)', () => {
    expect(props(file({ mime: 'image-png' }), space, 'files', false)['nc:has-preview']).toBe('true')
  })

  it('emits oc:comments-unread as the integer form, driven by hasComments', () => {
    const withComments = Object.assign(file(), { hasComments: true })
    expect(props(withComments, space, 'files', false)['oc:comments-unread']).toBe('1')
    expect(props(file(), space, 'files', false)['oc:comments-unread']).toBe('0')
  })
})

describe('buildNcPropResponse — ETags are strong', () => {
  // WebDAVFile.getetag goes through genEtag with weakPrefix defaulting to true,
  // so the raw value really is `W/"…"`. iOS uses the etag verbatim as a path
  // component for its on-disk thumbnail, and the `/` in `W/` becomes a missing
  // directory — thumbnails silently vanish for every image.
  it('strips the W/ prefix Sync-in’s genEtag adds', () => {
    const f = file()
    expect(f.getetag).toMatch(/^W\//)
    expect(props(f, space, 'files', false)['d:getetag']).toBe(f.getetag.replace('W/', ''))
  })

  it('falls back to a strong id-mtime etag when the file exposes none (directories)', () => {
    const dir = file({ isDir: true, name: 'photos', id: 77 })
    expect(dir.getetag).toBeUndefined()
    expect(props(dir, space, 'files', false)['d:getetag']).toBe(`"77-${FIXED_MTIME}"`)
  })
})

describe('buildNcPropResponse — owner resolution precedence', () => {
  const noOwnerSpace = spaceEnv({ root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS } })
  const requester = { login: 'bob', displayName: 'Bob Builder' }

  it('1. an explicit ownerDisplayName wins over everything else', () => {
    const p = props(file(), space, 'files', false, 'Alice Liddell', undefined, requester)
    expect(p['oc:owner-display-name']).toBe('Alice Liddell')
    // …while owner-id still comes from the space, not the requester.
    expect(p['oc:owner-id']).toBe('alice')
  })

  it('2. the requester fallback supplies both id and display name when the space root has no owner', () => {
    const p = props(file(), noOwnerSpace, 'files', false, '', undefined, requester)
    expect(p['oc:owner-id']).toBe('bob')
    expect(p['oc:owner-display-name']).toBe('Bob Builder')
  })

  it('3. the explicit space owner’s login is used when no display name is known', () => {
    const p = props(file(), space, 'files', false, '', undefined, requester)
    expect(p['oc:owner-id']).toBe('alice')
    // The explicit owner beats the requester fallback — a shared space must not
    // be reported as owned by whoever is looking at it.
    expect(p['oc:owner-display-name']).toBe('alice')
  })

  it('4. falls back to empty strings when nothing identifies an owner', () => {
    const p = props(file(), noOwnerSpace, 'files', false)
    expect(p['oc:owner-id']).toBe('')
    expect(p['oc:owner-display-name']).toBe('')
  })

  it('never leaves oc:owner-id empty when a requester fallback is available (Android gates canCreate on it)', () => {
    expect(props(file(), noOwnerSpace, 'files', true, '', undefined, requester)['oc:owner-id']).toBe('bob')
  })
})

describe('buildNcPropResponse — oc:share-types', () => {
  const withShares = (shares: { id: number; alias: string; name: string; type: SHARE_TYPE }[]) =>
    props(Object.assign(file(), { shares }), space, 'files', false)['oc:share-types']

  // The empty STRING (not an empty object, not undefined) is what makes
  // fast-xml-parser emit `<oc:share-types></oc:share-types>`, which is the shape
  // real NC emits for an unshared file and the one iOS expects to find.
  it('is the empty string when the file carries no shares', () => {
    expect(props(file(), space, 'files', false)['oc:share-types']).toBe('')
  })

  it('is the empty string when the shares array is present but empty', () => {
    expect(withShares([])).toBe('')
  })

  it('maps a LINK share to NC code 3 and a COMMON share to NC code 0', () => {
    expect(withShares([{ id: 1, alias: 'a', name: 'a', type: SHARE_TYPE.LINK }])).toEqual({ 'oc:share-type': ['3'] })
    expect(withShares([{ id: 1, alias: 'a', name: 'a', type: SHARE_TYPE.COMMON }])).toEqual({ 'oc:share-type': ['0'] })
  })

  it('DEDUPES repeats — three user shares are one <oc:share-type>0</oc:share-type>', () => {
    expect(
      withShares([
        { id: 1, alias: 'a', name: 'a', type: SHARE_TYPE.COMMON },
        { id: 2, alias: 'b', name: 'b', type: SHARE_TYPE.COMMON },
        { id: 3, alias: 'c', name: 'c', type: SHARE_TYPE.COMMON }
      ])
    ).toEqual({ 'oc:share-type': ['0'] })
  })

  it('keeps both codes, in first-seen order, when the file is shared both ways', () => {
    expect(
      withShares([
        { id: 1, alias: 'a', name: 'a', type: SHARE_TYPE.LINK },
        { id: 2, alias: 'b', name: 'b', type: SHARE_TYPE.COMMON },
        { id: 3, alias: 'c', name: 'c', type: SHARE_TYPE.LINK }
      ])
    ).toEqual({ 'oc:share-type': ['3', '0'] })
  })
})

describe('buildNcPropResponse — the trashbin branch', () => {
  const trashSpace = spaceEnv({ alias: 'personal', repository: SPACE_REPOSITORY.TRASH })

  it('adds the three nc:trashbin-* props only in trashbin mode', () => {
    const live = props(file(), space, 'files', false)
    expect(live['nc:trashbin-filename']).toBeUndefined()
    expect(live['nc:trashbin-original-location']).toBeUndefined()
    expect(live['nc:trashbin-deletion-time']).toBeUndefined()

    const trashed = props(file(), trashSpace, 'trashbin', false)
    expect(trashed['nc:trashbin-filename']).toBe('pic.jpg')
    expect(trashed['nc:trashbin-deletion-time']).toBeDefined()
  })

  it('emits nc:trashbin-deletion-time in unix SECONDS, floored — mtime is stored in ms', () => {
    const f = file({ mtime: FIXED_MTIME + 999 })
    expect(props(f, trashSpace, 'trashbin', false)['nc:trashbin-deletion-time']).toBe(String(Math.floor((FIXED_MTIME + 999) / 1000)))
  })

  it('strips a sabre-style ".d<unix-ts>" suffix from nc:trashbin-filename', () => {
    expect(props(file({ name: 'report.docx.d1716891600' }), trashSpace, 'trashbin', false)['nc:trashbin-filename']).toBe('report.docx')
  })

  it('leaves a name alone when the trailing dot-segment is not all digits', () => {
    expect(props(file({ name: 'archive.tar.gz' }), trashSpace, 'trashbin', false)['nc:trashbin-filename']).toBe('archive.tar.gz')
  })

  it('prefers the recorded origin path for nc:trashbin-original-location', () => {
    const f = Object.assign(file(), { origin: { spaceRootExternalPath: 'Documents/2024/pic.jpg' } })
    expect(props(f, trashSpace, 'trashbin', false)['nc:trashbin-original-location']).toBe('Documents/2024/pic.jpg')
  })

  it('falls back to <space alias>/<name> when no origin was recorded', () => {
    expect(
      props(file(), spaceEnv({ alias: 'shared-space', repository: SPACE_REPOSITORY.TRASH }), 'trashbin', false)['nc:trashbin-original-location']
    ).toBe('shared-space/pic.jpg')
  })

  it('falls back to the bare name when the space has no alias either', () => {
    expect(props(file(), spaceEnv({ alias: '', repository: SPACE_REPOSITORY.TRASH }), 'trashbin', false)['nc:trashbin-original-location']).toBe(
      'pic.jpg'
    )
  })

  it('reports no permission letters in trashbin mode (restore/delete are the client’s own actions)', () => {
    const p = props(file(), trashSpace, 'trashbin', false)
    expect(p['oc:permissions']).toBe('')
    expect(p['ocs:share-permissions']).toBe('0')
  })
})

describe('buildNcPropResponse — files vs collections', () => {
  it('omits d:getcontentlength / d:getcontenttype for a collection and reports oc:size 0', () => {
    const p = props(file({ isDir: true, name: 'photos', size: 4096 }), space, 'files', false)
    expect(p['d:resourcetype']).toEqual({ 'd:collection': '' })
    expect(p).not.toHaveProperty('d:getcontentlength')
    expect(p).not.toHaveProperty('d:getcontenttype')
    expect(p['oc:size']).toBe('0')
  })

  it('emits an EMPTY-STRING resourcetype for a file, plus its length and its de-dashed mime', () => {
    const p = props(file(), space, 'files', false)
    expect(p['d:resourcetype']).toBe('')
    expect(p['d:getcontentlength']).toBe('1234')
    // Stored as `image-jpeg`; only the FIRST dash is the encoded slash.
    expect(p['d:getcontenttype']).toBe('image/jpeg')
  })

  it('turns only the first dash back into a slash on a hyphenated subtype', () => {
    expect(props(file({ mime: 'application-vnd-ms-excel' }), space, 'files', false)['d:getcontenttype']).toBe('application/vnd-ms-excel')
  })

  it('emits a positive oc:fileid / zero-padded oc:id even for an inode-derived negative id', () => {
    const p = props(file({ id: -424242 }), space, 'files', false)
    expect(p['oc:fileid']).toBe('424242')
    expect(p['oc:id']).toBe('00000000000000424242syncin')
  })
})

describe('buildNcPropResponse — the root quota block', () => {
  it('emits the -3 "unlimited" sentinel when no cap is configured', () => {
    const p = props(file({ isDir: true, name: 'alice' }), space, 'files', true, '', { used: 500 })
    expect(p['d:quota-used-bytes']).toBe('500')
    expect(p['d:quota-available-bytes']).toBe('-3')
  })

  it('emits the remaining bytes when a cap is configured, never below zero', () => {
    expect(props(file({ isDir: true }), space, 'files', true, '', { used: 300, total: 1000 })['d:quota-available-bytes']).toBe('700')
    expect(props(file({ isDir: true }), space, 'files', true, '', { used: 5000, total: 1000 })['d:quota-available-bytes']).toBe('0')
  })

  it('is absent on children, in trashbin mode, and when no quota was passed', () => {
    expect(props(file(), space, 'files', false, '', { used: 500 })).not.toHaveProperty('d:quota-used-bytes')
    expect(props(file(), space, 'trashbin', true, '', { used: 500 })).not.toHaveProperty('d:quota-used-bytes')
    expect(props(file({ isDir: true }), space, 'files', true)).not.toHaveProperty('d:quota-used-bytes')
  })
})

describe('buildNcPropResponse — permission source', () => {
  // envPermissions is DELETE-stripped at virtual endpoints so the user cannot
  // trash their own personal-space root; children always get the full set.
  const asymmetric = spaceEnv({ envPermissions: 'a:m', permissions: SPACE_ALL_OPERATIONS })

  it('the root response reads envPermissions', () => {
    expect(props(file({ isDir: true }), asymmetric, 'files', true)['oc:permissions']).not.toMatch(/D/)
  })

  it('a child response reads the full space permissions', () => {
    expect(props(file(), asymmetric, 'files', false)['oc:permissions']).toMatch(/D/)
  })
})

describe('buildNcPropResponse — invariants of the envelope', () => {
  it('carries the href and a 200 propstat status', () => {
    const r = buildNcPropResponse(file(), space, 'files', false) as unknown as Built
    expect(r['d:href']).toBe('/remote.php/dav/files/alice/pic.jpg')
    expect(r['d:propstat']['d:status']).toBe('HTTP/1.1 200 OK')
  })

  it('emits d:getlastmodified in RFC1123 (mtime is ms; this field is the one that stays a date)', () => {
    expect(props(file(), space, 'files', false)['d:getlastmodified']).toBe(new Date(FIXED_MTIME).toUTCString())
  })

  it('does NOT emit nc:lock-* props — the clients gate the lock UI on a capability we do not advertise', () => {
    const p = props(file(), space, 'files', false)
    expect(Object.keys(p).filter((k) => k.startsWith('nc:lock'))).toEqual([])
  })
})

describe('buildNcDeletedResponse', () => {
  // RFC 6578 §3.2: a removed member's DAV:response MUST carry a DAV:status of
  // 404 and MUST NOT carry any DAV:propstat.
  it('is an href plus a 404 status, with no propstat block at all', () => {
    const r = buildNcDeletedResponse('/remote.php/dav/files/alice/gone.txt')
    expect(r).toEqual({ 'd:href': '/remote.php/dav/files/alice/gone.txt', 'd:status': 'HTTP/1.1 404 Not Found' })
    expect(r).not.toHaveProperty('d:propstat')
  })
})
