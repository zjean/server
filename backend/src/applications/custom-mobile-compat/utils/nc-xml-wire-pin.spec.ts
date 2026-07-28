import { buildUploadDirPropfindBody } from '../controllers/nc-uploads.controller'
import { buildCommentsMultistatus, buildProppatchAck } from './nc-comment-xml'
import { buildSingleVersionMultistatus, buildVersionLabelAck, buildVersionsMultistatus, type NcVersionXmlEntry } from './nc-version-xml'

// BYTE-FOR-BYTE PIN of every hand-rolled multistatus body this module emits
// from a pure function. Written BEFORE the nc-xml.ts consolidation (#343 /
// #345) and deliberately not softened afterwards.
//
// Why a byte pin and not more `toContain` assertions: the sibling specs
// (nc-version-xml.spec.ts, nc-comment-xml.spec.ts, nc-uploads.controller
// .spec.ts) already assert the SEMANTICS — which props appear, what they mean,
// and the upstream citation for each. What they cannot catch is a refactor that
// preserves every prop but changes the envelope: a dropped xmlns, a reordered
// attribute, a `<d:x/>` that became `<d:x></d:x>`, a lost prolog. Those are
// exactly the failure modes of "collapse seven XMLBuilder configs into one",
// and every one of them is invisible to a `toContain` suite.
//
// The whole point of this file is that a diff here is LOUD. If a change to
// nc-xml.ts makes one of these fail, that is the file doing its job: go read
// the delta, decide whether the new bytes are still what the NC client parses,
// and only then update the literal — with a note saying why.
//
// NOTE ON ARITY: the emitters below declare THREE namespaces (version, comment)
// and TWO (the comment PROPPATCH ack) and ONE (uploads), where the four
// PROPFIND/REPORT services declare FOUR. That asymmetry is pinned here as
// found, not normalised — see the PR discussion for why the difference is
// correct rather than a bug (each body declares exactly the prefixes it uses;
// `ocs:` is only ever emitted by nc-prop-builder's share-permissions prop).

// ──────── nc-version-xml ────────

const VERSION_LOGIN = 'alice'
const VERSION_FILE_ID = 4242
// 2024-05-03T13:20:00Z, in seconds (the revision) and milliseconds (the mtime).
const VERSION_REVISION = 1_714_742_400
const VERSION_MTIME_MS = 1_714_742_400_000

function versionEntry(overrides: Partial<NcVersionXmlEntry> = {}): NcVersionXmlEntry {
  return {
    revision: VERSION_REVISION,
    mtimeMs: VERSION_MTIME_MS,
    size: 1234,
    contentType: 'text/plain',
    label: 'before the rewrite',
    author: 'bob',
    ...overrides
  }
}

describe('wire-format pin: nc-version-xml', () => {
  it('buildVersionsMultistatus — collection self entry first, then one version', () => {
    expect(buildVersionsMultistatus(VERSION_LOGIN, VERSION_FILE_ID, [versionEntry()])).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/versions/alice/versions/4242/</d:href><d:propstat><d:prop><d:resourcetype><d:collection></d:collection></d:resourcetype><d:getlastmodified>Thu, 01 Jan 1970 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/remote.php/dav/versions/alice/versions/4242/1714742400</d:href><d:propstat><d:prop><d:getcontentlength>1234</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><d:getlastmodified>Fri, 03 May 2024 13:20:00 GMT</d:getlastmodified><d:creationdate>2024-05-03T13:20:00.000Z</d:creationdate><d:getetag>1714742400</d:getetag><d:resourcetype></d:resourcetype><oc:id>4242</oc:id><oc:size>1234</oc:size><nc:version-label>before the rewrite</nc:version-label><nc:version-author>bob</nc:version-author><nc:has-preview>false</nc:has-preview></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })

  it('buildVersionsMultistatus — a file with no history is the self entry alone', () => {
    expect(buildVersionsMultistatus(VERSION_LOGIN, VERSION_FILE_ID, [])).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/versions/alice/versions/4242/</d:href><d:propstat><d:prop><d:resourcetype><d:collection></d:collection></d:resourcetype><d:getlastmodified>Thu, 01 Jan 1970 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })

  it('buildSingleVersionMultistatus — no self entry, and null label/author render as empty elements', () => {
    expect(buildSingleVersionMultistatus(VERSION_LOGIN, VERSION_FILE_ID, versionEntry({ label: null, author: null }))).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/versions/alice/versions/4242/1714742400</d:href><d:propstat><d:prop><d:getcontentlength>1234</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><d:getlastmodified>Fri, 03 May 2024 13:20:00 GMT</d:getlastmodified><d:creationdate>2024-05-03T13:20:00.000Z</d:creationdate><d:getetag>1714742400</d:getetag><d:resourcetype></d:resourcetype><oc:id>4242</oc:id><oc:size>1234</oc:size><nc:version-label></nc:version-label><nc:version-author></nc:version-author><nc:has-preview>false</nc:has-preview></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })

  it('buildVersionLabelAck', () => {
    expect(buildVersionLabelAck('/remote.php/dav/versions/alice/versions/4242/1714742400')).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/versions/alice/versions/4242/1714742400</d:href><d:propstat><d:prop><nc:version-label></nc:version-label></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })
})

// ──────── nc-comment-xml ────────

describe('wire-format pin: nc-comment-xml', () => {
  it('buildCommentsMultistatus — one comment, with XML-special characters escaped by the builder', () => {
    expect(
      buildCommentsMultistatus([
        {
          commentId: 7,
          fileId: 42,
          actorId: 'alice',
          actorDisplayName: 'Alice Liddell',
          message: 'a < b & c > d',
          createdAt: new Date(1_746_282_181_000)
        }
      ])
    ).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/comments/files/42/7</d:href><d:propstat><d:prop><oc:id>7</oc:id><oc:verb>comment</oc:verb><oc:actorType>users</oc:actorType><oc:actorId>alice</oc:actorId><oc:creationDateTime>Sat, 03 May 2025 14:23:01 GMT</oc:creationDateTime><oc:objectType>files</oc:objectType><oc:objectId>42</oc:objectId><oc:isUnread>false</oc:isUnread><oc:message>a &lt; b &amp; c &gt; d</oc:message><oc:actorDisplayName>Alice Liddell</oc:actorDisplayName></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })

  // An empty entry list must still produce a well-formed, CHILDLESS multistatus
  // — not a self-closing one. `suppressEmptyNode: false` is what guarantees the
  // explicit close tag, and an empty `d:response` array contributes nothing.
  it('buildCommentsMultistatus — no comments is an explicitly-closed empty multistatus', () => {
    expect(buildCommentsMultistatus([])).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"></d:multistatus>'
    )
  })

  // TWO namespaces here, not three: this ack never emits an `nc:` prop.
  it('buildProppatchAck', () => {
    expect(buildProppatchAck('/remote.php/dav/comments/files/42/7', 'oc:message')).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/comments/files/42/7</d:href><d:propstat><d:prop><oc:message></oc:message></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    )
  })
})

// ──────── nc-uploads.controller ────────
//
// The odd one out: this body is a RAW TEMPLATE STRING, so it is the only
// multistatus in the module that is pretty-printed (two-space indent, newline
// per element) and the only one whose empty elements are self-closing
// (`<d:collection/>`, `<d:resourcetype/>`) rather than explicitly closed. Both
// differences are consequences of hand-writing the XML rather than of any
// client requirement — pinned here so that folding this emitter into the shared
// builder shows up as an explicit, reviewable byte diff rather than a silent
// reformat.

describe('wire-format pin: nc-uploads buildUploadDirPropfindBody', () => {
  it('collection only (depth 0 / no chunks yet), with the href XML-escaped', () => {
    expect(buildUploadDirPropfindBody('/remote.php/dav/uploads/alice/A&B', [])).toBe(
      `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/uploads/alice/A&amp;B</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
    )
  })

  it('collection plus one response per staged chunk (Android sums these for resume)', () => {
    expect(
      buildUploadDirPropfindBody('/remote.php/dav/uploads/alice/tx', [
        { name: '0', size: 1048576, mtimeMs: 1_716_220_800_000 },
        { name: 'part one', size: 524288, mtimeMs: 1_716_220_800_000 }
      ])
    ).toBe(
      `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/uploads/alice/tx</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/uploads/alice/tx/0</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>1048576</d:getcontentlength>
        <d:getlastmodified>Mon, 20 May 2024 16:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/uploads/alice/tx/part%20one</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>524288</d:getcontentlength>
        <d:getlastmodified>Mon, 20 May 2024 16:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
    )
  })
})
