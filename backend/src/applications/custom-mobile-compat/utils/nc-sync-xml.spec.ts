import { formatSyncToken, parseSyncCollectionBody, SYNC_TOKEN_URN_PREFIX } from './nc-sync-xml'

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
