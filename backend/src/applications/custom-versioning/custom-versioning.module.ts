import { Global, Module } from '@nestjs/common'
import { configuration } from '../../configuration/config.environment'
import { CustomSharedModule } from '../custom-shared/custom-shared.module'
import { FilesModule } from '../files/files.module'
import { EditorHistoryService } from './services/editor-history.service'
import { VersioningQueries } from './services/versioning-queries.service'
import { VersionsRetention } from './services/versions-retention.service'
import { VersioningController } from './versioning.controller'
import { VersioningService } from './services/versioning.service'
import { VersionsAdminService } from './services/versions-admin.service'
import { VersionsAdminController } from './versions-admin.controller'
import { VersionsOfficeController } from './versions-office.controller'

// Fork-owned file versioning. See docs/plans/2026-07-25-file-versioning-design.md.
//
// Everything is gated on `files.versions.enabled` INSIDE VersioningService, so
// the upstream hook sites are one-line calls that no-op while the flag is off.
//
// CustomSharedModule provides FileRowEnsurer: version rows key on files.id, but
// `files` rows are lazily materialized, so a snapshot has to be able to
// materialize one. FilesModule provides FilesQueries and FilesLockManager.
//
// @Global is what keeps the hooks cycle-free. The write-path hooks live in
// FilesManager and both editor managers, so those modules need
// VersioningService — but this module already imports FilesModule, and having
// FilesModule import it back would be a module-level cycle requiring
// forwardRef() (a pattern this repo does not otherwise use). Exporting
// globally, as UsersModule / CacheModule / DatabaseModule already do, breaks
// the cycle: the PROVIDER graph stays acyclic, because VersioningService
// depends only on FilesQueries and FilesLockManager, never on FilesManager.
// VersionsOfficeController authenticates the document server's server-to-server
// fetch with `@OnlyOfficeEnvironment()`, whose OnlyOfficeGuard is provided by
// OnlyOfficeModule — imported, and re-exported through FilesModule, ONLY when an
// office editor is enabled (files.module.ts:37-38). So the controller has to be
// mounted on the same condition, or a deployment with no office editor dies at
// boot with UnknownDependenciesException instead of simply not having a panel.
//
// The gate is spelled the same way FilesModule spells it, INCLUDING Euro-Office.
// #374 is the precedent for why that matters: two separately-written copies of
// this expression disagreed about Euro-Office, and a Euro-Office-only deployment
// died at boot.
const officeEditorEnabled = configuration.applications.files.editors.onlyoffice.enabled || configuration.applications.files.editors.eurooffice.enabled

@Global()
@Module({
  imports: [FilesModule, CustomSharedModule],
  // VersionsAdminController is separate from VersioningController because it is
  // authorized by role rather than by SpaceGuard; VersionsOfficeController is
  // separate because it is authorized by an OnlyOffice token rather than by a
  // browser session. Both headers explain why merging them would be unsafe.
  controllers: [VersioningController, VersionsAdminController, ...(officeEditorEnabled ? [VersionsOfficeController] : [])],
  providers: [VersioningService, VersioningQueries, VersionsRetention, VersionsAdminService, EditorHistoryService],
  exports: [VersioningService]
})
export class CustomVersioningModule {}
