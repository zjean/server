import { Test, TestingModule } from '@nestjs/testing'
import { ACTION } from '../../../common/constants'
import { FileEvent } from '../../files/events/file-events'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { NcSyncLogService } from './nc-sync-log.service'
import { Mock } from 'vitest'

// Phase 1 spec scope: cover the FileEvent → append() mapping (the only
// thing that runs without a real DB). The query-side methods (since,
// currentToken, prune) build Drizzle filter objects whose evaluation
// requires either a real DB or a heavy filter-tree interpreter. Those are
// covered by the integration smoke at phase 4.
//
// The two display readers added for the activity feed (`recent`,
// `recentForPath`) are tested below for QUERY SHAPE rather than filter
// semantics: the ordering and the limit are what a caller's correctness depends
// on, and both are observable without evaluating the filter tree. Getting the
// order wrong would make `limit` truncate to the OLDEST events instead of the
// newest — a silent wrong-answer bug rather than an error.

describe(NcSyncLogService.name, () => {
  let moduleRef: TestingModule
  let service: NcSyncLogService
  let captured: Record<string, unknown>[]
  let fakeDb: { insert: Mock; select: Mock }
  // Test override for resolveViewers — when set, replaces the real DB-backed
  // implementation so existing personal-space tests don't need to mock the
  // shared-space query chain. Shared-space tests assign this directly.
  let viewerResolver: ((actorId: number, spaceAlias: string, spaceId?: number) => Promise<number[]>) | undefined

  beforeEach(async () => {
    captured = []
    viewerResolver = undefined
    fakeDb = {
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v)
          return Promise.resolve({ affectedRows: 1 })
        }
      })),
      // Empty select chain — resolveViewers' DB path is exercised via the
      // viewerResolver override on shared-space tests below.
      select: vi.fn(() => ({ from: () => ({ where: () => Promise.resolve([]) }) }))
    }
    moduleRef = await Test.createTestingModule({
      providers: [NcSyncLogService, { provide: DB_TOKEN_PROVIDER, useValue: fakeDb }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcSyncLogService)
    // Patch resolveViewers to honor the per-test override when set.
    const orig = service.resolveViewers.bind(service)
    ;(service as { resolveViewers: NcSyncLogService['resolveViewers'] }).resolveViewers = (
      actorId: number,
      alias: string,
      spaceId: number | undefined
    ) => (viewerResolver ? viewerResolver(actorId, alias, spaceId) : orig(actorId, alias, spaceId))
  })

  afterEach(async () => {
    await moduleRef.close()
    FileEvent.removeAllListeners('event')
  })

  // A chainable select fake that records what was asked for. Returns `rows`
  // from the terminal .limit() call, mirroring Drizzle's builder shape.
  const captureSelect = (rows: Record<string, unknown>[]) => {
    const calls: { orderBy: number; limit?: number } = { orderBy: 0 }
    fakeDb.select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: (...args: unknown[]) => {
            calls.orderBy = args.length
            return {
              limit: (n: number) => {
                calls.limit = n
                return Promise.resolve(rows)
              }
            }
          }
        })
      })
    }))
    return calls
  }

  const row = (over: Record<string, unknown> = {}) => ({
    id: 5,
    ownerId: 7,
    repository: 'files',
    spaceAlias: 'personal',
    path: 'docs/report.txt',
    type: 'update',
    ts: 1000,
    ...over
  })

  describe('display readers for the activity feed', () => {
    // NEWEST FIRST, and the limit therefore truncates the tail rather than the
    // head. With ascending order, `limit: 50` on a busy account would return the
    // 50 OLDEST events and the feed would look frozen.
    it('recentForPath orders and limits, defaulting to 50', async () => {
      const calls = captureSelect([row()])
      const events = await service.recentForPath({ ownerId: 7, spaceAlias: 'personal', path: 'docs/report.txt' })

      expect(calls.orderBy).toBe(1)
      expect(calls.limit).toBe(50)
      expect(events).toEqual([{ id: 5, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'docs/report.txt', type: 'update', ts: 1000 }])
    })

    it('recentForPath honours an explicit limit', async () => {
      const calls = captureSelect([])
      await service.recentForPath({ ownerId: 7, spaceAlias: 'personal', path: 'a.txt', limit: 5 })
      expect(calls.limit).toBe(5)
    })

    it('recent orders and limits, defaulting to 50', async () => {
      const calls = captureSelect([row()])
      const events = await service.recent({ ownerId: 7 })

      expect(calls.orderBy).toBe(1)
      expect(calls.limit).toBe(50)
      expect(events).toHaveLength(1)
    })

    // The bigint columns come back as strings on some driver versions, so the
    // Number() coercions in toSyncEvent are load-bearing: a string id would
    // serialize into the activity payload as a quoted value and break the
    // client's Int field.
    it('coerces the bigint columns a driver may hand back as strings', async () => {
      captureSelect([row({ id: '9', ownerId: '7', ts: '1700000000000' })])
      const [event] = await service.recent({ ownerId: 7 })

      expect(event.id).toBe(9)
      expect(event.ownerId).toBe(7)
      expect(event.ts).toBe(1_700_000_000_000)
    })
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

  it('shared-space event fans out to every viewer (regression for #206)', async () => {
    // A change made by user 7 in space "team-photos" (id=99) is visible to
    // every space member: user 8 (direct), user 9 + user 10 (via group 50).
    // Without fanout, B's REPORT (filtered by ownerId=B) never sees changes
    // A makes in the shared space.
    viewerResolver = async (actorId, alias, spaceId) => {
      expect(alias).toBe('team-photos')
      expect(spaceId).toBe(99)
      return [actorId, 8, 9, 10]
    }
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { id: 99, repository: 'files', alias: 'team-photos', realBasePath: '/data/team-photos/files' },
      action: ACTION.ADD,
      rPath: '/data/team-photos/files/photo.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(4)
    expect((captured.map((c) => c.ownerId) as number[]).sort((a, b) => a - b)).toEqual([7, 8, 9, 10])
    for (const row of captured) {
      expect(row).toMatchObject({ spaceAlias: 'team-photos', path: 'photo.jpg', type: 'create' })
    }
  })

  it('personal-space event writes exactly one row (no fanout query, no DB lookup)', async () => {
    // Personal spaces have only one viewer — the owner. The handler must
    // short-circuit before any DB query, otherwise every PUT in a personal
    // space pays an extra round-trip.
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/data/janwiebe/files/personal' },
      action: ACTION.ADD,
      rPath: '/data/janwiebe/files/personal/photo.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ ownerId: 7 })
    expect(fakeDb.select).not.toHaveBeenCalled()
  })
})
