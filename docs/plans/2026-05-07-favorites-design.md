# Favorites — Design

**Date:** 2026-05-07
**Scope:** Core backend + classic UI only. NC compat wiring and v2 UI are out of scope (separate follow-up).
**Target:** Upstream PR to `Sync-in/server` via `upstream-contrib/favorites` branch.

---

## Background

Sync-in has no favorites model today. The NC mobile compat module intentionally omits `<oc:favorite>` from PROPFIND responses so iOS/Android hide the star UI (see `docs/plans/2026-04-26-nc-favorites-disabled.md`). This design adds the core feature to the server so NC compat and v2 can wire into it later.

Nextcloud stores favorites in `oc_favorites(uid, object_type, object_id)` — per-user, per-file-node-id, across all file contexts. Sync-in mirrors this exactly.

---

## 1. Database

**New table: `files_favorites`**

```ts
// backend/src/applications/files/schemas/files-favorites.schema.ts

export const filesFavorites = mysqlTable(
  'files_favorites',
  {
    userId: bigint('userId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: datetime('createdAt', { mode: 'date' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fileId] }),
    index('user_idx').on(table.userId),
  ]
)
```

**Design notes:**
- Composite PK on `(userId, fileId)` — prevents duplicates, makes toggle idempotent
- `onDelete: 'cascade'` on both FKs — self-cleaning when user or file is deleted
- `user_idx` is the hot index — all runtime queries filter by userId
- `createdAt` for sort order (most recently starred first); Nextcloud lacks this — small improvement
- No `objectType` — YAGNI; Sync-in only favorites files

**Key insight:** each physical file has exactly one row in the `files` table regardless of access context (personal / space / share). The `ownerId`/`spaceId`/`shareExternalId` columns indicate storage context, but the integer PK is stable. Favoriting works across all contexts automatically via a single `fileId`.

**Migration:** `npm run -w backend db:generate` — never write SQL by hand.

**Export:** add to `backend/src/infrastructure/database/schema.ts`.

---

## 2. Backend API

### Endpoints

Three new endpoints in `FilesController`, all with `@SkipSpaceGuard()`:

```
GET    /api/files/favorites          → list user's favorited files
POST   /api/files/favorite/:fileId   → mark file as favorite
DELETE /api/files/favorite/:fileId   → unmark file as favorite
```

Add to `backend/src/applications/files/constants/routes.ts`:

```ts
FAVORITES: 'favorites',
FAVORITE:  'favorite',
```

### Service: `FilesFavorites`

New service at `files-favorites.service.ts`, parallel to `FilesRecents`:

```ts
getFavorites(user: UserModel, limit?: number): Promise<FileProps[]>
addFavorite(user: UserModel, fileId: number): Promise<void>
removeFavorite(user: UserModel, fileId: number): Promise<void>
```

`getFavorites` joins `files_favorites → files` ordered by `createdAt DESC`. Returns `FileProps` — the same shape used everywhere else in the files API.

### `isFavorite` in file listings

Add `withIsFavorite?: boolean` to the `options` bag in `browseFiles` (same pattern as existing `withHasComments`). When enabled, LEFT JOIN `files_favorites` on `userId = currentUser AND fileId = files.id` and surface `isFavorite: boolean` on each `FileProps`. The join is cheap — indexed on `userId`.

This means the file browser gets accurate star state without a separate API call.

### Query layer additions (`FilesQueries`)

- `getFavorites(userId, limit?)` — join `files_favorites → files`, order by `createdAt DESC`
- `addFavorite(userId, fileId)` — insert ignore (idempotent)
- `removeFavorite(userId, fileId)` — delete, no-op if missing (idempotent)
- `browseFiles` extended with `withIsFavorite` option

---

## 3. Classic Frontend

### New `favorites` app module

Mirrors the `recents` module:

```
frontend/src/app/applications/favorites/
  favorites.constants.ts        → FAVORITES_PATH, FAVORITES_TITLE, FAVORITES_ICON (faStar)
  favorites.routes.ts           → route → FavoritesComponent
  components/
    favorites.component.ts/.html  → wraps FilesFavoritesWidgetComponent
    widgets/
      files-favorites-widget.component.ts/.html/.scss
```

Register in `app.routes.ts` alongside `recentsRoutes`.

**`FilesFavoritesWidgetComponent`** (mirrors `FilesRecentsWidgetComponent`):
- Reads `store.filesFavorites()` signal
- Calls `filesService.loadFavorites(limit)` on init
- Click on item → `router.navigate` to file location (same pattern as recents)
- Show/hide more toggle

### Sidebar menu entry

In `spaces.constants.ts`, add one entry to `SPACES_MENU.submenus` directly after Recents:

```ts
{
  title: FAVORITES_TITLE,
  icon: FAVORITES_ICON,   // faStar (solid)
  link: FAVORITES_PATH.BASE
}
```

### Star toggle on file rows

Add a star icon button to each file row in the file browser:
- Filled `faStar` (solid) when `file.isFavorite === true`
- Outlined `faStar` (regular) when false
- Click calls `filesService.toggleFavorite(file.id, !file.isFavorite)`
- `toggleFavorite` hits `POST` or `DELETE /api/files/favorite/:id` and updates `store.filesFavorites()` reactively

### Store additions

- `filesFavorites: Signal<FileProps[]>` in `StoreService`
- `filesService.loadFavorites(limit?)` — fetches and pushes to store
- `filesService.toggleFavorite(fileId, add: boolean)` — POST/DELETE + store update

### i18n

Add `"Favorites"` key to `en.json` and all other locale files (check which locales ship at implementation time).

---

## 4. Upstream-Contrib Branch Strategy

```bash
git fetch upstream
git checkout -b upstream-contrib/favorites upstream/main
```

**Constraints for this branch:**
- No `custom-*` imports or paths
- No references to `custom-mobile-compat`, `custom-v2`, or any fork-specific modules
- Conventional commit messages only (`feat(files): ...`, `fix(files): ...`)
- No `mod()/custom()` prefixes

All changes in sections 1–3 touch only core upstream files with no fork dependencies.

**Open PR against upstream:**

```bash
gh pr create --repo Sync-in/server --base main --head upstream-contrib/favorites \
  --title "feat(files): add favorites support"
```

This is the one case where the PR targets `Sync-in/server`, not `zjean/server`.

**Parallel fork integration:**

While the upstream PR is under review, cherry-pick `upstream-contrib/favorites` into a `feat/favorites-fork-integration` branch and merge into `zjean/server main` via normal squash PR. This unblocks NC compat and v2 work. When upstream eventually merges and the weekly sync runs, the files are already present in the fork — the sync is a no-op for those paths.

---

## Out of scope (follow-up)

- NC compat: `<oc:favorite>` in PROPFIND, PROPPATCH toggle, `REPORT {oc:favorite}` listing, OCS capability advertisement
- v2 UI: star toggle and favorites view in the custom-v2 file browser
