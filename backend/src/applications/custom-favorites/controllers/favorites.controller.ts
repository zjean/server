import { Controller, Delete, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { SkipSpaceGuard } from '../../spaces/decorators/space-skip-guard.decorator'
import { SkipSpacePermissionsCheck } from '../../spaces/decorators/space-skip-permissions.decorator'
import { GetSpace } from '../../spaces/decorators/space.decorator'
import { SpaceGuard } from '../../spaces/guards/space.guard'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { GetUser } from '../../users/decorators/user.decorator'
import type { UserModel } from '../../users/models/user.model'
import { CUSTOM_FAVORITES_ROUTE } from '../constants/routes'
import type { FileFavorite } from '../interfaces/file-favorite.interface'
import { FavoritesManager } from '../services/favorites-manager.service'

@Controller(CUSTOM_FAVORITES_ROUTE.BASE)
@SkipSpacePermissionsCheck()
@UseGuards(SpaceGuard)
export class FavoritesController {
  constructor(private readonly favoritesManager: FavoritesManager) {}

  @Get()
  @SkipSpaceGuard()
  getFavorites(@GetUser() user: UserModel, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number): Promise<FileFavorite[]> {
    return this.favoritesManager.getFavorites(user, limit)
  }

  @Get(CUSTOM_FAVORITES_ROUTE.IDS)
  @SkipSpaceGuard()
  getFavoriteIds(@GetUser() user: UserModel): Promise<number[]> {
    return this.favoritesManager.getFavoriteIds(user)
  }

  @Post(`${CUSTOM_FAVORITES_ROUTE.SPACES}/*`)
  addFavorite(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<FileFavorite> {
    return this.favoritesManager.addFavorite(user, space)
  }

  @Delete(`${CUSTOM_FAVORITES_ROUTE.SPACES}/*`)
  removeFavorite(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<void> {
    return this.favoritesManager.removeFavorite(user, space)
  }
}
