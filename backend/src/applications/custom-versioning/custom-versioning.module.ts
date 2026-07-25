import { Global, Module } from '@nestjs/common'
import { CustomSharedModule } from '../custom-shared/custom-shared.module'
import { FilesModule } from '../files/files.module'
import { VersioningQueries } from './services/versioning-queries.service'
import { VersioningService } from './services/versioning.service'

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
@Global()
@Module({
  imports: [FilesModule, CustomSharedModule],
  providers: [VersioningService, VersioningQueries],
  exports: [VersioningService]
})
export class CustomVersioningModule {}
