// Build one OCS share record matching upstream NC's ShareAPIController::formatShare
// output shape (apps/files_sharing/lib/Controller/ShareAPIController.php:124-209).
//
// Used by NcOcsSharesController to populate the iOS "Shares" tab (NCShares.swift)
// and any client that calls /ocs/v{1,2}.php/apps/files_sharing/api/v1/shares with
// shared_with_me=true. iOS keys on `file_source` (=fileId) to look up the matching
// local PROPFIND metadata for rendering — that fileId MUST equal the underlying
// file's real DB id we emit elsewhere (oc:fileid in PROPFIND, mount fileId in
// nc-share-mount-resolver) or iOS won't find the file and the row will stay empty.

import type { NcShareMount } from '../services/nc-share-mount-resolver.service'
import { toNcPermissions } from './nc-permissions'
import { ncHasPreview } from './nc-preview-predicate'

// NC OCS share-record. Field names are wire-format; do not rename them.
// `share_type` codes:
//   0 = user (NC IShare::TYPE_USER)        — what we emit for incoming shares
//   1 = group
//   3 = public link
//   4 = email
// 7+ = federation / talk / deck / etc. — out of scope
export interface NcOcsShareRecord {
  id: string
  share_type: number
  uid_owner: string
  displayname_owner: string
  uid_file_owner: string
  displayname_file_owner: string
  permissions: number
  can_edit: boolean
  can_delete: boolean
  stime: number
  // Sub-share parent id (NC only sets this for re-shares; we don't model
  // resharing on the recipient side, so it's null today). Typed as nullable
  // number rather than `null` literal so a future emitter that actually
  // populates it doesn't have to widen the interface.
  parent: number | null
  expiration: string | null
  token: string | null
  note: string
  label: string
  path: string
  item_type: 'file' | 'folder'
  item_permissions: number
  item_source: number
  file_source: number
  file_parent: number
  file_target: string
  item_size: number
  item_mtime: number
  mimetype: string
  has_preview: boolean
  storage_id: string
  storage: number
  'is-mount-root': boolean
  'mount-type': 'shared'
  // share_with would identify the recipient — for shared-with-me records iOS
  // doesn't need it (the recipient IS the requester). Real NC emits it, so
  // we mirror that to be wire-compatible.
  share_with: string
  share_with_displayname: string
  share_with_displayname_unique: string
}

// recipient = the requester (Bob). Donor = mount.owner (Alice).
export function buildSharedWithMeRecord(mount: NcShareMount, recipient: { login: string; fullName: string }): NcOcsShareRecord {
  const { shareMask } = toNcPermissions(mount.permissions, mount.isDir, 'files')
  const permissions = Number(shareMask)
  // Sync-in stores mtime in ms; NC OCS expects seconds. We use the *file*'s
  // ctime as a proxy for the share's creation time — the actual share
  // createdAt isn't carried by SharesQueries.shareRootFiles (would need an
  // upstream mod commit to add to the SELECT). The iOS Shares tab only uses
  // stime for sorting; file-ctime keeps a stable ordering for the
  // non-recent-resharing case which covers all of Sync-in's shares today.
  // If we ever start re-issuing shares for the same file, this will sort
  // by file-update-time rather than share-creation-time — accept that.
  const stime = Math.max(0, Math.floor((mount.ctime ?? 0) / 1000))
  const item_mtime = Math.max(0, Math.floor((mount.mtime ?? 0) / 1000))
  // canEdit/canDelete are derived from the share's permission bitmask.
  // bit 2 = UPDATE, bit 8 = DELETE (matches NC's Constants::PERMISSION_*).
  const canEdit = (permissions & 2) !== 0
  const canDelete = (permissions & 8) !== 0

  return {
    id: String(mount.shareId),
    // Always 0 (NC IShare::TYPE_USER). Sync-in's SHARE_TYPE.COMMON maps to
    // this — we don't model group / link / federated shares as recipient-
    // side mountpoints (links go via a different controller, group / fed
    // are out of scope for this fork). If that ever changes, derive from
    // the share-member-type rather than hardcoding.
    share_type: 0,
    uid_owner: mount.owner.login,
    displayname_owner: mount.owner.fullName || mount.owner.login,
    uid_file_owner: mount.owner.login,
    displayname_file_owner: mount.owner.fullName || mount.owner.login,
    permissions,
    can_edit: canEdit,
    can_delete: canDelete,
    stime,
    parent: null,
    expiration: null,
    token: null,
    note: '',
    label: '',
    // recipient-relative path — the mount appears at /<alias> in their home.
    path: `/${mount.alias}`,
    item_type: mount.isDir ? 'folder' : 'file',
    item_permissions: permissions,
    item_source: mount.fileId,
    file_source: mount.fileId,
    // NC clients don't rely on file_parent for shared-with-me rows; emit 0
    // to indicate "no NC-visible parent" (the home root has no fileId).
    file_parent: 0,
    file_target: `/${mount.alias}`,
    item_size: Math.max(0, Math.trunc(mount.size ?? 0)),
    item_mtime,
    mimetype: normalizeMime(mount.mime),
    // True for image mimes so iOS renders a thumbnail on the Shares-tab
    // row. ncHasPreview is the same predicate the PROPFIND builder uses,
    // so the Shares tab and the home browser agree on what's previewable.
    has_preview: ncHasPreview(mount.mime),
    storage_id: `home::${recipient.login}`,
    storage: 1,
    'is-mount-root': true,
    'mount-type': 'shared',
    share_with: recipient.login,
    share_with_displayname: recipient.fullName || recipient.login,
    share_with_displayname_unique: recipient.login
  }
}

function normalizeMime(mime: string | undefined): string {
  if (!mime) return ''
  return mime.replace('-', '/')
}
