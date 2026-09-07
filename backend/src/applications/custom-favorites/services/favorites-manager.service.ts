import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import type { FileFavorite } from '../../files/schemas/file-favorite.interface'
import { FilesFavoritesManager } from '../../files/services/files-favorites-manager.service'
import { FilesFavoritesQueries } from '../../files/services/files-favorites-queries.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { getProps, isPathExists } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { FavoritesQueries } from './favorites-queries.service'
import { NO_CLIENT_FILE_ID } from '../../custom-shared/constants/file-ids'

// NC mobile bridge over upstream's favorites (upstream shipped the feature in 2.5.0,
// commit d3724ec5 — the fork's own table and controller are gone; see
// docs/plans/2026-09-07-favorites-upstream-adoption-plan.md).
//
// This exists ONLY because custom-mobile-compat cannot call upstream's manager:
//
//   - NC PROPPATCH <oc:favorite> carries a PATH and no file id, while upstream's
//     addFavorite(user, space, fileId) requires a client-supplied id. The path→id
//     resolution below is what closes that gap.
//   - NC PROPFIND needs a cheap id Set per listing; upstream has no such query.
//     See FavoritesQueries for why its list method is not a substitute.
//
// Everything else delegates, so the NC surface and the v2 UI cannot drift apart.
@Injectable()
export class FavoritesManager {
  constructor(
    private readonly favoritesQueries: FavoritesQueries,
    private readonly filesFavoritesManager: FilesFavoritesManager,
    private readonly filesFavoritesQueries: FilesFavoritesQueries,
    private readonly filesQueries: FilesQueries
  ) {}

  // Delegated verbatim. Rows the user can no longer reach come back with
  // isDisabled: true and a raw owner-relative `path` — callers must skip those
  // rather than treat `path` as addressable.
  getFavorites(user: UserModel): Promise<FileFavorite[]> {
    return this.filesFavoritesManager.getFavorites(user)
  }

  getFavoriteIds(user: UserModel): Promise<number[]> {
    return this.favoritesQueries.getFavoriteIdsForUser(user.id)
  }

  async addFavorite(user: UserModel, space: SpaceEnv): Promise<void> {
    const fileId = await this.getOrCreateFileId(space)
    return this.filesFavoritesQueries.addFavorite(user.id, fileId)
  }

  async removeFavorite(user: UserModel, space: SpaceEnv): Promise<void> {
    const fileId = await this.getFileId(space)
    if (fileId === undefined) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    return this.filesFavoritesQueries.removeFavorite(user.id, fileId)
  }

  private async getOrCreateFileId(space: SpaceEnv): Promise<number> {
    if (!(await isPathExists(space.realPath))) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    // No client-supplied fileId — a NEGATIVE sentinel skips the lookup-by-id
    // branch; 0 is rejected by upstream's assertValidFileId.
    return this.filesQueries.getOrCreateSpaceFile(NO_CLIENT_FILE_ID, fileProps, space.dbFile)
  }

  private async getFileId(space: SpaceEnv): Promise<number | undefined> {
    if (!(await isPathExists(space.realPath))) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    return this.filesQueries.getSpaceFileId(fileProps, space.dbFile)
  }
}
