import { NC_XMLNS, NC_XMLNS_ALL, PROPSTAT_OK, XML_PROLOG, createNcXmlBuilder, escapeXml, renderMultistatus } from './nc-xml'

describe('nc-xml', () => {
  describe('NC_XMLNS', () => {
    // THE PREFIX SPELLINGS ARE A WIRE CONTRACT, not a style choice.
    // NextcloudKit navigates by literal prefixed name — xml["d:multistatus",
    // "d:response"], propstat["d:prop", "oc:id"] (NKDataFileXML.swift:287,406)
    // — and parses with SWXMLHash, whose shouldProcessNamespaces defaults to
    // false, so it never sees the declarations. Renaming `d` to `D` is valid XML,
    // is fine for Android's namespace-aware parser, and silently breaks iOS
    // entirely. This test exists to make that rename fail here first.
    it('pins the prefix spellings and their URIs', () => {
      expect(NC_XMLNS).toEqual({
        d: 'DAV:',
        oc: 'http://owncloud.org/ns',
        nc: 'http://nextcloud.org/ns',
        ocs: 'http://open-collaboration-services.org/ns'
      })
    })

    it('NC_XMLNS_ALL is ordered d, oc, nc, ocs — the order fixes the attribute order on the root', () => {
      expect(NC_XMLNS_ALL).toEqual(['d', 'oc', 'nc', 'ocs'])
    })
  })

  describe('renderMultistatus', () => {
    const response = { 'd:href': '/x', 'd:propstat': { 'd:prop': { 'oc:id': '1' }, 'd:status': PROPSTAT_OK } }

    it('declares all four namespaces by default, in NC_XMLNS_ALL order', () => {
      expect(renderMultistatus([response])).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns"><d:response><d:href>/x</d:href><d:propstat><d:prop><oc:id>1</oc:id></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
      )
    })

    // Declaring only what the body uses is correct and safe: iOS cannot see the
    // declarations at all, and Android only requires that a prefix the body USES
    // be resolvable. See the NC_XMLNS comment for the upstream citations.
    it('declares a narrowed prefix list in the order given', () => {
      expect(renderMultistatus([], { prefixes: ['d', 'oc'] })).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"></d:multistatus>`
      )
      expect(renderMultistatus([], { prefixes: ['d'] })).toBe(`${XML_PROLOG}<d:multistatus xmlns:d="DAV:"></d:multistatus>`)
    })

    // A childless multistatus must be EXPLICITLY CLOSED, not self-closed —
    // that is what suppressEmptyNode: false buys, and it is the form every NC
    // surface in this module has always emitted.
    it('renders an empty response list as an explicitly-closed multistatus', () => {
      expect(renderMultistatus([])).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns"></d:multistatus>`
      )
    })

    it('emits one <d:response> per entry, in order', () => {
      const body = renderMultistatus([{ 'd:href': '/a' }, { 'd:href': '/b' }], { prefixes: ['d'] })
      expect(body).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href></d:response><d:response><d:href>/b</d:href></d:response></d:multistatus>`
      )
    })

    // RFC 6578 §6.4 puts <d:sync-token> as the LAST child of the multistatus.
    // A renderer that emitted it before the responses would leave the client
    // unable to advance its token.
    it('appends `trailing` children after the responses', () => {
      expect(renderMultistatus([{ 'd:href': '/a' }], { prefixes: ['d'], trailing: { 'd:sync-token': 'urn:x:7' } })).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href></d:response><d:sync-token>urn:x:7</d:sync-token></d:multistatus>`
      )
    })

    it('still emits `trailing` when there are no responses', () => {
      expect(renderMultistatus([], { prefixes: ['d'], trailing: { 'd:sync-token': 'urn:x:7' } })).toBe(
        `${XML_PROLOG}<d:multistatus xmlns:d="DAV:"><d:sync-token>urn:x:7</d:sync-token></d:multistatus>`
      )
    })

    it('escapes XML-special characters in element text so callers never hand-escape', () => {
      const body = renderMultistatus([{ 'd:href': '/a&b<c>' }], { prefixes: ['d'] })
      expect(body).toContain('<d:href>/a&amp;b&lt;c&gt;</d:href>')
      expect(body).not.toContain('/a&b<c>')
    })
  })

  describe('createNcXmlBuilder', () => {
    // Guards the `ignoreAttributes` flag itself. With `ignoreAttributes: true`,
    // fast-xml-parser 5.x emits `@_`-prefixed keys as ELEMENTS whose tag name is
    // the literal key — `<@_xmlns:d>DAV:</@_xmlns:d>` — which is not well-formed
    // XML, with no error and no warning. Every pin in this module would still
    // pass while the namespace declarations silently corrupted the document.
    it('emits @_ keys as attributes rather than dropping them or emitting them as elements', () => {
      const built = createNcXmlBuilder().build({ ocs: { '@_xmlns:d': 'DAV:', meta: { '@_probe': 'x', status: 'ok' } } })
      expect(built).toBe('<ocs xmlns:d="DAV:"><meta probe="x"><status>ok</status></meta></ocs>')
    })

    it('keeps empty nodes explicitly closed', () => {
      expect(createNcXmlBuilder().build({ 'd:resourcetype': '' })).toBe('<d:resourcetype></d:resourcetype>')
    })

    it('returns independent instances', () => {
      expect(createNcXmlBuilder()).not.toBe(createNcXmlBuilder())
    })
  })

  describe('escapeXml', () => {
    // The 5-character form, correct for element text AND attribute values. The
    // helper it replaces (nc-uploads' xmlEscape) handled only `& < >`, which was
    // safe for the element text it happened to serve and unsafe under its
    // general-purpose name (#345).
    it('escapes all five of & < > " and the apostrophe', () => {
      expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f')
    })

    it('escapes & first so entities are not doubled into nonsense', () => {
      expect(escapeXml('&lt;')).toBe('&amp;lt;')
    })

    it('leaves text with no special characters untouched', () => {
      expect(escapeXml('/remote.php/dav/files/alice/report.pdf')).toBe('/remote.php/dav/files/alice/report.pdf')
    })
  })
})
