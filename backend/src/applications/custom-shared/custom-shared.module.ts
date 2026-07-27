import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { FileRowEnsurer } from './services/file-row-ensurer.service'

// Fork-owned helpers shared by more than one custom-* module.
//
// FileRowEnsurer lives here rather than in custom-versioning because
// custom-mobile-compat must not depend on custom-versioning: versioning is
// feature-flagged off by default, while mobile-compat needs a real
// `<oc:fileid>` unconditionally. See the versioning ADR §12.
@Module({
  // FilesModule exports FilesQueries, which FileRowEnsurer uses for the
  // get-or-create upsert helpers.
  imports: [FilesModule],
  providers: [FileRowEnsurer],
  exports: [FileRowEnsurer]
})
export class CustomSharedModule {}
