# Upstream changes — custom-UI impact

Merge commit: `fe0f520` (origin/upstream-main → main, 2026-04-24).

## 1. Commits reviewed

Three upstream commits came in via the merge:

- `a2f86e1` refactor(backend:files): extract `downloadFile` and centralize SSRF, content-length, and quota checks
- `325df7b` chore(deps): update — dep bumps only, no app code changes
- `ffff6bd` Update nl.json — Dutch translation polish from an upstream contributor

Only `a2f86e1` touches `backend/src/applications/files/`. The other two are out of scope for this investigation.

## 2. Wire-contract changes

**None.** The HTTP surface is unchanged:

- Endpoint: `POST /api/files/task/operation/download/:spaceId/...` (controller at `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/files.controller.ts:167`, method `downloadFromUrlAsTask`) — untouched in `a2f86e1`.
- Request body: `DownloadFileDto` = `{ url: string }` — the DTO file `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/dto/file-operations.dto.ts:23-35` was not modified by this commit. Existing validators (`@IsUrl` restricted to `http`/`https`) are unchanged.
- Response: `FileTask` — unchanged.

The refactor is purely internal to the backend services layer:

- `FilesManager.downloadFromUrl` changed signature from `(user, space, url: string)` to `(user, space, downloadDto: DownloadFileDto)` at `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/services/files-manager.service.ts:505`.
- `FilesMethods.downloadFromUrl` now passes the DTO through rather than unwrapping `.url` at `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/services/files-methods.service.ts:87-90`.
- Download logic (HEAD, SSRF check, content-length parse, streaming GET) moved into a new `downloadFile(...)` helper at `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/utils/download-file.ts` (new file, 71 lines).
- `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/utils/url-file.ts` was deleted — its `regExpPrivateIP` export is inlined inside `download-file.ts` now.

**Frontend callers verified unaffected:**

- Classic wrapper `FilesService.downloadFromUrl(url, name)` at `/Users/janwiebe/prive/sync-in-server/frontend/src/app/applications/files/services/files.service.ts:189-197` already POSTs `{ url } satisfies DownloadFileDto`. No edit needed.
- Custom-v2 caller `PersonalComponent.downloadFromUrl()` at `/Users/janwiebe/prive/sync-in-server/frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts:620-641` delegates to that classic wrapper. No edit needed.
- No frontend code imports the deleted `url-file.ts` (grep across `frontend/src/` returned zero hits).

**No patches required.**

## 3. Internal refactors with no frontend impact

- `a2f86e1` — all diffs (`files-manager.service.ts`, `files-manager.service.spec.ts`, `files-methods.service.ts`, new `utils/download-file.ts`, deleted `utils/url-file.ts`) are internal. HTTP surface unchanged, DTO unchanged, frontend TS compilation unaffected.

## 4. Behaviour changes worth verifying

The refactor is advertised as "centralize SSRF, content-length, and quota checks" — it adds two new runtime error paths that didn't exist before on the download-from-URL flow. Both surface through the async task queue (`FilesTasksManager.createTask` catches the thrown `FileError` and writes `e.message` into `FileTaskStatus.ERROR` — see `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/services/files-tasks-manager.service.ts:51-52`), **not** via the initial HTTP response. The frontend `FilesService.downloadFromUrl` error handler at `files.service.ts:195` only catches synchronous POST failures — task errors are consumed by the task-watcher stream.

### 4a. New error path — missing Content-Length

- Code: `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/utils/download-file.ts:49-51`
  ```ts
  if (!contentLength) {
    throw new FileError(HttpStatus.BAD_REQUEST, 'Missing "content-length" header')
  }
  ```
- Before: the old implementation silently tolerated a missing header and only set `space.task.props.totalSize` if present. Downloads from servers that didn't advertise Content-Length still succeeded.
- After: **any** remote URL whose HEAD response omits Content-Length now fails hard. This is a real behaviour change users may hit with some CDNs, chunked-encoding responses, redirect chains, etc.
- Surfaces in v2 as: the task entry flipping to `ERROR` with message `Missing "content-length" header` in the task queue / task toast.
- No i18n key exists for this string (grep across `frontend/src/i18n/` returned zero hits). NL users will see the raw English.

### 4b. New error path — pre-download quota check

- Code: `/Users/janwiebe/prive/sync-in-server/backend/src/applications/files/utils/download-file.ts:53-56`
  ```ts
  if (space.willExceedQuota(contentLength)) {
    throw new FileError(HttpStatus.INSUFFICIENT_STORAGE, 'Storage quota will be exceeded')
  }
  ```
- Before: no pre-flight quota check on download-from-URL. A too-large download would only fail mid-stream when storage filled.
- After: fast-fails with 507 before any bytes are streamed.
- i18n status: `"Storage quota will be exceeded"` already translated — present in `/Users/janwiebe/prive/sync-in-server/frontend/src/i18n/nl.json:133` (and en/tr/ja/zh). Already covered.

SSRF regex was moved but unchanged (same IPv4/IPv6 CIDR list as old `url-file.ts`). A legitimate download against a compliant server with room under quota still succeeds identically.

## 5. Recommended follow-ups

- [ ] (Optional, low priority) Add i18n key `"Missing \"content-length\" header"` to `/Users/janwiebe/prive/sync-in-server/frontend/src/i18n/en.json` and `/Users/janwiebe/prive/sync-in-server/frontend/src/i18n/nl.json` so the task queue error is localized. angular-l10n uses the English string as the key — quote exactly.
- [ ] (Verify only) Smoke-test one download-from-URL in the `/v2` personal screen against a URL that does return Content-Length (e.g. a public S3 object). Happy path should be untouched.
- [ ] **No frontend code changes needed.** The classic `FilesService.downloadFromUrl` and the custom-v2 `PersonalComponent.downloadFromUrl` are wire-contract-compatible with the refactored backend.
