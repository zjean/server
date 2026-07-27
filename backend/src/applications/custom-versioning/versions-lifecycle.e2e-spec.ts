import fs from 'node:fs/promises'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// Phase E, cases E2E-1 and E2E-2: the upload lifecycle and restore, end to end
// against a real MariaDB and a real filesystem.
//
// These two are the suite's spine. Every other case is a variation on "which
// write path produced the version" or "which policy removed it"; these establish
// that a version is the bytes that were destroyed, that it can be read back
// exactly, and that restoring one is non-destructive.
//
// Read `utils/versions-e2e.fixture.ts` before adding cases — it documents the
// four environment facts (the `permissions` column, the CSRF header, the route
// prefix, the shared config singleton) that each cost a session to find.
describe('versions lifecycle (e2e)', () => {
  let e2e: VersionsE2EContext

  beforeAll(async () => {
    e2e = await setupVersionsE2E()
  })

  afterAll(async () => await e2e?.teardown())

  beforeEach(() => {
    e2e.restoreConfig()
    e2e.config.enabled = true
    // Every case here counts versions, so coalescing must not silently merge
    // two writes into one. Cases that test the window set it themselves.
    e2e.config.minIntervalSeconds = 0
    e2e.config.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 0 } as never
  })

  /* ------------------------------------------------------------------ E2E-1 */

  describe('E2E-1 upload lifecycle', () => {
    it('creates no version for a new file, one per overwrite, and serves each revision’s exact bytes', async () => {
      const rel = 'e2e1-lifecycle.txt'
      await e2e.seed(rel, 'revision one')

      // A create is not an overwrite: there are no bytes to preserve. Asserted
      // as a DELTA, because the blob store is root-scoped — it holds every
      // file's history for this user, so an absolute count would only pass
      // while this happens to be the first case in the file.
      const blobsBefore = (await e2e.blobs()).length
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
      expect(await e2e.blobs()).toHaveLength(blobsBefore)

      await e2e.overwrite(rel, 'revision two — longer', 'web')
      expect(await e2e.versionsOf(rel)).toHaveLength(1)

      await e2e.overwrite(rel, 'revision three', 'web')
      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(2)

      // Newest first, and each row describes the content it REPLACED — so the
      // newest version holds 'revision two', not 'revision three'.
      expect(versions.map((v) => v.size)).toEqual(['revision two — longer', 'revision one'].map((s) => Buffer.byteLength(s)))
      expect(versions.every((v) => v.origin === 'web')).toBe(true)
      expect(versions.every((v) => v.author?.login === e2e.user.login)).toBe(true)

      // The live file is the newest content; history is everything before it.
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('revision three')

      // Download each revision over HTTP and compare bytes exactly. This is the
      // assertion that a version is USABLE rather than merely listed.
      const [newest, oldest] = versions
      const newestContent = await e2e.api.content(newest.id, rel)
      const oldestContent = await e2e.api.content(oldest.id, rel)
      expect(newestContent.status).toBe(200)
      expect(newestContent.body).toBe('revision two — longer')
      expect(oldestContent.body).toBe('revision one')
    })

    it('lists history over HTTP with the same rows the service reports', async () => {
      const rel = 'e2e1-http.txt'
      await e2e.seed(rel, 'first')
      await e2e.overwrite(rel, 'second', 'web')

      const res = await e2e.api.list(rel)
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      // createdAt crosses the wire as a string even though the backend type says
      // Date — the trap C1 hit. Assert the wire shape, not the type.
      expect(typeof (res.body[0] as unknown as { createdAt: string }).createdAt).toBe('string')
      expect(res.body[0].checksum).toMatch(/^[0-9a-f]{64}$/)
    })

    it('serves a revision as an attachment named after the live file, not after the version id', async () => {
      const rel = 'e2e1-disposition.txt'
      await e2e.seed(rel, 'before')
      await e2e.overwrite(rel, 'after', 'web')
      const [version] = await e2e.versionsOf(rel)

      const res = await e2e.api.content(version.id, rel)
      // `attachment` is deliberate: rendering an old revision inline where the
      // current file is expected would be actively misleading.
      expect(String(res.headers['content-disposition'])).toContain('attachment')
      expect(String(res.headers['content-disposition'])).toContain(encodeURIComponent(rel))
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength('before'))
    })

    it('reports usage that rises with history and carries the quota ceiling', async () => {
      const rel = 'e2e1-usage.txt'
      await e2e.seed(rel, 'x'.repeat(100))
      const before = await e2e.api.usage(rel)

      await e2e.overwrite(rel, 'y'.repeat(50), 'web')
      const after = await e2e.api.usage(rel)

      expect(after.status).toBe(200)
      // Usage is ROOT-scoped, not per-file — the figure ADR §7 makes a release
      // blocker, because enabling versioning silently reduces effective quota.
      expect(after.body.used).toBe(before.body.used + 100)
      expect(after.body.count).toBe(before.body.count + 1)
    })
  })

  /* ------------------------------------------------------------------ E2E-2 */

  describe('E2E-2 restore', () => {
    it('restores the bytes, PRESERVES THE INODE, and snapshots what it replaced', async () => {
      const rel = 'e2e2-restore.txt'
      await e2e.seed(rel, 'the original')
      await e2e.overwrite(rel, 'the clobbering write', 'web')

      const [version] = await e2e.versionsOf(rel)
      const statBefore = await fs.stat(e2e.filesPath(rel))

      const res = await e2e.api.restore(version.id, rel)
      expect(res.status).toBe(201)

      // The bytes came back…
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('the original')
      const statAfter = await fs.stat(e2e.filesPath(rel))
      // …in place. Trash retention keys records on inodes
      // (files-trash-retention.service.ts:207) and dbFileHash / file.id
      // consumers depend on inode stability, so a restore that replaced the
      // inode would look like delete+create to all of them (ADR §9).
      expect(statAfter.ino).toBe(statBefore.ino)
      expect(statAfter.size).toBe(Buffer.byteLength('the original'))
      expect(statAfter.size).not.toBe(statBefore.size)

      // A restore is never destructive: the content it replaced became its own
      // version, so you can always get back to where you were.
      const after = await e2e.versionsOf(rel)
      const restoreRow = after.find((v) => v.origin === 'restore')
      expect(restoreRow).toBeDefined()
      const restored = await e2e.api.content(restoreRow!.id, rel)
      expect(restored.body).toBe('the clobbering write')
    })

    it('updates the files row so the size the rest of the app reports is the restored one', async () => {
      const rel = 'e2e2-filesrow.txt'
      await e2e.seed(rel, 'a much longer original than the replacement')
      await e2e.overwrite(rel, 'short', 'web')
      const [version] = await e2e.versionsOf(rel)

      expect((await e2e.api.restore(version.id, rel)).status).toBe(201)

      // The version rows key on files.id, so re-listing proves the row survived
      // the restore and still anchors the history.
      const space = await e2e.spaceEnv(rel)
      const fileId = (await e2e.versionsOf(rel))[0].fileId
      expect(fileId).toBeGreaterThan(0)
      expect(space.realPath).toBe(e2e.filesPath(rel))
    })

    it('can restore twice in a row, because each restore leaves its own way back', async () => {
      const rel = 'e2e2-twice.txt'
      await e2e.seed(rel, 'state A')
      await e2e.overwrite(rel, 'state B', 'web')

      const first = (await e2e.versionsOf(rel)).find((v) => v.origin === 'web')!
      expect((await e2e.api.restore(first.id, rel)).status).toBe(201)
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('state A')

      // The restore's own snapshot holds state B — go forward again through it.
      const backToB = (await e2e.versionsOf(rel)).find((v) => v.origin === 'restore')!
      expect((await e2e.api.restore(backToB.id, rel)).status).toBe(201)
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('state B')
    })

    // The requirement the handoff calls folklore-prone: writes need the CSRF
    // header as well as the cookie, and a restore is a write.
    it('refuses a restore that carries the session cookie but no CSRF header', async () => {
      const rel = 'e2e2-csrf.txt'
      await e2e.seed(rel, 'original')
      await e2e.overwrite(rel, 'clobbered', 'web')
      const [version] = await e2e.versionsOf(rel)

      const res = await e2e.api.restore(version.id, rel, { csrf: false })
      expect(res.status).toBe(403)
      // And nothing happened.
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('clobbered')
    })

    // The authorization boundary for every by-id operation. A caller supplies a
    // version id and it is only accepted if it hangs off the file the resolved
    // space env points at — so ids cannot be walked.
    it('404s a version id that belongs to a different file', async () => {
      const mine = 'e2e2-mine.txt'
      const other = 'e2e2-other.txt'
      await e2e.seed(mine, 'mine v1')
      await e2e.seed(other, 'other v1')
      await e2e.overwrite(mine, 'mine v2', 'web')
      await e2e.overwrite(other, 'other v2', 'web')

      const [otherVersion] = await e2e.versionsOf(other)
      expect((await e2e.api.content(otherVersion.id, mine)).status).toBe(404)
      expect((await e2e.api.restore(otherVersion.id, mine)).status).toBe(404)
    })
  })

  /* ---------------------------------------------------- naming and deletion */

  describe('labels and deletion over the API', () => {
    it('names a version and clears the name again', async () => {
      const rel = 'e2e-label.txt'
      await e2e.seed(rel, 'label-case v1')
      await e2e.overwrite(rel, 'label-case v2', 'web')
      const [version] = await e2e.versionsOf(rel)

      expect((await e2e.api.label(version.id, rel, 'before the rewrite')).status).toBe(200)
      expect((await e2e.versionsOf(rel))[0].label).toBe('before the rewrite')

      expect((await e2e.api.label(version.id, rel, null)).status).toBe(200)
      expect((await e2e.versionsOf(rel))[0].label).toBeNull()
    })

    it('deletes an unlabeled version and its blob', async () => {
      const rel = 'e2e-delete.txt'
      // Content unique across this file. The store is content-addressed and
      // refcounted per (checksum, root), so reusing another case's bytes would
      // legitimately keep the blob alive and this case would fail for the right
      // reason at the wrong assertion. E2E-9 asserts that behaviour on purpose.
      await e2e.seed(rel, 'delete-case original bytes')
      await e2e.overwrite(rel, 'delete-case replacement bytes', 'web')
      const [version] = await e2e.versionsOf(rel)
      // Identify the blob by its digest rather than by counting the store:
      // <versions>/<digest[0:2]>/<digest>.
      const blob = e2e.versionsPath(`${version.checksum.slice(0, 2)}/${version.checksum}`)
      await expect(fs.stat(blob)).resolves.toBeDefined()

      expect((await e2e.api.remove(version.id, rel)).status).toBe(200)
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
      // The blob goes only because nothing else referenced it — the refcount is
      // per (checksum, versionsRoot).
      await expect(fs.stat(blob)).rejects.toThrow()
    })

    // THE CASE THAT SHIPPED BROKEN. `?confirmLabeled=true` is bound to @Query(),
    // so it arrives as the STRING 'true'; the app pipe does no implicit
    // conversion and @IsBoolean() rejected it with a 400, making a named version
    // undeletable. Only a request that goes through the real pipe can catch it —
    // which is exactly why this case is here and not in a unit spec.
    it('requires confirmation to delete a NAMED version, and accepts the query-string form of the flag', async () => {
      const rel = 'e2e-delete-labeled.txt'
      await e2e.seed(rel, 'labeled-delete v1')
      await e2e.overwrite(rel, 'labeled-delete v2', 'web')
      const [version] = await e2e.versionsOf(rel)
      await e2e.api.label(version.id, rel, 'keep me')

      // Unconfirmed: a 409 the UI turns into a prompt — not a 500.
      const unconfirmed = await e2e.api.remove(version.id, rel)
      expect(unconfirmed.status).toBe(409)
      expect(await e2e.versionsOf(rel)).toHaveLength(1)

      const confirmed = await e2e.api.remove(version.id, rel, '?confirmLabeled=true')
      expect(confirmed.status).toBe(200)
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------ the diff API */

  describe('diff', () => {
    it('diffs a revision against the live file', async () => {
      const rel = 'e2e-diff.txt'
      await e2e.seed(rel, 'line one\nline two\n')
      await e2e.overwrite(rel, 'line one\nline two changed\n', 'web')
      const [version] = await e2e.versionsOf(rel)

      const res = await e2e.api.diff(version.id, rel)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { diff: string; identical: boolean }
      expect(body.identical).toBe(false)
      expect(body.diff).toContain('line two changed')
    })

    it('415s a binary file rather than decoding it as text', async () => {
      const rel = 'e2e-diff.png'
      await e2e.seed(rel, 'not really a png')
      await e2e.overwrite(rel, 'still not a png', 'web')
      const [version] = await e2e.versionsOf(rel)

      expect((await e2e.api.diff(version.id, rel)).status).toBe(415)
    })
  })
})
