// Config singleton must be mocked before UserModel/SpaceModel read it at load
// (parseVersionsRoot lives next to the path resolution that uses them).
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '/data',
        usersPath: '/data/users',
        spacesPath: '/data/spaces',
        tmpPath: '/data/tmp',
        versions: { enabled: true, quotaShare: 0.5, retentionDays: { users: false, spaces: false } }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { Test } from '@nestjs/testing'
import { HttpStatus } from '@nestjs/common'
import { Mock } from 'vitest'
import { FileError } from '../../files/models/file-error'
import { VersioningQueries } from './versioning-queries.service'
import { VersionsAdminService } from './versions-admin.service'
import { VersionsRetention } from './versions-retention.service'

// The operator surface for version storage (#342).
//
// Two things are worth testing here and they are both about MEANING rather than
// mechanism: that the figures the panel shows are the ones they are labelled as
// (in particular that a reported ceiling is the ceiling the retention sweep will
// enforce — #338), and that the purge delegates to the retention path instead of
// growing a delete of its own.
describe(VersionsAdminService.name, () => {
  let service: VersionsAdminService
  let queries: Record<string, Mock>
  let retention: { rootCeiling: Mock; purgeRoot: Mock }

  beforeEach(async () => {
    queries = {
      usageTotals: vi.fn().mockResolvedValue({ used: 0, labeledBytes: 0, count: 0, roots: 0, files: 0 }),
      usageByAllRoots: vi.fn().mockResolvedValue([]),
      renameRoot: vi.fn().mockResolvedValue(0)
    }
    retention = {
      rootCeiling: vi.fn().mockResolvedValue(null),
      purgeRoot: vi.fn().mockResolvedValue({ removed: 0, removedBytes: 0, keptLabeled: 0 })
    }

    const moduleRef = await Test.createTestingModule({
      providers: [VersionsAdminService, { provide: VersioningQueries, useValue: queries }, { provide: VersionsRetention, useValue: retention }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(VersionsAdminService)
  })

  afterEach(() => vi.restoreAllMocks())

  /* ------------------------------------------------------------- summary */

  it('reports instance-wide totals from the un-grouped aggregate, not from the truncated ranking', async () => {
    // The ranking is a top-N. Summing it would under-report the total on any
    // install with more roots than the cap — which is every install the panel
    // matters on.
    queries.usageTotals.mockResolvedValue({ used: 5_000, labeledBytes: 400, count: 12, roots: 30, files: 7 })
    queries.usageByAllRoots.mockResolvedValue([{ versionsRoot: 'user:alice', used: 100, labeledBytes: 0, count: 1, files: 1 }])

    const summary = await service.storageSummary(1)

    expect(summary.used).toBe(5_000)
    expect(summary.count).toBe(12)
    expect(summary.labeledBytes).toBe(400)
    expect(summary.roots).toBe(30)
    expect(summary.files).toBe(7)
    expect(summary.topRoots).toHaveLength(1)
  })

  it('labels a root as a user or a space and carries every per-root figure through', async () => {
    queries.usageByAllRoots.mockResolvedValue([
      { versionsRoot: 'user:alice', used: 300, labeledBytes: 100, count: 4, files: 2 },
      { versionsRoot: 'space:team', used: 200, labeledBytes: 0, count: 2, files: 1 }
    ])

    const { topRoots } = await service.storageSummary()

    expect(topRoots[0]).toMatchObject({ versionsRoot: 'user:alice', kind: 'user', name: 'alice', used: 300, labeledBytes: 100, count: 4, files: 2 })
    expect(topRoots[1]).toMatchObject({ versionsRoot: 'space:team', kind: 'space', name: 'team', used: 200, count: 2, files: 1 })
  })

  it('takes the ceiling from the function retention enforces, so the label is true (#338)', async () => {
    queries.usageByAllRoots.mockResolvedValue([{ versionsRoot: 'user:alice', used: 300, labeledBytes: 0, count: 1, files: 1 }])
    retention.rootCeiling.mockResolvedValue(512)

    const { topRoots } = await service.storageSummary()

    expect(retention.rootCeiling).toHaveBeenCalledWith('user:alice')
    expect(topRoots[0].ceiling).toBe(512)
  })

  it('reports no ceiling — rather than inventing one — when nothing caps the root', async () => {
    queries.usageByAllRoots.mockResolvedValue([{ versionsRoot: 'user:alice', used: 300, labeledBytes: 0, count: 1, files: 1 }])
    retention.rootCeiling.mockResolvedValue(null)

    const { topRoots } = await service.storageSummary()

    expect(topRoots[0].ceiling).toBeNull()
  })

  it('still surfaces a row whose root it cannot parse, without a ceiling', async () => {
    // Storage an operator cannot see is storage nobody can account for, so a
    // malformed root is shown as-is. It gets no ceiling because there is no
    // user or space to size one against.
    queries.usageByAllRoots.mockResolvedValue([{ versionsRoot: 'legacy-root', used: 42, labeledBytes: 0, count: 1, files: 1 }])

    const { topRoots } = await service.storageSummary()

    expect(topRoots[0]).toMatchObject({ versionsRoot: 'legacy-root', name: 'legacy-root', ceiling: null })
    expect(retention.rootCeiling).not.toHaveBeenCalled()
  })

  it('asks for the configured top-N by default', async () => {
    await service.storageSummary()
    expect(queries.usageByAllRoots).toHaveBeenCalledWith(10)
  })

  /* --------------------------------------------------------------- purge */

  it('delegates the purge to the retention path and echoes the target back', async () => {
    retention.purgeRoot.mockResolvedValue({ removed: 3, removedBytes: 900, keptLabeled: 2 })

    const result = await service.purgeRoot('user:alice')

    expect(retention.purgeRoot).toHaveBeenCalledWith('user:alice')
    expect(result).toEqual({ versionsRoot: 'user:alice', removed: 3, removedBytes: 900, keptLabeled: 2 })
  })

  it('purges a space root too', async () => {
    await service.purgeRoot('space:team')
    expect(retention.purgeRoot).toHaveBeenCalledWith('space:team')
  })

  it.each([
    ['neither prefix', 'alice'],
    ['an empty name', 'user:'],
    ['a path traversal', 'user:../../etc'],
    ['a separator in the name', 'space:team/sub'],
    ['a bare prefix word', 'users:alice']
  ])('refuses %s with a 400 and touches nothing', async (_label, root) => {
    await expect(service.purgeRoot(root)).rejects.toMatchObject({ httpCode: HttpStatus.BAD_REQUEST })
    await expect(service.purgeRoot(root)).rejects.toBeInstanceOf(FileError)
    expect(retention.purgeRoot).not.toHaveBeenCalled()
  })

  /* ------------------------------------------------------------- repoint */

  // The repair for an install that renamed a login or a space alias before the
  // rename paths learned to repoint (#471). Everything asserted here is about
  // it being SAFE, because it is the action an operator runs from a log line
  // without a second source of truth about what it will do.
  it('repoints one root at another and reports how many rows moved', async () => {
    queries.renameRoot.mockResolvedValue(7)

    const result = await service.repointRoot('user:alice', 'user:bob')

    expect(queries.renameRoot).toHaveBeenCalledWith('user:alice', 'user:bob')
    expect(result).toEqual({ fromVersionsRoot: 'user:alice', toVersionsRoot: 'user:bob', moved: 7 })
  })

  it('repoints a space root too', async () => {
    await service.repointRoot('space:old-team', 'space:team')
    expect(queries.renameRoot).toHaveBeenCalledWith('space:old-team', 'space:team')
  })

  // A root with nothing under it is a legitimate 0 — someone may have repaired
  // it already, or the stale root never held history. It must not read as a
  // failure.
  it('reports 0 rather than failing when the stale root holds no rows', async () => {
    queries.renameRoot.mockResolvedValue(0)
    await expect(service.repointRoot('user:alice', 'user:bob')).resolves.toMatchObject({ moved: 0 })
  })

  // It only ever rewrites the recorded root. Nothing on this service's other
  // path — the one that deletes — may be reachable from here.
  it('deletes nothing', async () => {
    await service.repointRoot('user:alice', 'user:bob')
    expect(retention.purgeRoot).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed source', 'alice', 'user:bob'],
    ['a malformed target', 'user:alice', 'bob'],
    ['a path traversal in the target', 'user:alice', 'user:../../etc']
  ])('refuses %s with a 400 and moves nothing', async (_label, from, to) => {
    await expect(service.repointRoot(from, to)).rejects.toMatchObject({ httpCode: HttpStatus.BAD_REQUEST })
    expect(queries.renameRoot).not.toHaveBeenCalled()
  })

  // A user's blobs live under usersPath and a space's under spacesPath, so a
  // cross-kind repoint produces rows resolving to a tree their bytes were
  // never in — the exact breakage this endpoint repairs.
  it('refuses to repoint across the user/space line', async () => {
    await expect(service.repointRoot('user:alice', 'space:team')).rejects.toMatchObject({ httpCode: HttpStatus.BAD_REQUEST })
    expect(queries.renameRoot).not.toHaveBeenCalled()
  })

  // Answering 0 to a no-op would read like "there was nothing to fix", which
  // is the one message an operator must not get from a typo.
  it('refuses a no-op rather than answering 0', async () => {
    await expect(service.repointRoot('user:alice', 'user:alice')).rejects.toMatchObject({ httpCode: HttpStatus.BAD_REQUEST })
    expect(queries.renameRoot).not.toHaveBeenCalled()
  })
})
