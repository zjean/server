import { Module } from '@nestjs/common'
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
@Module({
  imports: [FilesModule, CustomSharedModule],
  providers: [VersioningService, VersioningQueries],
  exports: [VersioningService]
})
export class CustomVersioningModule {}
