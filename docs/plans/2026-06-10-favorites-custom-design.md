# Favorites — Custom (fork-isolated) Design

**Date:** 2026-06-10
**Scope:** Backend favorites (isolated `custom-favorites` module) + v2 UI only.
**Why this exists:** The `upstream-contrib/favorites` PR is not being merged upstream. We
re-home the feature into fork-owned custom code so it ships now and survives weekly
upstream syncs with zero conflicts. The upstream-contrib branch + its PR stay open.

Supersedes the integration strategy in `docs/plans/2026-05-07-favorites-design.md` (that
doc targeted upstream + the classic UI; this one targets fork-isolated custom code + v2).

---

## Guiding constraint: merge-safety

The old branch modified hot upstream files — the exact merge-conflict surface our fork
rules forbid:

| Upstream file the old branch edited | Why it conflicts on sync |
|---|---|
| `files/services/files-queries.service.ts` (`withIsFavorite` JOIN, favorites CRUD) | Hot file, upstream edits it often |
| `files/controller.ts`, `files/services/files.service.ts` | Core controller/service |
| `spaces/components/spaces-browser.component.*` | Classic browser, upstream-owned |
| `store/store.service.ts` | Global store |
| `i18n/{en,nl,de,...}.json` | Upstream owns these bundles |
| `styles/components/_theme_{light,dark}.scss` | Upstream theme |

**This design touches upstream files in exactly two places, both additive single lines
matching existing fork precedent:**

1. `backend/src/infrastructure/database/schema.ts` — one `export *` line (the
   `nc_sync_events` custom table already adds such a line here).
2. `backend/src/applications/applications.module.ts` — one module import + one entry in
   the `imports` array (mirrors `CustomMobileCompatModule` / `CustomFeaturesModule`).

Everything else lives under `custom-favorites/` (backend) or `custom-v2/` (frontend),
plus the fork-owned `i18n/custom/{en,nl}.json` bundle.

---

## 1. Database

**New table: `custom_files_favorites`**

Renamed from the branch's `files_favorites` to avoid a table-name collision if upstream
ever ships its own favorites. Our fork owns the `custom_` prefix.

```ts
// backend/src/applications/custom-favorites/schemas/files-favorites.schema.ts
import { Column, SQL, sql } from 'drizzle-orm'
import { bigint, datetime, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core'
import { files } from '../../files/schemas/files.schema'
import { users } from '../../users/schemas/users.schema'

export const customFilesFavorites = mysqlTable(
  'custom_files_favorites',
  {
    userId: bigint('userId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: datetime('createdAt', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fileId] }),
    index('custom_files_favorites_user_idx').on(table.userId),
    index('custom_files_favorites_file_idx').on(table.fileId)
  ]
)
```

**Design notes** (carried from the matured branch):

- Composite PK `(userId, fileId)` — duplicates impossible, toggle idempotent.
- `onDelete: cascade` on both FKs — self-cleaning when a user or file row is deleted.
- `createdAt` drives "most recently starred first" ordering.
- No `objectType` — Sync-in only favorites files (YAGNI).
- Each physical file has exactly one stable `files.id` regardless of access context
  (personal / space / share), so a single `fileId` favorites it everywhere.

**Export:** add one line to `backend/src/infrastructure/database/schema.ts`:

```ts
export * from '../../applications/custom-favorites/schemas/files-favorites.schema'
```

**Migration:** generate with tooling — **never hand-write the SQL** (journal must stay in
sync, per CLAUDE.md):

```bash
npm run -w backend db:generate   # creates 0005_*.sql + meta snapshot + _journal entry
npm run -w backend db:migrate    # apply locally
```

> Sync caveat: if a future upstream sync introduces its own migration with the same
> numeric prefix, reconcile during the sync (handled by the fork-maintenance skill). The
> `custom_` table name means there is never a *table* collision, only a possible
> journal-ordering reconcile.

---

## 2. Backend — isolated module `custom-favorites`

Directory mirrors `custom-mobile-compat`'s isolation template.

```
backend/src/applications/custom-favorites/
  custom-favorites.module.ts
  constants/routes.ts
  controllers/favorites.controller.ts
  services/favorites-manager.service.ts
  services/favorites-queries.service.ts
  services/favorites-manager.service.spec.ts
  schemas/files-favorites.schema.ts
  interfaces/file-favorite.interface.ts
```

### Routes (`constants/routes.ts`)

```ts
export const CUSTOM_FAVORITES_ROUTE = { BASE: 'favorites', SPACES: 'spaces', IDS: 'ids' } as const
export const API_CUSTOM_FAVORITES = `api/${CUSTOM_FAVORITES_ROUTE.BASE}` // for the frontend import
```

(Frontend imports the constant from `@sync-in-server/backend/.../custom-favorites/constants/routes`,
the same cross-package import pattern v2 already uses for `API_SPACES_BROWSE`.)

### Endpoints (`favorites.controller.ts`)

Guarded by upstream `SpaceGuard` (imported, not modified), `@SkipSpacePermissionsCheck()`:

```
GET    /api/favorites              → FileFavorite[]   (list, @SkipSpaceGuard)
GET    /api/favorites/ids          → number[]         (favorited fileIds, @SkipSpaceGuard)
POST   /api/favorites/spaces/*     → FileFavorite     (path-based add, SpaceGuard resolves *)
DELETE /api/favorites/spaces/*     → void             (path-based remove)
```

- **Path-based add/remove** is the branch's matured approach: `@GetSpace()` resolves the
  wildcard path to a `SpaceEnv`; the manager find-or-creates the file id. This handles
  **unindexed files** correctly (a file that exists on disk but has no `files` row yet),
  which the earlier `:fileId` approach could not.
- **`GET /ids`** is the isolation substitute for the branch's `withIsFavorite` JOIN into
  `browseFiles`. Instead of editing the upstream query, the v2 browser fetches the id set
  once and merges client-side.

### `favorites-manager.service.ts`

Reuses upstream `FilesQueries.getOrCreateSpaceFile` / `getSpaceFileId` (both already exist
in `main`) and `utils/files` `getProps` / `isPathExists`. Logic copied from the branch's
`FavoritesManager`:

```ts
getFavorites(user, limit?) → favoritesQueries.getFavorites(user, limit)
getFavoriteIds(user)       → favoritesQueries.getFavoriteIdsForUser(user.id)
addFavorite(user, space)   → fileId = getOrCreateFileId(space); favoritesQueries.add(...)
removeFavorite(user, space)→ fileId = getFileId(space); 404 if missing; favoritesQueries.remove(...)
```

### `favorites-queries.service.ts`

Owns all DB access against `customFilesFavorites` (injects `DB_TOKEN_PROVIDER`). Keeps the
favorites SQL **out of** the upstream `FilesQueries`. Methods:

- `getFavorites(userId, spaceIds, shareIds, limit)` — `customFilesFavorites ⋈ files`,
  LEFT JOIN `spaces`/`shares`, access filter (`ownerId = userId` OR space/share membership),
  `inTrash = false`, ordered `createdAt DESC`. Builds `navPath` in TypeScript
  (`buildFavoriteNavPath` — copied verbatim from the branch, no raw SQL).
- `getFavoriteIdsForUser(userId)` — `SELECT fileId WHERE userId = ?`. Returns `number[]`.
- `addFavorite(userId, fileId)` — `INSERT ... IGNORE`.
- `removeFavorite(userId, fileId)` — `DELETE`; throws `NotFoundException` if no rows.

Access-filtering inputs (`spaceIds`, `shareIds`) come from upstream `SpacesQueries.spaceIds`
/ `SharesQueries.shareIds`, injected into the manager (the branch's `FilesFavorites` did
exactly this).

### `interfaces/file-favorite.interface.ts`

```ts
import type { FileProps } from '../../files/interfaces/file-props.interface'
export interface FileFavorite extends Pick<FileProps, 'id'|'name'|'isDir'|'mime'|'size'|'mtime'|'ctime'> {
  isFavorite: boolean
  navPath: string
}
```

### Module wiring

`custom-favorites.module.ts` imports `FilesModule` (for `FilesQueries`), `SpacesModule`,
`SharesModule`, `UsersModule`; declares the controller + two services. Registered in
`applications.module.ts` next to `CustomFeaturesModule`.

---

## 3. Frontend — all inside `custom-v2/`

### `services/favorites.service.ts` (new, custom-v2-owned)

Holds the favorites state — **does not touch** upstream `StoreService` / `FilesService`.

```ts
favorites = signal<FileFavorite[]>([])     // for the Favorites screen
favoriteIds = signal<Set<number>>(new Set()) // for per-row stars
loadFavorites(limit?)        // GET /api/favorites
loadFavoriteIds()            // GET /api/favorites/ids → Set
isFavorite(fileId): boolean  // membership check
toggle(spacePath, fileId, add) // POST/DELETE /api/favorites/spaces/<path>; optimistic Set update + rollback on error
```

Uses `HttpClient` + the backend route constant directly (the pattern `space-files`
already uses). Toasts via the existing v2 `ToastService`.

### `screens/favorites/favorites.component.{ts,html,scss}` (new)

Mirrors `RecentsComponent`: reads `favoritesService.favorites()`, lists rows with
`FileGlyphComponent`, navigates via `navPath`, calls `loadFavorites()` in `ngOnInit`,
breadcrumb `[{ label: 'Favorites', icon: 'star' }]`.

### Routing + nav (custom-v2 files — safe to edit)

- `v2.constants.ts`: add `FAVORITES: 'favorites'` to `V2_ROUTES`.
- `v2.routes.ts`: `{ path: V2_ROUTES.FAVORITES, component: FavoritesComponent }`.
- `layout/left-nav.component.ts`: add `{ id: 'favorites', label: 'Favorites', icon: 'star', route: `/${V2_PATH}/${V2_ROUTES.FAVORITES}` }` right after the `recents` entry. (Add a `star` glyph to `icons/icon-v2.component.ts` if absent.)

### Star toggle in the file browser (`screens/space/space-files.component.ts` — custom-v2)

- On folder load, call `favoritesService.loadFavoriteIds()` (once; cheap).
- Add a context-menu entry to the existing `menuItems` computed:
  ```ts
  { id: 'favorite',
    label: this.favoritesService.isFavorite(f.id) ? 'Remove from favorites' : 'Add to favorites',
    icon: 'star',
    action: () => this.toggleFavorite(f) }
  ```
- `toggleFavorite(f)` builds the space path the same way the dock-context effect does —
  `[SPACE_REPOSITORY.FILES, alias, ...segs, f.name].join('/')` — and calls
  `favoritesService.toggle(path, f.id, !isFav)`.
- Render a small star indicator on rows where `favoritesService.isFavorite(f.id)` is true
  (read the signal in the template).

### i18n (fork-owned bundle only)

Add keys to `frontend/src/i18n/custom/{en,nl}.json` — never the upstream bundles. Keys:
`Favorites`, `Add to favorites`, `Remove from favorites`, plus a `v2_*` parameterised
toast key if needed (per the angular-l10n named-key rule in CLAUDE.md).

---

## 4. Branch + PR handling

- `upstream-contrib/favorites` PR stays **open** (upstream may merge someday).
- New work lands on `feat/favorites-custom`, rooted at **`main`** (not `upstream/main` —
  this is fork code, not an upstream contribution).
- Merge into `zjean/server` main via **squash** PR (`--repo zjean/server`).
- If upstream later merges its version, reconcile then: drop the `custom_` table or
  migrate data, and decide whether to switch the v2 UI onto the upstream endpoint.

---

## 5. Out of scope (follow-up)

**NC mobile `<oc:favorite>`** stays disabled exactly as today
(`docs/plans/2026-04-26-nc-favorites-disabled.md`). When we wire it later, the path is:
PROPFIND emits `<oc:favorite>` from `getFavoriteIdsForUser`; PROPPATCH toggles via the
manager; `REPORT {oc:favorite}` lists via `getFavorites`; OCS capability advertised in
`custom-mobile-compat/constants/capabilities.ts`. Read the NextcloudKit/ios source first
(per CLAUDE.md's NC-source-as-ground-truth rule). Not built now.

**Classic UI** gets no star — v2 is the fork's UI surface.

---

## 6. Verification & findings (2026-06-10)

Browser-verified against the local dev server end-to-end. All core flows pass:
Favorites screen, left-nav entry, star indicator, dynamic context-menu label,
add (POST), remove (DELETE), and navigation via `navPath`.

Three things the build/lint gates did **not** catch, fixed during verification:

1. **`navPath` missing the item name.** `files.path` is the item's *parent*
   directory ('.' at the space root); the name lives in `files.name`.
   `buildFavoriteNavPath` emitted only the parent (`files/personal`), so the v2
   UI opened the folder instead of the file. Fixed to append the name —
   `navPath` is now the full repository path (`files/personal/fav-test.md`).
2. **Personal browser was missing the toggle.** `/v2/personal` is served by
   `PersonalComponent`, a separate near-duplicate of `SpaceFilesComponent`. The
   star + context action were added to space-files only; replicated into
   PersonalComponent (commit `4d405a77`).
3. **Toggle path not per-segment encoded.** Wrapped the space path in
   `encodeUrl()` so names with reserved chars (`#`, `%`, `?`) round-trip.

**Finding deferred at design time — shares:** the `getFavorites` access filter
includes a `files.shareExternalId` branch, which only matches *external-path*
shares. This is **not reachable from the v2 UI**: opening a share in v2
(`SharedComponent.openShare`) navigates to the classic route
`/spaces/shares/<alias>`, which has no star. The only v2-favoritable files are
**personal** (filter: `ownerId = user`) and **member-space** (filter:
`spaceId IN …`), both handled correctly. The shares branch is harmless and left
in place for when a v2 share-file browser exists. If v2 later gains one,
re-test share favorites against the filter before shipping.

**Migration-chain repair (folded in):** generating the favorites migration
surfaced a pre-existing defect — `0004_nc_sync_events` (PR #92) was committed
hand-written (`CREATE TABLE IF NOT EXISTS`) with **no** `meta/0004_snapshot.json`
and a note to "regenerate on the next generate." We were that next generate;
the missing snapshot was backfilled via tooling (prod-safe: the applied `0004`
SQL and journal tag are unchanged), so `0005` contains only
`custom_files_favorites`.
