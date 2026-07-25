import { bigint, char, datetime, index, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'
import { files } from '../../files/schemas/files.schema'
import { shares } from '../../shares/schemas/shares.schema'
import { spacesRoots } from '../../spaces/schemas/spaces-roots.schema'
import { spaces } from '../../spaces/schemas/spaces.schema'
import { users } from '../../users/schemas/users.schema'

// Fork-owned file-versions table. Named `custom_files_versions` (not
// `files_versions`) so there is never a collision if upstream ships its own
// versioning — they left `// todo : versioning here` markers in
// files-manager.service.ts and files-event-manager.service.ts, so this is a
// live possibility, not a hypothetical. Same reasoning as
// `custom_files_favorites`.
//
// See docs/plans/2026-07-25-file-versioning-design.md for the full design.
// The two decisions that most shape this table:
//
// ANCHOR (ADR §3.1): rows key on `fileId` → `files.id`, never on path. The
// `files` table has no unique index on (ownerId, path, name) and, more
// importantly, `filesQueries.moveFiles` regexp-repaths `files.path` while
// leaving `files.id` untouched — so an id-keyed version row follows a rename
// or move with ZERO code, whereas a path-keyed one would orphan an entire
// file's history on any missed repath. Because `files` rows are lazily
// materialized (a file that was only ever uploaded and edited has no row),
// the id is guaranteed by custom-shared's FileRowEnsurer before insert.
//
// There is deliberately NO `path` column. It would create a repathing
// obligation on every rename for no benefit — descendant purge resolves ids
// through `files` via childFilesFindRegexp instead.
//
// FK (ADR §3.2): ON DELETE CASCADE is a BACKSTOP, not the mechanism.
// `filesQueries.deleteFiles` hard-deletes `files` rows on permanent delete,
// including every descendant of a directory in one regexp query, so a
// non-cascading FK would make those deletes fail. The service still purges
// explicitly BEFORE deleteFiles runs, because the cascade cannot decrement
// blob refcounts — stranded blobs are swept by the retention GC.
//
// ORPHAN SWEEP (ADR §20): the `fileId` column name and the schema.ts export are
// BOTH load-bearing beyond ORM plumbing. FilesScheduler.deleteOrphanFiles
// (@Cron EVERY_DAY_AT_4AM) deletes every `files` row not referenced by a table
// carrying a `fileId` column, discovering those tables by reflecting over
// schema.ts. Since a version row is often the ONLY reference to a row this
// feature materialized, dropping either half would make the 4 AM sweep delete
// those rows and cascade away all their history. files-versions.schema.spec.ts
// asserts both halves.
export const customFilesVersions = mysqlTable(
  'custom_files_versions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    // The anchor. NOT NULL: a version without a resolvable file is meaningless.
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    // Denormalized access scope, mirroring the `files` column set. This is a
    // NON-AUTHORITATIVE CACHE (ADR §15): it exists to avoid a join when
    // resolving a versions root, and is never the basis of a permission
    // decision — authoritative scope is always the `files` row plus the space
    // env the caller already resolved. A cross-space move leaves these stale
    // by design; they are refreshed opportunistically on the next snapshot.
    ownerId: bigint('ownerId', { mode: 'number', unsigned: true }).references(() => users.id, { onDelete: 'cascade' }),
    spaceId: bigint('spaceId', { mode: 'number', unsigned: true }).references(() => spaces.id, { onDelete: 'cascade' }),
    spaceExternalRootId: bigint('spaceExternalRootId', { mode: 'number', unsigned: true }).references(() => spacesRoots.id, {
      onDelete: 'cascade'
    }),
    shareExternalId: bigint('shareExternalId', { mode: 'number', unsigned: true }).references(() => shares.id, { onDelete: 'cascade' }),
    // Where the blob physically lives: 'user:<login>' or 'space:<alias>'.
    // Recorded at snapshot time and AUTHORITATIVE for blob resolution, so a
    // file moved to another space keeps resolving to the root that actually
    // holds its blobs — and the GC must match on this, not on the file's
    // current space, or it would delete a moved file's history as orphaned.
    // login and alias are both varchar(255); 261 covers 'space:' + 255.
    versionsRoot: varchar('versionsRoot', { length: 261 }).notNull(),
    // sha512-256, hex. Algorithm-neutral column name on purpose: changing the
    // algorithm must be an explicit migration, not a silent format break.
    // 64 hex chars for sha512-256.
    checksum: char('checksum', { length: 64 }).notNull(),
    // Logical size of the snapshotted content. Over-counts when dedup hits,
    // which makes the quotaShare cap conservative — accepted (ADR §7).
    size: bigint('size', { mode: 'number', unsigned: true }).notNull(),
    // mtime OF THE SUPERSEDED CONTENT, in unix milliseconds (repo convention;
    // NC clients want seconds and the compat layer divides).
    mtime: bigint('mtime', { mode: 'number', unsigned: true }).notNull(),
    createdAt: datetime('createdAt', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    // Nullable for system-originated snapshots (no acting user).
    authorId: bigint('authorId', { mode: 'number', unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
    // Which write path produced this snapshot. One value per destructive entry
    // point enumerated in ADR §4 — `web-patch` and `sync-make` exist because
    // saveMultipart's PATCH branch and mkFile(overwrite=true) are separate
    // destructive paths that a saveStream-centric design misses.
    origin: mysqlEnum('origin', [
      'web',
      'web-patch',
      'webdav',
      'sync',
      'sync-make',
      'nc-chunked',
      'nc-text',
      'collabora',
      'onlyoffice',
      'restore'
    ]).notNull(),
    // Named revision. A labeled version is never coalesced, never auto-expired
    // by retentionDays/maxVersionsPerFile, and never evicted by the quota cap.
    label: varchar('label', { length: 255 })
  },
  (table) => [
    // Primary read pattern: list a file's history, newest first.
    index('custom_files_versions_file_idx').on(table.fileId),
    // Blob refcount: COUNT(*) over (checksum, versionsRoot). Dedup and
    // refcounting are PER ROOT because blobs are physically per root.
    index('custom_files_versions_blob_idx').on(table.checksum, table.versionsRoot),
    // Retention sweep by age.
    index('custom_files_versions_created_idx').on(table.createdAt),
    // Coalescing lookup: newest version for (fileId, authorId, origin).
    index('custom_files_versions_coalesce_idx').on(table.fileId, table.authorId, table.origin, table.createdAt),
    // Eager quota cap: SUM(size) per root, and "oldest unlabeled in this root".
    index('custom_files_versions_root_idx').on(table.versionsRoot, table.label, table.createdAt)
  ]
)
