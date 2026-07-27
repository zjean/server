import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { eq } from 'drizzle-orm'
import fs from 'node:fs/promises'
import path from 'node:path'
import { configuration } from '../../../configuration/config.environment'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import type { FilesVersionsConfig } from '../../files/files.config'
import { isPathExists, removeFiles } from '../../files/utils/files'
import { spaces } from '../../spaces/schemas/spaces.schema'
import { users } from '../../users/schemas/users.schema'
import { VERSIONS_ROOT_SPACE_PREFIX, VERSIONS_ROOT_USER_PREFIX, VERSIONS_STAGING_DIR } from '../constants/versioning'
import { VersionRow } from '../interfaces/version.interface'
import { versionsPathFromRoot } from '../utils/paths'
import { VersioningQueries } from './versioning-queries.service'
import { VersioningService } from './versioning.service'

// Nightly retention and garbage collection for the versions store, modeled on
// FilesTrashRetention: one scheduled entry point, each rule isolated so a
// failure in one does not skip the rest.
//
// A blob is only removed once no version row in ITS OWN ROOT references it.
// Refcounts are per (checksum, versionsRoot) because blobs are physically per
// root — and, importantly, a file that has been moved to another space keeps
// resolving to the root recorded on its rows, so matching on the file's CURRENT
// space would delete a moved file's history as if it were orphaned (ADR §15).
@Injectable()
export class VersionsRetention {
  private readonly logger = new Logger(VersionsRetention.name)
  private readonly config: FilesVersionsConfig = configuration.applications.files.versions
  // Grace period before an unreferenced blob is swept. A snapshot writes the
  // blob before its row, so a blob that is briefly unreferenced may simply be
  // one whose insert has not landed yet.
  private readonly ORPHAN_GRACE_MS = 86_400_000 // one day
  private isRunning = false

  constructor(
    @Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema,
    private readonly queries: VersioningQueries,
    private readonly versioning: VersioningService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanVersions(): Promise<void> {
    if (!this.config.enabled) return
    if (this.isRunning) {
      this.logger.warn({ tag: this.cleanVersions.name, msg: 'previous run still in progress, skipping' })
      return
    }
    this.isRunning = true
    this.logger.log({ tag: this.cleanVersions.name, msg: 'START' })
    try {
      for (const versionsRoot of await this.queries.distinctRoots()) {
        // Each rule is independently guarded: a broken root must not stop the
        // sweep for every other root.
        await this.runRule('retentionDays', versionsRoot, () => this.enforceRetentionDays(versionsRoot))
        await this.runRule('trashExpired', versionsRoot, () => this.purgeTrashExpired(versionsRoot))
        await this.runRule('maxVersionsPerFile', versionsRoot, () => this.enforceMaxVersionsPerFile(versionsRoot))
        await this.runRule('quotaShare', versionsRoot, () => this.enforceQuotaShare(versionsRoot))
        await this.runRule('danglingRows', versionsRoot, () => this.collectDanglingRows())
        await this.runRule('orphanBlobs', versionsRoot, () => this.collectOrphanBlobs(versionsRoot))
      }
    } finally {
      this.isRunning = false
      this.logger.log({ tag: this.cleanVersions.name, msg: 'END' })
    }
  }

  private async runRule(name: string, versionsRoot: string, run: () => Promise<number>): Promise<void> {
    try {
      const n = await run()
      if (n > 0) this.logger.log({ tag: this.cleanVersions.name, msg: `${versionsRoot} ${name}: ${n} removed` })
    } catch (e) {
      this.logger.error({ tag: this.cleanVersions.name, msg: `${versionsRoot} ${name} failed: ${e}` })
    }
  }

  /* ------------------------------------------------------------------- rules */

  // Age-based expiry, with the users/spaces split the trash retention config
  // uses. Labeled versions are exempt — a named revision is never auto-expired.
  private async enforceRetentionDays(versionsRoot: string): Promise<number> {
    const days = this.retentionDaysFor(versionsRoot)
    if (!days) return 0
    const cutoff = new Date(Date.now() - days * 86_400_000)
    return this.dropAll(await this.queries.unlabeledOlderThan(versionsRoot, cutoff))
  }

  // The rule ADR §10 was corrected to require: a file in the trash whose disk
  // copy trash retention has already removed keeps its `files` row (retention
  // never touches that table) and our version rows keep that row alive against
  // the orphan sweep — so nothing would ever reclaim this space on its own.
  //
  // Reuses the TRASH retention window, because the intent is "the file itself
  // is gone for good; its history should follow".
  private async purgeTrashExpired(versionsRoot: string): Promise<number> {
    const days = this.trashRetentionDaysFor(versionsRoot)
    if (!days) return 0
    const cutoff = new Date(Date.now() - days * 86_400_000)
    return this.dropAll(await this.queries.unlabeledInTrashOlderThan(versionsRoot, cutoff))
  }

  // Keep at most maxVersionsPerFile per file, dropping oldest unlabeled first.
  // Labeled versions are kept AND counted, so a file with more labels than the
  // cap simply keeps them all.
  private async enforceMaxVersionsPerFile(versionsRoot: string): Promise<number> {
    const keep = this.config.maxVersionsPerFile
    if (!keep) return 0
    let removed = 0
    for (const fileId of await this.queries.fileIdsExceeding(versionsRoot, keep)) {
      const total = await this.queries.countByFileId(fileId)
      const excess = total - keep
      if (excess <= 0) continue
      const candidates = (await this.queries.unlabeledByFileIdOldestFirst(fileId)).filter((r) => r.versionsRoot === versionsRoot)
      removed += await this.dropAll(candidates.slice(0, excess))
    }
    return removed
  }

  // Backstop for the eager cap in VersioningService: the eager path only runs
  // on write, so a root can sit over the ceiling indefinitely if nobody saves.
  private async enforceQuotaShare(versionsRoot: string): Promise<number> {
    const share = this.config.quotaShare
    if (!share) return 0
    const quota = await this.rootQuota(versionsRoot)
    if (!quota) return 0
    const ceiling = quota * share

    let { used } = await this.queries.usageByRoot(versionsRoot)
    let removed = 0
    while (used > ceiling) {
      const victim = await this.queries.oldestUnlabeledByRoot(versionsRoot)
      if (!victim) return removed // only labeled versions left; keep them
      await this.versioning.dropVersionForRetention(victim)
      used -= victim.size
      removed++
    }
    return removed
  }

  // Version rows whose `files` row is genuinely gone. With the FK's ON DELETE
  // CASCADE this should be unreachable, so anything found here means a delete
  // path bypassed both the explicit purge and the cascade — worth logging as a
  // warning rather than sweeping silently.
  private async collectDanglingRows(): Promise<number> {
    const rows = await this.queries.danglingRows()
    if (!rows.length) return 0
    this.logger.warn({ tag: this.collectDanglingRows.name, msg: `${rows.length} version rows had no files row` })
    return this.dropAll(rows)
  }

  // Blobs on disk that no row references, plus staging debris from a crashed
  // snapshot. The grace period matters: a snapshot writes the blob before the
  // row, so a just-written blob is legitimately unreferenced for a moment.
  private async collectOrphanBlobs(versionsRoot: string): Promise<number> {
    const versionsPath = versionsPathFromRoot(versionsRoot)
    if (!versionsPath || !(await isPathExists(versionsPath))) return 0
    const now = Date.now()
    let removed = 0

    for (const shard of await fs.readdir(versionsPath, { withFileTypes: true }).catch(() => [])) {
      const shardPath = path.join(versionsPath, shard.name)
      if (!shard.isDirectory()) continue

      if (shard.name === VERSIONS_STAGING_DIR) {
        // Staging debris is never referenced by anything; age is the only test.
        for (const stale of await fs.readdir(shardPath, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(shardPath, stale.name)
          const stats = await fs.stat(p).catch(() => null)
          if (stats && now - stats.mtimeMs > this.ORPHAN_GRACE_MS) {
            await removeFiles(p).catch(() => undefined)
            removed++
          }
        }
        continue
      }

      for (const blob of await fs.readdir(shardPath, { withFileTypes: true }).catch(() => [])) {
        if (!blob.isFile()) continue
        const blobPath = path.join(shardPath, blob.name)
        const stats = await fs.stat(blobPath).catch(() => null)
        if (!stats || now - stats.mtimeMs <= this.ORPHAN_GRACE_MS) continue
        // Refcount within THIS root only — see the class comment.
        if ((await this.queries.countByBlob(blob.name, versionsRoot)) > 0) continue
        await removeFiles(blobPath).catch(() => undefined)
        removed++
      }
    }
    return removed
  }

  /* ------------------------------------------------------------------ shared */

  private async dropAll(rows: VersionRow[]): Promise<number> {
    for (const row of rows) {
      await this.versioning.dropVersionForRetention(row)
    }
    return rows.length
  }

  private retentionDaysFor(versionsRoot: string): number | false {
    const retention = this.config.retentionDays
    return versionsRoot.startsWith(VERSIONS_ROOT_USER_PREFIX) ? retention.users : retention.spaces
  }

  private trashRetentionDaysFor(versionsRoot: string): number | false {
    const trash = configuration.applications.files.trashRetention
    return versionsRoot.startsWith(VERSIONS_ROOT_USER_PREFIX) ? trash.users : trash.spaces
  }

  // The quota of the thing the root belongs to — not of whatever space a caller
  // happened to be in. Same scope-matching rule the eager cap follows (ADR §7).
  private async rootQuota(versionsRoot: string): Promise<number | null> {
    if (versionsRoot.startsWith(VERSIONS_ROOT_USER_PREFIX)) {
      const login = versionsRoot.slice(VERSIONS_ROOT_USER_PREFIX.length)
      const [row] = await this.db.select({ quota: users.storageQuota }).from(users).where(eq(users.login, login)).limit(1)
      return row?.quota || null
    }
    if (versionsRoot.startsWith(VERSIONS_ROOT_SPACE_PREFIX)) {
      const alias = versionsRoot.slice(VERSIONS_ROOT_SPACE_PREFIX.length)
      const [row] = await this.db.select({ quota: spaces.storageQuota }).from(spaces).where(eq(spaces.alias, alias)).limit(1)
      return row?.quota || null
    }
    return null
  }
}
