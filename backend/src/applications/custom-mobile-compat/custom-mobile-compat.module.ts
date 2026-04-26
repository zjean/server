import { Module } from '@nestjs/common'
import { AUTH_PROVIDER } from '../../authentication/providers/auth-providers.constants'
import { AuthProviderOIDCModule } from '../../authentication/providers/oidc/auth-provider-oidc.module'
import { configuration } from '../../configuration/config.environment'
import { FilesModule } from '../files/files.module'
import { SpacesModule } from '../spaces/spaces.module'
import { UsersModule } from '../users/users.module'
import { WebDAVModule } from '../webdav/webdav.module'
import { NcDavController } from './controllers/nc-dav.controller'
import { NcDiscoveryController } from './controllers/nc-discovery.controller'
import { NcExtrasController } from './controllers/nc-extras.controller'
import { NcLoginV2Controller } from './controllers/nc-login-v2.controller'
import { NcMobileOidcController } from './controllers/nc-mobile-oidc.controller'
import { NcOcsController } from './controllers/nc-ocs.controller'
import { NcUploadsController } from './controllers/nc-uploads.controller'
import { NcBasicAuthGuard } from './guards/nc-basic-auth.guard'
import { NcChunkedUploadsService } from './services/nc-chunked-uploads.service'
import { NcLoginFlowService } from './services/nc-login-flow.service'
import { NcMobileOidcService } from './services/nc-mobile-oidc.service'
import { NcPathResolverService } from './services/nc-path-resolver.service'
import { NcPropfindService } from './services/nc-propfind.service'
import { NcResponseService } from './services/nc-response.service'
import { NcSyncLogService } from './services/nc-sync-log.service'

// Custom add-on module: exposes a Nextcloud-compatible subset of URLs so that
// stock Nextcloud iOS/Android clients can log in and sync against a Sync-in
// server. See docs/plans/2026-04-23-mobile-nextcloud-compat-design.md.
//
// When auth.provider === 'oidc', additionally mount the mobile OIDC delegation
// (browser hop → IdP → app-password handoff). See
// docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
const oidcEnabled = configuration.auth?.provider === AUTH_PROVIDER.OIDC

@Module({
  imports: [UsersModule, FilesModule, WebDAVModule, SpacesModule, ...(oidcEnabled ? [AuthProviderOIDCModule] : [])],
  controllers: [
    NcDiscoveryController,
    NcLoginV2Controller,
    NcOcsController,
    NcDavController,
    NcExtrasController,
    NcUploadsController,
    ...(oidcEnabled ? [NcMobileOidcController] : [])
  ],
  providers: [
    NcBasicAuthGuard,
    NcLoginFlowService,
    NcPathResolverService,
    NcResponseService,
    NcChunkedUploadsService,
    NcPropfindService,
    NcSyncLogService,
    ...(oidcEnabled ? [NcMobileOidcService] : [])
  ]
})
export class CustomMobileCompatModule {}
