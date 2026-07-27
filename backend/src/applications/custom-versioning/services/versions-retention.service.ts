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
import { spaceVersionsRoot, userVersionsRoot, versionsPathFromRoot } from '../utils/paths'
import { VersioningQueries } from './versioning-queries.service'
import { VersioningService } from './versioning.service'

// Nightly retention and garbage collection for the versions store, modeled on
// FilesTrashRetention: one scheduled entry point, each rule isolated so a
// failure in one does not skip the rest.
//
// NO TRASH-AGE RULE, DELIBERATELY. An earlier revision reclaimed versions of
// files sitting in the trash once the version was older than the trash retention
// window. That was wrong and destroyed restorable history: a version's
// `createdAt` is when the file was OVERWRITTEN, which says nothing about when it
// was trashed, and there is no trashed-at timestamp anywhere addressable by
// `files.id` (the `files` row carries only `inTrash`; the trash sweeper's own
// `deletedAt` lives in per-root, inode-keyed tables). So a file last edited two
// months ago lost its whole history on the first sweep after being trashed,
// while remaining restorable for the full window — directly contradicting ADR
// §10's "restored from trash -> versions still attached".
//
// The accepted consequence is a bounded leak: history of a file whose trash
// entry expired on disk survives until that entry is permanently deleted, at
// which point FilesManager.delete's purge reclaims it properly. `retentionDays`
// and `quotaShare` still bound total growth in the meantime. A documented leak
// beats undocumented data loss; re-adding the rule requires first adding a real
// trashed-at timestamp.
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
  // Matches FilesTrashRetention.fileBatchSize on purpose.
  private readonly batchSize = 1000
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
      // Row rules, per root that actually holds versions.
      for (const versionsRoot of await this.queries.distinctRoots()) {
        // Each rule is independently guarded: a broken root must not stop the
        // sweep for every other root.
        await this.runRule('retentionDays', versionsRoot, () => this.enforceRetentionDays(versionsRoot))
        await this.runRule('maxVersionsPerFile', versionsRoot, () => this.enforceMaxVersionsPerFile(versionsRoot))
        await this.runRule('quotaShare', versionsRoot, () => this.enforceQuotaShare(versionsRoot))
      }
      // Filesystem rules need a DIFFERENT root list. distinctRoots() reads the
      // versions table, so a root holding blobs but NO rows — precisely the
      // state in which bytes are guaranteed to be orphaned, e.g. every version
      // of a file was purged, or a crash left staging debris — would never be
      // visited and would leak forever. These enumerate the disk instead.
      for (const versionsRoot of await this.rootsOnDisk()) {
        await this.runRule('orphanBlobs', versionsRoot, () => this.collectOrphanBlobs(versionsRoot))
      }
      // Global, not per root: the query has no root filter, so running it inside
      // the loop meant N identical full anti-joins per night and a count
      // attributed to whichever root happened to be first.
      await this.runRule('danglingRows', null, () => this.collectDanglingRows())
    } finally {
      this.isRunning = false
      this.logger.log({ tag: this.cleanVersions.name, msg: 'END' })
    }
  }

  // `versionsRoot` is null for rules that are global rather than per root, so
  // their log lines do not attribute a system-wide count to one root.
  private async runRule(name: string, versionsRoot: string | null, run: () => Promise<number>): Promise<void> {
    const scope = versionsRoot ? `${versionsRoot} ` : ''
    try {
      const n = await run()
      if (n > 0) this.logger.log({ tag: this.cleanVersions.name, msg: `${scope}${name}: ${n} removed` })
    } catch (e) {
      this.logger.error({ tag: this.cleanVersions.name, msg: `${scope}${name} failed: ${e}` })
    }
  }

  /* ------------------------------------------------------------------- rules */

  // Age-based expiry, with the users/spaces split the trash retention config
  // uses. Labeled versions are exempt — a named revision is never auto-expired.
  //
  // This also covers trashed files: it filters on age alone, not on trash state,
  // so an old version is reclaimed whether or not its file is currently in the
  // trash. That matters because the trash-specific rule this class used to carry
  // was WRONG and has been removed — see the class comment.
  private async enforceRetentionDays(versionsRoot: string): Promise<number> {
    const days = this.retentionDaysFor(versionsRoot)
    if (!days) return 0
    const cutoff = new Date(Date.now() - days * 86_400_000)
    let removed = 0
    // Paged: the first run after enabling retention on a populated install can
    // match a very large number of rows, each costing a DELETE, a refcount COUNT
    // and possibly an unlink.
    for (;;) {
      const page = await this.queries.unlabeledOlderThan(versionsRoot, cutoff, this.batchSize)
      removed += await this.dropAll(page, 'retentionDays')
      if (page.length < this.batchSize) return removed
    }
  }

  // Keep at most maxVersionsPerFile per file IN THIS ROOT, dropping oldest
  // unlabeled first. Labeled versions are kept AND counted, so a file with more
  // labels than the cap simply keeps them all.
  //
  // Gate, count and candidate list are all per root. They used to disagree — a
  // per-root gate, a global count, and a global candidate list filtered down —
  // which for a file whose versions span two roots (moved between spaces)
  // over-deleted in one root and under-enforced in the other.
  private async enforceMaxVersionsPerFile(versionsRoot: string): Promise<number> {
    const keep = this.config.maxVersionsPerFile
    if (!keep) return 0
    let removed = 0
    for (const { fileId, count } of await this.queries.fileIdsExceeding(versionsRoot, keep)) {
      const excess = count - keep
      if (excess <= 0) continue
      const candidates = await this.queries.unlabeledByFileIdOldestFirst(versionsRoot, fileId, excess)
      removed += await this.dropAll(candidates, 'maxVersionsPerFile')
    }
    return removed
  }

  // Backstop for the eager cap in VersioningService: the eager path only runs on
  // write, so a root can sit over the ceiling indefinitely if nobody saves.
  //
  // The eviction itself lives in VersioningService because the decision of WHEN
  // eviction is allowed — never, if labeled bytes alone exceed the ceiling —
  // must exist in exactly one place. Duplicating it is what produced the same
  // data-loss bug on both paths.
  private async enforceQuotaShare(versionsRoot: string): Promise<number> {
    const share = this.config.quotaShare
    if (!share) return 0
    const quota = await this.rootQuota(versionsRoot)
    if (!quota) return 0
    return this.versioning.evictUntilUnderCeiling(versionsRoot, quota * share)
  }

  // Version rows whose `files` row is genuinely gone. With the FK's ON DELETE
  // CASCADE this should be unreachable, so anything found here means a delete
  // path bypassed both the explicit purge and the cascade — worth logging as a
  // warning rather than sweeping silently.
  private async collectDanglingRows(): Promise<number> {
    const rows = await this.queries.danglingRows()
    if (!rows.length) return 0
    this.logger.warn({ tag: this.collectDanglingRows.name, msg: `${rows.length} version rows had no files row` })
    return this.dropAll(rows, 'danglingRows')
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

  // Logs one line per deletion at `log` level. ADR §7 sets the standard —
  // "silently deleting a user's history deserves an audit trail" — and an
  // aggregate count cannot answer "which version of which file went, and why",
  // which is the only question that matters when a user asks where their
  // history went.
  private async dropAll(rows: VersionRow[], rule: string): Promise<number> {
    for (const row of rows) {
      await this.versioning.dropVersionForRetention(row)
      this.logger.log({
        tag: this.cleanVersions.name,
        msg: `${rule}: removed version ${row.id} of file ${row.fileId} (${row.size} bytes) from ${row.versionsRoot}`
      })
    }
    return rows.length
  }

  // Roots that have a versions directory ON DISK, regardless of whether any row
  // still points into it. Enumerated from the filesystem rather than from users
  // and spaces tables so it also covers a deleted user's leftover tree.
  private async rootsOnDisk(): Promise<string[]> {
    const roots: string[] = []
    const sources: [string, (name: string) => string][] = [
      [configuration.applications.files.usersPath, userVersionsRoot],
      [configuration.applications.files.spacesPath, spaceVersionsRoot]
    ]
    for (const [basePath, toRoot] of sources) {
      for (const entry of await fs.readdir(basePath, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        const root = toRoot(entry.name)
        const versionsPath = versionsPathFromRoot(root)
        if (versionsPath && (await isPathExists(versionsPath))) roots.push(root)
      }
    }
    return roots
  }

  private retentionDaysFor(versionsRoot: string): number | false {
    const retention = this.config.retentionDays
    return versionsRoot.startsWith(VERSIONS_ROOT_USER_PREFIX) ? retention.users : retention.spaces
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
