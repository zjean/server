import { Test, TestingModule } from '@nestjs/testing'
import { ACTION } from '../../../common/constants'
import { FileEvent } from '../../files/events/file-events'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { NcSyncLogService } from './nc-sync-log.service'

// Phase 1 spec scope: cover the FileEvent → append() mapping (the only
// thing that runs without a real DB). The query-side methods (since,
// currentToken, prune) build Drizzle filter objects whose evaluation
// requires either a real DB or a heavy filter-tree interpreter. Those are
// covered by the integration smoke at phase 4.

describe(NcSyncLogService.name, () => {
  let moduleRef: TestingModule
  let service: NcSyncLogService
  let captured: Record<string, unknown>[]
  let fakeDb: { insert: jest.Mock }

  beforeEach(async () => {
    captured = []
    fakeDb = {
      insert: jest.fn(() => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v)
          return Promise.resolve({ affectedRows: 1 })
        }
      }))
    }
    moduleRef = await Test.createTestingModule({
      providers: [NcSyncLogService, { provide: DB_TOKEN_PROVIDER, useValue: fakeDb }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcSyncLogService)
  })

  afterEach(async () => {
    await moduleRef.close()
    FileEvent.removeAllListeners('event')
  })

  it('append() inserts a row with the given fields', async () => {
    await service.append({ ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'a.pdf', type: 'create', ts: 1000 })
    expect(captured).toEqual([{ ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'a.pdf', type: 'create', ts: 1000 }])
  })

  it('FileEvent ADD → appends a `create` row with path stripped of space.realBasePath prefix', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/files/personal/photo.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toEqual([
      expect.objectContaining({ ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'photo.jpg', type: 'create' })
    ])
  })

  it('FileEvent UPDATE → appends an `update` row', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.UPDATE,
      rPath: '/data/janwiebe/files/personal/notes.md'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured[0]).toMatchObject({ type: 'update', path: 'notes.md' })
  })

  it('FileEvent DELETE_PERMANENTLY → appends a `delete` row', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.DELETE_PERMANENTLY,
      rPath: '/data/janwiebe/files/personal/old.pdf'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured[0]).toMatchObject({ type: 'delete', path: 'old.pdf' })
  })

  it('trash repository events get repository="trash"', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'trash', alias: 'personal', realBasePath: '/data/janwiebe/trash/personal' },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/trash/personal/old.pdf'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured[0]).toMatchObject({ repository: 'trash' })
  })

  it('attachListener is idempotent — second call does not double-subscribe', async () => {
    service.attachListener()
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/files/personal/x.txt'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
  })

  it('skips events with unmappable actions (no row written)', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: 'OPEN' as never, // not in our enum-to-type map
      rPath: '/data/janwiebe/files/personal/x.txt'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toEqual([])
  })

  it('production rPath===space.realPath case stores the path relative to realBasePath (regression)', async () => {
    // Real upstream emission: FilesManager fires `rPath: space.realPath`, where
    // space.realPath already includes the file's full path (paths=['photos','cat.jpg'])
    // while realBasePath is the space root. Stripping realPath would yield ''.
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: {
        repository: 'files',
        alias: 'personal',
        realBasePath: '/data/janwiebe/files/personal',
        realPath: '/data/janwiebe/files/personal/photos/cat.jpg'
      },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/files/personal/photos/cat.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured[0]).toMatchObject({ path: 'photos/cat.jpg', type: 'create' })
  })

  it('skips events with no user', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: null,
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/files/personal/x.txt'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toEqual([])
  })
})
