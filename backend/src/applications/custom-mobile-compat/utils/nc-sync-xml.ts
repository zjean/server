// Helpers for the WebDAV REPORT sync-collection (RFC 6578) handler.
//
// The body is parsed via the upstream `xmlParse` (fast-xml-parser with
// `removeNSPrefix: true`), so the parsed object has un-namespaced keys —
// `<d:sync-collection>` becomes `sync-collection`. Sync tokens are wrapped
// in a fork-specific URN so they survive client round-tripping unchanged.

import { xmlIsValid, xmlParse } from '../../webdav/utils/xml'

// Token URN. NC iOS treats sync-tokens as opaque strings; we use a fork
// scheme so misrouted tokens (e.g. from a different deployment) parse-fail
// fast rather than collide with a stranger's sequence space.
export const SYNC_TOKEN_URN_PREFIX = 'http://sync-in/ns/sync/v1/'

export interface ParsedSyncCollection {
  // The sequence id the client last saw. 0 means "first sync" (the body
  // either had no <d:sync-token> or sent it empty).
  sinceId: number
  // 'infinity' is RFC-allowed; we still treat it as a flat listing for v1
  // since `nc_sync_events` rows are recorded per-path with no hierarchy
  // metadata. Most NC iOS / Android clients send `1`.
  syncLevel: '1' | 'infinity'
  // Optional <d:limit><d:nresults>N</d:nresults></d:limit>. Capped to a
  // sane upper bound by the caller; absent here means "no client-side cap".
  limit: number | null
}

// Parse the body of a REPORT request. Tolerant of:
//   - empty body (treated as first sync, sinceId=0, syncLevel='1')
//   - missing <d:sync-token>
//   - sync-token value that doesn't carry our URN prefix (treated as 0
//     so the client gets a fresh full sync rather than a 412)
//
// Throws HttpException-equivalent strings on malformed XML; callers are
// expected to translate to 400 Bad Request.
export function parseSyncCollectionBody(raw: string | Buffer | null | undefined): ParsedSyncCollection {
  if (!raw) {
    return { sinceId: 0, syncLevel: '1', limit: null }
  }
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  if (text.trim().length === 0) {
    return { sinceId: 0, syncLevel: '1', limit: null }
  }

  const valid = xmlIsValid(text)
  if (valid !== true) {
    throw new Error(`Invalid XML in REPORT body: ${valid.err?.msg ?? 'unknown parse error'}`)
  }

  const parsed = xmlParse(text) as Record<string, unknown>
  // removeNSPrefix strips `d:`, so the root key is `sync-collection`.
  const sc = parsed['sync-collection'] as Record<string, unknown> | undefined
  if (!sc) {
    throw new Error('REPORT body must contain <d:sync-collection>')
  }

  // <d:sync-token> may be missing, empty, or carry our URN prefix.
  // fast-xml-parser without `parseTagValue: true` returns string values for
  // simple elements; an empty element parses to an empty string.
  const tokenRaw = sc['sync-token']
  const tokenStr = typeof tokenRaw === 'string' ? tokenRaw : ''
  const sinceId = parseSyncToken(tokenStr)

  // <d:sync-level> per RFC 6578 §6.3. Defaults to '1' when absent — most
  // NC clients omit it.
  const levelRaw = sc['sync-level']
  const levelStr = typeof levelRaw === 'string' ? levelRaw.trim() : '1'
  const syncLevel: '1' | 'infinity' = levelStr === 'infinity' ? 'infinity' : '1'

  // <d:limit><d:nresults>N</d:nresults></d:limit>. Optional.
  let limit: number | null = null
  const limitNode = sc['limit'] as Record<string, unknown> | undefined
  if (limitNode && typeof limitNode === 'object') {
    const n = (limitNode as Record<string, unknown>)['nresults']
    const parsedN = typeof n === 'string' || typeof n === 'number' ? Number(n) : NaN
    if (Number.isFinite(parsedN) && parsedN > 0) {
      limit = Math.floor(parsedN)
    }
  }

  return { sinceId, syncLevel, limit }
}

// Strip the URN prefix and return the integer sequence. Returns 0 on
// anything we can't recognize, which causes a full re-sync — safer than
// 412'ing the client for a token format we don't understand.
//
// The URN check is the isolation boundary: tokens without our prefix are
// foreign (issued by a different deployment, hand-crafted by a buggy
// client, etc.) and we refuse to interpret their numeric tail as our
// sequence space. A bare `"42"` could otherwise land in the middle of
// our log and skip events.
function parseSyncToken(value: string): number {
  if (!value) return 0
  const trimmed = value.trim()
  if (trimmed.length === 0) return 0
  if (!trimmed.startsWith(SYNC_TOKEN_URN_PREFIX)) return 0
  const stripped = trimmed.slice(SYNC_TOKEN_URN_PREFIX.length)
  const n = Number(stripped)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

// Format a sequence id as the URN-wrapped sync-token string we emit on
// every response.
export function formatSyncToken(seq: number): string {
  return `${SYNC_TOKEN_URN_PREFIX}${seq}`
}

export type ReportBodyType = 'sync-collection' | 'filter-files' | 'unknown'

// Cheap content sniffer for the WebDAV REPORT body. NC clients send two
// distinct REPORT shapes against the same URL:
//   - <d:sync-collection> for RFC 6578 incremental sync (default refresh)
//   - <oc:filter-files>   for the Favorites tab (NextcloudKit's NKDataFileXML
//     getRequestBodyFavorite)
// The router needs to pick a handler before either parser sees the body —
// otherwise routing through the sync-collection parser 400s on a filter-files
// request and iOS spins forever on the Favorites tab.
//
// We do a regex-only sniff: the goal is to pick a route, not to validate
// the XML. The full structural parse happens downstream once the right
// handler is chosen. Tolerates leading XML decl + doctype, either
// namespace-prefixed or bare root element, and case-sensitive matching
// (REPORT body root names are always lowercase per spec).
export function detectReportBodyType(raw: string | Buffer | null | undefined): ReportBodyType {
  if (!raw) return 'unknown'
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  if (text.trim().length === 0) return 'unknown'
  // Skip leading <?xml ...?> and <!DOCTYPE ...> if present.
  const stripped = text
    .replace(/^\s*<\?xml[^?]*\?>/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>/, '')
    .trimStart()
  if (/^<(?:[A-Za-z_][\w.-]*:)?sync-collection[\s/>]/.test(stripped)) return 'sync-collection'
  if (/^<(?:[A-Za-z_][\w.-]*:)?filter-files[\s/>]/.test(stripped)) return 'filter-files'
  return 'unknown'
}
