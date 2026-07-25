import { Global, Module } from '@nestjs/common'
import { AdminModule } from './admin/admin.module'
import { CommentsModule } from './comments/comments.module'
import { CustomMobileCompatModule } from './custom-mobile-compat/custom-mobile-compat.module'
import { CustomFeaturesModule } from './custom-features/custom-features.module'
import { CustomFavoritesModule } from './custom-favorites/custom-favorites.module'
import { CustomVersioningModule } from './custom-versioning/custom-versioning.module'
import { FilesModule } from './files/files.module'
import { NotificationsModule } from './notifications/notifications.module'
import { SharesModule } from './shares/shares.module'
import { SpacesModule } from './spaces/spaces.module'
import { SyncModule } from './sync/sync.module'
import { UsersModule } from './users/users.module'
import { WebDAVModule } from './webdav/webdav.module'

@Global()
@Module({
  imports: [
    UsersModule,
    SpacesModule,
    SharesModule,
    FilesModule,
    WebDAVModule,
    AdminModule,
    CommentsModule,
    NotificationsModule,
    SyncModule,
    CustomMobileCompatModule,
    CustomFeaturesModule,
    CustomFavoritesModule,
    CustomVersioningModule
  ],
  exports: [UsersModule, SpacesModule, SharesModule, FilesModule, WebDAVModule, CommentsModule, NotificationsModule]
})
export class ApplicationsModule {}
