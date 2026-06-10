// The per-user access context a favorite was created through, stamped on the
// row at favorite-time so the list can re-check access and build the nav path
// without depending on the (owner-scoped) `files` row. See files-favorites.schema.ts.
export interface FavoriteContext {
  // Full repository path the user favorited through (e.g. `files/personal/x/y.md`).
  path: string
  // Set when favorited inside a space; null for personal / share contexts.
  spaceId: number | null
  // Set when favorited inside a share; null for personal / space contexts.
  shareId: number | null
}
