# NC mobile-compat — U1/U2/U3 + #6 on-device verification guide

**Date:** 2026-05-28
**Predecessor:** [`2026-05-02-nc-mobile-compat-audit-followups.md`](2026-05-02-nc-mobile-compat-audit-followups.md) → "Adversarial unknowns" + #6 sections.
**Server-side changes tracked here:** branch `fix/nc-compat-u1-u2-u3-verification`.

This doc is the testing companion to the server-side changes that ship:

- **U1 mitigation** — `OC-Total-Length` optional on chunked-upload assembly.
- **U2/U3 instrumentation** — log lines on the OnlyOffice / directEditing candidate paths and on every 406 from `requireJson`.
- **#6 fix** — PROPFIND on the upload staging dir now enumerates already-uploaded chunks so Android can resume from `nextByte` instead of restarting at byte 0.

The branch can merge before any device session — none of the changes regress existing iOS/Android behavior; they only relax one over-strict check (U1), add log lines (U2, U3), and enrich one previously-minimal PROPFIND response (#6).

After merge, run the test steps below against a real iPhone + Android device pointed at a Sync-in instance running the merged build. Record findings inline in the **Results** sections so the next maintainer (or Claude session) can pick up from a known state.

## Prerequisites

- Sync-in dev/staging instance built from `main` after this PR lands.
- One iPhone + one Android device — physical, not simulator — with the stock Nextcloud client (latest App Store / Play Store version) configured to point at the instance.
- A test user with at least one of each: `.docx`, `.xlsx`, `.txt`, plus a sample folder for large-file uploads.
- SSH access to the server so you can `tail -f` the backend log, or a `kubectl logs -f` equivalent for whatever runtime hosts the build.
- Optional but recommended: mitmproxy or Charles configured as the device's HTTP proxy. For U2/U3 the server logs are sufficient; for U1 a proxy makes it easier to see the exact headers Android sends on the assembly MOVE.

## Locating the log lines

All three instrumentations emit through Nest's `Logger`. Grep your tail for these tags:

| Tag | Source | Meaning |
|---|---|---|
| `assembleAndMove` | `NcUploadsController` | OC-Total-Length absent on a chunked-upload assembly MOVE (U1) |
| `directEditing.info` | `NcDirectEditingController` | iOS hit `/ocs/v2.php/apps/files/api/v1/directEditing` (catalog read) |
| `directEditing.open` | `NcDirectEditingController` | iOS hit `/ocs/.../directEditing/open` to start an edit session (U2) |
| `onlyoffice.config` | `NcOnlyOfficeController` | Client hit `/index.php/apps/onlyoffice/config` (the connector, U2) |
| `requireJson` | `NcResponseService` | Any OCS endpoint rejected with 406 because the client sent `Accept: application/xml` (U3) |

(#6 doesn't get its own tag — the PROPFIND handler doesn't log on every probe. Inspect the response via the device-side proxy or by curl'ing the staging dir directly while a partial upload is in progress.)

Quick grep: `tail -f backend.log | grep -E 'assembleAndMove|directEditing\.|onlyoffice\.config|requireJson'`.

## U1 — Android chunked-upload `OC-Total-Length`

**Hypothesis:** Android's `ChunkedFileUploadRemoteOperation` may omit `OC-Total-Length` on the assembly MOVE request. The pre-merge code 400'd in that case → silently broke every Android big-file upload.

**Mitigation already shipped on this branch:** the header is now optional. When absent, the upload still proceeds (each chunk is Content-Length-verified at PUT time, so end-to-end integrity is preserved). The server logs a warning so we can tell whether Android actually omits it in practice.

### Test steps

1. On Android, find or create a file ≥ 100 MB (a video clip works; a generated random file via the Files app's import flow works too).
2. With the device on Wi-Fi (or toggle airplane mode mid-upload to force the chunked path even on fast connections), upload the file via the Files app to Sync-in.
3. Wait for the upload to finish. Confirm in the Sync-in web UI that the file is present and matches the source size to the byte.
4. **Repeat with iOS** — upload the same file from a recent iPhone. iOS should always send the header (the audit was confident iOS is fine).

### What to look for

- **Per-chunk PUTs succeed** (HTTP 201 each). If you see 400s with "Content-Length" in the message, the per-chunk integrity check caught a partial upload — that's the existing safety net working, unrelated to U1.
- **Assembly MOVE succeeds** (HTTP 201). The file appears in the destination directory at full size.
- Grep for `assembleAndMove` log lines on the server. Two possible outcomes:
  - **No log line during the Android upload** → Android sent `OC-Total-Length`. U1 hypothesis was wrong; current behavior is fine. *Action: remove the optional-header path and restore the strict 400 check, since we now know all clients send it.*
  - **`OC-Total-Length absent` warning during the Android upload** → U1 hypothesis confirmed. *Action: keep the optional-header behavior. Add a unit/integration test for the absent-header path. Update audit followups doc to mark #6 (chunked resume) as the remaining Android upload concern — separate problem from this one.*

### Results

_Fill in below after the test session._

- iOS large-file upload: [pass / fail], assembleAndMove log line: [present / absent]
- Android large-file upload: [pass / fail], assembleAndMove log line: [present / absent]
- Decision: [tighten header back to required / keep as optional]

## #6 — Android chunked-upload resume

**Bug (confirmed pre-merge):** the upload-dir PROPFIND only emitted the collection itself — no per-chunk responses. Android's `ChunkedFileUploadRemoteOperation` reads `<d:getcontentlength>` across the listing to compute `nextByte`; without per-chunk entries it always sees zero bytes already uploaded → restarts from byte 0 on every retry.

**Fix shipped:** `rootHandler`'s PROPFIND case now reads the Depth header. At depth=1/infinity (Android's actual probe), it calls `staging.listChunksWithStats(userId, uploadId)` and emits a `<d:response>` per chunk with `<d:getcontentlength>` + `<d:getlastmodified>` + empty `<d:resourcetype/>` (file, not collection). Depth=0 keeps the old collection-only shape.

### Test steps

1. On Android, pick a file ≥ 50 MB (the bigger the better — gives more time to interrupt).
2. Start uploading to Sync-in via the Files app on Wi-Fi.
3. When the upload progress bar shows ~30–60% complete, **kill the network** by toggling airplane mode on the device.
4. Wait a few seconds, then turn airplane mode off so the device reconnects. The Files app should auto-retry the upload.
5. Watch the Files app's upload speed indicator and the server's network monitor (or `iftop` on the server). On retry, Android should **resume from the existing offset**, not restart from 0. The total bytes pushed over the wire after the second attempt should be roughly the size of the *remaining* unsent bytes — not the whole file again.
6. After completion, verify the assembled file matches the source byte-for-byte (compute a checksum on both sides).

### What to look for

- **PROPFIND traffic in mitmproxy or server access logs:** after retry, Android sends `PROPFIND /remote.php/dav/uploads/<user>/<uploadId>` with `Depth: 1`. The response should be a 207 multistatus containing one `<d:response>` per chunk already on disk, each with a positive `<d:getcontentlength>`.
- **Resume offset behavior:** if the upload still restarts at byte 0, capture the PROPFIND response body — if it shows the chunks correctly but Android ignores them, the parsing on Android's side is the next thing to investigate (unlikely; this is well-trodden code in `WebdavEntry.kt`).

If you can't easily interrupt mid-upload (devices are fast), you can simulate by manually `kill -9`-ing the connection on the server side, or by using a flaky-network simulator like [`pumba`](https://github.com/alexei-led/pumba) for Docker.

### Results

**The on-device session was never run** — these fields are still open, and the checklist above is still the recipe:

- Upload size: [____ MB]
- First-attempt progress before interrupt: [__%]
- Second-attempt total bytes pushed: [____ MB] (expected: roughly `size × (1 - first-attempt%)`)
- Final file checksum matches source: [yes / no]

**What IS verified, as of 2026-07-30:** the server side of the same scenario, automatically, in
`backend/src/applications/custom-mobile-compat/controllers/nc-chunked-upload.e2e-spec.ts`. It stages two of three
chunks, probes with `Depth: 1`, computes `nextByte` from the response exactly as `ChunkedFileUploadRemoteOperation`
does — summing the children and excluding the collection — and requires that offset to be the byte count really on
disk. Then it resumes, assembles, and compares byte for byte. Four supporting cases pin numeric (not lexical) chunk
ordering, the depth-0 collection-only shape, the `OC-Total-Length` mismatch refusal leaving nothing at the destination,
and staging-dir cleanup after the MOVE.

That covers "the offset we report is true and assembly from it is correct", which is what the original bug got wrong.
It does **not** cover "Android believes us" — the two are different claims, and only a device can settle the second.
- PROPFIND response includes per-chunk `<d:getcontentlength>` entries: [yes / no / not captured]

## U2 — iOS OnlyOffice trigger path

**Hypothesis:** Unclear whether NextcloudKit's "Edit" affordance on a `.docx`/`.xlsx`/`.pptx` hits our OnlyOffice connector (`/index.php/apps/onlyoffice/config`) or routes through the OCS direct-editing path (`/ocs/v2.php/apps/files/api/v1/directEditing/open`). The directEditing catalog this fork advertises currently only declares a `Nextcloud Text` editor — no OnlyOffice entry — so if iOS uses the OCS path, the Edit button won't appear on OnlyOffice-handled files even though OnlyOffice itself is configured and working in the web UI.

> **RESOLVED 2026-07-30 as Path B, from source — no device session needed. See the Results section below.**

**No mitigation shipped yet.** Both candidate paths log on entry; we use the logs to learn which one iOS chooses, then implement the right fix surgically.

### Test steps

1. Confirm OnlyOffice is enabled for this Sync-in instance (`applications.files.onlyoffice.enabled = true` + a working document server). Verify by editing a `.docx` in the Sync-in web UI — the OnlyOffice editor should open.
2. From a fresh iOS session (force-quit the Nextcloud app first to clear any cached catalogs):
   - Open a `.docx` in the iOS Files app.
   - Tap the file's "..." menu / Edit button.
   - Observe: does iOS offer an OnlyOffice / "Edit with Documents" option? Does the Edit button do anything at all on `.docx`?
3. Repeat for `.xlsx` and `.pptx`.
4. Repeat for `.txt` (which is in the Nextcloud Text editor catalog — should work; serves as a positive control).

### What to look for

| Tap "Edit" on… | Server log expected | Interpretation |
|---|---|---|
| `.txt` | `directEditing.info` (catalog read) followed by `directEditing.open editorId=text path=…` | Positive control — Nextcloud Text path works. |
| `.docx` | `onlyoffice.config fileId=…` only, no `directEditing.open` | **Path A — connector.** No further action needed; OnlyOffice on iOS works via the existing connector. |
| `.docx` | `directEditing.open editorId=onlyoffice path=…` and **no** `onlyoffice.config` | **Path B — directEditing.** iOS expects an OnlyOffice entry in the directEditing catalog. *Action: add an `onlyoffice` editor entry to `NcDirectEditingService.listEditors()` whose `/open` response returns a URL that takes the user through the OnlyOffice connector. Likely shape: editor `id = 'onlyoffice'`, `name = 'OnlyOffice'`, mimetypes `[application/vnd.openxmlformats-officedocument.{wordprocessingml.document,spreadsheetml.sheet,presentationml.presentation}]`. Cross-reference `NextcloudKit+Editor.swift` in the upstream NextcloudKit repo to confirm the exact expected response shape.* |
| `.docx` | **Neither log line** | iOS never asked the server. Likely the iOS catalog still has a stale entry (force-quit and retry); or OnlyOffice isn't surfaced by iOS at all on this build. Sniff with mitmproxy to see what URLs the device actually hits — could be a third path nobody listed. |

If the Edit affordance never appears on `.docx` in iOS regardless of what the server logs say, the issue is iOS-side gating (the catalog the server returned doesn't satisfy iOS's "isAvailableDirectEditingEditorView" check on the file's mime + editor name pair) — see the comment block at the top of [`nc-direct-editing.service.ts`](../../backend/src/applications/custom-mobile-compat/services/nc-direct-editing.service.ts) for the gating logic.

### Results — **Path B**, settled 2026-07-30 by reading the clients (#369)

The device session was never needed, because the question has a definitive answer
in the clients' own source:

- **`nextcloud/ios`, `nextcloud/android` and `nextcloud/NextcloudKit` contain no
  reference to `apps/onlyoffice` at all.** Path A is not merely unlikely, it does
  not exist. The only office surfaces those clients implement are the
  directEditing catalog and `richdocuments`.
- iOS's `NCViewer.swift` DOCUMENTS branch calls
  `utility.editorsDirectEditing(account:contentType:)`, which reads
  `capabilities.directEditingEditors` (populated from our `/info` by
  `NextcloudKit+NCText.swift::textObtainEditorDetails`), then resolves the editor
  through `NCDirectEditorAdapter.resolve` — a registry keyed on the lowercased
  editor **id**: `text`, `onlyoffice`, `eurooffice`, `whiteboard`.
- Android matches the same way: `EditorUtils.kt` keeps
  `OFFICE_EDITOR_IDS = setOf("onlyoffice", "eurooffice")` and compares against
  `Editor.id`.

Two corrections to the hypothesis above, both of which would have misled a device
session:

- The gate is the editor **id**, not the name. The name check
  (`isAvailableDirectEditingEditorView` comparing against `"nextcloud text"` /
  `"onlyoffice"`) is an older iOS shape; current iOS gates on
  `!editors.isEmpty` and then on the id registry.
- The `/open` URL must point at **a page we serve ourselves**, not "through the
  OnlyOffice connector". Both clients load the returned URL in a plain
  WebView/WKWebView; there is no connector handshake on the client side at all.

**Follow-up action: shipped in #369** — an office entry in
`NcDirectEditingService.listEditors()` (id following the configured document
server, `onlyoffice` or `eurooffice`) plus `NcOfficeEditorController`, which
renders the document server's `api.js` into the host WebView under the same
short-lived token scheme the text editor uses.

The `onlyoffice.config` / `directEditing.*` U2 instrumentation can now be removed
(step 3 of the Cleanup section) — it was there to answer this question.

## U3 — Endpoints iOS hits with `Accept: application/xml`

**Hypothesis:** Beyond the known `getapppassword` case (covered by audit follow-up #7 separately), some other iOS code paths might also send `Accept: application/xml` to OCS endpoints. Our `NcResponseService.requireJson` returns 406 in those cases — silent breakage of whatever iOS feature was making the call.

**No mitigation shipped yet.** `requireJson` now warn-logs every 406 with the URL and Accept header so we can compile the list of XML-expecting endpoints, then decide per-endpoint whether to add an XML serializer or relax the 406.

### Test steps

1. From a fresh iOS session (force-quit first), log in to Sync-in via the standard "Login" flow on the Nextcloud iOS app.
2. After login lands you on the Files view, exercise every screen you can think of:
   - File browsing (root, a subfolder)
   - Star/unstar a file → open Favorites tab
   - Tap a file to preview → open the file
   - Edit a `.txt`, `.docx` (covers U2 too)
   - Open the side menu → Activity, Notifications, Settings, Logout (do NOT actually log out — just open the screen and back out)
   - Open the Photos / Media tab if it appears
3. **Don't forget the Advanced → Manual login flow** if it's still relevant on this build — that hits `getapppassword`, which is a known XML-expecting endpoint and gives you a positive control that `requireJson` is logging.

### What to look for

`tail -f backend.log | grep requireJson` while you click through each screen. For every 406 log line:

1. Note the URL.
2. Note the Accept header value.
3. Note which iOS screen / action triggered it.

After the session, group by URL → list of unique endpoints iOS asked for in XML.

### Results

_Fill in below after the test session. Add one row per unique URL hit with `Accept: application/xml`._

| URL | Accept header | Triggering iOS action | Severity (does iOS show a broken state, or recover silently?) |
|---|---|---|---|
| `/ocs/v2.php/core/getapppassword` | `application/xml` | Advanced → Manual login | n/a — already covered by audit follow-up #7 |
| _(add rows here)_ | | | |

### Decision per endpoint

For each unique endpoint discovered:

- **Severity HIGH** (iOS shows broken/empty state): plumb an XML serializer through `NcResponseService.xml()` for that route, OR — for OCS endpoints that already have a stable JSON shape — relax `requireJson` to a soft check that prefers JSON but returns XML if the client demands it.
- **Severity LOW** (iOS retries with JSON or silently ignores): leave the 406 in place; document as known.

## Closing the loop

Once test results are filled in:

1. Update [`2026-05-02-nc-mobile-compat-audit-followups.md`](2026-05-02-nc-mobile-compat-audit-followups.md) — strike U1/U2/U3 from the "Adversarial unknowns" section, move any newly-discovered concrete bugs into the numbered follow-ups list.
2. Open follow-up PRs as needed (per-decision actions above). Standard `fix/nc-compat-*` branch convention.
3. **Remove the instrumentation** once a follow-up PR addresses the underlying issue. The U2 log lines on `directEditing.*` + `onlyoffice.config` are deliberately verbose for one device session; leaving them in production indefinitely creates log noise. The U1 absent-header warn log can stay (it's a useful diagnostic for any future client-quirk hunt). The U3 warn log can stay for the same reason.
