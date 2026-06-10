import { NotFoundException } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { FavoritesQueries } from './favorites-queries.service'
import { Mock } from 'vitest'

// DB is mocked at the drizzle-builder level (matches nc-sync-log.service.spec.ts /
// recents-touch.service.spec.ts). We exercise the chain shape + row mapping, not real SQL.

describe(FavoritesQueries.name, () => {
  let moduleRef: TestingModule
  let service: FavoritesQueries
  let selectRows: Record<string, unknown>[]
  let inserts: { values: Record<string, unknown>; upserted: boolean }[]
  let deleteAffected: number
  let fakeDb: { select: Mock; insert: Mock; delete: Mock }

  beforeEach(async () => {
    selectRows = []
    inserts = []
    deleteAffected = 1

    // A thenable select chain: every chained method returns the same builder, and the
    // builder itself resolves to `selectRows` when awaited.
    const makeSelectBuilder = () => {
      const builder: Record<string, unknown> = {}
      for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
        builder[m] = vi.fn(() => builder)
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(selectRows)
      return builder
    }

    fakeDb = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          const entry = { values: v, upserted: false }
          inserts.push(entry)
          return {
            onDuplicateKeyUpdate: () => {
              entry.upserted = true
              return Promise.resolve([{ affectedRows: 1 }])
            }
          }
        }
      })),
      delete: vi.fn(() => ({
        where: () => Promise.resolve([{ affectedRows: deleteAffected }])
      }))
    }

    moduleRef = await Test.createTestingModule({
      providers: [FavoritesQueries, { provide: DB_TOKEN_PROVIDER, useValue: fakeDb }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(FavoritesQueries)
  })

  afterEach(async () => {
    await moduleRef.close()
  })

  it('is defined', () => {
    expect(service).toBeDefined()
  })

  it('getFavoriteIdsForUser returns the fileId list', async () => {
    selectRows = [{ fileId: 11 }, { fileId: 22 }, { fileId: 33 }]
    const ids = await service.getFavoriteIdsForUser(7)
    expect(fakeDb.select).toHaveBeenCalled()
    expect(ids).toEqual([11, 22, 33])
  })

  it('addFavorite upserts userId + fileId + access context', async () => {
    await service.addFavorite(7, 42, { path: 'files/personal/x.md', spaceId: null, shareId: null })
    expect(fakeDb.insert).toHaveBeenCalled()
    expect(inserts).toHaveLength(1)
    expect(inserts[0].values).toMatchObject({ userId: 7, fileId: 42, path: 'files/personal/x.md', spaceId: null, shareId: null })
    // re-favoriting refreshes context → onDuplicateKeyUpdate path
    expect(inserts[0].upserted).toBe(true)
  })

  it('addFavorite stamps the share context when favorited in a share', async () => {
    await service.addFavorite(7, 42, { path: 'shares/team-share/x.md', spaceId: null, shareId: 9 })
    expect(inserts[0].values).toMatchObject({ shareId: 9, spaceId: null, path: 'shares/team-share/x.md' })
  })

  it('removeFavorite throws NotFound when no rows are affected', async () => {
    deleteAffected = 0
    await expect(service.removeFavorite(7, 42)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('removeFavorite resolves when a row is deleted', async () => {
    deleteAffected = 1
    await expect(service.removeFavorite(7, 42)).resolves.toBeUndefined()
    expect(fakeDb.delete).toHaveBeenCalled()
  })

  it('getFavorites maps rows to FileFavorite objects, navPath from the stored per-user path', async () => {
    selectRows = [
      {
        id: 5,
        name: 'report.pdf',
        isDir: false,
        mime: 'application-pdf',
        size: 1234,
        mtime: 1000,
        ctime: 900,
        // navPath is the access path stamped at favorite-time (customFilesFavorites.path)
        navPath: 'files/personal/docs/report.pdf'
      }
    ]
    const favs = await service.getFavorites(7, [55], [88], 50)
    expect(fakeDb.select).toHaveBeenCalled()
    expect(favs).toHaveLength(1)
    expect(favs[0]).toMatchObject({ id: 5, name: 'report.pdf', isDir: false, isFavorite: true })
    expect(favs[0].navPath).toBe('files/personal/docs/report.pdf')
  })

  it('getFavoriteForFile returns a mapped FileFavorite carrying its stored navPath', async () => {
    selectRows = [
      {
        id: 5,
        name: 'photo.jpg',
        isDir: false,
        mime: 'image-jpeg',
        size: 10,
        mtime: 1,
        ctime: 1,
        // favorited through a share → nav path is the share path the user used
        navPath: 'shares/team-share/photo.jpg'
      }
    ]
    const fav = await service.getFavoriteForFile(7, 5)
    expect(fav).toBeDefined()
    expect(fav?.isFavorite).toBe(true)
    expect(fav?.navPath).toBe('shares/team-share/photo.jpg')
  })

  it('getFavoriteForFile returns undefined when no row exists', async () => {
    selectRows = []
    const fav = await service.getFavoriteForFile(7, 999)
    expect(fav).toBeUndefined()
  })
})
