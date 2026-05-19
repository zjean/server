# NC mobile: serve a `recommended files` carousel for the iOS Files tab

**Date:** 2026-05-03
**Branch:** `feat/nc-recommendations`
**Scope:** Single new OCS endpoint that surfaces existing Sync-in recents data in the shape Nextcloud's `RecommendedFilesController` produces, so stock NC iOS shows its "Recommended files" carousel at the top of the Files tab.

## Why

The NC iOS app (≥ 5.x, server major ≥ 30) renders a "Recommended files" carousel at the top of the Files tab, populated by `GET /ocs/v2.php/apps/files/api/v1/recommendations`. Sync-in does not implement that endpoint, so the carousel stays blank. The user-facing effect is a missing affordance NC users expect.

Sync-in already maintains a per-user, 14-day rolling list of recent files (`files_recents` table, `FilesRecents` service, fed during PROPFIND traversal). Mapping that to NC's recommendations response is mechanical — no schema change, no background job, no protocol work beyond a single OCS handler.

## Goals

- NC iOS shows the carousel populated with the user's recently modified files.
- No regressions in classic UI, v2, or other NC compat surfaces.
- Cheap to extend later when we add WebDAV `SEARCH` for the Recent filter view (see non-goals).

## Non-goals

- **WebDAV `SEARCH` for the Recent filter** — NC iOS uses a `SEARCH` HTTP method against `/remote.php/dav/` for the Recent tab, which requires a basic-search XML parser we don't have. Deferred until we can capture an iOS network log of an actual SEARCH request and design against real evidence (see "Operate, observe, iterate" below).
- **Reasons beyond `"recent"`** — NC supports `recent`, `favorite`, `shared`. We only have recent data; favorites/shared are deferred.
- **Capability flag** — upstream NC's `apps/files/lib/Capabilities.php` doesn't gate this endpoint behind a flag (it's gated on server `version.major >= 30`, which we already pass with our advertised `33.0.0-sync-in`). Adding a non-standard flag risks confusing other clients. If iOS observably fails to call the endpoint after deploy, add a flag in a follow-up.

## Endpoint contract

```
GET /ocs/v2.php/apps/files/api/v1/recommendations[?limit=N]
```

- **Auth:** `NcBasicAuthGuard` (Basic Auth via app password) + `@AuthTokenSkip()` — same posture as every other `ocs/v2.php/apps/files/...` route in the compat layer. Sync-in JWTs are not accepted on NC routes.
- **Headers:** Caller must accept JSON (`Accept: application/json`, `*/*`, or empty); explicit XML-only requests are rejected with 406, mirroring `nc-ocs.controller.ts`.
- **Query:** `limit` — clamped to `[1, 50]`; default `10`; non-numeric or negative → default.
- **Empty result:** valid; returns `data.entries: []` with HTTP 200. Never 404 — an empty carousel is a valid state, and 404 would surface as a generic error in iOS.

### Response shape

```json
{
  "ocs": {
    "meta": { "status": "ok", "statuscode": 200, "message": "" },
    "data": {
      "entries": [
        {
          "id": 12345,
          "timestamp": 1714742400,
          "name": "report.docx",
          "directory": "/Documents",
          "extension": "docx",
          "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "hasPreview": true,
          "reason": "recent"
        }
      ]
    }
  }
}
```

### Field mapping (`FileRecent` → entry)

| NC field    | Source                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `id`        | `rec.id` (already a real Sync-in DB file id post-#126)                 |
| `timestamp` | `Math.floor(rec.mtime / 1000)` — NC uses Unix seconds; Sync-in stores ms |
| `name`      | basename of `rec.path`                                                  |
| `directory` | dirname of `rec.path` (root-level files → `"/"`)                       |
| `extension` | last segment after final `.` in `name`; `""` when none. NC convention is the last extension only — `archive.tar.gz` → `"gz"` |
| `mimeType`  | `rec.mime` translated from Sync-in's `image-jpeg` form to standard `image/jpeg` (single dash → slash) |
| `hasPreview`| `ncHasPreview(rec.mime)` — same predicate that drives `<nc:has-preview>` in PROPFIND, guarantees the carousel agrees with the file list |
| `reason`    | always `"recent"` — we only track one signal                           |

## Implementation

### Files

**New: `backend/src/applications/custom-mobile-compat/utils/nc-recommendation-entry.ts`**
- Pure function `toRecommendationEntry(rec: FileRecent): NcRecommendationEntry`.
- Helpers (kept private): `splitPath(path)`, `extractExtension(name)`, `ncMimeType(mime)`.
- Exported `NcRecommendationEntry` interface.

**New: `backend/src/applications/custom-mobile-compat/controllers/nc-recommendations.controller.ts`**
- `@Controller() @AuthTokenSkip()` — class-level, mirrors `NcOcsController`.
- Single handler `@Get('ocs/v2.php/apps/files/api/v1/recommendations') @UseGuards(NcBasicAuthGuard)`.
- Parse + clamp `limit`. Call `filesRecents.getRecents(user, limit)`. Map and wrap.

**Modify: `backend/src/applications/custom-mobile-compat/custom-mobile-compat.module.ts`**
- Register new controller. `FilesModule` (which exports `FilesRecents`) is already imported, so DI works without further wiring.

### Tests

**`nc-recommendation-entry.spec.ts` — pure unit tests:**
- `path: "/Documents/report.docx"` → `directory: "/Documents", name: "report.docx", extension: "docx"`
- Root-level: `path: "/photo.jpg"` → `directory: "/", extension: "jpg"`
- No extension: `path: "/notes/README"` → `extension: ""`
- Multi-dot: `archive.tar.gz` → `extension: "gz"`
- `hasPreview: true` for `image-jpeg`, `image/png`; `false` for `application/zip`, `null`, `undefined`
- `mimeType` translation: `image-jpeg` → `image/jpeg`; standard mimes pass through unchanged
- `timestamp` = `Math.floor(mtime_ms / 1000)`

**`nc-recommendations.controller.spec.ts` — Nest test module pattern, mirrors `nc-ocs.controller.spec.ts`:**
- 401 without `Authorization: Basic …` (guard rejects).
- Empty service result → `entries: []`, HTTP 200, OCS envelope shape.
- `?limit=5` → `FilesRecents.getRecents` called with 5.
- `?limit=99` → clamped to 50.
- `?limit=-1` and `?limit=foo` → falls back to 10.
- `Accept: application/xml` → 406 (XML rejected via `requireJson`).
- Authenticated user is forwarded to `FilesRecents.getRecents` (asserts the `req.user` plumbing).

### Manual verification before merge

1. Build, start backend.
2. `curl -u user:apppassword 'https://host/ocs/v2.php/apps/files/api/v1/recommendations?limit=10' -H 'OCS-APIRequest: true' -H 'Accept: application/json' | jq` — confirm shape matches the contract above.
3. Deploy to staging, force-quit + reopen iOS app, observe carousel at top of Files tab.
4. If empty after deploy: capture iOS network log (Charles / mitmproxy), file follow-up — likely either a missing capability flag or a different endpoint path the iOS version actually hits.

## Operate, observe, iterate

The "Recent" filter view in the iOS Files tab is intentionally out of scope here. NC iOS uses WebDAV `SEARCH` for that view, which we don't implement. Once this PR is live, the next deploy gives us a real iOS network log we can use to design `SEARCH` support against actual request bodies — much more reliable than guessing the basic-search XML grammar from memory.

## Risk

- **Endpoint goes live but carousel stays empty** — likely a capability gate I haven't seen. One-line follow-up.
- **NC iOS expects an extra field** — additive; one-line follow-up.
- **Performance** — `FilesRecents.getRecents` already runs in production (classic UI uses it) with `limit` indexed. No new query load.
- **Security** — endpoint is per-user; `getRecents` filters by `userId`, `spaceIds`, `shareIds`. No cross-user leak path.

## Versioning

Patch-level customization, no schema change → next release is `2.2.1-custom.<n+1>`.
