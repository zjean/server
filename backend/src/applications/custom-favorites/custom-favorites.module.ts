import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { SharesModule } from '../shares/shares.module'
import { SpacesModule } from '../spaces/spaces.module'
import { UsersModule } from '../users/users.module'
import { FavoritesController } from './controllers/favorites.controller'
import { FavoritesManager } from './services/favorites-manager.service'
import { FavoritesQueries } from './services/favorites-queries.service'

@Module({
  imports: [UsersModule, FilesModule, SpacesModule, SharesModule],
  controllers: [FavoritesController],
  providers: [FavoritesManager, FavoritesQueries]
})
export class CustomFavoritesModule {}
