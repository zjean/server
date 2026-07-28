import { XMLBuilder } from 'fast-xml-parser'
import { escapeHtml } from './nc-html'

// The one place this module decides how it writes XML. Consolidates what were
// seven copy-pasted XMLBuilder configs, five disagreeing namespace-constant
// declarations, and eight hand-rolled <d:multistatus> renderers (#343), plus
// the three divergent escape helpers (#345).
//
// DELIBERATELY OUT OF SCOPE: upstream's `webdav/utils/xml.ts`. That builder
// serves Sync-in's own WebDAV surface, which uses an uppercase `D:` prefix and
// declares only DAV: — a shape NC clients do not parse. Folding the two would
// put this module's wire format on the upstream merge-conflict surface for no
// gain. The duplication between the two files is intentional.
//
// WHAT THIS FILE DOES NOT DO: it does not normalise any per-response prop.
// Every prop name, value form, and element shape stays exactly where its
// upstream citation is (nc-prop-builder, nc-version-xml, nc-comment-xml). A
// consolidation that "tidied" one of those would break an NC client silently —
// see nc-version-xml.ts's header for three worked examples.

// ──────── namespaces ────────

// The four namespaces this module's WebDAV bodies can use.
//
// THE RULE, ESTABLISHED FROM UPSTREAM SOURCE: declare every prefix the body
// USES; nothing requires declaring one it doesn't. Arity is therefore per-body,
// and the fact that our emitters disagree on it is correct rather than a bug.
// This was worth pinning down because the emitters previously carried a comment
// claiming "NC clients expect four namespaces on EVERY <d:multistatus>", which
// is wrong twice over. What upstream actually does:
//
//   - A real NC 207 root carries FOUR declarations, and the fourth is
//     `xmlns:s="http://sabredav.org/ns"` — NOT this `ocs` one. It appears
//     because sabre's Writer dumps the whole namespaceMap on the first element
//     written, used or not (sabre-io/xml lib/Writer.php:151-156), and that map
//     is seeded with DAV: + sabredav.org/ns (sabre-io/dav
//     lib/DAV/Xml/Service.php:41-44) then extended by exactly two entries in
//     NC's FilesPlugin::initialize (apps/dav/lib/Connector/Sabre/
//     FilesPlugin.php:118-119). `s:` is declared on every 207 and USED on none:
//     its elements only ever appear on `<d:error>` documents, built by a
//     separate path (sabre-io/dav lib/DAV/Server.php:261-274).
//   - `http://open-collaboration-services.org/ns` is never in NC's
//     namespaceMap at all. It exists only as a property NAME —
//     `{http://open-collaboration-services.org/ns}share-permissions`
//     (FilesPlugin.php:51) — so upstream emits it via the writer's ad-hoc
//     branch, inline on the element as `<x1:share-permissions xmlns:x1="…">`,
//     never on the root. Our `ocs:` root declaration is a divergence from
//     upstream, but a working one, and it is REQUIRED given that
//     nc-prop-builder emits `<ocs:share-permissions>` as a prefixed element.
//
// Why the per-body arity is safe, from the two client parsers (they are in
// OPPOSITE modes, and neither is hurt by omitting an unused declaration):
//
//   - iOS (NextcloudKit) is namespace-BLIND. It navigates by literal prefixed
//     strings — `xml["d:multistatus", "d:response"]`, `propstat["d:prop",
//     "oc:id"]` (NKDataFileXML.swift:287,406) — and parses with SWXMLHash,
//     whose `shouldProcessNamespaces` defaults to false. It cannot see xmlns
//     declarations at all.
//   - Android (android-library) is namespace-AWARE. WebdavEntry resolves by URI
//     + local name (`Namespace.getNamespace(NAMESPACE_OC)`, WebdavEntry.kt:113)
//     and Jackrabbit sets `factory.setNamespaceAware(true)`
//     (DavDocumentBuilderFactory.java:44). So for Android an undeclared prefix
//     that the body USES is a fatal well-formedness error — the whole parse
//     fails — while an extra unused declaration is a few wasted bytes.
//
// THE COROLLARY THAT ACTUALLY BITES, and the one to protect: because iOS matches
// literal prefixed names, the prefix SPELLINGS are a wire contract. Emitting
// `xmlns:D="DAV:"` with `D:multistatus` is valid XML and fine for Android, and
// silently breaks iOS completely. Never rename a prefix; the declaration count
// is the part that doesn't matter.
//
// Who declares what, and why:
//
//   d/oc/nc/ocs — PROPFIND + the three REPORT/SEARCH services. All four are
//                 required: nc-prop-builder emits `<ocs:share-permissions>`.
//   d/oc/nc     — the file-versions tree (nc:version-label, nc:version-author)
//                 and the comments listing.
//   d/oc        — the comments PROPPATCH ack (one oc: prop, no nc:).
//   d           — the chunked-upload staging dir (plain DAV props only).
export const NC_XMLNS = {
  d: 'DAV:',
  oc: 'http://owncloud.org/ns',
  nc: 'http://nextcloud.org/ns',
  ocs: 'http://open-collaboration-services.org/ns'
} as const

export type NcXmlnsPrefix = keyof typeof NC_XMLNS

// What a PROPFIND/REPORT body built from nc-prop-builder responses needs.
export const NC_XMLNS_ALL: readonly NcXmlnsPrefix[] = ['d', 'oc', 'nc', 'ocs']

// ──────── builder ────────

// `ignoreAttributes: false` + `attributeNamePrefix: '@_'` is what every emitter
// in this module already used, and the flag is load-bearing rather than
// cosmetic. On a *builder* — unlike on an XMLParser, where `ignoreAttributes:
// true` is the correct choice — that flag stops `@_`-prefixed keys from
// becoming attributes: fast-xml-parser 5.x emits them as ELEMENTS whose tag
// name is the literal key, i.e. `<@_xmlns:d>DAV:</@_xmlns:d>`, which is not
// well-formed XML and would make NextcloudKit's parse of the whole document
// fail. No error, no warning, no failing test.
//
// `suppressEmptyNode: false` keeps empty elements explicitly closed
// (`<d:resourcetype></d:resourcetype>` rather than `<d:resourcetype/>`). Both
// are empty elements as far as every NC parser is concerned, but the explicit
// form is what the PROPFIND tree has always emitted and therefore the form
// that has been exercised against real iOS and Android clients.
//
// `format: false` because these bodies are machine-read only, and because
// pretty-printing would insert whitespace text nodes into elements whose
// emptiness some clients check (Android's WebdavEntry turns ANY non-null
// `d:resourcetype` value into contentType "DIR").
export const NC_XML_BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  suppressEmptyNode: false
} as const

export function createNcXmlBuilder(): XMLBuilder {
  return new XMLBuilder(NC_XML_BUILDER_OPTIONS)
}

// Shared instance for this module's renderers. XMLBuilder holds no per-build
// state, so one instance is safe across concurrent requests.
const builder = createNcXmlBuilder()

// Every body this module emits carries the same prolog. NC clients don't
// require one, but omitting it would be a gratuitous change to a working wire
// format.
export const XML_PROLOG = '<?xml version="1.0" encoding="utf-8"?>'

// The propstat status line for a successfully-read property. Sabre emits the
// HTTP/1.1 reason phrase, and NextcloudKit's parser drops any propstat whose
// status text does not contain "200" (NKDataFileXML.swift:735).
export const PROPSTAT_OK = 'HTTP/1.1 200 OK'

// ──────── multistatus ────────

export interface RenderMultistatusOptions {
  // Which namespace prefixes to declare on <d:multistatus>. Defaults to all
  // four; pass a narrower list to match a body that uses fewer. See NC_XMLNS.
  prefixes?: readonly NcXmlnsPrefix[]
  // Extra children appended AFTER the responses, e.g. RFC 6578's
  // <d:sync-token>, which §6.4 places as the last child of the multistatus.
  trailing?: Record<string, unknown>
}

// Render a 207 Multi-Status body: prolog + <d:multistatus> with the requested
// xmlns declarations, one child per entry in `responses`, then `trailing`.
//
// `responses` may be empty — every NC surface this module serves treats a
// childless multistatus as "nothing here" rather than an error, and each of the
// eight callers relied on that. An empty list omits the `d:response` key
// entirely rather than handing the builder an empty array; the two are
// byte-identical today, and being explicit means the output does not depend on
// how fast-xml-parser chooses to treat `[]`.
export function renderMultistatus(responses: readonly unknown[], options: RenderMultistatusOptions = {}): string {
  const root: Record<string, unknown> = {}
  // Attributes first: fast-xml-parser emits keys in insertion order, so this is
  // what fixes the xmlns attribute order on the root element.
  for (const prefix of options.prefixes ?? NC_XMLNS_ALL) {
    root[`@_xmlns:${prefix}`] = NC_XMLNS[prefix]
  }
  if (responses.length > 0) root['d:response'] = responses
  if (options.trailing) Object.assign(root, options.trailing)
  return `${XML_PROLOG}${builder.build({ 'd:multistatus': root })}`
}

// ──────── escaping ────────

// THE one escape function for this module, re-exported from nc-html rather than
// reimplemented, so there is exactly one implementation (#345 found three, two
// byte-identical and one silently weaker).
//
// It escapes all five of `& < > " '`, which is correct for BOTH XML element text
// and XML attribute values. The minimal sets differ per context — `& <` for
// text, `& < "` for a double-quoted attribute — and the previous
// `nc-uploads.controller.ts::xmlEscape` handled only `& < >`, so it was safe
// for the element text it happened to be used for and unsafe for anything
// else, under a general-purpose name. Over-escaping `>` and `'` costs nothing:
// every XML parser resolves the entity back to the same character.
//
// PREFER THE BUILDER. Nothing on the XML path needs this today — renderMultistatus
// escapes for you, correctly and per-context. It is exported so that anyone who
// does end up hand-writing XML in this module reaches for the correct helper
// instead of writing a fourth partial one.
export { escapeHtml as escapeXml }
