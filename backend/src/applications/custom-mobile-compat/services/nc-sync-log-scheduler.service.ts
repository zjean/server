import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { NcSyncLogService } from './nc-sync-log.service'

// Daily cron that drops sync-log events older than the retention horizon.
// Without this, `nc_sync_events` grows unbounded and `minKeptToken()` never
// rises off the genesis event id, so the 412-Precondition-Failed trigger in
// NcSyncReportService.respond effectively never fires — clients with very
// old tokens silently get partial truth instead of a forced full re-sync.
//
// Runs at 03:15 daily (separate hour from other application schedulers so
// the DB doesn't see all daily prunes at once).
@Injectable()
export class NcSyncLogScheduler {
  private readonly logger = new Logger(NcSyncLogScheduler.name)

  constructor(private readonly ncSyncLog: NcSyncLogService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduledPrune(): Promise<void> {
    this.logger.log({ tag: this.runScheduledPrune.name, msg: `START` })
    try {
      const removed = await this.ncSyncLog.prune()
      this.logger.log({ tag: this.runScheduledPrune.name, msg: `DONE removed=${removed}` })
    } catch (e) {
      this.logger.error({ tag: this.runScheduledPrune.name, msg: `${e}` })
    }
  }
}
