import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { files } from '../../files/schemas/files.schema'
import { shares } from '../../shares/schemas/shares.schema'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { spaces } from '../../spaces/schemas/spaces.schema'
import { FileFavorite } from '../interfaces/file-favorite.interface'
import { customFilesFavorites } from '../schemas/files-favorites.schema'

const favoriteFileSelect = {
  id: files.id,
  name: files.name,
  isDir: files.isDir,
  mime: files.mime,
  size: files.size,
  mtime: files.mtime,
  ctime: files.ctime,
  path: files.path,
  ownerId: files.ownerId,
  spaceAlias: spaces.alias,
  shareAlias: shares.alias
}

// `path` is the item's PARENT directory within the space ('.' at the space
// root); `name` is the item itself. The nav path is the full repository path
// to the item (parent + name) so the v2 UI can open a file directly or
// navigate into a folder. Mirrors how recents combines parentPath + name.
const buildFavoriteNavPath = (path: string, name: string, ownerId: number | null, spaceAlias: string | null, shareAlias: string | null): string => {
  const dir = path && path !== '.' ? `/${path}` : ''
  const tail = `${dir}/${name}`
  if (ownerId !== null) return `${SPACE_REPOSITORY.FILES}/${SPACE_ALIAS.PERSONAL}${tail}`
  if (spaceAlias) return `${SPACE_REPOSITORY.FILES}/${spaceAlias}${tail}`
  if (shareAlias) return `${SPACE_REPOSITORY.SHARES}/${shareAlias}${tail}`
  return ''
}

interface FavoriteFileRow {
  id: number
  name: string
  isDir: boolean
  mime: string | null
  size: number
  mtime: number
  ctime: number
  path: string
  ownerId: number | null
  spaceAlias: string | null
  shareAlias: string | null
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
  navPath: buildFavoriteNavPath(row.path, row.name, row.ownerId, row.spaceAlias, row.shareAlias)
})

@Injectable()
export class FavoritesQueries {
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  async getFavorites(userId: number, spaceIds: number[], shareIds: number[], limit = 100): Promise<FileFavorite[]> {
    const rows = await this.db
      .select(favoriteFileSelect)
      .from(customFilesFavorites)
      .innerJoin(files, eq(files.id, customFilesFavorites.fileId))
      .leftJoin(spaces, eq(spaces.id, files.spaceId))
      .leftJoin(shares, eq(shares.id, files.shareExternalId))
      .where(
        and(
          eq(customFilesFavorites.userId, userId),
          eq(files.inTrash, false),
          // inArray(col, []) compiles to `false` in drizzle, so empty scopes
          // simply drop out — same pattern as getRecentsFromUser upstream.
          or(eq(files.ownerId, userId), inArray(files.spaceId, spaceIds), inArray(files.shareExternalId, shareIds))
        )
      )
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
      .leftJoin(spaces, eq(spaces.id, files.spaceId))
      .leftJoin(shares, eq(shares.id, files.shareExternalId))
      .where(and(eq(customFilesFavorites.userId, userId), eq(customFilesFavorites.fileId, fileId)))
      .limit(1)
    return row ? toFileFavorite(row) : undefined
  }

  async addFavorite(userId: number, fileId: number): Promise<void> {
    await this.db.insert(customFilesFavorites).ignore().values({ userId, fileId })
  }

  async removeFavorite(userId: number, fileId: number): Promise<void> {
    const result = await this.db
      .delete(customFilesFavorites)
      .where(and(eq(customFilesFavorites.userId, userId), eq(customFilesFavorites.fileId, fileId)))
    if (!result[0].affectedRows) throw new NotFoundException('Favorite not found')
  }
}
