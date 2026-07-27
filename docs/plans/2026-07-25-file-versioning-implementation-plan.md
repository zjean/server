# File Versioning Implementation Plan — zjean/server (Sync-in fork)

Audience: orchestration agent dispatching subagent tasks. Each task has an ID, dependencies, exact file targets, deliverables, verification tests, and acceptance criteria. Follow repo conventions in `CLAUDE.md` strictly (branch naming, `custom-*` isolation, `mod()` commits, squash merge for feature/mod PRs, PR flow to `zjean/server` only).

**Revision 2 (2026-07-25)** — finalized after codebase verification of the draft. Six substantive changes, all marked `[R2]` inline:

1. **Anchor resolved.** `space.dbFile` carries no `id` and `files` rows are lazily materialized, so `fileId` is not available at any hook site. Versions are id-keyed, with the id guaranteed by a promoted `FileRowEnsurer` (new task **B0**). Directory purge resolves descendant ids from `files` before the row delete.
2. **Write paths: SIX, not four.** Added `saveMultipart`'s PATCH branch (the web text-editor save) and `mkFile(overwrite=true)` (sync client `make`, truncates to zero bytes).
3. **Quota §7 rewritten.** Versions still count (zero code), but `quotaShare` is enforced *eagerly inside the snapshot path*. The draft's "never blocks the user's save" was unachievable — the rejection happens in `space.guard.ts` before versioning code runs.
4. **Move/rename semantics added** as ADR §15 (was absent entirely). Free under the id-keyed anchor; the ADR must record *why* so nobody "simplifies" to path-keying.
5. **Frontend target resolved:** `custom-v2` only (ADR §14).
6. **Hardlink-same-device downgraded** from guarantee to likely-but-config-dependent.

---

> ## ⚠️ STATUS (2026-07-27): Phases A and B are BUILT AND MERGED. Parts of this plan are SUPERSEDED.
>
> **Start here instead:** [`2026-07-27-file-versioning-handoff.md`](2026-07-27-file-versioning-handoff.md), then
> [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) (the ADR).
>
> **The ADR is the authority.** Where this plan and the ADR disagree, the ADR is right — it was corrected three
> times during implementation, by failing tests and by review. This plan was not.
>
> Phases A and B (tasks A1, B0–B6) shipped as PRs #310–#317. This document remains accurate for **Phases C, D and E**.
> Its Phase-A/B task bodies are kept as a record of what was planned, **not as instructions**.
>
> **Several designs in here are wrong and would destroy data if implemented as written.** Each is marked inline where
> it appears. Do not act on a Phase-A/B instruction without checking for a `SUPERSEDED` note beside it.
>
> Drift that is merely out of date (following it gets you a compile error, not data loss):
>
> | This plan says | Reality |
> |---|---|
> | table `files_versions` | **`custom_files_versions`** — the `custom_` prefix avoids collision if upstream ships its own (ADR §3) |
> | `realVersionsPathFromSpace(user, space)` | `versionsRootFromSpace()` + `versionsPathFromRoot()` in `custom-versioning/utils/paths.ts` |
> | `purgeForDescendants(scopeProps, path)` | `purgeForPath(props, isDir)` |
> | scope columns "refreshed lazily from `files` on read" | refreshed on the file's next snapshot via `refreshScope`; never authoritative (ADR §15) |
> | snapshot is "O(1)-ish when hardlink succeeds" | retracted — there is no hardlink; cost is one clone-or-copy plus one hash of the staged copy (ADR §1.2) |
> | B5 "dangling-row GC (row whose blob is missing…)" | not implemented; implementing it literally is dangerous — see the handoff's "known gaps" |

Non-negotiable constraints derived from verified codebase behavior: editors replace live content via `copyFileContent`, never `moveFiles` (inode stability is deliberate; restore must honor it); there are **six** overwrite paths, including NC chunked uploads and `saveMultipart` PATCH which bypass or are easily missed under `saveStream`-centric thinking; **`files` rows are lazily materialized and `space.dbFile` has no `id`, so every snapshot must ensure a row first**; the repo checksum standard is `sha512-256`; the blob store lives as a sibling of the files repository (like trash), never inside it; quota is computed by `dirSize` over the whole home path, so versions count toward quota **and the pre-flight upload guard is synchronous off a 1-day cache**; the direct-write branch of `saveStream` destroys the file at the first byte, so its snapshot gate is `fExists && startRange === 0`; WebDAV writes hold no server lock; permanent-delete purging must cover the `inTrashRepository` branch and directory descendants; `copyMove` overwrite already trashes the destination and needs no snapshot; all database migrations are generated via drizzle-kit tooling, never hand-written.

---

## 0. Grounding facts (verified in codebase 2026-07, do not re-derive)

- Backend: NestJS + Fastify, Drizzle ORM on MySQL/MariaDB. Files live on the plain filesystem; the `files` table (`backend/src/applications/files/schemas/files.schema.ts`) is metadata only: id, owner/space/root/share FKs, path, name, isDir, inTrash, mime, size, mtime, ctime. No checksum column, no version concept.

- **`[R2]` The `files` table is a sparse, lazily-populated index — NOT a row-per-file mirror.** This is the single most consequential fact for this feature and the draft missed it:
  - `FileDBProps` (`files/interfaces/file-db-props.interface.ts:3-12`) has **no `id` field**. It is `{ownerId?, spaceId?, spaceExternalRootId?, shareExternalId?, inTrash, path}` — a *scope + path descriptor*.
  - `space.dbFile` is built by `dbFileFromSpace` (`spaces/utils/paths.ts:128`) from the space env alone, with **no DB lookup**. So at every write-path hook site the code holds `user` + `space` and therefore a scope+path descriptor, never a `files.id`.
  - Rows are materialized on demand by `filesQueries.getOrCreateUserFile` (`files-queries.service.ts:120`) / `getOrCreateSpaceFile` (:136), called only by shares (`shares-manager.service.ts:170,218,380`), comments (:93), `custom-favorites` (:70), recents, `sync-paths-manager` (:223-225), and `custom-mobile-compat` nc-dav (:394,402). **A file that has only ever been uploaded and edited has no row and no id.**
  - `filesQueries.deleteFiles(props, isDir, force)` (:193) predicates entirely on (scope, path) via `convertToWhere` — never on id. Upstream's addressing primitive is (scope, path) throughout.
  - The `files` table has **no unique index on (ownerId, path, name)** — documented in `custom-mobile-compat/services/nc-file-row-ensurer.service.ts:36-40`, which exists precisely because calling `getOrCreateUserFile` blindly fans out duplicate rows on repeated calls. That service is the working precedent for materializing a row safely (path-keyed lookup first, insert only on genuine miss) and is the basis for **B0**.
  - Where a row *does* exist, `files.id` is genuinely stable: stable across moves (`copyMove` regexp-updates `files.path` via `filesQueries.moveFiles`) and stable across trashing (`deleteFiles` sets `inTrash = true`, keeps the row). Only permanent delete (row already `inTrash`, or `force`) hard-deletes rows, including all descendants of a directory via a single regexp query.

- **`[R2]` Write paths. There are SIX, not four:**
  1. `FilesManager.saveStream()` (`files-manager.service.ts:99`) — called by `files-methods.service.ts` (web), `webdav/services/webdav-methods.service.ts:221` (WebDAV PUT, no `tmpPath`, direct write), `sync/services/sync-manager.service.ts:51` (desktop client, `tmpPath` + `SYNC_CHECKSUM_ALG`), `custom-mobile-compat/controllers/nc-text-editor.controller.ts:207`.
  2. `FilesManager.saveMultipart()` **PUT branch** (`files-manager.service.ts:196`) — web multipart overwrite; writes to a tmp file first, with deferred destructive deletes (:283-291) before `moveFiles(tmpFile, dstFile, true)` at **:292**.
  3. **`[R2]` `FilesManager.saveMultipart()` PATCH branch — a distinct overwrite path the draft folded into "overwrite" and would have missed.** `overwrite` is `req.method === PUT` only (:205), but `tmpFile = overwrite || patchMethod` (:241) and PATCH *requires* the destination to exist (:237-239). PATCH therefore flows through the same `moveFiles` at :292. This is the **web text-editor save path** — it is tagged `source: 'editor'` at :315. A hook gated on `overwrite` alone ships a hole in one of the most common save flows.
  4. Editor saves BYPASS saveStream: `files/editors/collabora-online/collabora-online-manager.service.ts` (`saveDocument` at :115, `writeFromStream` to `os.tmpdir()` at :120) and `files/editors/only-office/only-office-manager.service.ts` (`saveDocument` — **private**, at :352; callback download `writeFromStream` at :388). Both then replace the live file with **`copyFileContent(tmpFilePath, space.realPath)`** at :137 / :409 respectively — NOT `moveFiles`. The code comments at :135 / :407 say this is deliberate, "to avoid inode changes" (`dbFileHash` / `file.id` depend on inode stability). Both emit `FileEvent` UPDATE with `source: 'editor'`. Collabora has `req.user`; OnlyOffice's `saveDocument(user, space, url)` takes the acting user as a **parameter**.
  5. **NC chunked uploads BYPASS saveStream**: `custom-mobile-compat/controllers/nc-uploads.controller.ts` assembles chunk parts and does `moveFiles(tmpPath, space.realPath, true)` directly (**:212**, `assembleAndMove`). NC mobile large-file overwrites go through here.
  6. **`[R2]` `FilesManager.mkFile(user, space, overwrite = true)` (`files-manager.service.ts:348`) destroys content and the draft missed it entirely.** `sync/services/sync-manager.service.ts:98` calls `mkFile(req.user, req.space, true)` from `make()`. With `overwrite` true and the path existing, it reaches either `createEmptyFile(space.realPath)` (`files/utils/files.ts:104` → `fs.writeFile(rPath, '')`, **truncating an existing file to zero bytes**) or `copyFileContent(srcSample, space.realPath)` (:365, overwriting with a template). No snapshot in the draft; a direct violation of its own §7.9 completeness invariant.

- `saveStream` internals that constrain hook placement:
  - Non-`tmpPath` (direct) branch: `writeFromStream(realPath, req.raw, startRange)` opens the LIVE file with flag `'w'` when `startRange === 0` (truncate) and `'a'` otherwise (`files/utils/files.ts:253`). The destructive moment is the first byte of the first chunk. Content-range resumed chunks (`startRange > 0`) see `fExists === true` but the file already holds partial NEW content.
  - `tmpPath` branch: destructive moment is `moveFiles(tmpPath, realPath, true)` at :166, after `validateTmpFile`.
  - Locking: a server lock is created ONLY in the non-DAV path (:125-131). WebDAV requests get `filesLockManager.checkConflicts` (:119-124) and hold NO lock during the write.
  - POST cannot overwrite: `saveStream` rejects at :105-107, `saveMultipart` rejects per-part at :234-236. No snapshot needed for POST.

- Upstream left hooks: `files-manager.service.ts:153` `// todo : versioning here` and `files-event-manager.service.ts:20` `// todo: handle versioning`. The `FileEvent` bus (ADD/UPDATE/DELETE) is buffered/async — usable for post-write bookkeeping only, NOT for the pre-overwrite snapshot.

- **Trash physical layout (the template to mirror exactly):** trash is a SIBLING of the files repository under the home path — `UserModel.getHomePath(login)/{files,trash}` and `SpaceModel.getHomePath(alias)/{files,trash}` (`user.model.ts:151-156`, `space.model.ts:53-59`, via `SPACE_REPOSITORY.FILES` / `.TRASH`). Trash is NOT a dotfolder inside the served tree. `realTrashPathFromSpace` (`spaces/utils/paths.ts:76-101`) resolves which trash a given space env maps to (personal, space, external-root, and share cases). `SPACE_REPOSITORY` (`spaces/constants/spaces.ts:13`) is `files|trash|shares` — a `versions` sibling does not collide.

- **`[R2]` Path roots are independently configurable and guest/link homes live elsewhere.** `files.config.ts:85-97` defines `dataPath`, `usersPath`, `spacesPath`, `tmpPath` as separate settings — they can be separate mounts. Worse, `UserModel.getHomePath(login, isGuest, isLink)` (`user.model.ts:135-143`) puts guests under `tmpPath/guests/<login>` and links under `tmpPath/links/<login>`, while `getTrashPath(login)` (:154) calls `getHomePath(login)` *without* those flags and so resolves into `usersPath`. Consequence: hardlinking is *likely* same-device but not guaranteed, and for guest/link writes the versions dir would land outside the ephemeral tree that holds the live files. See ADR §1 and §8.

- Trash DB: per-root `files_trash_` tables created by raw SQL (`files-trash.schema.ts`), scan-populated. The retention service (`files-trash-retention.service.ts`) is FILESYSTEM-SCAN based: the scan is the source of truth (`readdir` at :181), records not seen in a run are removed, and ids are inode-derived (`id: stats.ino` at :207, with explicit inode-reuse handling at :263). It does NOT hold `files.id`.

- Quota: `files-quota-manager.service.ts` computes usage with `dirSize(UserModel.getHomePath(login))` (:105-110) and `dirSize(SpaceModel.getHomePath(alias))` plus external paths for spaces (:138-145). `dirSize` walks EVERYTHING with no exclusions — trash already counts toward user quota today. Anything placed under the home path counts automatically.

- **`[R2]` Quota enforcement is synchronous and reads a stale figure.** `spaces/guards/space.guard.ts:54` calls `req.space.willExceedQuota(contentLength)` as a **pre-flight upload reject**, and `willExceedQuota` (`spaces/models/space-env.model.ts:136-141`) compares against `storageUsage` sourced from the cached `dirSize` result — `CACHE_QUOTA_TTL = 86400` (1 day, `files/constants/cache.ts:15`). Same guard shape at `download-file.ts:173`, `files-manager.service.ts:463` (copyMove), `sync-manager.service.ts:59`. This guard runs **before any versioning code**, which is why the draft's "never block the user's save" promise was unachievable. See ADR §7.

- Content indexer: `files-content-indexer.service.ts` recurses with plain `readdir` (`parseFileMetadata` at :319-321, recursing at :324) starting from resolved files-repository paths (`p.realPath` at :250). There is NO dotfolder or name-based exclusion. A blob store inside the files root WOULD be indexed; a sibling directory is naturally outside its roots.

- `copyMove` (`files-manager.service.ts:387`): on overwrite it calls `this.delete(user, dstSpace)` (:488-489), which moves the destination to TRASH (recoverable), before the move/copy. For task transfers this delete is DEFERRED via a callback passed to `filesTasksTransfer` (:496 move, :516 copy) — an inline hook at :489 would miss that path. The DB repath happens at `filesQueries.moveFiles(...)` (:506).

- `FilesManager.delete` (`files-manager.service.ts:525`): the COMMON permanent-delete path is the `space.inTrashRepository` branch at **:539-541** (delete from trash: `removeFiles` + DELETE_PERMANENTLY event; `forceDeleteInDB` stays FALSE). The `forceDeleteInDB` branch at **:572-581** is the rare no-trash-path fallback. Both end at `filesQueries.deleteFiles(space.dbFile, isDir, forceDeleteInDB)`.

- Checksums: `checksumFile(filePath, alg)` in `files/utils/files.ts:210`; `SYNC_CHECKSUM_ALG = 'sha512-256'` (`sync/constants/sync.ts:5`). sha512-256 digests are 64 hex chars. `writeFromStreamAndChecksum` (:272) exists for single-pass write+hash. `copyFileContent` (:293) is `writeFromStream(dstPath, srcStream)` with `start = 0` → flag `'w'` → truncate-in-place, **preserving the inode**.

- Nextcloud client emulation lives in `custom-mobile-compat/` (nc-dav / nc-ocs / nc-discovery controllers, `constants/capabilities.ts`). NC clients discover versioning via the `files_versions` capability and query `remote.php/dav/versions/{user}/versions/{fileId}`. CLAUDE.md mandates NC-source-as-ground-truth: fetch the upstream `files_versions` app source (routes, DAV plugin, `lib/Capabilities.php`) BEFORE designing endpoints — a prior compat feature shipped broken because this step was skipped. Note `[R2]`: NC addresses versions **by fileId**, which is a second independent reason the anchor must be a real `files.id`.

- Supporting services: `files-lock-manager.service.ts`, `files-quota-manager.service.ts`, `files-content-indexer.service.ts`, `files-recents.service.ts`.

- Frontend: Angular classic UI under `frontend/src/app/applications/files/` (sidebar `components/sidebar/files-selection.component`, `components/dialogs/` has `files-trash-dialog` / `files-lock-dialog` as structural templates, `components/viewers/` for previews) plus fork-specific `custom-v2`. Classic UI is ground truth for backend API usage (per CLAUDE.md) — **`[R2]` reference reading only; the build target is `custom-v2`, ADR §14.**

- Tests: vitest unit (`npm -w backend test`), e2e via `vitest-e2e.config.mts` (`test:e2e`); harness bootstrap in `backend/src/app.e2e-spec.ts`. Mock helper: `@golevelup/ts-vitest`. Migrations: Drizzle SQL files in `backend/migrations/` with `meta/` snapshots (verified next index: **0007**). DB sanity script: `src/infrastructure/database/scripts/check-db.ts`. **`[R2]` `npm run build -w backend` must pass before pushing — vitest's type check does not catch service↔real-class type errors.**

- Fork conventions: new code in `custom-versioning` / `custom-shared` paths; upstream edits are small atomic `mod(<area>): ...` commits; fork i18n keys in `frontend/src/i18n/custom/{en,nl}.json` (`v2_*` prefix for parameterized keys, plain-English literals for static); feature branch → PR to `zjean/server` → `test` green → squash merge; upstream-contrib branches root at `upstream/main` with no `custom-*` paths; AGPL headers preserved.

---

## 1. Phase A — Design decisions (ADRs, must complete before coding)

**Task A1 — Write ADR document** (`docs/plans/2026-07-25-file-versioning-design.md`)
Depends on: nothing. Blocks: everything.

Decide and record, with rationale:

1. **Storage layout.** Content-addressed store as a SIBLING of the files repository, exactly like trash: `<home>/versions/<digest[0:2]>/<digest>` where `<home>` is `UserModel.getHomePath(login)` or `SpaceModel.getHomePath(alias)`, resolved by a `realVersionsPathFromSpace()` helper modeled 1:1 on `realTrashPathFromSpace` (`spaces/utils/paths.ts:76`) covering personal / space / external-root / share cases. Rationale (verified): a store inside the files root would be listed by WebDAV PROPFIND and browse, synced down by the desktop client, walked by the content indexer (no dotfolder exclusion exists — verified at `files-content-indexer.service.ts:321`), and counted twice in intent by `dirSize`. Sibling placement gets the isolation trash already gets. Record explicitly that `versions` is **not** added to `SPACE_REPOSITORY` / `SPACE_ALIAS` and is never URL-reachable or browsable — unlike `trash`, which is.
   > **SUPERSEDED — ADR §1.1. DO NOT HARDLINK.** A hardlinked blob shares the live file's inode, and three of the
   > seven write paths truncate that inode *in place*, so the "saved" version ends up holding the NEW content. Blobs
   > are copied with `fs.copyFile` + `COPYFILE_FICLONE`. `versioning.service.spec.ts` fails if `fs.link` comes back.

   **`[R2]` Hardlink caveat, downgraded from the draft's guarantee.** `usersPath`/`spacesPath`/`tmpPath`/`dataPath` are independently configurable (`files.config.ts:85-97`) and may be separate mounts; and guest/link homes sit under `tmpPath` while `getTrashPath` resolves into `usersPath` (`user.model.ts:135-156`). So treat **hardlink-then-copy-on-`EXDEV` as the normal contract**, not an external-root edge case. Measure both. Record that same-device is the expected deployment but not an invariant the code may assume.
2. **Checksum algorithm.** `sha512-256`, reusing `checksumFile` / `SYNC_CHECKSUM_ALG` (NOT sha256 — the repo standard is sha512-256, `sync/constants/sync.ts:5`). Digest is 64 hex chars. Path sharding is `<digest[0:2]>`; algorithm-neutral naming everywhere (column named `checksum`, no algorithm baked into paths or DTOs). Record the algorithm in the ADR so a future change is an explicit migration.
3. **`[R2]` DB model — anchor resolved: id-keyed, ensurer-guaranteed.** Single global `files_versions` table (NOT per-root like trash; versions need joins with `files` for API queries, and unlike trash there is no FS-scan reconciliation).
   - `id` PK; `fileId` bigint unsigned **NOT NULL**, indexed.
   - **The anchor decision, with the reasoning the draft lacked.** `space.dbFile` has no `id` and `files` rows are lazily materialized (§0), so `fileId` is not available at any hook site and cannot be assumed to exist. Two candidates were weighed:
     - *Path-keyed* (scope columns + path, mirroring `deleteFiles` and `files_trash`): needs no row materialization and matches upstream's addressing primitive — but every rename/move would require regexp-repathing version rows or they orphan; `path` is non-unique by schema (no unique index on `(ownerId, path, name)`, verified); and D2's NC compat needs a real `files.id` regardless.
     - **Chosen: id-keyed with a guaranteed row.** `VersioningService` calls a shared `FileRowEnsurer` (task **B0**) to obtain a positive `files.id` before inserting, using the path-keyed-lookup-then-insert-on-miss discipline already proven in `nc-file-row-ensurer.service.ts`. Consequences, all favourable: **rename/move needs zero new code** (upstream's `filesQueries.moveFiles` repaths `files` and the id is unchanged — see §15); directory purge resolves descendant ids from `files` via the existing `childFilesFindRegexp` (`files.schema.ts`) before the row delete; NC fileId mapping is native. Cost: one indexed lookup and possibly one insert on a file's *first* snapshot only. Record this trade explicitly.
   - **FK decision with eyes open:** `filesQueries.deleteFiles` hard-deletes `files` rows (including all directory descendants via one regexp query) at permanent-delete time. A non-cascading FK would make those deletes fail unless version purging always runs first, including for every descendant. **Chosen: FK to `files.id` with `ON DELETE CASCADE`** as a safety net, *plus* explicit service-side purge that runs BEFORE `deleteFiles` (B3). The cascade cannot decrement blob refcounts, so the orphan-blob / dangling-row GC in B5 covers the gap. Record that the cascade is a backstop, not the mechanism.
   - Denormalized owner/space/root/share columns matching the `files` table pattern, for permission scoping and for resolving the versions root without a join. **`[R2]` No denormalized `path` column** — it would need repathing on every rename for no benefit, since purge resolves ids through `files`.
   - `checksum` char(64), `size`, `mtime` (of the superseded content), `createdAt`, `authorId` FK users (nullable for system), `origin` enum (`web`, `web-patch`, `webdav`, `sync`, `sync-make`, `nc-chunked`, `nc-text`, `collabora`, `onlyoffice`, `restore`), `label` varchar(255) nullable (named revisions), `versionsRoot` discriminator (user login / space alias + type) so the blob path is resolvable without recomputing space envs.
   - No separate blobs table for v1: refcount by `COUNT(*)` on `checksum` + `versionsRoot` at purge time. Dedup and refcount are PER versions root, since blobs are physically per root — record this scoping explicitly.
4. **Version creation semantics.** A version snapshot = the file content about to be destroyed (pre-write snapshot), captured synchronously inside the write path. Never version new-file creation (ACTION.ADD). The destructive moment differs per path and each hook targets it exactly (see B3): direct `writeFromStream` first chunk; `moveFiles` from tmp (PUT *and* PATCH); `copyFileContent` from tmp; NC assemble `moveFiles`; `mkFile` truncate. **Locking caveat (verified):** WebDAV writes hold no server lock (conflict check only, `saveStream:119-124`), so the snapshot in that path is best-effort under concurrency; do not claim "under lock" semantics for the `webdav` origin. Non-DAV saveStream writes, and the snapshot inside them, ARE under the lock saveStream creates at :127.
5. **Coalescing policy.** Config-driven `minIntervalSeconds` (default 60) per (fileId, authorId, origin) for editor, `nc-chunked`, `web-patch`, and WebDAV origins: if the newest version for that tuple is younger than the interval AND unlabeled, skip the snapshot (the pre-session state is already captured). Labeled versions are never coalesced or auto-expired.
   **`[R2]` OnlyOffice cadence is already answered — fold into the ADR rather than deferring to D4.** `only-office-manager.service.ts:142-180` calls `saveDocument` only from callback statuses 2 (no active users / closed unsaved), 3 (save error retry), 6 (forcesave), and 7 (forcesave error). Status 1 (users connect/disconnect) does **not** save. There is no autosave-per-keystroke path, so coalescing is near-moot for `onlyoffice`; keep it enabled for uniformity but expect it rarely to fire. Collabora's cadence still needs D4 measurement.
6. **Retention.** Mirror `FilesTrashRetentionConfig` (`files/files.config.ts:51`, including the `0 → false` Transform + `ValidateIf` idiom): `FilesVersionsConfig { enabled, maxVersionsPerFile, retentionDays (users/spaces split like trash), quotaShare, minIntervalSeconds }`. Start with maxVersions + retentionDays + quotaShare; NC-style thinning ladder is deferred to a later iteration.
7. **`[R2]` Quota — count them, cap them eagerly, and drop the unachievable promise.** The draft's §7 asserted versions count toward quota (correct) *and* that a snapshot would "never block the user's actual save" (unachievable). Verified: `space.guard.ts:54` rejects uploads pre-flight via `willExceedQuota`, reading a `dirSize`-derived `storageUsage` cached for a day (`CACHE_QUOTA_TTL`, `files/constants/cache.ts:15`). That guard runs before any versioning code, so versioning cannot promise anything about it. Resolution:
   - Versions **count** toward quota. Zero code; consistent with trash, which counts today.
   - `quotaShare` (max fraction of quota versions may consume; NC uses 50%) is enforced **eagerly inside `snapshotBeforeOverwrite`**, not only by the scheduler: compute current usage as `SELECT SUM(size) WHERE versionsRoot = ?` (cheap, indexed — *not* a `dirSize` walk), and while `used + newSize > quota * quotaShare`, evict the oldest unlabeled version (blob refcount-aware) before inserting. Skip entirely when the space has no `storageQuota` (0/null = unlimited).
   - Note that `SUM(size)` is *logical* size and over-counts when dedup hits, so the cap is conservative. Record that as accepted.
   - The scheduler (B5) still enforces `retentionDays` and `maxVersionsPerFile`, and re-checks `quotaShare` as a backstop.
   - **The honest claim to record:** "snapshotting never grows usage beyond `quotaShare` of quota" — NOT "saves are never blocked." A user whose *real files* fill the remaining quota is rejected by the pre-existing guard exactly as they are today; versioning's worst case is a bounded, documented loss of `quotaShare` fraction of usable quota. Surface versions usage in the UI (C2) so this is visible rather than mysterious.
   - Excluding versions from the quota walk was considered and **rejected for v1**: it needs a `mod()` on the quota manager (merge-conflict surface), breaks the trash precedent, and removes all backpressure — the volume could fill with no user-visible signal.
8. **External roots policy.** Files under `spaceExternalRootId`/`shareExternalId` can be modified out-of-band. v1: versioning applies only to writes through the app (best effort); direct filesystem writes are not versioned. No watcher in v1. Cross-device copy fallback per §1. **`[R2]` Decide and record whether guest/link writes are versioned at all** — their homes are under `files.tmpPath` while `getTrashPath`/`getVersionsPath` resolve into `usersPath`, so versions would outlive the ephemeral tree. Recommended: **skip versioning for guest and link users** (`user.isGuest || user.isLink` → no-op), which also sidesteps a cross-device copy on every public-link upload.
9. **Restore semantics.** Restore = snapshot current content as a new version (origin `restore`), then replace live content with **`copyFileContent(blobPath, realPath)` — NOT `moveFiles`.** Verified rationale: both editors deliberately use `copyFileContent` "to avoid inode changes" (comments at `collabora-online-manager.service.ts:135`, `only-office-manager.service.ts:407`); `copyFileContent` truncates in place via flag `'w'` (`files/utils/files.ts:253,293`) so the inode survives; trash retention keys on inodes (`files-trash-retention.service.ts:207`); `dbFileHash`/`file.id` consumers depend on inode stability. Restore must not swap the inode. Update the `files` row (size/mtime), emit `FileEvent` UPDATE (recents/indexing/quota react), respect locks via `files-lock-manager` (create a lock for the restore like non-DAV saveStream does).
10. **Trash/delete interplay.** File → trash: `files` row survives with `inTrash = true` and stable id (verified), versions kept. Restored from trash: versions still attached. Permanently purged: version rows deleted + blob refcounts decremented. Hook points (verified against `delete()`):
    - The `space.inTrashRepository` branch (`files-manager.service.ts:539-541`) — this is the COMMON permanent-delete path (`forceDeleteInDB` remains false there).
    - The `forceDeleteInDB` fallback branch (:572-581).
    - Directory deletes: `deleteFiles` removes ALL descendant rows in one regexp query, so `purgeForFile(fileId)` alone misses children. **`[R2]` Under the id-keyed anchor the purge is clean:** resolve descendant ids first — `SELECT id FROM files WHERE <scope> AND childFilesFindRegexp(path)` reusing the exported helper from `files.schema.ts` — then delete `files_versions` rows for those ids, **before** `filesQueries.deleteFiles` runs (FK ordering per §3). API shape: `purgeForFile(fileId)` and `purgeForDescendants(scopeProps, path)`.
    > **SUPERSEDED — ADR §10.** The dangling-row GC **cannot** absorb this case: trash retention never touches the
    > `files` table, and version rows *pin* that row against `deleteOrphanFiles`, so it never disappears and nothing is
    > ever reclaimed. The replacement rule (purge `inTrash` versions older than the trash window) was ALSO wrong and
    > destroyed restorable history — a version's `createdAt` is when the file was overwritten, not when it was trashed,
    > and no trashed-at timestamp is addressable by `files.id`. **There is no trash-age rule.** Read ADR §10 first.

    - Trash retention scheduler: it is FS-scan/inode based and does not hold `files.id` (verified). **Decision: do NOT attempt a record→`files` mapping there.** Let trash retention simply trigger the B5 dangling-row GC ("version row whose `files` row is gone"), which absorbs the case without the fragile inode↔id join the draft budgeted as real work.
11. **copyMove overwrite.** Verified: the destination is already moved to TRASH via `this.delete(user, dstSpace)` (:488-489) before the move/copy, so its content is recoverable and its versions travel with the trashed row. The delete is also deferred via callback for task transfers (:496, :516), so a single inline hook would miss that path anyway. Decision for v1: NO snapshot in `copyMove`; document that trash covers overwrite-by-move/copy. Revisit only if trash retention windows prove too short.
12. **Module placement.** New module `backend/src/applications/custom-versioning/` (fork isolation) exporting `VersioningService`, consumed via small `mod()` hooks in upstream files (`files-manager.service.ts`, both editor managers) and one direct import in the fork-owned `nc-uploads.controller.ts` (already a `custom-*` path, no `mod()` needed). **`[R2]` Plus `backend/src/applications/custom-shared/` for the `FileRowEnsurer` (B0)**, consumed by both `custom-versioning` and `custom-mobile-compat` — versioning must not be a dependency of mobile-compat, since versioning is feature-flagged off by default and mobile-compat needs the ensurer unconditionally. Contributing upstream is **not** pursued for v1; record that.
13. **Feature flag.** Everything behind `files.versions.enabled` config (default false initially), checked inside the service so hooks are one-line no-ops when off. **`[R2]` The `FileRowEnsurer` is explicitly NOT gated by this flag** — mobile-compat's `oc:fileid` correctness depends on it regardless.
14. **`[R2]` Frontend target: `custom-v2` only.** Version history ships in `frontend/src/app/applications/custom-v2/`. Classic UI (`applications/files/`) is **reference reading only**, per CLAUDE.md's classic-as-ground-truth rule — open `components/sidebar/files-selection.component` and `components/dialogs/files-trash-dialog.component` to copy API-call shape and dialog structure, but do not edit them. Rationale: v2 is the UI this fork ships and iterates on, and it keeps the entire frontend off the upstream merge-conflict surface. Classic-UI parity is explicitly out of scope for v1.
15. **`[R2]` Move/rename semantics — absent from the draft entirely.** A plain rename or move (`copyMove` with `isMove`) is **not** an overwrite and creates no version. Under the id-keyed anchor (§3) it also requires **no code**: `filesQueries.moveFiles` (`files-manager.service.ts:506`) regexp-updates `files.path` while `files.id` is unchanged, so version rows follow automatically. Record this as a *reason for* the anchor choice, and add the regression test (E2E-19) so a future "simplification" to path-keying can't silently orphan every renamed file's history. Cross-space moves: the `files` row moves scope via `moveFiles(srcProps, dstProps)`; the denormalized scope columns on `files_versions` therefore go stale. **Decision: treat the denormalized scope columns as a permission-scoping cache refreshed lazily from `files` on read**, or re-derive on move — record which, and cover with a test. Note that the blob may now live under the *previous* root's versions dir; v1 accepts that (the `versionsRoot` column records where the blob actually is), and B5's GC must not treat it as orphaned.

Deliverable: ADR merged via `docs/` PR. Acceptance: every numbered point has an explicit decision; §§1, 2, 3, 7, 9, 10, 11, 15 each cite the verified code behavior they rest on, with file:line.

---

## 2. Phase B — Backend core (subagent tasks, parallelizable where noted)

**`[R2]` Task B0 — Promote the file-row ensurer to shared fork code**
Depends: A1. Blocks: B2. Branch `feat/shared-file-row-ensurer`.

The single prerequisite the draft missed. Without a guaranteed `files.id`, nothing in B1–B4 has an anchor.

- Create `backend/src/applications/custom-shared/services/file-row-ensurer.service.ts`, generalizing `custom-mobile-compat/services/nc-file-row-ensurer.service.ts`. Read that file first — its header comment (lines 14-40) documents the duplicate-row trap, the missing unique index, and the personal-vs-space lookup split. Preserve all of it.
- API: `ensureFileId(user: UserModel, space: SpaceEnv, props: FileProps): Promise<number>` — path-keyed lookup first (`findUserFileByPath` for personal spaces, `filesQueries.getSpaceFileId` for space/shared/external), insert via `getOrCreateUserFile` / `getOrCreateSpaceFile` only on a genuine miss. Returns 0 (never throws) on DB error so callers can degrade.
- Refactor `NcFileRowEnsurer` to **delegate** to the shared service, keeping its `WebDAVFile`-specific short-circuits (`f.id > 0`, trash repository, no user) and its `f.id` fallback in place. Its public signature must not change.
- **`[R2]` Not gated by `files.versions.enabled`** — mobile-compat depends on it unconditionally (see ADR §13).
- Tests: port the existing nc-file-row-ensurer specs to the shared service; add a **no-duplicate-row test** (call twice for the same path → one row, same id) since that is the documented failure mode; personal vs space vs external-root vs share scoping; DB-error path returns 0.
- Acceptance: **all existing `custom-mobile-compat` PROPFIND specs stay green** (this is a refactor of load-bearing NC code — regression here breaks iOS previews per the ensurer's own comment); `npm run build -w backend` clean.

**Task B1 — Schema + migration**
Depends: A1. Branch `feat/versioning-schema`.
- Add `custom-versioning/schemas/files-versions.schema.ts` (Drizzle, follow `files.schema.ts` style: bigint unsigned PKs; `fileId` NOT NULL with FK to `files.id` `ON DELETE CASCADE` per ADR §3; indexes on `fileId`, `(checksum, versionsRoot)`, `createdAt`; composite index covering the coalescing lookup `(fileId, authorId, origin, createdAt)`; index supporting the eager quota cap `(versionsRoot, label, createdAt)`).
- **`[R2]` No `path` column** (ADR §3) — do not add one "for convenience"; it becomes a repathing obligation on every rename.
- Export from `infrastructure/database/schema.ts` (`mod(db)` commit — one line).
- Generate migration `backend/migrations/0007_*.sql` exclusively via `npm -w backend run db:generate` (drizzle-kit) from the schema definition — never hand-write or hand-edit migration SQL or `meta/` snapshots; if the generated SQL is wrong, fix the Drizzle schema and regenerate. Validate with `npm -w backend run db:check`. (The raw-SQL `files_trash_` tables are a scan-managed exception owned by upstream; the versions table is a normal Drizzle-managed table.)
- Unit tests: schema round-trip insert/select via the existing DB test harness (see how `files-trash-retention.service.spec.ts` bootstraps DB access; replicate). **`[R2]` Add a cascade test: deleting the parent `files` row removes its version rows.**
- Acceptance: `npm -w backend test` green; migration applies cleanly on a fresh DB (`check-db.ts`) and on a DB at 0006.

**Task B2 — VersioningService (core)**
Depends: B0, B1. Branch `feat/versioning-service`.
- `custom-versioning/services/versioning.service.ts` with API:
  > **SUPERSEDED in two ways — ADR §1.1 and §1.2.** (a) No hardlink, ever (see above). (b) The digest must come from
  > the STAGED COPY, not the live file: hashing the live file in a separate pass leaves a window in which the two
  > disagree, and in a content-addressed store one mis-named blob is then served for every later file with that
  > content. Real sequence: copy to `.staging/<uuid>.part` → hash the stage → publish by rename (always, even on a
  > dedup hit).

  - `snapshotBeforeOverwrite(user, space, opts: { origin }): Promise<void>` — sequence: feature-flag check → **`[R2]` guest/link skip (ADR §8)** → checksum current file via `checksumFile(path, SYNC_CHECKSUM_ALG)` → **`[R2]` `fileId = await ensureFileId(...)` (B0); abort quietly if 0** → coalescing policy → **`[R2]` eager `quotaShare` eviction (ADR §7)** → hardlink-or-copy into the blob store (hardlink first; fall back to copy on `EXDEV`, a **normal** case per ADR §1) → insert row. Blob path via `realVersionsPathFromSpace()` (new util in `custom-versioning/utils/`, modeled on `realTrashPathFromSpace`). Crash-safe ordering: blob before DB row; orphan blobs are GC'd by B5. NEVER throws into the caller's save path: catch, log error, return (ADR-recorded durability-vs-availability tradeoff).
  - `listVersions(user, space): VersionDto[]` (permission-checked via the same space env the caller resolved)
  - `getVersionStream(user, space, versionId)` (download)
  - `restoreVersion(user, space, versionId)` — per ADR §9: lock, snapshot current (origin `restore`), `copyFileContent` blob → realPath (inode preserved), update `files` row, emit `FileEvent` UPDATE, unlock.
  - `setLabel(user, space, versionId, label | null)`
  - `deleteVersion(user, space, versionId)` (labeled versions require an explicit confirm flag)
  - `purgeForFile(fileId)` and **`[R2]` `purgeForDescendants(scopeProps, path)`** — resolves descendant ids via `SELECT id FROM files WHERE <scope> AND childFilesFindRegexp(path)` (reuse the exported helper from `files.schema.ts`), then purges by id. Called on permanent delete per ADR §10.
  - **`[R2]` `versionsUsage(versionsRoot): Promise<number>`** — `SUM(size)`, backing the eager quota cap and the C2 usage display.
- Config class `FilesVersionsConfig` added to `files/files.config.ts` (`mod(files)`, follow the `FilesTrashRetentionConfig` shape at :51, incl. the `0 → false` Transform + `ValidateIf` idiom).
- Unit tests (vitest; tmpdir integration style like existing files specs): snapshot creates blob + row; **`[R2]` snapshot on a file with no `files` row materializes exactly one row and reuses it on the second snapshot**; dedup within one versions root (same content twice = one blob); coalescing window respected; labeled version never coalesced; **`[R2]` eager quota cap evicts oldest unlabeled and never evicts labeled**; **`[R2]` guest/link user = no-op**; restore snapshots current first AND preserves the live file's inode (assert `stat().ino` unchanged); <!-- SUPERSEDED: no hardlink exists, so there is no hardlink-fallback test. Assert instead that a blob is INDEPENDENT of a later in-place write, and that a blob's name is the hash of its own bytes (ADR §1.1, §1.2). --> purge decrements/deletes blobs; descendant purge covers children; disabled flag = all methods no-op; snapshot failure does not throw into the caller; permission denial for read-only user.
- Acceptance: ≥90% line coverage on the service; no imports from `custom-versioning` into upstream files except via the B3 hooks; `npm run build -w backend` clean.

**Task B3 — Write-path hooks (SIX paths; `mod()` where upstream, direct where fork-owned)**
Depends: B2. Branch `mod/versioning-hooks`.
- **`files-manager.service.ts` `saveStream`** (`mod(files)`), replacing the `// todo : versioning here` marker at :153 with branch-aware placement:
  - Direct branch (no `tmpPath` — WebDAV PUT, nc-text-editor): snapshot when `fExists && !isDir && startRange === 0`, immediately BEFORE `writeFromStream`/`writeFromStreamAndChecksum` (:156-158). Never on resumed chunks (`startRange > 0` — the live file already holds partial new content; a snapshot there would capture garbage). In the DAV case no server lock exists (conflict check only) — best-effort, per ADR §4.
  - `tmpPath` branch (sync client): snapshot immediately before `moveFiles(options.tmpPath, space.realPath, true)` at :166, only when the destination exists. One snapshot per completed upload regardless of how many ranged requests fed the tmp file.
  - Origin derivation: `options.dav` → `webdav`; sync caller → `sync`; nc-text-editor → `nc-text`; default `web` (pass origin via `SaveStreamOptions` — extend the interface; record the mechanism).
- **`saveMultipart`** (`mod(files)`): **`[R2]` gate on `(overwrite || patchMethod) && dstExists && !dstIsDir`, NOT on `overwrite` alone.** `overwrite` is PUT-only (:205) but `tmpFile` is set for PATCH too (:241) and PATCH requires an existing destination (:237-239), so both flow through `moveFiles(tmpFile, dstFile, true)` at :292 — which is the snapshot point, placed after the deferred deletes at :283-291. Origin `web` for PUT, **`web-patch` for PATCH** (the web text-editor save; note the existing `source: 'editor'` tagging at :315). Skip the dir-replacement case (no file content to version).
- **Collabora `saveDocument`** (`files/editors/collabora-online/collabora-online-manager.service.ts`, snapshot before `copyFileContent` at **:137**) and **OnlyOffice `saveDocument`** (`files/editors/only-office/only-office-manager.service.ts`, before `copyFileContent` at **:409**) (`mod(editors)`): the copy **is** the destructive moment — there is no move. Origin `collabora` / `onlyoffice`; author = `req.user` (Collabora) / the `user` **parameter** of `saveDocument(user, space, url)` (OnlyOffice, :352). Note OnlyOffice reaches this from callback statuses 2/3/6/7 only (:142-180).
- **`nc-uploads.controller.ts` `assembleAndMove`** (fork-owned file, direct import, no `mod()`): snapshot the existing destination before `moveFiles(tmpPath, space.realPath, true)` at **:212**. Origin `nc-chunked`. Without this hook, NC mobile large-file overwrites create no versions.
- **`[R2]` `mkFile`** (`mod(files)`, `files-manager.service.ts:348`): when `overwrite === true` and the path exists and is a file, snapshot before the destructive write — both the `copyFileContent(srcSample, ...)` branch (:365) and the `createEmptyFile(...)` branch (:369, which truncates to zero bytes via `fs.writeFile(rPath, '')`). Origin `sync-make` (the only current caller with `overwrite=true` is `sync-manager.service.ts:98`). This closes the sixth path and satisfies §7.9.
- **`copyMove`: NO hook** (ADR §11 — destination goes to trash already; task transfers defer the delete via callback and would dodge an inline hook anyway).
- **`[R2]` Move/rename: NO hook** (ADR §15 — `filesQueries.moveFiles` repaths `files` and the `fileId` anchor is unaffected). Covered by regression test E2E-19, not by code.
> **Partly SUPERSEDED — ADR §10.** The purge hooks themselves are correct and shipped. The final clause — "merely
> trigger the B5 dangling-row GC" — is not: see the note under A1 §10 above. Nothing is hooked into trash retention.

- **Purge hooks** (`mod(files)`): in `FilesManager.delete`, call the purge API in BOTH permanent branches — the `inTrashRepository` branch (:539-541, the common path) and the `forceDeleteInDB` fallback (:572-581) — using `purgeForDescendants` when `isDir`, **BEFORE** `filesQueries.deleteFiles` (FK ordering per ADR §3/§10, and required so descendant ids are still resolvable). In `files-trash-retention.service.ts`: **`[R2]` no record→`files` mapping** — merely trigger the B5 dangling-row GC (ADR §10).
- Unit tests: extend `files-manager.service.spec.ts`, both editor manager specs, and the nc-uploads controller spec — every hook fires exactly once per overwrite; **`[R2]` PATCH multipart fires**; **`[R2]` `mkFile(overwrite=true)` on an existing file fires**; never on create; never on POST; never on resumed chunks; never when flag disabled; never for directories; purge fires on permanent delete from trash and covers directory children.
- Acceptance: upstream diffs small and greppable; one atomic `mod(files):` / `mod(editors):` commit per upstream file; nc-uploads change is a normal fork commit; `npm run build -w backend` clean.

**Task B4 — REST API**
Depends: B2 (parallel with B3). Branch `feat/versioning-api`.
- `custom-versioning/versioning.controller.ts` + routes constant file, mounted under the files route namespace using the same space-env resolution guards/decorators the files controller uses (read `files.controller.ts` first; reuse its space param decorators — do not reinvent permission resolution).
- Endpoints: `GET .../versions` (list), `GET .../versions/:id` (download, proper content-type + disposition), `POST .../versions/:id/restore`, `PATCH .../versions/:id` (label), `DELETE .../versions/:id`. **`[R2]` `GET .../versions/usage`** (versions bytes + `quotaShare` ceiling, for the C2 display mandated by ADR §7). DTOs with class-validator, matching repo DTO style.
- Text diff endpoint `GET .../versions/:id/diff?against=current|<id>` for text mimetypes only (size-capped, e.g. 2 MB), returning unified diff; 415 otherwise.
- Unit tests: controller specs with `@golevelup/ts-vitest` mocks (repo pattern); permission matrix (owner, write member, read-only member, guest, public link → 403/404).
- Acceptance: route constants exported; all endpoints return 404 when the flag is disabled.

**Task B5 — Scheduler + retention**
Depends: B2. Branch `feat/versioning-retention`.
> **SUPERSEDED in part — ADR §10 and §7.** As shipped: no trash-age rule (see A1 §10 above), and the quota eviction is
> NOT reimplemented here — it calls `VersioningService.evictUntilUnderCeiling`, the single place that decides when
> eviction is allowed. Duplicating that decision produced the same data-loss bug twice.

- `custom-versioning/services/versions-retention.service.ts` modeled on `files-trash-retention.service.ts` and registered via `infrastructure/scheduler` the same way: enforce `retentionDays`, `maxVersionsPerFile`, `quotaShare` as a **backstop** to B2's eager cap (oldest unlabeled first, per versions root, using `versionsUsage()` — not a `dirSize` walk), orphan-blob GC (blob with zero rows and mtime older than 24h), and dangling-row GC (row whose blob is missing, or — per ADR §10 — whose `files` row no longer exists → log + delete row + refcount fix).
- **`[R2]` The GC must not treat a cross-space-moved file's blob as orphaned** — match on the `versionsRoot` column recorded at snapshot time, not on the file's current space (ADR §15).
- Unit tests: each rule in isolation; labeled versions survive `retentionDays` and `maxVersions` but count toward `quotaShare`; GC idempotent; scheduler no-ops when disabled; <!-- SUPERSEDED: there is no trash-retention-purged case for the dangling-row GC to handle (ADR §10); assert the opposite, that history is NOT reclaimed merely because a file sits in the trash --> a case where labeled bytes alone exceed the quota ceiling must evict NOTHING (the bug that shipped twice); **`[R2]` GC leaves a moved file's blob alone**.

**Task B6 — Events, indexing, recents, admin config**
Depends: B3. Branch `feat/versioning-glue`.
- `files-event-manager.service.ts`: replace the `todo: handle versioning` comment at :20 — post-write events do NOT create versions (creation is synchronous in B3) but may drive metrics/notifications; document this in the comment (`mod(files)`). The editors' `source: 'editor'` event field is available for cheap origin metrics.
- Indexer isolation: with the sibling `versions` dir (ADR §1) the indexer's roots (files repositories) never contain the blob store — but the indexer has NO dotfolder exclusion (verified, `files-content-indexer.service.ts:321`), so this isolation exists ONLY because of the sibling placement. Write a test proving the versions dir is not indexed, as a regression guard against anyone "simplifying" the store back inside the root.
- Same guard for sync and WebDAV: assert the versions dir never appears in a WebDAV PROPFIND of the space root or in a sync diff (cheap unit-level assertions here; full flows in Phase E).
- Admin: expose `FilesVersionsConfig` the same way trash retention is exposed (inspect `applications/admin` + frontend admin screens; if trash retention is env/yaml-only, versions config is too — match, don't invent UI).
- WebSocket: if trash/comments emit websocket notifications on change, emit a `versions-updated` event for open file panels (check `infrastructure/websocket` usage by comments first; skip if no precedent).

---

## 3. Phase C — Frontend (`custom-v2`, per ADR §14)

**Task C1 — v2 service + models**
Depends: B4. Branch `feat/versioning-frontend-service`.
- **`[R2]`** Angular service in the `custom-v2` service layer (`frontend/src/app/applications/custom-v2/`). Per CLAUDE.md's classic-as-ground-truth rule, **read the classic files service first** to copy the API-call shape (URL construction, space-env params, error handling) — but do not edit `applications/files/`.
- Typed models mirroring backend DTOs. i18n keys in `frontend/src/i18n/custom/{en,nl}.json` (`v2_*` prefix for parameterized keys, plain-English literals for static strings — never touch upstream i18n files). v2 toasts route through `ToastService`, which auto-translates and interpolates: `this.toast.success('v2_restored_version', { date })`.

**Task C2 — Version history UI**
Depends: C1. Branch `feat/versioning-frontend-ui`.
- v2 sidebar/detail section showing count + latest, opening a versions dialog. Structural references (read, don't edit): classic `components/sidebar/files-selection.component` for how lock/comments render in a selection panel, `components/dialogs/files-trash-dialog.component` for list-dialog structure.
- List: author avatar, timestamp, size, origin icon, label. Actions: download, restore (confirm dialog, warns that current content will be snapshotted first), name/rename revision (inline edit), delete (confirm; extra confirm for labeled).
- **`[R2]` Versions usage display** (bytes + `quotaShare` ceiling from `GET .../versions/usage`), required by ADR §7 so quota consumption by history is visible rather than mysterious.
- Compare: text files → unified diff component consuming the diff endpoint; non-text → open the old version read-only via the existing v2 viewer pipeline.
- Component tests following repo v2 practice; if coverage there is thin, match repo practice and rely on e2e (no new test framework).
- **`[R2]` Browser-verify before reporting complete** — use the `v2-dev-loop-verify` skill; v2-specific rendering bugs (design-token white-on-white) are only caught in the running dev server.
- Acceptance: feature-flag driven (capability from the backend config endpoint — mirror how v2 discovers trash/editor availability); AGPL source link untouched; no upstream i18n files edited; no files under `applications/files/` modified.

---

## 4. Phase D — Integrations

**Task D1 — WebDAV correctness**
Depends: B3. Branch `mod/versioning-webdav`.
- Verify WebDAV PUT versions per the direct-branch rule (snapshot at `startRange === 0` only) and coalesces per policy. Regression test: a resumed content-range PUT sequence produces exactly ONE version containing the full pre-upload content, never a partial.
- Verify ETag/getlastmodified in `webdav-methods.service.ts` derive from the live file only (PROPFIND unchanged by version existence). **`[R2]` Keep strong ETags** — the `W/` prefix breaks NC iOS thumbnail paths (`nc-prop-builder.ts`).
- Document (do not "fix") the no-lock nature of DAV writes as it applies to snapshot concurrency (ADR §4).
- Optional backlog: DeltaV-lite `version-history` REPORT — skip in v1.

**Task D2 — Nextcloud client compatibility**
Depends: B4. Branch `feat/versioning-nc-compat`.
- **MANDATORY first step per CLAUDE.md's NC-source-as-ground-truth rule: fetch and read the upstream Nextcloud `files_versions` app source (DAV plugin, routes, `lib/Capabilities.php`) and the relevant `NextcloudKit` / `nextcloud/ios` client handling BEFORE writing any endpoint.** Wire format, property names, and capability shape cannot be inferred from server-side conventions (a prior compat feature shipped JSON where XML was required, against a wrong path, and rendered empty until the next PR). Follow the six-step investigation recipe in CLAUDE.md.
- In `custom-mobile-compat`: advertise `files_versions` in `constants/capabilities.ts` / the OCS capabilities response (nc-ocs / nc-discovery controllers), gated on the feature flag.
- Implement NC versions DAV: `PROPFIND /remote.php/dav/versions/{user}/versions/{fileId}` (list, with `getcontentlength`, `getlastmodified`, `d:getetag`), `GET` of a version, `MOVE` to `.../versions/{user}/restore/target` (NC restore semantics), and the NC 28+ version-labeling prop if the compat layer already targets those clients (check existing user-agent handling in `nc-propfind.service`).
- Reuse `VersioningService`. **`[R2]` NC fileId ↔ `files.id` is direct** under the id-keyed anchor — reuse the shared `FileRowEnsurer` (B0) exactly as nc-dav already does, so a version query for an FS-only file resolves rather than 404s. Apply the storage quirks: mime `image-jpeg` → `image/jpeg`, mtime ms → seconds, real DB ids (never negative), strong ETags.
- Tests: extend the nc controller spec suites (`nc-propfind.service.spec.ts` shows the fixture style) with capability presence, list/download/restore round-trip, and permission denial.

**Task D3 — Desktop sync interplay**
Depends: B3. Branch: verification only, no code expected.
- Prove: a restore changes mtime/size/checksum WITHOUT changing the inode, and the sync diff (`sync-manager.service.ts`, `SYNC_DIFF_DONE` flow) propagates it to clients as a normal remote update; a sync upload of an existing file creates exactly one version (snapshot at the final `moveFiles` from tmp, not per ranged request); **`[R2]` a sync `make` on an existing file (`mkFile(overwrite=true)`) creates exactly one version before truncation**; the sync client never sees or syncs the versions directory.
- Deliverable: the Phase E test cases covering this.

**Task D4 — Editor session coalescing validation**
Depends: B3.
- Manual/e2e scenario: open a document in Collabora, autosave N times in 5 minutes → expect 1 version (the pre-session content) with correct author; tune `minIntervalSeconds` from the observed cadence.
- **`[R2]` OnlyOffice cadence is already established from source** (statuses 2/3/6/7 only, no autosave — ADR §5); confirm empirically but do not re-derive. Expect coalescing to rarely fire there.

---

## 5. Phase E — Integration and E2E test plan (vitest e2e config, `npm -w backend run test:e2e`)

Build on the existing harness (`backend/src/app.e2e-spec.ts` bootstraps the app; follow it). One spec file per flow, real MariaDB + tmpdir storage roots (match existing e2e environment provisioning).

- E2E-1 Upload lifecycle: create file (no version) → overwrite via files API (1 version) → overwrite again (2) → list shows correct order/authors/sizes → download v1 bytes exact match.
- E2E-2 Restore: restore v1 → live content = v1 bytes, inode unchanged (assert `stat().ino`), new version with origin `restore` containing pre-restore content → `files` row size/mtime updated → FileEvent fired (recents updated).
- E2E-3 WebDAV: PUT overwrite creates version; resumed content-range PUT sequence creates exactly ONE version with the full pre-upload content (never a partial); two PUTs within the coalescing window create one; PROPFIND ETag semantics unchanged (strong ETags); versions dir absent from PROPFIND of the root.
- E2E-4 Sync: chunked/resumed upload (tmpPath + content-range path) of an existing file → exactly one version, snapshotted at the final move.
- E2E-5 NC chunked upload: assemble-and-MOVE overwrite of an existing file via the `nc-uploads` endpoints → exactly one version, origin `nc-chunked`. (This path bypasses saveStream.)
- E2E-6 Trash: delete file → versions retained (files row `inTrash`, id stable); restore from trash → versions listable; permanent delete FROM TRASH (the `inTrashRepository` branch) → version rows gone, blobs GC'd (assert on disk); directory permanent delete → descendants' versions purged too.
- E2E-7 Permissions: read-only space member can list/download but not restore/delete/label (assert the ADR matrix); user outside the space gets 404; public link cannot reach version endpoints.
- E2E-8 Retention: seed versions beyond maxVersions/retentionDays, run the scheduler job directly, assert labeled survive, unlabeled pruned oldest-first, orphan blobs removed.
- E2E-9 Dedup/refcount: two files with identical content IN THE SAME storage root → one blob on disk; purge one file → blob remains; purge both → blob gone. Same content in TWO DIFFERENT roots → two blobs (dedup is per-root by design; assert both directions).
- E2E-10 NC compat: capabilities advertise files_versions; PROPFIND versions lists; GET version bytes; MOVE-restore works; disabled flag hides the capability.
- E2E-11 Editor callbacks: simulate an OnlyOffice callback save (status 6) and a Collabora PutFile against a seeded file → version created with correct origin/author, live-file inode unchanged after save; repeat within the window → coalesced.
- **`[R2]` E2E-12 Quota (rewritten):** versions count toward `dirSize`-derived usage (assert usage rises after the quota job runs); fill `quotaShare` → the **next snapshot eagerly evicts** the oldest unlabeled version before inserting, and total versions bytes never exceed `quota * quotaShare`; labeled versions are never evicted even at the ceiling; a space with no `storageQuota` skips the cap entirely. **Do not assert "the save is never blocked"** — assert instead that `space.guard.ts`'s pre-flight rejection behaviour is unchanged from baseline (ADR §7).
- E2E-13 Flag off: all endpoints 404, hooks no-op, zero blob-store writes, NC capability absent. **`[R2]` But `FileRowEnsurer` still functions** — nc-dav `oc:fileid` emission is unaffected by the versioning flag.
- E2E-14 Concurrency: two parallel non-DAV overwrites of the same file (lock manager mediates) → no corrupt blob store, version count deterministic per lock outcome. Separate DAV case documents best-effort behavior (no server lock): assert no corruption, not a strict count.
- E2E-15 Crash safety: kill between blob write and DB insert (inject failure) → orphan GC cleans the blob; kill between DB insert and response → version valid; injected snapshot failure → the user's save still succeeds.
- E2E-16 copyMove overwrite: destination content recoverable from trash, NO version snapshot created (per ADR §11), and the overwritten destination's versions travel with the trashed row.
- **`[R2]` E2E-17 Multipart PATCH (web text editor):** PATCH-save an existing file via `saveMultipart` → exactly one version, origin `web-patch`; repeat within the coalescing window → one. Guards the path the draft would have missed.
- **`[R2]` E2E-18 `mkFile` truncate:** sync `make` (`mkFile(overwrite=true)`) against an existing non-empty file → exactly one version holding the pre-truncation content, origin `sync-make`, before the file becomes zero bytes. Also cover the `copyFileContent(srcSample, ...)` template-overwrite branch.
- **`[R2]` E2E-19 Rename/move (anchor regression guard):** overwrite a file twice (2 versions) → rename it → versions still listable under the new path with the same ids and correct content; move it to a different space → versions still listable, blob still resolvable via the recorded `versionsRoot`, and B5's GC does not delete it. **This is the test that makes ADR §15 enforceable** — it fails loudly if anyone re-keys versions on path.
- **`[R2]` E2E-20 Row ensuring:** snapshot a file that has never been shared/commented/favorited (no `files` row) → a row is created and the version is anchored to it; snapshot the same file again → **no duplicate row** (same `fileId`), guarding the documented `getOrCreateUserFile` fan-out trap; concurrent first-snapshots of the same file do not produce two rows.

Migration test: apply 0007 on a snapshot of a 0006 DB with a populated files table; the versions table is new so no long DDL on `files` — assert anyway. **`[R2]` Assert the `ON DELETE CASCADE` FK is present and functional.**

---

## 6. Non-functional and rollout

- **Performance:** snapshot is O(1)-ish when hardlink succeeds; checksum is the cost: one streamed read of the old file via `checksumFile` (stream-based, does not block the event loop). Perf test: versioning a 1 GB file reads it at most once and hardlinks rather than copies on the same device. **`[R2]` Cross-device fallback is a normal case, not an edge case** (configurable path roots, guest/link homes — ADR §1): measure the streamed-copy cost and document it. **`[R2]` Also measure the added first-snapshot cost of `ensureFileId`** (one indexed lookup + possible insert).
- **Observability:** Nest `Logger` `{ tag, msg }` pattern as used throughout; snapshot/purge/GC at verbose, failures at warn/error. Never fail the user's save because snapshotting failed — log, proceed (ADR-recorded policy). **`[R2]` Log eager-cap evictions at `log` level, not verbose** — silently deleting a user's history deserves an audit trail.
- **Backup/restore docs:** update deployment docs (`docs/`) — the per-home `versions` directories must be included in backups alongside `files`, `trash`, and the DB.
- **Rollout:** merge with flag default OFF → enable on staging → soak with real Collabora/OnlyOffice and NC iOS/Android clients (chunked upload path especially) → default ON in a `-custom.<n>` release. CHANGELOG entry per repo convention. **`[R2]` B0 ships independently of the flag and must soak first** — it refactors load-bearing NC PROPFIND code.
- **`[R2]` Quota communication:** enabling this feature silently reduces every user's effective quota by up to `quotaShare`. The release note and the C2 usage display are release blockers, not nice-to-haves.
- **Upstream watch:** upstream left versioning TODOs and may ship their own. The weekly upstream-sync PR reviewer must check for upstream versioning work; the `custom-versioning` module boundary plus tiny `mod()` hooks is the containment strategy. Migration note in the ADR. **`[R2]` `mod()` hook sites to re-verify on every sync:** `saveStream` (2 spots), `saveMultipart` (:292 region), `mkFile`, both editor `copyFileContent` calls, `delete()` (both permanent branches). Keep them greppable (`git log --grep '^mod('`).

## 7. Maintainability guardrails (enforce in every subagent prompt)

1. New code under `custom-versioning/` and `custom-shared/` (backend) and fork i18n bundles only; upstream file edits are single-purpose `mod(<area>)` commits, ideally ≤10 lines each. `nc-uploads.controller.ts` is fork-owned; edits there are normal commits. **`[R2]` No edits under `frontend/src/app/applications/files/`** — v2 only (ADR §14).
2. Read the neighboring upstream implementation before writing (trash retention for the scheduler, `realTrashPathFromSpace` for path resolution, `nc-file-row-ensurer` for row materialization, classic trash dialog for UI structure, nc-propfind specs for NC tests, files controller for guards). Match its style exactly, including error classes (`FileError`), logging shape, and DTO/validator idioms. For D2, additionally read upstream Nextcloud source per CLAUDE.md.
3. No new dependencies without an ADR note. Diff generation: prefer a tiny well-known lib or hand-rolled Myers; check `package.json` first.
4. Every task = one feature branch, one PR to `zjean/server` (`--repo zjean/server` explicitly), `test` check green, squash merge. Never push to `main`, never PR upstream unless on an `upstream-contrib/` branch rooted at `upstream/main` with no `custom-*` paths. Remotes use the `github-prive` SSH alias; ensure the SSH key is loaded before pushing.
5. All behavior behind `files.versions.enabled` — **`[R2]` except `FileRowEnsurer` (B0), which mobile-compat needs unconditionally.** AGPL headers preserved on every touched upstream file.
6. Definition of done per task: code + unit tests + spec file updated for any modified upstream service + **`[R2]` `npm run build -w backend` clean** (vitest's type check misses service↔real-class errors) + CHANGELOG line + docs touch if user-visible.
7. **Inode-stability invariant:** no code in this feature may replace a live file's inode. Restores and any live-content replacement use `copyFileContent`. Enforce in review; E2E-2 and E2E-11 assert it.
8. **Migrations via tooling only:** every schema change goes through drizzle-kit (`db:generate` → generated SQL + `meta/` snapshot → `db:check`/`check-db.ts`). No hand-written or hand-edited migration files, ever.
9. **`[R2]` Write-path completeness invariant (corrected to six entry points / six hook sites):** any code path that overwrites live file content must gain a snapshot hook and an E2E case before merge. Current inventory — entry point → hook site → covering test:
   | # | Entry point | Hook site | Origin | Test |
   |---|---|---|---|---|
   | 1 | `saveStream` direct branch | before `writeFromStream` (:156-158), gated `fExists && startRange === 0` | `webdav` / `nc-text` | E2E-3 |
   | 2 | `saveStream` tmpPath branch | before `moveFiles` (:166) | `sync` | E2E-4 |
   | 3 | `saveMultipart` PUT **and PATCH** | before `moveFiles` (:292), gated `(overwrite \|\| patchMethod) && dstExists && !dstIsDir` | `web` / `web-patch` | E2E-1, **E2E-17** |
   | 4 | Collabora `saveDocument` | before `copyFileContent` (:137) | `collabora` | E2E-11 |
   | 5 | OnlyOffice `saveDocument` | before `copyFileContent` (:409) | `onlyoffice` | E2E-11 |
   | 6 | NC `assembleAndMove` | before `moveFiles` (:212) | `nc-chunked` | E2E-5 |
   | 7 | **`mkFile(overwrite=true)`** | once before the sample-vs-empty branch (:363), covering both `copyFileContent` (:365) and `createEmptyFile` (:369) | `sync-make` | **E2E-18** |

   One hook covers PUT and PATCH (same destructive `moveFiles`), and one covers both `mkFile` branches — so seven entry points map to seven hook sites. When reviewing an upstream sync, grep for new `writeFromStream` / `copyFileContent` / `moveFiles(..., true)` / `createEmptyFile` call sites and extend this table before merging.
10. **`[R2]` Anchor invariant:** version rows are keyed on `files.id`, never on path. Any change that introduces a path column or path-based lookup on `files_versions` must first explain how rename/move repathing is handled — E2E-19 exists to fail loudly if this slips.
11. **`[R2]` Quota honesty invariant:** never document or claim that versioning cannot cause a failed save. The pre-flight guard in `space.guard.ts` is outside this feature's control (ADR §7).

## 8. Task dependency graph (for the orchestrator)

```
A1 ──> B0 ──┐
     └> B1 ──┴─> B2 ──┬─> B3 ──> B6, D1, D3, D4
                      ├─> B4 ──> C1 ──> C2
                      │      └─> D2
                      └─> B5
B3 + B4 + B5 ──> Phase E (e2e suite, split E2E-1..20 across subagents by module)
Everything ──> §6 rollout
```

`[R2]` **B0 is the new critical-path root alongside B1** — B2 cannot obtain a `fileId` without it, and B0 touches load-bearing NC PROPFIND code, so it should land and soak early. B0 and B1 are independent of each other and parallelizable after A1.

Parallelizable after B2: {B3}, {B4}, {B5}. After B3+B4: {C1→C2}, {D1}, {D2}, {E specs}.
