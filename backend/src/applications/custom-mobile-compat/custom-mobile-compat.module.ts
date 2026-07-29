import { Module } from '@nestjs/common'
import { AUTH_PROVIDER } from '../../authentication/providers/auth-providers.constants'
import { AuthProviderOIDCModule } from '../../authentication/providers/oidc/auth-provider-oidc.module'
import { CommentsModule } from '../comments/comments.module'
import { CustomFavoritesModule } from '../custom-favorites/custom-favorites.module'
import { CustomSharedModule } from '../custom-shared/custom-shared.module'
import { configuration } from '../../configuration/config.environment'
import { FilesModule } from '../files/files.module'
import { SharesModule } from '../shares/shares.module'
import { SpacesModule } from '../spaces/spaces.module'
import { UsersModule } from '../users/users.module'
import { WebDAVModule } from '../webdav/webdav.module'
import { NcActivityController } from './controllers/nc-activity.controller'
import { NcCommentsController } from './controllers/nc-comments.controller'
import { NcDavController } from './controllers/nc-dav.controller'
import { NcDirectEditingController } from './controllers/nc-direct-editing.controller'
import { NcDiscoveryController } from './controllers/nc-discovery.controller'
import { NcExtrasController } from './controllers/nc-extras.controller'
import { NcLoginV2Controller } from './controllers/nc-login-v2.controller'
import { NcMobileOidcController } from './controllers/nc-mobile-oidc.controller'
import { NcOcsController } from './controllers/nc-ocs.controller'
import { NcOcsSharesController } from './controllers/nc-ocs-shares.controller'
import { NcOnlyOfficeCallbackController, NcOnlyOfficeController } from './controllers/nc-onlyoffice.controller'
import { NcRecommendationsController } from './controllers/nc-recommendations.controller'
import { NcTextEditorController } from './controllers/nc-text-editor.controller'
import { NcThemingController } from './controllers/nc-theming.controller'
import { NcSearchService } from './services/nc-search.service'
import { NcUploadsController } from './controllers/nc-uploads.controller'
import { NcVersionsController } from './controllers/nc-versions.controller'
import { NcVersionsService } from './services/nc-versions.service'
import { NcBasicAuthGuard } from './guards/nc-basic-auth.guard'
import { NcActivityService } from './services/nc-activity.service'
import { NcAppPasswordService } from './services/nc-app-password.service'
import { NcChunkedUploadsService } from './services/nc-chunked-uploads.service'
import { NcDirectEditingService } from './services/nc-direct-editing.service'
import { NcFavoritesReportService } from './services/nc-favorites-report.service'
import { NcFileRowEnsurer } from './services/nc-file-row-ensurer.service'
import { NcLoginFlowService } from './services/nc-login-flow.service'
import { NcMobileOidcService } from './services/nc-mobile-oidc.service'
import { NcOnlyOfficeFileResolver } from './services/nc-onlyoffice-file-resolver.service'
import { NcOnlyOfficeForceSaveService } from './services/nc-onlyoffice-force-save.service'
import { NcOnlyOfficeTranslatorService } from './services/nc-onlyoffice-translator.service'
import { NcPathResolverService } from './services/nc-path-resolver.service'
import { NcPropfindService } from './services/nc-propfind.service'
import { NcResponseService } from './services/nc-response.service'
import { NcShareMountResolverService } from './services/nc-share-mount-resolver.service'
import { NcSyncLogScheduler } from './services/nc-sync-log-scheduler.service'
import { NcSyncLogService } from './services/nc-sync-log.service'
import { NcSyncReportService } from './services/nc-sync-report.service'

// Custom add-on module: exposes a Nextcloud-compatible subset of URLs so that
// stock Nextcloud iOS/Android clients can log in and sync against a Sync-in
// server. See docs/plans/2026-04-23-mobile-nextcloud-compat-design.md.
//
// When auth.provider === 'oidc', additionally mount the mobile OIDC delegation
// (browser hop → IdP → app-password handoff). See
// docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
const oidcEnabled = configuration.auth?.provider === AUTH_PROVIDER.OIDC
// Mounted when an OnlyOffice-protocol document server is enabled — either
// OnlyOffice or Euro-Office. FilesModule re-exports OnlyOfficeModule on the
// exact same either-or condition (its `officeConnectorEnabled`), so requiring DI
// on deployments with neither would fail at boot.
//
// That claim was ASPIRATIONAL until #374, not descriptive: files.module.ts wrote
// the condition twice and its `exports` copy omitted the Euro-Office half, so
// widening this gate in #360 made every Euro-Office-only deployment die at boot.
// The two sides now share one binding. If this gate is ever widened again,
// check that FilesModule actually exports what the new configuration needs —
// a comment asserting an invariant is not the same as the invariant holding.
//
// Euro-Office is an OnlyOffice-protocol server, not a second protocol: Sync-in
// types its config as `OnlyOfficeConfig` and OnlyOfficeManager already selects
// it when onlyoffice is disabled (only-office-manager.service.ts:82-85). So the
// same connector controllers serve both, and the client-facing route prefix
// stays /index.php/apps/onlyoffice/* — that prefix is the upstream NC app id,
// not an editor brand. See constants/routes.ts for the citation.
const officeEditorEnabled =
  configuration.applications.files.editors.onlyoffice?.enabled === true || configuration.applications.files.editors.eurooffice?.enabled === true

@Module({
  // FilesModule exports FilesQueries (used by NcSyncReportService for DB id
  // resolution); SpacesModule provides spaces-aware helpers used elsewhere
  // in this module.
  // CommentsModule re-exports CommentsQueries for the NC iOS Comments tab —
  // mapped onto the existing comments storage by NcCommentsController, no
  // schema or domain changes.
  // CustomFavoritesModule exports FavoritesManager — reused by NcPropfindService,
  // NcSyncReportService, and NcFavoritesReportService to surface per-user
  // favorites to the stock NC clients (star / toggle / Favorites tab).
  // CustomSharedModule exports FileRowEnsurer — the lookup-then-insert core
  // NcFileRowEnsurer wraps, shared with custom-versioning.
  //
  // CustomVersioningModule is deliberately NOT imported. It is @Global and
  // exports VersioningService, which is how FilesManager and both editor
  // managers already reach it, and how NcVersionsService reaches it here. That
  // keeps this module's import list free of the versioning module (ADR §12) —
  // mobile-compat needs FileRowEnsurer unconditionally, and it must keep
  // getting it from custom-shared whether versioning is on or off.
  imports: [
    UsersModule,
    FilesModule,
    WebDAVModule,
    SpacesModule,
    SharesModule,
    CommentsModule,
    CustomFavoritesModule,
    CustomSharedModule,
    ...(oidcEnabled ? [AuthProviderOIDCModule] : [])
  ],
  controllers: [
    NcDiscoveryController,
    NcLoginV2Controller,
    NcOcsController,
    NcOcsSharesController,
    NcDavController,
    NcExtrasController,
    NcCommentsController,
    // The OCS activity feed. Not advertised in capabilities — it exists because
    // NC Android renders its file-detail list (versions included) only when the
    // activities call returns a parseable OCS body. See the controller.
    NcActivityController,
    NcDirectEditingController,
    NcRecommendationsController,
    NcTextEditorController,
    NcThemingController,
    NcUploadsController,
    // The NC file-versions DAV tree. Every handler 404s while
    // files.versions.enabled is false, and the matching OCS capability is
    // absent in the same state — so the route is mounted unconditionally and
    // the flag is read at request time, in one place.
    NcVersionsController,
    ...(oidcEnabled ? [NcMobileOidcController] : []),
    ...(officeEditorEnabled ? [NcOnlyOfficeController, NcOnlyOfficeCallbackController] : [])
  ],
  providers: [
    NcBasicAuthGuard,
    NcAppPasswordService,
    NcActivityService,
    NcLoginFlowService,
    NcPathResolverService,
    NcShareMountResolverService,
    NcResponseService,
    NcChunkedUploadsService,
    NcDirectEditingService,
    NcFavoritesReportService,
    NcFileRowEnsurer,
    NcPropfindService,
    NcSearchService,
    NcSyncLogScheduler,
    NcSyncLogService,
    NcSyncReportService,
    NcVersionsService,
    ...(oidcEnabled ? [NcMobileOidcService] : []),
    ...(officeEditorEnabled ? [NcOnlyOfficeTranslatorService, NcOnlyOfficeFileResolver, NcOnlyOfficeForceSaveService] : [])
  ]
})
export class CustomMobileCompatModule {}
