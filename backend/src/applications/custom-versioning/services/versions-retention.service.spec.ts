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
  let versioning: { dropVersionForRetention: Mock }
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
      })
    }
    queries = {
      distinctRoots: vi.fn().mockResolvedValue([ROOT]),
      unlabeledOlderThan: vi.fn().mockResolvedValue([]),
      unlabeledInTrashOlderThan: vi.fn().mockResolvedValue([]),
      fileIdsExceeding: vi.fn().mockResolvedValue([]),
      countByFileId: vi.fn().mockResolvedValue(0),
      unlabeledByFileIdOldestFirst: vi.fn().mockResolvedValue([]),
      usageByRoot: vi.fn().mockResolvedValue({ used: 0, count: 0 }),
      oldestUnlabeledByRoot: vi.fn().mockResolvedValue(undefined),
      danglingRows: vi.fn().mockResolvedValue([]),
      countByBlob: vi.fn().mockResolvedValue(1)
    }
    const db = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) })) }

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

    expect(queries.unlabeledOlderThan).toHaveBeenCalledWith(ROOT, expect.any(Date))
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

  /* ------------------------------------------------------- trash-expired rule */

  // This is the rule ADR §10 was corrected to require. Waiting for a version
  // row to become "dangling" cannot work: trash retention never touches the
  // `files` table, and our own rows keep it alive against the orphan sweep.
  it('reclaims versions of files the trash has already expired', async () => {
    trashConfig.users = 30
    queries.unlabeledInTrashOlderThan.mockResolvedValue([row({ id: 9 })])

    await service.cleanVersions()

    expect(queries.unlabeledInTrashOlderThan).toHaveBeenCalledWith(ROOT, expect.any(Date))
    expect(dropped.map((r) => r.id)).toContain(9)
  })

  it('skips the trash rule when trash retention itself is off', async () => {
    await service.cleanVersions()
    expect(queries.unlabeledInTrashOlderThan).not.toHaveBeenCalled()
  })

  /* --------------------------------------------------- maxVersionsPerFile */

  it('trims a file down to the cap, oldest unlabeled first', async () => {
    versionsConfig.maxVersionsPerFile = 3
    queries.fileIdsExceeding.mockResolvedValue([100])
    queries.countByFileId.mockResolvedValue(5)
    queries.unlabeledByFileIdOldestFirst.mockResolvedValue([row({ id: 1 }), row({ id: 2 }), row({ id: 3 }), row({ id: 4 })])

    await service.cleanVersions()

    // 5 total, keep 3 => drop the 2 oldest unlabeled.
    expect(dropped.map((r) => r.id)).toEqual([1, 2])
  })

  it('keeps every labeled version even when that exceeds the cap', async () => {
    versionsConfig.maxVersionsPerFile = 2
    queries.fileIdsExceeding.mockResolvedValue([100])
    queries.countByFileId.mockResolvedValue(5)
    // All five are labeled, so none are candidates.
    queries.unlabeledByFileIdOldestFirst.mockResolvedValue([])

    await service.cleanVersions()

    expect(dropped).toHaveLength(0)
  })

  it('never trims a version belonging to another root', async () => {
    versionsConfig.maxVersionsPerFile = 1
    queries.fileIdsExceeding.mockResolvedValue([100])
    queries.countByFileId.mockResolvedValue(3)
    queries.unlabeledByFileIdOldestFirst.mockResolvedValue([row({ id: 1, versionsRoot: 'space:other' }), row({ id: 2 })])

    await service.cleanVersions()

    // A file moved between spaces has rows in two roots; this sweep is
    // per-root, so the other root's rows are not its business.
    expect(dropped.map((r) => r.id)).toEqual([2])
  })

  /* --------------------------------------------------------- quotaShare */

  it('is a no-op when the root has no quota', async () => {
    queries.usageByRoot.mockResolvedValue({ used: 10_000, count: 1 })
    await service.cleanVersions()
    expect(queries.oldestUnlabeledByRoot).not.toHaveBeenCalled()
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
