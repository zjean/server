import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { UserModel } from '../../users/models/user.model'
import { NcActivityService } from './nc-activity.service'
import { NcSyncLogService } from './nc-sync-log.service'
import type { NcSyncEvent } from './nc-sync-log.service'

const USER = { id: 7, login: 'alice' } as UserModel
const SERVER = 'https://cloud.example.test'

function event(overrides: Partial<NcSyncEvent> = {}): NcSyncEvent {
  return {
    id: 77,
    ownerId: 7,
    repository: 'files',
    spaceAlias: 'personal',
    path: 'docs/report.txt',
    type: 'update',
    ts: 1_753_005_600_000,
    ...overrides
  }
}

describe(NcActivityService.name, () => {
  let service: NcActivityService
  let recent: Mock
  let recentForPath: Mock
  let getUserFile: Mock

  beforeEach(async () => {
    recent = vi.fn().mockResolvedValue([])
    recentForPath = vi.fn().mockResolvedValue([])
    getUserFile = vi.fn()

    const moduleRef = await Test.createTestingModule({
      providers: [
        NcActivityService,
        { provide: NcSyncLogService, useValue: { recent, recentForPath } },
        { provide: FilesQueries, useValue: { getUserFile } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcActivityService)
  })

  describe('recent', () => {
    it('maps the user’s recent events onto activity entries', async () => {
      recent.mockResolvedValue([event({ id: 78, type: 'create' }), event({ id: 77, type: 'update' })])

      const entries = await service.recent(USER, SERVER, 50)

      expect(recent).toHaveBeenCalledWith({ ownerId: 7, limit: 50 })
      expect(entries.map((e) => e.activity_id)).toEqual([78, 77])
      expect(entries.map((e) => e.type)).toEqual(['file_created', 'file_changed'])
    })

    // The log carries no fileId, and resolving one per row would be a query per
    // entry for a field the client only follows from a rich object — which this
    // fork does not emit (see nc-activity-entry.ts).
    it('leaves object_id at 0 in the unfiltered feed rather than a query per row', async () => {
      recent.mockResolvedValue([event()])
      const [entry] = await service.recent(USER, SERVER, 50)
      expect(entry.object_id).toBe(0)
    })

    it('returns an empty feed when the log has nothing for this user', async () => {
      await expect(service.recent(USER, SERVER, 50)).resolves.toEqual([])
    })
  })

  describe('forFile', () => {
    it('resolves the fileId to a path and reads that path’s events', async () => {
      getUserFile.mockResolvedValue({ id: 4242, path: 'docs/report.txt' })
      recentForPath.mockResolvedValue([event()])

      const entries = await service.forFile(USER, 4242, SERVER, 25)

      // Owner-scoped lookup — the authorization step as well as the lookup.
      expect(getUserFile).toHaveBeenCalledWith(7, 4242)
      expect(recentForPath).toHaveBeenCalledWith({ ownerId: 7, spaceAlias: 'personal', path: 'docs/report.txt', limit: 25 })
      expect(entries).toHaveLength(1)
      // Here the id IS known, so it is carried through.
      expect(entries[0].object_id).toBe(4242)
    })

    // EMPTY, NEVER AN ERROR — and this is the whole point of the endpoint, not a
    // convenience. NC Android renders its file-detail list only when the
    // activities call yields a parseable OCS body; a 404 for every file the log
    // has not seen would reintroduce exactly the failure this fixes.
    it.each([
      ['the file is not owned by the requester', () => getUserFile.mockResolvedValue(null)],
      ['the row carries no path', () => getUserFile.mockResolvedValue({ id: 4242, path: '' })],
      ['the lookup throws', () => getUserFile.mockRejectedValue(new Error('db down'))]
    ])('returns an empty feed, not an error, when %s', async (_label, arrange) => {
      arrange()
      await expect(service.forFile(USER, 4242, SERVER, 25)).resolves.toEqual([])
      expect(recentForPath).not.toHaveBeenCalled()
    })

    // A file whose last change predates the log's 30-day prune horizon has no
    // events. Correct, not a bug — the same horizon already bounds what the sync
    // REPORT can replay.
    it('returns an empty feed for a resolvable file with no logged events', async () => {
      getUserFile.mockResolvedValue({ id: 4242, path: 'docs/report.txt' })
      await expect(service.forFile(USER, 4242, SERVER, 25)).resolves.toEqual([])
    })
  })
})
