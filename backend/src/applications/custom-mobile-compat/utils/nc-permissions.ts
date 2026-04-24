import { SPACE_OPERATION, SPACE_PERMS_SEP } from '../../spaces/constants/spaces'

// Nextcloud / ownCloud permission letters (the ones stock mobile clients
// understand). Emitted as a string of letters on <oc:permissions>, plus a
// numeric bitmask on <ocs:share-permissions>.
//
//   S  shared with me
//   R  can reshare
//   M  mounted from elsewhere
//   G  readable (get)
//   D  delete
//   N  rename (mv in place)
//   V  move between folders
//   W  write file contents (files only)
//   C  create child (folders only)
//   K  create / copy into collection (folders only)
//
// Bitmask: Read=1, Update=2, Create=4, Delete=8, Share=16.
//
// Reference implementation that iOS / Android trust: OxiCloud's
// webdav_handler.rs emits "RGDNVW" for files and "RGDNVCK" for folders when
// the caller has full control. We do the same and additionally add 'R'
// conditional on share-outside permission.

export interface NcPermissionsResult {
  // <oc:permissions> — letter string, order-insensitive
  letters: string
  // <ocs:share-permissions> — integer bitmask rendered as a decimal string
  shareMask: string
}

export type NcPermissionsMode = 'files' | 'trashbin'

// Map a Sync-in permission string like "a:d:m:si:so" plus a file's `isDir` flag
// to the NC letter+bitmask pair. `mode === 'trashbin'` always returns empty
// (trashed items are read-only on NC, you can only restore or delete — which
// the NC client models as "no permissions except its own trashbin actions").
export function toNcPermissions(
  syncinPermissions: string | undefined | null,
  isDir: boolean,
  mode: NcPermissionsMode = 'files'
): NcPermissionsResult {
  if (mode === 'trashbin') {
    return { letters: '', shareMask: '0' }
  }
  const ops = new Set((syncinPermissions ?? '').split(SPACE_PERMS_SEP).filter(Boolean))
  const canAdd = ops.has(SPACE_OPERATION.ADD)
  const canModify = ops.has(SPACE_OPERATION.MODIFY)
  const canDelete = ops.has(SPACE_OPERATION.DELETE)
  const canShareOut = ops.has(SPACE_OPERATION.SHARE_OUTSIDE)

  // G (get) is always implied — if the client saw the entry it can read it.
  const letters: string[] = ['G']
  if (canShareOut) letters.push('R')
  if (canDelete) letters.push('D')
  if (canModify) {
    letters.push('N') // rename in place
    letters.push('V') // move across folders
  }
  if (canAdd) {
    if (isDir) {
      letters.push('C') // create child in this collection
      letters.push('K') // accept copy/move-into (NC's separate bit for collections)
    } else {
      letters.push('W') // write file contents
    }
  }

  let mask = 1 // Read
  if (canModify) mask |= 2 // Update
  if (canAdd) mask |= 4 // Create
  if (canDelete) mask |= 8 // Delete
  if (canShareOut) mask |= 16 // Share

  return { letters: letters.join(''), shareMask: String(mask) }
}
