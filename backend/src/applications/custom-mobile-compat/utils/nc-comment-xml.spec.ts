import { buildCommentsMultistatus, buildProppatchAck, isMarkAsReadProppatch, parsePostCommentBody, parseProppatchUpdateBody } from './nc-comment-xml'
import type { NcCommentXmlEntry } from './nc-comment-xml'

function entry(overrides: Partial<NcCommentXmlEntry> = {}): NcCommentXmlEntry {
  return {
    commentId: 7,
    fileId: 42,
    actorId: 'alice',
    actorDisplayName: 'Alice Liddell',
    message: 'Looks good to me',
    createdAt: new Date('2026-05-03T14:23:01Z'),
    ...overrides
  }
}

describe('buildCommentsMultistatus', () => {
  it('declares the four DAV/oc/nc namespaces NK relies on', () => {
    const xml = buildCommentsMultistatus([entry()])
    expect(xml).toContain('xmlns:d="DAV:"')
    expect(xml).toContain('xmlns:oc="http://owncloud.org/ns"')
    expect(xml).toContain('xmlns:nc="http://nextcloud.org/ns"')
  })

  it('emits all NK-required oc:* properties for one comment', () => {
    const xml = buildCommentsMultistatus([entry()])
    expect(xml).toContain('<oc:id>7</oc:id>')
    expect(xml).toContain('<oc:verb>comment</oc:verb>')
    expect(xml).toContain('<oc:actorType>users</oc:actorType>')
    expect(xml).toContain('<oc:actorId>alice</oc:actorId>')
    expect(xml).toContain('<oc:objectType>files</oc:objectType>')
    expect(xml).toContain('<oc:objectId>42</oc:objectId>')
    expect(xml).toContain('<oc:isUnread>false</oc:isUnread>')
    expect(xml).toContain('<oc:message>Looks good to me</oc:message>')
    expect(xml).toContain('<oc:actorDisplayName>Alice Liddell</oc:actorDisplayName>')
  })

  it('emits the date in RFC 1123 format (NK parses "EEE, dd MMM y HH:mm:ss zzz")', () => {
    // NKDataFileXML.swift:706 uses that exact DateFormatter pattern. ISO 8601
    // silently fails to parse and NK falls back to current time, breaking
    // ordering in the comments tab.
    const xml = buildCommentsMultistatus([entry({ createdAt: new Date('2026-05-03T14:23:01Z') })])
    expect(xml).toContain('<oc:creationDateTime>Sun, 03 May 2026 14:23:01 GMT</oc:creationDateTime>')
  })

  it('marks each propstat as 200 OK so NK includes it (NKDataFileXML.swift:735 filters non-200)', () => {
    const xml = buildCommentsMultistatus([entry()])
    expect(xml).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
  })

  it('builds a d:href under /remote.php/dav/comments/files/{fileId}/{commentId}', () => {
    const xml = buildCommentsMultistatus([entry()])
    expect(xml).toContain('<d:href>/remote.php/dav/comments/files/42/7</d:href>')
  })

  it('escapes XML-special characters in the message body', () => {
    // fast-xml-parser handles this; assert so a regression in the dep version
    // doesn't silently break the wire.
    const xml = buildCommentsMultistatus([entry({ message: 'a < b & c > d "x" \'y\'' })])
    expect(xml).toContain('a &lt; b &amp; c &gt; d')
    expect(xml).not.toContain('a < b & c > d')
  })

  it('emits multiple <d:response> blocks for multiple comments', () => {
    const xml = buildCommentsMultistatus([entry({ commentId: 1 }), entry({ commentId: 2 })])
    expect(xml.match(/<d:response>/g)?.length).toBe(2)
    expect(xml).toContain('<oc:id>1</oc:id>')
    expect(xml).toContain('<oc:id>2</oc:id>')
  })

  it('produces an empty multistatus when no comments are passed', () => {
    const xml = buildCommentsMultistatus([])
    expect(xml).toContain('<d:multistatus')
    expect(xml).not.toContain('<d:response>')
  })

  it('starts with an XML prolog so strict parsers accept it', () => {
    const xml = buildCommentsMultistatus([])
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
  })
})

describe('buildProppatchAck', () => {
  it('returns a 207 multistatus with the requested prop and 200 status', () => {
    const xml = buildProppatchAck('/remote.php/dav/comments/files/42/7', 'oc:message')
    expect(xml).toContain('<d:multistatus')
    expect(xml).toContain('<d:href>/remote.php/dav/comments/files/42/7</d:href>')
    expect(xml).toContain('<oc:message')
    expect(xml).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
  })

  it('supports the readMarker prop variant', () => {
    const xml = buildProppatchAck('/remote.php/dav/comments/files/42', 'oc:readMarker')
    expect(xml).toContain('<oc:readMarker')
  })
})

describe('parsePostCommentBody', () => {
  it('extracts message from a pre-parsed NK POST body', () => {
    expect(parsePostCommentBody({ actorType: 'users', verb: 'comment', message: 'hello' })).toBe('hello')
  })

  it('trims surrounding whitespace', () => {
    expect(parsePostCommentBody({ message: '  spaced  ' })).toBe('spaced')
  })

  it('returns null for an empty / whitespace-only message', () => {
    expect(parsePostCommentBody({ message: '' })).toBeNull()
    expect(parsePostCommentBody({ message: '   ' })).toBeNull()
  })

  it('returns null when message is missing or non-string', () => {
    expect(parsePostCommentBody({ actorType: 'users', verb: 'comment' })).toBeNull()
    expect(parsePostCommentBody({ message: 123 })).toBeNull()
  })

  it('parses a raw JSON string body as a fallback', () => {
    expect(parsePostCommentBody('{"actorType":"users","verb":"comment","message":"raw"}')).toBe('raw')
  })

  it('returns null for malformed JSON (NK does not escape quotes in message)', () => {
    // NK builds the body via string concat without escaping. A user typing `"`
    // would produce broken JSON; we 400 those, surfacing as a silent edit
    // failure on iOS — same behavior as upstream NC.
    expect(parsePostCommentBody('{"message":"oops"missing":quote"}')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parsePostCommentBody('"just a string"')).toBeNull()
    expect(parsePostCommentBody('[1,2,3]')).toBeNull()
  })

  it('parses a Buffer body', () => {
    expect(parsePostCommentBody(Buffer.from('{"message":"buf"}', 'utf8'))).toBe('buf')
  })

  it('returns null on null / undefined / wrong type', () => {
    expect(parsePostCommentBody(null)).toBeNull()
    expect(parsePostCommentBody(undefined)).toBeNull()
    expect(parsePostCommentBody(123)).toBeNull()
  })
})

describe('parseProppatchUpdateBody', () => {
  const nkUpdateBody = (msg: string) => `<?xml version="1.0" encoding="UTF-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <d:set>
        <d:prop>
            <oc:message>${msg}</oc:message>
        </d:prop>
    </d:set>
</d:propertyupdate>`

  it('extracts the message from NK requestBodyCommentsUpdate', () => {
    expect(parseProppatchUpdateBody(nkUpdateBody('updated content'))).toBe('updated content')
  })

  it('trims surrounding whitespace', () => {
    expect(parseProppatchUpdateBody(nkUpdateBody('  padded  '))).toBe('padded')
  })

  it('returns null for an empty message', () => {
    expect(parseProppatchUpdateBody(nkUpdateBody(''))).toBeNull()
  })

  it('returns null for a body without an oc:message prop', () => {
    const noMessage = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:other>x</oc:other></d:prop></d:set>
</d:propertyupdate>`
    expect(parseProppatchUpdateBody(noMessage)).toBeNull()
  })

  it('returns null on malformed XML', () => {
    expect(parseProppatchUpdateBody('<not xml')).toBeNull()
  })

  it('returns null on null / empty body', () => {
    expect(parseProppatchUpdateBody(null)).toBeNull()
    expect(parseProppatchUpdateBody('')).toBeNull()
    expect(parseProppatchUpdateBody(undefined)).toBeNull()
  })

  it('parses a Buffer body', () => {
    expect(parseProppatchUpdateBody(Buffer.from(nkUpdateBody('from buffer'), 'utf8'))).toBe('from buffer')
  })
})

describe('isMarkAsReadProppatch', () => {
  it('detects NK requestBodyCommentsMarkAsRead', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <d:set><d:prop><readMarker xmlns="http://owncloud.org/ns"/></d:prop></d:set>
</d:propertyupdate>`
    expect(isMarkAsReadProppatch(body)).toBe(true)
  })

  it('detects the prefixed variant some clients may send', () => {
    expect(isMarkAsReadProppatch('<oc:readMarker/>')).toBe(true)
  })

  it('returns false for a normal update body', () => {
    expect(isMarkAsReadProppatch('<oc:message>hi</oc:message>')).toBe(false)
  })

  it('returns false on null / empty', () => {
    expect(isMarkAsReadProppatch(null)).toBe(false)
    expect(isMarkAsReadProppatch('')).toBe(false)
    expect(isMarkAsReadProppatch(undefined)).toBe(false)
  })
})
