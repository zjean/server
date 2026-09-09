import { Test, TestingModule } from '@nestjs/testing'
import { Mock } from 'vitest'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { FavoritesQueries } from './favorites-queries.service'

// DB is mocked at the drizzle-builder level (matches nc-sync-log.service.spec.ts /
// recents-touch.service.spec.ts). We exercise the chain shape + row mapping, not real SQL.
//
// Only one query survives upstream shipping favorites in 2.5.0 — see the service.

describe(FavoritesQueries.name, () => {
  let moduleRef: TestingModule
  let service: FavoritesQueries
  let selectRows: Record<string, unknown>[]
  let fakeDb: { select: Mock }

  beforeEach(async () => {
    selectRows = []

    // A thenable select chain: every chained method returns the same builder, and the
    // builder itself resolves to `selectRows` when awaited.
    const makeSelectBuilder = () => {
      const builder: Record<string, unknown> = {}
      for (const m of ['from', 'where', 'limit']) {
        builder[m] = vi.fn(() => builder)
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(selectRows)
      return builder
    }

    fakeDb = { select: vi.fn(() => makeSelectBuilder()) }

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

  it('getFavoriteIdsForUser maps rows to a bare id list', async () => {
    selectRows = [{ fileId: 11 }, { fileId: 22 }]
    await expect(service.getFavoriteIdsForUser(1)).resolves.toEqual([11, 22])
    expect(fakeDb.select).toHaveBeenCalledTimes(1)
  })

  it('getFavoriteIdsForUser returns an empty list when the user has no favorites', async () => {
    selectRows = []
    await expect(service.getFavoriteIdsForUser(1)).resolves.toEqual([])
  })
})
