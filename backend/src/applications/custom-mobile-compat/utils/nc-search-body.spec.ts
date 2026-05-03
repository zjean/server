import { parseSearchBody } from './nc-search-body'

// Pinned to upstream `nextcloud/ios` `iOSClient/Recent/NCRecent.swift`
// requestBodyRecent. If that template ever changes shape, these tests catch
// the drift and the parser needs an update.
function recentBody(opts: { href?: string; ts?: string | number; limit?: number | string } = {}): string {
  const href = opts.href ?? '/files/alice'
  const ts = String(opts.ts ?? '1714742400')
  const limit = String(opts.limit ?? '100')
  return `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ns="http://nextcloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/></d:prop></d:select>
    <d:from>
      <d:scope>
        <d:href>${href}</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>
      <d:and>
        <d:or>
          <d:not><d:eq><d:prop><d:getcontenttype/></d:prop><d:literal>httpd/unix-directory</d:literal></d:eq></d:not>
          <d:eq><d:prop><oc:size/></d:prop><d:literal>0</d:literal></d:eq>
        </d:or>
        <d:gt>
          <d:prop><d:getlastmodified/></d:prop>
          <d:literal>${ts}</d:literal>
        </d:gt>
      </d:and>
    </d:where>
    <d:orderby>
      <d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order>
    </d:orderby>
    <d:limit><d:nresults>${limit}</d:nresults><ns:firstresult>0</ns:firstresult></d:limit>
  </d:basicsearch>
</d:searchrequest>`
}

describe('parseSearchBody', () => {
  it('parses the canonical NC iOS Recent body', () => {
    const out = parseSearchBody(recentBody())
    expect(out).toEqual({ kind: 'recent', scopeHref: '/files/alice', sinceTimestamp: 1714742400, limit: 100 })
  })

  it('caps limit at 100', () => {
    expect(parseSearchBody(recentBody({ limit: 999 }))).toMatchObject({ limit: 100 })
  })

  it('falls back to default limit when missing or non-positive', () => {
    const out1 = parseSearchBody(recentBody({ limit: 0 }))
    expect(out1).toMatchObject({ kind: 'recent', limit: 100 })
    const out2 = parseSearchBody(recentBody({ limit: 'abc' }))
    expect(out2).toMatchObject({ kind: 'recent', limit: 100 })
  })

  it('returns unknown for empty / null / whitespace bodies', () => {
    expect(parseSearchBody(null)).toEqual({ kind: 'unknown' })
    expect(parseSearchBody(undefined)).toEqual({ kind: 'unknown' })
    expect(parseSearchBody('')).toEqual({ kind: 'unknown' })
    expect(parseSearchBody('   \n  ')).toEqual({ kind: 'unknown' })
  })

  it('returns unknown for malformed XML rather than throwing', () => {
    expect(parseSearchBody('<not-xml')).toEqual({ kind: 'unknown' })
    expect(parseSearchBody('<a><b></a>')).toEqual({ kind: 'unknown' })
  })

  it('returns unknown for SEARCH bodies without a basicsearch element', () => {
    // E.g. a future Media-tab body or a third-party client's expression.
    const body = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:other/></d:searchrequest>`
    expect(parseSearchBody(body)).toEqual({ kind: 'unknown' })
  })

  it('returns unknown when scope href is missing', () => {
    const body = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:from><d:scope><d:depth>infinity</d:depth></d:scope></d:from><d:where><d:and><d:gt><d:prop><d:getlastmodified/></d:prop><d:literal>1714742400</d:literal></d:gt></d:and></d:where></d:basicsearch></d:searchrequest>`
    expect(parseSearchBody(body)).toEqual({ kind: 'unknown' })
  })

  it('returns unknown when the date literal is missing', () => {
    const body = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:from><d:scope><d:href>/files/alice</d:href></d:scope></d:from><d:where><d:and></d:and></d:where></d:basicsearch></d:searchrequest>`
    expect(parseSearchBody(body)).toEqual({ kind: 'unknown' })
  })

  it('accepts a Buffer body', () => {
    const out = parseSearchBody(Buffer.from(recentBody(), 'utf8'))
    expect(out).toMatchObject({ kind: 'recent', scopeHref: '/files/alice' })
  })

  it('extracts scope href verbatim — service is responsible for cross-checking against the authenticated user', () => {
    expect(parseSearchBody(recentBody({ href: '/files/eve' }))).toMatchObject({ scopeHref: '/files/eve' })
  })
})
