import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { FavoritesManager } from './services/favorites-manager.service'
import { FavoritesQueries } from './services/favorites-queries.service'

@Module({
  imports: [FilesModule],
  providers: [FavoritesManager, FavoritesQueries],
  // No controller: upstream's FilesController owns /api/files/favorites since 2.5.0.
  // FavoritesManager is exported purely as the NC mobile bridge for
  // custom-mobile-compat (PROPFIND star, PROPPATCH toggle, REPORT listing).
  exports: [FavoritesManager]
})
export class CustomFavoritesModule {}
