import { Inject, Injectable } from '@nestjs/common'
import { and, asc, count, countDistinct, desc, eq, inArray, isNull, lt, sql, sum } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { convertToWhere, dbGetInsertedId } from '../../../infrastructure/database/utils'
import { FileDBProps } from '../../files/interfaces/file-db-props.interface'
import { childFilesMatch, files } from '../../files/schemas/files.schema'
import { dirName, fileName } from '../../files/utils/files'
import { userFullNameSQL, users } from '../../users/schemas/users.schema'
import { VersionInsert, VersionOrigin, VersionRow } from '../interfaces/version.interface'
import { customFilesVersions } from '../schemas/files-versions.schema'

// The handle drizzle hands a transaction callback. Derived rather than named so
// it cannot drift from the DBSchema this class is injected with.
type DBTransaction = Parameters<Parameters<DBSchema['transaction']>[0]>[0]

// All SQL for custom_files_versions lives here, keeping VersioningService about
// orchestration only — the same split upstream uses (FilesQueries /
// FilesManager) and custom-favorites uses (FavoritesQueries /
// FavoritesManager).
@Injectable()
export class VersioningQueries {
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  /* ------------------------------------------------- blob publish / release */
  //
  // THE THREE METHODS BELOW ARE ONE MECHANISM, and the reason they take a
  // callback instead of returning a decision is the whole point: the
  // filesystem step has to happen while the database still holds the state the
  // decision was made from (#489).
  //
  // The race they close: `removeBlobIfUnreferenced` used to count rows and then
  // unlink, while a snapshot published its blob and then inserted its row.
  // Interleaved, a refcount of 0 means "not referenced YET" — the unlink lands
  // on bytes a row is about to point at, and that version lists but 404s on
  // download and restore.
  //
  // It is closed by two changes that only work together:
  //
  //   1. THE ROW GOES IN BEFORE THE BLOB, inside a transaction. On its own this
  //      would violate the ADR's "blob first, row second" rule, whose reason is
  //      that a crash between the two must never leave a committed row pointing
  //      at nothing. A transaction preserves exactly that: the row is committed
  //      only after the rename returned, and a failure or a crash in between
  //      rolls it back. The residual case is the reverse — a commit that fails
  //      after a successful rename — which leaves an orphan blob, the harmless
  //      direction the nightly sweep already owns.
  //
  //      What the inversion buys is that a blob can no longer be on disk while
  //      its row is invisible: by the time the rename runs, the row exists and
  //      is exclusively locked by this transaction.
  //
  //   2. THE DROPPER'S DELETE, REFCOUNT AND UNLINK ARE ONE TRANSACTION, and the
  //      refcount is a LOCKING read. A plain SELECT would answer from the
  //      transaction's REPEATABLE READ snapshot and miss a row committed after
  //      it started; `for('update')` reads the latest committed version AND
  //      blocks on rows another transaction is still writing. So a publisher
  //      that has inserted — committed or not — is always either seen or waited
  //      for.
  //
  // The remaining order is publisher-second: the dropper's locking read runs
  // over a (checksum, versionsRoot) range the publisher has not inserted into
  // yet. Under REPEATABLE READ — MariaDB's and MySQL's default, and what this
  // deployment runs — that read takes a next-key lock on the range, so the
  // publisher's INSERT waits for the dropper to commit and then re-publishes
  // the bytes.
  //
  // UNDER READ COMMITTED THIS IS NOT CLOSED, AND NOTHING REPAIRS IT. There is
  // no gap lock, so the dropper can unlink bytes the publisher is about to
  // name, leaving a committed row pointing at nothing — the one outcome the
  // ADR forbids. An earlier version of this comment offered the nightly sweep
  // as "the backstop either way", which is wrong and worth stating plainly:
  // `danglingRows` removes rows whose FILES row is gone, not rows whose BLOB
  // is gone, and no rule looks for the latter — deleting a row because its
  // bytes are missing is itself destructive, so none should. The damage is
  // bounded to that one version and surfaces as a 404 on its download,
  // restore and diff.
  //
  // So the isolation level is a deployment requirement of this feature, not a
  // performance preference. If this server is ever run against a database
  // configured for READ COMMITTED, close the window on the publisher side
  // some other way — a unique index on (checksum, versionsRoot, fileId, id)
  // read with a locking point read would do it without the range-lock
  // deadlock below, and is the direction to take, not the removed lock.
  //
  // WHAT IS DELIBERATELY *NOT* HERE: a matching locking read on the publisher
  // side. It closes the READ COMMITTED gap, and it deadlocks — two snapshots of
  // different content take gap locks on the same index gap (neither conflicts),
  // then each blocks on the other's gap lock trying to insert into it. Measured,
  // not theorised: it produced two `Innodb_deadlocks` per e2e run and silently
  // cost those saves their version, because `snapshotBeforeOverwrite` swallows
  // everything by design.

  // Inserts a version row and publishes its blob as one atomic step.
  //
  // `publishBlob` runs INSIDE the transaction, so it must be the cheap half of
  // the write — the copy and the hash happen before this is called, and only
  // the same-filesystem rename is in here.
  //
  // `contentAuthorId` IS RESOLVED HERE, not by the caller (#491). It is derived
  // from the newest existing row for this file, so reading it outside the
  // transaction — which is what evaluating it as an argument does — widens the
  // window in which two concurrent snapshots of the same file observe the same
  // predecessor and both claim it. Reading it as the transaction's first
  // statement narrows that window to the transaction itself.
  //
  // It does NOT eliminate it, and deliberately so: only a locking read would,
  // and a locking read on the publisher side is the one thing the header above
  // records as measured-and-removed for deadlocking two concurrent snapshots
  // against each other. The residual is one row attributing content to the
  // wrong one of two people who saved the same file in the same instant —
  // strictly better than the off-by-one this column replaces, and not worth a
  // deadlock.
  async insertVersionPublishing(values: Omit<VersionInsert, 'contentAuthorId'>, publishBlob: () => Promise<void>): Promise<number> {
    return this.db.transaction(async (tx) => {
      const contentAuthorId = await this.lastAuthorIdForFile(values.fileId, tx)
      const versionId = dbGetInsertedId(await tx.insert(customFilesVersions).values({ ...values, contentAuthorId }))
      await publishBlob()
      return versionId
    })
  }

  // Deletes one row and, still holding the lock, unlinks its blob if nothing
  // else references it.
  async deleteByIdReleasingBlob(versionId: number, checksum: string, versionsRoot: string, unlinkBlob: () => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(customFilesVersions).where(eq(customFilesVersions.id, versionId))
      if (await this.blobIsUnreferenced(tx, checksum, versionsRoot)) await unlinkBlob()
    })
  }

  // The purge equivalent: every row of a set of files goes, then each distinct
  // blob they referenced is released if nothing else points at it.
  //
  // The bulk DELETE is inside the transaction for the same reason the single
  // one is — it is the delete that holds the locks the checks depend on, so
  // splitting them would reopen #489 on the purge path.
  async deleteByFileIdsReleasingBlobs(
    fileIds: number[],
    blobs: { checksum: string; versionsRoot: string }[],
    unlinkBlob: (checksum: string, versionsRoot: string) => Promise<void>
  ): Promise<void> {
    if (!fileIds.length) return
    await this.db.transaction(async (tx) => {
      await tx.delete(customFilesVersions).where(inArray(customFilesVersions.fileId, fileIds))
      for (const blob of blobs) {
        if (await this.blobIsUnreferenced(tx, blob.checksum, blob.versionsRoot)) await unlinkBlob(blob.checksum, blob.versionsRoot)
      }
    })
  }

  // Refcount is per (checksum, versionsRoot) because blobs are physically per
  // root — the same digest in two roots is two files, and counting them as one
  // would delete a blob another root still needs.
  private async blobIsUnreferenced(tx: DBTransaction, checksum: string, versionsRoot: string): Promise<boolean> {
    const rows = await tx
      .select({ id: customFilesVersions.id })
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.checksum, checksum), eq(customFilesVersions.versionsRoot, versionsRoot)))
      .limit(1)
      .for('update')
    return rows.length === 0
  }

  // Newest version for the coalescing tuple. Returns the row so the caller can
  // check `label` — a labeled version must never suppress a snapshot, or a
  // named revision would silently swallow the next real change.
  async newestForTuple(fileId: number, authorId: number | null, origin: VersionOrigin): Promise<VersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(customFilesVersions)
      .where(
        and(
          eq(customFilesVersions.fileId, fileId),
          authorId === null ? isNull(customFilesVersions.authorId) : eq(customFilesVersions.authorId, authorId),
          eq(customFilesVersions.origin, origin)
        )
      )
      .orderBy(desc(customFilesVersions.createdAt), desc(customFilesVersions.id))
      .limit(1)
    return row
  }

  // History for a file, newest first, with BOTH author identities joined.
  //
  // Two joins because the row carries two different people and each has a
  // reader (#491):
  //   - `contentAuthorId` wrote the bytes this row holds. That is the author a
  //     version list must show, and showing `authorId` instead is what
  //     attributed every revision to whoever came next.
  //   - `authorId` replaced them. Only the NEWEST row's value is interesting,
  //     and it is interesting precisely because it names the author of the
  //     content that is live right now — which is what the OnlyOffice history
  //     panel labels its "current" entry with.
  async listByFileId(fileId: number): Promise<
    (VersionRow & {
      authorLogin: string | null
      authorFullName: string | null
      supersededByLogin: string | null
      supersededByFullName: string | null
    })[]
  > {
    const contentAuthor = alias(users, 'contentAuthor')
    return this.db
      .select({
        ...columnsOf(),
        authorLogin: contentAuthor.login,
        authorFullName: userFullNameSQL(contentAuthor),
        supersededByLogin: users.login,
        supersededByFullName: userFullNameSQL(users)
      })
      .from(customFilesVersions)
      .leftJoin(contentAuthor, eq(contentAuthor.id, customFilesVersions.contentAuthorId))
      .leftJoin(users, eq(users.id, customFilesVersions.authorId))
      .where(eq(customFilesVersions.fileId, fileId))
      .orderBy(desc(customFilesVersions.createdAt), desc(customFilesVersions.id))
  }

  // The `authorId` of the LAST row inserted for this file — i.e. whoever
  // performed the write that produced the content a snapshot is about to
  // supersede (#491). Null when the file has no history yet, or when that
  // write had no acting user.
  //
  // Ordered by `id`, not by `createdAt` or `mtime`. The question is strictly
  // "which row was written most recently", the primary key answers it
  // unambiguously, and `mtime` in particular is client-controlled and not
  // monotonic. Not root-scoped either: a file moved between spaces has rows in
  // two roots, and its authorship chain runs through both.
  //
  // Takes an optional transaction handle so `insertVersionPublishing` can read
  // the predecessor inside the same transaction that inserts — see there.
  async lastAuthorIdForFile(fileId: number, tx: DBTransaction | DBSchema = this.db): Promise<number | null> {
    const [row] = await tx
      .select({ authorId: customFilesVersions.authorId })
      .from(customFilesVersions)
      .where(eq(customFilesVersions.fileId, fileId))
      .orderBy(desc(customFilesVersions.id))
      .limit(1)
    return row?.authorId ?? null
  }

  async getById(versionId: number): Promise<VersionRow | undefined> {
    const [row] = await this.db.select().from(customFilesVersions).where(eq(customFilesVersions.id, versionId)).limit(1)
    return row
  }

  async setLabel(versionId: number, label: string | null): Promise<void> {
    await this.db.update(customFilesVersions).set({ label }).where(eq(customFilesVersions.id, versionId))
  }

  // Keeps the denormalized scope columns fresh. They are a non-authoritative
  // cache (ADR §15), so this is opportunistic — never a correctness
  // requirement, which is why nothing schedules it.
  async refreshScope(fileId: number, scope: Pick<VersionInsert, 'ownerId' | 'spaceId' | 'spaceExternalRootId' | 'shareExternalId'>): Promise<void> {
    await this.db.update(customFilesVersions).set(scope).where(eq(customFilesVersions.fileId, fileId))
  }

  // Repoints every row of one versions root at another (#471).
  //
  // `versionsRoot` is derived from a MUTABLE name — a user login or a space
  // alias — and renaming either MOVES THE WHOLE HOME DIRECTORY, the versions
  // store inside it included. The rows are the only thing that does not travel
  // with it, and rows that disagree with the disk are not merely unreadable:
  // the nightly orphan sweep enumerates the DISK, finds the new name, asks for
  // a refcount under it, gets 0 for every blob because the rows still say the
  // old one, and unlinks the entire store.
  //
  // A plain UPDATE rather than a per-row loop: the rename is one logical act
  // and the (versionsRoot, label, createdAt) index already covers the predicate.
  //
  // Returns how many rows moved, which the caller logs — a rename of a root
  // that never held history is a legitimate 0, not a failure.
  async renameRoot(oldVersionsRoot: string, newVersionsRoot: string): Promise<number> {
    if (oldVersionsRoot === newVersionsRoot) return 0
    const [header] = await this.db
      .update(customFilesVersions)
      .set({ versionsRoot: newVersionsRoot })
      .where(eq(customFilesVersions.versionsRoot, oldVersionsRoot))
    return Number((header as { affectedRows?: number })?.affectedRows ?? 0)
  }

  async deleteById(versionId: number): Promise<void> {
    await this.db.delete(customFilesVersions).where(eq(customFilesVersions.id, versionId))
  }

  // Blob refcount, scoped to the root. Dedup is PER versions root because
  // blobs are physically per root — a digest shared across two roots is two
  // files on disk and must not be treated as one.
  async countByBlob(checksum: string, versionsRoot: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.checksum, checksum), eq(customFilesVersions.versionsRoot, versionsRoot)))
    return Number(row?.n ?? 0)
  }

  // The same refcount asked of a SET of roots at once, for the blob sweep's
  // rename tripwire (#471).
  //
  // WHY A SECOND, DELIBERATELY UNSCOPED COUNT EXISTS. `countByBlob` answers
  // "does anything in THIS root still need these bytes", which is the right
  // question while the rows and the disk agree. After an unrepointed rename
  // they do not: the store physically moved with the home directory, so the
  // blobs now sitting under `user:bob` are the very bytes `user:alice`'s rows
  // describe, and the per-root count answers 0 for every one of them. This asks
  // the only question that distinguishes that from a genuine orphan — "is there
  // a row in a root whose store has GONE MISSING that names these bytes" — and
  // the caller passes exactly that set of stranded roots.
  //
  // Empty set is a short-circuit rather than an `IN ()`: on a healthy instance
  // there are no stranded roots and this must cost nothing.
  async countByBlobInRoots(checksum: string, versionsRoots: string[]): Promise<number> {
    if (!versionsRoots.length) return 0
    const [row] = await this.db
      .select({ n: count() })
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.checksum, checksum), inArray(customFilesVersions.versionsRoot, versionsRoots)))
    return Number(row?.n ?? 0)
  }

  // SUM(size) for the quota cap — an indexed aggregate, deliberately NOT a
  // dirSize walk of the store (ADR §7).
  //
  // `labeledBytes` is what makes the cap safe: labeled versions are never
  // evictable, so an eviction loop that does not know how much of `used` is
  // unevictable can chase a ceiling it can never reach and destroy every
  // unlabeled version trying. Both callers need that number, so it is computed
  // in the same pass over the (versionsRoot, label, createdAt) index.
  async usageByRoot(versionsRoot: string): Promise<{ used: number; labeledBytes: number; count: number }> {
    const [row] = await this.db
      .select({
        used: sum(customFilesVersions.size),
        labeled: labeledBytesSQL(),
        n: count()
      })
      .from(customFilesVersions)
      .where(eq(customFilesVersions.versionsRoot, versionsRoot))
    return { used: Number(row?.used ?? 0), labeledBytes: Number(row?.labeled ?? 0), count: Number(row?.n ?? 0) }
  }

  // Is there ANY version in this root of exactly this logical size?
  //
  // The dedup half of the write-path pre-flight (#339). A snapshot whose blob
  // already exists costs zero disk bytes, so the quota cap lets it through at
  // any size — but the digest is only known after the copy has been made, which
  // is the whole reason the cap runs post-staging. Identical content implies
  // identical size, so a root holding no row of this size cannot possibly dedup
  // this content, and an over-ceiling write can be declined without copying it.
  // The converse does not hold — same length, different bytes — so a hit means
  // only "stage it and let enforceQuotaShare decide", exactly as before.
  //
  // LIMIT 1 over the (versionsRoot, ...) index prefix, and it runs ONLY for a
  // write that already exceeds the ceiling: the path that used to pay a full
  // read + write + unlink to reach the same answer.
  async existsSizeInRoot(versionsRoot: string, size: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: customFilesVersions.id })
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.versionsRoot, versionsRoot), eq(customFilesVersions.size, size)))
      .limit(1)
    return !!row
  }

  // Instance-wide totals for the admin panel (#342) — ONE aggregate over the
  // table, deliberately not distinctRoots() followed by N usageByRoot() calls.
  //
  // Reports the same three figures usageByRoot does, plus how many roots and
  // files they are spread over, so the panel's summary line and its per-root
  // table cannot define "used" or "labeled" differently.
  async usageTotals(): Promise<{ used: number; labeledBytes: number; count: number; roots: number; files: number }> {
    const [row] = await this.db
      .select({
        used: sum(customFilesVersions.size),
        labeled: labeledBytesSQL(),
        n: count(),
        roots: countDistinct(customFilesVersions.versionsRoot),
        files: countDistinct(customFilesVersions.fileId)
      })
      .from(customFilesVersions)
    return {
      used: Number(row?.used ?? 0),
      labeledBytes: Number(row?.labeled ?? 0),
      count: Number(row?.n ?? 0),
      roots: Number(row?.roots ?? 0),
      files: Number(row?.files ?? 0)
    }
  }

  // usageByRoot for EVERY root at once, heaviest first, capped at `limit` — the
  // "which users and spaces are the heavy consumers" question (#342).
  //
  // Ordered by SUM(size), i.e. by the same number the quota cap charges, so the
  // ranking answers "who is eating quota" rather than "who has the most rows".
  async usageByAllRoots(limit: number): Promise<{ versionsRoot: string; used: number; labeledBytes: number; count: number; files: number }[]> {
    const rows = await this.db
      .select({
        versionsRoot: customFilesVersions.versionsRoot,
        used: sum(customFilesVersions.size),
        labeled: labeledBytesSQL(),
        n: count(),
        files: countDistinct(customFilesVersions.fileId)
      })
      .from(customFilesVersions)
      .groupBy(customFilesVersions.versionsRoot)
      .orderBy(desc(sum(customFilesVersions.size)))
      .limit(limit)
    return rows.map((r) => ({
      versionsRoot: r.versionsRoot,
      used: Number(r.used ?? 0),
      labeledBytes: Number(r.labeled ?? 0),
      count: Number(r.n ?? 0),
      files: Number(r.files ?? 0)
    }))
  }

  // Oldest-first UNLABELED versions in one root. Labeled versions are never
  // candidates for anything automatic, and are equally never candidates for the
  // admin purge — the exemption is encoded HERE, in the candidate query, rather
  // than restated at each caller, which is how this feature produced the same
  // data-loss bug twice.
  //
  // Paged for the same reason unlabeledOlderThan is: a heavy root can hold a
  // very large number of rows and each removal costs a DELETE, a refcount COUNT
  // and possibly an unlink.
  async unlabeledByRootOldestFirst(versionsRoot: string, limit: number): Promise<VersionRow[]> {
    return this.db
      .select()
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.versionsRoot, versionsRoot), isNull(customFilesVersions.label)))
      .orderBy(asc(customFilesVersions.createdAt), asc(customFilesVersions.id))
      .limit(limit)
  }

  // Eviction candidate for the quota cap: oldest UNLABELED version in the root.
  // Labeled versions are never evicted, even at the ceiling.
  //
  // The same query as unlabeledByRootOldestFirst with limit 1, and delegating
  // says so: if the eviction order ever changes it must change for both, since
  // the eager cap and the admin purge remove rows from the same end of the same
  // list.
  async oldestUnlabeledByRoot(versionsRoot: string): Promise<VersionRow | undefined> {
    const [row] = await this.unlabeledByRootOldestFirst(versionsRoot, 1)
    return row
  }

  async listByFileIds(fileIds: number[]): Promise<VersionRow[]> {
    if (!fileIds.length) return []
    return this.db.select().from(customFilesVersions).where(inArray(customFilesVersions.fileId, fileIds))
  }

  async deleteByFileIds(fileIds: number[]): Promise<void> {
    if (!fileIds.length) return
    await this.db.delete(customFilesVersions).where(inArray(customFilesVersions.fileId, fileIds))
  }

  // Resolves the `files` ids a delete is about to remove, so their versions can
  // be purged BEFORE filesQueries.deleteFiles runs — required both by FK
  // ordering and because descendant ids stop being resolvable afterwards.
  //
  // Mirrors deleteFiles (files-queries.service.ts:193-232) exactly: the target
  // itself is matched by (scope, dirName(path), fileName(path), isDir), and for
  // a directory its descendants are matched by (scope, childFilesMatch).
  // A single regexp query covers every depth, which is why purging by the
  // target id alone would silently leave every child's history orphaned.
  async resolveFileIdsForDelete(props: FileDBProps, isDir: boolean): Promise<number[]> {
    const commonProps: Omit<FileDBProps, 'path'> = {
      ownerId: props.ownerId || null,
      spaceId: props.spaceId || null,
      spaceExternalRootId: props.spaceExternalRootId || null,
      shareExternalId: props.shareExternalId || null,
      inTrash: props.inTrash
    }
    const targetProps: FileDBProps & { name: string; isDir: boolean } = {
      ...commonProps,
      path: dirName(props.path),
      name: fileName(props.path),
      isDir
    }

    const ids = new Set<number>()
    for (const row of await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(...convertToWhere(files, targetProps)))) {
      ids.add(row.id)
    }
    if (isDir) {
      for (const row of await this.db
        .select({ id: files.id })
        .from(files)
        .where(and(...convertToWhere(files, commonProps), childFilesMatch(props.path)))) {
        ids.add(row.id)
      }
    }
    return [...ids]
  }

  // --- retention / GC support (B5) ---

  // EVERY version of one file within one root, newest first, labels included.
  // The thinner needs labeled rows in the list: it filters them itself, and
  // handing it a pre-filtered list would make a labeled version invisible in a
  // way that changes nothing today but would silently diverge if the thinner
  // ever anchored spacing on labels.
  //
  // Unpaged, deliberately. The row count for ONE file is bounded by the thinner
  // itself on every write, so the pathological case this would page for cannot
  // persist past the next save. The query is root-scoped for the same reason
  // every retention query here is: a file whose versions span two roots (it was
  // moved between spaces) has a different total per root, so a GLOBAL read
  // would over-thin in one root while under-thinning in the other.
  async byFileIdNewestFirst(versionsRoot: string, fileId: number): Promise<VersionRow[]> {
    return this.db
      .select()
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.versionsRoot, versionsRoot), eq(customFilesVersions.fileId, fileId)))
      .orderBy(desc(customFilesVersions.mtime), desc(customFilesVersions.id))
  }

  // Paged: the FIRST run after enabling retention on a populated install can
  // match a very large number of rows, and each one costs a DELETE, a refcount
  // COUNT and possibly an unlink. The caller loops until a page comes back
  // short. `limit` matches FilesTrashRetention's own batch size on purpose.
  async unlabeledOlderThan(versionsRoot: string, cutoff: Date, limit: number): Promise<VersionRow[]> {
    return this.db
      .select()
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.versionsRoot, versionsRoot), isNull(customFilesVersions.label), lt(customFilesVersions.createdAt, cutoff)))
      .orderBy(asc(customFilesVersions.createdAt), asc(customFilesVersions.id))
      .limit(limit)
  }

  // Every root that currently holds versions. Read from the versions table
  // rather than by enumerating users and spaces: a root with no history needs
  // no retention work, and this also naturally covers a root whose user or
  // space is gone.
  async distinctRoots(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ versionsRoot: customFilesVersions.versionsRoot }).from(customFilesVersions)
    return rows.map((r) => r.versionsRoot)
  }

  async distinctFileIdsByRoot(versionsRoot: string): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ fileId: customFilesVersions.fileId })
      .from(customFilesVersions)
      .where(eq(customFilesVersions.versionsRoot, versionsRoot))
    return rows.map((r) => r.fileId)
  }

  // Version rows whose `files` row is gone. This is how the trash-retention
  // case is absorbed: that service is filesystem-scan/inode based and holds no
  // files.id, so ADR §10 deliberately does NOT hook it — the dangling rows it
  // leaves behind are swept here instead of via a fragile inode<->id join.
  async danglingRows(limit = 1000): Promise<VersionRow[]> {
    return this.db
      .select({ ...columnsOf() })
      .from(customFilesVersions)
      .leftJoin(files, eq(files.id, customFilesVersions.fileId))
      .where(isNull(files.id))
      .limit(limit)
  }
}

// SUM over the LABELED rows' sizes only.
//
// Shared by all three aggregates on purpose. `labeledBytes` is what makes the
// eviction loop safe — it is how evictUntilUnderCeiling knows a ceiling is
// unreachable before it deletes every unlabeled version chasing it — and it is
// also what the admin panel reports as unreclaimable. Two definitions of
// "labeled bytes" would let the panel promise a purge the enforcement path
// cannot deliver.
function labeledBytesSQL() {
  return sum(sql`CASE WHEN ${customFilesVersions.label} IS NULL THEN 0 ELSE ${customFilesVersions.size} END`)
}

// Explicit column map so a join'd select still returns exactly the version row
// shape (drizzle otherwise nests the joined tables).
function columnsOf() {
  return {
    id: customFilesVersions.id,
    fileId: customFilesVersions.fileId,
    ownerId: customFilesVersions.ownerId,
    spaceId: customFilesVersions.spaceId,
    spaceExternalRootId: customFilesVersions.spaceExternalRootId,
    shareExternalId: customFilesVersions.shareExternalId,
    versionsRoot: customFilesVersions.versionsRoot,
    checksum: customFilesVersions.checksum,
    size: customFilesVersions.size,
    mtime: customFilesVersions.mtime,
    createdAt: customFilesVersions.createdAt,
    authorId: customFilesVersions.authorId,
    contentAuthorId: customFilesVersions.contentAuthorId,
    origin: customFilesVersions.origin,
    label: customFilesVersions.label
  }
}
