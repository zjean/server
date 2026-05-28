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

// hrefBase is the NC URL of the home root, e.g.
// '/remote.php/dav/files/bob/'. Used as the parent path for the mount-root
// <d:href>; must already include the trailing slash.
export function buildShareMountPropResponse(mount: NcShareMount, hrefBase: string): Record<string, unknown> {
  const href = `${hrefBase}${encodeNcSegment(mount.alias)}/`
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
    // Folder sizes aren't cheap to compute here; emit 0 to match real NC's
    // behaviour for incoming mount roots (real NC also doesn't recurse).
    'oc:size': '0',
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

// Encode a single path segment for inclusion in an NC <d:href>. NC clients
// re-use the href verbatim as a follow-up URL, so the encoding must round-
// trip through their URL parser. We encode the standard URI-reserved set
// EXCEPT '/' (kept as-is — though share aliases shouldn't contain it).
function encodeNcSegment(seg: string): string {
  return encodeURIComponent(seg)
}

// Translate Sync-in's stored mime ("image-jpeg") back to standard form
// ("image/jpeg"). Sync-in replaces the first '/' with '-' on storage; NC
// clients want the standard form on the wire.
function normalizeMime(mime: string): string {
  return mime.replace('-', '/')
}
