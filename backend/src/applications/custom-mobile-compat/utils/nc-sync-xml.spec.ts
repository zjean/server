import { detectReportBodyType, formatSyncToken, parseSyncCollectionBody, SYNC_TOKEN_URN_PREFIX } from './nc-sync-xml'

describe('detectReportBodyType', () => {
  // Used by NcDavController to decide whether the REPORT body is a
  // <d:sync-collection> (RFC 6578 delta sync) or an <oc:filter-files>
  // (NC iOS Favorites tab). Must be tolerant of:
  //   - whitespace + leading XML declaration / doctype
  //   - either namespace-prefixed (`<d:sync-collection xmlns:d="DAV:">`) or
  //     bare (`<sync-collection xmlns="DAV:">`) root element, since iOS may
  //     use either form
  //   - common typos / unknown body shapes (return 'unknown', let caller 400)
  // We intentionally do NOT do a full XML parse — that's the next-stage
  // handler's job. Here we only need to pick a route.
  it('detects sync-collection bodies', () => {
    expect(detectReportBodyType('<d:sync-collection xmlns:d="DAV:"></d:sync-collection>')).toBe('sync-collection')
    expect(detectReportBodyType('<?xml version="1.0"?>\n<d:sync-collection xmlns:d="DAV:"/>')).toBe('sync-collection')
  })

  it('detects filter-files bodies (oc-prefixed and bare)', () => {
    expect(detectReportBodyType('<oc:filter-files xmlns:oc="http://owncloud.org/ns"></oc:filter-files>')).toBe('filter-files')
    expect(detectReportBodyType('<?xml version="1.0"?><filter-files xmlns="http://owncloud.org/ns"/>')).toBe('filter-files')
  })

  it('returns "unknown" for anything else (caller turns into 400)', () => {
    expect(detectReportBodyType('<d:something-else xmlns:d="DAV:"/>')).toBe('unknown')
    expect(detectReportBodyType('not xml')).toBe('unknown')
  })

  it('returns "unknown" for an empty body so callers can decide whether to default', () => {
    expect(detectReportBodyType(null)).toBe('unknown')
    expect(detectReportBodyType(undefined)).toBe('unknown')
    expect(detectReportBodyType('')).toBe('unknown')
    expect(detectReportBodyType('   \n  ')).toBe('unknown')
  })
})

describe('parseSyncCollectionBody', () => {
  it('treats empty/missing body as first sync (sinceId=0, syncLevel=1)', () => {
    expect(parseSyncCollectionBody(null)).toEqual({ sinceId: 0, syncLevel: '1', limit: null })
    expect(parseSyncCollectionBody(undefined)).toEqual({ sinceId: 0, syncLevel: '1', limit: null })
    expect(parseSyncCollectionBody('')).toEqual({ sinceId: 0, syncLevel: '1', limit: null })
    expect(parseSyncCollectionBody('   \n  ')).toEqual({ sinceId: 0, syncLevel: '1', limit: null })
  })

  it('parses URN-prefixed sync-token to a numeric sinceId', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>${SYNC_TOKEN_URN_PREFIX}42</d:sync-token>
        <d:sync-level>1</d:sync-level>
      </d:sync-collection>`
    expect(parseSyncCollectionBody(body)).toEqual({ sinceId: 42, syncLevel: '1', limit: null })
  })

  it('parses sync-level=infinity', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>${SYNC_TOKEN_URN_PREFIX}10</d:sync-token>
        <d:sync-level>infinity</d:sync-level>
      </d:sync-collection>`
    expect(parseSyncCollectionBody(body).syncLevel).toBe('infinity')
  })

  it('treats empty sync-token element as first sync (sinceId=0)', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token></d:sync-token>
        <d:sync-level>1</d:sync-level>
      </d:sync-collection>`
    expect(parseSyncCollectionBody(body).sinceId).toBe(0)
  })

  it('treats unknown token format as sinceId=0 (full re-sync) rather than throwing', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>https://other-server/sync/abc</d:sync-token>
      </d:sync-collection>`
    // unrecognized URN → falls through Number() → NaN → 0
    expect(parseSyncCollectionBody(body).sinceId).toBe(0)
  })

  it('parses <d:limit><d:nresults>N</d:nresults></d:limit>', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>${SYNC_TOKEN_URN_PREFIX}5</d:sync-token>
        <d:limit><d:nresults>250</d:nresults></d:limit>
      </d:sync-collection>`
    expect(parseSyncCollectionBody(body)).toEqual({ sinceId: 5, syncLevel: '1', limit: 250 })
  })

  it('ignores invalid limit values', () => {
    const body = `
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>${SYNC_TOKEN_URN_PREFIX}1</d:sync-token>
        <d:limit><d:nresults>not-a-number</d:nresults></d:limit>
      </d:sync-collection>`
    expect(parseSyncCollectionBody(body).limit).toBeNull()
  })

  it('throws on malformed XML', () => {
    expect(() => parseSyncCollectionBody('<d:sync-collection><not-closed>')).toThrow()
  })

  it('throws when the root is not <d:sync-collection>', () => {
    expect(() => parseSyncCollectionBody('<d:propfind xmlns:d="DAV:"></d:propfind>')).toThrow(/sync-collection/)
  })

  it('accepts Buffer bodies (Fastify default for unknown content-types)', () => {
    const body = Buffer.from(`<d:sync-collection xmlns:d="DAV:"><d:sync-token>${SYNC_TOKEN_URN_PREFIX}9</d:sync-token></d:sync-collection>`)
    expect(parseSyncCollectionBody(body).sinceId).toBe(9)
  })
})

describe('formatSyncToken', () => {
  it('wraps the sequence in our URN prefix', () => {
    expect(formatSyncToken(0)).toBe(`${SYNC_TOKEN_URN_PREFIX}0`)
    expect(formatSyncToken(123)).toBe(`${SYNC_TOKEN_URN_PREFIX}123`)
  })
})
