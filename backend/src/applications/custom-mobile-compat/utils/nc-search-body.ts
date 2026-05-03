// Parser for the WebDAV SEARCH body NextcloudKit (and therefore NC iOS) sends
// when populating the "Recent" view inside the More tab. The exact body shape
// lives in upstream `nextcloud/ios` `iOSClient/Recent/NCRecent.swift` —
// `requestBodyRecent`. NextcloudKit's send-side is at
// `Sources/NextcloudKit/NextcloudKit+WebDAV.swift::searchBodyRequest` and it
// fires `SEARCH /remote.php/dav` with `Accept: application/xml`.
//
// Body skeleton (namespaces stripped here for readability — fast-xml-parser
// is configured with `removeNSPrefix: true`):
//
//   <searchrequest>
//     <basicsearch>
//       <select>...prop list...</select>
//       <from><scope><href>/files/USER_ID</href><depth>infinity</depth></scope></from>
//       <where>
//         <and>
//           <or>...exclude-dirs-or-zero-byte...</or>
//           <gt>
//             <prop><getlastmodified/></prop>
//             <literal>UNIX_TIMESTAMP_SECONDS</literal>
//           </gt>
//         </and>
//       </where>
//       <orderby><order><prop><getlastmodified/></prop><descending/></order></orderby>
//       <limit><nresults>100</nresults><firstresult>0</firstresult></limit>
//     </basicsearch>
//   </searchrequest>
//
// We intentionally only recognize this exact shape (the "Recent" pattern). Any
// other SEARCH body — Media tab's photo-only filter, third-party clients,
// malformed XML — classifies as 'unknown' and the caller returns an empty 207
// multistatus rather than 400/500. Empty success is the iOS-safe response
// because 4xx/5xx on this path triggers iOS's "session is broken, sign me out"
// behavior on some builds (the user-facing report behind this PR).

import { xmlIsValid, xmlParse } from '../../webdav/utils/xml'

export type SearchBody =
  | {
      kind: 'recent'
      // /files/<userId> — what NC iOS told us its scope is. Cross-checked
      // against the authenticated user in the service so a token-stolen
      // request can't enumerate someone else's recents.
      scopeHref: string
      // Unix epoch seconds. Files with mtime > this should be returned. We
      // pre-cap by FilesRecents' own 14-day rolling window in practice; this
      // value is informational.
      sinceTimestamp: number
      // <nresults> from the body. Default 100 if absent / non-positive.
      limit: number
    }
  | { kind: 'unknown' }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100

export function parseSearchBody(raw: string | Buffer | null | undefined): SearchBody {
  if (!raw) return { kind: 'unknown' }
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  if (!text.trim()) return { kind: 'unknown' }
  if (xmlIsValid(text) !== true) return { kind: 'unknown' }

  let parsed: unknown
  try {
    parsed = xmlParse(text)
  } catch {
    return { kind: 'unknown' }
  }

  // searchrequest → basicsearch. With removeNSPrefix, both names lose `d:`.
  const basicsearch = pickPath(parsed, ['searchrequest', 'basicsearch'])
  if (!isObject(basicsearch)) return { kind: 'unknown' }

  const scopeHref = pickString(pickPath(basicsearch, ['from', 'scope', 'href']))
  if (!scopeHref) return { kind: 'unknown' }

  // Walk where → and → gt → literal. The Recent body wraps the date filter
  // inside <and>/<gt>. Some XML parsers may collapse single-child arrays
  // differently; tolerate both `and: {gt:...}` and `gt:...` directly under
  // `where`.
  const sinceTimestamp = extractSinceTimestamp(pickPath(basicsearch, ['where']))
  if (sinceTimestamp === null) return { kind: 'unknown' }

  const limit = clampLimit(pickPath(basicsearch, ['limit', 'nresults']))

  return { kind: 'recent', scopeHref, sinceTimestamp, limit }
}

function extractSinceTimestamp(where: unknown): number | null {
  if (!isObject(where)) return null
  // Try `where.and.gt.literal`, then `where.gt.literal` (parser variation).
  const candidates: unknown[] = [pickPath(where, ['and', 'gt', 'literal']), pickPath(where, ['gt', 'literal'])]
  for (const c of candidates) {
    const n = parseTimestamp(c)
    if (n !== null) return n
  }
  return null
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function pickPath(obj: unknown, segments: string[]): unknown {
  let cur: unknown = obj
  for (const s of segments) {
    if (!isObject(cur)) return undefined
    cur = (cur as Record<string, unknown>)[s]
  }
  return cur
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
