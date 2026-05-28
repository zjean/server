import { Test, TestingModule } from '@nestjs/testing'
import fs from 'node:fs/promises'
import { ACTION } from '../../../common/constants'
import { FileEvent } from '../../files/events/file-events'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { FilesQueries } from '../../files/services/files-queries.service'
import { RecentsTouchService } from './recents-touch.service'

// Scope: FileEvent → ensureDbRow → upsertRecent. The DB layer is mocked at the
// drizzle-builder level (matches the pattern in nc-sync-log.service.spec.ts);
// we exercise branching and column shape, not real SQL.

interface StatLike {
  isDirectory: () => boolean
  size: number
  mtime: Date
}

describe(RecentsTouchService.name, () => {
  let moduleRef: TestingModule
  let service: RecentsTouchService
  let updates: Record<string, unknown>[]
  let inserts: Record<string, unknown>[]
  let updateAffected: number
  let filesQueriesMock: {
    getUserFileByPath: jest.Mock
    getOrCreateUserFile: jest.Mock
    getOrCreateSpaceFile: jest.Mock
    getSpaceFileId: jest.Mock
  }
  let statSpy: jest.SpyInstance

  const makeStat = (overrides: Partial<StatLike> = {}): StatLike => ({
    isDirectory: () => false,
    size: 1234,
    mtime: new Date(),
    ...overrides
  })

  beforeEach(async () => {
    updates = []
    inserts = []
    updateAffected = 0

    const fakeDb = {
      update: jest.fn(() => ({
        set: (set: Record<string, unknown>) => ({
          where: () => ({
            limit: () => {
              updates.push(set)
              return Promise.resolve({ affectedRows: updateAffected })
            }
          })
        })
      })),
      insert: jest.fn(() => ({
        values: (v: Record<string, unknown>) => {
          inserts.push(v)
          return Promise.resolve({ affectedRows: 1 })
        }
      }))
    }

    filesQueriesMock = {
      getUserFileByPath: jest.fn().mockResolvedValue(null),
      getOrCreateUserFile: jest.fn().mockResolvedValue(101),
      getOrCreateSpaceFile: jest.fn().mockResolvedValue(202),
      getSpaceFileId: jest.fn().mockResolvedValue(undefined)
    }

    moduleRef = await Test.createTestingModule({
      providers: [RecentsTouchService, { provide: DB_TOKEN_PROVIDER, useValue: fakeDb }, { provide: FilesQueries, useValue: filesQueriesMock }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(RecentsTouchService)

    statSpy = jest.spyOn(fs, 'stat').mockResolvedValue(makeStat() as never)
  })

  afterEach(async () => {
    statSpy.mockRestore()
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

  it('UPDATE in personal space → inserts a recents row with ownerId, dir url, basename, mtime', async () => {
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
      expect.objectContaining({ id: 0, path: 'folder', name: 'foo.txt', isDir: false })
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      id: 101,
      ownerId: 7,
      spaceId: null,
      shareId: null,
      path: 'files/personal/folder',
      name: 'foo.txt',
      mtime: mtime.getTime()
    })
  })

  it('UPDATE for a file already in recents → updates mtime, no insert', async () => {
    updateAffected = 1
    const mtime = new Date('2026-05-21T10:00:00Z')
    statSpy.mockResolvedValueOnce(makeStat({ mtime }) as never)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/foo.txt'
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ name: 'foo.txt', path: 'files/personal/folder', mtime: mtime.getTime() })
    expect(inserts).toHaveLength(0)
  })

  it('ADD in a non-personal space → inserts a recents row with spaceId', async () => {
    filesQueriesMock.getSpaceFileId.mockResolvedValueOnce(undefined)
    const spaceSpace = {
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

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: spaceSpace as never,
      action: ACTION.ADD,
      rPath: '/data/team/files/docs/quarterly.docx'
    })

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      id: 202,
      ownerId: null,
      spaceId: 55,
      shareId: null,
      path: 'files/team/docs',
      name: 'quarterly.docx'
    })
  })

  it('skips when the event targets a directory', async () => {
    statSpy.mockResolvedValueOnce(makeStat({ isDirectory: () => true }) as never)

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.ADD,
      rPath: '/data/7/files/personal/folder'
    })

    expect(inserts).toHaveLength(0)
    expect(updates).toHaveLength(0)
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
    expect(inserts).toHaveLength(0)
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

    expect(inserts).toHaveLength(0)
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
    expect(inserts).toHaveLength(0)
  })

  it('skips silently when the file no longer exists on disk', async () => {
    statSpy.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: personalSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/7/files/personal/folder/gone.txt'
    })

    expect(inserts).toHaveLength(0)
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
    expect(inserts[0]).toMatchObject({ id: 555, ownerId: 7 })
  })

  it('UPDATE in a non-personal space for an existing recents row → updates, no insert', async () => {
    // Catches the symmetric branch to the personal-space update test: the
    // WHERE clause for the upsert builds spaceId vs ownerId, so a regression
    // in the space-side construction would slip past the personal test.
    filesQueriesMock.getSpaceFileId.mockResolvedValueOnce(202)
    updateAffected = 1
    const mtime = new Date('2026-05-22T10:00:00Z')
    statSpy.mockResolvedValueOnce(makeStat({ mtime }) as never)
    const spaceSpace = {
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

    await service.handleFileEvent({
      user: { id: 7 } as never,
      space: spaceSpace as never,
      action: ACTION.UPDATE,
      rPath: '/data/team/files/docs/quarterly.docx'
    })

    expect(filesQueriesMock.getOrCreateSpaceFile).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ name: 'quarterly.docx', path: 'files/team/docs', mtime: mtime.getTime() })
    expect(inserts).toHaveLength(0)
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
