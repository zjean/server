import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { UsersModule } from '../users/users.module'
import { WebDAVModule } from '../webdav/webdav.module'
import { NcDavController } from './controllers/nc-dav.controller'
import { NcDiscoveryController } from './controllers/nc-discovery.controller'
import { NcLoginV2Controller } from './controllers/nc-login-v2.controller'
import { NcOcsController } from './controllers/nc-ocs.controller'
import { NcBasicAuthGuard } from './guards/nc-basic-auth.guard'
import { NcChunkedUploadsService } from './services/nc-chunked-uploads.service'
import { NcLoginFlowService } from './services/nc-login-flow.service'
import { NcPathResolverService } from './services/nc-path-resolver.service'
import { NcResponseService } from './services/nc-response.service'

// Custom add-on module: exposes a Nextcloud-compatible subset of URLs so that
// stock Nextcloud iOS/Android clients can log in and sync against a Sync-in
// server. See docs/plans/2026-04-23-mobile-nextcloud-compat-design.md for the
// full design + decisions log.
@Module({
  imports: [UsersModule, FilesModule, WebDAVModule],
  controllers: [NcDiscoveryController, NcLoginV2Controller, NcOcsController, NcDavController],
  providers: [NcBasicAuthGuard, NcLoginFlowService, NcPathResolverService, NcResponseService, NcChunkedUploadsService]
})
export class CustomMobileCompatModule {}
