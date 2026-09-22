import { Test, TestingModule } from '@nestjs/testing'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
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
    const calls: { orderBy: number; limit?: number; where?: unknown } = { orderBy: 0 }
    fakeDb.select = vi.fn(() => ({
      from: () => ({
        where: (condition: unknown) => {
          calls.where = condition
          return {
            orderBy: (...args: unknown[]) => {
              calls.orderBy = args.length
              return {
                limit: (n: number) => {
                  calls.limit = n
                  return Promise.resolve(rows)
                }
              }
            }
          }
        }
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

  describe('since() — the sync-token reader', () => {
    // REGRESSION #479. `repository` is a second dimension the spaceAlias filter
    // does not constrain: the personal space carries alias 'personal' for BOTH
    // repositories. Without this condition a trash row whose trash-relative
    // path collides with a live files path is returned to the files REPORT and
    // can override the files event for that path. The only caller refuses the
    // trashbin URL outright, so trash rows are never wanted here.
    it('scopes the query to the files repository', async () => {
      const calls = captureSelect([])
      await service.since({ ownerId: 7, sinceId: 3, spaceAlias: 'personal' })

      const query = new MySqlDialect().sqlToQuery(calls.where as never)
      expect(query.sql).toContain('`repository`')
      expect(query.params).toContain('files')
    })

    // REGRESSION: the token that goes with the filtered window. Because
    // `since()` drops trash rows in SQL, the last row it returns is the last
    // FILES row — stamping that as the token parks the client behind every
    // trash row above it (delete 600 files, sync, empty the trash: the next
    // REPORT is empty and echoes the old token back), until the prune lifts the
    // GLOBAL minKeptToken() past it and the client is thrown a 412 full re-sync
    // it never earned. `maxIdInWindow` is the same window WITHOUT the
    // repository filter, so a row we chose not to send still advances the
    // client — and it keeps the ownerId/spaceAlias scope, so the token never
    // advances past another collection's events.
    describe('maxIdInWindow() — the token ceiling', () => {
      const captureAggregate = (rows: Record<string, unknown>[]) => {
        const calls: { where?: unknown } = {}
        fakeDb.select = vi.fn(() => ({
          from: () => ({
            where: (condition: unknown) => {
              calls.where = condition
              return Promise.resolve(rows)
            }
          })
        }))
        return calls
      }

      it('does NOT constrain the repository, but keeps the owner + space scope', async () => {
        const calls = captureAggregate([{ max: 1600 }])
        const max = await service.maxIdInWindow({ ownerId: 7, sinceId: 1000, spaceAlias: 'personal' })

        const query = new MySqlDialect().sqlToQuery(calls.where as never)
        expect(query.sql).not.toContain('`repository`')
        expect(query.sql).toContain('`ownerId`')
        expect(query.sql).toContain('`spaceAlias`')
        expect(query.params).toContain(1000)
        expect(max).toBe(1600)
      })

      it('returns 0 for an empty window — MAX() over no rows is NULL', async () => {
        captureAggregate([{ max: null }])
        expect(await service.maxIdInWindow({ ownerId: 7, sinceId: 1000 })).toBe(0)
      })

      it('coerces a max a driver may hand back as a string', async () => {
        captureAggregate([{ max: '1600' }])
        expect(await service.maxIdInWindow({ ownerId: 7, sinceId: 0 })).toBe(1600)
      })
    })

    it('orders ascending by id and defaults the limit to 500', async () => {
      const calls = captureSelect([row()])
      const events = await service.since({ ownerId: 7, sinceId: 0 })

      expect(calls.orderBy).toBe(1)
      expect(calls.limit).toBe(500)
      expect(events).toHaveLength(1)
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

  // REGRESSION #478. The move-to-trash emission is the one that does NOT
  // address the space it names: upstream fires the SOURCE (files) space with
  // `rPath` set to the file's new ABSOLUTE path under the user's trash root,
  // which shares no prefix with the files space's realBasePath. Logging that
  // verbatim both discloses the server's disk layout in the REPORT body and
  // makes the 404 marker name an href no client has ever seen — so the delete
  // never propagates, which is the entire point of RFC 6578 incremental sync.
  // The payload below is the exact shape files-manager.service.ts emits.
  it('FileEvent DELETE (move to trash) → logs the ORIGINAL files-relative path, not the absolute trash path', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: {
        repository: 'files',
        alias: 'personal',
        realBasePath: '/var/lib/syncin/users/bob/files',
        realPath: '/var/lib/syncin/users/bob/files/photos/cat.jpg'
      },
      action: ACTION.DELETE,
      rPath: '/var/lib/syncin/users/bob/trash/photos/cat.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured[0]).toMatchObject({ repository: 'files', spaceAlias: 'personal', path: 'photos/cat.jpg', type: 'delete' })
    // No absolute path may survive into the row at all.
    expect(captured[0].path).not.toContain('/var/lib/syncin')
  })

  // A DELETE that arrives without space.realPath has NO safe fallback: `rPath`
  // on this emission is the absolute TRASH path, so falling back to it writes
  // exactly the row #478 exists to remove — an unaddressable href plus the
  // server's disk layout. The payload below is a real move-to-trash shape with
  // realPath missing, which is the only way the fallback is reachable; the row
  // must not be written at all.
  it('FileEvent DELETE without space.realPath is dropped, never logged as the absolute trash path', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      space: { repository: 'files', alias: 'personal', realBasePath: '/var/lib/syncin/users/bob/files' },
      action: ACTION.DELETE,
      rPath: '/var/lib/syncin/users/bob/trash/photos/cat.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toEqual([])
  })

  // Fail-safe for every action, not just DELETE: whatever the reason a path did
  // not reduce to a space-relative one, an absolute server path addresses
  // nothing a client can ask for and discloses the disk layout.
  it('drops any event whose path did not reduce to a space-relative one', async () => {
    service.attachListener()
    ;(FileEvent.emit as (e: 'event', payload: unknown) => boolean)('event', {
      user: { id: 7 },
      // no realBasePath at all → nothing to strip
      space: { repository: 'files', alias: 'personal' },
      action: ACTION.ADD,
      rPath: '/var/lib/syncin/users/bob/files/photo.jpg'
    })
    await new Promise((r) => setImmediate(r))
    expect(captured).toEqual([])
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
