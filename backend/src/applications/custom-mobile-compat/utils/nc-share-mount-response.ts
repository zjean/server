// Build a virtual <d:response> entry for a share-mount root.
//
// NcPropfindService appends one of these per row from
// NcShareMountResolverService.listMounts() when iOS PROPFINDs the user's NC
// home root. From the client's perspective the result is indistinguishable
// from a real folder living in the home — except for the badge: oc:permissions
// carries 'S' (shared with me), which NCListCell.swift:441 turns into the
// "shared with me" folder icon. nc:mount-type='shared' is emitted alongside
// as informational, mirroring real NC's wire format.
//
// fileId is the underlying file's real DB id, so a follow-up
// /remote.php/dav/files/{user}/<share.alias>/ PROPFIND can also surface the
// same id from the donor space — keeping iOS's offline cache consistent
// across both routing paths.

import type { NcShareMount } from '../services/nc-share-mount-resolver.service'
import { buildOcId, ncFileId } from './nc-oc-id'
import { toNcPermissions } from './nc-permissions'

const HTTP_OK_PROPSTAT_STATUS = 'HTTP/1.1 200 OK'

// Encode a single NC <d:href> path segment to match sabre/dav's rawurlencode
// output. Exported because both the mount-root entry's href and the home-root
// hrefBase (`{user.login}`) need the same encoding — real NC and iOS expect
// byte-for-byte equality on segment encoding for cache key reconciliation.
//
// `encodeURIComponent` differs from PHP `rawurlencode` on five ASCII chars:
// `!`, `'`, `(`, `)`, `*` — sabre encodes them, JS doesn't. A share alias
// like "Alice's Photos" round-trips wrong without this patch.
export function rawurlencodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A')
}

// hrefBase is the NC URL of the home root, e.g.
// '/remote.php/dav/files/bob/'. Used as the parent path for the mount-root
// <d:href>; must already include the trailing slash.
export function buildShareMountPropResponse(mount: NcShareMount, hrefBase: string): Record<string, unknown> {
  const href = `${hrefBase}${rawurlencodeSegment(mount.alias)}/`
  // Share-mount entries always live in 'files' mode (trashbin doesn't surface
  // mounts) and are always the root of their own mount — so isRoot semantics
  // for permission emission don't apply here; we use the share's intersected
  // permissions directly with the S flag set.
  const { letters, shareMask } = toNcPermissions(mount.permissions, mount.isDir, 'files', true)
  const positiveId = ncFileId(mount.fileId)
  const mtime = Number.isFinite(mount.mtime) ? Math.max(0, Math.trunc(mount.mtime)) : 0
  const ownerLogin = mount.owner.login
  const ownerDisplay = mount.owner.fullName || ownerLogin
  const resourcetype = mount.isDir ? { 'd:collection': '' } : ''
  const contentType = mount.mime ? normalizeMime(mount.mime) : undefined

  const props: Record<string, unknown> = {
    'd:displayname': mount.name,
    'd:getlastmodified': new Date(mtime).toUTCString(),
    // Strong ETag (no W/ prefix — iOS uses this verbatim as a thumbnail-path
    // component, see nc-prop-builder.ts:111 comment).
    'd:getetag': `"${positiveId}-${mtime}"`,
    'd:resourcetype': resourcetype,
    'oc:id': buildOcId(mount.fileId),
    'oc:fileid': String(positiveId),
    'oc:permissions': letters,
    'ocs:share-permissions': shareMask,
    // Pass the stored size through. For files this is the byte size; for
    // folder mount-roots Sync-in stores 0 until a folder-size recompute fires
    // (see folder-size action) — emit it as-is so a recomputed folder shows
    // its size in iOS's long-press info pane rather than a misleading 0 B.
    'oc:size': String(Math.max(0, Math.trunc(mount.size ?? 0))),
    'oc:owner-id': ownerLogin,
    'oc:owner-display-name': ownerDisplay,
    // Empty <oc:share-types> — share-types lists who *I* shared the file
    // with. For shares received from someone else this stays empty (the
    // 'S' in oc:permissions is the recipient-side marker).
    'oc:share-types': '',
    'nc:has-preview': 'false',
    'oc:comments-unread': '0',
    'nc:is-encrypted': '0',
    // mount-type='shared' is informational; the badge is driven by 'S' in
    // oc:permissions. Real NC emits both.
    'nc:mount-type': 'shared'
  }

  if (!mount.isDir && contentType) {
    props['d:getcontenttype'] = contentType
    props['d:getcontentlength'] = String(Math.max(0, Math.trunc(mount.size ?? 0)))
  }

  return {
    'd:href': href,
    'd:propstat': {
      'd:prop': props,
      'd:status': HTTP_OK_PROPSTAT_STATUS
    }
  }
}

// Translate Sync-in's stored mime ("image-jpeg") back to standard form
// ("image/jpeg"). Sync-in replaces the first '/' with '-' on storage; NC
// clients want the standard form on the wire. Single-replace is load-bearing
// — only the first hyphen is the encoded slash; subsequent hyphens (e.g.
// "vnd-ms-excel") are real subtype separators that must survive.
function normalizeMime(mime: string): string {
  return mime.replace('-', '/')
}
