# NC sync-collection — v2 follow-ups

Date: 2026-04-26
Status of v1 (4 phases): **shipped** as of PR #95.

> **Status (2026-05-28):** Follow-up #1 and the write-side of #2 are shipped; #2's read-side as originally framed turned out to be a non-issue once the NC URL → single-space resolver was confirmed. Only #3 (low-priority subtree filter) remains genuinely open. See "Status check, 2026-05-28" section below for the audit.

| PR | What |
|---|---|
| #88 | Original WebDAV REPORT sync-collection design doc |
| #89 | Design pivot — subscribe to FileEvent so web/server-side mutations log too |
| #92 | Phase 1 — `nc_sync_events` schema + `NcSyncLogService` (FileEvent → DB) |
| #94 | Phase 2 — REPORT verb controller + service + 1020 tests green |
| #95 | Phase 4 — `dav.sync-token: true` capability flag flip |

(Phase 3 — "wire hooks into existing verb handlers" — was deliberately skipped: the FileEvent subscription in phase 1 captures all the verbs phase 3 would have hooked, plus web-UI / OnlyOffice / server-side. Removed from the plan in PR #89.)

## What works today

- NC iOS (and Android) clients reading `/ocs/v2.php/cloud/capabilities` see `dav.sync-token: true` and switch to REPORT sync-collection on `/remote.php/dav/files/<user>` instead of PROPFIND-polling.
- Every mutation that emits Sync-in's global `FileEvent` (PUT / DELETE / MOVE / COPY / MKCOL via web, mobile, OnlyOffice, Collabora, server-side jobs) writes a row to `nc_sync_events`.
- REPORT returns 207 Multi-Status: one `<d:response>` per change, deduped by `(spaceAlias, path)`, plus a trailing `<d:sync-token>`. Token older than `minKeptToken` → 412 Precondition Failed → client wipes its cache and full-syncs.

## v2 follow-ups (in priority order)

### 1. DB id resolution for create/update events — `medium`

**Problem.** When a REPORT response carries a create/update event for a path with no existing `files`-table row, the prop block uses the inode-derived placeholder via `ncFileId(getProps().id)`. The next full PROPFIND on the parent dir (which goes through `spacesBrowser.browse`) returns the *real* DB id. NC iOS may treat these as two different files and end up with a duplicate cache entry until the next manual full sync reconciles.

**Why it might not be visible.** PRs #84 / #85 already insert a DB row immediately after PUT for files uploaded via the NC mobile-compat path. So for the typical NC-iOS-uploads-then-checks-back case, the row exists and PROPFIND would have stamped a real id — but our REPORT handler doesn't query that row, it stats fresh. The drift is real but limited to: web UI uploads, OnlyOffice saves, server-side cron writes, anything that goes through `webdav.put()` without our DB-row hook (which ensures the row exists, but our REPORT path doesn't read it).

**Fix sketch.** In `NcSyncReportService.buildEventResponse`:

1. After `getProps`, look up the real DB id:
   - personal space → `spacesQueries.getOrCreateUserFile(user.id, props)` (idempotent — returns existing id when it matches)
   - other spaces → `spacesQueries.getOrCreateSpaceFile(0, props, dbFileFromSpace(user.id, space))`
2. Replace `props.id` with the returned DB id.
3. Construct `WebDAVFile` from the patched props.

Cost: one extra DB round-trip per create/update event in a REPORT response. For typical NC iOS sync responses (a handful of events), negligible.

**Validate by.** Upload a file via the web UI → REPORT from iOS → record the `<oc:fileid>`. Then full PROPFIND from iOS → confirm the same `<oc:fileid>` for the same path. Today they may differ.

### 2. Cross-space sync (shared spaces appear at user-root) — `medium`

**Problem.** REPORT on `/remote.php/dav/files/<user>/` only returns events for the spaceAlias the URL resolves to (`personal`, in the typical case). Events from shared spaces — even when those shares are mounted *inside* the user's home view — are filtered out. NC iOS expects everything visible at `/files/<user>/...` to be REPORT-able from a single sync-token.

**Why it's deferred.** Mapping internal `(spaceAlias, eventPath)` back to a NC-style `/files/<user>/<path>` href requires reversing the path resolver: shared mounts appear under a per-share prefix (e.g. `/files/<user>/Marketing/...` for a share aliased `marketing`), so an event with `(spaceAlias: marketing, path: 'budget.xlsx')` needs to emit href `/files/<user>/Marketing/budget.xlsx`. There's no existing reverse-resolver helper.

**Fix sketch.**

1. Extend `NcPathResolverService` with a `reverseResolveToUserHomePath(user, spaceAlias, eventPath)` method that queries the user's mounted shares and produces the user-home-view path.
2. In `NcSyncReportService.respond`, drop the spaceAlias filter from the `since` call when the URL resolves to the user's home root; filter by `ownerId` only.
3. For each event, build the href from the reverse-resolver output rather than `${user.login}/${event.path}`.

Edge case: the same file accessible via multiple shares would produce duplicate hrefs. Either dedupe at REPORT-build time, or accept the duplicate (NC iOS handles it gracefully).

**Validate by.** Add a shared space, mount it for the test user, modify a file in the shared space via the web UI, REPORT from iOS → expect the change to surface.

### 3. Subtree filtering (REPORT on a subfolder) — `low`

**Problem.** RFC 6578 §3.1 expects sync-collection to be anchored at the URL the REPORT was sent to. If iOS REPORTs `/files/<user>/Documents/`, only events under `Documents/` should surface. Current implementation returns the whole space's events regardless of the URL path.

**Why it's low priority.** NC iOS REPORTs at the user-root in practice — never at subfolders. Until that changes, the bug is invisible.

**Fix sketch.** In `NcSyncReportService.respond`, derive the URL's relative path within the space (`space.relativeUrl` is the space-root-relative path, with `'.'` meaning "at root"). Filter events whose `path` doesn't start with that prefix.

### 4. iOS push notifications — `out of scope, separately scoped`

Real NC also emits OCS notifications for changes — sync-collection alone gets us most of the UX win at lower cost (push requires an APNs cert + an app-side notification service extension). Out of scope for v1 and v2.

## Phase 4 manual smoke results

(Fill in after deploy + iOS test. Smoke checklist below.)

- [ ] `/ocs/v2.php/cloud/capabilities` returns `data.capabilities.dav.sync-token === true`.
- [ ] First REPORT from a fresh iOS install completes (initial sync via empty `<d:sync-token>`); files appear.
- [ ] Upload via web UI → file appears on iOS within ~2s without manual refresh.
- [ ] Delete via web UI → file disappears from iOS within ~2s.
- [ ] Move file across folders via web UI → iOS reflects the move.
- [ ] Edit file in OnlyOffice (web) → iOS shows new mtime within ~2s.
- [ ] Token older than prune horizon (manual: SQL-trim `nc_sync_events`, then have iOS REPORT with stale token) → iOS recovers via full re-sync.

## Pickup notes for next session

If smoke surfaces issues:

- **Duplicate cache entries on iOS** → likely follow-up #1 (DB id resolution). Confirm by comparing `<oc:fileid>` between a REPORT response and a fresh PROPFIND.
- **Shared-space changes invisible** → follow-up #2 (cross-space scope).
- **Some changes never surface** → check `nc_sync_events` table directly. Empty rows for a known mutation means the FileEvent subscription missed it; an inserted row that REPORT doesn't return means a query/dedup/href bug.

If smoke is clean, the sync-collection feature is done for the foreseeable. The capability flag stays on, and we revisit only if NC iOS protocol changes (sync-collection has been stable since 2010).

## Status check, 2026-05-28

Re-audited the three follow-ups against the current source tree.

### #1 — DB id resolution: **shipped** ✓

- **PR #97** (`0422bbc9`, 2026-04-26): added a lookup-only resolver via `FilesQueries.getSpaceFileId` after `getProps`. Replaced the inode placeholder with the real DB id when a row already existed.
- **PR #126** (`3f28a22e`): superseded the lookup-only fix with `NcFileRowEnsurer.ensure(...)` — the same get-or-create helper PROPFIND uses. Now REPORT also *creates* a DB row on miss, so ids stay stable across REPORT and PROPFIND even for pure-web-UI / OnlyOffice uploads that previously lacked a row.

Current code: [`nc-sync-report.service.ts:204-211`](../../backend/src/applications/custom-mobile-compat/services/nc-sync-report.service.ts). Validation steps from the original plan are obsolete — PROPFIND and REPORT now share the ensurer, so the inode-vs-DB drift is structurally impossible.

### #2 — Cross-space sync: **not applicable as originally framed; write-side shipped** ✓

The plan assumed shared spaces are visible at `/remote.php/dav/files/<user>/` (the NC convention upstream — shared mounts merged into the user's home view). **Sync-in doesn't model the NC URL root that way.** [`NcPathResolverService.resolve`](../../backend/src/applications/custom-mobile-compat/services/nc-path-resolver.service.ts:47-80) maps the NC URL root to **one** space — personal by default, optionally redirected to `space:<alias>` via `user.settings.mobileHome`. There is no merged home view; the URL points at a single space at a time.

Consequence: the REPORT handler's `spaceAlias: space.alias` filter ([`nc-sync-report.service.ts:92`](../../backend/src/applications/custom-mobile-compat/services/nc-sync-report.service.ts:92)) is *correct*, not a bug. Events for spaces the URL doesn't resolve to *should* be excluded. Dropping the filter as the plan sketched would surface events from spaces the iOS/Android client can't see at this URL.

What the plan really cared about — "co-members of a shared space see each other's edits" — is handled on the *write* side by **PR #223** (`7e5f0185`, 2026-05-20). [`NcSyncLogService.handleFileEvent`](../../backend/src/applications/custom-mobile-compat/services/nc-sync-log.service.ts:147) now resolves the visible-userId set (actor + direct members + users in member groups) and appends one row per viewer. A user with `mobileHome = space:marketing` whose REPORT URL resolves to the marketing space will see edits made by every co-member, because the event log carries a row tagged with their `ownerId` + `marketing` alias.

No reverse-resolver / cross-space href stitching needed. **Closed.**

### #3 — Subtree filtering: **still open, low impact** 🔴

[`nc-sync-report.service.ts:respond`](../../backend/src/applications/custom-mobile-compat/services/nc-sync-report.service.ts:57-133) does not filter events by `space.relativeUrl`. A REPORT to `/files/<user>/Documents/` will return every event in the resolved space, not just events under `Documents/`. NC iOS still only REPORTs at user-root in practice, so the bug is dormant.

Fix sketch unchanged: in `respond`, after resolving `space`, derive the in-space prefix from `space.relativeUrl` (which is `'.'` for the space root). For any non-`.` value, filter `events` to those whose `path` matches the prefix or its descendants. Two-line change, plus a unit test.

### Net remaining work for this plan

Just #3. Trivial — can be folded into the next NC-compat PR or kept dormant. The plan's "Phase 4 manual smoke" checklist is still worth running once after the next deploy as a sanity check on the full v1 + v2.1 stack.
