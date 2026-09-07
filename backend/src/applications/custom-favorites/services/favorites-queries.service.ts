import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { filesFavorites } from '../../files/schemas/files-favorites.schema'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'

// The one query the fork still owns after upstream shipped favorites (2.5.0).
//
// Upstream's FilesFavoritesQueries has no id-list method, and its getFavoritesFromUser
// runs three union queries across spaces, shares and external roots to resolve a
// DISPLAY location — far too heavy for the NC PROPFIND path, which needs nothing but
// "is this file id starred" for every row of every directory listing.
//
// Reads only. All writes go through upstream's FilesFavoritesQueries so there is a
// single source of truth for the insert-upsert and delete-by-key semantics.
@Injectable()
export class FavoritesQueries {
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  async getFavoriteIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.db.select({ fileId: filesFavorites.fileId }).from(filesFavorites).where(eq(filesFavorites.userId, userId))
    return rows.map((r) => r.fileId)
  }
}
