# ADR — File Versioning (zjean/server fork)

- **Status:** Accepted
- **Date:** 2026-07-25
- **Implements:** [`2026-07-25-file-versioning-implementation-plan.md`](2026-07-25-file-versioning-implementation-plan.md) Phase A / Task A1
- **Supersedes:** nothing (upstream has only `// todo` markers — `files-manager.service.ts:153`, `files-event-manager.service.ts:20`)
- **Scope:** backend `custom-versioning` + `custom-shared` modules, small `mod()` hooks in upstream files, `custom-v2` frontend, `custom-mobile-compat` NC surface.

All `file:line` citations below were re-verified against `main` at commit `37384614` on 2026-07-25. Where the implementation plan's line numbers had drifted, the verified value is used and the drift noted.

---

## Context

Sync-in stores files on a plain filesystem with the `files` table as a metadata index. There is no version concept: every overwrite destroys the previous content irrecoverably. Upstream left two `todo` markers but no design.

Three facts about the codebase shape every decision that follows, and each has burned a previous design draft:

1. **The `files` table is a sparse, lazily-populated index — not a row-per-file mirror.** `FileDBProps` (`files/interfaces/file-db-props.interface.ts`) carries no `id`; it is a *scope + path descriptor*. `space.dbFile` is built by `dbFileFromSpace` (`spaces/utils/paths.ts:128`) from the space env alone with no DB lookup. So at every write-path hook site the code holds `user` + `space` — never a `files.id`. Rows are materialized on demand by `getOrCreateUserFile` (`files-queries.service.ts:120`) / `getOrCreateSpaceFile` (:136), called only by shares, comments, favorites, recents, sync-paths and nc-dav. **A file that has only ever been uploaded and edited has no row and no id.**
2. **There are seven destructive write entry points, not the obvious one.** Two live inside `saveStream`, two inside `saveMultipart` (PUT *and* PATCH), two bypass `saveStream` entirely (both editors, via `copyFileContent`), one is NC chunked assembly, and one is `mkFile(overwrite=true)` which truncates to zero bytes. Any `saveStream`-centric design ships holes.
3. **Quota is enforced pre-flight, synchronously, off a one-day cache.** `spaces/guards/space.guard.ts:54` rejects uploads via `willExceedQuota` before any versioning code runs. Versioning therefore cannot promise anything about whether a save succeeds.

---

## 1. Storage layout — content-addressed blob store, sibling of the files repository

**Decision.** Blobs live at `<home>/versions/<digest[0:2]>/<digest>`, where `<home>` is `UserModel.getHomePath(login)` or `SpaceModel.getHomePath(alias)` — i.e. a **sibling of `files/` and `trash/`**, resolved by `versionsRootFromSpace(user, space)` + `versionsPathFromRoot(root)` in `custom-versioning/utils/paths.ts`, modeled 1:1 on `realTrashPathFromSpace` (`spaces/utils/paths.ts:76-101`) and covering the same four cases: personal, space, external-root, share.

`versions` is **not** added to `SPACE_REPOSITORY` or `SPACE_ALIAS` (`spaces/constants/spaces.ts:13-24`, verified to be exactly `files|trash|shares`). Unlike `trash`, which *is* URL-reachable and browsable, the versions store is never addressable through a space URL, never browsable, and never appears in any listing.

**Rationale (verified).** Trash already demonstrates the pattern: `UserModel.getTrashPath(login)` is `getHomePath(login)/trash` (`user.model.ts:154-156`) and `SpaceModel.getTrashPath(alias)` is `getHomePath(alias)/trash` (`space.model.ts:57-59`). A store placed *inside* the files repository would instead be:

- listed by WebDAV PROPFIND and by the browse API (both walk the files root);
- synced down by the desktop client;
- walked by the content indexer — `files-content-indexer.service.ts:321` recurses with a plain `fs.readdir(dir, { withFileTypes: true })` and **there is no dotfolder or name-based exclusion anywhere in it**, so a `.versions` dotfolder would not save us;
- counted by `dirSize` twice in intent.

Sibling placement grants the isolation trash already enjoys, with zero exclusion logic to maintain. **This isolation exists *only* because of the sibling placement** — see §17 (guardrail) for the regression test that pins it.

### 1.1 Blobs are CoW-cloned or copied — **never hardlinked**

**The implementation plan's hardlink-first design is retracted. It was a correctness bug, not an optimization.** This was caught by a failing test during B2, not by review, so the reasoning is recorded here in full.

A hardlinked blob **shares the live file's inode**. Three of the seven write paths (§4) then truncate that inode *in place* rather than replacing it:

| Path | Destructive call | Effect on a hardlinked blob |
|---|---|---|
| `saveStream` direct branch | `writeFromStream(realPath, …)`, flag `'w'` (`files/utils/files.ts:253`) | **blob overwritten with the new bytes** |
| Collabora / OnlyOffice `saveDocument` | `copyFileContent` — which is `writeFromStream`, same flag | **blob overwritten** |
| `mkFile(overwrite=true)` | `copyFileContent`, or `createEmptyFile`'s `fs.writeFile(rPath, '')` | **blob truncated to zero bytes** |

Only the `moveFiles`-based paths (sync tmpPath, multipart PUT/PATCH, NC chunked assembly) would have been safe, because a rename swaps the inode. So a hardlink store would have silently produced version rows whose content equals the *new* file — the exact opposite of the feature — for editor saves, WebDAV PUTs and sync `make`.

The bitter irony: **the repo's deliberate inode-stability is what makes hardlink snapshotting unsound.** §9 relies on that same property for restore. The two facts are the same fact read from opposite ends, and the plan applied it in only one direction.

**Decision: `fs.copyFile(realPath, blobPath, COPYFILE_FICLONE)`.**

- `COPYFILE_FICLONE` (not `_FORCE`) requests a reflink and **silently degrades to a full copy** when the filesystem can't clone. On APFS/btrfs/XFS this is nearly as cheap as a hardlink; elsewhere it is an honest copy.
- A CoW clone is **independent**: a later in-place write splits the shared blocks instead of corrupting the copy. That is the property the store actually requires.
- It also removes the cross-device special case entirely — no `EXDEV` branch, no `isCrossDevice` call. Cross-device remains a **normal** case (`dataPath`/`usersPath`/`spacesPath`/`tmpPath` are independently configurable, `files.config.ts:85-97`; external roots point anywhere, `spaces/utils/paths.ts:39-47`), and `copyFile` handles it without the code knowing.

### 1.2 The digest is taken from the staged copy, and the copy is published by rename

Three requirements, all discovered while implementing, that together fix the store's one invariant: **a blob's filename is the hash of the bytes under it.**

**Copy first, then hash what was copied — never hash the live file.** Hashing the live file in a pass separate from the copy leaves a window in which the file changes between the two reads. §4 states outright that WebDAV writes hold **no server lock**, so that window is reachable by design, not by bad luck. The blob would then sit under a digest that does not describe it — and because lookups are content-addressed, *every later snapshot of the genuinely-matching content would dedup against that mis-named blob and silently serve the wrong bytes.* This is the only corruption in the design that escapes its own row, which is what makes it worth the extra care.

**Publish by rename.** A crash mid-copy must leave a `.part` file, never a **truncated file at the content-addressed path** — the existence check would trust that as a complete blob forever. Staging lives in `<versions>/.staging/<uuid>.part` so the publish is a same-filesystem rename (atomic); a stage in the OS temp dir could be on another device and would silently become a second copy.

**Rename unconditionally, even on a dedup hit.** Skipping the copy when the digest already exists reintroduces a check-then-act: between that check and the row insert, a concurrent eviction or purge can unlink the blob, leaving a brand-new row pointing at nothing — a version that lists but can never be downloaded. Rename is atomic and the content is byte-identical by construction, so replacing is always safe. **Accepted cost:** one copy that could sometimes have been skipped. Storage dedup is unaffected (the rename lands on the same path); only the write is repeated.

**Cost, stated honestly:** a snapshot is one clone-or-copy plus one streamed read of the staged copy to hash it. On a cloning filesystem the copy is near-free; elsewhere it is a full copy. The plan's "O(1)-ish when hardlink succeeds" performance claim no longer applies, and §6 of the plan should measure the clone and copy cases rather than hardlink vs copy.

## 2. Checksum algorithm — `sha512-256`

**Decision.** `sha512-256`, via the existing `checksumFile(filePath, alg)` (`files/utils/files.ts:210`) with `SYNC_CHECKSUM_ALG` (`sync/constants/sync.ts:5`). Digests are 64 hex chars. Sharding is `<digest[0:2]>` (256 buckets).

**Rationale.** It is the repo standard — the desktop sync protocol already uses it, so choosing sha256 would introduce a second hash algorithm for no benefit. `checksumFile` is stream-based (`pipeline(createReadStream(...), hash)`), so hashing a large file does not block the event loop.

**Algorithm neutrality.** The column is named `checksum`, not `sha512_256`; no DTO or path segment encodes the algorithm. Changing it later is an explicit migration (rehash or dual-read), not a silent format break. Recording the choice here is what makes that an explicit decision.

## 3. DB model — one global table, **id-keyed** on a *guaranteed* `files.id`

**Decision.** A single global **`custom_files_versions`** table (Drizzle-managed, not per-root like `files_trash_*`), keyed on `fileId` → `files.id`, NOT NULL.

**The `custom_` prefix is deliberate, not cosmetic.** Upstream left the versioning TODOs, so them shipping their own `files_versions` is a live possibility rather than a hypothetical — and a table-name collision during an upstream sync would be a migration failure at deploy time. This follows the precedent already set by `custom_files_favorites`, whose schema comment records the same reasoning.

Per-root was rejected: versions need joins against `files` for API queries and for descendant purge, and — unlike trash, which is reconciled by a filesystem scan (`files-trash-retention.service.ts:181`, ids derived from `stats.ino` at :207) — versions have no FS-scan source of truth to reconcile against.

### 3.1 The anchor decision

`space.dbFile` has no `id`, and `files` rows are lazily materialized (Context §1). So `fileId` is *not available* at any hook site and cannot be assumed to exist. Two candidates:

| | Path-keyed (scope columns + path) | **Id-keyed (chosen)** |
|---|---|---|
| Row materialization | not needed | needed on a file's first snapshot |
| Matches upstream addressing | yes — `deleteFiles(props, isDir, force)` (`files-queries.service.ts:193`) predicates purely on (scope, path) via `convertToWhere` | no |
| Rename / move | **every rename must regexp-repath version rows or they orphan** | **zero code** — see §15 |
| Uniqueness | `path` is non-unique by schema: `files.schema.ts:36-43` has indexes on `path` and `name` but **no unique index on (ownerId, path, name)** | PK |
| NC compat | needs a real `files.id` anyway (§D2) — would need the ensurer regardless | native |

**Chosen: id-keyed, with the id guaranteed by a shared `FileRowEnsurer`** (Task B0), using the path-keyed-lookup-then-insert-on-genuine-miss discipline already proven in `custom-mobile-compat/services/nc-file-row-ensurer.service.ts`. That file's header comment (lines 14-40) documents the exact trap being avoided: `getOrCreateUserFile` inserts whenever `file.id <= 0` *without* a path-keyed lookup, and because there is no unique index, repeated calls fan out duplicate rows.

**Cost:** one indexed lookup, plus at most one insert, on a file's *first* snapshot only. **Benefit:** rename/move needs no code; descendant purge is a clean id resolution; NC `fileId` mapping is direct. The trade is accepted deliberately.

### 3.2 Foreign key — `ON DELETE CASCADE` as a backstop, not the mechanism

`filesQueries.deleteFiles` hard-deletes `files` rows on permanent delete, **including all descendants of a directory in one regexp query** (`files-queries.service.ts:193`). A non-cascading FK would make those deletes fail unless version purging always ran first for every descendant.

**Decision: FK to `files.id` with `ON DELETE CASCADE`, *plus* an explicit service-side purge that runs before `deleteFiles` (§10).** The cascade cannot decrement blob refcounts, so it is a safety net against a missed purge path, not the intended mechanism. The gap it leaves — rows gone, blobs stranded — is closed by the orphan-blob GC (§B5). Recorded so nobody removes the explicit purge on the grounds that "the FK handles it."

### 3.3 Columns

| Column | Type | Notes |
|---|---|---|
| `id` | bigint unsigned PK autoincrement | matches `files.id` style (`files.schema.ts:19`) |
| `fileId` | bigint unsigned **NOT NULL**, FK → `files.id` `ON DELETE CASCADE` | the anchor (§3.1) |
| `ownerId` / `spaceId` / `spaceExternalRootId` / `shareExternalId` | bigint unsigned nullable | denormalized scope, mirroring the `files` pattern (`files.schema.ts:20-26`) — a **non-authoritative cache**, see §15 |
| `checksum` | char(64) | §2 |
| `size` | bigint unsigned | logical size of the snapshotted content |
| `mtime` | bigint unsigned | mtime **of the superseded content**, in ms (repo convention) |
| `createdAt` | datetime | when the snapshot was taken |
| `authorId` | bigint unsigned nullable, FK → `users.id` | nullable for system-originated snapshots |
| `origin` | enum | `web`, `web-patch`, `webdav`, `sync`, `sync-make`, `nc-chunked`, `nc-text`, `collabora`, `onlyoffice`, `restore` |
| `label` | varchar(255) nullable | named revisions; never coalesced, never auto-expired |
| `versionsRoot` | varchar | discriminator `user:<login>` \| `space:<alias>` — resolves the blob path without recomputing a space env, and pins the blob's actual location across cross-space moves (§15) |

**No `path` column.** Deliberately omitted. A denormalized path would create a repathing obligation on every rename for no benefit, since purge resolves ids *through* `files`. §17 guardrail 10 exists to stop this being "added for convenience."

**No separate blobs table for v1.** Refcount is `COUNT(*)` over `(checksum, versionsRoot)` at purge time, backed by an index. **Dedup and refcount are scoped PER versions root**, because blobs are physically per root — identical content in two roots is two blobs, by design. Recorded explicitly so the E2E asserts both directions (E2E-9).

## 4. Version creation semantics — synchronous pre-write snapshot

**Decision.** A version is **the content about to be destroyed**, captured **synchronously inside the write path**, immediately before the destructive operation. Creation of a new file (`ACTION.ADD`) is never versioned. The `FileEvent` bus is buffered/async (`files-event-manager.service.ts`) and therefore usable only for post-write bookkeeping — never for the snapshot itself, because by the time an event fires the old bytes are gone.

The destructive moment differs per path, and each hook targets it exactly (§B3 table in the plan):

| Entry point | Destructive moment | Verified |
|---|---|---|
| `saveStream` direct branch | `writeFromStream` opens the LIVE file with flag `'w'` when `start === 0` | `files/utils/files.ts:253` |
| `saveStream` tmpPath branch | `moveFiles(tmpPath, realPath, true)` | `files-manager.service.ts:166` |
| `saveMultipart` PUT **and** PATCH | `moveFiles(tmpFile, dstFile, true)` | `files-manager.service.ts:292` |
| Collabora `saveDocument` | `copyFileContent(tmpFilePath, req.space.realPath)` | `collabora-online-manager.service.ts:137` |
| OnlyOffice `saveDocument` | `copyFileContent(tmpFilePath, space.realPath)` | `only-office-manager.service.ts:409` |
| NC `assembleAndMove` | `moveFiles(tmpPath, space.realPath, true)` | `nc-uploads.controller.ts:212` |
| `mkFile(overwrite=true)` | `copyFileContent(srcSample, ...)` or `createEmptyFile(...)` | `files-manager.service.ts:365` / `:369` |

**Resumed chunks are never snapshotted.** In the direct branch, `writeFromStream` uses flag `'a'` when `start > 0` (`files/utils/files.ts:253`), and `saveStream` validates `startRange === fileSize` (`files-manager.service.ts:147-150`). A `startRange > 0` request therefore sees `fExists === true` while the live file **already holds partial new content** — snapshotting there would capture a half-written frankenfile. The gate is `fExists && !isDir && startRange === 0`.

**POST needs no snapshot.** `saveStream` rejects an existing path for POST at :105-107 and `saveMultipart` rejects per-part at :211-213 / :234-236.

**Locking — honest scoping.** A server lock is created only in the **non-DAV** branch: `filesLockManager.create(...)` at `files-manager.service.ts:127`. WebDAV requests get `checkConflicts` only (:119-124) and hold **no lock during the write**. Therefore:

- non-DAV `saveStream` writes, and the snapshot inside them, **are** under a lock;
- the `webdav` origin's snapshot is **best-effort under concurrency**. Do not document or claim "under lock" semantics for it. E2E-14 asserts *no corruption* for the DAV case, not a strict version count.

## 5. Coalescing — per (fileId, authorId, origin), config-driven

**Decision.** `minIntervalSeconds` (default **60**). Before snapshotting, if the newest version for the tuple `(fileId, authorId, origin)` is younger than the interval **and unlabeled**, skip — the pre-session state is already captured. Applied to the editor, `nc-chunked`, `web-patch`, and `webdav` origins.

**Labeled versions are never coalesced and never auto-expired** (§6).

**OnlyOffice cadence — already answered from source, no measurement needed.** `only-office-manager.service.ts:142-176` calls `saveDocument` only from callback statuses **2** (no active users / closed unsaved), **3** (save error retry), **6** (forcesave) and **7** (forcesave error). Status 1 (users connect/disconnect) does not save. **There is no autosave-per-keystroke path**, so coalescing is near-moot for `onlyoffice`; it stays enabled for uniformity but is expected to rarely fire. Task D4 confirms empirically but does not re-derive.

Collabora's cadence is genuinely unknown from source (the WOPI host is driven by the Collabora container's own autosave timer) and is measured in D4 to tune the default.

## 6. Retention — mirror the trash retention config shape

**Decision.** `FilesVersionsConfig`, added to `files/files.config.ts`, mirroring `FilesTrashRetentionConfig` (:51-63) **including its `0 → false` Transform + `ValidateIf` idiom** so `0` means "off" rather than "immediately expire everything":

```ts
class FilesVersionsConfig {
  enabled: boolean = false                      // §13
  maxVersionsPerFile: number | false = 20
  retentionDays: { users: number | false; spaces: number | false }   // split, exactly like trashRetention
  quotaShare: number | false = 0.5              // §7; NC's default is 50%
  minIntervalSeconds: number = 60               // §5
}
```

v1 enforces `maxVersionsPerFile` + `retentionDays` + `quotaShare`. An NC-style thinning ladder (keep-per-hour/day/week) is explicitly **deferred**.

## 7. Quota — versions count, capped eagerly, and the unachievable promise is dropped

This section replaces the draft's claim that snapshotting "never blocks the user's save." That was **unachievable** and is retracted here.

**Verified.** `spaces/guards/space.guard.ts:52-56` reads `content-length` and calls `req.space.willExceedQuota(contentLength)` as a **pre-flight upload rejection**. `willExceedQuota` (`spaces/models/space-env.model.ts:136-141`) compares against `storageUsage`, which is sourced from a **cached `dirSize` result with `CACHE_QUOTA_TTL = 86400` — one day** (`files/constants/cache.ts:15`). The same guard shape recurs at `files-manager.service.ts:463` (copyMove) and in the sync manager. **This guard runs before any versioning code executes.**

**Decisions:**

1. **Versions count toward quota.** Zero code — `files-quota-manager.service.ts:110` computes usage as `dirSize(UserModel.getHomePath(login))`, and `dirSize` (`files/utils/files.ts:322`) walks everything with no exclusions. Anything under the home path counts automatically. This is consistent with **trash, which counts today**.
2. **`quotaShare` is enforced eagerly, inside `snapshotBeforeOverwrite`** — not only by the scheduler. Current usage is `SELECT SUM(size) WHERE versionsRoot = ?` (cheap and indexed — explicitly **not** a `dirSize` walk). While `used + newSize > quota * quotaShare`, evict the oldest **unlabeled** version (decrementing blob refcounts) before inserting. Skipped entirely when the space has no `storageQuota` (`willExceedQuota` itself returns false in that case, :137).

   **Four constraints on that loop, all learned from bugs it actually had.** Review found the first two as reproducible data loss; record them so the loop is never "simplified" back:

   - **A write larger than the ceiling is not versioned at all.** The condition `used + incoming > ceiling` is unsatisfiable when `incoming > ceiling`, so an unguarded loop evicts until nothing unlabeled remains — destroying every *other* file's history in the root — and then inserts anyway, still over the ceiling. Maximum destruction, zero benefit. Refusing that one write is correct; the caller degrades to "no version".
   - **A restore's own safety snapshot is exempt from the cap.** It is a net, not new growth — and worse, eviction picks the oldest unlabeled version, which is very often *exactly the revision being restored*. See §9.
   - **The ceiling must be sized against the same scope the root belongs to.** `space.storageQuota` is the *current env's* allowance, but for a share with an external path `versionsRootFromSpace` resolves to the acting **user's** root. Using the env's quota there evicts the user's personal history to fit a write into someone else's small share. When the scopes do not line up, skip the eager cap and leave it to the B5 backstop.
   - **A dedup hit costs zero disk bytes and must not evict anything.**
3. **`SUM(size)` is *logical* size and over-counts when dedup hits.** The cap is therefore conservative — accepted.
4. The scheduler (B5) re-checks `quotaShare` as a **backstop** alongside `retentionDays` and `maxVersionsPerFile`.
5. **Evictions are logged at `log` level, not verbose.** Silently deleting a user's history deserves an audit trail.

**The honest claim, recorded verbatim for reuse in release notes:**

> Snapshotting never grows storage usage beyond `quotaShare` of a space's quota.

**Not**: "saves are never blocked." A user whose *real files* fill the remaining quota is rejected by the pre-existing guard exactly as they are today. Versioning's worst case is a **bounded, documented reduction of usable quota by the `quotaShare` fraction**. Because that reduction is otherwise invisible, the C2 versions-usage display is a **release blocker, not a nice-to-have** (§14).

**Rejected for v1: excluding versions from the quota walk.** It would require a `mod()` on the quota manager (adding merge-conflict surface to a hot upstream file), break the trash precedent, and remove all backpressure — the volume could fill with no user-visible signal.

## 8. External roots and guest/link users

**External roots.** Files under `spaceExternalRootId` / `shareExternalId` can be modified out-of-band. **v1 versions only writes that go through the app**; direct filesystem writes are not versioned and no watcher is added. Cross-device copy fallback applies per §1 (external paths are routinely a different device).

**Guest and link users — versioning is skipped entirely.** `snapshotBeforeOverwrite` no-ops when `user.isGuest || user.isLink`.

**Rationale (verified).** `UserModel.getHomePath(login, isGuest, isLink)` puts guests under `tmpPath/guests/<login>` and links under `tmpPath/links/<login>` (`user.model.ts:135-148`), whereas `getTrashPath(login)` calls `getHomePath(login)` **without those flags** (:154-156) and so resolves into `usersPath`. A `getVersionsPath` modeled on it would inherit the same split: versions for a guest upload would be written outside the ephemeral tree that holds the live files, outliving the guest home and accumulating unreferenced blobs. Skipping also avoids a guaranteed cross-device copy on every public-link upload. Public links are a sharing surface, not a document-authoring surface; version history there has no user to show it to.

## 9. Restore — `copyFileContent`, never `moveFiles`; the inode must survive

**Decision.** Restore is: acquire a lock → snapshot the *current* content as a new version with origin `restore` → replace live content with **`copyFileContent(blobPath, realPath)`** → update the `files` row (size/mtime) → emit `FileEvent` UPDATE → release the lock.

**`moveFiles` is forbidden here.** Rationale, all verified:

- Both editors deliberately use `copyFileContent` instead of a move, with comments saying so: *"copy contents to avoid inode changes (dbFileHash in some cases)"* (`collabora-online-manager.service.ts:135`) and *"copy contents to avoid inode changes (`file.id` in some cases)"* (`only-office-manager.service.ts:407`).
- `copyFileContent` (`files/utils/files.ts:293-296`) is `writeFromStream(dstPath, srcStream)` with `start = 0`, which opens with flag `'w'` (:253) — **truncate in place, inode preserved**.
- Trash retention keys records on inodes (`files-trash-retention.service.ts:207`, `id: stats.ino`, with explicit inode-reuse handling at :263).
- `dbFileHash` / `file.id` consumers depend on inode stability.

A restore that swapped the inode would look like a delete+create to trash retention and to any inode-keyed consumer. E2E-2 and E2E-11 assert `stat().ino` is unchanged.

**The blob must be opened before anything else runs.** Review found reproducible data loss here. The first implementation resolved the blob path, checked it existed, and *only then* took the pre-restore snapshot — a check-then-act. That snapshot's quota eviction picks the oldest **unlabeled** version, which is very often **exactly the old revision the user asked to restore**. It unlinked the blob, and the write then truncated the live file to zero bytes before failing to read its source. Asking to go back destroyed both the file and the thing you asked to go back to.

Three fixes, all now in the code:

- **Open the blob first and write the live file from that descriptor**, not from the path. An open descriptor keeps the bytes alive across an `unlink`, so nothing can pull them away mid-restore.
- **Exempt a restore's own snapshot from the quota cap** (§7) — it is a safety net, not new growth.
- **Verify the blob's size against its row before touching the live file.** `writeFromStream` truncates the destination the moment the stream opens, so a short or corrupt source has to be caught while the live content is still intact.

The general lesson, worth more than the specific bug: **anything that reads a blob must pin it before running code that can evict.** Eviction and reads share no lock.

The lock is created the way non-DAV `saveStream` does it (`filesLockManager.create`, `files-manager.service.ts:127`) — restore is always an app-initiated action, never a DAV write, so it always runs under a real lock.

## 10. Trash and delete interplay

**Verified lifecycle.** Trashing a file sets `inTrash = true` and **keeps the row with a stable id** (`deleteFiles(props, isDir, force=false)`, `files-queries.service.ts:193`). Only a permanent delete hard-deletes rows.

| Event | Version behavior |
|---|---|
| File → trash | `files` row survives, id stable → **versions kept** |
| Restored from trash | versions still attached, nothing to do |
| Permanently purged | version rows deleted, blob refcounts decremented |

**Hook points, both verified against `FilesManager.delete` (`files-manager.service.ts:525-597`):**

1. **The `space.inTrashRepository` branch (:539-541)** — `removeFiles` + `DELETE_PERMANENTLY` event, with `forceDeleteInDB` remaining **false**. This is the **common** permanent-delete path (emptying the trash), and a design that hooked only `forceDeleteInDB` would miss it entirely.
2. **The `forceDeleteInDB` fallback (:572-582)** — the rare "no trash path resolvable" case.

Both converge on `filesQueries.deleteFiles(space.dbFile, isDir, forceDeleteInDB)` at **:592**. Purge must run **before** that call — required both by FK ordering (§3.2) and because descendant ids are only resolvable while the rows still exist.

**Directory deletes.** `deleteFiles` removes **all descendant rows in a single regexp query**, so `purgeForFile(fileId)` alone misses children. API is therefore two methods:

- `purgeForFile(fileId)`
- `purgeForPath(props, isDir)` — resolves ids with `SELECT id FROM files WHERE <scope> AND childFilesFindRegexp(path)`, reusing the exported helper at `files.schema.ts:52`, then purges by id.

**Trash retention scheduler — deliberately not hooked.** `files-trash-retention.service.ts` is filesystem-scan based: the scan is the source of truth (`readdir` at :181), records not seen in a run are dropped, and ids are inode-derived (:207). **It does not hold `files.id`.** Attempting an inode↔id join there would be fragile and is **rejected**.

**Correction (found in review — the original delegation here was wrong).** This section used to say trash retention "simply lets B5's dangling-row GC absorb the case". **It cannot.** Verified:

1. `files-trash-retention.service.ts` never touches the `files` table at all — only its own `files_trash_*` tables and the filesystem. So when retention permanently removes a trashed file from disk, its `files` row survives with `inTrash = true`.
2. Before this feature, that row was unreferenced and the nightly orphan sweep (§20) deleted it. **Now our own version rows reference it, so the sweep skips it — permanently.**
3. `danglingRows` is `LEFT JOIN files … WHERE files.id IS NULL`. Since the `files` row never disappears, it never matches. The absorption mechanism can never fire.

In other words: **version rows *pin* `files` rows against the sweep.** That is the same mechanism §20 relies on to keep ensurer-materialized rows alive, read from the other side — and it disables the reclamation path this section delegated to.

**Revised decision, second attempt — the first one was wrong.** An earlier revision of this section said: *"purge version rows whose `files` row has `inTrash = true` and whose age exceeds the trash retention window."* That was implemented faithfully and **destroyed restorable history**, because "whose age" can only mean the *version's* age and a version's age is unrelated to when its file was trashed:

- A version's `createdAt` is when the file was **overwritten** — arbitrarily long before it was trashed. So `createdAt < now − window` implies nothing at all about how long the file has been in the trash.
- There is **no trashed-at timestamp addressable by `files.id`**. The `files` row carries only the `inTrash` boolean (`files-queries.service.ts` sets `{ inTrash: true }` and nothing else); the trash sweeper's own `deletedAt` lives in per-root, **inode-keyed** `files_trash_*` tables, which §10 already rejected joining against.
- Concretely: a document last edited two months ago, trashed today, with `trashRetention.users = 30` — every version is older than the cutoff, so the whole history is deleted on the **first nightly sweep**, while the file itself stays restorable for the full 30 days. That directly contradicts this section's own table row, *"Restored from trash → versions still attached."*

**So there is no trash-age rule.** The reclamation that remains:

- `retentionDays` expires old unlabeled versions **regardless of trash state** — it filters on age alone — so nothing is retained indefinitely merely because a file is in the trash.
- `quotaShare` bounds total growth per root.
- Permanently deleting the trash entry runs `purgeForPath`, which reclaims properly.

**Accepted, documented leak:** history of a file whose *trash entry expired on disk* survives until that entry is permanently deleted, because trash retention removes the disk copy without touching the `files` row. A documented leak beats undocumented data loss. Re-adding a trash-age rule requires **first** adding a real trashed-at timestamp (a fork-owned table keyed on `fileId`, which would also join the §20 protected union automatically) — not another proxy.

`danglingRows` stays as a backstop for the genuinely-dangling case (a `files` row hard-deleted where the explicit purge was missed), but per the analysis above it is not the mechanism for anything routine.

## 11. `copyMove` overwrite — no snapshot

**Decision.** No versioning hook in `copyMove`.

**Rationale (verified).** On overwrite, `copyMove` calls `this.delete(user, dstSpace)` (`files-manager.service.ts:488-489`) **before** the move/copy, which moves the destination **to trash** — so the overwritten content is already recoverable, and its version rows travel with the trashed `files` row (id stable per §10). Additionally, for task transfers the delete is **deferred via a callback** passed into `filesTasksTransfer.move` (:496) / `.copy` (:516), so a single inline hook at :489 would silently miss that path anyway.

Trash coverage is the mechanism; document it rather than duplicating it. Revisit only if trash retention windows prove too short in practice. E2E-16 asserts both halves (recoverable from trash, *and* no version row created).

## 12. Module placement

- **`backend/src/applications/custom-versioning/`** — `VersioningService`, schema, controller, retention service, utils. Fork-isolated, so upstream never touches it.
- **`backend/src/applications/custom-shared/`** — the `FileRowEnsurer` (Task B0).

  It lives here rather than in `custom-versioning` because **`custom-mobile-compat` must not depend on `custom-versioning`**: versioning is feature-flagged off by default, while mobile-compat needs the ensurer *unconditionally* for correct `oc:fileid` emission (§13).
- **Upstream consumption is via small `mod()` hooks** in `files-manager.service.ts` and the two editor managers — single-purpose commits, ideally ≤10 lines each, greppable via `git log --grep '^mod('`.
- **`nc-uploads.controller.ts` is fork-owned** (already a `custom-*` path), so its hook is a normal commit, not a `mod()`.

**Upstreaming is not pursued for v1.** Recorded deliberately: the design leans on fork-specific modules and a fork config surface, and upstream may ship their own versioning (they left the TODOs). Containment — a module boundary plus tiny hooks — is the strategy for surviving that (§18).

## 13. Feature flag — `files.versions.enabled`, default OFF

**Decision.** Everything gates on `files.versions.enabled`, checked **inside** `VersioningService` so that every hook site is a one-line call that no-ops when disabled. All REST endpoints return 404 when off; the NC `files_versions` capability is absent when off.

**The `FileRowEnsurer` is explicitly NOT gated by this flag.** Mobile-compat's `oc:fileid` correctness depends on it regardless of whether versioning is enabled — gating it would regress NC iOS previews (see the `nc-file-row-ensurer.service.ts:14-40` comment for what breaks). E2E-13 asserts the flag-off state *and* that the ensurer still functions.

## 14. Frontend target — `custom-v2` only

**Decision.** Version history ships **only** in `frontend/src/app/applications/custom-v2/`. No file under `frontend/src/app/applications/files/` is modified.

Per CLAUDE.md's classic-as-ground-truth rule, the classic screens are **reference reading**: `components/sidebar/files-selection.component` for how lock/comments render inside a selection panel, and `components/dialogs/files-trash-dialog.component` for list-dialog structure. Read them for API-call shape and structure; do not edit them.

**Rationale.** v2 is the UI this fork ships and iterates on, and confining the frontend to `custom-v2` keeps the entire frontend off the upstream merge-conflict surface. **Classic-UI parity is explicitly out of scope for v1.**

i18n goes in `frontend/src/i18n/custom/{en,nl}.json` only — `v2_*` prefix for parameterized keys, plain-English literals for short static strings. Upstream i18n files are never touched.

## 15. Move and rename — free under the id-keyed anchor

**Decision.** A plain rename or move is **not** an overwrite and creates **no version**. It also requires **no code**.

**Rationale (verified).** `filesQueries.moveFiles(srcProps, dstProps, isDir)` (`files-manager.service.ts:506` → `files-queries.service.ts:235`) regexp-updates `files.path` while **`files.id` is unchanged**. Because version rows key on `fileId` (§3.1), they follow the file automatically. Under the rejected path-keyed alternative, every rename would have needed a parallel regexp repath of `custom_files_versions` — and any miss would orphan an entire file's history.

**This is a reason *for* the anchor choice, not an afterthought.** E2E-19 exists to make it enforceable: it fails loudly if anyone re-keys versions on path.

**Cross-space moves.** `moveFiles(srcProps, dstProps)` moves the row's scope, so the **denormalized scope columns on `custom_files_versions` go stale**.

**Decision: the denormalized scope columns are a non-authoritative cache.** They exist to avoid a join when resolving a versions root, never to make an authorization decision. Authoritative scope is always the `files` row plus the space env the caller already resolved — which is how every other permission check in the codebase works. Consequences:

- A stale scope column **cannot** cause a privilege error, because it is never the basis of one.
- No repathing or re-deriving job is added. Columns are refreshed opportunistically on the file's next snapshot.
- **The blob may now live under the *previous* root's versions directory.** v1 accepts this: the `versionsRoot` column records where the blob actually is, and reads resolve through it. **B5's GC must match on `versionsRoot`, not on the file's current space**, or it would delete a moved file's blobs as orphans. E2E-19 covers both halves.

## 16. Dependencies — none added

**Decision.** No new npm dependencies. Verified: `backend/package.json` has no `diff`/`jsdiff`/`fast-diff`. The unified-diff endpoint (§B4) uses a small hand-rolled LCS-based diff in `custom-versioning/utils/unified-diff.ts`, size-capped at 2 MB and restricted to text mimetypes (415 otherwise). `fs-extra` (already present, `backend/package.json:65`) backs the existing `moveFiles`/`copyFiles` helpers and needs no addition.

---

## 17. Guardrails (enforced in review)

1. **Write-path completeness.** Any code path that overwrites live file content gains a snapshot hook **and** an E2E case before merge. On every upstream sync, grep for new `writeFromStream` / `copyFileContent` / `moveFiles(..., true)` / `createEmptyFile` call sites and extend the plan's §7.9 table.
2. **Inode stability, read in both directions.** No code in this feature may replace a live file's inode — restores and any live-content replacement use `copyFileContent` (§9). And *because* writes truncate in place, no blob may ever share an inode with a live file: blobs are cloned or copied, never hardlinked (§1.1). Anyone "optimizing" the store back to `fs.link` reintroduces silent history corruption; `versioning.service.spec.ts` has the test that fails.
3. **Anchor invariant.** Version rows key on `files.id`, never on path. Any change adding a path column or path-based lookup to `custom_files_versions` must first explain how rename/move repathing is handled (§15).
4. **Quota honesty.** Never document or claim that versioning cannot cause a failed save (§7).
5. **Store isolation is placement-dependent.** The indexer has no dotfolder exclusion (`files-content-indexer.service.ts:321`). A test proves the versions directory is not indexed, not present in a WebDAV PROPFIND of the space root, and not in a sync diff — as a regression guard against "simplifying" the store back inside the files root.
6. **Migrations via tooling only.** Every schema change goes through `npm -w backend run db:generate` → generated SQL + `meta/` snapshot → `db:check`. No hand-written or hand-edited migration files, ever. (`files_trash_*` is a scan-managed raw-SQL exception owned by upstream; `custom_files_versions` is a normal Drizzle table.)
7. **`npm run build -w backend` must pass before pushing.** vitest's type check does not catch service↔real-class type errors.

## 18. Upstream-sync watch list

Upstream left versioning TODOs and may ship their own implementation. The containment strategy is the `custom-versioning` module boundary plus minimal hooks. **`mod()` sites to re-verify on every upstream sync:**

| File | Sites |
|---|---|
| `files/services/files-manager.service.ts` | `saveStream` ×2 (:156-158 direct, :166 tmpPath), `saveMultipart` (:292 region), `mkFile` (:363 region), `delete` ×2 (:539-541, :572-582), purge before `deleteFiles` (:592) |
| `files/editors/collabora-online/collabora-online-manager.service.ts` | before `copyFileContent` (:137) |
| `files/editors/only-office/only-office-manager.service.ts` | before `copyFileContent` (:409) |
| `files/files.config.ts` | `FilesVersionsConfig` registration |
| `files/services/files-scheduler.service.ts` | `deleteOrphanFiles` — §20's protection exists only while this cron keeps discovering tables via `getTablesWithFileIdColumn()`. If an upstream sync replaces that with a hard-coded table list, the guard test stays green and the protection is gone. |
| `infrastructure/database/utils.ts` | `getTablesWithFileIdColumn` — the reflection §20 depends on |
| `infrastructure/database/schema.ts` | `custom_files_versions` export |
| `files/services/files-event-manager.service.ts` | the replaced `todo` comment (:20) |

Fork-owned, no `mod()` needed: `custom-mobile-compat/controllers/nc-uploads.controller.ts` (:212).

## 19. Rollout

Merge with the flag **OFF** → enable on staging → soak against real Collabora/OnlyOffice and NC iOS/Android clients (the chunked-upload path especially) → default ON in a `-custom.<n>` release.

**Task B0 ships independently of the flag and must soak first** — it refactors load-bearing NC PROPFIND code, where a regression breaks iOS previews.

**Release-note requirements (blockers, not nice-to-haves):** enabling this feature silently reduces every user's effective quota by up to `quotaShare`. The release note must say so in the §7 wording, and the C2 usage display must ship with it. Deployment docs must add the per-home `versions/` directories to the backup set alongside `files/`, `trash/`, and the database.

## 20. The nightly orphan sweep — an interaction found during implementation

Not in the implementation plan; discovered while wiring the schema (B1) and load-bearing enough to record here.

**`FilesScheduler.deleteOrphanFiles` (`files-scheduler.service.ts:154`, `@Cron EVERY_DAY_AT_4AM`) deletes every `files` row that is not referenced by any table carrying a `fileId` column.** It discovers those tables *by reflection* over `infrastructure/database/schema.ts`, via `getTablesWithFileIdColumn()` (`infrastructure/database/utils.ts:93`), and unions their distinct `fileId`s.

This cuts two ways.

**It is why the ensurer's rows survive.** Versioning materializes `files` rows for files with no other reference — an uploaded, never-shared, never-commented file. Because `custom_files_versions` has a `fileId` column *and* is exported from `schema.ts`, its rows join the protected union automatically. No code needed.

**It is also a silent-data-loss trap**, because both halves of that contract are implicit. Rename the **TypeScript property** away from `fileId` (the SQL column name is free — both the reflection and the sweep's `table.fileId` go through the property), or drop the `schema.ts` export, and the 4 AM sweep starts deleting exactly those rows — at which point the `ON DELETE CASCADE` from §3.2 takes **every version of every affected file** with them. Nightly, silently, with no error. `files-versions.schema.spec.ts` asserts both halves for this reason; treat a failure there as a data-loss bug, not a style nit.

**Accepted consequence: `fileId` is not eternal for files with no other reference.** When retention prunes a file's *last* version, its `files` row may become unreferenced and be swept that night. The next snapshot then materializes a *new* row with a *new* id. This is harmless — no version rows exist to orphan — and matches how upstream already treats favorites- and comments-only rows. But it means "the id is stable" holds *while history exists*, not forever. Nothing in this design depends on the stronger claim.

**Note for `custom-mobile-compat`:** the same sweep already applies to rows `NcFileRowEnsurer` materializes, so an `oc:fileid` for an FS-only, unreferenced file is not stable across nights. That is pre-existing behavior, out of scope here, and recorded only so it is not later misdiagnosed as a versioning regression.
