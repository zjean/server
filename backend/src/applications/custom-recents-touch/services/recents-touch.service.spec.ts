import { Test, TestingModule } from '@nestjs/testing'
import fs from 'node:fs/promises'
import { ACTION } from '../../../common/constants'
import { FileEvent } from '../../files/events/file-events'
import type { FileRecent, FileRecentLocation } from '../../files/schemas/file-recent.interface'
import { FilesQueries } from '../../files/services/files-queries.service'
import { RecentsTouchService } from './recents-touch.service'
import { Mock } from 'vitest'
import { NO_CLIENT_FILE_ID } from '../../custom-shared/constants/file-ids'

// Stub fs.stat at the module level. The service does `import fs from 'node:fs/promises'`
// and calls `fs.stat`; under vitest a default-import spy (vi.spyOn(fs, 'stat')) does not
// reliably propagate to the service's own default-import binding, so mock the module and
// keep the rest of fs/promises real (importActual) for anything else in the graph.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return { ...actual, default: { ...(actual as any).default, stat: vi.fn() } }
})

// Scope: FileEvent → ensureDbRow → upsertRecent.
//
// The recents write is asserted over an in-memory *table* rather than over a
// mocked query result. That is deliberate, and it is the #493 regression lock:
// the previous version of this spec mocked the drizzle result as
// `{ affectedRows: n }`, a shape the mysql2 driver never returns
// (MySqlQueryResult is a `[ResultSetHeader, FieldPacket[]]` tuple), so a dead
// "did the UPDATE hit anything?" branch passed its test while inserting a
// duplicate row per file event in production. A stateful fake cannot be
// satisfied that way — it only goes green if the end state really is one row.

interface StatLike {
  isDirectory: () => boolean
  size: number
  mtime: Date
}

describe(RecentsTouchService.name, () => {
  let moduleRef: TestingModule
  let service: RecentsTouchService
  let recentsRows: Record<string, unknown>[]
  let filesQueriesMock: {
    getUserFileByPath: Mock
    getOrCreateUserFile: Mock
    getOrCreateSpaceFile: Mock
    getSpaceFileId: Mock
    upsertRecent: Mock
  }
  let statSpy: Mock

  const makeStat = (overrides: Partial<StatLike> = {}): StatLike => ({
    isDirectory: () => false,
    size: 1234,
    mtime: new Date(),
    ...overrides
  })

  // Mirrors FilesQueries.upsertRecent (files-queries.service.ts): inside one
  // transaction, DELETE every row matching the location (repository columns +
  // path) that carries the same name, then INSERT the new one. files_recents
  // has no unique key, so this delete-then-insert *is* the upsert.
  const rowMatches = (row: Record<string, unknown>, location: FileRecentLocation, name: string): boolean => {
    const { path: locationPath, ...repository } = location
    return row.path === locationPath && row.name === name && Object.entries(repository).every(([column, value]) => row[column] === value)
  }

  const fakeUpsertRecent = async (location: FileRecentLocation, recent: FileRecent): Promise<void> => {
    recentsRows = recentsRows.filter((row) => !rowMatches(row, location, recent.name))
    recentsRows.push({ ...recent })
  }

  beforeEach(async () => {
    // Pin the clock (Date only — leaves timers/promises real) so the 14-day
    // retention check in handleFileEvent is deterministic against the fixed
    // mtimes the tests assert on; otherwise real time eventually drifts past
    // the window and the upsert tests silently stop firing.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-23T00:00:00Z'))

    recentsRows = []

    filesQueriesMock = {
      getUserFileByPath: vi.fn().mockResolvedValue(null),
      getOrCreateUserFile: vi.fn().mockResolvedValue(101),
      getOrCreateSpaceFile: vi.fn().mockResolvedValue(202),
      getSpaceFileId: vi.fn().mockResolvedValue(undefined),
      upsertRecent: vi.fn(fakeUpsertRecent)
    }

    moduleRef = await Test.createTestingModule({
      providers: [RecentsTouchService, { provide: FilesQueries, useValue: filesQueriesMock }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(RecentsTouchService)

    statSpy = vi.mocked(fs.stat as unknown as Mock)
    statSpy.mockReset()
    statSpy.mockResolvedValue(makeStat() as never)
  })

  afterEach(async () => {
    statSpy.mockRestore()
    vi.useRealTimers()
    await moduleRef.close()
    FileEvent.removeAllListeners('event')
  })

  const personalSpace = {
    id: 0,
    url: 'files/personal/folder/foo.txt',
    relativeUrl: 'folder/foo.txt',
    inPersonalSpace: true,
    inTrashRepository: false,
    inSharesList: false,
    inSharesRepository: false
  }

  const teamSpace = {
    id: 55,
    url: 'files/team/docs/quarterly.docx',
    relativeUrl: 'docs/quarterly.docx',
    paths: ['docs', 'quarterly.docx'],
    inPersonalSpace: false,
    inTrashRepository: false,
    inSharesList: false,
    inSharesRepository: false,
    repository: 'files',
    root: { id: 0, alias: 'root' }
  }

  it('UPDATE in personal space → writes a recents row with ownerId, dir url, basename, mtime', async () => {
    const mtime = new Date('2026-05-20T10:00:00Z')
    statSpy.mockResolvedValueOnce(makeStat({ mtime }) as never)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(filesQueriesMock.getOrCreateUserFile).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ id: NO_CLIENT_FILE_ID, path: 'folder', name: 'foo.txt', isDir: false })
    )
    // The location is the one upstream's FilesRecents.updateRecentFromEditor builds,
    // so the fork's writer and upstream's editor writer address the same row.
    expect(filesQueriesMock.upsertRecent).toHaveBeenCalledWith(
      { ownerId: 7, path: 'files/personal/folder' },
      expect.objectContaining({ id: 101, name: 'foo.txt', mtime: mtime.getTime() })
    )
    expect(recentsRows).toHaveLength(1)
    expect(recentsRows[0]).toMatchObject({
      id: 101,
      ownerId: 7,
      path: 'files/personal/folder',
      name: 'foo.txt',
      mtime: mtime.getTime()
    })
  })

  it('#493: repeated saves of the same file leave exactly one recents row, with the latest mtime', async () => {
    // A Collabora session saves unprompted every ~15s; each save emits a FileEvent
    // UPDATE. Before the fix each event INSERTed a fresh row (the UPDATE branch
    // could never fire), so a ten-minute edit left ~40 rows for one file in a table
    // with no unique key, and browse-time reconciliation could not prune them.
    const saves = [
      new Date('2026-05-20T10:00:00Z'),
      new Date('2026-05-20T10:00:15Z'),
      new Date('2026-05-20T10:00:30Z'),
      new Date('2026-05-20T10:00:45Z')
    ]
    filesQueriesMock.getUserFileByPath.mockResolvedValue(101)

    for (const mtime of saves) {
      statSpy.mockResolvedValueOnce(makeStat({ mtime }) as never)
      await service.handleFileEvent({
        user: { id: 7 } as never,
        space: personalSpace as never,
        action: ACTION.UPDATE,
        rPath: '/data/7/files/personal/folder/foo.txt'
      })
    }

    expect(filesQueriesMock.upsertRecent).toHaveBeenCalledTimes(saves.length)
    expect(recentsRows).toHaveLength(1)
    expect(recentsRows[0]).toMatchObject({ id: 101, ownerId: 7, mtime: saves[saves.length - 1].getTime() })
  })

  it('ADD in a non-personal space → writes a recents row with spaceId', async () => {
    filesQueriesMock.getSpaceFileId.mockResolvedValueOnce(undefined)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: teamSpace as never,
      action: ACTION.ADD,
      rPath: '/data/team/files/docs/quarterly.docx'
    })

    expect(filesQueriesMock.upsertRecent).toHaveBeenCalledWith(
      { spaceId: 55, path: 'files/team/docs' },
      expect.objectContaining({ id: 202, name: 'quarterly.docx' })
    )
    expect(recentsRows).toHaveLength(1)
    expect(recentsRows[0]).toMatchObject({
      id: 202,
      spaceId: 55,
      path: 'files/team/docs',
      name: 'quarterly.docx'
    })
    expect(recentsRows[0].ownerId).toBeUndefined()
  })

  it('skips when the event targets a directory', async () => {
    statSpy.mockResolvedValueOnce(makeStat({ isDirectory: () => true }) as never)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.ADD,
      rPath: '/data/7/files/personal/folder'
    })

    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
    expect(filesQueriesMock.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('skips events for files in the trash repository', async () => {
    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: { ...personalSpace, inTrashRepository: true } as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/trash/personal/folder/foo.txt'
    })

    expect(statSpy).not.toHaveBeenCalled()
    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
  })

  it('skips events whose mtime is outside the 14-day retention window', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    statSpy.mockResolvedValueOnce(makeStat({ mtime: longAgo }) as never)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
    expect(filesQueriesMock.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('skips DELETE actions (cleanup is handled by browse() + scheduler)', async () => {
    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.DELETE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(statSpy).not.toHaveBeenCalled()
    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
  })

  it('skips silently when the file no longer exists on disk', async () => {
    statSpy.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/gone.txt'
    })

    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
    expect(filesQueriesMock.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('reuses an existing files-row id when the path already resolves (no duplicate insert)', async () => {
    filesQueriesMock.getUserFileByPath.mockResolvedValueOnce(555)
    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(filesQueriesMock.getOrCreateUserFile).not.toHaveBeenCalled()
    expect(recentsRows).toHaveLength(1)
    expect(recentsRows[0]).toMatchObject({ id: 555, ownerId: 7 })
  })

  it('fix #163: skips the upsert when the materialised files-row id is not positive', async () => {
    // ensureDbRow can only return a real (>0) id in practice, but the id <= 0
    // guard in handleFileEvent is the fork's #163 protection against writing
    // FS-only (negative inode) ids into files_recents — those 404 on
    // click-through because getRecentsFromUser never joins against `files`.
    // Assert the guard holds so an upstream sync can't silently drop it.
    filesQueriesMock.getUserFileByPath.mockResolvedValueOnce(null)
    filesQueriesMock.getOrCreateUserFile.mockResolvedValueOnce(0)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(filesQueriesMock.upsertRecent).not.toHaveBeenCalled()
    expect(recentsRows).toHaveLength(0)
  })

  it('repeated UPDATEs in a non-personal space also collapse to one row', async () => {
    // Catches the symmetric branch to the personal-space case: the location
    // built for the upsert carries spaceId vs ownerId, so a regression in the
    // space-side construction (a location that never matches the stored row)
    // would slip past the personal test and duplicate rows again.
    filesQueriesMock.getSpaceFileId.mockResolvedValue(202)
    const first = new Date('2026-05-22T10:00:00Z')
    const second = new Date('2026-05-22T10:05:00Z')

    for (const mtime of [first, second]) {
      statSpy.mockResolvedValueOnce(makeStat({ mtime }) as never)
      await service.handleFileEvent({
        user: { id: 7 } as never,
        space: teamSpace as never,
        action: ACTION.UPDATE,
        rPath: '/data/team/files/docs/quarterly.docx'
      })
    }

    expect(filesQueriesMock.getOrCreateSpaceFile).not.toHaveBeenCalled()
    expect(recentsRows).toHaveLength(1)
    expect(recentsRows[0]).toMatchObject({
      id: 202,
      spaceId: 55,
      name: 'quarterly.docx',
      path: 'files/team/docs',
      mtime: second.getTime()
    })
  })

  it('attachListener() is idempotent and onModuleDestroy() removes the listener', async () => {
    // Guards against the leak the principled review caught: FileEvent is a
    // process-global emitter and must release its handler when the module
    // tears down, otherwise dev hot-reloads / e2e rebuilds stack listeners.
    const before = FileEvent.listenerCount('event')
    service.attachListener()
    service.attachListener() // second call is a no-op
    expect(FileEvent.listenerCount('event')).toBe(before + 1)

    service.onModuleDestroy()
    expect(FileEvent.listenerCount('event')).toBe(before)

    // Idempotent on the destroy side too.
    service.onModuleDestroy()
    expect(FileEvent.listenerCount('event')).toBe(before)
  })
})
