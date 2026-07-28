import { XMLParser } from 'fast-xml-parser'
import { renderMultistatus } from './nc-xml'

// Wire-format helpers for /remote.php/dav/comments/files/{fileId}, the DAV
// surface NC iOS hits via NextcloudKit's NextcloudKit+Comments.swift. Three
// concerns live here, all pure functions:
//
//   1. buildCommentsMultistatus — the 207 PROPFIND response body. NK parses
//      it with NKDataFileXML.convertDataComments, navigating
//      d:multistatus → d:response → d:propstat → d:prop → oc:* children. An
//      entry is dropped unless its propstat status text contains "200" — see
//      NKDataFileXML.swift:735.
//   2. parsePostBody — extract the message from the JSON body NK sends to
//      POST: `{"actorType":"users","verb":"comment","message":"<text>"}`.
//      NK does NOT JSON-escape the message before stringifying, so messages
//      containing `"` or `\` produce malformed JSON. We treat that as 400.
//   3. parseProppatchUpdateBody — extract the new message from the PROPPATCH
//      XML body NK sends to update an existing comment. The body is a fixed
//      d:propertyupdate → d:set → d:prop → oc:message template (see
//      NKDataFileXML.swift:42-51).

// Everything we need to render one comment as a NK-parseable propstat block.
// Author identity is split per NK's NKComments model: actorId is the login
// identifier, actorDisplayName is what NC iOS shows in the UI. Sync-in's
// CommentsQueries.getComments returns both via the joined users table.
export interface NcCommentXmlEntry {
  // Sync-in's comments.id (number). Emitted as oc:id and used to build the
  // d:href; NK reads it as messageId (string).
  commentId: number
  // The file the comment is attached to. Mirrored back in oc:objectId so NK
  // round-trips it; also used to build the d:href segment.
  fileId: number
  // The user.login of the comment author.
  actorId: string
  // The user.fullName (or login fallback) — what NC iOS renders next to the
  // message. Empty string is allowed; NC iOS handles missing display names.
  actorDisplayName: string
  // Comment body. XML-escaped at build time; pass it raw here.
  message: string
  // Creation timestamp. Emitted as RFC 1123 / IMF-fixdate
  // ("Mon, 03 May 2026 14:23:01 GMT") because NK parses with the format
  // "EEE, dd MMM y HH:mm:ss zzz" (NKDataFileXML.swift:706). ISO 8601 silently
  // fails to parse and NK leaves the date at "now", which collapses ordering.
  createdAt: Date
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Don't auto-coerce types — comment messages can be "1" or "true" and we
  // want them as strings, not booleans/numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  // Strip namespace prefixes so we can read oc:message as either "oc:message"
  // or just "message" depending on what NK happens to send.
  removeNSPrefix: true,
  // Keep CDATA + entity decoding active (default true) so &lt; and friends
  // come back as literals.
  trimValues: true
})

// Build the 207 Multistatus PROPFIND body NK consumes. `entries` may be empty
// — NK accepts <d:multistatus/> with no children and renders an empty list.
//
// Hrefs are absolute paths starting from the server root, which is what
// NC iOS expects (it stores them in NKComments.path; not currently used for
// navigation, but worth getting right).
export function buildCommentsMultistatus(entries: NcCommentXmlEntry[]): string {
  const responses = entries.map((entry) => ({
    'd:href': `/remote.php/dav/comments/files/${entry.fileId}/${entry.commentId}`,
    'd:propstat': {
      'd:prop': {
        'oc:id': String(entry.commentId),
        'oc:verb': 'comment',
        'oc:actorType': 'users',
        'oc:actorId': entry.actorId,
        'oc:creationDateTime': entry.createdAt.toUTCString(),
        'oc:objectType': 'files',
        'oc:objectId': String(entry.fileId),
        'oc:isUnread': 'false',
        'oc:message': entry.message,
        'oc:actorDisplayName': entry.actorDisplayName
      },
      'd:status': 'HTTP/1.1 200 OK'
    }
  }))

  // d/oc/nc. The listing itself emits only d: and oc: props, but nc: has been
  // declared here since the endpoint shipped and NextcloudKit is namespace-blind
  // (it matches literal prefixed names and never reads a declaration), so
  // dropping it would be a byte change with no upside.
  return renderMultistatus(responses, { prefixes: ['d', 'oc', 'nc'] })
}

// Build a minimal 207 Multistatus body acknowledging a PROPPATCH update or
// readMarker. NK's evaluateResponse only checks the HTTP status (must be in
// 200..299), so an empty body would also work — but a well-formed multistatus
// is the WebDAV-correct response shape and costs nothing.
export function buildProppatchAck(href: string, propName: 'oc:message' | 'oc:readMarker'): string {
  // Two namespaces, not three: the acknowledged prop is always an oc: one.
  return renderMultistatus(
    [
      {
        'd:href': href,
        'd:propstat': {
          'd:prop': { [propName]: '' },
          'd:status': 'HTTP/1.1 200 OK'
        }
      }
    ],
    { prefixes: ['d', 'oc'] }
  )
}

// Extract `message` from NK's POST body. Accepts either a pre-parsed object
// (Nest's JSON parser produces one for application/json) or a raw string
// (defensive fallback if the parser misses).
//
// Returns the trimmed message string when present and non-empty, or null
// otherwise — the caller should reply 400 on null.
export function parsePostCommentBody(body: unknown): string | null {
  let parsed: Record<string, unknown> | null = null
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    parsed = body as Record<string, unknown>
  } else if (typeof body === 'string') {
    try {
      const candidate: unknown = JSON.parse(body)
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      return null
    }
  } else if (Buffer.isBuffer(body)) {
    try {
      const candidate: unknown = JSON.parse(body.toString('utf8'))
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  if (!parsed) return null

  const message = parsed.message
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Extract the new message from an NK comment-update PROPPATCH body. NK's
// requestBodyCommentsUpdate (NKDataFileXML.swift:42) is a fixed template:
//
//   <d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" ...>
//     <d:set>
//       <d:prop>
//         <oc:message>{message}</oc:message>
//       </d:prop>
//     </d:set>
//   </d:propertyupdate>
//
// The {message} value is NOT escaped client-side — NK substitutes the raw
// string via String(format:). Any `<`, `>`, or `&` in the user's edit will
// produce malformed XML and we treat it as 400. (Same iOS behavior as the
// POST path; users typing those characters get a silent edit failure.)
//
// Returns the trimmed message string when present and non-empty, null
// otherwise. The body argument may be a string or Buffer.
export function parseProppatchUpdateBody(body: string | Buffer | undefined | null): string | null {
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

  // After removeNSPrefix the path collapses to propertyupdate.set.prop.message.
  // We accept both the array (set has multiple prop blocks) and singleton forms
  // fast-xml-parser may produce.
  const root = (parsed as Record<string, unknown>)['propertyupdate']
  const set = pickFirst(root, 'set')
  const prop = pickFirst(set, 'prop')
  const message = pickFirst(prop, 'message')
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Detect NK's mark-all-read PROPPATCH body so we can short-circuit it without
// re-parsing the propname tree. NK ships a fixed body (NKDataFileXML.swift:30)
// containing <readMarker xmlns="http://owncloud.org/ns"/> inside d:set/d:prop;
// we don't act on it — comments are global-read in MVP — but we acknowledge
// it with a 200 propstat so NK's evaluateResponse passes.
export function isMarkAsReadProppatch(body: string | Buffer | undefined | null): boolean {
  if (body === undefined || body === null) return false
  const xml = typeof body === 'string' ? body : body.toString('utf8')
  return /<\s*(?:[a-zA-Z0-9]+:)?readMarker\b/.test(xml)
}

// fast-xml-parser hands back either a single value or an array of values when
// the same tag appears multiple times. Coerce to "first occurrence" so the
// extraction code stays linear.
function pickFirst(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined
  const v = (node as Record<string, unknown>)[key]
  if (Array.isArray(v)) return v[0]
  return v
}
