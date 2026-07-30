import { eq, like } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { cache } from '../../infrastructure/cache/schemas/mysql-cache.schema'
import { users } from '../users/schemas/users.schema'
import { customFilesVersions } from './schemas/files-versions.schema'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// The orphan-blob GC only collects blobs OLDER than its one-day grace window
// (versions-retention.service.ts ORPHAN_GRACE_MS), so a freshly written orphan is
// deliberately spared. Tests that want it collected have to backdate the file.
const ORPHAN_GRACE_MS = 86_400_000

// Phase E: the policies that decide when history is REMOVED, plus the two write
// paths a saveStream-centric reading of the design misses.
//
// Cases covered here: E2E-4 (sync tmpPath upload), E2E-8 (retention),
// E2E-12 (quota share, per the ADR §7 rewrite), E2E-14 (concurrency),
// E2E-15 (crash safety) and E2E-17 (multipart PATCH).
//
// These are the cases where a green unit test proved least: the retention spec's
// db stub always answered "this root has no quota", so 19 tests passed over a
// destructive branch that never ran and had a data-loss bug in it. Against a real
// database the branch runs.
describe('versions retention, quota and crash safety (e2e)', () => {
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
  const versionsRoot = () => `user:${e2e.user.login}`

  // Age a version row by rewriting its createdAt, so retention rules that key on
  // time can be exercised without waiting.
  const ageVersion = async (versionId: number, days: number) => {
    const createdAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    await e2e.db.update(customFilesVersions).set({ createdAt }).where(eq(customFilesVersions.id, versionId))
  }

  // Same idea as ageVersion, but in SECONDS: what thinning's FLOOR (versions-
  // thinning.ts — never expire a capture held for less than the band step it
  // is judged by) is measured against. A version this e2e suite just wrote has
  // a createdAt of "now", so without backdating it the floor exempts it from
  // every automatic rule regardless of spacing — a fast in-process run never
  // ages past the finest band's 2s step on its own. Only createdAt moves here;
  // mtime (what the curve actually spaces survivors by) must stay put, or the
  // test would stop exercising the real spacing rule.
  const ageVersionSeconds = async (versionId: number, seconds: number) => {
    const createdAt = new Date(Date.now() - seconds * 1000)
    await e2e.db.update(customFilesVersions).set({ createdAt }).where(eq(customFilesVersions.id, versionId))
  }

  /* ------------------------------------------------------------------ E2E-4 */

  // The sync client uploads into a tmp file and then MOVES it into place. The
  // destructive moment is that final move, not the tmp write — so one completed
  // upload is one version, however many ranged requests fed the tmp file.
  describe('E2E-4 sync upload via tmpPath', () => {
    it('versions once at the final move, tagged sync', async () => {
      const rel = 'e2e4-sync.txt'
      await e2e.seed(rel, 'sync original content')
      const tmpPath = path.join(e2e.user.tmpPath ?? '/tmp', `sync-e2e-${Date.now()}`)

      const space = await e2e.spaceEnv(rel)
      await e2e.filesManager.saveStream(
        e2e.user,
        space,
        { method: 'PUT', headers: {}, raw: Readable.from(['sync new content']) } as never,
        {
          tmpPath
        } as never
      )

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect(versions[0].origin).toBe('sync')
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('sync original content')
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('sync new content')
    })
  })

  /* ----------------------------------------------------------------- E2E-17 */

  // The web text editor saves with PATCH through saveMultipart. Gating on
  // `overwrite` alone would miss it — overwrite is PUT-only, but PATCH reaches
  // the same destructive moveFiles. This is the path the original draft missed.
  describe('E2E-17 multipart PATCH', () => {
    it('versions a PATCH save as web-patch', async () => {
      const rel = 'e2e17-patch.txt'
      await e2e.seed(rel, 'patch original content')

      const space = await e2e.spaceEnv(rel)
      await e2e.filesManager.saveMultipart(e2e.user, space, {
        method: 'PATCH',
        files: async function* () {
          yield { filename: rel, file: Readable.from(['patch new content']) }
        }
      } as never)

      const versions = await e2e.versionsOf(rel)
      expect(versions).toHaveLength(1)
      expect(versions[0].origin).toBe('web-patch')
      expect((await e2e.api.content(versions[0].id, rel)).body).toBe('patch original content')
    })
  })

  /* ------------------------------------------------------------------ E2E-8 */

  describe('E2E-8 retention', () => {
    it('thins rapid successive versions and keeps NAMED versions regardless', async () => {
      const rel = 'e2e8-thin.txt'
      await e2e.seed(rel, 'retention gen 0')
      for (let i = 1; i <= 5; i++) {
        await e2e.overwrite(rel, `retention gen ${i}`, 'web')
      }
      const all = await e2e.versionsOf(rel)

      // Name the OLDEST, which is what any pruning rule reaches for first.
      const oldest = all[all.length - 1]
      expect((await e2e.api.label(oldest.id, rel, 'pinned')).status).toBe(200)

      // Clear the thinning FLOOR (versions-thinning.ts: never expire a capture
      // held for less than the band step it is judged by) for the unlabeled
      // versions. Without this, cleanVersions() sees every version here as
      // "just created" — createdAt is only milliseconds old — and exempts all
      // of them from every rule, so the sweep would pass by pruning nothing,
      // which is not what happens in production once real time has moved on.
      // Only createdAt moves; mtime (what the curve spaces survivors by) is
      // untouched, so the actual spacing rule is still what gets exercised.
      for (const v of all) {
        if (v.id !== oldest.id) await ageVersionSeconds(v.id, 5)
      }

      await e2e.retention.cleanVersions()

      const kept = await e2e.versionsOf(rel)
      // DETERMINISTIC: the label is exempt from every automatic rule.
      expect(kept.some((v) => v.id === oldest.id)).toBe(true)
      // TIMING-DEPENDENT, so guarded. The collapse only holds if the writes
      // landed inside the 2s band; on a slow runner they spread past it and
      // nothing is expected to collapse. Asserting unconditionally would make
      // this a false negative under load. The curve itself is unit-tested in
      // versions-thinning.spec.ts.
      const spans = all.map((v) => v.mtime).sort((a, b) => b - a)
      const allWithin2s = spans.every((m, i) => i === 0 || spans[i - 1] - m < 2000)
      if (allWithin2s) {
        expect(kept.filter((v) => !v.label).length).toBeLessThan(all.filter((v) => !v.label).length)
      }
    })

    // #340's point, restated for thinning: shaping happens on the WRITE path, so
    // one file's history is bounded between nightly runs. The sweep is
    // deliberately NOT invoked here — that absence is the whole assertion.
    //
    // thinFile runs SYNCHRONOUSLY inside the write path, so unlike the sweep
    // case above (which sometimes runs long enough, scanning every root, to
    // outlast the floor by accident) this one never would: a fast in-process
    // e2e run reaches the very next write's thinFile pass milliseconds after
    // the previous one, so createdAt always reads as "now" and the floor
    // always wins. The middle backdating step below is what makes eager
    // thinning observable at all without relying on that timing accident, or
    // on a multi-second sleep.
    it('thins as the versions are written, without the nightly sweep', async () => {
      const rel = 'e2e8-thin-eager.txt'
      await e2e.seed(rel, 'eager gen 0')
      for (let i = 1; i <= 3; i++) {
        await e2e.overwrite(rel, `eager gen ${i}`, 'web')
      }
      const preBackdate = await e2e.versionsOf(rel)

      // Clear the floor for what's been written so far — only createdAt moves.
      for (const v of preBackdate) {
        await ageVersionSeconds(v.id, 5)
      }

      for (let i = 4; i <= 5; i++) {
        await e2e.overwrite(rel, `eager gen ${i}`, 'web')
      }

      const kept = await e2e.versionsOf(rel)
      // DETERMINISTIC: the newest version is always kept, and each version holds
      // the content its write destroyed — so the newest survivor is the last
      // generation overwritten. True whatever the runner's speed.
      expect((await e2e.api.content(kept[0].id, rel)).body).toBe('eager gen 4')
      // TIMING-DEPENDENT, guarded: the collapse below only holds if those
      // earlier writes actually landed within the 2s band of each other in
      // real time — on a slow runner they spread past it and nothing is
      // expected to collapse on spacing alone, floor or not. The curve itself
      // is unit-tested in versions-thinning.spec.ts.
      const spans = preBackdate.map((v) => v.mtime).sort((a, b) => b - a)
      const allWithin2s = spans.every((m, i) => i === 0 || spans[i - 1] - m < 2000)
      if (allWithin2s) {
        expect(kept.length).toBeLessThan(5)
      }
    })

    it('never trims a NAMED version on the write path, however old', async () => {
      const rel = 'e2e8-max-eager-named.txt'
      await e2e.seed(rel, 'named gen 0')
      for (const n of [1, 2, 3]) {
        await e2e.overwrite(rel, `named gen ${n}`, 'web')
      }
      const all = await e2e.versionsOf(rel)
      expect(all).toHaveLength(3)
      // Name the OLDEST — exactly what an oldest-first trim reaches for first.
      const oldest = all[all.length - 1]
      expect((await e2e.api.label(oldest.id, rel, 'pinned')).status).toBe(200)

      // Clear the floor for the unlabeled versions, same reasoning as the
      // eager case above — without it the very next write's thinFile pass
      // exempts all of them as "just created" and this case would pass having
      // exercised nothing. Only createdAt moves.
      for (const v of all) {
        if (v.id !== oldest.id) await ageVersionSeconds(v.id, 5)
      }

      await e2e.overwrite(rel, 'named gen 4', 'web')

      const kept = await e2e.versionsOf(rel)
      // DETERMINISTIC: the label is exempt from every automatic rule on the
      // write path exactly as on the sweep, and its content never changes.
      expect(kept.map((v) => v.id)).toContain(oldest.id)
      expect((await e2e.api.content(oldest.id, rel)).body).toBe('named gen 0')
      // TIMING-DEPENDENT, guarded: whether the unlabeled ones behind it are
      // thinned depends on their writes having landed within the 2s band in
      // real time. Which ones survive is the curve's job (unit-tested in
      // versions-thinning.spec.ts) — here only "something unlabeled can go,
      // the label never does" is asserted.
      const spans = all.map((v) => v.mtime).sort((a, b) => b - a)
      const allWithin2s = spans.every((m, i) => i === 0 || spans[i - 1] - m < 2000)
      if (allWithin2s) {
        expect(kept.length).toBeLessThan(all.length + 1)
      }
    })

    it('expires versions older than retentionDays, and keeps younger ones', async () => {
      const rel = 'e2e8-days.txt'
      await e2e.seed(rel, 'days gen 0')
      await e2e.overwrite(rel, 'days gen 1', 'web')
      await e2e.overwrite(rel, 'days gen 2', 'web')
      const [younger, older] = await e2e.versionsOf(rel)
      await ageVersion(older.id, 40)

      e2e.config.retentionDays = { users: 30, spaces: false } as never
      await e2e.retention.cleanVersions()

      const kept = await e2e.versionsOf(rel)
      expect(kept.map((v) => v.id)).toContain(younger.id)
      expect(kept.map((v) => v.id)).not.toContain(older.id)
    })

    it('never expires a NAMED version, however old', async () => {
      const rel = 'e2e8-named-old.txt'
      await e2e.seed(rel, 'named-old gen 0')
      await e2e.overwrite(rel, 'named-old gen 1', 'web')
      const [version] = await e2e.versionsOf(rel)
      await e2e.api.label(version.id, rel, 'keep forever')
      await ageVersion(version.id, 400)

      e2e.config.retentionDays = { users: 1, spaces: false } as never
      await e2e.retention.cleanVersions()

      expect((await e2e.versionsOf(rel)).map((v) => v.id)).toContain(version.id)
    })

    it('collects an orphan blob that no row references', async () => {
      // Crash debris: a blob written before the row insert (see E2E-15). The GC
      // is what stops it accumulating forever.
      const orphanDigest = 'e'.repeat(64)
      const orphan = blobFor(orphanDigest)
      await fs.mkdir(path.dirname(orphan), { recursive: true })
      await fs.writeFile(orphan, 'orphaned bytes')
      // Backdate it past the grace window. A fresh orphan is spared on purpose:
      // the GC cannot tell debris from a blob whose row insert is still in
      // flight, so it waits a day rather than racing the writer.
      const aged = new Date(Date.now() - ORPHAN_GRACE_MS - 60_000)
      await fs.utimes(orphan, aged, aged)
      await expect(fs.stat(orphan)).resolves.toBeDefined()

      await e2e.retention.cleanVersions()

      await expect(fs.stat(orphan)).rejects.toThrow()
    })
  })

  /* ----------------------------------------------------------------- E2E-12 */

  // ADR §7 as rewritten. The claim is NOT "a save is never blocked" — that was
  // retracted as unachievable, because space.guard.ts rejects uploads pre-flight
  // off a day-old cached dirSize, long before any versioning code runs. The
  // claim that IS honest: snapshotting never grows version bytes in a root beyond
  // quota * quotaShare.
  describe('E2E-12 quota share', () => {
    const setQuota = async (bytes: number | null) => {
      await e2e.db.update(users).set({ storageQuota: bytes }).where(eq(users.id, e2e.user.id))
      // The ceiling reads through a ONE-DAY cache, so changing the column alone
      // leaves it stale — the trap the Phase D handoff calls out, and the reason
      // a quota test that "should obviously work" silently does not.
      await e2e.db.delete(cache).where(like(cache.key, 'quota%'))
    }

    afterEach(async () => await setQuota(null))

    it('evicts oldest-unlabeled-first so version bytes stay under quota * quotaShare', async () => {
      const rel = 'e2e12-cap.txt'
      const chunk = (n: number) => `${n}`.repeat(400)
      await setQuota(2000) // ceiling = 2000 * 0.5 = 1000 bytes of history
      e2e.config.quotaShare = 0.5

      await e2e.seed(rel, chunk(1))
      for (const n of [2, 3, 4, 5]) {
        await e2e.overwrite(rel, chunk(n), 'web')
      }

      const usage = await e2e.api.usage(rel)
      expect(usage.status).toBe(200)
      expect(usage.body.ceiling).toBe(1000)
      // Four overwrites of 400 bytes each would be 1600 without the cap.
      expect(usage.body.used).toBeLessThanOrEqual(1000)
      // And the survivors are the NEWEST — eviction takes the oldest first.
      const kept = await e2e.versionsOf(rel)
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(4)
    })

    it('never evicts a labeled version, accepting the overshoot instead', async () => {
      const rel = 'e2e12-labeled.txt'
      const chunk = (n: number) => `L${n}`.repeat(300)
      await setQuota(2000)
      e2e.config.quotaShare = 0.5

      await e2e.seed(rel, chunk(1))
      await e2e.overwrite(rel, chunk(2), 'web')
      const [first] = await e2e.versionsOf(rel)
      await e2e.api.label(first.id, rel, 'pinned at the ceiling')

      for (const n of [3, 4, 5] as const) {
        await e2e.overwrite(rel, chunk(n), 'web')
      }

      // The named one is still there. If labeled bytes ALONE exceeded the
      // ceiling, no sequence of evictions could reach it — and an unguarded
      // `while (used > ceiling)` loop would then delete every unlabeled version
      // in the root, including other files', and still finish over the ceiling.
      expect((await e2e.versionsOf(rel)).map((v) => v.id)).toContain(first.id)
    })

    it('skips the cap entirely for a user with no quota', async () => {
      const rel = 'e2e12-noquota.txt'
      await setQuota(null)
      e2e.config.quotaShare = 0.5

      await e2e.seed(rel, 'Z'.repeat(500))
      for (const n of [1, 2, 3]) {
        await e2e.overwrite(rel, `${n}`.repeat(500), 'web')
      }

      // Nothing was evicted: with no quota there is no ceiling to enforce, and
      // willExceedQuota itself returns false in that case.
      expect(await e2e.versionsOf(rel)).toHaveLength(3)
      expect((await e2e.api.usage(rel)).body.ceiling).toBeNull()
    })

    it('does not evict for a dedup hit, which costs zero disk bytes', async () => {
      const a = 'e2e12-dedup-a.txt'
      const b = 'e2e12-dedup-b.txt'
      const shared = 'D'.repeat(600)
      await setQuota(2000)
      e2e.config.quotaShare = 0.5

      await e2e.seed(a, shared)
      await e2e.overwrite(a, 'a moves on', 'web')
      const [versionA] = await e2e.versionsOf(a)

      await e2e.seed(b, shared)
      await e2e.overwrite(b, 'b moves on', 'web')

      // The second snapshot is the same bytes, so it adds no disk usage and must
      // not evict the first to make room for itself.
      expect((await e2e.versionsOf(a)).map((v) => v.id)).toContain(versionA.id)
      expect((await e2e.versionsOf(b))[0].checksum).toBe(versionA.checksum)
    })
  })

  /* ----------------------------------------------------------------- E2E-15 */

  describe('E2E-15 crash safety', () => {
    // The whole feature is built on this trade: a failed snapshot degrades to
    // "no version for this write", NEVER to a failed save. A snapshot that
    // propagated its error would turn a working save into a 500.
    it('lets the user’s save succeed when the snapshot fails', async () => {
      const rel = 'e2e15-failure.txt'
      await e2e.seed(rel, 'crash case original')

      const spy = vi.spyOn(e2e.versioningQueries, 'insertVersion').mockRejectedValueOnce(new Error('injected DB failure'))
      try {
        await e2e.overwrite(rel, 'crash case replacement', 'web')
      } finally {
        spy.mockRestore()
      }

      // The save landed…
      expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('crash case replacement')
      // …with no version, and no half-written row.
      expect(await e2e.versionsOf(rel)).toHaveLength(0)
    })

    // Blob first, row second, on purpose: a crash between the two leaves an
    // orphan blob that the GC sweeps, whereas the reverse order would leave a
    // row pointing at nothing — a version that lists but can never be
    // downloaded. This asserts the direction of the failure.
    it('leaves at most a collectable orphan blob when the row insert dies, never a row without bytes', async () => {
      const rel = 'e2e15-orphan.txt'
      await e2e.seed(rel, 'orphan case original')

      const spy = vi.spyOn(e2e.versioningQueries, 'insertVersion').mockRejectedValueOnce(new Error('injected DB failure'))
      try {
        await e2e.overwrite(rel, 'orphan case replacement', 'web')
      } finally {
        spy.mockRestore()
      }

      expect(await e2e.versionsOf(rel)).toHaveLength(0)
      // The invariant the ordering buys: no row exists without bytes. Asserted
      // over every version this root actually has, so a row pointing at nothing
      // would fail here rather than at a download much later.
      for (const fileId of await e2e.versioningQueries.distinctFileIdsByRoot(versionsRoot())) {
        for (const row of await e2e.versioningQueries.listByFileId(fileId)) {
          await expect(fs.stat(blobFor(row.checksum))).resolves.toBeDefined()
        }
      }
    })

    it('leaves no staging debris behind on a successful snapshot', async () => {
      const rel = 'e2e15-staging.txt'
      await e2e.seed(rel, 'staging case original')
      await e2e.overwrite(rel, 'staging case replacement', 'web')

      const staging = await fs.readdir(e2e.versionsPath('.staging')).catch(() => [])
      expect(staging).toEqual([])
    })
  })

  /* ----------------------------------------------------------------- E2E-14 */

  // The claim under concurrency is NO CORRUPTION, deliberately not a strict
  // version count. Non-DAV writes are serialized by the lock manager, but WebDAV
  // holds no server lock during the write (ADR §4), so the DAV origin is
  // best-effort by design and asserting an exact count there would encode a
  // guarantee the design does not make.
  //
  // What must hold either way is the store's one invariant: the filename of a
  // blob is the hash of the bytes under it. That is what "copy first, then hash
  // the COPY" buys — hashing the live file in a separate pass leaves a window,
  // reachable precisely because DAV writes are unlocked, in which the two
  // disagree. A mis-named blob is the only corruption in this design that
  // escapes its own row: every later snapshot of the genuinely-matching content
  // would dedup against it and serve the wrong bytes.
  describe('E2E-14 concurrency', () => {
    it('never stores a blob whose name disagrees with its bytes, under parallel overwrites', async () => {
      const rel = 'e2e14-parallel.txt'
      await e2e.seed(rel, 'concurrent baseline content')

      await Promise.allSettled([
        e2e.overwrite(rel, 'concurrent write A'.padEnd(200, 'A'), 'web'),
        e2e.overwrite(rel, 'concurrent write B'.padEnd(300, 'B'), 'web'),
        e2e.overwrite(rel, 'concurrent write C'.padEnd(400, 'C'), 'web')
      ])

      const versions = await e2e.versionsOf(rel)
      // Some number of versions exists; which is a function of the lock outcome
      // and is not asserted.
      expect(versions.length).toBeGreaterThan(0)

      for (const version of versions) {
        const blob = blobFor(version.checksum)
        const bytes = await fs.readFile(blob)
        // THE INVARIANT: re-hash the stored bytes and require the name back.
        const digest = createHash('sha512-256').update(bytes).digest('hex')
        expect(digest).toBe(version.checksum)
        // And the recorded size describes those same bytes, which is what
        // restore verifies before it truncates anything.
        expect(bytes.byteLength).toBe(version.size)
      }
    })

    it('keeps every version downloadable after parallel writes, so no row points at nothing', async () => {
      const rel = 'e2e14-downloadable.txt'
      await e2e.seed(rel, 'downloadable baseline')
      await Promise.allSettled([e2e.overwrite(rel, 'par-1', 'web'), e2e.overwrite(rel, 'par-2', 'web')])

      for (const version of await e2e.versionsOf(rel)) {
        const res = await e2e.api.content(version.id, rel)
        expect(res.status).toBe(200)
        expect(Buffer.byteLength(res.body)).toBe(version.size)
      }
    })
  })
})
