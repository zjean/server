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
  parent: null
  expiration: null
  token: null
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
  // Sync-in stores mtime in ms; NC OCS expects seconds. ctime is the share
  // creation time conceptually, but shareRootFiles only carries the *file*'s
  // ctime — close enough for the iOS Shares tab which just sorts on it.
  const stime = Math.max(0, Math.floor((mount.ctime ?? 0) / 1000))
  const item_mtime = Math.max(0, Math.floor((mount.mtime ?? 0) / 1000))
  // canEdit/canDelete are derived from the share's permission bitmask.
  // bit 2 = UPDATE, bit 8 = DELETE (matches NC's Constants::PERMISSION_*).
  const canEdit = (permissions & 2) !== 0
  const canDelete = (permissions & 8) !== 0

  return {
    id: String(mount.shareId),
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
    has_preview: false,
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
