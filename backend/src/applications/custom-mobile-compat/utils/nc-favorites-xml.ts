// Wire-format helpers for Nextcloud favorites on the WebDAV surface.
//
// Two pure concerns live here (mirrors the nc-comment-xml.ts pattern):
//
//   1. parseFavoriteProppatch — classify a PROPPATCH body as favorite /
//      unfavorite / "not a favorite request". The stock NC clients send three
//      shapes against the file's own DAV URL (verified upstream — see
//      docs/plans/2026-06-11-nc-favorites-design.md):
//        iOS favorite    : <d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set>
//        iOS unfavorite  : <d:set><d:prop><oc:favorite>0</oc:favorite></d:prop></d:set>
//        Android favorite: same <d:set> … 1 form
//        Android unfavorite: <d:remove><d:prop><oc:favorite/></d:prop></d:remove>
//      Anything without an oc:favorite element (e.g. the mtime PROPPATCH the
//      upstream WebDAVMethods already handles) returns null so the caller
//      delegates to the existing handler untouched.
//
//   2. ncSubpathForFavorite — reverse-map a stored favorite's sync-in
//      repository path (navPath) into a path relative to the user's NC home,
//      or null when the favorite isn't reachable under that home. This is the
//      "home-reachable only" scoping for the Favorites REPORT: we never emit a
//      <d:href> the client can't navigate.

import { XMLParser } from 'fast-xml-parser'
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Keep values as strings — we must tell "1" from "0", not have them coerced
  // to truthy/falsy numbers (and an empty <oc:favorite/> must stay "").
  parseTagValue: false,
  parseAttributeValue: false,
  // Strip namespace prefixes so oc:favorite reads as either form.
  removeNSPrefix: true,
  trimValues: true
})

// Returns true to favorite, false to unfavorite, null when the body carries no
// oc:favorite directive (caller should delegate to the default PROPPATCH path).
export function parseFavoriteProppatch(body: string | Buffer | undefined | null): boolean | null {
  if (body === undefined || body === null) return null
  const xml = typeof body === 'string' ? body : body.toString('utf8')
  if (xml.trim().length === 0) return null

  let parsed: unknown
  try {
    parsed = xmlParser.parse(xml)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  // After removeNSPrefix: propertyupdate.{set,remove}.prop.favorite
  const root = pickFirst(parsed, 'propertyupdate')

  // <d:set> wins: an explicit favorite value of "1" favorites, anything else
  // (notably iOS's "0") unfavorites — matching upstream TagsPlugin's
  // `(int)$favState === 1 || $favState === 'true'`.
  const setProp = pickFirst(pickFirst(root, 'set'), 'prop')
  if (hasKey(setProp, 'favorite')) {
    const value = pickFirst(setProp, 'favorite')
    return String(value).trim() === '1'
  }

  // <d:remove> of oc:favorite is Android's unfavorite.
  const removeProp = pickFirst(pickFirst(root, 'remove'), 'prop')
  if (hasKey(removeProp, 'favorite')) return false

  return null
}

// The user's NC home, as resolved by NcPathResolverService.resolve(...,'').
export interface NcFavoriteHome {
  spaceAlias: string
  rootAlias: string | null
}

// Minimal shape of a share-mount (NcShareMountResolverService.listMounts).
interface MountLike {
  alias: string
}

// Reverse-map a stored favorite navPath into a path relative to the NC home,
// or null when it isn't navigable under that home (see module header).
//   files/personal/<rest>     → <rest>           (only when home is personal)
//   files/<spaceAlias>/<rest>  → <rest>           (only when home == that space)
//   shares/<alias>/<rest>      → <alias>/<rest>   (only when still mounted)
// Share-mounts overlay every NC home root, so a share favorite is reachable
// regardless of which home the user is on, as long as the mount still exists.
export function ncSubpathForFavorite(navPath: string, home: NcFavoriteHome, mounts: MountLike[]): string | null {
  const [repo, alias, ...rest] = navPath.split('/').filter(Boolean)

  if (repo === SPACE_REPOSITORY.SHARES) {
    if (!alias) return null
    return mounts.some((m) => m.alias === alias) ? [alias, ...rest].join('/') : null
  }

  if (repo === SPACE_REPOSITORY.FILES) {
    if (alias !== home.spaceAlias) return null
    let tail = rest
    if (home.rootAlias) {
      if (tail[0] !== home.rootAlias) return null
      tail = tail.slice(1)
    }
    return tail.join('/')
  }

  // trash and anything else is never favorited.
  return null
}

function pickFirst(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined
  const v = (node as Record<string, unknown>)[key]
  if (Array.isArray(v)) return v[0]
  return v
}

function hasKey(node: unknown, key: string): boolean {
  return !!node && typeof node === 'object' && key in (node as Record<string, unknown>)
}
