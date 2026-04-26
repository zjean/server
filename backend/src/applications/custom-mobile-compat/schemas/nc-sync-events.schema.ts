import { bigint, index, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { users } from '../../users/schemas/users.schema'

// Append-only log of file mutations the NC mobile sync-collection REPORT
// reads from. Each row represents one observed change: a create / update /
// delete on a single path, scoped to a single user (the file's owner —
// shared-file events get one row per viewer in v2; v1 only emits for the
// owner).
//
// Rows are pruned by a daily cron after `keepDays` (default 30) — tokens
// older than that horizon return 412 Precondition Failed and the client
// does a full re-sync.
//
// The autoincrement `id` doubles as the sync-token sequence. Keep insertion
// order stable (single-process or carefully ordered) so clients can
// reliably resume from the last token they saw.

export const ncSyncEvents = mysqlTable(
  'nc_sync_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    ownerId: bigint('ownerId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Repository: 'files' or 'trash'. We don't currently emit shares-repo
    // events; cross-share visibility is a v2 concern.
    repository: varchar('repository', { length: 16 }).notNull(),
    // Space alias the change happened in: 'personal' for the user's home,
    // a space alias otherwise. Lets the REPORT handler scope by space.
    spaceAlias: varchar('spaceAlias', { length: 64 }).notNull(),
    // Full file path within the space, joined with '/'. e.g. 'photos/cat.jpg'.
    // For dirs the trailing slash is stripped.
    path: varchar('path', { length: 4096 }).notNull(),
    // 'create' | 'update' | 'delete'. Maps from Sync-in's ACTION enum:
    // ADD → create, UPDATE → update, DELETE / DELETE_PERMANENTLY → delete.
    type: mysqlEnum('type', ['create', 'update', 'delete']).notNull(),
    // Event time in unix milliseconds. Used for pruning + display only;
    // ordering is by `id`, not `ts`.
    ts: bigint('ts', { mode: 'number', unsigned: true }).notNull()
  },
  (table) => [
    // Primary read pattern: "give me events for ownerId since id > token,
    // optionally scoped by space".
    index('owner_id_idx').on(table.ownerId, table.id),
    index('owner_space_id_idx').on(table.ownerId, table.spaceAlias, table.id),
    // Pruning sweep: "delete where ts < cutoff".
    index('ts_idx').on(table.ts)
  ]
)
