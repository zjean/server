# File Versioning — handoff

- **Date:** 2026-07-27
- **Audience:** whoever picks this up next, with no memory of the sessions that built it
- **Status:** Phases A, B and C complete and merged to `main`. Feature flag **off**. Phases D and E not started.

> **Starting Phase D?** Read [`2026-07-27-file-versioning-phase-d-handoff.md`](2026-07-27-file-versioning-phase-d-handoff.md) instead — it supersedes this document's §5 per-task notes for D, and carries the verified dev-stack recipe. This file remains the record of the Phase A/B design corrections, which are still current.

Read this first, then the ADR. The implementation plan is still accurate for *what* is left; this document records *what changed under it* and *what will bite you*.

| Document | Role |
|---|---|
| [`2026-07-25-file-versioning-implementation-plan.md`](2026-07-25-file-versioning-implementation-plan.md) | The task list. Still authoritative for C, D, E scope. Its Phase-B details are now superseded where they conflict with the ADR. |
| [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) | **The ADR — the authority.** Corrected three times during implementation. Where the plan and the ADR disagree, the ADR wins. |
| This file | State, the corrections and why, and the traps. |

---

## 1. What is on `main`

Eight PRs, #310–#317, in this order:

| PR | What |
|---|---|
| #310 | The ADR |
| #311 | `custom-shared/FileRowEnsurer` — materializes a `files` row on demand, shared with `custom-mobile-compat` |
| #312 | `custom_files_versions` schema + migration `0007` |
| #313 | `VersioningService` — snapshot, restore, label, delete, purge, usage |
| #314 | The seven write-path hooks (`mod(files)`, `mod(editors)`, NC uploads) |
| #315 | REST API — list, download, restore, label, delete, usage, diff |
| #316 | Retention scheduler + blob GC |
| #317 | Store-isolation guard test; event-bus documentation |

**1993 backend tests, `nest build` clean, backend lint clean** at `f6aeea19`.

**Nothing is user-visible yet.** `files.versions.enabled` defaults to `false` (`files/files.config.ts`), checked inside `VersioningService`, so all seven hooks are no-ops and every REST endpoint 404s.

### Since this file was first written

Three more PRs landed, and the state above is Phase A/B only:

| PR | What |
|---|---|
| #320 | **C1** — the `custom-v2` service and typed models |
| #321 | **C2** — the version-history UI, a Versions tab in the file-detail inspector |
| #322 | Fixes found by browser-verifying C2: restore was impossible (`create` vs `createOrRefresh` on the caller's own lock) and every domain error returned 500 (`FileError` is not an `HttpException`). Both are written up in the Phase D handoff §4 |

`main` at `7880d052`, **2003 tests passing**. The feature is verified working end to end in a browser as of #322 — so the browser-verification gate this file recorded as owed is **satisfied**.

### Left to do

- **D1** — WebDAV correctness verification (mostly assertions; no new code expected).
- **D2** — Nextcloud client compatibility. **Read §5 before touching this.**
- **D3** — desktop sync interplay: verification only.
- **D4** — Collabora coalescing cadence measurement.
- **Phase E** — the E2E suite, cases E2E-1..20. Note E2E-6's trash expectations and the trash-age discussion in §3.4; the plan's E2E list predates that correction.

---

## 2. The one-paragraph mental model

When a write is about to destroy a file's bytes, `VersioningService.snapshotBeforeOverwrite` is called **synchronously, before the destructive operation**. It copies the current content into a content-addressed blob store — `<home>/versions/<digest[0:2]>/<digest>`, a **sibling** of `files/` and `trash/` — and inserts a row in `custom_files_versions` keyed on `files.id`. It never throws into the caller: a failed snapshot degrades to "no version", never to a failed save. Reads, restore and retention all go back through `versionsRoot` (the string `user:<login>` or `space:<alias>` recorded on each row) to find the bytes.

Everything else in the design follows from three facts about this codebase, all verified:

1. **The `files` table is a sparse index, not a row-per-file mirror.** `space.dbFile` carries no `id`. A file that was only ever uploaded and edited has no row at all — hence the `FileRowEnsurer`.
2. **There are seven destructive write entry points, not one.** Two in `saveStream`, two in `saveMultipart` (PUT *and* PATCH), both editors (which bypass `saveStream` entirely), NC chunked assembly, and `mkFile(overwrite=true)`.
3. **Quota is enforced pre-flight off a one-day cache**, before any versioning code runs. Versioning therefore cannot promise anything about whether a save succeeds — see ADR §7 for the wording that *is* honest.

---

## 3. Five corrections made during implementation

Each was a real defect found by a test or a review, not a refactor. Each is recorded in the ADR; they are collected here because a fresh reader will otherwise re-derive the original, wrong design — the plan still describes some of them.

### 3.1 Blobs are copied, never hardlinked (ADR §1.1)

The plan specified hardlink-then-copy-on-`EXDEV`. **That silently destroys history.** A hardlinked blob shares the live file's inode, and three of the seven write paths truncate that inode *in place* rather than replacing it: `saveStream`'s direct branch, both editors via `copyFileContent`, and `mkFile`. For those, the following write lands on the bytes the version points at, so the "saved" version ends up holding the **new** content.

The irony worth remembering: **the repo's deliberate inode-stability is what makes hardlinking unsound here**, and the ADR relies on that same property for restore (§9). The same fact, read from both ends.

Now `fs.copyFile` + `COPYFILE_FICLONE` — a reflink where the filesystem supports it, an honest copy otherwise, which also removes the cross-device branch. **`versioning.service.spec.ts` has the test that fails if anyone reintroduces `fs.link`.**

### 3.2 The digest comes from the staged copy, and publish is always by rename (ADR §1.2)

Hashing the live file in a pass separate from the copy leaves a window in which the two disagree — and WebDAV writes hold **no server lock**, so that window is reachable by design. Because the store is content-addressed, one mis-named blob would then be served for *every later file with that content*. This is the only corruption in the design that escapes its own row.

So: copy to `<versions>/.staging/<uuid>.part`, hash **the stage**, rename into the shard. The rename is unconditional even on a dedup hit — skipping it reintroduces a check-then-act where a concurrent eviction can leave a brand-new row pointing at nothing.

### 3.3 Restore pins the blob open before it snapshots (ADR §9)

The first implementation resolved the blob path, checked it existed, then took its safety snapshot — whose quota eviction picks the **oldest unlabeled version**, which is very often *exactly the revision being restored*. It unlinked the blob, and the write then truncated the live file to zero bytes before failing to read its source. Asking to go back destroyed both the file and the thing you asked to go back to.

Now: `fs.open` first, write from the descriptor (an open fd survives `unlink`), verify the blob's size against its row before touching the live file, and exempt restore snapshots from the quota cap.

**The general rule, which applies to anything you add:** *anything that reads a blob must pin it before running code that can evict.* Eviction and reads share no lock.

### 3.4 There is no trash-age rule, and there cannot be one (ADR §10)

ADR §10 originally delegated reclamation of trash-expired files to a "dangling-row GC" — version rows whose `files` row had vanished. **That is unreachable:** `files-trash-retention` never touches the `files` table, and version rows *pin* the `files` row against `FilesScheduler.deleteOrphanFiles`. The row never disappears, so nothing was ever reclaimed.

The replacement — "purge versions of `inTrash` files older than the trash window" — was **also wrong, and destroyed restorable history.** A version's `createdAt` is when the file was *overwritten*, arbitrarily long before it was trashed. A document last edited two months ago and trashed today lost its entire history on the first nightly sweep while staying restorable for the full window.

There is **no trashed-at timestamp addressable by `files.id`**: the row carries only `inTrash`, and the trash sweeper's `deletedAt` lives in per-root, **inode-keyed** tables the ADR already rejected joining.

So the rule was removed. `retentionDays` expires old versions regardless of trash state, and permanent delete purges properly. **The accepted, documented leak:** history of a file whose trash entry expired *on disk* survives until that entry is permanently deleted. If you want to close it, add a real trashed-at timestamp first (a fork-owned table keyed on `fileId`, which would also join §20's protected union automatically) — not another proxy.

### 3.5 The eviction decision lives in exactly one place (ADR §7)

Labeled versions are never evictable. So if labeled bytes **alone** exceed the ceiling, no sequence of evictions can reach it — and a `while (used > ceiling)` loop then deletes every unlabeled version in the root, including every other file's, and still finishes over the ceiling. Maximum destruction, zero benefit.

**This bug shipped twice**, because the same decision rule lived on the eager path and in the retention sweep and only one copy had the guard. It is now `VersioningService.evictUntilUnderCeiling`, called by both. If you add a third caller, call that method — do not write another loop.

---

## 4. Two ways this codebase produced green tests over broken code

Both are worth internalising before you write tests here.

**`snapshotBeforeOverwrite` swallows every error by design.** That is correct — a failed snapshot must not 500 a working save — but it means a bug *after* the row insert is invisible. A missing method on a collaborator threw a `TypeError` that **43 green tests never noticed**. `versioning.service.spec.ts` now spies on `Logger.prototype.error` and happy-path cases assert nothing was logged. **Keep that, and extend it to any new swallowing path.**

**A stub that always takes the boring branch hides the interesting one.** The retention spec's `db` stub always answered *"this root has no quota"*, so **no test ever entered the quota rule's destructive path** — which is exactly where the data-loss bug in §3.5 lived. 19 green tests over a loop that never ran. When you stub a gate, make at least one case open it.

---

## 5. Per-task notes for what is left

**C1 / C2 (frontend).**
- `custom-v2` **only**. Do not touch `frontend/src/app/applications/files/` — read it as ground truth for API-call shape, per CLAUDE.md, then write v2.
- i18n goes in `frontend/src/i18n/custom/{en,nl}.json`; never upstream bundles. `v2_*` prefix for parameterised keys.
- The API is already there: `versions/{list,usage,content,restore,label,delete,diff}/…` — see `custom-versioning/constants/routes.ts`. The space path is the trailing wildcard.
- **C1 is done** (`custom-v2/services/versions.service.ts` + `custom-v2/models/version.model.ts`). Three things it had to correct or work around, all of which C2 inherits:
  - **`?confirmLabeled=true` returned 400.** `DeleteVersionDto` is bound to `@Query()`, so the value arrives as the string `'true'`, and the app pipe is `ValidationPipe({ transform: true, whitelist: true })` with no `enableImplicitConversion` — `@IsBoolean()` rejected it, making a labeled version undeletable. Fixed with a per-field `@Transform`; the controller spec now runs the real pipe against the real DTO, which is the gap that let it ship (every other case hands the handler a DTO object directly).
  - **`VersionProps.createdAt` is a `Date` in the backend type and a string on the wire.** Typing a response as `VersionProps` compiles and then throws on `.getTime()`. `VersionApiProps` spells out the wire shape; `toVersionModel` converts once.
  - **The feature-off 404 is now `VERSIONS_DISABLED_MESSAGE`** in `custom-versioning/constants/versioning.ts`, imported by the frontend. Status alone cannot carry the probe: these routes also 404 with SpaceGuard's `'Space not found'`. `VersionsService.availability` latches `unavailable` only on that exact message, so a per-file failure never hides the panel globally.
- Two timestamps per row, and they are not interchangeable: `mtime` is when the revision's own bytes were written, `createdAt` is when the overwrite retired it. They can be months apart.
- **C2 is done**, with two decisions that depart from the implementation plan — both deliberate, both the maintainer's call:
  - **The history is a tab in the `file-detail` inspector, beside Comments — not a dialog off the file browser** as §3 of the plan describes. `comments-panel.component.ts` is the structural precedent it follows.
  - **Rows are labeled with `mtime`**, framed as "restore it to how it was on…". `createdAt` is in the row's tooltip.
  - Supporting notes: the tab is hidden until `VersionsService.probe()` settles availability (the panel cannot drive its own tab's visibility — it only mounts once the tab is open), and `VERSIONS_TEXTUAL_MIMES` / `VERSIONS_MAX_DIFF_BYTES` moved into `constants/versioning.ts` so the UI decides whether to offer Compare from the same facts the endpoint enforces.
  - **Deferred, and why:** non-text compare. The plan wanted the old revision opened read-only in the v2 viewer, but `GET versions/content` is `Content-Disposition: attachment` by deliberate design (rendering an old revision inline where the current file is expected is misleading — see the controller). Inline preview needs a backend opt-in, which is a product decision, not a UI detail. Non-text rows offer download.
  - **Browser-verified in #322**, which is where the two real bugs turned up. Full recipe in the Phase D handoff §2 — the "no Chrome / `ng serve` binding" blockers recorded elsewhere are stale.
- **ADR §7 makes the versions-usage display a release blocker**, not a nice-to-have: enabling this feature silently reduces every user's effective quota by up to `quotaShare`, and the UI is the only place that becomes visible. Shipped in C2; note the figure is **root-scoped, not per-file**, and its ceiling reads through a one-day quota cache.

**D2 (NC compat) — the highest-risk remaining task.** CLAUDE.md mandates reading upstream Nextcloud source *before* designing any endpoint, and a previous compat feature shipped broken because that step was skipped. Fetch the `nextcloud/files_versions` app (routes, DAV plugin, `lib/Capabilities.php`) plus the `NextcloudKit` parser for the wire format. The NC `fileId` maps directly to our `files.id`, so reuse `FileRowEnsurer` exactly as nc-dav already does. Apply the storage quirks: mime `image-jpeg` → `image/jpeg`, mtime ms → seconds, real DB ids, **strong** ETags.

**Phase E (E2E).** Needs the dev stack running. Known environment blockers from earlier sessions: no Chrome installed (the chrome-devtools MCP fails), `ng serve` binds `:4200` `[::1]`-only rather than `:8080`, and OrbStack wedges under load. The MariaDB dev container is pre-seeded and was at migration 0006 before this work; it now has `custom_files_versions`.

---

## 6. Known gaps, deliberately left

Small, and each has a reason:

- **No test asserts `deleteOrphanFiles` actually protects a version-referenced `files` row.** The existing test asserts the *reflection contract* (`custom_files_versions` appears in `getTablesWithFileIdColumn()`), which covers two of three failure modes. The third — an upstream sync replacing that reflection with a hard-coded table list — would leave the test green and the protection gone. `files-scheduler.service.ts` is on ADR §18's watch list for this reason.
- **No test pins the `versionsRootFromSpace` ↔ `realTrashPathFromSpace` mirror.** They agree branch-for-branch by construction and by comment, but a table-driven spec running the same env shapes through both would catch upstream divergence that prose cannot.
- **`blobPathFromRoot` is not fuzzed**, only case-tested.
- **The retention sweep is N+1 per victim** (delete, refcount, unlink). Bounded now, but a large first run on a populated install is still chatty. Paging is in place; batching the victim selection is not.
- **ADR §20 nuance:** the load-bearing thing is the **TypeScript property key** `fileId`, not the SQL column name. The reflection and the sweep both go through the property.

---

## 7. Repo mechanics that cost time in these sessions

All in CLAUDE.md, but these are the ones actually hit:

- **`git add <explicit paths>`.** A `git add docs/` swept eight untracked PNG screenshots into a docs PR and onto `main`. They turned out to belong there — `docs/plans/` already tracked screenshots — but it wasn't a deliberate choice. Never `-A` or a directory while untracked files sit in the tree.
- **`npm run build -w backend` before every push.** vitest's type check does not catch service↔real-class type errors; `nest build` does.
- **Backend lint is a pre-push gate** and it will fail CI on prettier formatting alone. `npm run -w backend lint:fix`.
- **Migrations only via `npm run -w backend db:generate`.** A hand-written SQL file is silently skipped, because `drizzle-kit migrate` reads `meta/_journal.json` to decide what to apply.
- **Stacked PRs plus squash merge means a rebase after every merge.** Squashing rewrites SHAs, so each remaining branch must be re-pointed or its diff keeps carrying already-merged work. Eight PRs cost seven rebase cycles; they were all conflict-free because the stack was linear.
- **The SSH key must be loaded** (`ssh-add`) before any push; `gh` works over HTTPS regardless, which makes the failure look confusing.
