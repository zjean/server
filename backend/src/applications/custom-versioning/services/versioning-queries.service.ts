import { Inject, Injectable } from '@nestjs/common'
import { and, asc, count, countDistinct, desc, eq, inArray, isNull, lt, sql, sum } from 'drizzle-orm'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { convertToWhere, dbGetInsertedId } from '../../../infrastructure/database/utils'
import { FileDBProps } from '../../files/interfaces/file-db-props.interface'
import { childFilesFindRegexp, files } from '../../files/schemas/files.schema'
import { dirName, fileName } from '../../files/utils/files'
import { userFullNameSQL, users } from '../../users/schemas/users.schema'
import { VersionInsert, VersionOrigin, VersionRow } from '../interfaces/version.interface'
import { customFilesVersions } from '../schemas/files-versions.schema'

// All SQL for custom_files_versions lives here, keeping VersioningService about
// orchestration only — the same split upstream uses (FilesQueries /
// FilesManager) and custom-favorites uses (FavoritesQueries /
// FavoritesManager).
@Injectable()
export class VersioningQueries {
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  async insertVersion(values: VersionInsert): Promise<number> {
    return dbGetInsertedId(await this.db.insert(customFilesVersions).values(values))
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

  // History for a file, newest first, with the author joined for display.
  async listByFileId(fileId: number): Promise<(VersionRow & { authorLogin: string | null; authorFullName: string | null })[]> {
    return this.db
      .select({
        ...columnsOf(),
        authorLogin: users.login,
        authorFullName: userFullNameSQL(users)
      })
      .from(customFilesVersions)
      .leftJoin(users, eq(users.id, customFilesVersions.authorId))
      .where(eq(customFilesVersions.fileId, fileId))
      .orderBy(desc(customFilesVersions.createdAt), desc(customFilesVersions.id))
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
  // a directory its descendants are matched by (scope, childFilesFindRegexp).
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
        .where(and(...convertToWhere(files, commonProps), childFilesFindRegexp(props.path)))) {
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
    origin: customFilesVersions.origin,
    label: customFilesVersions.label
  }
}
