// Config singleton must be mocked before UserModel/SpaceModel load it.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '',
        usersPath: '',
        spacesPath: '',
        tmpPath: '',
        trashRetention: { users: false, spaces: false },
        versions: {
          enabled: true,
          maxVersionsPerFile: 20,
          retentionDays: { users: false, spaces: false },
          quotaShare: 0.5,
          minIntervalSeconds: 60
        }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { Test } from '@nestjs/testing'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Mock } from 'vitest'
import { configuration } from '../../../configuration/config.environment'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { VERSIONS_STAGING_DIR } from '../constants/versioning'
import { VersionRow } from '../interfaces/version.interface'
import { VersioningQueries } from './versioning-queries.service'
import { VersioningService } from './versioning.service'
import { VersionsRetention } from './versions-retention.service'

const versionsConfig = configuration.applications.files.versions as any
const trashConfig = configuration.applications.files.trashRetention as any

const DAY = 86_400_000

describe(VersionsRetention.name, () => {
  let service: VersionsRetention
  let queries: Record<string, Mock>
  let versioning: { dropVersionForRetention: Mock; evictUntilUnderCeiling: Mock }
  let quotaRows: { quota: number }[]
  let tmpRoot: string
  let dropped: VersionRow[]

  const ROOT = 'user:alice'

  function row(over: Partial<VersionRow> = {}): VersionRow {
    return {
      id: 1,
      fileId: 100,
      versionsRoot: ROOT,
      checksum: 'a'.repeat(64),
      size: 10,
      mtime: 1,
      createdAt: new Date(),
      label: null,
      origin: 'web',
      authorId: 7,
      ownerId: 7,
      spaceId: null,
      spaceExternalRootId: null,
      shareExternalId: null,
      ...over
    } as VersionRow
  }

  const versionsDir = () => path.join(tmpRoot, 'users', 'alice', 'versions')

  async function seedBlob(digest: string, ageMs = 2 * DAY): Promise<string> {
    const p = path.join(versionsDir(), digest.slice(0, 2), digest)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, 'blob')
    const when = new Date(Date.now() - ageMs)
    await fs.utimes(p, when, when)
    return p
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-in-retention-'))
    configuration.applications.files.usersPath = path.join(tmpRoot, 'users')
    configuration.applications.files.spacesPath = path.join(tmpRoot, 'spaces')
    configuration.applications.files.tmpPath = path.join(tmpRoot, 'tmp')

    versionsConfig.enabled = true
    versionsConfig.maxVersionsPerFile = 20
    versionsConfig.retentionDays = { users: false, spaces: false }
    versionsConfig.quotaShare = 0.5
    trashConfig.users = false
    trashConfig.spaces = false

    dropped = []
    versioning = {
      dropVersionForRetention: vi.fn().mockImplementation(async (r: VersionRow) => {
        dropped.push(r)
      }),
      evictUntilUnderCeiling: vi.fn().mockResolvedValue(0)
    }
    queries = {
      distinctRoots: vi.fn().mockResolvedValue([ROOT]),
      unlabeledOlderThan: vi.fn().mockResolvedValue([]),
      fileIdsExceeding: vi.fn().mockResolvedValue([]),
      unlabeledByFileIdOldestFirst: vi.fn().mockResolvedValue([]),
      usageByRoot: vi.fn().mockResolvedValue({ used: 0, labeledBytes: 0, count: 0 }),
      oldestUnlabeledByRoot: vi.fn().mockResolvedValue(undefined),
      unlabeledByRootOldestFirst: vi.fn().mockResolvedValue([]),
      danglingRows: vi.fn().mockResolvedValue([]),
      countByBlob: vi.fn().mockResolvedValue(1),
      distinctFileIdsByRoot: vi.fn().mockResolvedValue([]),
      byFileIdNewestFirst: vi.fn().mockResolvedValue([])
    }
    // Returns a quota so the quota rule actually reaches its destructive path; a
    // stub that always answered "no quota" is why a data-loss bug in that loop
    // survived a green suite.
    quotaRows = [{ quota: 0 }]
    const db = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(quotaRows) }) }) })) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        VersionsRetention,
        { provide: DB_TOKEN_PROVIDER, useValue: db },
        { provide: VersioningQueries, useValue: queries },
        { provide: VersioningService, useValue: versioning }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(VersionsRetention)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('does nothing at all while the feature flag is off', async () => {
    versionsConfig.enabled = false
    await service.cleanVersions()
    expect(queries.distinctRoots).not.toHaveBeenCalled()
  })

  /* --------------------------------------------------------- retentionDays */

  it('skips age expiry when retentionDays is off (0 -> false)', async () => {
    await service.cleanVersions()
    expect(queries.unlabeledOlderThan).not.toHaveBeenCalled()
  })

  it('expires unlabeled versions past the users retention window', async () => {
    versionsConfig.retentionDays = { users: 30, spaces: false }
    queries.unlabeledOlderThan.mockResolvedValue([row({ id: 1 }), row({ id: 2 })])

    await service.cleanVersions()

    expect(queries.unlabeledOlderThan).toHaveBeenCalledWith(ROOT, expect.any(Date), expect.any(Number))
    const cutoff = queries.unlabeledOlderThan.mock.calls[0][1] as Date
    // ~30 days ago, within a second of tolerance.
    expect(Math.abs(Date.now() - cutoff.getTime() - 30 * DAY)).toBeLessThan(1000)
    expect(dropped.map((r) => r.id)).toEqual([1, 2])
  })

  it('uses the spaces window for a space root', async () => {
    versionsConfig.retentionDays = { users: 10, spaces: 90 }
    queries.distinctRoots.mockResolvedValue(['space:team'])
    queries.unlabeledOlderThan.mockResolvedValue([])

    await service.cleanVersions()

    const cutoff = queries.unlabeledOlderThan.mock.calls[0][1] as Date
    expect(Math.abs(Date.now() - cutoff.getTime() - 90 * DAY)).toBeLessThan(1000)
  })

  /* --------------------------------------------- no trash-age rule (removed) */

  // The removed rule keyed on the VERSION's age while claiming to mean "the file
  // has been in the trash long enough". Those are unrelated: a version's
  // createdAt is when the file was overwritten. A file last edited months ago
  // lost its entire history on the first sweep after being trashed, while still
  // restorable from the trash. There is no trashed-at timestamp addressable by
  // files.id, so the rule cannot be written correctly and was dropped.
  it('does not reclaim history just because a file sits in the trash', async () => {
    trashConfig.users = 30
    versionsConfig.retentionDays = { users: false, spaces: false }

    await service.cleanVersions()

    expect(dropped).toHaveLength(0)
  })

  it('still expires an OLD version of a trashed file via the age rule', async () => {
    // The age rule filters on age alone, not trash state, so nothing leaks
    // indefinitely just because a file is in the trash.
    versionsConfig.retentionDays = { users: 30, spaces: false }
    queries.unlabeledOlderThan.mockResolvedValueOnce([row({ id: 4 })]).mockResolvedValue([])

    await service.cleanVersions()

    expect(dropped.map((r) => r.id)).toContain(4)
  })

  /* --------------------------------------------------------- thinning */

  describe('thinning rule', () => {
    // secondsAgo is applied to mtime; createdAt is pinned far in the past so
    // the floor in versionsToExpire (never expire a row younger than the step
    // it's being judged by) never exempts these fixtures — see task brief.
    const thinRow = (id: number, secondsAgo: number, label: string | null = null): VersionRow =>
      row({ id, fileId: 7, versionsRoot: ROOT, mtime: Date.now() - secondsAgo * 1000, label, createdAt: new Date(0) })

    it('thins every file in the root and returns the number removed', async () => {
      queries.distinctFileIdsByRoot.mockResolvedValue([7])
      queries.byFileIdNewestFirst.mockResolvedValue([thinRow(11, 120), thinRow(12, 154)])

      const removed = await service['enforceThinning'](ROOT)

      expect(removed).toBe(1)
      expect(versioning.dropVersionForRetention).toHaveBeenCalledTimes(1)
      expect(dropped[0].id).toBe(12)
    })

    it('removes nothing from an already-thinned root', async () => {
      queries.distinctFileIdsByRoot.mockResolvedValue([7])
      queries.byFileIdNewestFirst.mockResolvedValue([thinRow(11, 120)])

      expect(await service['enforceThinning'](ROOT)).toBe(0)
    })

    // Exercises the sweep's own wiring, not just the private method in
    // isolation: the two cases above call enforceThinning directly and would
    // stay green even if cleanVersions's runRule('thinning', ...) line stopped
    // calling it. This is what makes the wiring itself falsifiable.
    it('is reached by the nightly sweep', async () => {
      queries.distinctFileIdsByRoot.mockResolvedValue([7])
      queries.byFileIdNewestFirst.mockResolvedValue([thinRow(11, 120), thinRow(12, 154)])

      await service.cleanVersions()

      expect(dropped.map((r) => r.id)).toContain(12)
    })
  })

  /* --------------------------------------------------------- quotaShare */

  it('is a no-op when the root has no quota', async () => {
    quotaRows = [{ quota: 0 }]
    await service.cleanVersions()
    expect(versioning.evictUntilUnderCeiling).not.toHaveBeenCalled()
  })

  it('delegates eviction to the shared helper with quota * quotaShare as the ceiling', async () => {
    quotaRows = [{ quota: 1000 }]
    versionsConfig.quotaShare = 0.5

    await service.cleanVersions()

    expect(versioning.evictUntilUnderCeiling).toHaveBeenCalledWith(ROOT, 500)
  })

  it('skips the quota rule entirely when quotaShare is disabled', async () => {
    quotaRows = [{ quota: 1000 }]
    versionsConfig.quotaShare = false
    await service.cleanVersions()
    expect(versioning.evictUntilUnderCeiling).not.toHaveBeenCalled()
  })

  /* ------------------------------------------------------- dangling rows */

  it('sweeps and warns about version rows whose files row is gone', async () => {
    queries.danglingRows.mockResolvedValue([row({ id: 77 })])
    await service.cleanVersions()
    expect(dropped.map((r) => r.id)).toContain(77)
  })

  /* -------------------------------------------------------- orphan blobs */

  it('removes an unreferenced blob older than the grace period', async () => {
    const digest = 'b'.repeat(64)
    const blob = await seedBlob(digest)
    queries.countByBlob.mockResolvedValue(0)

    await service.cleanVersions()

    expect(
      await fs
        .access(blob)
        .then(() => true)
        .catch(() => false)
    ).toBe(false)
  })

  it('keeps an unreferenced blob inside the grace period', async () => {
    // A snapshot writes the blob before its row, so a brand-new blob is
    // legitimately unreferenced for a moment.
    const blob = await seedBlob('c'.repeat(64), 60_000)
    queries.countByBlob.mockResolvedValue(0)

    await service.cleanVersions()

    expect(
      await fs
        .access(blob)
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('keeps a blob that is still referenced in this root', async () => {
    const blob = await seedBlob('d'.repeat(64))
    queries.countByBlob.mockResolvedValue(2)

    await service.cleanVersions()

    expect(
      await fs
        .access(blob)
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  // ADR §15: a file moved to another space keeps resolving to the root recorded
  // on its rows. Refcounting on the file's CURRENT space would delete a moved
  // file's history as orphaned.
  it('refcounts within the root being swept, not the file’s current space', async () => {
    const digest = 'e'.repeat(64)
    await seedBlob(digest)
    queries.countByBlob.mockResolvedValue(1)

    await service.cleanVersions()

    expect(queries.countByBlob).toHaveBeenCalledWith(digest, ROOT)
  })

  it('removes stale staging debris from a crashed snapshot', async () => {
    const stageDir = path.join(versionsDir(), VERSIONS_STAGING_DIR)
    await fs.mkdir(stageDir, { recursive: true })
    const stale = path.join(stageDir, 'abandoned.part')
    const fresh = path.join(stageDir, 'in-flight.part')
    await fs.writeFile(stale, 'x')
    await fs.writeFile(fresh, 'x')
    const old = new Date(Date.now() - 2 * DAY)
    await fs.utimes(stale, old, old)

    await service.cleanVersions()

    expect(
      await fs
        .access(stale)
        .then(() => true)
        .catch(() => false)
    ).toBe(false)
    // An in-flight stage must survive — the snapshot writing it is not done.
    expect(
      await fs
        .access(fresh)
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('does not treat the staging dir as a blob shard', async () => {
    const stageDir = path.join(versionsDir(), VERSIONS_STAGING_DIR)
    await fs.mkdir(stageDir, { recursive: true })
    await fs.writeFile(path.join(stageDir, 'x.part'), 'x')
    queries.countByBlob.mockResolvedValue(0)

    await service.cleanVersions()

    // Staging names are not digests, so they must never be refcount-checked.
    expect(queries.countByBlob).not.toHaveBeenCalledWith('x.part', ROOT)
  })

  /* ------------------------------------------------------------ isolation */

  it('keeps going when one rule throws', async () => {
    versionsConfig.retentionDays = { users: 30, spaces: false }
    queries.unlabeledOlderThan.mockRejectedValue(new Error('db down'))
    queries.danglingRows.mockResolvedValue([row({ id: 5 })])

    await expect(service.cleanVersions()).resolves.toBeUndefined()

    // A failure in the first rule must not skip the rest.
    expect(dropped.map((r) => r.id)).toContain(5)
  })

  /* -------------------------------------------------------- rootCeiling */

  it('reports the ceiling it enforces, and null when nothing caps the root', async () => {
    quotaRows = [{ quota: 1000 }]
    expect(await service.rootCeiling(ROOT)).toBe(500)

    // No quota on the owner: nothing to cap against.
    quotaRows = [{ quota: 0 }]
    expect(await service.rootCeiling(ROOT)).toBeNull()

    // The cap itself disabled (0 -> false).
    quotaRows = [{ quota: 1000 }]
    versionsConfig.quotaShare = false
    expect(await service.rootCeiling(ROOT)).toBeNull()

    // Not a root at all.
    versionsConfig.quotaShare = 0.5
    expect(await service.rootCeiling('nonsense')).toBeNull()
  })

  /* -------------------------------------------------------- admin purge */

  it('purges a root through the retention eviction path, never a raw delete', async () => {
    const rows = [row({ id: 1, size: 10 }), row({ id: 2, size: 30 })]
    // Paged: one short page, so the loop stops after it.
    queries.unlabeledByRootOldestFirst.mockResolvedValueOnce(rows).mockResolvedValue([])
    queries.usageByRoot.mockResolvedValue({ used: 0, labeledBytes: 0, count: 0 })

    const result = await service.purgeRoot(ROOT)

    // The ONE seam that matters: every removal went through
    // VersioningService.dropVersionForRetention, which is the refcount-aware
    // blob path. A bespoke DELETE would show up here as zero calls.
    expect(versioning.dropVersionForRetention).toHaveBeenCalledTimes(2)
    expect(dropped.map((r) => r.id)).toEqual([1, 2])
    expect(result).toEqual({ removed: 2, removedBytes: 40, keptLabeled: 0 })
  })

  it('leaves labeled versions alone: candidates come from the unlabeled-only query', async () => {
    // What the purge is offered is what the unlabeled-only query returns — the
    // labeled row is never in the page. Its survival then shows up in the
    // post-purge count read back from the root.
    queries.unlabeledByRootOldestFirst.mockResolvedValueOnce([row({ id: 1, size: 10 })]).mockResolvedValue([])
    queries.usageByRoot.mockResolvedValue({ used: 25, labeledBytes: 25, count: 1 })

    const result = await service.purgeRoot(ROOT)

    expect(queries.unlabeledByRootOldestFirst).toHaveBeenCalledWith(ROOT, expect.any(Number))
    expect(dropped.map((r) => r.id)).toEqual([1])
    expect(dropped.every((r) => r.label === null)).toBe(true)
    expect(result).toEqual({ removed: 1, removedBytes: 10, keptLabeled: 1 })
  })

  it('pages until a page comes back short', async () => {
    // batchSize is 1000; a full page must be followed by another fetch.
    const full = Array.from({ length: 1000 }, (_, i) => row({ id: i + 1, size: 1 }))
    queries.unlabeledByRootOldestFirst
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([row({ id: 1001, size: 1 })])
      .mockResolvedValue([])

    const result = await service.purgeRoot(ROOT)

    expect(queries.unlabeledByRootOldestFirst).toHaveBeenCalledTimes(2)
    expect(result.removed).toBe(1001)
  })

  it('is a zero result for a root that holds no history', async () => {
    expect(await service.purgeRoot('user:nobody')).toEqual({ removed: 0, removedBytes: 0, keptLabeled: 0 })
    expect(versioning.dropVersionForRetention).not.toHaveBeenCalled()
  })

  it('does not start a second run while one is in progress', async () => {
    let release: () => void = () => undefined
    queries.distinctRoots.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        })
    )

    const first = service.cleanVersions()
    await service.cleanVersions() // must return immediately
    expect(queries.distinctRoots).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})
