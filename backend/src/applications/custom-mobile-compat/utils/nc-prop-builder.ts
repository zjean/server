// Build a single NC-flavored <d:response> entry for a WebDAVFile.
//
// Extracted from NcPropfindService.buildResponse so both the PROPFIND verb
// and the REPORT (sync-collection) verb emit byte-identical prop blocks.
// Pure function — no `this` state, no DI; trivially testable in isolation.
//
// Boolean DAV props are emitted as the literal strings "true"/"false" rather
// than "1"/"0". Cross-client reasoning:
//   - iOS NextcloudKit parses with NSString.boolValue, which accepts both
//     "1"/"0" and "true"/"false".
//   - Android WebdavEntry parses nc:has-preview with Boolean.valueOf, which
//     ONLY recognizes the literal word forms — "1" silently parses to false
//     and Android Files renders no thumbnails on any image (root cause of
//     the audit-1 finding that prompted this change).
// Word-form is the cross-client lingua franca. PR #134 had switched the
// other way for iOS-only reasons; that fix held but broke Android.
// nc:lock is the deliberate exception: Android requires the exact literal
// "1" (and treats "true" as false), so buildLockProps below stays on "1"/"0".

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
// Optional quota figures threaded onto the user-home root response in
// `files` mode so iOS can render the quota bar at the home view. Sync-in
// models "no quota" as storageQuota <= 0; we translate that to the ownCloud
// sentinel value -3 ("unlimited / unknown") for d:quota-available-bytes,
// which iOS recognizes as "show an open-ended bar".
export interface NcRootQuota {
  used: number
  // Optional cap. Pass undefined / <= 0 to signal "no quota".
  total?: number
}

// Fallback owner identity for personal-space PROPFINDs where SpaceEnv's
// constructor doesn't populate space.root.owner (see space-env.model.ts:71
// — the synthetic unanchored root has no owner field). Without it, NC
// Android sees an empty <oc:owner-id> and refuses write operations on the
// folder ("no permissions to create files/folders here") because several
// Android versions gate canCreate on owner-id matching the logged-in user.
// Personal-space ownership IS the requester by definition, so we plumb
// the requesting user's login + display name through.
export interface NcRequesterFallback {
  login: string
  displayName: string
}

export function buildNcPropResponse(
  f: WebDAVFile,
  space: SpaceEnv,
  mode: NcPermissionsMode,
  isRoot: boolean,
  ownerDisplayName = '',
  rootQuota?: NcRootQuota,
  requesterFallback?: NcRequesterFallback
): Record<string, unknown> {
  const href = f.href
  const sourcePerms = isRoot ? (space.envPermissions ?? space.permissions) : (space.permissions ?? space.envPermissions ?? '')
  const { letters, shareMask } = toNcPermissions(sourcePerms, f.isDir, mode)

  // Personal-space SpaceEnvs synthesize an unanchored root without an owner
  // field; fall back to the requester so <oc:owner-id> / <oc:owner-display-name>
  // are never empty (Android gates canCreate on owner == self). For shared
  // and external spaces the explicit space.root.owner takes precedence —
  // the fallback only fires when nothing else identifies an owner.
  const explicitOwner = space.root?.owner
  const owner = explicitOwner?.login ? explicitOwner : requesterFallback ? { id: 0, login: requesterFallback.login } : { id: 0, login: '' }
  // Display-name resolution order (first non-empty wins):
  //   1. caller-supplied ownerDisplayName (used when requester == file owner)
  //   2. requester fallback (personal-space synthetic root case — the
  //      requester's fullName beats their bare login)
  //   3. explicit space owner's login (shared/external space case)
  //   4. empty string (nothing else known)
  const ownerDisplay = ownerDisplayName || (!explicitOwner?.login && requesterFallback?.displayName) || owner.login || ''

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
    // Sync-in's genEtag defaults to weakPrefix=true and produces W/"...".
    // Real Nextcloud (sabre/dav) emits strong ETags. NextcloudKit's parser
    // strips quotes when reading <d:getetag> but does NOT strip the W/
    // prefix, so a weak ETag lands in iOS metadata.etag with a literal
    // slash mid-string. iOS then uses that etag verbatim as a path
    // component for the on-disk thumbnail location:
    //   <docStorage>/<ocId>/<etag><ext> -> ".../<ocId>/W/<rest>.preview.ico"
    // The W/ becomes a missing intermediate directory and the thumbnail
    // pipeline silently fails -- list cells stay empty for image files
    // even when nc:has-preview is true. Real NC works because its strong
    // ETags have no slash. Strip the W/ prefix here so the wire format
    // matches what NC mobile clients are tested against.
    'd:getetag': stripWeakPrefix(f.getetag) ?? `"${String(positiveId)}-${String(f.mtime)}"`,
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
    'nc:has-preview': ncHasPreview(f.mime) ? 'true' : 'false',
    // oc:comments-unread (oc namespace, not nc:has-comments) is what NC iOS
    // and Android actually parse for the comment badge — see
    // NKDataFileXML.swift:436 (NSString.boolValue) and the matching Android
    // path in WebdavEntry. Sync-in only carries a boolean today; the iOS
    // parser treats any non-zero string as truthy so "1"/"0" works as a
    // stand-in for "unread > 0" / "unread == 0".
    'oc:comments-unread': hasComments ? '1' : '0',
    'nc:is-encrypted': '0',
    'nc:mount-type': '',
    ...buildLockProps(lock)
  }

  if (!f.isDir) {
    props['d:getcontenttype'] = f.getcontenttype
    if (contentLength !== undefined) props['d:getcontentlength'] = contentLength
  }

  if (isRoot && mode === 'files' && rootQuota) {
    const used = Math.max(0, Math.floor(rootQuota.used))
    const total = rootQuota.total ?? 0
    const available = total > 0 ? Math.max(0, total - used) : -3
    props['d:quota-used-bytes'] = String(used)
    props['d:quota-available-bytes'] = String(available)
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

// Drop the leading W/ (case-insensitive) from a weak ETag. Returns the
// original string when no prefix is present, and undefined when input is
// undefined — so callers can chain into a default.
function stripWeakPrefix(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return raw.replace(/^W\//i, '')
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
