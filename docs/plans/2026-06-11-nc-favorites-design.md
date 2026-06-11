# Nextcloud favorites support for `custom-mobile-compat`

**Date:** 2026-06-11
**Status:** Design — pending implementation
**Depends on:** PR #275 (`custom-favorites` module — per-user file favorites)

## Goal

Expose the per-user favorites we already store (`custom_files_favorites`,
keyed by `(userId, fileId)`) through the Nextcloud-compatible WebDAV surface in
`custom-mobile-compat`, so the stock NC iOS/Android clients:

1. **See the star** on favorited files in any directory listing (PROPFIND).
2. **Toggle the star** on/off (PROPPATCH).
3. **Populate the Favorites tab** (REPORT `oc:filter-files`).

No new storage, no new capability. We reuse `FavoritesManager` verbatim — the
same service the v2 UI and classic API already drive, so the NC surface and the
web surface stay in lockstep by construction.

## Ground truth (verified against upstream source)

Quoted from `nextcloud/server`, `nextcloud/NextcloudKit`, `nextcloud/ios`,
`nextcloud/android-library` on `master` (see CLAUDE.md NC-source-as-ground-truth
rule). The decisive details:

| Concern | Contract |
|---|---|
| Property | `{http://owncloud.org/ns}favorite` → `<oc:favorite>` |
| Value | **integer string `"1"` / `"0"`** — *never* `true`/`false`. Android (`WebdavEntry.kt`) does `IS_ENCRYPTED == favoriteValue` where `IS_ENCRYPTED = "1"`, an exact-equality compare. `"true"` silently reads as not-favorite. iOS uses `NSString.boolValue` (accepts both) — so `"1"` satisfies both clients. |
| Set (PROPPATCH) | On the **file's own DAV URL** `…/dav/files/<user>/<path>`. iOS: `<d:set><d:prop><oc:favorite>1\|0</oc:favorite></d:prop></d:set>`. Android favorite: same `<d:set>…1`. **Android unfavorite: `<d:remove><d:prop><oc:favorite/></d:prop></d:remove>`** — must be handled. |
| Server PROPPATCH accept | Upstream `TagsPlugin.php`: `(int)$favState === 1 \|\| $favState === 'true'` → favorite; anything else (incl. `0` and null/removed) → unfavorite. Returns `200` on set, `204` on remove; overall `207`. |
| List (REPORT) | On the **home root** `…/dav/files/<user>` (no path). Body `<oc:filter-files>…<oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>`. Server (`FilesReportPlugin.php`) triggers on **presence** of the `oc:favorite` filter-rule, ignores its value. Response `207 multistatus`. |
| `<d:href>` | Absolute, percent-encoded, `/remote.php/dav/files/<user>/<path>`; trailing `/` for collections. iOS derives `serverUrl`/`fileName` from it. |
| Capability gate | **None.** Favorites is always-on in NC; no `files.favorites` capability. `capabilities.ts` unchanged. |

## What already exists (the seams)

- `FavoritesManager` (in `custom-favorites`):
  - `addFavorite(user, space: SpaceEnv)` → get-or-create the `files` row, upsert favorite with per-user access context.
  - `removeFavorite(user, space: SpaceEnv)` → delete; throws `NotFoundException` if the file has no row.
  - `getFavorites(user)` → access-re-checked list of `FileFavorite { id, name, isDir, mime, size, mtime, ctime, isFavorite, navPath }`, capped 100. `navPath` is the **sync-in repository path** the user favorited through (`files/personal/…`, `files/<spaceAlias>/…`, or `shares/<alias>/…`).
  - `getFavoriteIdsForUser(userId)` → cheap `number[]` of favorited `files.id`.
- `custom-mobile-compat`:
  - `nc-dav.controller.ts` resolves NC URL → `SpaceEnv` (`req.space`), routes by HTTP method. PROPPATCH currently delegates to upstream `WebDAVMethods.proppatch` (mtime/Win32 only). REPORT sniffs the body and routes `filter-files` → `NcSyncReportService.respondFilterFiles`, which is **a stub returning an empty multistatus**.
  - `nc-prop-builder.ts` `buildNcPropResponse(...)` builds every `<d:response>` for PROPFIND / sync-collection / (future) filter-files. **It does not emit `oc:favorite` today.**
  - `NcPathResolverService.resolve(user, {mode,subpath})` → `{ spaceAlias, rootAlias, relativePath }` for the user's home (honors `user.settings.mobileHome`).
  - `NcShareMountResolverService.listMounts(user)` → `{ alias, … }[]` of incoming share-mounts overlaid on the NC home root.
  - `NcFileRowEnsurer.ensure(file, space, user)` → promotes FS-only files to a real DB id.

## Scope decisions (confirmed with maintainer)

- **REPORT favorites scope: home-reachable only.** A favorite is listed only if
  its `navPath` resolves to a navigable href under the user's current NC home —
  i.e. it never emits a broken href. Concretely that covers:
  - personal favorites when the home is personal (the common case),
  - share-mount favorites (mounts overlay every home root), and
  - collaborative-space favorites when `mobileHome` points at that space.

  A collaborative-space favorite while the home is personal is **silently
  omitted** (not navigable under that home). Documented limitation; revisit only
  if users hit it.
- **Single PR** delivering all three pieces (read prop + write toggle + list).
  They share the `FavoritesManager` wiring and the XML builder; shipping one
  without the others leaves the feature half-dead in the client.

## Design

### 0. Cross-module DI (prerequisite)

- `custom-favorites.module.ts`: add `exports: [FavoritesManager]` (currently the
  module exports nothing).
- `custom-mobile-compat.module.ts`: `imports: [… , CustomFavoritesModule]`.

### 1. PROPFIND — emit `oc:favorite` (read)

`oc:favorite` is emitted by the **shared** `buildNcPropResponse`, so this change
lights up PROPFIND, sync-collection, *and* the favorites REPORT at once. That
means it touches every NC response — desired (real NC always includes
`oc:favorite`), but every call site must pass the real value or risk the star
flickering off after a sync.

- `nc-prop-builder.ts`: add a param `isFavorite: boolean` (default `false`) and
  emit `'oc:favorite': isFavorite ? '1' : '0'` into the `props` map (alongside
  `oc:permissions` etc.). String, never boolean.
- Call sites fetch the favorite-id set **once per request** and pass per-file:
  - `nc-propfind.service.ts`: `const favIds = new Set(await favoritesManager.getFavoriteIdsForUser(user.id))`; for each file pass `isFavorite: favIds.has(file.id)`. **Must use the post-`ensure` real id** (FS-only files carry a placeholder id that won't match a favorite row). Inject `FavoritesManager`.
  - `nc-sync-report.service.ts` (`buildEventResponse`): same set, same per-file lookup, so synced files keep their star.
  - The favorites REPORT path (below) always passes `isFavorite: true`.
- Deleted responses (`buildNcDeletedResponse`) are unaffected — href + 404 only.

`getFavoriteIdsForUser` returns *all* of the user's favorite ids regardless of
access context — correct for marking (the user is already viewing the file);
access re-checking only matters for the REPORT listing.

### 2. REPORT `oc:filter-files` — list favorites (read)

New service **`NcFavoritesReportService`** (keeps `NcSyncReportService` focused
on RFC-6578 sync; both are independently testable). Deps: `FavoritesManager`,
`NcPathResolverService`, `NcShareMountResolverService`, `SpacesManager`. Reuses
the existing `sendFilterFiles` multistatus envelope (4 namespaces, no
sync-token) — move that helper here or share it.

The controller routes `reportType === 'filter-files'` to this service instead of
the `NcSyncReportService` stub. The stub `respondFilterFiles` is deleted.

**Algorithm** (`respond(req, res)`):

1. `favs = await favoritesManager.getFavorites(user)` — already access-filtered + capped.
2. `home = resolver.resolve(user, { mode: 'files', subpath: '' })` → `{ spaceAlias, rootAlias }`.
3. `mounts = await shareMounts.listMounts(user)`.
4. For each `fav`, compute `ncSub = ncSubpathForFavorite(fav.navPath, home, mounts)`; skip if `null` (not home-reachable).
5. Build the `SpaceEnv` for `ncSub` exactly like the controller's `buildUrlSegments`:
   share-mount first segment → `[SHARES, alias, ...rest]`, else home segments +
   rest; `space = await spacesManager.spaceEnv(user, segments)`.
6. `props = await getProps(space.realPath, space.relativeUrl)`. If the stat
   fails (file gone), skip — never emit a phantom entry.
7. `file = new WebDAVFile(props, dirname(ncHref)); file.id = fav.id` (already a
   real DB id — favorites FK to `files.id`).
8. `buildNcPropResponse(file, space, 'files', false, user.fullName, undefined, { login: user.login, displayName: user.fullName || user.login }, /* isFavorite */ true)`.
9. Collect; `sendFilterFiles(res, responses)`.

**`ncSubpathForFavorite(navPath, home, mounts)`** — pure, unit-tested:

```
const [repo, alias, ...rest] = navPath.split('/')
if (repo === SPACE_REPOSITORY.SHARES)
  return mounts.some(m => m.alias === alias) ? [alias, ...rest].join('/') : null
if (repo === SPACE_REPOSITORY.FILES) {
  if (alias !== home.spaceAlias) return null
  let tail = rest
  if (home.rootAlias) { if (tail[0] !== home.rootAlias) return null; tail = tail.slice(1) }
  return tail.join('/')
}
return null   // trash etc. is never favorited
```

- Personal home (`spaceAlias=personal`, `rootAlias=null`): `files/personal/docs/x` → `docs/x`. ✓
- Share mount: `shares/<alias>/y` → `<alias>/y` iff still mounted. ✓ (works under any home)
- Space home (`mobileHome=space:team`): `files/team/z` → `z`. ✓
- Out-of-home space favorite while home=personal → `null` (omitted). ✓

**href** = `/remote.php/dav/files/<login>/<ncSub>`, per-segment percent-encoded
(reuse the existing `encodeUriUserPath` helper). Collections get a trailing `/`
(consistent with the rest of the module / `buildNcPropResponse`).

**Performance:** one `spaceEnv` + one `stat` per favorite, ≤100. Acceptable.
Optional later optimization: group by space/share and resolve each root once.

### 3. PROPPATCH — toggle favorite (write)

Handled **entirely in the NC layer** — we do *not* modify upstream
`WebDAVMethods.proppatch` (keeps the change off the upstream merge-conflict
surface; that method legitimately 423s unknown props).

- New util `parseFavoriteProppatch(body): boolean | null` (in `nc-sync-xml.ts`
  or a sibling `nc-favorites-xml.ts`). Parse with `fast-xml-parser` (already a
  dep). Returns:
  - `true`  ← `<d:set>` containing `<oc:favorite>1</oc:favorite>`
  - `false` ← `<d:set>` containing `<oc:favorite>0</oc:favorite>` (iOS unfavorite) **or** `<d:remove>` containing `<oc:favorite/>` (Android unfavorite)
  - `null`  ← no `oc:favorite` element → not a favorite PROPPATCH
- `nc-dav.controller.ts`, PROPPATCH case: `const fav = parseFavoriteProppatch(req.body)`. If `fav === null` → delegate to `webdav.proppatch` (mtime path unchanged). Otherwise call `favoritesService.respondProppatchFavorite(req, res, fav)`.
- `NcFavoritesReportService.respondProppatchFavorite(req, res, favorite)` (or a
  small dedicated method/service):
  - `favorite === true` → `await favoritesManager.addFavorite(user, req.space)`.
  - `favorite === false` → `await favoritesManager.removeFavorite(user, req.space)`, **catching `NotFoundException`** so unfavorite is idempotent (NC returns 204 even for a non-favorited file).
  - Respond `207` multistatus with one `<d:response>`:
    - `<d:href>` = the request's own NC path (echo `req.dav.url`, re-encoded).
    - `<d:propstat><d:prop><oc:favorite/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` for set; `204 No Content` for remove (mirrors upstream `TagsPlugin`).

`addFavorite`/`removeFavorite` already branch on `space.inPersonalSpace` /
`inSharesRepository` / space context, so favoriting a file inside a mounted
share stores the right `shareId` — identical to the v2 path.

### 4. Capabilities

No change. Verified: no client gates favorites on a capability flag.

## Files touched

| File | Change |
|---|---|
| `custom-favorites/custom-favorites.module.ts` | `exports: [FavoritesManager]` |
| `custom-mobile-compat/custom-mobile-compat.module.ts` | import `CustomFavoritesModule`; register `NcFavoritesReportService` |
| `custom-mobile-compat/utils/nc-prop-builder.ts` | add `isFavorite` param; emit `oc:favorite` `"1"`/`"0"` |
| `custom-mobile-compat/services/nc-propfind.service.ts` | fetch fav-id set once; pass `isFavorite` per file (post-ensure id); inject `FavoritesManager` |
| `custom-mobile-compat/services/nc-sync-report.service.ts` | thread `isFavorite` into `buildEventResponse`; delete `respondFilterFiles` stub |
| `custom-mobile-compat/services/nc-favorites-report.service.ts` | **new** — REPORT listing + PROPPATCH response |
| `custom-mobile-compat/utils/nc-favorites-xml.ts` | **new** — `parseFavoriteProppatch`, `ncSubpathForFavorite` |
| `custom-mobile-compat/controllers/nc-dav.controller.ts` | PROPPATCH: intercept favorite intent; REPORT: route `filter-files` → new service |

## Testing (TDD — write the spec first)

- `nc-prop-builder.spec.ts`: emits `<oc:favorite>1</oc:favorite>` when favorite, `0` otherwise; never `true`/`false`.
- `nc-favorites-xml.spec.ts`: `parseFavoriteProppatch` for iOS `<set>1`, iOS `<set>0`, Android `<remove>`, and a mtime-only PROPPATCH (→ `null`); `ncSubpathForFavorite` for personal / share / space-home / out-of-home / trash.
- `nc-favorites-report.service.spec.ts`: builds a multistatus for a mix of favorites (mock `spacesManager.spaceEnv`/`getProps`), omits out-of-home + stat-fail entries, hrefs are absolute & encoded.
- Regression: existing `nc-prop-builder` / `nc-sync-report` snapshots updated to include the new `oc:favorite` element (it now appears in every response). Existing PROPPATCH (mtime) test still green — favorite parse returns `null` and delegates.
- Backend gate: `npm run -w backend test` + `npm run -w backend lint` green before PR.
- Manual/device verification (best-effort, separate from CI): star a file in NC iOS, confirm it appears in the Favorites tab and the star persists across a pull-to-refresh.

## Branch / PR

- Branch `feat/nc-favorites`, conventional commit `feat(custom-mobile-compat): expose per-user favorites to NC clients (PROPFIND/PROPPATCH/REPORT)`.
- Target `zjean/server`, `--repo zjean/server`. Squash merge.
- No DB migration (reuses `custom_files_favorites`). No capability change.
