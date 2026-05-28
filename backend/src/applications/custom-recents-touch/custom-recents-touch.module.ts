import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { RecentsTouchService } from './services/recents-touch.service'

// Pure-add fork module. Subscribes to FileEvent and upserts files_recents on
// ADD/UPDATE so v2's Recents screen reflects edits without requiring the user
// to re-browse the parent folder. See services/recents-touch.service.ts for
// the rationale.
@Module({
  imports: [FilesModule],
  providers: [RecentsTouchService]
})
export class CustomRecentsTouchModule {}
