import { XMLBuilder, XMLParser } from 'fast-xml-parser'

// Wire-format helpers for /remote.php/dav/versions/{user}/versions/{fileId} —
// the NC file-versions DAV tree. Pure functions, no DI.
//
// EVERY DETAIL HERE COMES FROM UPSTREAM SOURCE, not from REST convention. The
// authorities, in the order they were read:
//
//   - nextcloud/server apps/files_versions/lib/Sabre/{VersionHome,VersionRoot,
//     VersionCollection,VersionFile,RestoreFolder,Plugin}.php — the node tree,
//     the props, and the MOVE-into-restore semantics.
//   - nextcloud/android-library .../files/ReadFileVersionsRemoteOperation.java
//     — PROPFIND with Depth: 1, and the prop set (WebdavUtils
//     .getFileVersionPropSet: getcontenttype, resourcetype, getcontentlength,
//     getlastmodified, creationdate, oc:id, oc:size).
//   - nextcloud/android-library .../files/model/FileVersion.java — the parser.
//
// THREE CONSEQUENCES THAT WOULD NOT BE GUESSED:
//
//  1. THE SELF ENTRY IS MANDATORY AND MUST COME FIRST. ReadFileVersions loops
//     `for (int i = 1; i < responses.length; ++i)` — it unconditionally
//     discards response[0] as the collection itself. Omit the self entry and
//     the client silently loses the oldest version, every time.
//
//  2. THE NODE NAME IS A UNIX-SECONDS TIMESTAMP, NOT OUR ROW ID, AND IT MUST
//     AGREE WITH d:getlastmodified. FileVersion never reads the href: its
//     getFileName() is `String.valueOf(modifiedTimestamp / 1000)`, derived from
//     the parsed d:getlastmodified, and RestoreFileVersionRemoteOperation
//     builds the restore MOVE source from THAT. So a listing whose href name
//     disagrees with its getlastmodified produces a restore request for a
//     revision that does not exist. Upstream is self-consistent here because
//     its revision id IS the timestamp — the legacy backend literally names the
//     stored file `<path>.v<filemtime>` (Storage.php:374).
//
//  3. d:getetag IS THE BARE REVISION ID, UNQUOTED. VersionFile::getETag()
//     returns `(string)$this->version->getRevisionId()`. Not a strong ETag, not
//     quoted — sabre emits whatever the node returns. We mirror it: the NC
//     clients only compare it for equality, and diverging invents a shape no
//     client has been tested against. (This is NOT the case the fork's
//     strong-ETag rule covers; that rule is about the FILES tree, where a `W/`
//     prefix lands in an iOS thumbnail path.)

// One version, in the shape this file renders. `revision` and `lastModified`
// are deliberately separate fields even though one is derived from the other,
// so the caller owns the ms → s conversion and the invariant in (2) above is
// visible at the call site rather than implied here.
export interface NcVersionXmlEntry {
  // Unix SECONDS. Becomes both the href's last segment and the node name.
  revision: number
  // The superseded content's own mtime, in unix MILLISECONDS (Sync-in stores
  // mtimes in ms; NC's DAV date is RFC 1123 either way).
  mtimeMs: number
  size: number
  // Sync-in stores mime with the first '/' replaced by '-' ('image-jpeg').
  // Pass the ALREADY-TRANSLATED form ('image/jpeg') — the translation belongs
  // to the caller that knows the storage convention.
  contentType: string
  // nc:version-label. null renders an empty element, which is what upstream
  // does for an unlabeled version (getMetadataValue returns null).
  label: string | null
  // nc:version-author — the login of whoever caused the overwrite. null for a
  // system-originated snapshot or a deleted account.
  author: string | null
}

const DAV_NS = 'DAV:'
const OC_NS = 'http://owncloud.org/ns'
const NC_NS = 'http://nextcloud.org/ns'

const HTTP_OK_PROPSTAT_STATUS = 'HTTP/1.1 200 OK'

// Matches NcPropfindService / nc-comment-xml so every body this module emits
// has the same namespace prefixes and element syntax.
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  suppressEmptyNode: false
})

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Labels can be "1" or "true"; keep them strings.
  parseTagValue: false,
  parseAttributeValue: false,
  // So we can read the label whether the client sends nc:version-label or a
  // differently-prefixed binding of the same namespace.
  removeNSPrefix: true,
  trimValues: true
})

export function versionsCollectionHref(login: string, fileId: number): string {
  return `/remote.php/dav/versions/${encodeURIComponent(login)}/versions/${fileId}`
}

export function versionHref(login: string, fileId: number, revision: number): string {
  return `${versionsCollectionHref(login, fileId)}/${revision}`
}

// The 207 body for a PROPFIND of a file's version collection.
//
// `entries` may be empty — a file with no history is a valid collection with no
// children, and Android renders an empty version list rather than an error.
// The self entry is always emitted first; see (1) in the header comment.
export function buildVersionsMultistatus(login: string, fileId: number, entries: NcVersionXmlEntry[]): string {
  const responses: unknown[] = [collectionResponse(login, fileId)]
  for (const entry of entries) {
    responses.push(versionResponse(login, fileId, entry))
  }
  return render(responses)
}

// The 207 body for a PROPFIND of ONE version (Depth: 0 against a version's own
// URL). No self-collection entry here: the addressed resource IS the version,
// so it is response[0] and no client skips it.
export function buildSingleVersionMultistatus(login: string, fileId: number, entry: NcVersionXmlEntry): string {
  return render([versionResponse(login, fileId, entry)])
}

// PROPPATCH acknowledgement for nc:version-label. Upstream answers a
// propertyupdate with a 207 naming each handled property; NC clients read the
// status only, but the correct shape costs one object.
export function buildVersionLabelAck(href: string): string {
  return render([
    {
      'd:href': href,
      'd:propstat': {
        'd:prop': { 'nc:version-label': '' },
        'd:status': HTTP_OK_PROPSTAT_STATUS
      }
    }
  ])
}

// Extract the new label from a PROPPATCH body.
//
// Returns:
//   - a string (possibly empty) when the body SETS nc:version-label,
//   - null when the body REMOVES it — upstream has no remove handler, so we
//     treat a remove as "clear the label", which is what our own API models as
//     label = null,
//   - undefined when the body is not a version-label propertyupdate at all,
//     which the caller turns into a 400 rather than guessing.
//
// An empty <nc:version-label/> parses to '' and also means "clear it": the
// service normalizes blank input to null (VersioningService.setLabel).
export function parseVersionLabelProppatch(body: unknown): string | null | undefined {
  const raw = toBodyString(body)
  if (!raw) return undefined
  let parsed: Record<string, any>
  try {
    parsed = xmlParser.parse(raw)
  } catch {
    return undefined
  }
  const update = parsed?.propertyupdate
  if (!update) return undefined

  const set = firstOf(update.set)
  const setProp = firstOf(set?.prop)
  if (setProp && 'version-label' in setProp) {
    const value = setProp['version-label']
    // fast-xml-parser renders an empty element as '' and a self-closing one as
    // ''. Anything object-shaped (nested elements) is not a label.
    return typeof value === 'string' ? value : value == null ? '' : undefined
  }

  const remove = firstOf(update.remove)
  const removeProp = firstOf(remove?.prop)
  if (removeProp && 'version-label' in removeProp) return null

  return undefined
}

// Is this MOVE a restore? Upstream models restore as moving a VersionFile INTO
// the sibling `restore` collection (RestoreFolder::moveInto calls rollBack), so
// the Destination is `.../versions/{user}/restore/<anything>` — Android sends
// the fileId as the target name, the web UI sends the file name, and upstream
// ignores the name entirely. We do too: only the collection matters.
//
// Accepts an absolute URL or a path-relative Destination, matching what
// NcDavController already tolerates for COPY/MOVE.
export function isRestoreDestination(destination: string | undefined, login: string): boolean {
  if (!destination) return false
  let pathname = destination
  try {
    pathname = new URL(destination).pathname
  } catch {
    // path-relative — use as-is
  }
  const prefix = `/remote.php/dav/versions/${encodeURIComponent(login)}/restore/`
  // Decode so a client that percent-encoded the login still matches.
  const decoded = safeDecode(pathname.split('?')[0])
  return decoded.startsWith(safeDecode(prefix))
}

// ──────── internals ────────

function render(responses: unknown[]): string {
  const body = xmlBuilder.build({
    'd:multistatus': {
      '@_xmlns:d': DAV_NS,
      '@_xmlns:oc': OC_NS,
      '@_xmlns:nc': NC_NS,
      'd:response': responses
    }
  })
  return `<?xml version="1.0" encoding="utf-8"?>${body}`
}

// The collection itself. Upstream's VersionCollection reports getLastModified()
// as 0 and carries no size, so we emit the epoch and a collection resourcetype
// and nothing else — Android discards this entry wholesale, and emitting more
// would be inventing props no reader consumes.
function collectionResponse(login: string, fileId: number): Record<string, unknown> {
  return {
    'd:href': `${versionsCollectionHref(login, fileId)}/`,
    'd:propstat': {
      'd:prop': {
        'd:resourcetype': { 'd:collection': '' },
        'd:getlastmodified': new Date(0).toUTCString()
      },
      'd:status': HTTP_OK_PROPSTAT_STATUS
    }
  }
}

function versionResponse(login: string, fileId: number, entry: NcVersionXmlEntry): Record<string, unknown> {
  return {
    'd:href': versionHref(login, fileId, entry.revision),
    'd:propstat': {
      'd:prop': {
        'd:getcontentlength': String(entry.size),
        'd:getcontenttype': entry.contentType,
        // Must agree with the href's revision segment — see (2) in the header.
        'd:getlastmodified': new Date(entry.mtimeMs).toUTCString(),
        'd:creationdate': new Date(entry.mtimeMs).toISOString(),
        // Bare revision id, unquoted, as VersionFile::getETag() does.
        'd:getetag': String(entry.revision),
        // A version is a file, never a collection. Android's WebdavEntry turns
        // ANY non-null resourcetype value into contentType "DIR", which would
        // make FileVersion.isFolder() true and read the size from oc:size — so
        // this must be an EMPTY element, not `<d:collection/>`.
        'd:resourcetype': '',
        // oc:id / oc:size are in the requested prop set. oc:id is the SOURCE
        // file's id (upstream's FileVersion carries the file's localId, not a
        // per-version identity), and oc:size mirrors the length.
        'oc:id': String(fileId),
        'oc:size': String(entry.size),
        'nc:version-label': entry.label ?? '',
        'nc:version-author': entry.author ?? '',
        // ALWAYS false, deliberately, even for images.
        //
        // Upstream emits true for preview-supported mimes, but it backs that
        // with a dedicated route — apps/files_versions/appinfo/routes.php has
        // exactly one entry, `Preview#getPreview` at /preview — which this fork
        // does not serve. Our /index.php/core/preview renders the LIVE file, so
        // a truthy value here would either make a client request a preview it
        // cannot get (a 404 per row per listing, the exact pattern that got
        // `bulkupload` removed from our capabilities) or, worse, show the
        // CURRENT thumbnail beside an OLD revision. Word form because Android
        // parses this prop with Boolean.valueOf.
        'nc:has-preview': 'false'
      },
      'd:status': HTTP_OK_PROPSTAT_STATUS
    }
  }
}

function firstOf(value: unknown): Record<string, any> | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'object' && value[0] !== null ? value[0] : undefined
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : undefined
}

function toBodyString(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  return null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
