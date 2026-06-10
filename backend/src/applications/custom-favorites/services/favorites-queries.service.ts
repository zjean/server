import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { files } from '../../files/schemas/files.schema'
import { FileFavorite } from '../interfaces/file-favorite.interface'
import { FavoriteContext } from '../interfaces/favorite-context.interface'
import { customFilesFavorites } from '../schemas/files-favorites.schema'

// The metadata columns come from the joined `files` row; `navPath` is the
// per-user access path stamped on the favorite itself (customFilesFavorites.path),
// so a file shared into the user navigates through THEIR path, not the owner's.
const favoriteFileSelect = {
  id: files.id,
  name: files.name,
  isDir: files.isDir,
  mime: files.mime,
  size: files.size,
  mtime: files.mtime,
  ctime: files.ctime,
  navPath: customFilesFavorites.path
}

interface FavoriteFileRow {
  id: number
  name: string
  isDir: boolean
  mime: string | null
  size: number
  mtime: number
  ctime: number
  navPath: string
}

const toFileFavorite = (row: FavoriteFileRow): FileFavorite => ({
  id: row.id,
  name: row.name,
  isDir: row.isDir,
  mime: row.mime,
  size: row.size,
  mtime: row.mtime,
  ctime: row.ctime,
  isFavorite: true,
  navPath: row.navPath
})

// Access predicate: a favorite is visible when it is personal (no space/share
// context — a user's own personal space is always theirs) OR its stamped space
// is one the user still belongs to OR its stamped share is one still shared
// with them. inArray(col, []) compiles to `false`, so empty scopes drop out.
const accessibleFavorite = (spaceIds: number[], shareIds: number[]) =>
  or(
    and(isNull(customFilesFavorites.spaceId), isNull(customFilesFavorites.shareId)),
    inArray(customFilesFavorites.spaceId, spaceIds),
    inArray(customFilesFavorites.shareId, shareIds)
  )

@Injectable()
export class FavoritesQueries {
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  async getFavorites(userId: number, spaceIds: number[], shareIds: number[], limit = 100): Promise<FileFavorite[]> {
    const rows = await this.db
      .select(favoriteFileSelect)
      .from(customFilesFavorites)
      .innerJoin(files, eq(files.id, customFilesFavorites.fileId))
      .where(and(eq(customFilesFavorites.userId, userId), eq(files.inTrash, false), accessibleFavorite(spaceIds, shareIds)))
      .orderBy(desc(customFilesFavorites.createdAt))
      .limit(limit)
    return rows.map(toFileFavorite)
  }

  async getFavoriteIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.db
      .select({ fileId: customFilesFavorites.fileId })
      .from(customFilesFavorites)
      .where(eq(customFilesFavorites.userId, userId))
    return rows.map((r) => r.fileId)
  }

  async getFavoriteForFile(userId: number, fileId: number): Promise<FileFavorite | undefined> {
    const [row] = await this.db
      .select(favoriteFileSelect)
      .from(customFilesFavorites)
      .innerJoin(files, eq(files.id, customFilesFavorites.fileId))
      .where(and(eq(customFilesFavorites.userId, userId), eq(customFilesFavorites.fileId, fileId)))
      .limit(1)
    return row ? toFileFavorite(row) : undefined
  }

  // Upsert: re-favoriting a file refreshes the access context (e.g. the user
  // now reaches it through a different space/share/path).
  async addFavorite(userId: number, fileId: number, context: FavoriteContext): Promise<void> {
    const values = { userId, fileId, path: context.path, spaceId: context.spaceId ?? null, shareId: context.shareId ?? null }
    await this.db
      .insert(customFilesFavorites)
      .values(values)
      .onDuplicateKeyUpdate({ set: { path: values.path, spaceId: values.spaceId, shareId: values.shareId } })
  }

  async removeFavorite(userId: number, fileId: number): Promise<void> {
    const result = await this.db
      .delete(customFilesFavorites)
      .where(and(eq(customFilesFavorites.userId, userId), eq(customFilesFavorites.fileId, fileId)))
    if (!result[0].affectedRows) throw new NotFoundException('Favorite not found')
  }
}
