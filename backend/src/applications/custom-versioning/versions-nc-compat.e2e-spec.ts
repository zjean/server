import fs from 'node:fs/promises'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// Phase E, cases E2E-5 and E2E-10: the Nextcloud-facing surfaces, over real HTTP
// with a real minted app-password.
//
// WHY THESE ARE WORTH THE SETUP. The NC versions tree's three load-bearing wire
// facts cannot be proven by a passing unit test of the XML builder — the builder
// can be perfectly correct while the ROUTE hands it the wrong number, or while
// the capability that gates the client is off. Each of the three silently breaks
// a client rather than erroring:
//
//   1. the collection's own entry must be response[0] (Android discards it),
//   2. a version's node name must be its mtime in unix SECONDS and must agree
//      with d:getlastmodified (Android derives the restore MOVE source from the
//      parsed date, never from the href),
//   3. d:resourcetype must be an EMPTY element (any value makes Android treat
//      the version as a directory).
//
// Authorization here is an app-password, not the user's login password:
// NcBasicAuthGuard accepts only AUTH_SCOPE.MOBILE_NC credentials and rejects the
// main password on purpose, matching Nextcloud's posture. `e2e.ncAuth` is that
// credential.
describe('versions NC compatibility (e2e)', () => {
  let e2e: VersionsE2EContext

  beforeAll(async () => {
    e2e = await setupVersionsE2E()
  })

  afterAll(async () => await e2e?.teardown())

  beforeEach(() => {
    e2e.restoreConfig()
    e2e.config.enabled = true
    e2e.config.minIntervalSeconds = 0
    e2e.config.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 0 } as never
  })

  const nc = (method: string, url: string, extra: { headers?: Record<string, string>; payload?: string } = {}) =>
    e2e.app.inject({
      method,
      url,
      headers: { authorization: e2e.ncAuth, ...(extra.headers ?? {}) },
      ...(extra.payload === undefined ? {} : { payload: extra.payload })
    } as never)

  const versionsUrl = (fileId: number) => `/remote.php/dav/versions/${e2e.user.login}/versions/${fileId}`

  // Produce a file with history and return the fileId the NC tree addresses.
  //
  // Each generation's mtime is pushed a distinct number of seconds into the past
  // BEFORE it is overwritten, because a version records the live file's mtime at
  // snapshot time and the NC tree identifies a version by that mtime in whole
  // SECONDS. Two overwrites in the same wall-clock second therefore produce two
  // rows that collapse to ONE entry on the NC surface — real behaviour, asserted
  // deliberately further down, but not what most of these cases are about.
  const seedWithHistory = async (rel: string, generations: string[]) => {
    await e2e.seed(rel, generations[0])
    let agoSeconds = generations.length * 10
    for (const content of generations.slice(1)) {
      const at = new Date(Date.now() - agoSeconds * 1000)
      await fs.utimes(e2e.filesPath(rel), at, at)
      await e2e.overwrite(rel, content, 'web')
      agoSeconds -= 10
    }
    const versions = await e2e.versionsOf(rel)
    expect(versions.length).toBe(generations.length - 1)
    return { fileId: versions[0].fileId, versions }
  }

  /* ----------------------------------------------------------------- E2E-10 */

  describe('E2E-10 the NC versions DAV tree', () => {
    it('lists a file’s history, with the collection itself as the FIRST response', async () => {
      const rel = 'nc10-list.txt'
      const { fileId, versions } = await seedWithHistory(rel, ['nc gen 0', 'nc gen 1', 'nc gen 2'])

      const res = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      expect(res.statusCode).toBe(207)

      const responses = [...res.body.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((m) => m[1])
      // One self entry + one per version. ReadFileVersionsRemoteOperation loops
      // from index 1, discarding response[0] — omit the self entry and Android
      // silently loses the oldest version on every listing.
      expect(responses).toHaveLength(versions.length + 1)
      expect(responses[0]).toContain(`${versionsUrl(fileId)}/</d:href>`)
      expect(responses[0]).toContain('<d:collection>')
    })

    // Fact (2). Asserted the way the CLIENT computes it: parse d:getlastmodified,
    // divide by 1000, and require the href's last segment back.
    it('names each version with the unix second its d:getlastmodified encodes', async () => {
      const rel = 'nc10-revision.txt'
      const { fileId } = await seedWithHistory(rel, ['revision naming gen 0', 'revision naming gen 1'])

      const res = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const [, version] = [...res.body.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((m) => m[1])

      const href = /<d:href>([^<]+)<\/d:href>/.exec(version)![1]
      const lastModified = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(version)![1]
      const nameFromHref = Number(href.split('/').pop())
      const nameAndroidWillDerive = Math.floor(new Date(lastModified).getTime() / 1000)

      expect(nameFromHref).toBeGreaterThan(0)
      expect(nameAndroidWillDerive).toBe(nameFromHref)
    })

    // Fact (3). Android's WebdavEntry turns ANY non-null resourcetype value into
    // contentType "DIR", which makes FileVersion.isFolder() true.
    it('emits an empty d:resourcetype for a version, and a bare unquoted ETag', async () => {
      const rel = 'nc10-props.txt'
      const { fileId } = await seedWithHistory(rel, ['props gen 0', 'props gen 1'])

      const res = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const [, version] = [...res.body.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((m) => m[1])

      expect(version).toMatch(/<d:resourcetype><\/d:resourcetype>|<d:resourcetype\/>/)
      expect(version).not.toContain('<d:collection>')
      // VersionFile::getETag() returns the bare revision id — not quoted, not weak.
      const etag = /<d:getetag>([^<]*)<\/d:getetag>/.exec(version)![1]
      expect(etag).toMatch(/^\d+$/)
      expect(version).not.toContain('W/')
      // has-preview is always false: we serve no version-preview route.
      expect(version).toContain('<nc:has-preview>false</nc:has-preview>')
    })

    it('downloads a version’s exact bytes, named after the source file', async () => {
      const rel = 'nc10-download.txt'
      const { fileId } = await seedWithHistory(rel, ['download gen 0', 'download gen 1'])

      const list = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(list.body)![1]

      const res = await nc('GET', `${versionsUrl(fileId)}/${revision}`)
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('download gen 0')
      expect(String(res.headers['content-disposition'])).toContain(rel)
      expect(String(res.headers['etag'])).toBe(revision)
    })

    // Restore is a MOVE of the version INTO the sibling `restore` collection —
    // upstream's RestoreFolder::moveInto calls rollBack. The request lands on the
    // version's own route because a WebDAV MOVE addresses the SOURCE.
    it('restores through a MOVE into the restore collection, answering 204', async () => {
      const rel = 'nc10-restore.txt'
      const { fileId } = await seedWithHistory(rel, ['nc restore original', 'nc restore clobbered'])
      const statBefore = await fs.stat(e2e.filesPath(rel))

      const list = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(list.body)![1]

      const res = await nc('MOVE', `${versionsUrl(fileId)}/${revision}`, {
        // Android sends the fileId as the target name; upstream ignores the name
        // entirely and only the collection matters.
        headers: { destination: `/remote.php/dav/versions/${e2e.user.login}/restore/${fileId}` }
      })

      // RestoreFileVersionRemoteOperation accepts 201 or 204.
      expect([201, 204]).toContain(res.statusCode)
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('nc restore original')
      // Same inode as everywhere else — a restore never replaces it.
      expect((await fs.stat(e2e.filesPath(rel))).ino).toBe(statBefore.ino)
    })

    it('400s a MOVE that targets anything other than the restore collection', async () => {
      const rel = 'nc10-badmove.txt'
      const { fileId } = await seedWithHistory(rel, ['badmove original', 'badmove clobbered'])
      const list = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(list.body)![1]

      const res = await nc('MOVE', `${versionsUrl(fileId)}/${revision}`, {
        headers: { destination: `/remote.php/dav/files/${e2e.user.login}/${rel}` }
      })

      expect(res.statusCode).toBe(400)
      // Silently restoring here would turn a client bug into a content overwrite.
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('badmove clobbered')
    })

    it('names a version through PROPPATCH of nc:version-label', async () => {
      const rel = 'nc10-label.txt'
      const { fileId } = await seedWithHistory(rel, ['nc label gen 0', 'nc label gen 1'])
      const list = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(list.body)![1]

      const res = await nc('PROPPATCH', `${versionsUrl(fileId)}/${revision}`, {
        headers: { 'content-type': 'application/xml' },
        payload:
          '<d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>from nextcloud</nc:version-label></d:prop></d:set></d:propertyupdate>'
      })

      expect(res.statusCode).toBe(207)
      expect((await e2e.versionsOf(rel))[0].label).toBe('from nextcloud')
    })

    it('deletes a version, including a NAMED one, since the protocol carries no confirmation flag', async () => {
      const rel = 'nc10-delete.txt'
      const { fileId, versions } = await seedWithHistory(rel, ['nc delete gen 0', 'nc delete gen 1'])
      await e2e.api.label(versions[0].id, rel, 'named but deletable over NC')

      const list = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(list.body)![1]

      const res = await nc('DELETE', `${versionsUrl(fileId)}/${revision}`)
      expect(res.statusCode).toBe(204)
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
    })

    // THE ACCEPTED COST of identifying a version by its mtime in seconds, which
    // is forced by the client (Android derives the restore MOVE source from the
    // parsed d:getlastmodified, never from the href). Upstream cannot represent
    // two versions in one second either — both would want the same `.v<ts>`
    // storage filename. The v2 UI keys on the row id and still shows both.
    it('collapses two versions that share a unix second into one NC entry, keeping the newest', async () => {
      const rel = 'nc10-collapse.txt'
      // No mtime spacing here: both overwrites land in the same second.
      await e2e.seed(rel, 'collapse gen 0')
      await e2e.overwrite(rel, 'collapse gen 1', 'web')
      await e2e.overwrite(rel, 'collapse gen 2', 'web')
      const rows = await e2e.versionsOf(rel)
      expect(rows).toHaveLength(2)
      expect(Math.floor(rows[0].mtime / 1000)).toBe(Math.floor(rows[1].mtime / 1000))

      const res = await nc('PROPFIND', versionsUrl(rows[0].fileId), { headers: { depth: '1' } })
      const responses = [...res.body.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((m) => m[1])

      // Self entry + ONE version, not two: a client cannot address two nodes
      // with the same name, and emitting both would make its restore ambiguous.
      expect(responses).toHaveLength(2)
      // The newest row wins, deterministically.
      const revision = /<d:href>[^<]*\/versions\/\d+\/(\d+)<\/d:href>/.exec(res.body)![1]
      const download = await nc('GET', `${versionsUrl(rows[0].fileId)}/${revision}`)
      expect(download.body).toBe('collapse gen 1')
    })

    it('403s a request for another user’s principal, and 404s an unknown file', async () => {
      const rel = 'nc10-scope.txt'
      const { fileId } = await seedWithHistory(rel, ['scope gen 0', 'scope gen 1'])

      const otherPrincipal = await nc('PROPFIND', `/remote.php/dav/versions/somebody-else/versions/${fileId}`, { headers: { depth: '1' } })
      expect(otherPrincipal.statusCode).toBe(403)

      const unknownFile = await nc('PROPFIND', versionsUrl(999_999_999), { headers: { depth: '1' } })
      expect(unknownFile.statusCode).toBe(404)
    })

    it('rejects the user’s main password — only an app-password reaches the NC tree', async () => {
      const rel = 'nc10-auth.txt'
      const { fileId } = await seedWithHistory(rel, ['auth gen 0', 'auth gen 1'])

      const res = await e2e.app.inject({
        method: 'PROPFIND',
        url: versionsUrl(fileId),
        headers: {
          authorization: `Basic ${Buffer.from(`${e2e.user.login}:password`).toString('base64')}`,
          depth: '1'
        }
      } as never)

      expect(res.statusCode).toBe(401)
    })

    it('404s the whole tree while the feature flag is off, so a client never learns it exists', async () => {
      const rel = 'nc10-flag.txt'
      const { fileId } = await seedWithHistory(rel, ['flag gen 0', 'flag gen 1'])

      e2e.config.enabled = false
      const res = await nc('PROPFIND', versionsUrl(fileId), { headers: { depth: '1' } })
      expect(res.statusCode).toBe(404)
    })
  })

  /* ------------------------------------------------------------------ E2E-5 */

  // The NC chunked upload assembles staged chunks and MOVEs the result over the
  // destination. That final move is the destructive moment, and it BYPASSES
  // saveStream entirely — which is why it needs its own hook and its own case.
  // One completed upload is one version, however many chunks fed it.
  describe('E2E-5 NC chunked upload', () => {
    it('versions the destination once at assemble-and-move, tagged nc-chunked', async () => {
      const rel = 'nc5-chunked.txt'
      await e2e.seed(rel, 'the content NC chunked upload will replace')

      const uploadId = `e2e-chunked-${Date.now()}`
      const uploadRoot = `/remote.php/dav/uploads/${e2e.user.login}/${uploadId}`
      expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)

      // Chunk names are what the client sends; the server assembles in name
      // order, which is why NC pads them.
      const chunks = ['00000001', '00000002', '00000003']
      const payloads = ['chunk-one-', 'chunk-two-', 'chunk-three']
      for (const [i, name] of chunks.entries()) {
        const res = await nc('PUT', `${uploadRoot}/${name}`, { payload: payloads[i] })
        expect([200, 201, 204]).toContain(res.statusCode)
      }

      const move = await nc('MOVE', `${uploadRoot}/.file`, {
        headers: { destination: `/remote.php/dav/files/${e2e.user.login}/${rel}` }
      })
      expect([201, 204]).toContain(move.statusCode)

      // The assembled content landed…
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe(payloads.join(''))
      // …and exactly one version holds what it replaced, not one per chunk.
      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect(versions[0].origin).toBe('nc-chunked')
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('the content NC chunked upload will replace')
    })

    it('creates no version when the chunked upload lands on a new path', async () => {
      const rel = 'nc5-chunked-new.txt'
      const uploadId = `e2e-chunked-new-${Date.now()}`
      const uploadRoot = `/remote.php/dav/uploads/${e2e.user.login}/${uploadId}`

      expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)
      expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/00000001`, { payload: 'brand new' })).statusCode)
      const move = await nc('MOVE', `${uploadRoot}/.file`, {
        headers: { destination: `/remote.php/dav/files/${e2e.user.login}/${rel}` }
      })
      expect([201, 204]).toContain(move.statusCode)

      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('brand new')
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
    })
  })

  /* ------------------------------------------------- the OCS capability gate */

  // NC Android gates its ENTIRE version list on files.versioning being true
  // before it ever PROPFINDs the tree above, so the capability and the routes
  // have to agree. They do, because both read the same flag.
  describe('the files.versioning capability', () => {
    const capabilities = async () => {
      const res = await nc('GET', '/ocs/v2.php/cloud/capabilities', { headers: { accept: 'application/json' } })
      expect(res.statusCode).toBe(200)
      return (res.json() as { ocs: { data: { capabilities: { files: Record<string, unknown> } } } }).ocs.data.capabilities.files
    }

    it('advertises versioning plus labeling and deletion while the feature is on', async () => {
      e2e.config.enabled = true
      const files = await capabilities()
      expect(files.versioning).toBe(true)
      expect(files.version_labeling).toBe(true)
      expect(files.version_deletion).toBe(true)
      // The key is files.versioning — `files_versions` is the app id, not the
      // capability.
      expect(files.files_versions).toBeUndefined()
    })

    it('reports versioning false and omits the other two while the flag is off', async () => {
      e2e.config.enabled = false
      const files = await capabilities()
      expect(files.versioning).toBe(false)
      expect(files.version_labeling).toBeUndefined()
      expect(files.version_deletion).toBeUndefined()
    })
  })

  /* ---------------------------------------------- the activity prerequisite */

  // Not a versioning endpoint, but the reason the version list renders at all on
  // Android: FileDetailActivitiesFragment fetches activities AND versions in one
  // task and calls populateList only when the ACTIVITIES result parsed. The
  // requirement is an OCS-SHAPED body — parseResult navigates
  // ocs.data unconditionally and NPEs on any body without an `ocs` key.
  describe('the activity feed the Android version list depends on', () => {
    it('answers an ocs envelope whose data is an array, for both the feed and the per-file filter', async () => {
      const rel = 'nc-activity.txt'
      const { fileId } = await seedWithHistory(rel, ['activity gen 0', 'activity gen 1'])

      for (const url of [
        '/ocs/v2.php/apps/activity/api/v2/activity',
        `/ocs/v2.php/apps/activity/api/v2/activity/filter?object_type=files&object_id=${fileId}`
      ]) {
        const res = await nc('GET', url, { headers: { accept: 'application/json' } })
        expect(res.statusCode).toBe(200)
        const body = res.json() as { ocs: { meta: { statuscode: number }; data: unknown[] } }
        expect(Array.isArray(body.ocs.data)).toBe(true)
        expect(body.ocs.meta.statuscode).toBe(200)
      }
    })
  })
})
