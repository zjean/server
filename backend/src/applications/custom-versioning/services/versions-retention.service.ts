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
import { API_VERSIONS_ADMIN_REPOINT } from '../constants/routes'
import { VERSIONS_ROOT_SPACE_PREFIX, VERSIONS_ROOT_USER_PREFIX, VERSIONS_STAGING_DIR } from '../constants/versioning'
import { VersionRow } from '../interfaces/version.interface'
import { spaceVersionsRoot, userVersionsRoot, versionsPathFromRoot } from '../utils/paths'
import { versionsToExpire } from '../utils/versions-thinning'
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

  // THE FLAG GATES THE SHAPING RULES, NOT THE RECLAIM RULES (#490).
  //
  // The whole sweep used to return early while `files.versions.enabled` was
  // false, which stranded the store: an operator disables the feature —
  // typically *because of* a quota complaint — and from that moment nothing
  // reclaims anything, while `files-quota-manager`'s dirSize walk keeps
  // charging every byte under `versions/` to the user. The only remedy left was
  // the manual `rm -rf` + `DELETE FROM` surgery purgeRoot exists to make
  // unnecessary.
  //
  // So the two GC rules — orphan blobs and dangling rows — now run either way.
  // Neither can destroy reachable history by construction: an orphan blob is
  // bytes no row points at (after a day's grace), and a dangling row is a row
  // whose `files` row is already gone. They are pure reclaim.
  //
  // The three ROW rules stay gated. retentionDays, thinning and quotaShare
  // shape a history that is still addressable, and applying a shaping policy to
  // a store the operator has taken out of service would quietly delete
  // revisions they would find missing on re-enabling. An operator who wants
  // those bytes back while the feature is off has an explicit instrument that
  // is now reachable: the admin purge.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanVersions(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn({ tag: this.cleanVersions.name, msg: 'previous run still in progress, skipping' })
      return
    }
    this.isRunning = true
    this.logger.log({ tag: this.cleanVersions.name, msg: 'START' })
    try {
      // Root list for the whole sweep. Read ONCE and reused by the coherence
      // check below — two reads of the same list could disagree, and the
      // cheaper of the two answers is the one that decides whether blobs get
      // unlinked.
      //
      // THIS READ MUST STAY OUTSIDE ANY `this.config.enabled` GATE, and the
      // rule is load-bearing rather than stylistic. The flag decides whether
      // new versions are MINTED; the filesystem rules below run regardless,
      // because rows and blobs written while it was on outlive it. They derive
      // the stranded-root list from exactly this answer, so gating the read
      // would hand them an empty list — and an empty stranded list is not
      // "nothing is wrong", it is "the tripwire is disarmed". The one state in
      // which that matters is the one it exists for: an unrepointed rename on
      // an instance where versioning has since been switched off.
      //
      // (Agreed resolution with #524, which gates the ROW rules on the flag:
      // the gate goes around the loop below, never around this line, and that
      // branch's `expect(distinctRoots).not.toHaveBeenCalled()` narrows to the
      // shaping probes — unlabeledOlderThan / distinctFileIdsByRoot /
      // evictUntilUnderCeiling — which is what "did no row work" actually
      // means.)
      const rootsWithRows = await this.queries.distinctRoots()
      // Row rules, per root that actually holds versions. GATED (#524): the
      // three shaping rules below reshape history that is still addressable, so
      // they must not run on a store the operator has taken out of service. The
      // read above is deliberately NOT inside this gate — see its comment.
      if (this.config.enabled) {
        for (const versionsRoot of rootsWithRows) {
          // Each rule is independently guarded: a broken root must not stop the
          // sweep for every other root.
          await this.runRule('retentionDays', versionsRoot, () => this.enforceRetentionDays(versionsRoot))
          await this.runRule('thinning', versionsRoot, () => this.enforceThinning(versionsRoot))
          await this.runRule('quotaShare', versionsRoot, () => this.enforceQuotaShare(versionsRoot))
        }
      }
      // Filesystem rules need a DIFFERENT root list. distinctRoots() reads the
      // versions table, so a root holding blobs but NO rows — precisely the
      // state in which bytes are guaranteed to be orphaned, e.g. every version
      // of a file was purged, or a crash left staging debris — would never be
      // visited and would leak forever. These enumerate the disk instead.
      //
      // …which is exactly what makes this the one rule that can destroy an
      // entire history at once, so every blob a STRANDED root's rows still
      // name is held back from it (#471). See collectOrphanBlobs.
      const stranded = await this.unresolvableRoots(rootsWithRows)
      if (stranded.length) {
        this.logger.error({
          tag: this.cleanVersions.name,
          msg:
            `${stranded.length} versions root(s) hold rows but have no store on disk (${stranded.join(', ')}). ` +
            `A user login or space alias was very likely renamed without repointing its version rows — every download ` +
            `and restore under those roots will 404 until they are repointed. ` +
            `REMEDY: POST ${API_VERSIONS_ADMIN_REPOINT} {"fromVersionsRoot":"<stale root>","toVersionsRoot":"<current root>"} ` +
            `as an administrator; it only rewrites the recorded root and deletes nothing.`
        })
      }
      for (const versionsRoot of await this.rootsOnDisk()) {
        await this.runRule('orphanBlobs', versionsRoot, () => this.collectOrphanBlobs(versionsRoot, stranded))
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

  // Thin every file in this root to the curve.
  //
  // BACKSTOP, not the only enforcement point. VersioningService thins the file it
  // just versioned on every write; this sweep is the only thing that reaches a
  // root nobody writes to. Thinning is idempotent, so re-examining an
  // already-shaped file costs a read and nothing else.
  //
  // Per root, like every other row rule here: a file whose versions span two
  // roots (it was moved between spaces) must be thinned per root, or one root
  // over-deletes while the other under-enforces.
  private async enforceThinning(versionsRoot: string): Promise<number> {
    let removed = 0
    for (const fileId of await this.queries.distinctFileIdsByRoot(versionsRoot)) {
      const rows = await this.queries.byFileIdNewestFirst(versionsRoot, fileId)
      const expiring = versionsToExpire(rows, Date.now())
      if (expiring.length === 0) continue
      removed += await this.dropAll(
        rows.filter((r) => expiring.includes(r.id)),
        'thinning'
      )
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
    const ceiling = await this.rootCeiling(versionsRoot)
    if (ceiling === null) return 0
    return this.versioning.evictUntilUnderCeiling(versionsRoot, ceiling)
  }

  // The ceiling this sweep will ACTUALLY apply to a root: its owner's quota
  // times quotaShare, or null when nothing caps it (no quota on the user or
  // space, or quotaShare disabled).
  //
  // Public because the admin panel reports it, and it must be THIS function
  // rather than a second derivation — that was #338, where versionsUsage
  // computed a ceiling from `space.storageQuota` while enforcement required the
  // resolved root to match the current env, so the figure shown was a limit
  // nothing would ever apply. One derivation, two readers: what the panel
  // displays is what the 3AM sweep will enforce.
  async rootCeiling(versionsRoot: string): Promise<number | null> {
    const share = this.config.quotaShare
    if (!share) return null
    const quota = await this.rootQuota(versionsRoot)
    if (!quota) return null
    return quota * share
  }

  /* ------------------------------------------------------------ admin purge */

  // Purges ONE versions root on an operator's instruction (#342): a departing
  // employee, an incident, a user who filled their quota with revisions of one
  // file. Returns what went and what stayed.
  //
  // ROUTED THROUGH THE SAME EVICTION PATH AS THE NIGHTLY RULES, deliberately.
  // Candidates come from the unlabeled-only query, and every removal goes
  // through dropAll -> VersioningService.dropVersionForRetention, which is the
  // one refcount-aware blob seam. The bespoke alternative an operator resorts to
  // today — DELETE FROM custom_files_versions WHERE versionsRoot = ? plus an rm
  // -rf of the directory — bypasses three things at once: the labeled-version
  // exemption, the per-root blob refcount (a blob a surviving labeled version
  // still points at would go with it), and the per-victim audit line ADR §7
  // requires. It also cannot honour ADR §9's pin-before-read discipline, so a
  // concurrent download or restore loses its bytes mid-stream.
  //
  // NAMED VERSIONS SURVIVE, always. There is no flag to remove them: they are
  // exempt from every automatic rule precisely because someone decided they
  // matter, and an admin purge is not a better-informed decision about one
  // user's named revisions than that user's own. Removing one stays a per-version
  // act with its own confirmation (deleteVersion's 409).
  //
  // Blobs left in the root with no row at all — from a purge that crashed, or
  // from an earlier bug — are not this method's business; the nightly
  // orphan-blob rule owns them and reaches roots by scanning the disk.
  async purgeRoot(versionsRoot: string): Promise<{ removed: number; removedBytes: number; keptLabeled: number }> {
    let removed = 0
    let removedBytes = 0
    // Paged, and re-queried each round rather than offset-walked: every row in
    // the page is deleted before the next fetch, so the same query naturally
    // returns the next page. A page shorter than the batch size is the last one.
    for (;;) {
      const page = await this.queries.unlabeledByRootOldestFirst(versionsRoot, this.batchSize)
      if (!page.length) break
      removedBytes += page.reduce((total, row) => total + row.size, 0)
      removed += await this.dropAll(page, 'adminPurge')
      if (page.length < this.batchSize) break
    }
    // Whatever is left in the root is exactly what the purge was not allowed to
    // touch, so the count is read back rather than computed — it cannot then
    // disagree with what the panel will show on its next refresh.
    const { count: keptLabeled } = await this.queries.usageByRoot(versionsRoot)
    this.logger.log({
      tag: this.purgeRoot.name,
      msg: `${versionsRoot}: purged ${removed} versions (${removedBytes} bytes), kept ${keptLabeled} named`
    })
    return { removed, removedBytes, keptLabeled }
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
  //
  // THE #471 TRIPWIRE LIVES HERE, PER BLOB, and it is per blob because the
  // root-level version of it did not survive contact with the scenario it was
  // written for. That guard skipped a root only while the root had NO rows,
  // reasoning that "some root's rows lost their store" plus "this root has a
  // store but no rows" is the signature of an unrepointed rename. It is — for
  // about as long as it takes the renamed user to press Save once. From that
  // instant `versionsRootFromSpace` derives the CURRENT login, the new root
  // acquires rows, the guard reads false, and the sweep unlinks the entire
  // pre-rename history: exactly #471, now with the tripwire watching.
  //
  // What actually distinguishes the two cases is not whether this root has
  // rows, but whether the bytes in front of us are ones a STRANDED root's rows
  // still describe. After a rename they are — the store moved with the home
  // directory, so `user:alice`'s rows name blobs physically sitting under
  // `user:bob`. A genuine orphan is named by nothing anywhere. So the per-root
  // refcount decides as before, and a blob it calls unreferenced gets one more
  // question asked of the stranded roots before it is unlinked.
  //
  // This costs nothing on a healthy instance (`stranded` is empty and the
  // query short-circuits), and it does not neuter the rule while a stranded
  // root exists: a root with no rows is still swept, and a genuinely orphaned
  // blob is still collected. Only bytes with a claimant are held back, and they
  // are held back rather than deleted, which is the direction this rule is
  // allowed to be wrong in.
  //
  // KNOWN LIMIT: the signal is the stranded root, so a rename whose OLD name
  // has since acquired a store of its own — a user deleted and recreated under
  // the previous login — is not protected. Repointing the rows is the fix for
  // that, and the unconditional error log above names the endpoint that does
  // it; this is the net under the fix, not a substitute for it.
  private async collectOrphanBlobs(versionsRoot: string, stranded: string[] = []): Promise<number> {
    const versionsPath = versionsPathFromRoot(versionsRoot)
    if (!versionsPath || !(await isPathExists(versionsPath))) return 0
    const now = Date.now()
    let removed = 0
    let heldBack = 0

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
        // …and the tripwire: unreferenced HERE is not unreferenced if a root
        // that has lost its store still names these bytes.
        if ((await this.queries.countByBlobInRoots(blob.name, stranded)) > 0) {
          heldBack++
          continue
        }
        await removeFiles(blobPath).catch(() => undefined)
        removed++
      }
    }
    if (heldBack) {
      this.logger.warn({
        tag: this.collectOrphanBlobs.name,
        msg:
          `${versionsRoot}: kept ${heldBack} unreferenced blob(s) that rows in a root with no store still name ` +
          `(${stranded.join(', ')}) — repoint those rows and they become readable history again`
      })
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

  // Roots that rows point at but that have NO versions directory on disk — the
  // signature of an orphaned store, and the input to the blob sweep's tripwire
  // (#471).
  //
  // WHY ONLY THE BLOB SWEEP CARES. `versionsRoot` is derived from a user login
  // or a space alias, both mutable, and renaming either moves the home
  // directory with the blob store inside it. Repointing the rows is now part of
  // both rename paths, so this should never fire — but when it does, the blob
  // sweep is the rule that turns the inconsistency into permanent data loss: it
  // enumerates the DISK, finds the store under its new name, refcounts it
  // against rows that still say the old one, gets 0 for every blob, and unlinks
  // all of them. The row rules cannot do comparable damage (their own blob
  // removal resolves the stale root, finds nothing, and logs), so they are left
  // running rather than stalling every root's retention on one bad entry.
  //
  // It is also a diagnostic in its own right, and a real one: these roots'
  // downloads and restores are already 404ing, and nothing but repointing the
  // rows fixes that — which is why cleanVersions logs it unconditionally, at
  // error level, with the repair endpoint named.
  private async unresolvableRoots(rootsWithRows: string[]): Promise<string[]> {
    const unresolvable: string[] = []
    for (const versionsRoot of rootsWithRows) {
      const versionsPath = versionsPathFromRoot(versionsRoot)
      if (!versionsPath || !(await isPathExists(versionsPath))) unresolvable.push(versionsRoot)
    }
    return unresolvable
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
