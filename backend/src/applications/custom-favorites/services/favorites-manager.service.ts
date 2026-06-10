import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { FilesQueries } from '../../files/services/files-queries.service'
import { getProps, isPathExists } from '../../files/utils/files'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { UserModel } from '../../users/models/user.model'
import { FavoriteContext } from '../interfaces/favorite-context.interface'
import { FileFavorite } from '../interfaces/file-favorite.interface'
import { FavoritesQueries } from './favorites-queries.service'

const FAVORITES_LIMIT_DEFAULT = 100
const FAVORITES_LIMIT_MAX = 1000

@Injectable()
export class FavoritesManager {
  private readonly logger = new Logger(FavoritesManager.name)

  constructor(
    private readonly favoritesQueries: FavoritesQueries,
    private readonly filesQueries: FilesQueries,
    private readonly spacesQueries: SpacesQueries,
    private readonly sharesQueries: SharesQueries
  ) {}

  async getFavorites(user: UserModel, limit?: number): Promise<FileFavorite[]> {
    const [spaceIds, shareIds] = await Promise.all([this.spacesQueries.spaceIds(user.id), this.sharesQueries.shareIds(user.id, +user.isAdmin)])
    return this.favoritesQueries.getFavorites(user.id, spaceIds, shareIds, Math.min(limit ?? FAVORITES_LIMIT_DEFAULT, FAVORITES_LIMIT_MAX))
  }

  getFavoriteIds(user: UserModel): Promise<number[]> {
    return this.favoritesQueries.getFavoriteIdsForUser(user.id)
  }

  async addFavorite(user: UserModel, space: SpaceEnv): Promise<FileFavorite> {
    const fileId = await this.getOrCreateFileId(space)
    await this.favoritesQueries.addFavorite(user.id, fileId, this.favoriteContext(space))
    const fav = await this.favoritesQueries.getFavoriteForFile(user.id, fileId)
    if (!fav) throw new NotFoundException('Favorite not found after insert')
    return fav
  }

  // Capture the per-user access context at favorite-time. `space.url` is the
  // full repository path the user reached the file through (e.g.
  // `files/personal/x/y.md`, `shares/<alias>/x`) — stored verbatim as the nav
  // path. The space/share id lets the list re-check current access later.
  // In the shares repository, `space.id` is the share id. Mirrors the
  // location mapping in FilesRecents.
  private favoriteContext(space: SpaceEnv): FavoriteContext {
    if (space.inPersonalSpace) return { path: space.url, spaceId: null, shareId: null }
    if (space.inSharesRepository) return { path: space.url, spaceId: null, shareId: space.id }
    return { path: space.url, spaceId: space.id, shareId: null }
  }

  async removeFavorite(user: UserModel, space: SpaceEnv): Promise<void> {
    const fileId = await this.getFileId(space)
    if (fileId === undefined) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    return this.favoritesQueries.removeFavorite(user.id, fileId)
  }

  private async getOrCreateFileId(space: SpaceEnv): Promise<number> {
    if (!(await isPathExists(space.realPath))) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    // no client-supplied fileId — pass 0 to skip the fast-path lookup
    return this.filesQueries.getOrCreateSpaceFile(0, fileProps, space.dbFile)
  }

  private async getFileId(space: SpaceEnv): Promise<number | undefined> {
    if (!(await isPathExists(space.realPath))) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    return this.filesQueries.getSpaceFileId(fileProps, space.dbFile)
  }
}
