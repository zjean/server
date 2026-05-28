# NC mobile-compat audit — outstanding follow-ups

**Date:** 2026-05-02
**Predecessors:** [`2026-04-23-mobile-nextcloud-compat-design.md`](2026-04-23-mobile-nextcloud-compat-design.md), [`2026-04-26-nc-sync-collection-design.md`](2026-04-26-nc-sync-collection-design.md), [`2026-04-26-nc-favorites-disabled.md`](2026-04-26-nc-favorites-disabled.md)
**Related branch:** `fix/nc-mobile-compat-audit-1`

This plan tracks the work surfaced by the 2026-05-02 cross-client gap analysis against `nextcloud/ios` (NextcloudKit) and `nextcloud/android-library`. The audit produced fifteen prioritized findings plus a small set of unknowns that need a real device to resolve. Five fixes shipped on the `audit-1` branch; this doc captures everything still outstanding.

## What just shipped (audit-1 branch)

| # | Severity | Fix | Commit subject |
|---|---|---|---|
| 1 | CRITICAL | Android sees `nc:has-preview="1"` as `false` (Boolean.valueOf), so no thumbnails ever rendered | `fix(nc): emit nc:has-preview as "true"/"false" for Android compatibility` |
| 2 | HIGH | iOS toasted "Direct editing unavailable" on every editable file open (404 on `/ocs/v2.php/apps/files/api/v1/directEditing`) | `fix(nc): stub /apps/files/api/v1/directEditing with empty editor map` |
| 3 | MEDIUM | iOS quota bar showed "0 GB of 0 GB" because PROPFIND root didn't carry `d:quota-*-bytes` | `fix(nc): emit quota-used-bytes / quota-available-bytes on PROPFIND root` |
| 4 | MEDIUM | Comments badge stayed dark — emit was on the wrong namespace + element name (`nc:has-comments` vs `oc:comments-unread`) | `fix(nc): rename nc:has-comments to oc:comments-unread` |
| 5 | CRITICAL | iOS Favorites tab spun forever — every REPORT was routed to the sync-collection parser, which 400'd on the `<oc:filter-files>` body | `fix(nc): route oc:filter-files REPORT body so iOS Favorites tab loads` |

#5 ships an **empty-result stub** for filter-files. The wire shape is correct so the tab loads cleanly; populating it with real favorited rows is blocked on schema work tracked below.

## Outstanding — schema-blocked (favorites)

The audit's #4-half and #5-half both depend on a per-user favorites column that doesn't exist on Sync-in's `files` table today.

### A. Add per-user favorite tracking

**Scope:**
- DB migration: add a `file_favorites(user_id, file_id, created_at, PRIMARY KEY (user_id, file_id))` join table (per-user star, not global). `files` doesn't model user-specific state today, so a join table is the right shape — keeps the hot-path `files` row narrow and lets us evict cleanly when a user is deleted.
- Backend write paths: PROPPATCH on `<oc:favorite>0|1` from NC clients, plus a v2 UI affordance.
- Backend read paths: subquery on PROPFIND (similar shape to `fileHasCommentsSubquerySQL` at `backend/src/applications/files/services/files-queries.service.ts:65`), plus a `listFavoriteIds(userId)` query for the filter-files REPORT.
- `nc-prop-builder.ts`: emit `oc:favorite` as `'1'`/`'0'` (NextcloudKit reads via NSString.boolValue — same convention used elsewhere in the prop block).
- `nc-sync-report.service.ts:respondFilterFiles`: replace the empty-result stub with a query against the new join table. The response shape is already identical to a PROPFIND, so once we have the path list we just iterate `buildNcPropResponse` over it.

**Why it matters:** Favorites tab + per-row star are baseline iOS expectations. The current empty tab is better than the previous spinner but still doesn't do what users expect when they tap the star.

**Risk:** Migration on the `files` row itself would have been simpler but lossy under multi-tenant deployments — the join table keeps "Alice favorited X" separate from "X exists in Alice's space." Plan around the standard Sync-in migration tooling (`backend/src/db/migrations/`).

### B. Real filter-files filtering once A lands

Trivially follows from A: replace the stub in `respondFilterFiles` with a query that:
1. Calls `listFavoriteIds(req.user.id)` for the requester.
2. For each favorited file id, resolves to a path + `WebDAVFile`, runs through `buildNcPropResponse`.
3. Honors any `<d:limit><d:nresults>` if the body carries one (NC iOS sometimes does on Favorites).

The empty-result wire shape ships in the audit-1 branch so this is purely a query swap; no client-side coordination needed.

## Outstanding — independent of schema

### 6. Android chunked-upload resume

> **Status (2026-05-28):** Fix shipped on branch `fix/nc-compat-u1-u2-u3-verification`. PROPFIND on the upload staging dir now enumerates already-uploaded chunks (one `<d:response>` per chunk with `<d:getcontentlength>` + `<d:getlastmodified>` + empty `<d:resourcetype/>`) when `Depth: 1`/infinity. Depth 0 keeps the original collection-only shape. Manual Android verification tracked in [`2026-05-28-nc-mobile-compat-u1-u2-u3-verification.md`](2026-05-28-nc-mobile-compat-u1-u2-u3-verification.md) §#6.

**Severity:** HIGH (originally audit item #3, kept on the followups list because it's larger than the audit-1 PR scope)

**Bug:** Android's `ChunkedFileUploadRemoteOperation` does `PROPFIND depth 1` against `/remote.php/dav/uploads/{user}/{uploadId}` to enumerate already-uploaded chunks (sums each `<d:getcontentlength>` to compute `nextByte`). Our handler at `backend/src/applications/custom-mobile-compat/controllers/nc-uploads.controller.ts:65-69` calls `minimalPropfindBody()` which only acknowledges the collection — no per-chunk responses. Android decides "no chunks here yet" and re-uploads the entire file from byte 0 on every retry.

iOS doesn't try to resume, so this is Android-specific.

**Fix:**
1. In `chunkHandler`'s PROPFIND case (or move into `rootHandler` if we standardize on PROPFINDing the upload dir), enumerate `staging.listChunks(user.id, uploadId)`.
2. For each chunk file, `fs.stat` to get size + mtime.
3. Emit a `<d:response>` per chunk with `<d:href>`, `<d:getcontentlength>`, `<d:getlastmodified>`, `<d:resourcetype/>` (file, not collection), plus the parent collection response.
4. Test with Android Files on a flaky network — kill after ~50% upload, restart, watch the resume happen at the right offset.

**Files:** `backend/src/applications/custom-mobile-compat/controllers/nc-uploads.controller.ts:42-78` (root handler), maybe split into a dedicated `respondUploadDirPropfind` helper.

### 7. iOS manual-login path (`/ocs/v2.php/core/getapppassword`)

**Severity:** MEDIUM (rare in practice — most users use the v2 polling flow — but breaks the fallback)

**Bug:** Users who pick "Advanced > Manual" on the iOS login screen trigger NextcloudKit's `getAppPassword` (`NextcloudKit+Login.swift:22-58`). This `GET /ocs/v2.php/core/getapppassword` with Basic Auth expects an XML envelope `<ocs><data><apppassword>…</apppassword></data></ocs>`. We have only `DELETE /ocs/v2.php/core/apppassword` (`nc-ocs.controller.ts:80-99`) — note the `get` prefix difference and the XML-vs-JSON divergence.

**Fix:**
1. Add `GET /ocs/v2.php/core/getapppassword` to `NcOcsController`.
2. Mint a new MOBILE_NC app-password via `UsersManager.createAppPassword(req.user, 'Mobile NC (manual)', AUTH_SCOPE.MOBILE_NC)` — same path the v2 polling flow takes.
3. Return XML, not JSON: NextcloudKit parses with SwiftyXMLParser. Reuse the `XMLBuilder` we already use for PROPFIND.
4. Test by configuring the iOS app's Advanced > Manual login against a dev instance.

**Files:** `backend/src/applications/custom-mobile-compat/controllers/nc-ocs.controller.ts`, plus an XML render helper next to `NcResponseService.json`.

### 8. Lock UI capability + missing lock-time/lock-timeout props

**Severity:** LOW (lock-on-edit is rarely used; most files never enter a locked state)

**State today:** `nc-prop-builder.ts:138-147` emits `nc:lock`, `nc:lock-owner-type`, `nc:lock-owner`, `nc:lock-owner-displayname`, `nc:lock-owner-editor` — but capabilities don't advertise `files.locking`, and `nc:lock-time`/`nc:lock-timeout` aren't emitted. iOS won't show the lock UI at all without the capability flag, so we're paying the cost of emitting per-file lock props while no client renders them.

**Two paths:**
- **Path X (do less):** drop the `nc:lock-*` emit branch in `buildLockProps()` since nothing reads it. Smaller surface, less to maintain.
- **Path Y (do more):** advertise `files.locking: '1.0'` in capabilities, plumb `lock.expiresAt` (if/when Sync-in's `FileLockProps` carries one) onto `nc:lock-time` and `nc:lock-timeout`. Lets iOS render the "locked by … expires in X" sheet.

Recommend Path X for now — simpler, and lock-on-edit hasn't been requested.

**Files:** `backend/src/applications/custom-mobile-compat/utils/nc-prop-builder.ts`, `backend/src/applications/custom-mobile-compat/constants/capabilities.ts`.

### 9. `dav.bulkupload: '1.0'` advertised but no endpoint

**Severity:** LOW

**Bug:** `capabilities.ts:74` includes `bulkupload: '1.0'`. Android may try `/remote.php/dav/bulk` based on this capability and fall back to one-by-one uploads on the resulting 404 — wastes a round-trip and slows small-batch uploads.

**Fix:** Remove the line. One-line change. Also worth checking whether iOS exercises the bulk endpoint (NCKit doesn't appear to from the audit — not seen in `+Upload.swift` — but worth a sniff).

**Files:** `backend/src/applications/custom-mobile-compat/constants/capabilities.ts:74`.

### 10. PROPFIND on missing path returns 400 instead of 404

**Severity:** LOW

**Bug:** `nc-dav.controller.ts:131-136` catches `spaceEnv` errors and throws `BAD_REQUEST`. iOS expects 404 for missing paths and treats other 4xx as "broken account" with a generic error toast.

**Fix:** Sniff the error message (or better, switch `spacesManager.spaceEnv` to throw a typed error class). Path-not-found → 404, true validation failure → 400.

**Files:** `backend/src/applications/custom-mobile-compat/controllers/nc-dav.controller.ts:123-138`.

### 11. `nc:sharees` not emitted (Android sharee avatars)

**Severity:** LOW (and gated on sharing being enabled)

**State today:** Android's `WebdavEntry.kt:373-390 createShareeUser` reads a `<nc:sharees>` parent with `<nc:sharee><nc:id>...</nc:id><nc:display-name>...</nc:display-name><nc:type>...</nc:type></nc:sharee>` children. We don't emit it. With `files_sharing.api_enabled=false` in capabilities the share badge never lights up, so this is dormant.

**Action:** Park until [`2026-04-26-nc-favorites-disabled.md`](2026-04-26-nc-favorites-disabled.md) → sharing enablement is on the table. Add a TODO comment in `nc-prop-builder.ts` above the `oc:share-types` emit so the next person enabling sharing finds it.

### 12. OPTIONS `Allow:` header missing `SEARCH` → Android disables file search

**Severity:** LOW (one of two ways to do search; the other is unified search which we also don't have)

**Bug:** Android probes `OPTIONS /remote.php/dav/files/<user>/` and only enables the search affordance if the `Allow:` header lists `SEARCH` (`SearchRemoteOperation.java:91-95`). We don't define an OPTIONS route, so Fastify auto-replies without `SEARCH`. We also don't implement the SEARCH method — `nc-dav.controller.ts:293` falls through to 405 — so advertising it would be a lie.

**Two paths:**
- **Path X:** ship a minimal SEARCH (DAV `<d:searchrequest>` body, files-by-name only against the requester's space). Covers ~80% of what Android's UI actually does. Then add an OPTIONS handler that lists SEARCH. ~half a day.
- **Path Y:** accept that Android search is disabled. iOS users get the same blank because we also don't implement `/ocs/v2.php/search/providers/...`. Document.

Recommend Path Y for now — search isn't a stated requirement and the implementation cost is non-trivial.

### 13. Photo gallery view metadata

**Severity:** LOW (cosmetic; only matters for users who use the iOS Files Media tab)

**Missing props:** `nc:metadata-photos-{exif,gps,original_date_time,place,size}`, `nc:file-metadata-size`, `nc:file-metadata-gps`. iOS uses `nc:metadata-photos-size` (width/height) for the masonry grid + `nc:metadata-photos-original_date_time` for sort. Without them, photo cells are default-sized and sort by mtime; the EXIF detail panel is blank.

**Cost:** non-trivial because EXIF/GPS extraction needs `sharp.metadata()` or `exiftool`-style read on every PROPFIND of a photo. Either:
- Pre-compute on upload (write to a sidecar or a `file_metadata(file_id, …)` table).
- Compute lazily on PROPFIND and cache.

**Recommendation:** Park until a user explicitly asks. The Media tab works without these (just less polished).

### 14. `oc:checksums`, `oc:downloadURL`, `oc:data-fingerprint`

**Severity:** TRIVIAL — iOS reads these as raw strings, doesn't fail on absence.

**Action:** None. Document as "will not implement unless requested."

### 15. `nc:hidden`, `nc:rich-workspace`, `nc:note`, `nc:system-tags`

**Severity:** TRIVIAL — all optional UI hooks, clients tolerate absence.

**Action:** None. Tags would be a feature request (Sync-in doesn't model them).

## Adversarial unknowns — needs on-device verification

These are findings I could not resolve from source alone. Each needs a real iOS or Android device against a dev instance to confirm whether it's a bug or not.

> **In progress (2026-05-28):** Server-side mitigation (U1) + instrumentation (U2, U3) shipped on branch `fix/nc-compat-u1-u2-u3-verification`. After that lands on `main`, follow the device-test guide at [`2026-05-28-nc-mobile-compat-u1-u2-u3-verification.md`](2026-05-28-nc-mobile-compat-u1-u2-u3-verification.md). Fill in the Results sections there and use the per-item decision table to determine next steps.

### U1. Android `OC-Total-Length` on chunked MOVE

**Hypothesis:** Android may not send `OC-Total-Length` on the chunked-MOVE assembly request. NextcloudKit-Android sends it on the *non-chunked* PUT path; the chunked path uses `MoveMethod` and the audit didn't confirm whether that adds the header.

**Why it matters:** `nc-uploads.controller.ts:181-186` returns 400 if missing. If Android omits it, every Android big-file upload returns 400 → uploads broken silently for Android.

**Verification:** sniff one Android big-file upload (e.g. a 200MB photo) against the server logs / a debug proxy. Look at the request headers on the MOVE step. If `OC-Total-Length` is absent, soften the server check (compute total from staging + treat the header as optional but verified-when-present).

**Test plan:** Android Files app + 1 large file + airplane-mode toggle to force the chunked path even on Wi-Fi. Diff the request headers against iOS's to confirm.

### U2. iOS-native OnlyOffice trigger path

**Hypothesis:** Unclear whether NextcloudKit's "Edit with OnlyOffice" affordance hits our `/index.php/apps/onlyoffice/config` (the connector we have) or routes through `/ocs/v2.php/apps/files/api/v1/directEditing/open` (which we now stub with an empty editor map).

**Why it matters:** if iOS uses `directEditing/open`, our empty-map stub from audit-1 #2 silently disables OnlyOffice on iOS — worse than the toast. If iOS uses the connector path, audit-1 #2 is correct and OnlyOffice keeps working.

**Verification:** open a `.docx` from the iOS Files app, hit "Edit", inspect Charles/mitmproxy. Look for either `GET /index.php/apps/onlyoffice/config?fileId=…` (good — connector path) or `POST /directEditing/open?path=&editorId=onlyoffice` (bad — our empty map blocks).

**Mitigation if bad:** populate the directEditing response with one OnlyOffice editor entry pointing at our connector URL.

### U3. iOS `Accept` header on OCS endpoints

**Hypothesis:** Some iOS code paths might send `Accept: application/xml` on OCS calls. Our `NcResponseService.requireJson` returns 406 in that case. The audit found this in NextcloudKit's `getAppPassword` (XML-only — covered by U1's #7 fix), but other endpoints might also use XML.

**Verification:** scan an iOS session's request log for `Accept: application/xml` on any `/ocs/` URL. If found, list which endpoints and decide per-endpoint whether to return XML or relax the 406.

## Suggested ordering for the next round of work

| Order | Item | Reason |
|---|---|---|
| 1 | U1 (verify on device) | Could be hidden critical bug; quick to verify |
| 2 | U2 (verify on device) | Risk that audit-1 #2 made OnlyOffice worse — verify before any further iOS work |
| 3 | #6 — Android resume | High user-impact for Android users uploading large files |
| 4 | #9 — drop bulkupload capability | Trivial one-line cleanup |
| 5 | A + B — favorites schema + filter-files | Largest unblocked feature gap |
| 6 | #7 — manual-login XML endpoint | Restores a fallback path that's currently dead |
| 7 | #10 — 404 vs 400 | Cleanup |
| 8 | #8 — drop or fully implement lock UI | Maintenance |
| 9 | Park 11–15 | Cosmetic / blocked / TODO comments only |

## Source references

- `backend/src/applications/custom-mobile-compat/utils/nc-prop-builder.ts` — PROPFIND prop emission, audit-1 changes
- `backend/src/applications/custom-mobile-compat/services/nc-sync-report.service.ts` — REPORT handlers (sync-collection + filter-files)
- `backend/src/applications/custom-mobile-compat/controllers/nc-uploads.controller.ts` — chunked upload (item #6 lives here)
- `backend/src/applications/custom-mobile-compat/controllers/nc-ocs.controller.ts` — directEditing stub + manual-login (#7)
- `backend/src/applications/custom-mobile-compat/constants/capabilities.ts` — capability advertising (#9)

## Cross-client behavior notes — a quick reference

This came up enough during the audit that it's worth keeping handy:

| Prop / value | iOS (NextcloudKit) | Android (WebdavEntry) | Cross-client emit |
|---|---|---|---|
| Boolean as `"1"`/`"0"` | NSString.boolValue accepts | Boolean.valueOf rejects (false) | use `"true"`/`"false"` |
| Boolean as `"true"`/`"false"` | NSString.boolValue accepts | Boolean.valueOf accepts | safe |
| `nc:lock` | `.int > 0` | exact-string `"1"` | use `"1"`/`"0"` (the deliberate exception) |
| `oc:permissions` letters | `String.contains("D")` etc. | same | identical, case-sensitive |
| `oc:fileid` | string, used verbatim in URLs | string, no int parse | use String(positiveId) |
| `nc:has-preview` | NSString.boolValue | Boolean.valueOf | **`"true"`/`"false"`** (PR audit-1 #1) |
| `oc:comments-unread` | NSString.boolValue | n/a | `"1"`/`"0"` works |
| `oc:favorite` | NSString.boolValue | NSString.boolValue equivalent | `"1"`/`"0"` per audit-1 #4 follow-up |
