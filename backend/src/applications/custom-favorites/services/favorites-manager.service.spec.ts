import { Test, TestingModule } from '@nestjs/testing'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { UserModel } from '../../users/models/user.model'
import { FavoritesManager } from './favorites-manager.service'
import { FavoritesQueries } from './favorites-queries.service'
import { Mock } from 'vitest'

// Stub the fs-touching helpers so addFavorite/removeFavorite resolve a file id
// without hitting disk — lets us assert the access-context mapping.
vi.mock('../../files/utils/files', () => ({
  isPathExists: vi.fn().mockResolvedValue(true),
  getProps: vi.fn().mockResolvedValue({ name: 'x.md', path: '.', isDir: false, size: 1, mtime: 1, ctime: 1 })
}))

// Build a minimal SpaceEnv-like object carrying just the fields the manager reads.
const makeSpace = (over: Partial<SpaceEnv>): SpaceEnv =>
  ({ id: 0, url: '', inPersonalSpace: false, inSharesRepository: false, realPath: '/tmp/x', dbFile: { path: '.' }, ...over }) as unknown as SpaceEnv

// All injected deps are mocked with vi.fn().

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

  it('addFavorite stamps the PERSONAL context (no space/share) from the space url', async () => {
    await service.addFavorite(user, makeSpace({ inPersonalSpace: true, url: 'files/personal/docs/x.md', id: 5 }))
    expect(favoritesQueriesMock.addFavorite).toHaveBeenCalledWith(1, 9, { path: 'files/personal/docs/x.md', spaceId: null, shareId: null })
  })

  it('addFavorite stamps the SPACE context with the space id', async () => {
    await service.addFavorite(user, makeSpace({ url: 'files/team/x.md', id: 3 }))
    expect(favoritesQueriesMock.addFavorite).toHaveBeenCalledWith(1, 9, { path: 'files/team/x.md', spaceId: 3, shareId: null })
  })

  it('addFavorite stamps the SHARE context with the share id (space.id in the shares repo)', async () => {
    await service.addFavorite(user, makeSpace({ inSharesRepository: true, url: 'shares/team-share/x.md', id: 8 }))
    expect(favoritesQueriesMock.addFavorite).toHaveBeenCalledWith(1, 9, { path: 'shares/team-share/x.md', spaceId: null, shareId: 8 })
  })
})
