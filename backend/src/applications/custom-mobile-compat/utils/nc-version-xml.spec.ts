import {
  buildSingleVersionMultistatus,
  buildVersionLabelAck,
  buildVersionsMultistatus,
  isRestoreDestination,
  parseVersionLabelProppatch,
  versionHref,
  versionsCollectionHref,
  type NcVersionXmlEntry
} from './nc-version-xml'

// Wire-format tests for the NC file-versions DAV tree.
//
// Every assertion here traces to upstream source rather than to a convention;
// the citation is on the test. The three that would silently break a client if
// they regressed are marked — those are not style, they are the whole feature.

const LOGIN = 'alice'
const FILE_ID = 4242

// 2026-07-20T10:00:00Z
const MTIME_MS = 1_753_005_600_000
const REVISION = Math.floor(MTIME_MS / 1000)

function entry(overrides: Partial<NcVersionXmlEntry> = {}): NcVersionXmlEntry {
  return {
    revision: REVISION,
    mtimeMs: MTIME_MS,
    size: 1234,
    contentType: 'text/plain',
    label: null,
    author: 'alice',
    ...overrides
  }
}

// Pull one <d:response> block out of a rendered body, in document order.
function responses(body: string): string[] {
  return [...body.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((m) => m[1])
}

function prop(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  if (match) return match[1]
  return new RegExp(`<${name}/>`).test(block) ? '' : undefined
}

describe('nc-version-xml', () => {
  describe('buildVersionsMultistatus', () => {
    // THE ONE THAT SILENTLY LOSES DATA IF IT REGRESSES.
    // ReadFileVersionsRemoteOperation.readData loops `for (int i = 1; ...)` —
    // response[0] is discarded unconditionally as the collection itself. Drop
    // the self entry and Android loses the oldest version on every listing,
    // with no error anywhere.
    it('emits the collection itself as the FIRST response, because Android discards response[0]', () => {
      const body = buildVersionsMultistatus(LOGIN, FILE_ID, [entry()])
      const blocks = responses(body)

      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toContain(`<d:href>${versionsCollectionHref(LOGIN, FILE_ID)}/</d:href>`)
      expect(blocks[0]).toContain('<d:collection></d:collection>')
      expect(blocks[1]).toContain(`<d:href>${versionHref(LOGIN, FILE_ID, REVISION)}</d:href>`)
    })

    it('still emits the self entry for a file with no history', () => {
      const blocks = responses(buildVersionsMultistatus(LOGIN, FILE_ID, []))
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('<d:collection></d:collection>')
    })

    // THE SECOND ONE THAT BREAKS RESTORE.
    // FileVersion.getFileName() is String.valueOf(modifiedTimestamp / 1000),
    // parsed out of d:getlastmodified — the href is never read — and
    // RestoreFileVersionRemoteOperation builds the MOVE source from that name.
    // If the href's last segment and getlastmodified disagree, every restore
    // targets a revision that does not exist.
    it('names the node with the same unix second that d:getlastmodified encodes', () => {
      const [, version] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry()]))

      const href = prop(version, 'd:href')!
      const lastModified = prop(version, 'd:getlastmodified')!
      const nameFromHref = Number(href.split('/').pop())
      const nameAndroidWillDerive = Math.floor(new Date(lastModified).getTime() / 1000)

      expect(nameFromHref).toBe(REVISION)
      expect(nameAndroidWillDerive).toBe(nameFromHref)
      // RFC 1123, which is what WebdavUtils.parseResponseDate accepts.
      expect(lastModified).toBe(new Date(MTIME_MS).toUTCString())
    })

    // THE THIRD ONE. Android's WebdavEntry turns ANY non-null resourcetype
    // value into contentType "DIR" (WebdavEntry.kt:152-160), which makes
    // FileVersion.isFolder() true — it then reads the size from oc:size and
    // treats the version as a directory. The element must be EMPTY.
    it('emits an empty d:resourcetype for a version, never a collection', () => {
      const [, version] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry()]))
      expect(prop(version, 'd:resourcetype')).toBe('')
      expect(version).not.toContain('<d:collection>')
    })

    it('emits the prop set ReadFileVersions actually asks for', () => {
      // WebdavUtils.getFileVersionPropSet: getcontenttype, resourcetype,
      // getcontentlength, getlastmodified, creationdate, oc:id, oc:size.
      const [, version] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry()]))

      expect(prop(version, 'd:getcontentlength')).toBe('1234')
      expect(prop(version, 'd:getcontenttype')).toBe('text/plain')
      expect(prop(version, 'd:creationdate')).toBe(new Date(MTIME_MS).toISOString())
      // oc:id is the SOURCE file's id — upstream's FileVersion carries the
      // file's localId, there is no per-version identity on the wire.
      expect(prop(version, 'oc:id')).toBe(String(FILE_ID))
      expect(prop(version, 'oc:size')).toBe('1234')
      expect(version).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
    })

    // VersionFile::getETag() returns (string)$this->version->getRevisionId() —
    // bare and unquoted, because sabre emits whatever the node returns. The
    // fork's strong-ETag rule is about the FILES tree, where a W/ prefix lands
    // in an iOS thumbnail path; it does not apply here and inventing quotes
    // would be a shape no client has been tested against.
    it('emits d:getetag as the bare revision id, matching VersionFile::getETag', () => {
      const [, version] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry()]))
      expect(prop(version, 'd:getetag')).toBe(String(REVISION))
      expect(version).not.toContain('W/')
    })

    it('emits the nc: label and author props, empty when absent', () => {
      const [, labeled] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry({ label: 'before the rewrite', author: 'bob' })]))
      expect(prop(labeled, 'nc:version-label')).toBe('before the rewrite')
      expect(prop(labeled, 'nc:version-author')).toBe('bob')

      const [, bare] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry({ label: null, author: null })]))
      expect(prop(bare, 'nc:version-label')).toBe('')
      expect(prop(bare, 'nc:version-author')).toBe('')
    })

    // Deliberate divergence from upstream, which emits true for image mimes and
    // backs it with apps/files_versions' own /preview route. We serve no such
    // route, so a truthy value would either mean a 404 per row per listing or a
    // CURRENT thumbnail shown beside an OLD revision.
    it('always emits nc:has-preview false, in word form, even for an image', () => {
      const [, version] = responses(buildVersionsMultistatus(LOGIN, FILE_ID, [entry({ contentType: 'image/jpeg' })]))
      expect(prop(version, 'nc:has-preview')).toBe('false')
    })

    it('declares the three namespaces NC clients bind', () => {
      const body = buildVersionsMultistatus(LOGIN, FILE_ID, [])
      expect(body).toContain('xmlns:d="DAV:"')
      expect(body).toContain('xmlns:oc="http://owncloud.org/ns"')
      expect(body).toContain('xmlns:nc="http://nextcloud.org/ns"')
      expect(body.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
    })

    it('escapes a label containing XML metacharacters', () => {
      const body = buildVersionsMultistatus(LOGIN, FILE_ID, [entry({ label: 'a & b <c>' })])
      expect(body).toContain('a &amp; b &lt;c&gt;')
    })

    it('percent-encodes a login with reserved characters in the href', () => {
      const body = buildVersionsMultistatus('a b/c', FILE_ID, [])
      expect(body).toContain('/remote.php/dav/versions/a%20b%2Fc/versions/4242/')
    })

    it('lists entries in the order given, so the caller owns newest-first', () => {
      const older = entry({ revision: REVISION - 600, mtimeMs: MTIME_MS - 600_000 })
      const body = buildVersionsMultistatus(LOGIN, FILE_ID, [entry(), older])
      const [, first, second] = responses(body)
      expect(prop(first, 'd:href')).toContain(String(REVISION))
      expect(prop(second, 'd:href')).toContain(String(REVISION - 600))
    })
  })

  describe('buildSingleVersionMultistatus', () => {
    // No self-collection entry: the addressed resource IS the version, so it is
    // response[0] and nothing skips it.
    it('emits exactly one response, the version itself', () => {
      const blocks = responses(buildSingleVersionMultistatus(LOGIN, FILE_ID, entry()))
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain(`<d:href>${versionHref(LOGIN, FILE_ID, REVISION)}</d:href>`)
    })
  })

  describe('parseVersionLabelProppatch', () => {
    const set = (value: string) =>
      `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>${value}</nc:version-label></d:prop></d:set></d:propertyupdate>`

    it('reads the new label out of a d:set', () => {
      expect(parseVersionLabelProppatch(set('release candidate'))).toBe('release candidate')
    })

    it('accepts a Buffer body, which is what the fallback parser yields', () => {
      expect(parseVersionLabelProppatch(Buffer.from(set('from a buffer')))).toBe('from a buffer')
    })

    // '' and null both mean "clear it" — VersioningService.setLabel normalizes
    // blank input to null, so the two converge in the service rather than here.
    it('treats an empty element as clearing the label', () => {
      expect(parseVersionLabelProppatch(set(''))).toBe('')
    })

    // Upstream has no remove handler for version-label at all; mapping remove
    // onto "clear" is the only reading that does not throw away the request.
    it('treats a d:remove as clearing the label', () => {
      const body =
        '<d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:remove><d:prop><nc:version-label/></d:prop></d:remove></d:propertyupdate>'
      expect(parseVersionLabelProppatch(body)).toBeNull()
    })

    it('reads the label regardless of the namespace prefix the client chose', () => {
      const body =
        '<propertyupdate xmlns="DAV:" xmlns:x="http://nextcloud.org/ns"><set><prop><x:version-label>prefixed</x:version-label></prop></set></propertyupdate>'
      expect(parseVersionLabelProppatch(body)).toBe('prefixed')
    })

    // undefined, not null: the caller must be able to tell "clear the label"
    // from "this is not a version-label request" — the latter is a 400.
    it.each([
      ['an empty body', ''],
      ['a non-XML body', 'not xml at all'],
      [
        'a propertyupdate for a different property',
        '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>x</d:getlastmodified></d:prop></d:set></d:propertyupdate>'
      ],
      ['a body that is not a propertyupdate', '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'],
      ['a null body', null]
    ])('returns undefined for %s', (_label, body) => {
      expect(parseVersionLabelProppatch(body)).toBeUndefined()
    })
  })

  describe('isRestoreDestination', () => {
    // RestoreFileVersionRemoteOperation sends the fileId as the target name;
    // the NC web UI sends the file name. RestoreFolder::moveInto ignores the
    // name entirely, so only the collection can be load-bearing.
    it.each([
      ['the Android form (absolute URL, fileId as name)', 'https://cloud.example.test/remote.php/dav/versions/alice/restore/4242'],
      ['a path-relative Destination', '/remote.php/dav/versions/alice/restore/4242'],
      ['a file name as the target', '/remote.php/dav/versions/alice/restore/report.txt'],
      ['a percent-encoded login', '/remote.php/dav/versions/alice/restore/a%20b.txt']
    ])('accepts %s', (_label, destination) => {
      expect(isRestoreDestination(destination, LOGIN)).toBe(true)
    })

    // A MOVE anywhere else is not a restore, and treating it as one would turn a
    // client bug into a content overwrite.
    it.each([
      ['the files tree', '/remote.php/dav/files/alice/report.txt'],
      ['another version', '/remote.php/dav/versions/alice/versions/4242/1753005000'],
      ["another user's restore folder", '/remote.php/dav/versions/bob/restore/4242'],
      ['the restore collection itself, with no target name', '/remote.php/dav/versions/alice/restore'],
      ['an empty destination', ''],
      ['no destination', undefined]
    ])('rejects %s', (_label, destination) => {
      expect(isRestoreDestination(destination, LOGIN)).toBe(false)
    })
  })

  describe('buildVersionLabelAck', () => {
    it('acknowledges the handled property with a 207 propstat', () => {
      const body = buildVersionLabelAck(versionHref(LOGIN, FILE_ID, REVISION))
      expect(body).toContain(`<d:href>${versionHref(LOGIN, FILE_ID, REVISION)}</d:href>`)
      expect(body).toContain('<nc:version-label></nc:version-label>')
      expect(body).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
    })
  })
})
