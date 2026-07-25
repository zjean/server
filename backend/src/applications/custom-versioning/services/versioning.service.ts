import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import fs from 'node:fs/promises'
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
import { LockConflict } from '../../files/models/file-lock-error'
import { FileEvent } from '../../files/events/file-events'
import { FilesLockManager } from '../../files/services/files-lock-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { FilesVersionsConfig } from '../../files/files.config'
import { checksumFile, copyFileContent, dirName, fileName, getMimeType, isPathExists, makeDir, removeFiles } from '../../files/utils/files'
import { SPACE_OPERATION } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { haveSpaceEnvPermissions } from '../../spaces/utils/permissions'
import { SYNC_CHECKSUM_ALG } from '../../sync/constants/sync'
import { UserModel } from '../../users/models/user.model'
import { DEPTH } from '../../webdav/constants/webdav'
import { SnapshotOptions, VersionProps, VersionRow, VersionsUsage } from '../interfaces/version.interface'
import { blobPathFromRoot, versionsRootFromSpace } from '../utils/paths'
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

    const fileId = await this.fileRowEnsurer.ensureFileId(user, space, this.fileProps(space, stats.size, stats.mtimeMs))
    if (!fileId) {
      // The ensurer already logged the cause and returns 0 rather than throwing.
      this.logger.warn({ tag: this.snapshot.name, msg: `no file id for ${space.url}, skipping snapshot` })
      return
    }

    if (await this.isCoalesced(fileId, user.id, options)) {
      this.logger.verbose({ tag: this.snapshot.name, msg: `coalesced ${space.url} (${options.origin})` })
      return
    }

    const checksum = await checksumFile(space.realPath, SYNC_CHECKSUM_ALG)
    const scope = this.scopeOf(space.dbFile)

    await this.enforceQuotaShare(space, versionsRoot, stats.size)

    // Blob first, row second. A crash between the two leaves an orphan blob,
    // which the retention GC sweeps; the reverse order would leave a version
    // row pointing at nothing — a visible, un-downloadable entry.
    await this.writeBlob(space.realPath, versionsRoot, checksum)

    await this.queries.insertVersion({
      fileId,
      ...scope,
      versionsRoot,
      checksum,
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs),
      authorId: user.id ?? null,
      origin: options.origin,
      label: null
    })
    this.logger.verbose({ tag: this.snapshot.name, msg: `versioned ${space.url} (${options.origin}) ${checksum.slice(0, 12)}` })
  }

  // Skips the snapshot when the newest version for (fileId, authorId, origin)
  // is younger than the window AND unlabeled — the pre-session state is already
  // captured, so an editor autosaving every 30s does not mint a version each
  // time. A labeled newest version never coalesces: suppressing here would let
  // a named revision silently swallow the next real change.
  private async isCoalesced(fileId: number, authorId: number | null, options: SnapshotOptions): Promise<boolean> {
    const window = this.config.minIntervalSeconds
    if (!window || window <= 0) return false
    const newest = await this.queries.newestForTuple(fileId, authorId ?? null, options.origin)
    if (!newest || newest.label) return false
    const ageSeconds = (Date.now() - new Date(newest.createdAt).getTime()) / 1000
    return ageSeconds < window
  }

  // Keeps total version bytes in this root at or under quota * quotaShare by
  // evicting oldest-unlabeled-first BEFORE inserting.
  //
  // This is the honest half of ADR §7: it bounds how much quota history can
  // consume, and it does NOT promise the user's save will succeed — the
  // pre-flight guard in space.guard.ts runs long before any of this and reads a
  // day-old cached dirSize. Never claim otherwise.
  private async enforceQuotaShare(space: SpaceEnv, versionsRoot: string, incomingSize: number): Promise<void> {
    const share = this.config.quotaShare
    if (!share || !space.storageQuota) return
    const ceiling = space.storageQuota * share

    let { used } = await this.queries.usageByRoot(versionsRoot)
    while (used + incomingSize > ceiling) {
      const victim = await this.queries.oldestUnlabeledByRoot(versionsRoot)
      if (!victim) {
        // Everything left is labeled. Labeled versions are never evicted, so
        // accept the overshoot rather than destroy a named revision.
        this.logger.warn({
          tag: this.enforceQuotaShare.name,
          msg: `${versionsRoot} is at the versions quota ceiling but only labeled versions remain, keeping them`
        })
        return
      }
      await this.dropVersion(victim)
      used -= victim.size
      // Logged at `log`, not verbose: silently deleting a user's history
      // deserves an audit trail.
      this.logger.log({
        tag: this.enforceQuotaShare.name,
        msg: `evicted version ${victim.id} (${victim.size} bytes) from ${versionsRoot} to stay under the versions quota share`
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
  // Dedup is free: an existing blob is byte-identical by construction, so
  // there is nothing to write.
  private async writeBlob(realPath: string, versionsRoot: string, checksum: string): Promise<void> {
    const blobPath = blobPathFromRoot(versionsRoot, checksum)
    if (!blobPath) {
      throw new Error(`unable to resolve a blob path in ${versionsRoot}`)
    }
    if (await isPathExists(blobPath)) return
    await makeDir(dirName(blobPath), true)
    // Stage then rename: a crash mid-copy must not leave a TRUNCATED file at
    // the content-addressed path, because the existence check above would then
    // trust it as a complete blob forever. Rename within one directory is
    // atomic, and the random suffix keeps concurrent snapshots of the same
    // digest from staging over each other.
    const stagePath = `${blobPath}.${randomUUID()}.part`
    try {
      await fs.copyFile(realPath, stagePath, fsConstants.COPYFILE_FICLONE)
      await fs.rename(stagePath, blobPath)
    } catch (e) {
      await removeFiles(stagePath).catch(() => undefined)
      // Another snapshot of the same content won the race — that blob is
      // byte-identical, so this is success, not failure.
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST' && (await isPathExists(blobPath))) return
      throw e
    }
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

  async getVersionStream(user: UserModel, space: SpaceEnv, versionId: number): Promise<{ stream: Readable; version: VersionRow }> {
    const version = await this.requireVersionFor(user, space, versionId)
    const blobPath = blobPathFromRoot(version.versionsRoot, version.checksum)
    if (!blobPath || !(await isPathExists(blobPath))) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version content not found')
    }
    return { stream: createReadStream(blobPath), version }
  }

  async versionsUsage(user: UserModel, space: SpaceEnv): Promise<VersionsUsage> {
    const versionsRoot = versionsRootFromSpace(user, space)
    if (!this.enabled || !versionsRoot) return { used: 0, ceiling: null, count: 0 }
    const { used, count } = await this.queries.usageByRoot(versionsRoot)
    const share = this.config.quotaShare
    return {
      used,
      count,
      ceiling: share && space.storageQuota ? space.storageQuota * share : null
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
  async restoreVersion(user: UserModel, space: SpaceEnv, versionId: number): Promise<void> {
    const version = await this.requireVersionFor(user, space, versionId)
    this.requireModifyPermission(space)

    const blobPath = blobPathFromRoot(version.versionsRoot, version.checksum)
    if (!blobPath || !(await isPathExists(blobPath))) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version content not found')
    }

    // A restore is always app-initiated, never a DAV write, so unlike the
    // webdav save path it always runs under a real server lock.
    const [ok, lock] = await this.filesLockManager.create(user, space.dbFile, SERVER_NAME, DEPTH.RESOURCE)
    if (!ok) {
      throw new LockConflict(lock, 'Conflicting lock')
    }
    try {
      await this.snapshotBeforeOverwrite(user, space, { origin: 'restore' })
      await copyFileContent(blobPath, space.realPath)
      const stats = await fs.stat(space.realPath)
      await this.updateFileRow(user, space, stats.size, stats.mtimeMs)
      FileEvent.emit('event', { user, space, action: ACTION.UPDATE, rPath: space.realPath })
    } finally {
      await this.releaseLock(lock)
    }
  }

  async setLabel(user: UserModel, space: SpaceEnv, versionId: number, label: string | null): Promise<void> {
    const version = await this.requireVersionFor(user, space, versionId)
    this.requireModifyPermission(space)
    await this.queries.setLabel(version.id, label?.trim() ? label.trim() : null)
  }

  // Deleting a LABELED version requires an explicit confirmation flag: a named
  // revision is exempt from every automatic pruning rule, so removing one is
  // always a deliberate act.
  async deleteVersion(user: UserModel, space: SpaceEnv, versionId: number, confirmLabeled = false): Promise<void> {
    const version = await this.requireVersionFor(user, space, versionId)
    this.requireModifyPermission(space)
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

  private requireModifyPermission(space: SpaceEnv): void {
    if (!haveSpaceEnvPermissions(space, SPACE_OPERATION.MODIFY)) {
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

  private async updateFileRow(user: UserModel, space: SpaceEnv, size: number, mtimeMs: number): Promise<void> {
    const fileId = await this.resolveFileId(user, space)
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
