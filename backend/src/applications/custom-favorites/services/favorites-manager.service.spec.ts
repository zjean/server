import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { Mock } from 'vitest'
import { FilesFavoritesManager } from '../../files/services/files-favorites-manager.service'
import { FilesFavoritesQueries } from '../../files/services/files-favorites-queries.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { FavoritesManager } from './favorites-manager.service'
import { FavoritesQueries } from './favorites-queries.service'

// Stub the fs-touching helpers so addFavorite/removeFavorite resolve a file id
// without hitting disk.
vi.mock('../../files/utils/files', () => ({
  isPathExists: vi.fn().mockResolvedValue(true),
  getProps: vi.fn().mockResolvedValue({ name: 'x.md', path: '.', isDir: false, size: 1, mtime: 1, ctime: 1 })
}))
import * as filesUtils from '../../files/utils/files'

// Build a minimal SpaceEnv-like object carrying just the fields the manager reads.
const makeSpace = (over: Partial<SpaceEnv> = {}): SpaceEnv =>
  ({ id: 0, url: '', inPersonalSpace: false, inSharesRepository: false, realPath: '/tmp/x', dbFile: { path: '.' }, ...over }) as unknown as SpaceEnv

describe(FavoritesManager.name, () => {
  let moduleRef: TestingModule
  let service: FavoritesManager
  let favoritesQueriesMock: { getFavoriteIdsForUser: Mock }
  let filesFavoritesManagerMock: { getFavorites: Mock }
  let filesFavoritesQueriesMock: { addFavorite: Mock; removeFavorite: Mock }
  let filesQueriesMock: { getOrCreateSpaceFile: Mock; getSpaceFileId: Mock }

  const user = { id: 1, isAdmin: false } as unknown as UserModel

  beforeEach(async () => {
    vi.mocked(filesUtils.isPathExists).mockResolvedValue(true)
    favoritesQueriesMock = { getFavoriteIdsForUser: vi.fn().mockResolvedValue([11, 22]) }
    filesFavoritesManagerMock = { getFavorites: vi.fn().mockResolvedValue([{ fileId: 9 }]) }
    filesFavoritesQueriesMock = { addFavorite: vi.fn().mockResolvedValue(undefined), removeFavorite: vi.fn().mockResolvedValue(undefined) }
    filesQueriesMock = {
      getOrCreateSpaceFile: vi.fn().mockResolvedValue(9),
      getSpaceFileId: vi.fn().mockResolvedValue(9)
    }

    moduleRef = await Test.createTestingModule({
      providers: [
        FavoritesManager,
        { provide: FavoritesQueries, useValue: favoritesQueriesMock },
        { provide: FilesFavoritesManager, useValue: filesFavoritesManagerMock },
        { provide: FilesFavoritesQueries, useValue: filesFavoritesQueriesMock },
        { provide: FilesQueries, useValue: filesQueriesMock }
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

  it('getFavorites delegates to upstream FilesFavoritesManager verbatim', async () => {
    await expect(service.getFavorites(user)).resolves.toEqual([{ fileId: 9 }])
    expect(filesFavoritesManagerMock.getFavorites).toHaveBeenCalledWith(user)
  })

  it('getFavoriteIds uses the fork-owned id query, not upstream list resolution', async () => {
    await expect(service.getFavoriteIds(user)).resolves.toEqual([11, 22])
    expect(favoritesQueriesMock.getFavoriteIdsForUser).toHaveBeenCalledWith(1)
    expect(filesFavoritesManagerMock.getFavorites).not.toHaveBeenCalled()
  })

  // The whole reason this bridge exists: NC PROPPATCH carries a path, not a file id.
  it('addFavorite resolves the path to a file id, materializing the row if needed', async () => {
    await service.addFavorite(user, makeSpace({ inPersonalSpace: true, url: 'files/personal/docs/x.md' }))
    expect(filesQueriesMock.getOrCreateSpaceFile).toHaveBeenCalled()
    expect(filesFavoritesQueriesMock.addFavorite).toHaveBeenCalledWith(1, 9)
  })

  it('removeFavorite resolves the path WITHOUT materializing a row', async () => {
    await service.removeFavorite(user, makeSpace({ url: 'files/personal/x.md' }))
    expect(filesQueriesMock.getSpaceFileId).toHaveBeenCalled()
    expect(filesQueriesMock.getOrCreateSpaceFile).not.toHaveBeenCalled()
    expect(filesFavoritesQueriesMock.removeFavorite).toHaveBeenCalledWith(1, 9)
  })

  it('removeFavorite 404s when the file has no row (nothing could have been favorited)', async () => {
    filesQueriesMock.getSpaceFileId.mockResolvedValue(undefined)
    await expect(service.removeFavorite(user, makeSpace())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    expect(filesFavoritesQueriesMock.removeFavorite).not.toHaveBeenCalled()
  })

  it('addFavorite 404s when the path is gone from disk', async () => {
    vi.mocked(filesUtils.isPathExists).mockResolvedValue(false)
    await expect(service.addFavorite(user, makeSpace())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    expect(filesFavoritesQueriesMock.addFavorite).not.toHaveBeenCalled()
  })
})
