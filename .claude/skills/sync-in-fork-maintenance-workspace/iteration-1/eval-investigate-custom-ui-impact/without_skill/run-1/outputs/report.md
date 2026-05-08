# Upstream sync impact on custom v2/v3 UI — 2026-04-24

## Upstream sync under review

- Merge commit: `cc2ab27` — "Merge pull request #67 from zjean/sync/upstream-2026-04-24" (into `main`, 2026-04-24).
- Upstream commit merged into `backend/src/applications/files/`: **`a2f86e1`** — "refactor(backend:files): extract downloadFile and centralize SSRF, content-length, and quota checks" (johaven, 2026-04-24).
- The other two commits in the sync (`325df7b` chore(deps), `ffff6bd` nl.json) do not touch `files/`.

## What upstream `a2f86e1` actually changed

Five files touched, all backend:

| File | Kind |
|---|---|
| `backend/src/applications/files/services/files-manager.service.ts` | refactor, signature change |
| `backend/src/applications/files/services/files-manager.service.spec.ts` | test updates |
| `backend/src/applications/files/services/files-methods.service.ts` | call-site update |
| `backend/src/applications/files/utils/download-file.ts` | **new** (71 lines) |
| `backend/src/applications/files/utils/url-file.ts` | **deleted** (regex moved into new util) |

Concrete changes:

1. Internal signature change in `backend/src/applications/files/services/files-manager.service.ts:503`:
   - Before: `downloadFromUrl(user, space, url: string)`
   - After:  `downloadFromUrl(user, space, downloadDto: DownloadFileDto)`
2. `backend/src/applications/files/services/files-methods.service.ts:87-90` — the controller-facing caller now passes the whole `downloadDto` instead of unwrapping `downloadDto.url`.
3. SSRF / content-length / quota logic lifted out of the service and into a new util `backend/src/applications/files/utils/download-file.ts`. Private-IP regex (`regExpPrivateIP`) migrated from deleted `utils/url-file.ts` into the new util. Behavioural policy is unchanged; the DTO validator in `backend/src/applications/files/dto/file-operations.dto.ts:23-35` tightens URL scheme enforcement to `http`/`https` only with `require_valid_protocol: true` and `allow_underscores: false`.
4. Spec tests added for the DTO scheme validation (`files-manager.service.spec.ts:352-368`) and the existing `downloadFromUrl` call updated to pass `{ url }`.

**Wire format / HTTP contract: unchanged.** The endpoint is still `POST ${API_FILES_TASK_OPERATION_DOWNLOAD}/${dirPath}/${name}` (backend `backend/src/applications/files/constants/routes.ts:22`) and the request body is still `{ url: string }` — the DTO shape did not change, only its validator got stricter on URL schemes.

## Does this affect our frontend?

**No frontend patch required.** The refactor is a backend-internal reshuffle. Both the classic and custom v2 frontends already send exactly what the tightened DTO accepts.

Evidence:

- Classic service `frontend/src/app/applications/files/services/files.service.ts:189-197` already constructs `const op: DownloadFileDto = { url: url }` and POSTs it to `API_FILES_TASK_OPERATION_DOWNLOAD`. Unchanged and still matches.
- Classic dialog `frontend/src/app/applications/files/components/dialogs/files-new-dialog.component.ts:75-80` pre-validates the URL with `validHttpSchemaRegexp` (`frontend/src/app/common/utils/regexp.ts:3` → `/^https?:\/\//`), i.e. http/https only — exactly what the new `@IsUrl({ protocols: ['http','https'] })` enforces server-side.
- Custom v2 `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts:620-640` re-uses the same regex (line 625) and then calls `this.filesService.downloadFromUrl(url.trim(), name.trim())` (line 639), going through the classic service path. It does not construct its own DTO or hit its own endpoint, so it inherits the correct wire format for free.
- No v2/v3 code imports anything from the deleted `utils/url-file.ts` or the new `utils/download-file.ts` — those are backend-only modules.
- Grep over `frontend/src` for `downloadFromUrl` / `DownloadFileDto` / `url-file` / `regExpPrivateIP` returns only the three legitimate sites above. No custom-v3 screens under `custom-v2/` or elsewhere re-implement this endpoint.

## Risks worth sanity-checking (but not acting on)

- **Slightly stricter DTO validation.** The new `@IsUrl` config additionally rejects underscores in hostnames and trailing dots. The frontend regex `/^https?:\/\//` only checks the scheme, so a user could theoretically type a URL with `_` in the host that passes the client but now 400s server-side. Low risk; not a regression introduced by our fork. If it ever surfaces as a bad error message, mirror the stricter rules in `validHttpSchemaRegexp` — but no change needed now.
- **No classic ↔ v2 drift.** This is exactly the failure mode `CLAUDE.md` warns about; verified clean here — v2 delegates to the classic `FilesService.downloadFromUrl` rather than re-implementing the request.

## Verdict

**Zero custom v2/v3 UI changes required.** The refactor is backend-internal; HTTP contract (`POST .../task/operation/download/<path>/<name>`, body `{ url }`) is preserved, and both the classic service and the v2 wrapper already satisfy the tightened DTO rules via the shared `validHttpSchemaRegexp` pre-check.
