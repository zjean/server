import { Injectable, Logger } from '@nestjs/common'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SPACE_ALIAS } from '../../spaces/constants/spaces'
import type { UserModel } from '../../users/models/user.model'
import { buildNcActivityEntry, type NcActivityEntry } from '../utils/nc-activity-entry'
import { NcSyncLogService } from './nc-sync-log.service'

// Backs /ocs/v2.php/apps/activity/api/v2/activity, reading the log
// NcSyncLogService already keeps for the RFC 6578 sync-collection REPORT.
//
// NO NEW STORAGE. `nc_sync_events` is already an append-only per-user record of
// create / update / delete with a path and a timestamp — that IS an activity
// feed, and it is already pruned by an existing cron. Adding a second table for
// the same facts would mean two things to keep in step.
//
// What the log does NOT carry, and the honest consequences:
//
//   - No actor. Rows are keyed on the file's OWNER (the viewer), not on who made
//     the change. For the personal-space scope this endpoint serves those are
//     the same person, so the entry names that one identity rather than guessing
//     (see buildNcActivityEntry).
//   - No fileId, only a path. So the per-file filter resolves fileId -> path
//     and matches on the path, rather than the other way round.
//   - A 30-day horizon. Events older than the prune window are gone, so a file
//     whose last change predates it has an empty feed. That is correct, not a
//     bug: the same horizon already governs what the sync REPORT can replay.
@Injectable()
export class NcActivityService {
  private readonly logger = new Logger(NcActivityService.name)

  constructor(
    private readonly syncLog: NcSyncLogService,
    private readonly filesQueries: FilesQueries
  ) {}

  // The user's recent activity across every space they own files in.
  async recent(user: UserModel, serverUrl: string, limit: number): Promise<NcActivityEntry[]> {
    const events = await this.syncLog.recent({ ownerId: user.id, limit })
    // fileId 0 for the unfiltered feed: the log carries no id, and resolving one
    // per row would be a query per entry for a field the client only uses when
    // it navigates from a rich object — which we do not emit.
    return events.map((e) => buildNcActivityEntry(e, user.login, 0, serverUrl))
  }

  // Activity for ONE file. Returns an empty list — never an error — for a file
  // the requester does not own or that has no logged events.
  //
  // Empty rather than 404 on purpose. The whole reason this endpoint exists is
  // that NC Android renders its file-detail list only when the activities call
  // parses; answering 404 for an unknown id would put us back in exactly the
  // failure this fixes for every file the log has not seen. An empty feed is
  // also the truthful answer: we know of no activity.
  async forFile(user: UserModel, fileId: number, serverUrl: string, limit: number): Promise<NcActivityEntry[]> {
    let row: { id: number; path: string } | null = null
    try {
      // Owner-scoped, so this is the authorization step as well as the lookup —
      // same constraint as nc-comments and the NC versions tree.
      row = await this.filesQueries.getUserFile(user.id, fileId)
    } catch (e) {
      this.logger.warn({ tag: this.forFile.name, msg: `file lookup failed for ${fileId}: ${(e as Error).message}` })
      return []
    }
    if (!row?.path) return []

    // getUserFile returns the space-relative path including the filename, with
    // no leading slash — the same shape the sync log stores (see
    // recentForPath's contract). Personal space only, matching the resolution.
    const events = await this.syncLog.recentForPath({
      ownerId: user.id,
      spaceAlias: SPACE_ALIAS.PERSONAL,
      path: row.path,
      limit
    })
    return events.map((e) => buildNcActivityEntry(e, user.login, fileId, serverUrl))
  }
}
