import { Column, SQL, sql } from 'drizzle-orm'
import { bigint, datetime, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core'
import { files } from '../../files/schemas/files.schema'
import { users } from '../../users/schemas/users.schema'

// Fork-owned favorites table. Renamed from upstream-contrib's `files_favorites`
// to `custom_files_favorites` so there is never a table-name collision if
// upstream ships its own favorites. See docs/plans/2026-06-10-favorites-custom-design.md.
export const customFilesFavorites = mysqlTable(
  'custom_files_favorites',
  {
    userId: bigint('userId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
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
