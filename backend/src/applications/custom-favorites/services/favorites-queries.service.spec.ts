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
  let inserts: { values: Record<string, unknown>; ignored: boolean }[]
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
      insert: vi.fn(() => {
        const entry = { values: {} as Record<string, unknown>, ignored: false }
        const chain = {
          ignore: () => {
            entry.ignored = true
            return chain
          },
          values: (v: Record<string, unknown>) => {
            entry.values = v
            inserts.push(entry)
            return Promise.resolve({ affectedRows: 1 })
          }
        }
        return chain
      }),
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

  it('addFavorite issues an insert-ignore with userId + fileId', async () => {
    await service.addFavorite(7, 42)
    expect(fakeDb.insert).toHaveBeenCalled()
    expect(inserts).toHaveLength(1)
    expect(inserts[0].ignored).toBe(true)
    expect(inserts[0].values).toMatchObject({ userId: 7, fileId: 42 })
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

  it('getFavorites issues the chained select and maps rows to FileFavorite objects', async () => {
    selectRows = [
      {
        id: 5,
        name: 'report.pdf',
        isDir: false,
        mime: 'application-pdf',
        size: 1234,
        mtime: 1000,
        ctime: 900,
        // path is the PARENT directory within the space; name is the item
        path: 'docs',
        ownerId: 7,
        spaceAlias: null,
        shareAlias: null
      }
    ]
    const favs = await service.getFavorites(7, [55], [88], 50)
    expect(fakeDb.select).toHaveBeenCalled()
    expect(favs).toHaveLength(1)
    expect(favs[0]).toMatchObject({ id: 5, name: 'report.pdf', isDir: false, isFavorite: true })
    // personal-space file (ownerId set) → files/personal/<parent>/<name>
    expect(favs[0].navPath).toBe('files/personal/docs/report.pdf')
  })

  it('getFavoriteForFile returns a mapped FileFavorite when a row exists', async () => {
    selectRows = [
      {
        id: 5,
        name: 'photo.jpg',
        isDir: false,
        mime: 'image-jpeg',
        size: 10,
        mtime: 1,
        ctime: 1,
        // file at the space root → parent path is '.'
        path: '.',
        ownerId: null,
        spaceAlias: 'team',
        shareAlias: null
      }
    ]
    const fav = await service.getFavoriteForFile(7, 5)
    expect(fav).toBeDefined()
    expect(fav?.isFavorite).toBe(true)
    expect(fav?.navPath).toBe('files/team/photo.jpg')
  })

  it('getFavoriteForFile returns undefined when no row exists', async () => {
    selectRows = []
    const fav = await service.getFavoriteForFile(7, 999)
    expect(fav).toBeUndefined()
  })
})
