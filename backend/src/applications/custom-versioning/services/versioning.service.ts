import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { SERVER_NAME } from '../../../common/shared'
import { ACTION } from '../../../common/constants'
import { configuration } from '../../../configuration/config.environment'
import { FileRowEnsurer } from '../../custom-shared/services/file-row-ensurer.service'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { FileDBProps } from '../../files/interfaces/file-db-props.interface'
import { FileLock } from '../../files/interfaces/file-lock.interface'
import { FileError } from '../../files/models/file-error'
import { FileEvent } from '../../files/events/file-events'
import { FilesLockManager } from '../../files/services/files-lock-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { FilesVersionsConfig } from '../../files/files.config'
import { checksumFile, dirName, fileName, getMimeType, isPathExists, makeDir, removeFiles, writeFromStream } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { canModifySpaceEnv } from '../../spaces/utils/permissions'
import { SYNC_CHECKSUM_ALG } from '../../sync/constants/sync'
import { UserModel } from '../../users/models/user.model'
import { DEPTH } from '../../webdav/constants/webdav'
import { SnapshotOptions, VersionOrigin, VersionProps, VersionRow, VersionsUsage } from '../interfaces/version.interface'
import { blobPathFromRoot, spaceVersionsRoot, userVersionsRoot, versionsPathFromRoot, versionsRootFromSpace } from '../utils/paths'
import { VERSIONS_STAGING_DIR } from '../constants/versioning'
import { VersioningQueries } from './versioning-queries.service'

// File versioning. See docs/plans/2026-07-25-file-versioning-design.md.
//
// The whole feature hangs off ONE contract: snapshotBeforeOverwrite captures
// the bytes a write is about to destroy, SYNCHRONOUSLY, before the destructive
// operation. It cannot be driven off the FileEvent bus, which is buffered and
// async — by the time an event fires, the old bytes are gone.
//
// Correspondingly, this service must NEVER throw into a caller's save path.
// A failed snapshot degrades to "no version for this write"; a snapshot that
// propagated its error would turn a working save into a 500. That is an
// explicit durability-vs-availability trade (ADR §4), which is why
// snapshotBeforeOverwrite catches everything and returns.
@Injectable()
export class VersioningService {
  private readonly logger = new Logger(VersioningService.name)
  private readonly config: FilesVersionsConfig = configuration.applications.files.versions

  constructor(
    private readonly queries: VersioningQueries,
    private readonly fileRowEnsurer: FileRowEnsurer,
    private readonly filesQueries: FilesQueries,
    private readonly filesLockManager: FilesLockManager
  ) {}

  get enabled(): boolean {
    return this.config.enabled === true
  }

  /* ---------------------------------------------------------------- snapshot */

  // Captures the CURRENT content of space.realPath as a new version.
  //
  // Call this immediately before the destructive operation, never after. Never
  // throws: all failures are logged and swallowed (see the class comment).
  async snapshotBeforeOverwrite(user: UserModel, space: SpaceEnv, options: SnapshotOptions): Promise<void> {
    if (!this.enabled) return
    // Guest and link homes live under files.tmpPath while the versions root
    // resolves into usersPath, so their versions would outlive the ephemeral
    // tree holding the live files — and every public-link upload would pay a
    // cross-device copy. Public links are a sharing surface, not an authoring
    // one; there is no user to show history to (ADR §8).
    if (user.isGuest || user.isLink) return

    try {
      await this.snapshot(user, space, options)
    } catch (e) {
      // Deliberately swallowed: the caller's save must still succeed.
      this.logger.error({
        tag: this.snapshotBeforeOverwrite.name,
        msg: `snapshot failed for ${space.url} (${options.origin}), the save proceeds unversioned: ${e}`
      })
    }
  }

  private async snapshot(user: UserModel, space: SpaceEnv, options: SnapshotOptions): Promise<void> {
    const stats = await fs.stat(space.realPath).catch(() => null)
    // Nothing to version: a create, or a directory. Callers gate on this too,
    // but re-checking here keeps the guarantee independent of seven hook sites.
    if (!stats?.isFile()) return

    const versionsRoot = versionsRootFromSpace(user, space)
    if (!versionsRoot) {
      this.logger.warn({ tag: this.snapshot.name, msg: `no versions root resolvable for ${space.url}, skipping` })
      return
    }

    // The anchor (ADR §3): version rows key on `files.id`, and `files` rows are
    // lazily materialized, so the ensurer — not a plain lookup — is what makes
    // the id exist on a file's FIRST snapshot.
    //
    // `options.fileId` is an already-PROVEN id, not a shortcut past that rule.
    // Only restoreVersion passes one, and only because requireVersionForWrite has
    // just accepted a version row whose fileId equals the id resolved from this
    // very space env — so the row is known to exist and the ensurer's lookup
    // would be the same lookup a second time (#349). Any other caller has no id
    // and must go through the ensurer: a bare lookup there returns 0 for a file
    // that has never had a row, and the snapshot would be dropped.
    const fileId = options.fileId || (await this.fileRowEnsurer.ensureFileId(user, space, this.fileProps(space, stats.size, stats.mtimeMs)))
    if (!fileId) {
      // The ensurer already logged the cause and returns 0 rather than throwing.
      this.logger.warn({ tag: this.snapshot.name, msg: `no file id for ${space.url}, skipping snapshot` })
      return
    }

    if (await this.isCoalesced(fileId, user.id, options)) {
      this.logger.verbose({ tag: this.snapshot.name, msg: `coalesced ${space.url} (${options.origin})` })
      return
    }

    // Cheap pre-flight (#339). Declines a write that no amount of eviction
    // could make room for BEFORE a byte is copied. It does NOT replace
    // enforceQuotaShare below — see cannotFitEvenAfterEviction for why both
    // exist and why this one cannot be the whole check.
    //
    // Exempt for `restore` for the same reason the cap below is: a restore's own
    // safety snapshot is a net rather than new growth.
    if (options.origin !== 'restore' && (await this.cannotFitEvenAfterEviction(user, space, versionsRoot, stats.size))) {
      this.logger.warn({
        tag: this.snapshot.name,
        msg: `${space.url} (${stats.size} bytes) exceeds the versions ceiling for ${versionsRoot}, the save proceeds unversioned`
      })
      return
    }

    const scope = this.scopeOf(space.dbFile)
    // Copy first, then hash what was copied — see stageBlob for why the digest
    // must not come from the live file.
    const staged = await this.stageBlob(space.realPath, versionsRoot)
    try {
      const blobPath = blobPathFromRoot(versionsRoot, staged.checksum)
      if (!blobPath) {
        throw new Error(`unable to resolve a blob path in ${versionsRoot}`)
      }
      // A restore's own safety snapshot is exempt from the cap: it is a net
      // rather than new growth, and letting it evict would allow it to delete
      // the very version being restored.
      if (options.origin !== 'restore') {
        const deduped = await isPathExists(blobPath)
        await this.enforceQuotaShare(user, space, versionsRoot, deduped ? 0 : staged.size)
      }

      // Blob first, row second. A crash between the two leaves an orphan blob,
      // which the retention GC sweeps; the reverse order would leave a version
      // row pointing at nothing — a visible, un-downloadable entry.
      await this.publishBlob(staged.stagePath, blobPath)

      await this.queries.insertVersion({
        fileId,
        ...scope,
        versionsRoot,
        checksum: staged.checksum,
        size: staged.size,
        mtime: Math.floor(stats.mtimeMs),
        authorId: user.id ?? null,
        origin: options.origin,
        label: null
      })
    } catch (e) {
      await removeFiles(staged.stagePath).catch(() => undefined)
      throw e
    }
    // The per-file cap, enforced EAGERLY (#340). It used to live only in the
    // nightly sweep, which left the row count for one file unbounded for up to
    // 24 hours — the coalescing window bounds the RATE, not the total, and the
    // quota cap is skipped entirely whenever rootQuota() cannot match scopes.
    //
    // OUTSIDE the try above, with its OWN error boundary, for the same reason
    // refreshScope below has one: the version is already committed at this
    // point, so a trim failure must not be rethrown into
    // snapshotBeforeOverwrite — that logs "the save proceeds unversioned",
    // which would be a lie once the row exists. Log and continue; the nightly
    // rule is still the backstop, so the worst case is a delay rather than a
    // permanent breach of the cap.
    //
    // NOT for a restore's own safety snapshot. That is the same exemption the
    // quota cap takes above, and it bites harder here: the candidates are THIS
    // FILE's oldest unlabeled versions, which when restoring the oldest revision
    // is precisely the version being restored. The overshoot is one row, cleared
    // by the next ordinary write to the file or by the nightly rule.
    if (options.origin !== 'restore') {
      await this.trimToMaxVersionsPerFile(versionsRoot, fileId).catch((e: unknown) => {
        this.logger.warn({ tag: this.snapshot.name, msg: `unable to trim versions of file ${fileId} in ${versionsRoot}: ${e}` })
      })
    }
    // Keeps the denormalized scope columns of this file's OTHER rows current
    // after a move. They are never authoritative (ADR §15), so this is a cache
    // refresh with its OWN error boundary: it runs after the version is safely
    // committed, and must never turn a successful snapshot into a logged
    // failure. It is here because the ADR promises the refresh happens on the
    // next snapshot, and a comment that lies is a defect in a fork that lives
    // by its comments.
    await this.queries.refreshScope(fileId, scope).catch((e: unknown) => {
      this.logger.warn({ tag: this.snapshot.name, msg: `unable to refresh scope columns for file ${fileId}: ${e}` })
    })
    this.logger.verbose({ tag: this.snapshot.name, msg: `versioned ${space.url} (${options.origin}) ${staged.checksum.slice(0, 12)}` })
  }

  // Skips the snapshot when the newest version for (fileId, authorId, origin)
  // is younger than that ORIGIN's window AND unlabeled — the pre-session state
  // is already captured, so an editor autosaving every 30s does not mint a
  // version each time. A labeled newest version never coalesces: suppressing
  // here would let a named revision silently swallow the next real change.
  //
  // The window is per-origin (ADR §5) because the editors' cadence is set by the
  // document server while an interactive save is a human decision — see
  // FilesVersionsOriginIntervalsConfig for the numbers and why one scalar cannot
  // serve both.
  private async isCoalesced(fileId: number, authorId: number | null, options: SnapshotOptions): Promise<boolean> {
    // A restore's safety snapshot is never coalesced. It is the only record of
    // the pre-restore content, so suppressing it would leave a second restore
    // inside the window with nothing to go back to — and §9's promise that a
    // restore is never destructive would stop holding. Restores are rare and
    // deliberate; there is no autosave storm to protect against.
    if (options.origin === 'restore') return false
    const window = this.coalescingWindow(options.origin)
    if (window <= 0) return false
    const newest = await this.queries.newestForTuple(fileId, authorId ?? null, options.origin)
    if (!newest || newest.label) return false
    const ageSeconds = (Date.now() - new Date(newest.createdAt).getTime()) / 1000
    return ageSeconds < window
  }

  // The window for one origin: its own override if configured, otherwise the
  // scalar fallback (ADR §5).
  //
  // TESTS FOR A NUMBER, NOT FOR TRUTHINESS. `0` is a meaningful value — "never
  // coalesce this origin" — and `?? fallback` or a truthiness check would
  // silently promote it back to 60. That is the same class of bug as the
  // config's own `0 -> false` Transform idiom, read from the other side.
  //
  // Reads through the config object each call rather than caching, because the
  // specs mutate `configuration.applications.files.versions` on an
  // already-constructed service.
  private coalescingWindow(origin: VersionOrigin): number {
    const configured = (this.config.minIntervalSecondsByOrigin as Partial<Record<VersionOrigin, number>> | undefined)?.[origin]
    if (typeof configured === 'number') return configured
    // An environment.yaml predating the per-origin block leaves it undefined;
    // the scalar is then the whole rule, exactly as before.
    return this.config.minIntervalSeconds ?? 0
  }

  // Keeps total version bytes in this root at or under quota * quotaShare by
  // evicting oldest-unlabeled-first BEFORE inserting.
  //
  // This is the honest half of ADR §7: it bounds how much quota history can
  // consume, and it does NOT promise the user's save will succeed — the
  // pre-flight guard in space.guard.ts runs long before any of this and reads a
  // day-old cached dirSize. Never claim otherwise.
  private async enforceQuotaShare(user: UserModel, space: SpaceEnv, versionsRoot: string, incomingSize: number): Promise<void> {
    const share = this.config.quotaShare
    // A dedup hit costs zero disk bytes, so it must not evict anything.
    if (!share || !incomingSize) return
    const quota = this.rootQuota(user, space, versionsRoot)
    if (!quota) return
    const ceiling = quota * share

    // No amount of eviction makes room for a version that alone exceeds the
    // ceiling, so evicting even one would be pure loss. Refusing to version
    // this one write is the correct trade; the caller degrades to "no version"
    // and the save proceeds.
    if (incomingSize > ceiling) {
      throw new FileError(
        HttpStatus.INSUFFICIENT_STORAGE,
        `version of ${incomingSize} bytes exceeds the versions ceiling (${Math.floor(ceiling)}) for ${versionsRoot}`
      )
    }

    // Leave room for the version about to be inserted.
    await this.evictUntilUnderCeiling(versionsRoot, ceiling - incomingSize)
  }

  // The write path's pre-flight: can a version of `size` bytes NEVER fit in this
  // root, no matter what gets evicted? (#339)
  //
  // WHY THIS IS A SECOND CHECK AND NOT A REPLACEMENT. enforceQuotaShare has to
  // run after staging, because the cost of the incoming version depends on
  // whether the blob deduped, and that is only known once the copy has been
  // hashed — and the digest must come from the copy, not from a separate read of
  // a file that may be changing under it (see stageBlob). But enforceQuotaShare's
  // one UNSATISFIABLE case is knowable from `stats.size` alone, and reaching it
  // used to cost a full read + write of the file plus an unlink, on every write
  // to it. So the expensive check stays where it is and this one only front-runs
  // the case that can never succeed.
  //
  // IT COMPARES AGAINST THE CEILING, NEVER AGAINST THE FREE SPACE. `ceiling -
  // used` is what eviction can free RIGHT NOW; a snapshot bigger than that is
  // routinely admitted by evicting older versions, and rejecting it here would
  // turn an efficiency fix into silent data loss. Only `size > ceiling` is
  // unsatisfiable whatever is evicted, and it is exactly the condition
  // enforceQuotaShare throws on.
  //
  // AND IT MUST NOT STEAL THE DEDUP CASE. A blob already present in the root
  // costs zero bytes, so enforceQuotaShare admits it at ANY size — reachable,
  // because a restore's exempt safety snapshot (or a quota that was lowered
  // afterwards) can leave a blob larger than the current ceiling in the root, and
  // an ordinary write back to that content then dedups against it. Identical
  // content implies identical size, so `existsSizeInRoot` is a sound necessary
  // condition: no row of this size means dedup is impossible and the bail is
  // safe. A hit only means "stage it and let the real check decide", i.e. exactly
  // today's behaviour, so the query buys the fast path without owning the
  // decision. (A blob with no row — crash debris the orphan GC has yet to sweep —
  // reads as non-dedupable here; the cost is one unversioned write of an
  // over-ceiling file, which is the same degradation the caller already accepts.)
  //
  // A null rootQuota means no eager cap applies at all (#338), so this is a
  // no-op there too — same gate, same function, as the enforcement side.
  private async cannotFitEvenAfterEviction(user: UserModel, space: SpaceEnv, versionsRoot: string, size: number): Promise<boolean> {
    const share = this.config.quotaShare
    if (!share) return false
    const quota = this.rootQuota(user, space, versionsRoot)
    if (!quota) return false
    if (size <= quota * share) return false
    return !(await this.queries.existsSizeInRoot(versionsRoot, size))
  }

  // Evicts oldest-unlabeled-first until this root's version bytes fit under
  // `ceiling`. Returns how many were removed.
  //
  // SHARED ON PURPOSE — this is the one place that decides when eviction is
  // allowed to happen, and it exists because having that decision in two places
  // already produced the same data-loss bug twice. The rule:
  //
  //   Labeled versions are never evictable. So if labeled bytes ALONE exceed the
  //   ceiling, no sequence of evictions can reach it — and a `while (used >
  //   ceiling)` loop will then delete every unlabeled version in the root,
  //   including every other file's, and still finish over the ceiling. Maximum
  //   destruction, zero benefit. Detect that up front and keep everything.
  //
  // The inverse is also true and is why the check cannot be "did I run out of
  // victims": by the time victims run out the damage is already done.
  async evictUntilUnderCeiling(versionsRoot: string, ceiling: number): Promise<number> {
    let { used, labeledBytes } = await this.queries.usageByRoot(versionsRoot)
    if (labeledBytes > ceiling) {
      this.logger.warn({
        tag: this.evictUntilUnderCeiling.name,
        msg: `${versionsRoot}: labeled versions alone (${labeledBytes} bytes) exceed the versions ceiling (${Math.floor(ceiling)}), keeping all history`
      })
      return 0
    }

    let removed = 0
    while (used > ceiling) {
      const victim = await this.queries.oldestUnlabeledByRoot(versionsRoot)
      // Unreachable given the guard above (labeledBytes <= ceiling < used means
      // unlabeled bytes remain), but a defensive exit beats an infinite loop if
      // sizes and rows ever disagree.
      if (!victim) return removed
      await this.dropVersion(victim)
      used -= victim.size
      removed++
      // Logged at `log`, not verbose, and per victim rather than as a total:
      // silently deleting a user's history deserves an audit trail that names
      // what went (ADR §7).
      this.logger.log({
        tag: this.evictUntilUnderCeiling.name,
        msg: `evicted version ${victim.id} of file ${victim.fileId} (${victim.size} bytes) from ${versionsRoot} to stay under the versions quota share`
      })
    }
    return removed
  }

  // Keeps ONE file's version count in ONE root at or under maxVersionsPerFile,
  // dropping oldest-unlabeled-first. Called after the row is inserted; the
  // nightly rule in VersionsRetention.enforceMaxVersionsPerFile stays as the
  // backstop for roots the write path never touches (and for a cap that was
  // lowered after the fact).
  //
  // `false` DISABLES the rule and must never be read as `0`. `!keep` is the same
  // test the nightly rule uses; a `keep ?? 0` or a `Number(keep)` would compute
  // an excess of `count` and delete every unlabeled version of the file on the
  // very first write.
  //
  // LABELED VERSIONS ARE KEPT AND COUNTED, exactly as in the nightly rule. The
  // exemption is not restated here: it is encoded in the candidate query, which
  // is unlabeled-only, so a file with more labels than the cap simply gets back
  // fewer rows than the excess and keeps them all. Stating the rule twice is how
  // this feature produced the same data-loss bug twice.
  //
  // THE BLOB UNLINK GOES THROUGH dropVersion, never through a removeFiles here.
  // That is the one refcount-aware seam — a blob another version in this root
  // still references must survive — and it is the seam ADR §9's pin-before-read
  // discipline is written against: a reader that has already opened the blob
  // keeps its bytes across the unlink, which is why restoreVersion opens the
  // descriptor before it takes its snapshot. An unlink here would bypass the
  // refcount and delete blobs other rows still point at.
  private async trimToMaxVersionsPerFile(versionsRoot: string, fileId: number): Promise<void> {
    const keep = this.config.maxVersionsPerFile
    if (!keep) return
    const excess = (await this.queries.countByFileId(versionsRoot, fileId)) - keep
    if (excess <= 0) return
    for (const victim of await this.queries.unlabeledByFileIdOldestFirst(versionsRoot, fileId, excess)) {
      await this.dropVersion(victim)
      // Per victim at `log`, not an aggregate at `verbose`: ADR §7 — silently
      // deleting a user's history deserves an audit trail that names what went.
      this.logger.log({
        tag: this.trimToMaxVersionsPerFile.name,
        msg: `trimmed version ${victim.id} of file ${victim.fileId} (${victim.size} bytes) from ${versionsRoot} to stay under maxVersionsPerFile (${keep})`
      })
    }
  }

  // Copies the live content into the store, preferring a copy-on-write clone.
  //
  // A HARDLINK WOULD BE A CORRECTNESS BUG, NOT AN OPTIMIZATION. It is the
  // obvious cheap move and it silently destroys history: a hardlinked blob
  // shares the live file's inode, and THREE of the seven write paths truncate
  // that inode in place rather than replacing it —
  //   - saveStream's direct branch, via writeFromStream with flag 'w'
  //     (files/utils/files.ts:253),
  //   - both editors, via copyFileContent (which is writeFromStream, same flag)
  //     — the very calls they use to KEEP the inode stable,
  //   - mkFile(overwrite=true), via copyFileContent or createEmptyFile's
  //     fs.writeFile(rPath, '').
  // In each case the following write lands on the same inode the "saved"
  // version points at, so the version ends up holding the NEW bytes. Only the
  // moveFiles-based paths would have been safe. The repo's deliberate
  // inode-stability (ADR §9) is exactly what makes hardlink snapshotting
  // unsound here.
  //
  // COPYFILE_FICLONE asks for a reflink and silently falls back to a full copy
  // when the filesystem cannot do it, which also covers the cross-device case
  // — normal here, since dataPath/usersPath/spacesPath/tmpPath are
  // independently configurable and external roots point anywhere (ADR §1). A
  // clone is cheap AND independent: writing to the live file afterwards splits
  // the shared blocks instead of corrupting the copy.
  //
  // The digest is taken from the STAGED COPY, never from the live file, and the
  // copy is published by rename. That ordering is what makes the store's one
  // invariant — "the filename is the hash of the bytes under it" — actually
  // true rather than merely asserted:
  //
  //   - Hashing the live file in a separate pass from the copy leaves a window
  //     in which the file changes between the two reads. WebDAV writes hold no
  //     server lock (ADR §4 admits the path is best-effort), so that window is
  //     reachable. The blob would then be stored under a digest that does not
  //     describe it — and because the store is content-addressed, EVERY later
  //     snapshot of the genuinely-matching content would dedup against that
  //     mis-named blob and silently serve the wrong bytes. The one corruption
  //     that escapes its own row.
  //   - Publishing by rename means a crash mid-copy leaves a `.part` file, not
  //     a TRUNCATED file at the content-addressed path, which the dedup check
  //     would otherwise trust as complete forever.
  //   - Renaming unconditionally (rather than skipping the copy when the blob
  //     already exists) also closes a race: between an existence check and the
  //     row insert, a concurrent eviction or purge could unlink the blob,
  //     leaving a brand-new row pointing at nothing. Rename is atomic and the
  //     content is identical by construction, so replacing is always safe. The
  //     cost is one copy we could sometimes have skipped; the alternative is
  //     versions that list but can never be downloaded.
  private async stageBlob(realPath: string, versionsRoot: string): Promise<{ stagePath: string; checksum: string; size: number }> {
    const versionsPath = versionsPathFromRoot(versionsRoot)
    if (!versionsPath) {
      throw new Error(`unable to resolve a versions path for ${versionsRoot}`)
    }
    const stageDir = path.join(versionsPath, VERSIONS_STAGING_DIR)
    await makeDir(stageDir, true)
    const stagePath = path.join(stageDir, `${randomUUID()}.part`)
    await fs.copyFile(realPath, stagePath, fsConstants.COPYFILE_FICLONE)
    const [checksum, stats] = await Promise.all([checksumFile(stagePath, SYNC_CHECKSUM_ALG), fs.stat(stagePath)])
    return { stagePath, checksum, size: stats.size }
  }

  private async publishBlob(stagePath: string, blobPath: string): Promise<void> {
    await makeDir(dirName(blobPath), true)
    await fs.rename(stagePath, blobPath)
  }

  // The ceiling must be sized against the SAME scope the versions root belongs
  // to. space.storageQuota is the CURRENT env's allowance, and the two can
  // diverge: for a share with an external path, versionsRootFromSpace resolves
  // to the acting user's own root while the env's quota belongs to the share.
  // Using the env's quota there would evict the user's PERSONAL history to fit
  // a write into someone else's small share. When the scopes do not line up we
  // skip the eager cap entirely and leave it to the retention backstop.
  private rootQuota(user: UserModel, space: SpaceEnv, versionsRoot: string): number | null {
    if (!space.storageQuota) return null
    if (space.inPersonalSpace && versionsRoot === userVersionsRoot(user.login)) return space.storageQuota
    if (space.alias && versionsRoot === spaceVersionsRoot(space.alias)) return space.storageQuota
    return null
  }

  /* ------------------------------------------------------------------ reads */

  // History for the file the resolved space env points at. Read access is
  // implied by having resolved the space env at all — the space guard already
  // enforced it — so there is no extra permission check here, matching how the
  // rest of the codebase treats a resolved env.
  async listVersions(user: UserModel, space: SpaceEnv): Promise<VersionProps[]> {
    if (!this.enabled) return []
    const fileId = await this.resolveFileId(user, space)
    if (!fileId) return []
    return (await this.queries.listByFileId(fileId)).map((row) => ({
      id: row.id,
      fileId: row.fileId,
      size: row.size,
      mtime: row.mtime,
      createdAt: row.createdAt,
      origin: row.origin,
      label: row.label,
      checksum: row.checksum,
      ...(row.authorLogin && { author: { login: row.authorLogin, fullName: row.authorFullName || row.authorLogin } })
    }))
  }

  // Pinned before returning, exactly as restoreVersion pins before writing, and
  // for the same reason: eviction and reads share no lock (ADR §9), and
  // evictUntilUnderCeiling unlinks blobs on EVERY snapshot — so any concurrent
  // write anywhere in this versions root can pull the bytes away, not just the
  // retention sweep.
  //
  // `fs.open` REPLACES the old isPathExists check rather than supplementing it.
  // A path-based check followed by a path-based createReadStream is check-then-
  // act: the stream's open is deferred to a later tick, so an eviction landing
  // in between faulted a stream the controller had already committed to a
  // response — a truncated body instead of the clean 404 the check existed to
  // produce. The descriptor is what actually keeps the bytes reachable across an
  // unlink; the check never could.
  //
  // Ownership of the descriptor leaves with the stream, so the close rides on the
  // stream's lifetime rather than on a try/finally the way restoreVersion's does.
  // autoClose is left at its DEFAULT (true), which closes the handle by calling
  // FileHandle.close() — not by closing the raw fd behind the wrapper's back. So
  // ownership can simply travel with the stream: no explicit close, and no
  // FileHandle left for the GC to finalize (Node warns on that today under
  // DEP0137 and will throw later). Verified by spying on the handle's close, and
  // by the suite being free of that warning.
  //
  // What this DOES require is that every caller either consumes the stream or
  // destroys it. All three do — both download handlers pipe it and destroy it on
  // HEAD, and the diff handler consumes it, destroys it when the revision is too
  // large, and now checks the mime type BEFORE acquiring it. A caller that takes
  // a stream and simply drops it leaks a descriptor, which is worth knowing when
  // adding a fourth.
  async getVersionStream(user: UserModel, space: SpaceEnv, versionId: number): Promise<{ stream: Readable; version: VersionRow }> {
    const version = await this.requireVersionFor(user, space, versionId)
    const blobPath = blobPathFromRoot(version.versionsRoot, version.checksum)
    const handle = blobPath ? await fs.open(blobPath, 'r').catch(() => null) : null
    if (!handle) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version content not found')
    }
    const stream = handle.createReadStream()
    return { stream, version }
  }

  // The live file, for the diff endpoint's `against=current`. Lives here rather
  // than in the controller so the controller never builds a filesystem path of
  // its own — space.realPath is the only path any of this touches, and it was
  // produced and authorized by the space guard.
  async liveContent(space: SpaceEnv): Promise<{ stream: Readable; size: number }> {
    const stats = await fs.stat(space.realPath).catch(() => null)
    if (!stats?.isFile()) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Location not found')
    }
    return { stream: createReadStream(space.realPath), size: stats.size }
  }

  async versionsUsage(user: UserModel, space: SpaceEnv): Promise<VersionsUsage> {
    const versionsRoot = versionsRootFromSpace(user, space)
    if (!this.enabled || !versionsRoot) return { used: 0, ceiling: null, count: 0 }
    const { used, count } = await this.queries.usageByRoot(versionsRoot)
    const share = this.config.quotaShare
    // The reported ceiling comes from rootQuota — the SAME function
    // enforceQuotaShare uses — so the number the UI shows is the number that
    // will actually be applied. Recomputing it from space.storageQuota alone
    // reported a cap for the scope-mismatch case rootQuota deliberately skips
    // (a share with an external path), i.e. a limit nothing would ever enforce.
    // `null` here means "no eager cap applies", which the panel renders as an
    // uncapped byte count instead of inventing a number.
    const quota = this.rootQuota(user, space, versionsRoot)
    return {
      used,
      count,
      ceiling: share && quota ? quota * share : null
    }
  }

  /* ----------------------------------------------------------------- writes */

  // Restores a version into the live file.
  //
  // The current content is snapshotted first (origin `restore`), so a restore
  // is never destructive — you can always get back to where you were.
  //
  // THE LIVE FILE'S INODE MUST SURVIVE. Both editors deliberately use
  // copyFileContent rather than a move "to avoid inode changes"
  // (collabora-online-manager.service.ts:135, only-office-manager.service.ts:407)
  // because trash retention keys records on inodes and dbFileHash/file.id
  // consumers depend on inode stability. copyFileContent truncates in place via
  // flag 'w' (files/utils/files.ts:253,293), preserving the inode; moveFiles
  // would replace it. Do not "optimize" this into a rename (ADR §9).
  //
  // THE BLOB IS OPENED BEFORE ANYTHING ELSE RUNS, and the live file is written
  // from that descriptor rather than from the path. An earlier version resolved
  // the path, checked it existed, and only then took the snapshot — a
  // check-then-act that lost data: the snapshot's own quota eviction picks the
  // oldest unlabeled version, which is very often exactly the old revision the
  // user asked to restore. It unlinked the blob, and the write then truncated
  // the live file to zero bytes before failing to read its source. An open
  // descriptor keeps the bytes alive across an unlink, so eviction can no
  // longer pull them away mid-restore.
  async restoreVersion(user: UserModel, space: SpaceEnv, versionId: number): Promise<void> {
    const version = await this.requireVersionForWrite(user, space, versionId)

    const blobPath = blobPathFromRoot(version.versionsRoot, version.checksum)
    const handle = blobPath ? await fs.open(blobPath, 'r').catch(() => null) : null
    if (!handle) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version content not found')
    }
    try {
      // Verify the blob before touching the live file: writeFromStream
      // truncates the destination as soon as the stream opens, so a short or
      // corrupt source must be caught while the live content is still intact.
      const blobStats = await handle.stat()
      if (blobStats.size !== version.size) {
        throw new FileError(HttpStatus.CONFLICT, 'Version content does not match its recorded size')
      }

      // A restore is always app-initiated, never a DAV write, so unlike the
      // webdav save path it always runs under a real server lock.
      //
      // `createOrRefresh`, NOT `create`. `create` treats ANY existing lock as a
      // conflict — including the caller's own — and the v2 text editor holds one
      // on every file it opens, which is the same screen that offers Restore. So
      // restoring a file you had open failed every time. `createOrRefresh`
      // refreshes your own lock and throws LockConflict only for someone else's,
      // which is why `files-manager.service.ts` uses it for its own write paths.
      const [created, lock] = await this.filesLockManager.createOrRefresh(user, space.dbFile, SERVER_NAME, DEPTH.RESOURCE)
      try {
        // `version.fileId` rather than a fourth resolution of the same id: the
        // guard above accepted this row only because its fileId is the id this
        // space env resolves to, so the `files` row provably exists (#349).
        await this.snapshotBeforeOverwrite(user, space, { origin: 'restore', fileId: version.fileId })
        // Same shape as copyFileContent (flag 'w', start 0 -> inode preserved),
        // but sourced from the pinned descriptor.
        await writeFromStream(space.realPath, handle.createReadStream({ autoClose: false }))
        const stats = await fs.stat(space.realPath)
        await this.updateFileRow(version.fileId, stats.size, stats.mtimeMs)
        FileEvent.emit('event', { user, space, action: ACTION.UPDATE, rPath: space.realPath })
      } finally {
        // Only release a lock this call took. A pre-existing one belongs to an
        // editor session that is still open — removing it would silently unlock
        // a file someone is editing.
        if (created) {
          await this.releaseLock(lock)
        }
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  async setLabel(user: UserModel, space: SpaceEnv, versionId: number, label: string | null): Promise<void> {
    const version = await this.requireVersionForWrite(user, space, versionId)
    await this.queries.setLabel(version.id, label?.trim() ? label.trim() : null)
  }

  // Deleting a LABELED version requires an explicit confirmation flag: a named
  // revision is exempt from every automatic pruning rule, so removing one is
  // always a deliberate act.
  async deleteVersion(user: UserModel, space: SpaceEnv, versionId: number, confirmLabeled = false): Promise<void> {
    const version = await this.requireVersionForWrite(user, space, versionId)
    if (version.label && !confirmLabeled) {
      throw new FileError(HttpStatus.CONFLICT, 'This version is named, confirmation is required to delete it')
    }
    await this.dropVersion(version)
  }

  /* ------------------------------------------------------------------ purge */

  // Purges every version of one file, blobs included.
  async purgeForFile(fileId: number): Promise<void> {
    if (!this.enabled) return
    await this.purgeForFileIds([fileId])
  }

  // Purge for a permanent delete, resolving ids the way deleteFiles will.
  //
  // MUST be called BEFORE filesQueries.deleteFiles: FK ordering requires it,
  // and afterwards the descendant ids are simply gone — deleteFiles removes
  // every child row in one regexp query, so there would be nothing left to
  // resolve and every child's history would leak (ADR §10).
  async purgeForPath(props: FileDBProps, isDir: boolean): Promise<void> {
    if (!this.enabled) return
    try {
      const fileIds = await this.queries.resolveFileIdsForDelete(props, isDir)
      await this.purgeForFileIds(fileIds)
    } catch (e) {
      // A failed purge must not block the user's delete; the retention GC's
      // dangling-row sweep will catch what is left behind.
      this.logger.error({ tag: this.purgeForPath.name, msg: `purge failed for ${props.path}: ${e}` })
    }
  }

  private async purgeForFileIds(fileIds: number[]): Promise<void> {
    if (!fileIds.length) return
    const rows = await this.queries.listByFileIds(fileIds)
    if (!rows.length) return
    await this.queries.deleteByFileIds(fileIds)
    // Rows are gone, so remaining refcounts are accurate: drop any blob that no
    // other version still points at.
    for (const blob of new Map(rows.map((r) => [`${r.versionsRoot}|${r.checksum}`, r])).values()) {
      await this.removeBlobIfUnreferenced(blob.checksum, blob.versionsRoot)
    }
    this.logger.log({ tag: this.purgeForFileIds.name, msg: `purged ${rows.length} versions for ${fileIds.length} file(s)` })
  }

  // Retention's entry point for removing a version. Deliberately a named
  // method rather than making dropVersion public: retention is the only caller
  // outside this class, and routing it through a documented seam keeps the
  // refcount-aware blob removal in one place instead of letting the scheduler
  // delete rows and blobs itself.
  async dropVersionForRetention(version: VersionRow): Promise<void> {
    return this.dropVersion(version)
  }

  // Deletes one version row and its blob if nothing else references it.
  private async dropVersion(version: VersionRow): Promise<void> {
    await this.queries.deleteById(version.id)
    await this.removeBlobIfUnreferenced(version.checksum, version.versionsRoot)
  }

  private async removeBlobIfUnreferenced(checksum: string, versionsRoot: string): Promise<void> {
    // Refcount is per (checksum, versionsRoot) because blobs are physically per
    // root — the same digest in two roots is two files, and counting them as
    // one would delete a blob another root still needs.
    if ((await this.queries.countByBlob(checksum, versionsRoot)) > 0) return
    const blobPath = blobPathFromRoot(versionsRoot, checksum)
    if (!blobPath) return
    try {
      await removeFiles(blobPath)
    } catch (e) {
      // Leave it for the orphan-blob GC rather than fail the caller.
      this.logger.warn({ tag: this.removeBlobIfUnreferenced.name, msg: `unable to remove blob ${blobPath}: ${e}` })
    }
  }

  /* ----------------------------------------------------------------- shared */

  // Loads a version and proves it belongs to the file the caller resolved.
  //
  // This is the authorization boundary for every by-id operation: the caller
  // supplies a version id, and it is only accepted if it hangs off the same
  // fileId the resolved space env points at. The denormalized scope columns are
  // deliberately NOT consulted — they are a stale-tolerant cache (ADR §15), so
  // basing access on them would be both wrong after a move and a privilege bug.
  private async requireVersionFor(user: UserModel, space: SpaceEnv, versionId: number): Promise<VersionRow> {
    if (!this.enabled) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Versioning is not enabled')
    }
    const fileId = await this.resolveFileId(user, space)
    const version = fileId ? await this.queries.getById(versionId) : undefined
    if (!version || version.fileId !== fileId) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version not found')
    }
    return version
  }

  // The WRITE-side guard: the version must hang off the file the caller resolved
  // AND the caller must be allowed to modify that file. Every by-id write goes
  // through this one seam (#349).
  //
  // Its value is structural, not the three lines it saves. The pair used to be a
  // convention repeated verbatim at each write method, which makes a fourth one
  // that forgets the permission half indistinguishable from getVersionStream
  // deliberately calling requireVersionFor alone — reads need no modify
  // permission. With this in place, "calls requireVersionFor directly" reads as
  // an explicit claim to be read-only.
  //
  // THE ORDER IS PART OF THE CONTRACT: existence first (404), permission second
  // (403). Both are FileError, which extends Error rather than HttpException, so
  // the status only becomes a status through the versioning exception filter —
  // swapping the order silently changes what every write endpoint answers for an
  // unknown id.
  private async requireVersionForWrite(user: UserModel, space: SpaceEnv, versionId: number): Promise<VersionRow> {
    const version = await this.requireVersionFor(user, space, versionId)
    this.requireModifyPermission(space)
    return version
  }

  // canModifySpaceEnv rather than a bare MODIFY check: it also refuses the trash
  // repository, which is read-only (space.guard.ts enforces the same rule for
  // every ADD/MODIFY request). Using the existing helper states the rule once
  // instead of restating half of it here.
  private requireModifyPermission(space: SpaceEnv): void {
    if (!canModifySpaceEnv(space)) {
      throw new FileError(HttpStatus.FORBIDDEN, 'Permission denied')
    }
  }

  // Resolves the file id for a space env WITHOUT materializing a row: reads
  // must never create one, or a listing request for a file with no history
  // would leave a row behind on every poll.
  private async resolveFileId(user: UserModel, space: SpaceEnv): Promise<number> {
    const stats = await fs.stat(space.realPath).catch(() => null)
    if (!stats?.isFile()) return 0
    const props = this.fileProps(space, stats.size, stats.mtimeMs)
    if (space.inPersonalSpace) {
      return (await this.filesQueries.getUserFileByPath(user.id, props.path, props.name)) || 0
    }
    return (await this.filesQueries.getSpaceFileId(props, space.dbFile)) || 0
  }

  // Builds the FileProps the ensurer and the id lookups expect from the space
  // env. space.dbFile.path is the full in-space path INCLUDING the filename, so
  // it splits into (dirName, fileName) — a root-level file yields path '.',
  // which is how `files.path` stores it.
  private fileProps(space: SpaceEnv, size: number, mtimeMs: number): FileProps {
    return {
      id: 0,
      path: dirName(space.dbFile.path),
      name: fileName(space.dbFile.path),
      isDir: false,
      size,
      mtime: Math.floor(mtimeMs),
      ctime: Math.floor(mtimeMs),
      mime: getMimeType(space.realPath, false)
    } as FileProps
  }

  private scopeOf(dbFile: FileDBProps) {
    return {
      ownerId: dbFile.ownerId || null,
      spaceId: dbFile.spaceId || null,
      spaceExternalRootId: dbFile.spaceExternalRootId || null,
      shareExternalId: dbFile.shareExternalId || null
    }
  }

  // Takes the id rather than re-resolving it from the space env: restoreVersion,
  // its only caller, already holds a proven one from its guard, and the lookup
  // this used to do was the third resolution of the same file in one call (#349).
  private async updateFileRow(fileId: number, size: number, mtimeMs: number): Promise<void> {
    if (!fileId) return
    await this.filesQueries.updateFile(fileId, { size, mtime: Math.floor(mtimeMs) })
  }

  private async releaseLock(lock: FileLock): Promise<void> {
    try {
      await this.filesLockManager.removeLock(lock.key)
    } catch (e) {
      this.logger.warn({ tag: this.releaseLock.name, msg: `Failed to remove lock ${lock.key}: ${e}` })
    }
  }
}
