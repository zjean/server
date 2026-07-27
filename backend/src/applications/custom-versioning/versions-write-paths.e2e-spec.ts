import fs from 'node:fs/promises'
import path from 'node:path'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// Phase E: the write paths and the invariants that only a real DB + real
// filesystem can prove.
//
// Cases covered here: E2E-3 (WebDAV), E2E-6 (trash), E2E-9 (dedup/refcount),
// E2E-13 (flag off), E2E-16 (copyMove), E2E-18 (mkFile truncate),
// E2E-19 (rename/move anchor) and E2E-20 (row ensuring).
//
// The write paths are driven at SERVICE level rather than over each protocol.
// That is deliberate: the seven destructive entry points are reached over five
// transports, and fabricating each transport would test the transport instead of
// the hook. The one exception is WebDAV, which gets a real HTTP request, because
// D1's claim is specifically about the DAV request shape.
describe('versions write paths and invariants (e2e)', () => {
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

  const blobFor = (checksum: string) => e2e.versionsPath(`${checksum.slice(0, 2)}/${checksum}`)

  /* ------------------------------------------------------------------ E2E-3 */

  describe('E2E-3 WebDAV', () => {
    const basic = () => `Basic ${Buffer.from(`${e2e.user.login}:password`).toString('base64')}`

    const put = (rel: string, payload: string, headers: Record<string, string> = {}) =>
      e2e.app.inject({
        method: 'PUT',
        url: `/webdav/personal/${rel}`,
        headers: { authorization: basic(), 'content-type': 'text/plain', ...headers },
        payload
      } as never)

    it('creates no version on the first PUT and one per later PUT, tagged webdav', async () => {
      const rel = 'e2e3-dav.txt'

      const created = await put(rel, 'dav revision one')
      expect([201, 204]).toContain(created.statusCode)
      expect(await e2e.versionsOf(rel)).toHaveLength(0)

      const overwritten = await put(rel, 'dav revision two')
      expect([201, 204]).toContain(overwritten.statusCode)

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect(versions[0].origin).toBe('webdav')
      const content = await e2e.api.content(versions[0].id, rel)
      expect(content.body).toBe('dav revision one')
    })

    // D1.1. A client resuming an overwrite issues a whole SEQUENCE against one
    // path: a plain PUT that truncates and writes the head, then one PUT per
    // remaining chunk carrying Content-Range. Only the first can see
    // startRange 0 — and it is the only one that still has the pre-upload bytes
    // in front of it, which is why exactly one version comes out of the whole
    // sequence and it holds the FULL previous content, never a partial.
    it('produces exactly ONE version across a resumed content-range PUT sequence, holding the full pre-upload content', async () => {
      const rel = 'e2e3-resumed.txt'
      await put(rel, 'the complete previous revision')
      expect(await e2e.versionsOf(rel)).toHaveLength(0)

      const head = 'HEAD-'
      expect([201, 204]).toContain((await put(rel, head)).statusCode)
      // Each chunk is offered at the file's current size, which is what
      // saveStream validates (`startRange !== size` is a 400).
      let size = Buffer.byteLength(head)
      for (const chunk of ['MIDDLE-', 'TAIL']) {
        const res = await put(rel, chunk, { 'content-range': `bytes ${size}-${size + Buffer.byteLength(chunk) - 1}/999` })
        expect([201, 204]).toContain(res.statusCode)
        size += Buffer.byteLength(chunk)
      }

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      // The whole previous revision, not a frankenfile of old and new bytes.
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('the complete previous revision')
      // And the sequence really did assemble.
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('HEAD-MIDDLE-TAIL')
    })

    // D1.4 / ADR §1. There is no exclusion filter anywhere: the versions store is
    // invisible to WebDAV, the content indexer and desktop sync ONLY because it
    // is a sibling of files/. This asserts it against a real PROPFIND.
    it('never lists the versions store in a PROPFIND of the space root', async () => {
      const rel = 'e2e3-propfind.txt'
      await put(rel, 'one')
      await put(rel, 'two')
      expect(await e2e.versionsOf(rel)).toHaveLength(1)

      const res = await e2e.app.inject({
        method: 'PROPFIND',
        url: '/webdav/personal',
        headers: { authorization: basic(), depth: '1' }
      } as never)

      expect(res.statusCode).toBe(207)
      expect(res.body).toContain(rel)
      expect(res.body).not.toContain('versions')
    })
  })

  /* ----------------------------------------------------------------- E2E-18 */

  // `mkFile(overwrite=true)` is "make a file", and it DESTROYS content — the one
  // entry point a saveStream-centric design misses entirely. One hook covers
  // both of its branches (createEmptyFile and the sample-document copy).
  describe('E2E-18 mkFile truncate', () => {
    it('versions the pre-truncation content before zeroing an existing file', async () => {
      const rel = 'e2e18-mkfile.txt'
      await e2e.seed(rel, 'content that mkFile is about to destroy')

      await e2e.filesManager.mkFile(e2e.user, await e2e.spaceEnv(rel), true)

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect(versions[0].origin).toBe('sync-make')
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('content that mkFile is about to destroy')
      // The live file really was truncated.
      expect((await fs.stat(e2e.filesPath(rel))).size).toBe(0)
    })

    it('does not version a plain create', async () => {
      const rel = 'e2e18-create.txt'
      await e2e.filesManager.mkFile(e2e.user, await e2e.spaceEnv(rel), false)
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
    })
  })

  /* ----------------------------------------------------------------- E2E-19 */

  // THE CASE THAT MAKES ADR §15 ENFORCEABLE. Version rows key on files.id, never
  // on path, so a rename is free — `moveFiles` regexp-updates files.path while
  // files.id is unchanged. Under the rejected path-keyed design every rename
  // would have needed a parallel repath, and any miss would orphan a file's
  // entire history. This fails loudly if anyone re-keys on path.
  describe('E2E-19 rename (the anchor invariant)', () => {
    it('keeps history, with the same ids and the same content, across a rename', async () => {
      const from = 'e2e19-before-rename.txt'
      const to = 'e2e19-after-rename.txt'
      await e2e.seed(from, 'anchor revision one')
      await e2e.overwrite(from, 'anchor revision two', 'web')
      await e2e.overwrite(from, 'anchor revision three', 'web')

      const before = await e2e.versionsOf(from)
      expect(before).toHaveLength(2)

      await e2e.filesManager.copyMove(e2e.user, await e2e.spaceEnv(from), await e2e.spaceEnv(to), true, true)
      expect(await fs.readFile(e2e.filesPath(to), 'utf8')).toBe('anchor revision three')

      const after = await e2e.versionsOf(to)
      expect(after.map((v) => v.id)).toEqual(before.map((v) => v.id))
      expect(after.map((v) => v.fileId)).toEqual(before.map((v) => v.fileId))
      // Still downloadable under the NEW path, which is the half a path-keyed
      // design would break.
      expect((await e2e.api.content(after[0].id, to)).body).toBe('anchor revision two')
      expect((await e2e.api.content(after[1].id, to)).body).toBe('anchor revision one')
    })
  })

  /* ----------------------------------------------------------------- E2E-16 */

  // ADR §11: copyMove's overwrite gets NO snapshot, deliberately. It calls
  // delete() first, which moves the destination to TRASH — so the overwritten
  // content is already recoverable, and its version rows travel with the trashed
  // files row. Trash coverage is the mechanism; duplicating it would double-store
  // every overwritten destination.
  describe('E2E-16 copyMove overwrite', () => {
    it('creates no version when a move overwrites the destination', async () => {
      const src = 'e2e16-src.txt'
      const dst = 'e2e16-dst.txt'
      await e2e.seed(src, 'the source content')
      await e2e.seed(dst, 'the destination about to be replaced')

      const before = await e2e.versionsOf(dst)
      await e2e.filesManager.copyMove(e2e.user, await e2e.spaceEnv(src), await e2e.spaceEnv(dst), true, true)

      expect(await fs.readFile(e2e.filesPath(dst), 'utf8')).toBe('the source content')
      // No NEW version for the destination — trash holds the old content.
      expect((await e2e.versionsOf(dst)).filter((v) => !before.some((b) => b.id === v.id))).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------------ E2E-6 */

  describe('E2E-6 trash', () => {
    // Trashing keeps the files row with a STABLE id (inTrash = true), so history
    // must survive — and be there again after a restore from trash. Note there
    // is no trash-AGE rule and there cannot be one: a version's createdAt is
    // when the file was overwritten, arbitrarily long before it was trashed, so
    // expiring history by that timestamp destroyed restorable revisions. See the
    // Phase A/B handoff §3.4.
    it('retains history when a file is moved to the trash', async () => {
      const rel = 'e2e6-trash.txt'
      await e2e.seed(rel, 'trash case original')
      await e2e.overwrite(rel, 'trash case replacement', 'web')
      const before = await e2e.versionsOf(rel)
      expect(before).toHaveLength(1)

      await e2e.filesManager.delete(e2e.user, await e2e.spaceEnv(rel))

      // The live file is gone from files/…
      await expect(fs.stat(e2e.filesPath(rel))).rejects.toThrow()
      // …but the rows survive, keyed on the still-existing files.id.
      const rows = await e2e.versioningQueries.listByFileId(before[0].fileId)
      expect(rows.map((r) => r.id)).toEqual(before.map((v) => v.id))
      // And so do the blobs.
      await expect(fs.stat(blobFor(before[0].checksum))).resolves.toBeDefined()
    })
  })

  /* ------------------------------------------------------------------ E2E-9 */

  // Dedup is per (checksum, versionsRoot), and the refcount is what makes it
  // safe: deleting one version must not pull the blob out from under another
  // that still points at it.
  describe('E2E-9 dedup and refcounting', () => {
    it('stores identical content once and keeps the blob until the last reference goes', async () => {
      const a = 'e2e9-a.txt'
      const b = 'e2e9-b.txt'
      const shared = 'byte-identical content in two files'
      await e2e.seed(a, shared)
      await e2e.seed(b, shared)
      await e2e.overwrite(a, 'a moves on', 'web')
      await e2e.overwrite(b, 'b moves on', 'web')

      const [versionA] = await e2e.versionsOf(a)
      const [versionB] = await e2e.versionsOf(b)
      // Same bytes → same digest → ONE blob on disk for two rows.
      expect(versionA.checksum).toBe(versionB.checksum)
      const blob = blobFor(versionA.checksum)
      await expect(fs.stat(blob)).resolves.toBeDefined()

      // Drop one: the blob stays, because the other row still references it.
      expect((await e2e.api.remove(versionA.id, a)).status).toBe(200)
      await expect(fs.stat(blob)).resolves.toBeDefined()
      expect((await e2e.api.content(versionB.id, b)).body).toBe(shared)

      // Drop the last: now it goes.
      expect((await e2e.api.remove(versionB.id, b)).status).toBe(200)
      await expect(fs.stat(blob)).rejects.toThrow()
    })
  })

  /* ----------------------------------------------------------------- E2E-20 */

  // Version rows key on files.id, but `files` is a SPARSE INDEX — a file that
  // was only ever uploaded and edited has no row at all. The ensurer materializes
  // one on first snapshot, and must not create a second on the next.
  describe('E2E-20 row ensuring', () => {
    it('materializes a files row for a file that has none, then reuses it', async () => {
      const rel = 'e2e20-ensure.txt'
      await e2e.seed(rel, 'never shared, never commented, never favorited')

      // Nothing else in the app has any reason to have created a row yet.
      await e2e.overwrite(rel, 'first overwrite', 'web')
      const first = await e2e.versionsOf(rel)
      expect(first).toHaveLength(1)
      expect(first[0].fileId).toBeGreaterThan(0)

      await e2e.overwrite(rel, 'second overwrite', 'web')
      const second = await e2e.versionsOf(rel)
      expect(second).toHaveLength(2)
      // ONE row, two versions — the guard against getOrCreateUserFile's
      // documented fan-out trap.
      expect(new Set(second.map((v) => v.fileId)).size).toBe(1)
      expect(second[1].fileId).toBe(first[0].fileId)
    })

    it('anchors a nested file on the path shape files.path actually stores', async () => {
      // dbFile.path is the full in-space path INCLUDING the filename, so it
      // splits into (dirname, filename) — and a root-level file yields '.'.
      const rel = 'e2e20-dir/nested.txt'
      await e2e.seed(rel, 'nested original')
      await e2e.overwrite(rel, 'nested replacement', 'web')

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('nested original')
    })
  })

  /* ----------------------------------------------------------------- E2E-13 */

  describe('E2E-13 the feature flag is off', () => {
    it('writes no versions and touches the blob store not at all', async () => {
      const rel = 'e2e13-off.txt'
      await e2e.seed(rel, 'flag-off original')
      const blobsBefore = await e2e.blobs()

      e2e.config.enabled = false
      await e2e.overwrite(rel, 'flag-off replacement', 'web')

      // The save still succeeded — the flag suppresses versioning, not writing.
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('flag-off replacement')
      expect(await e2e.blobs()).toEqual(blobsBefore)
    })

    it('404s every endpoint, with the message the UI probes for', async () => {
      const rel = 'e2e13-endpoints.txt'
      await e2e.seed(rel, 'x')
      await e2e.overwrite(rel, 'y', 'web')
      const [version] = await e2e.versionsOf(rel)

      e2e.config.enabled = false

      const list = await e2e.app.inject({
        method: 'GET',
        url: `/api/app/spaces/versions/list/files/personal/${rel}`,
        headers: { cookie: '' }
      } as never)
      // Unauthenticated is 401 regardless; the flag check is asserted through the
      // authenticated helpers below.
      expect([401, 404]).toContain(list.statusCode)

      expect((await e2e.api.list(rel)).status).toBe(404)
      expect((await e2e.api.usage(rel)).status).toBe(404)
      expect((await e2e.api.content(version.id, rel)).status).toBe(404)
      expect((await e2e.api.restore(version.id, rel)).status).toBe(404)
      expect((await e2e.api.label(version.id, rel, 'x')).status).toBe(404)
      expect((await e2e.api.remove(version.id, rel)).status).toBe(404)
      expect((await e2e.api.diff(version.id, rel)).status).toBe(404)
    })

    it('leaves existing history intact and readable again once the flag returns', async () => {
      const rel = 'e2e13-roundtrip.txt'
      await e2e.seed(rel, 'roundtrip original')
      await e2e.overwrite(rel, 'roundtrip replacement', 'web')
      const before = await e2e.versionsOf(rel)

      e2e.config.enabled = false
      expect((await e2e.api.list(rel)).status).toBe(404)

      e2e.config.enabled = true
      const after = await e2e.api.list(rel)
      expect(after.status).toBe(200)
      expect(after.body.map((v) => v.id)).toEqual(before.map((v) => v.id))
    })
  })

  /* ------------------------------------------------- the store's own layout */

  it('keeps the blob store a sibling of files/ and trash/, sharded by digest prefix', async () => {
    const rel = 'e2e-layout.txt'
    await e2e.seed(rel, 'layout original bytes')
    await e2e.overwrite(rel, 'layout replacement bytes', 'web')
    const [version] = await e2e.versionsOf(rel)

    const home = path.dirname(e2e.filesPath())
    expect(e2e.versionsPath()).toBe(path.join(home, 'versions'))
    expect(blobFor(version.checksum).startsWith(e2e.filesPath())).toBe(false)
    await expect(fs.stat(blobFor(version.checksum))).resolves.toBeDefined()
    // Staging lives inside the store, so publishing is a same-filesystem rename.
    await expect(fs.stat(e2e.versionsPath('.staging'))).resolves.toBeDefined()
  })
})
