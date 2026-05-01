// Build a single NC-flavored <d:response> entry for a WebDAVFile.
//
// Extracted from NcPropfindService.buildResponse so both the PROPFIND verb
// and the REPORT (sync-collection) verb emit byte-identical prop blocks.
// Pure function — no `this` state, no DI; trivially testable in isolation.
//
// Boolean DAV props in the oc/nc namespaces are emitted as integer strings
// ("1"/"0"), not "true"/"false" — that's the owncloud convention NC clients
// depend on (NextcloudKit reads them with `Int(text) == 1`). Anything boolean
// added here MUST follow the same shape; see #134 for the bug history.

import type { FileLockProps, FileProps } from '../../files/interfaces/file-props.interface'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { buildOcId, ncFileId } from './nc-oc-id'
import { toNcPermissions, type NcPermissionsMode } from './nc-permissions'
import { ncHasPreview } from './nc-preview-predicate'

const HTTP_OK_PROPSTAT_STATUS = 'HTTP/1.1 200 OK'

// Render the <d:response> for a single resource.
// `isRoot=true` uses space.envPermissions (DELETE-stripped at virtual
// endpoints — see PR #87) so the user can't trash their own personal-space
// root. Children always get full space.permissions so the trash action
// renders normally on each child.
//
// `ownerDisplayName` is the human-readable name shown to NC clients in
// share-info / activity ("Shared by …"). Callers thread it from the
// requesting UserModel for personal-space files (where owner == requester);
// pass `''` to fall back to the owner login.
export function buildNcPropResponse(
  f: WebDAVFile,
  space: SpaceEnv,
  mode: NcPermissionsMode,
  isRoot: boolean,
  ownerDisplayName = ''
): Record<string, unknown> {
  const href = f.href
  const sourcePerms = isRoot ? (space.envPermissions ?? space.permissions) : (space.permissions ?? space.envPermissions ?? '')
  const { letters, shareMask } = toNcPermissions(sourcePerms, f.isDir, mode)

  const owner = space.root?.owner ?? { id: 0, login: '' }
  const ownerDisplay = ownerDisplayName || owner.login || ''

  // hasComments / lock land on the WebDAVFile instance only when the
  // browse layer was called with { withHasComments, withLocks } enabled
  // (see WebDAVSpaces.listFiles). Cast through FileProps; absent fields
  // fall through to the safe defaults.
  const enriched = f as WebDAVFile & Partial<Pick<FileProps, 'hasComments' | 'lock'>>
  const hasComments = enriched.hasComments === true
  const lock = enriched.lock

  const resourcetype = f.isDir ? { 'd:collection': '' } : ''
  const contentLength = f.isDir ? undefined : String(f.size)
  const ocSize = String(f.isDir ? 0 : f.size)
  const positiveId = ncFileId(f.id)

  const props: Record<string, unknown> = {
    'd:displayname': f.displayname,
    'd:getlastmodified': f.getlastmodified,
    'd:getetag': f.getetag !== undefined ? f.getetag : `"${String(positiveId)}-${String(f.mtime)}"`,
    'd:resourcetype': resourcetype,
    'oc:id': buildOcId(f.id),
    'oc:fileid': String(positiveId),
    'oc:permissions': letters,
    'ocs:share-permissions': shareMask,
    'oc:size': ocSize,
    'oc:owner-id': String(owner.login ?? ''),
    'oc:owner-display-name': ownerDisplay,
    // <oc:share-types> contains zero or more <oc:share-type>N</oc:share-type>
    // entries (0=user, 1=group, 3=link, 4=email). NC iOS uses the
    // presence of any child to render the share badge on list cells.
    // Sync-in's WebDAV browse doesn't surface share-type info onto
    // WebDAVFile, so we emit an empty parent — same shape real NC
    // emits for unshared files. Populating real entries is a follow-up
    // wired through `withShares` on spacesBrowser.browse.
    'oc:share-types': '',
    'nc:has-preview': ncHasPreview(f.mime) ? '1' : '0',
    'nc:has-comments': hasComments ? '1' : '0',
    'nc:is-encrypted': '0',
    'nc:mount-type': '',
    ...buildLockProps(lock)
  }

  if (!f.isDir) {
    props['d:getcontenttype'] = f.getcontenttype
    if (contentLength !== undefined) props['d:getcontentlength'] = contentLength
  }

  if (mode === 'trashbin') {
    const baseName = stripTrashSuffix(f.name)
    props['nc:trashbin-filename'] = baseName
    props['nc:trashbin-original-location'] = originalLocationFor(f, space)
    props['nc:trashbin-deletion-time'] = String(Math.floor((f.mtime ?? Date.now()) / 1000))
  }

  return {
    'd:href': href,
    'd:propstat': {
      'd:prop': props,
      'd:status': HTTP_OK_PROPSTAT_STATUS
    }
  }
}

// Render the <d:response> for a deleted resource — the sync-collection
// REPORT marker that says "this href is gone now". Just the href + a
// 404 status, no propstat block (RFC 6578 §3.6).
export function buildNcDeletedResponse(href: string): Record<string, unknown> {
  return {
    'd:href': href,
    'd:status': 'HTTP/1.1 404 Not Found'
  }
}

// Some DAV servers add a ".d<unix-ts>" suffix to trashed files. Sync-in
// doesn't, so this is a no-op on current names — the trim is cheap and
// future-proof.
function stripTrashSuffix(name: string): string {
  const match = name.match(/^(.*)\.d\d+$/)
  return match ? match[1] : name
}

function originalLocationFor(f: WebDAVFile, space: SpaceEnv): string {
  const fromOrigin = (f as WebDAVFile & { origin?: { spaceRootExternalPath?: string } }).origin?.spaceRootExternalPath
  if (typeof fromOrigin === 'string' && fromOrigin.length > 0) return fromOrigin
  const alias = space.alias ?? ''
  return alias ? `${alias}/${f.name}` : f.name
}

// Render the lock-related nc: props NC iOS reads to draw the lock badge
// + "locked by …" UI. nc:lock itself is the "is this file locked?"
// boolean (1/0); the rest are descriptive and only emitted when locked.
// Sync-in's FileLockProps doesn't carry a token / timestamp / timeout;
// real NC's iOS client treats those as optional, so omitting them is fine.
// lock-owner-type is always 0 (= user) — we don't have app/token-level
// locks today.
function buildLockProps(lock: FileLockProps | undefined): Record<string, string> {
  if (!lock) return { 'nc:lock': '0' }
  return {
    'nc:lock': '1',
    'nc:lock-owner-type': '0',
    'nc:lock-owner': lock.owner.login,
    'nc:lock-owner-displayname': lock.owner.fullName || lock.owner.login,
    'nc:lock-owner-editor': lock.app
  }
}
