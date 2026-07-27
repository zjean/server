# File Versioning — Phase D findings

- **Date:** 2026-07-27
- **Status:** the record of what Phase D verified, and what it found that changes the design's claims.
- **Companion to** [`2026-07-27-file-versioning-phase-d-handoff.md`](2026-07-27-file-versioning-phase-d-handoff.md) (what to do) and
  [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) (the ADR — still the authority).

Phase D is integration work. Three of its four tasks are verification rather than new code, so this file is the
deliverable for those three: it says what was asserted, where the assertion lives, and what turned out to be untrue.

**Phase D is complete.** If you are picking this up, read §5 first — it is the short list of what is left and which
two items need a decision rather than a session. Two of the handoff's per-task instructions turned out to be wrong;
both are in D2, and both are called out where they matter.

---

## D1 — WebDAV correctness

Branch `mod/versioning-webdav`. No production code changed; all four claims already held. What was missing was
executable evidence, which is now in place.

### D1.1 A resumed content-range PUT sequence produces exactly ONE version

**Holds.** `files-manager.service.spec.ts` →
*"produces exactly ONE version across a resumed content-range PUT sequence, taken before the first byte lands"*.

The shape of a resumed DAV overwrite is worth writing down, because it is not the shape the task description
suggests. `saveStream` validates `startRange === <current file size>` (`files-manager.service.ts:175-178`), so a
client **cannot** open a sequence with `Content-Range: bytes 0-…` against an existing non-empty file — that request
is a 400 before any versioning code runs. The reachable sequence is:

| # | Request | `startRange` | Snapshot? |
|---|---|---|---|
| 1 | plain `PUT`, no `Content-Range` | 0 | **yes** — `origin: webdav` |
| 2..n | `PUT` with `Content-Range: bytes <size>-…` | `> 0` | no |

So the "snapshot at `startRange === 0` only" rule and "exactly one version per resumed sequence" are the *same* rule
seen from two sides, and the rule is load-bearing in only one direction: request 1 is the only one that still has the
pre-upload bytes in front of it.

The test asserts both halves — one snapshot, and its `invocationCallOrder` before the **first** `writeFromStream` of
the sequence. The ordering assertion is what covers *"the full pre-upload content, never a partial"*: there is no
chunk the snapshot could have been interleaved with.

### D1.2 ETag and `getlastmodified` derive from the live file only

**Holds.** `versioning.service.spec.ts` →
*"leaves the live file's ETag and getlastmodified untouched, so a PROPFIND cannot tell versions exist"*.

`WebDAVFile.getetag` is `genEtag(size, mtime)` and `getlastmodified` is `new Date(mtime).toUTCString()`
(`webdav/models/webdav-file.model.ts:43,65`) — both pure functions of the live stat. Snapshotting cannot perturb them
because `stageBlob` copies **out of** `space.realPath` with `fs.copyFile` and hashes the staged copy, so the live file
is only ever opened for reading.

That is a property of the current implementation, not of the interface, which is why it is now pinned: a version of
this feature that `touch`ed the live file to mark it versioned, or hashed it in place through a handle opened for
update, would change the ETag and make every DAV and NC client re-download an unmodified file. The test was verified
non-vacuous by injecting `fs.utimes(realPath, …)` into `stageBlob` — it fails.

### D1.3 Strong ETags stay strong

**Holds, already guarded.** `nc-propfind.service.spec.ts:137` →
*"emits d:getetag as a strong ETag (no W/ prefix), even when the source file carries a weak one"*.

Sync-in's `genEtag` defaults to `weakPrefix = true` and emits `W/"…"`; `nc-prop-builder.ts` strips it. Nothing in
versioning touches either. Recorded here so the next reader does not go looking: **the guard already exists and needs
no versioning-specific duplicate**, because versions never reach the ETag path at all.

### D1.4 The versions directory never appears in a PROPFIND of the space root

**Holds, and it is placement-dependent — this is the fragile one.**

Two assertions, deliberately at different levels:

- `utils/paths.spec.ts` → *"is not inside the files repository, so the indexer, PROPFIND and sync never see it"* —
  structural, over the path helpers.
- `versioning.service.spec.ts` → *"adds nothing inside the served files tree, so the versions store cannot surface in
  a PROPFIND"* (new) — behavioural, over a real snapshot on a real filesystem, including the `.staging` directory.

The second exists because the first would survive a refactor that moved the store while keeping the helpers' shape.
Neither is a filter: **there is no exclusion anywhere.** The content indexer walks with a plain readdir and has no
dotfolder or name-based skip (`files-content-indexer.service.ts:321`), and PROPFIND and the sync diff enumerate from
the same files-repository roots. The store is unseen **only** because it is a sibling of `files/` and `trash/`
(ADR §1). Anyone "simplifying" it to `<files>/.versions` breaks WebDAV, the indexer and desktop sync in one move, and
these two tests are the alarm.

### D1.5 DAV writes hold no server lock — documented, not fixed

`saveStream` creates a lock only in the **non-DAV** branch (`files-manager.service.ts:154`). A WebDAV request gets
`checkConflicts` (`:147-152`) and then writes **unlocked**. Two consequences, both accepted by ADR §4:

1. The `webdav` origin's snapshot is **best-effort under concurrency**. Do not document or claim "under lock"
   semantics for it. E2E-14's DAV case asserts *no corruption*, not a strict version count.
2. It is precisely why the snapshot must **copy first and hash the copy**, never hash the live file in a separate pass
   (ADR §1.2). The unlocked window between two reads of the live file is reachable *by design here*, and a blob stored
   under a digest that does not describe it is the one corruption in this design that escapes its own row — every
   later snapshot of the genuinely-matching content would dedup against it and serve the wrong bytes.

Fixing (1) would mean taking a server lock on DAV writes, which is an upstream behaviour change well outside this
feature's blast radius. Not attempted.

### D1.6 DeltaV `version-history` REPORT — out of scope

Confirmed still out of scope for v1, per the plan. Nothing consumes it: Sync-in's own clients use the REST API, and
the NC mobile clients use the NC versions DAV tree (see D2), not DeltaV. Implementing RFC 3253 would add a protocol
surface with no reader.

---

## D2 — Nextcloud client compatibility

Branch `feat/versioning-nc-compat`. The one Phase D task that is real code: `NcVersionsController`,
`NcVersionsService`, `utils/nc-version-xml.ts`, and the capability block.

### D2.0 Reading upstream first changed three decisions

This is the task CLAUDE.md's NC-source-as-ground-truth rule exists for, and it earned its keep three times. Each of
these would have been wrong if inferred from server-side convention:

| Inferred | Actually |
|---|---|
| a top-level `files_versions` capability block | `files.versioning`, plus `files.version_labeling` and `files.version_deletion` — `files_versions` is the **app id** |
| version nodes named by our row id | named by the superseded content's **mtime in unix seconds**, and the name must agree with `d:getlastmodified` |
| the listing contains one entry per version | the **collection itself must be response[0]**, or Android drops the oldest version |

The sources, and the exact lines that settle each:

- `nextcloud/server` → `apps/files_versions/lib/Capabilities.php` (the capability shape),
  `lib/Sabre/{VersionHome,VersionRoot,VersionCollection,VersionFile,RestoreFolder,Plugin}.php` (the node tree, the
  props, the MOVE-into-restore semantics), `lib/Storage.php:374` (the revision id **is** `filemtime`).
- `nextcloud/android-library` → `ReadFileVersionsRemoteOperation.java` (PROPFIND `Depth: 1`, and the
  `for (int i = 1; …)` loop that discards `response[0]`), `RestoreFileVersionRemoteOperation.java` (the MOVE),
  `model/FileVersion.java` (the parser), `WebdavUtils.getFileVersionPropSet()` (the requested props),
  `WebdavEntry.kt:150-173` (how `getlastmodified` and `resourcetype` are read).
- `nextcloud/NextcloudKit` → `NextcloudKit+Capabilities.swift:294-309` (the three flags being decoded).

**The revision-id decision is the load-bearing one, so it is worth stating why it cannot be our row id.**
`FileVersion.getFileName()` is `String.valueOf(modifiedTimestamp / 1000)`, computed from the parsed
`d:getlastmodified`. The href is **never read.** `RestoreFileVersionRemoteOperation` then builds its MOVE source from
that derived name. So a listing whose node name disagrees with its `getlastmodified` produces a restore request for a
revision that does not exist — and there is no error anywhere until the user taps Restore and nothing happens.

Of our two timestamps, `mtime` is the one that means what upstream's means (the mtime of the bytes the version holds).
`createdAt` is when the overwrite retired them, which can be months later.

**Accepted cost: one-second resolution.** Two versions of one file whose mtimes fall in the same second collapse to a
single NC entry. That is a property of the protocol rather than of our storage — upstream cannot represent them either,
since both would want the same `.v<ts>` filename. The v2 UI keys on the row id and still shows both. Collisions need
sub-second-adjacent overwrites that also escaped the coalescing window (different author or origin), so they are rare;
the newest row wins, deterministically.

### D2.1 What is served

`PROPFIND` of a collection and of a single version, `GET`/`HEAD` of a version, `MOVE` into `restore`, `DELETE`, and
`PROPPATCH` of `nc:version-label`. Every handler 404s while `files.versions.enabled` is false, checked **before** the
url-user and id checks so a disabled deployment leaks nothing about which ids exist. The capability is absent in the
same state, so a client never learns the tree exists.

`restore` needs no route of its own: a WebDAV MOVE is issued against the **source** URL, so a restore arrives on the
version's own route with the target in `Destination`. Nothing ever addresses the `restore` collection directly.

### D2.2 Two deliberate divergences from upstream

- **`nc:has-preview` is always `false`**, even for images. Upstream emits `true` and backs it with the single route in
  `apps/files_versions/appinfo/routes.php` (`Preview#getPreview`), which this fork does not serve. Our
  `/index.php/core/preview` renders the **live** file, so a truthy value would mean either a 404 per row per listing —
  the exact pattern that got `dav.bulkupload` removed from `constants/capabilities.ts` — or, worse, the current
  thumbnail displayed beside an old revision.
- **`DELETE` passes `confirmLabeled: true`.** The REST API requires an explicit flag before deleting a *named* version,
  because a name exempts it from every automatic pruning rule. NC's protocol has no way to send one, so the 409 would
  be unresolvable from the client and would read as "deleting versions is broken". A DELETE addressing one specific
  revision is itself the deliberate act.

### D2.3 One correction to the handoff: `FileRowEnsurer` is not used here

The handoff (§3, D2) says to *"reuse `custom-shared`'s `FileRowEnsurer` exactly as `nc-dav` already does — otherwise a
version query for a file with no `files` row 404s."* The concern is real; the placement is not. **It would be dead
code.** A client can only reach this route with a fileId our own PROPFIND of the parent directory handed it, and that
PROPFIND is where `NcFileRowEnsurer` already runs (`nc-propfind.service.ts:111`). By the time a fileId exists on the
wire, the `files` row exists. Adding a second, always-no-op call would obscure which layer owns the guarantee.

`CustomVersioningModule` is also **not** imported by `CustomMobileCompatModule`. It is `@Global` and exports
`VersioningService`, which is how `FilesManager` and both editor managers already reach it, and how `NcVersionsService`
reaches it here — so mobile-compat's import list stays free of the versioning module, and `FileRowEnsurer` keeps coming
from `custom-shared` whether versioning is on or off (ADR §12/§13).

### D2.4 The trap the handoff warned about, and the test for it

`VersioningExceptionsFilter` is declared on the controller, **and a spec asserts the declaration**. `FileError` and
`LockConflict` extend `Error`, so without it every domain error this tree can raise — 403 permission denied, 404
unknown revision, the 409 blob-size mismatch, a 423 lock conflict — arrives as an opaque 500. That is the bug PR #322
fixed for the REST API, and a new controller does **not** inherit the filter. The metadata assertion is cheap and is
the only thing that fails if someone drops the decorator.

### D2.5 It will not light up in a stock client yet — and that is about the clients

Implemented and correct is not the same as user-visible. Two independent client-side gates, both found by reading the
clients rather than by testing against them:

- **iOS has no file-versions UI at all.** NextcloudKit has no versions endpoint — there is no
  `NextcloudKit+Versions.swift` — and although `NextcloudKit+Capabilities.swift` *decodes* `versioning`,
  `version_deletion` and `version_labeling`, it never surfaces `versioning` on its flattened `Capabilities` object.
  Nothing in `nextcloud/ios` requests `/remote.php/dav/versions/…`.
- **Android's version list is gated behind an Activity API this fork does not serve.**
  `FileDetailActivitiesFragment` reads versions only when `capability.getFilesVersioning().isTrue()` (:253) — which we
  now satisfy — but it fetches activities *and* versions in one task and calls `populateList` only inside
  `if (result.isSuccess() && result.getData() != null)` on the **activities** result (:347). That call is
  `GetActivitiesRemoteOperation` → `/ocs/v2.php/apps/activity/api/v2/activity`, which this fork did not serve.

> **RESOLVED, and the mechanism above was stated too loosely.** The endpoint shipped (see D2.6). The correction matters
> because it changes what the fix had to be: `GetActivitiesRemoteOperation.isSuccess()` **deliberately accepts 404** —
> 200, 304 and 404 all count, an accommodation for servers without the activity app — so it is *not* true that "the
> fetch fails" on a 404. What actually happens is that the operation then parses the body unconditionally, and
> `jo.getAsJsonObject("ocs").getAsJsonArray("data")` throws `NullPointerException` for any body with no `ocs` key.
> Nest's own 404 JSON is exactly such a body, and `RemoteOperation.execute` does not catch it. **The requirement was
> therefore an OCS-shaped body, not a 200** — an empty `ocs.data` would already have been enough.

**Do not read an empty Android list as a bug in the versions code.** That inference is the reason this section exists.

### D2.6 The Activity OCS endpoint, added so the version list renders

`/ocs/v2.php/apps/activity/api/v2/activity` and its `/filter` variant, backed by `nc_sync_events` — the append-only log
`NcSyncLogService` already keeps for the RFC 6578 sync-collection REPORT. **No new storage:** that table is already a
per-user record of create / update / delete with a path and a timestamp, already pruned by an existing cron.

**Deliberately not advertised in capabilities.** The `activity` key stays absent. Android never consults it — the tab
is added unconditionally and the call is always made — so serving the endpoint is sufficient there, while advertising it
would additionally make NC iOS render an activity view and probe the endpoints behind it. Fixing Android without
changing anything for iOS is the smaller change, and it leaves the existing "deliberately NOT advertising
notifications or activity" comment in `constants/capabilities.ts` true.

Three wire facts that come from `Activity.kt` and the adapters, not from convention:

- **Every field must be present and non-null.** `Activity` is a Kotlin data class of non-null `String` properties parsed
  by Gson, and **Gson bypasses Kotlin's null checks** — an omitted field lands as `null` and throws at the first
  `.isNotEmpty()` on the render path, not at parse time.
- **`subject_rich` must be a JSON array.** `RichElementTypeAdapter.read` calls `in.beginArray()` unconditionally; an
  object or a string there raises `IllegalStateException` and takes the whole parse down.
- **`icon` is dereferenced outside its own guard** (`activity.icon.endsWith(…)` runs regardless of `isNotEmpty()`), so it
  must be a string even when empty.

Two deliberate simplifications, both to avoid nullable dereferences on the render path: `subject_rich` is always the
**empty array** with the human text in `subject` (a populated rich element sends `ActivityListAdapter` down its
clickable-chip branch, which dereferences `RichObject.name` and `.id`, both `String?`), and `previews` is always empty.
Also **`X-Activity-Last-Given` is deliberately not set**: `hasMoreActivities()` is `lastGiven > 0` and drives infinite
scroll, so emitting it without implementing `since` would make Android re-request the same page forever.

Honest limits, all inherited from the log rather than chosen: **no actor** (rows key on the file's owner, not on who
made the change, so the entry names that one identity), **no fileId** in the unfiltered feed (the log stores paths;
resolving an id per row would be a query per entry for a field only the rich-object path uses), and a **30-day
horizon** — a file whose last change predates the prune window has an empty feed, which is the same horizon that
already bounds what the sync REPORT can replay. Personal-space files only, like the rest of the fileId-keyed surface.

---

## D3 — Desktop sync interplay

Verification only; no production code. All four claims hold, and the headline is the one the plan hoped for:
**versioning needs no sync-side code at all.** The tests are written so that they demonstrate this rather than assert
it — the two sync-side cases know nothing about versioning, because a test that had to reach into the versioning
module to show the sync side works would be evidence against the claim.

### D3.1 A restore propagates as a normal remote update

**Holds.** Two tests, one per side:

- `custom-versioning/services/versioning.service.spec.ts` → *"changes the size, mtime and content hash the sync diff
  keys on, while the inode holds"*.
- `sync/services/sync-manager.service.spec.ts` → *"reports a restore as a modification: new size/mtime/checksum at an
  unchanged inode"*.

The mechanism is `sync-manager.service.ts::checkSumFile`. The diff tuple is `[isDir, size, mtime(s), ino, checksum]`
and the client's cached checksum is reused **only** when size **and** mtime **and** ino all match. A restore moves
size and mtime, so the reuse guard fails, the checksum is recomputed from the restored bytes, and the client receives
a changed `(size, mtime, checksum)` at a stable inode — an ordinary modification.

**One thing worth stating precisely, because it is easy to get backwards.** The inode is *not* what makes this a
modify rather than a delete+create for sync: the mtime change alone would do that, and if a restore *did* swap the
inode the diff would still report a change. The inode matters to **trash retention**, which keys records on
`stats.ino` (`files-trash-retention.service.ts:207`), and to `dbFileHash` / `file.id` consumers. Sync is simply
indifferent to it. So ADR §9's inode invariant is justified by trash retention, not by sync — and the counterfactual
test ("if the inode changed, sync would break") does not exist because it would be false.

The complementary control is asserted too: an untouched sibling keeps its cached checksum, so a restore does not
force a re-hash of the tree.

### D3.2 A sync upload of an existing file creates exactly one version

**Already held, already covered.** `files-manager.service.spec.ts` →
*"snapshots at the move for a tmpPath (sync) upload, not at the tmp write"*, plus the ordering assertion against
`moveFiles`. The reason it is one and not one-per-chunk is `validateTmpFile`: it rejects a tmp file whose size does not
match the declared size, so intermediate chunks never reach the `moveFiles` the hook guards.

### D3.3 A sync `make` on an existing file creates exactly one version before truncation

**Already held, already covered.** `files-manager.service.spec.ts` → *"snapshots before truncating an existing file to
zero bytes"* and *"snapshots before overwriting with a sample document"*, both with the ordering assertion. One hook at
`files-manager.service.ts:422` covers both `mkFile` branches (`createEmptyFile` and the `copyFileContent` sample
overwrite), which is why the count is one and not two.

### D3.4 The sync client never sees the versions directory

**Holds.** `sync/services/sync-manager.service.spec.ts` → *"never walks outside the space's files root, which is why
the versions store is invisible to sync"*.

The assertion is about the walk's **scope**, not about a filter, because there is no filter: `parseFiles` starts at
`space.realPath` (inside `files/`) and only recurses into directories it read there. `<home>/versions` is a sibling of
`<home>/files`, so it is unreachable. Same single fact as D1.4 — and the same fragility: move the store inside the
files root and WebDAV, the content indexer and desktop sync all break at once.

---

## D4 — Editor coalescing cadence

This is the one task whose stated deliverable could not be produced as written, and the reason is a finding rather
than an environment problem. Read D4.3 before tuning anything.

### D4.1 OnlyOffice — confirmed from the callback path, exhaustively

**Holds, as ADR §5 already claimed from source.** `only-office-manager.service.spec.ts` → the new
*"the complete set of statuses that version (D4)"* table.

`saveDocument` is reached from callback statuses **2** (closed with unsaved changes), **3** (save error, retried),
**6** (forcesave) and **7** (forcesave error, retried). Statuses **1** (users connect/disconnect), **4** (closed, no
changes) and **2 with `notmodified`** never save and therefore never version. There is no autosave-per-keystroke path
at all, so coalescing is expected to **rarely fire** for this editor — a document typically produces one version per
editing session, on close.

The table is exhaustive on purpose. It is the only way "the OnlyOffice cadence is known" survives an upstream sync: a
new status arm that saves shows up here as a surprise rather than as a silent extra version.

### D4.2 Collabora — the cadence, derived from Collabora's own defaults

**No live container was needed for the number, and none was available.** COOL's own `coolwsd.xml` documents its
defaults, which is a stronger source than one hand-measured session:

| Setting | Default | Meaning |
|---|---|---|
| `per_document.idlesave_duration_secs` | **30** | after 30 idle seconds, a modified document is saved |
| `per_document.autosave_duration_secs` | **300** | during continuous editing, save every 5 minutes |
| `per_document.always_save_on_exit` | `false` | no extra save on the last editor leaving |

So a PutFile can arrive as often as **every 30 seconds** of edit-then-pause, and at worst every 300 seconds of
uninterrupted typing. An operator who has tuned `coolwsd.xml` has moved these numbers, which is exactly why the
server-side rule must not assume any particular value.

`collabora-online-manager.service.spec.ts` → *"snapshots on EVERY PutFile — rate limiting is the coalescing window's
job, not the hook's"* pins the split: the hook is unconditional, and whether a version is minted is decided one layer
down by `VersioningService.isCoalesced`. Nobody should look for a rate limit in the editor, or add a second one.

### D4.3 The task's stated expectation is not achievable, and `minIntervalSeconds` is left at 60

The plan asks for: *"autosave N times in five minutes → expect **one** version (the pre-session content)"*, then
*"tune `minIntervalSeconds` from the observed cadence."* **The first half cannot be delivered by tuning the second**,
and this is a design finding, not a measurement gap.

`minIntervalSeconds` is a **rate limit**, not a session collapser. `isCoalesced` compares the newest version for
`(fileId, authorId, origin)` against *now*, so the versions minted during an editing session is
`≈ session_length / max(minIntervalSeconds, save_interval)`. Getting one version per *session* would require a window
longer than the session, and a session is unbounded — someone can leave a document open all afternoon. Concretely, at
the current default of 60 and Collabora's 30-second idle saves, a five-minute edit-and-pause session mints up to
**five** versions, not one.

The obvious fix — raise the default to 300 to match `autosave_duration_secs` — is **not applied**, because
`minIntervalSeconds` is global (ADR §5) and the same value governs `web-patch`, `webdav`, `nc-chunked` and `sync`. At
300 a user pressing Save four times in five minutes in the web text editor would get **one** version and no way back
to the intermediate states. That is a product trade-off between two different kinds of writer, not a mechanical
tuning, so shipping it as a side effect of D4 would be the wrong call.

**Recommendation, for the maintainer to accept or reject:** make the window **per-origin** — 300 s for `collabora` and
`onlyoffice`, 60 s for the interactive origins — and keep a single scalar as the fallback. That needs an ADR §5
amendment, so it is recorded here rather than done here. The default stays **60**.

> **RESOLVED.** The maintainer accepted the per-origin window; it shipped as **ADR §5.1** and
> `FilesVersionsOriginIntervalsConfig`. The scalar `minIntervalSeconds` stays 60 as the fallback for interactive
> origins, and `collabora` / `onlyoffice` default to 300. The paragraph above is left as the record of the reasoning.
> The decisive argument turned out to be the one about `maxVersionsPerFile`, not the row count: at 60 seconds an hour
> of active editing mints ~10 versions and evicts about half of that file's genuinely distinct older revisions.

**What is still owed, and is a soak item either way.** ADR §19 already requires a soak against real Collabora and
OnlyOffice before the flag defaults on. The empirical confirmation of D4.1/D4.2 belongs to that soak. Recipe, for
whoever runs it:

1. Enable an editor in `environment/environment.yaml` (`applications.files.editors.collabora` /
   `.onlyoffice`) — both are off in the dev config — and make the container reachable from the backend.
2. Set `applications.files.versions.minIntervalSeconds: 0` for the first pass, so every PutFile mints a version and
   the raw cadence is visible in the history rather than hidden by coalescing.
3. Open a document, type, pause for >30 s, repeat for five minutes. Count rows: that count **is** the PutFile count,
   and the gaps between their `createdAt` values are the container's real cadence.
4. Then set the window to the intended value and repeat, confirming the count drops to
   `≈ 300 / minIntervalSeconds`.

Step 2 matters: with the window at its default the measurement measures the window, not the editor.

---

## 5. What Phase D leaves for whoever is next

Phase D is complete and merged: **#324** (D1), **#325** (D2), **#326** (D3/D4). `main` at that point:
**147 test files, 2124 backend tests passing**, `nest build` clean, backend lint clean. Feature flag still **off**.

### Open decisions — both were resolved after this document was first written

1. ~~**The coalescing window (D4.3).**~~ **Resolved** — the per-origin window shipped as ADR §5.1. See D4.3.
2. ~~**A minimal Activity OCS endpoint (D2.5).**~~ **Resolved** — shipped, backed by the existing sync-event log and
   deliberately still unadvertised in capabilities. See D2.5's RESOLVED note and D2.6.

### Owed work, already scoped elsewhere

- **Phase E**, cases E2E-1..20 in the plan's §5. **15 of the 20 are done** — see
  [`2026-07-27-file-versioning-phase-e-notes.md`](2026-07-27-file-versioning-phase-e-notes.md) for what each covers,
  the four environment facts the harness encodes, and the five cases still owed.
- **The ADR §19 soak** against real Collabora, OnlyOffice and NC clients, before the flag defaults on. D4.2's recipe
  belongs to it.
- ~~**Two release blockers from ADR §7/§19**~~ **Both written.** The quota wording is the `2.4.4-custom.1` CHANGELOG
  entry (which is what `release.yml` uses as the GitHub Release body), and the backup requirement is
  [`docs/backup-and-restore.md`](../backup-and-restore.md).
- **A third blocker surfaced while wiring those up: the `RELEASE_GITHUB_TOKEN` secret does not exist.** `release.yml`
  validates it and fails without it, so a tag push today would build and publish the container image
  (`build-image.yml` uses the default `GITHUB_TOKEN`) while producing **no** GitHub Release — a half-completed release.
  Creating the PAT is a maintainer action; nothing in the repo can substitute for it.

### Two corrections this phase made to the handoff

Both are in D2 and both would have cost a debugging cycle:

- The capability key is **`files.versioning`**, not a top-level `files_versions` block (D2.0).
- **`FileRowEnsurer` is not needed** in the NC versions controller; it is already applied one layer up, in the PROPFIND
  that mints the fileId a client arrives with (D2.3).
