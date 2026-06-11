import { describe, expect, it } from 'vitest'
import { SPACE_ALIAS } from '../../spaces/constants/spaces'
import { ncSubpathForFavorite, parseFavoriteProppatch, type NcFavoriteHome } from './nc-favorites-xml'

// Verified wire forms (see docs/plans/2026-06-11-nc-favorites-design.md):
//   iOS  favorite : <d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set>
//   iOS  unfavorite: <d:set><d:prop><oc:favorite>0</oc:favorite></d:prop></d:set>
//   Android favorite: same <d:set> ... 1 form
//   Android unfavorite: <d:remove><d:prop><oc:favorite/></d:prop></d:remove>
const SET_FAVORITE = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set>
</d:propertyupdate>`

const SET_UNFAVORITE = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:favorite>0</oc:favorite></d:prop></d:set>
</d:propertyupdate>`

const REMOVE_FAVORITE = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:remove><d:prop><oc:favorite/></d:prop></d:remove>
</d:propertyupdate>`

const MTIME_ONLY = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set><d:prop><d:getlastmodified>Mon, 01 Jun 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:set>
</d:propertyupdate>`

describe('parseFavoriteProppatch', () => {
  it('returns true for an iOS/Android <d:set> oc:favorite=1', () => {
    expect(parseFavoriteProppatch(SET_FAVORITE)).toBe(true)
  })

  it('returns false for an iOS <d:set> oc:favorite=0', () => {
    expect(parseFavoriteProppatch(SET_UNFAVORITE)).toBe(false)
  })

  it('returns false for an Android <d:remove> of oc:favorite', () => {
    expect(parseFavoriteProppatch(REMOVE_FAVORITE)).toBe(false)
  })

  it('returns null for a PROPPATCH that does not touch oc:favorite (mtime only)', () => {
    expect(parseFavoriteProppatch(MTIME_ONLY)).toBeNull()
  })

  it('returns null for empty / missing / malformed bodies', () => {
    expect(parseFavoriteProppatch('')).toBeNull()
    expect(parseFavoriteProppatch(null)).toBeNull()
    expect(parseFavoriteProppatch(undefined)).toBeNull()
    expect(parseFavoriteProppatch('<not xml')).toBeNull()
  })
})

describe('ncSubpathForFavorite', () => {
  const personalHome: NcFavoriteHome = { spaceAlias: SPACE_ALIAS.PERSONAL, rootAlias: null }
  const mounts = [{ alias: 'team-share' }, { alias: 'photos' }]

  it('maps a personal favorite to the home-relative path when home is personal', () => {
    expect(ncSubpathForFavorite('files/personal/docs/report.pdf', personalHome, mounts)).toBe('docs/report.pdf')
  })

  it('maps a personal favorite at the home root to the bare file name', () => {
    expect(ncSubpathForFavorite('files/personal/report.pdf', personalHome, mounts)).toBe('report.pdf')
  })

  it('maps a mounted-share favorite to <alias>/<rest> under any home', () => {
    expect(ncSubpathForFavorite('shares/team-share/spec.md', personalHome, mounts)).toBe('team-share/spec.md')
  })

  it('omits a share favorite whose mount the user no longer has', () => {
    expect(ncSubpathForFavorite('shares/gone/spec.md', personalHome, mounts)).toBeNull()
  })

  it('omits a collaborative-space favorite when the home is personal', () => {
    expect(ncSubpathForFavorite('files/marketing/plan.xlsx', personalHome, mounts)).toBeNull()
  })

  it('maps a space favorite when the home points at that space', () => {
    const spaceHome: NcFavoriteHome = { spaceAlias: 'marketing', rootAlias: null }
    expect(ncSubpathForFavorite('files/marketing/plan.xlsx', spaceHome, mounts)).toBe('plan.xlsx')
  })

  it('omits a personal favorite when the home is a collaborative space', () => {
    const spaceHome: NcFavoriteHome = { spaceAlias: 'marketing', rootAlias: null }
    expect(ncSubpathForFavorite('files/personal/x.txt', spaceHome, mounts)).toBeNull()
  })

  it('honors an explicit root alias on the home (matches and strips it)', () => {
    const rootHome: NcFavoriteHome = { spaceAlias: 'marketing', rootAlias: 'designs' }
    expect(ncSubpathForFavorite('files/marketing/designs/logo.svg', rootHome, mounts)).toBe('logo.svg')
    expect(ncSubpathForFavorite('files/marketing/other/logo.svg', rootHome, mounts)).toBeNull()
  })

  it('never matches a trash path', () => {
    expect(ncSubpathForFavorite('trash/personal/old.txt', personalHome, mounts)).toBeNull()
  })
})
