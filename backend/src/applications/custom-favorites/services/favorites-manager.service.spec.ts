import { Test, TestingModule } from '@nestjs/testing'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { UserModel } from '../../users/models/user.model'
import { FavoritesManager } from './favorites-manager.service'
import { FavoritesQueries } from './favorites-queries.service'
import { Mock } from 'vitest'

// All injected deps are mocked with vi.fn(); the fs-touching private methods
// (getOrCreateFileId / getFileId) are intentionally not exercised here — we
// assert the delegation/limit-capping behavior only.

describe(FavoritesManager.name, () => {
  let moduleRef: TestingModule
  let service: FavoritesManager
  let favoritesQueriesMock: { getFavorites: Mock; getFavoriteIdsForUser: Mock; addFavorite: Mock; getFavoriteForFile: Mock; removeFavorite: Mock }
  let filesQueriesMock: { getOrCreateSpaceFile: Mock; getSpaceFileId: Mock }
  let spacesQueriesMock: { spaceIds: Mock }
  let sharesQueriesMock: { shareIds: Mock }

  const user = { id: 1, isAdmin: false } as unknown as UserModel

  beforeEach(async () => {
    favoritesQueriesMock = {
      getFavorites: vi.fn().mockResolvedValue([]),
      getFavoriteIdsForUser: vi.fn().mockResolvedValue([11, 22]),
      addFavorite: vi.fn().mockResolvedValue(undefined),
      getFavoriteForFile: vi.fn().mockResolvedValue({ id: 9, isFavorite: true, navPath: 'files/personal/x' }),
      removeFavorite: vi.fn().mockResolvedValue(undefined)
    }
    filesQueriesMock = {
      getOrCreateSpaceFile: vi.fn().mockResolvedValue(9),
      getSpaceFileId: vi.fn().mockResolvedValue(9)
    }
    spacesQueriesMock = { spaceIds: vi.fn().mockResolvedValue([]) }
    sharesQueriesMock = { shareIds: vi.fn().mockResolvedValue([]) }

    moduleRef = await Test.createTestingModule({
      providers: [
        FavoritesManager,
        { provide: FavoritesQueries, useValue: favoritesQueriesMock },
        { provide: FilesQueries, useValue: filesQueriesMock },
        { provide: SpacesQueries, useValue: spacesQueriesMock },
        { provide: SharesQueries, useValue: sharesQueriesMock }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(FavoritesManager)
  })

  afterEach(async () => {
    await moduleRef.close()
  })

  it('is defined', () => {
    expect(service).toBeDefined()
  })

  it('getFavorites resolves spaceIds + shareIds then delegates with a capped limit', async () => {
    await service.getFavorites(user, 9999)
    expect(spacesQueriesMock.spaceIds).toHaveBeenCalledWith(1)
    expect(sharesQueriesMock.shareIds).toHaveBeenCalledWith(1, 0)
    expect(favoritesQueriesMock.getFavorites).toHaveBeenCalledWith(1, [], [], 1000)
  })

  it('getFavorites defaults to 100 when no limit is supplied', async () => {
    await service.getFavorites(user)
    expect(favoritesQueriesMock.getFavorites).toHaveBeenCalledWith(1, [], [], 100)
  })

  it('getFavoriteIds delegates to favoritesQueries.getFavoriteIdsForUser', async () => {
    const ids = await service.getFavoriteIds(user)
    expect(favoritesQueriesMock.getFavoriteIdsForUser).toHaveBeenCalledWith(1)
    expect(ids).toEqual([11, 22])
  })
})
