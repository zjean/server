import { Column, SQL, sql } from 'drizzle-orm'
import { bigint, datetime, index, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core'
import { files } from '../../files/schemas/files.schema'
import { shares } from '../../shares/schemas/shares.schema'
import { spaces } from '../../spaces/schemas/spaces.schema'
import { users } from '../../users/schemas/users.schema'

// Fork-owned favorites table. Renamed from upstream-contrib's `files_favorites`
// to `custom_files_favorites` so there is never a table-name collision if
// upstream ships its own favorites. See docs/plans/2026-06-10-favorites-custom-design.md.
//
// Each favorite records the ACCESS CONTEXT it was created through, not just the
// file id. A file shared into a user stores a `files` row that describes the
// OWNER's storage context (ownerId = owner, no spaceId/shareId), so the file
// row alone cannot tell us how the favoriting user reaches it. We therefore
// stamp the per-user context at favorite-time (mirrors files_recents):
//   - `path`    : the full repository path the user favorited through
//                 (e.g. `files/personal/docs/report.pdf`, `shares/<alias>/x`).
//                 Used directly as the nav path — always correct per-user.
//   - `spaceId` : set when favorited inside a space → access re-checked against
//                 the user's current space membership.
//   - `shareId` : set when favorited inside a share → access re-checked against
//                 the user's current shares.
//   - personal favorites leave both null (a user's personal space is always theirs).
export const customFilesFavorites = mysqlTable(
  'custom_files_favorites',
  {
    userId: bigint('userId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 4096 }).notNull(),
    spaceId: bigint('spaceId', { mode: 'number', unsigned: true }).references(() => spaces.id, { onDelete: 'cascade' }),
    shareId: bigint('shareId', { mode: 'number', unsigned: true }).references(() => shares.id, { onDelete: 'cascade' }),
    createdAt: datetime('createdAt', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fileId] }),
    index('custom_files_favorites_user_idx').on(table.userId),
    index('custom_files_favorites_file_idx').on(table.fileId)
  ]
)

// EXISTS predicate helper — used by the favorites queries service later.
export const fileIsFavoriteForUserSQL = (fileId: Column | SQL, userId: Column | SQL): SQL =>
  sql`EXISTS(SELECT 1 FROM ${customFilesFavorites} WHERE ${customFilesFavorites.fileId} = ${fileId} AND ${customFilesFavorites.userId} = ${userId})`
