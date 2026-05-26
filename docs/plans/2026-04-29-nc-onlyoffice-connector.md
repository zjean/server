# NC OnlyOffice connector — implementation plan

> **Status (2026-05-26):** Shipped. `backend/src/applications/custom-mobile-compat/controllers/nc-onlyoffice.controller.ts` + `services/nc-onlyoffice-translator.service.ts` carry all four endpoints (`/config`, `/track`, `/empty`, `/save`); `constants/capabilities.ts` advertises `files.onlyoffice` when enabled.

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Each phase is a separately mergeable PR.

**Goal:** Expose Nextcloud's OnlyOffice connector protocol (`/index.php/apps/onlyoffice/*`) so the OnlyOffice Documents mobile app can open, edit, and save Sync-in files via its "Nextcloud" connection type.

**Architecture:** A custom-mobile-compat translator that reshapes Sync-in's existing `OnlyOfficeManager.getSettings()` output into NC's connector envelope, then routes the `/track` callback back into Sync-in's existing `OnlyOfficeManager.callBack()`. JWT signing reuses `applications.files.onlyoffice.secret` (HS256) — both connectors share one secret because the OnlyOffice document server only knows one. File resolution by `fileId` reuses the pattern in `nc-extras.controller.preview` (`FilesQueries.getUserFile` → `SpacesManager.spaceEnv`).

**Tech Stack:** NestJS, Fastify, `@nestjs/jwt`, existing `OnlyOfficeManager` (DI'd from `OnlyOfficeModule`), `FilesManager.mkFile` (template-based document creation), `NcBasicAuthGuard` (existing).

**Scope reference:** [`2026-04-26-nc-onlyoffice-connector-scope.md`](./2026-04-26-nc-onlyoffice-connector-scope.md)

**Out of scope:** Collabora/Richdocuments, OnlyOffice Forms, anonymous public-link editing, shared-space file resolution (personal-space only for v1, mirroring `nc-extras.controller.preview`).

---

## Pre-conditions confirmed

- Doc-server URL is reachable identically from the mobile app and Sync-in. No split internal/public URLs needed.
- `applications.files.onlyoffice.enabled` and `applications.files.onlyoffice.secret` already configured for the existing v2 dialog; same values are reused.
- `FilesQueries.getUserFile(userId, fileId)` returns real DB ids since PRs #84/#85/#86.

## One required `mod(...)` to upstream

`OnlyOfficeManager` is currently scoped to `OnlyOfficeModule` and not exported. To DI it from custom-mobile-compat we need a single-line export. This is a `mod(only-office)` commit, not a `custom(...)` addition.

```ts
// backend/src/applications/files/modules/only-office/only-office.module.ts
@Module({
  controllers: [OnlyOfficeController],
  providers: [OnlyOfficeManager, OnlyOfficeGuard, OnlyOfficeStrategy],
  exports: [OnlyOfficeManager], // NEW
})
export class OnlyOfficeModule {}
```

`FilesModule` already imports `OnlyOfficeModule` conditionally; we extend `imports`/`exports` symmetrically so consumers of `FilesModule` see `OnlyOfficeManager`. (Conditional re-export is fine — when `onlyoffice.enabled === false` the manager is just absent and our custom-mobile-compat guards on the same flag.)

---

## Phase 1 — Module skeleton + capability advertisement

**Why first:** Stand up routes, wire DI, prove capability discovery before any business logic. NC mobile gates the "Open with OnlyOffice" action on the `files.onlyoffice` capability — without it, none of the other endpoints are even reached.

**Files:**
- Create: `backend/src/applications/custom-mobile-compat/controllers/nc-onlyoffice.controller.ts` (stub handlers returning 501)
- Create: `backend/src/applications/custom-mobile-compat/controllers/nc-onlyoffice.controller.spec.ts`
- Modify: `backend/src/applications/custom-mobile-compat/constants/routes.ts` — add `ONLYOFFICE_*` route constants
- Modify: `backend/src/applications/custom-mobile-compat/constants/capabilities.ts` — conditional `files.onlyoffice` block
- Modify: `backend/src/applications/custom-mobile-compat/constants/capabilities.spec.ts` — assert flag presence/absence
- Modify: `backend/src/applications/custom-mobile-compat/custom-mobile-compat.module.ts` — register controller (conditional on `onlyoffice.enabled`)
- Modify: `backend/src/applications/files/modules/only-office/only-office.module.ts` — add `exports: [OnlyOfficeManager]` (`mod(only-office)`)
- Modify: `backend/src/applications/files/files.module.ts` — re-export `OnlyOfficeModule` conditionally (`mod(files)`)

### Task 1.1 — Add NC OnlyOffice route constants

**Step 1.** Read `constants/routes.ts` (already in working memory).

**Step 2.** Append four route constants right after `PREVIEW`:

```ts
// OnlyOffice connector (NC plugin protocol). Mounted only when
// applications.files.onlyoffice.enabled === true (see CustomMobileCompatModule).
ONLYOFFICE_CONFIG: '/index.php/apps/onlyoffice/config',
ONLYOFFICE_TRACK: '/index.php/apps/onlyoffice/track',
ONLYOFFICE_EMPTY: '/index.php/apps/onlyoffice/empty',
ONLYOFFICE_SAVE: '/index.php/apps/onlyoffice/save',
```

**Step 3.** Commit: `chore(custom-mobile-compat): add NC OnlyOffice route constants`.

### Task 1.2 — Capability advertisement (TDD)

**Step 1.** Open `capabilities.spec.ts`. Add a failing test:

```ts
describe('files.onlyoffice', () => {
  it('omits the block when onlyoffice is disabled', () => {
    jest.replaceProperty(configuration.applications.files.onlyoffice, 'enabled', false)
    const caps = ncCapabilities('https://example.test')
    expect(caps.capabilities.files).not.toHaveProperty('onlyoffice')
  })
  it('advertises mimetypes + templates when enabled', () => {
    jest.replaceProperty(configuration.applications.files.onlyoffice, 'enabled', true)
    const caps = ncCapabilities('https://example.test') as any
    expect(caps.capabilities.files.onlyoffice.mimetypes).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(caps.capabilities.files.onlyoffice.templates).toEqual(['docx', 'xlsx', 'pptx'])
  })
})
```

**Step 2.** Run: `cd backend && npx jest custom-mobile-compat/constants/capabilities.spec.ts`. Expect FAIL.

**Step 3.** Implement in `capabilities.ts`:

```ts
import { configuration } from '../../../configuration/config.environment'

// inside ncCapabilities, after `files: { ... preview: true }` block, conditionally merge:
const onlyofficeBlock = configuration.applications.files.onlyoffice.enabled
  ? {
      onlyoffice: {
        version: '9.0.0',
        mimetypes: [
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ],
        templates: ['docx', 'xlsx', 'pptx']
      }
    }
  : {}
```

Spread `...onlyofficeBlock` into the existing `files` capability object.

**Step 4.** Re-run jest. Expect PASS.

**Step 5.** Commit: `feat(custom-mobile-compat): advertise files.onlyoffice capability when enabled`.

### Task 1.3 — Stub controller + spec

**Step 1.** Create `nc-onlyoffice.controller.ts` mirroring the structure of `nc-extras.controller.ts` (same `@AuthTokenSkip()` + `@UseGuards(NcBasicAuthGuard)` pattern). All four handlers return `HttpStatus.NOT_IMPLEMENTED` for now.

```ts
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOnlyOfficeController {
  @Get(NC_ROUTE.ONLYOFFICE_CONFIG.slice(1))
  config(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }
  // …same for track, empty, save (POST decorators)
}
```

**Step 2.** Create `nc-onlyoffice.controller.spec.ts` with one "should be defined" test (mirror `only-office.controller.spec.ts:38`).

**Step 3.** Run: `npx jest custom-mobile-compat/controllers/nc-onlyoffice`. Expect PASS.

**Step 4.** Wire into `CustomMobileCompatModule`:

```ts
const onlyofficeEnabled = configuration.applications.files.onlyoffice?.enabled === true

controllers: [
  // …existing
  ...(onlyofficeEnabled ? [NcOnlyOfficeController] : [])
]
```

**Step 5.** Modify `OnlyOfficeModule` to export `OnlyOfficeManager` (one-line). Modify `FilesModule.imports` already includes it conditionally — add to `exports`:

```ts
exports: [
  FilesManager, FilesQueries, FilesLockManager, FilesQuotaManager, FilesMethods, FilesRecents,
  ...(configuration.applications.files.onlyoffice.enabled ? [OnlyOfficeModule] : [])
]
```

**Step 6.** Run full backend test: `cd backend && npm test -- --testPathPattern='custom-mobile-compat|only-office'`. Expect PASS.

**Step 7.** Commit two commits:
- `mod(only-office): export OnlyOfficeManager + module for cross-module DI`
- `feat(custom-mobile-compat): nc-onlyoffice controller skeleton + capability flag`

### Task 1.4 — Verify boot

**Step 1.** Start the backend with `applications.files.onlyoffice.enabled=true` in test config. Hit `GET /ocs/v2.php/cloud/capabilities` with valid mobile app-password. Confirm response includes `files.onlyoffice.mimetypes`.

**Step 2.** Hit `GET /index.php/apps/onlyoffice/config?fileId=1`. Confirm 501 (proves route is mounted).

**Step 3.** Open PR `feat(custom-mobile-compat): NC OnlyOffice connector — phase 1 (skeleton + capability)`.

---

## Phase 2 — `/config` endpoint (open file)

**Why second:** Single most important endpoint. Without it the mobile app can't open anything. All other endpoints depend on the same fileId-resolution + reshape logic.

**Files:**
- Create: `backend/src/applications/custom-mobile-compat/services/nc-onlyoffice-translator.service.ts`
- Create: `backend/src/applications/custom-mobile-compat/services/nc-onlyoffice-translator.service.spec.ts`
- Modify: `nc-onlyoffice.controller.ts` — implement `config()`
- Modify: `nc-onlyoffice.controller.spec.ts` — add config tests
- Modify: `custom-mobile-compat.module.ts` — register translator service

### Task 2.1 — Translator: reshape Sync-in DTO → NC envelope (TDD)

**Step 1.** Failing test in `nc-onlyoffice-translator.service.spec.ts`:

```ts
it('reshapes OnlyOfficeReqDto into NC connector envelope', () => {
  const synci: OnlyOfficeReqDto = {
    documentServerUrl: 'https://docs.example/onlyoffice',
    hasLock: false,
    config: {
      documentType: 'word',
      type: 'desktop',
      document: { fileType: 'docx', key: 'k1', title: 'a.docx', url: 'https://sync-in/api/.../document/...?token=t' },
      editorConfig: { mode: FILE_MODE.EDIT, callbackUrl: 'https://sync-in/api/.../callback/...?token=t', user: { id: '7', name: 'Jane' } },
      token: 'signed-payload-jwt'
    }
  }
  const out = translator.toNcEnvelope(synci, { fileId: '42' })
  expect(out).toEqual({
    document: {
      url: synci.config.document.url,
      fileType: 'docx',
      key: 'k1',
      title: 'a.docx',
      permissions: synci.config.document.permissions
    },
    editorConfig: {
      callbackUrl: synci.config.editorConfig.callbackUrl,
      mode: 'edit',
      user: { id: '7', name: 'Jane' },
      lang: 'en'
    },
    documentType: 'word',
    type: 'desktop',
    token: 'signed-payload-jwt'
  })
})
```

**Step 2.** `npx jest custom-mobile-compat/services/nc-onlyoffice-translator`. Expect FAIL.

**Step 3.** Implement `NcOnlyOfficeTranslatorService.toNcEnvelope(synci, { fileId })`. Pure function — no DI dependencies; just field re-projection. Drop fields NC's connector doesn't use (height, width, embedded, customization). Keep `token` as-is — same secret means it's already valid for the doc server.

**Step 4.** Run jest. Expect PASS.

**Step 5.** Commit: `feat(custom-mobile-compat): nc-onlyoffice translator (Sync-in DTO → NC envelope)`.

### Task 2.2 — Wire `/config` to `OnlyOfficeManager.getSettings`

**Step 1.** Failing controller test:

```ts
it('config: resolves fileId, calls OnlyOfficeManager.getSettings, returns NC envelope', async () => {
  filesQueriesMock.getUserFile.mockResolvedValue({ id: 42, path: 'docs/a.docx' })
  spacesManagerMock.spaceEnv.mockResolvedValue({ url: 'files/personal/docs/a.docx' } as any)
  onlyOfficeManagerMock.getSettings.mockResolvedValue({ /* fixture */ })
  translatorMock.toNcEnvelope.mockReturnValue({ shaped: true })

  const out = await controller.config({ user: fakeUser } as any, '42')

  expect(filesQueriesMock.getUserFile).toHaveBeenCalledWith(fakeUser.id, 42)
  expect(onlyOfficeManagerMock.getSettings).toHaveBeenCalled()
  expect(out).toEqual({ shaped: true })
})

it('config: returns 404 when fileId resolves to no file', async () => { … })
it('config: returns 400 when fileId is missing/non-numeric', async () => { … })
```

**Step 2.** `npx jest`. Expect FAIL.

**Step 3.** Implement `config()`:

```ts
@Get(NC_ROUTE.ONLYOFFICE_CONFIG.slice(1))
async config(@Req() req: FastifyRequest & { user: UserModel }, @Query('fileId') fileId?: string) {
  const id = Number.parseInt(fileId ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) throw new HttpException('fileId required', HttpStatus.BAD_REQUEST)
  const space = await this.resolveFileId(req.user, id)
  if (!space) throw new HttpException('file not found', HttpStatus.NOT_FOUND)
  const synci = await this.onlyOfficeManager.getSettings(req.user, space, req as any)
  return this.translator.toNcEnvelope(synci, { fileId: String(id) })
}
```

`resolveFileId` is a verbatim copy of `nc-extras.controller.ts:134-154` — extract into a small helper if both controllers want it, or inline for now (DRY can wait until phase 3 reuses it again).

**Step 4.** Run jest. Expect PASS.

**Step 5.** Run e2e backend smoke (existing pattern): `npm run test:e2e -- --testPathPattern=custom-mobile-compat`.

**Step 6.** Commit: `feat(custom-mobile-compat): NC OnlyOffice /config endpoint`.

### Task 2.3 — Manual smoke: open a file from OnlyOffice mobile

**Step 1.** Install OnlyOffice Documents mobile, add Nextcloud connection pointing at the dev server (Basic-Auth with an `AUTH_SCOPE.MOBILE_NC` app-password).

**Step 2.** Browse to a `.docx`, tap to open. Expect: editor loads in view mode; lock acquired in Sync-in (verify via classic UI showing "locked by you").

**Step 3.** Open PR `feat(custom-mobile-compat): NC OnlyOffice connector — phase 2 (/config)`.

---

## Phase 3 — `/track` callback dispatch (save round-trip)

**Why third:** Editing a doc round-trips through `/track` — without it, edits are lost. This phase makes the file-save loop functional.

**Files:**
- Modify: `nc-onlyoffice.controller.ts` — implement `track()`
- Modify: `nc-onlyoffice.controller.spec.ts` — add track tests

**Key insight:** The doc server calls `editorConfig.callbackUrl` — Sync-in already builds that URL with `?token=<userIdentityJWT>` embedded. We do the same in our config payload (translator passes `editorConfig.callbackUrl` through unchanged). When the doc server posts to it, the NC route receives the same token in the query string, and we extract user identity from it. So **`/track` doesn't use NcBasicAuthGuard** — it uses the same `OnlyOfficeStrategy` (token-from-query).

### Task 3.1 — `/track` route: parse + dispatch (TDD)

**Step 1.** Failing test:

```ts
it('track: validates JWT and dispatches to OnlyOfficeManager.callBack', async () => {
  // body: { key, status, url, token: '<oo-payload-jwt>', users, actions }
  // query token: '<user-identity-jwt>' validated by OnlyOfficeStrategy
  jwtMock.verifyAsync.mockResolvedValue({ identity: { id: 7, login: 'jane' } })
  filesQueriesMock.getUserFile.mockResolvedValue({ id: 42, path: 'a.docx' })
  spacesManagerMock.spaceEnv.mockResolvedValue({ url: '...' } as any)
  onlyOfficeManagerMock.callBack.mockResolvedValue({ error: 0 })

  const res = await controller.track({ user: { id: 7 } } as any, '42', { token: 'oo-payload', status: 2 })
  expect(onlyOfficeManagerMock.callBack).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), 'oo-payload')
  expect(res).toEqual({ error: 0 })
})
```

**Step 2.** `npx jest`. Expect FAIL.

**Step 3.** Implement:

```ts
@Post(NC_ROUTE.ONLYOFFICE_TRACK.slice(1))
@UseGuards(OnlyOfficeGuard)              // token-from-query, NOT NcBasicAuthGuard
@HttpCode(HttpStatus.OK)
async track(
  @Req() req: FastifyRequest & { user: UserModel },
  @Query('fileId') fileId: string,
  @Body() body: { token: string; status: number }
): Promise<{ error: number | string }> {
  const id = Number.parseInt(fileId ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) return { error: 'fileId required' }
  const space = await this.resolveFileId(req.user, id)
  if (!space) return { error: 'file not found' }
  return this.onlyOfficeManager.callBack(req.user, space, body.token)
}
```

The `@UseGuards(OnlyOfficeGuard)` requires importing `OnlyOfficeGuard` from `OnlyOfficeModule` — already exportable since Phase 1's module change.

> **Note:** override the controller-level `@UseGuards(NcBasicAuthGuard)` on this route by adding `@SetMetadata` or by structuring the controller so `track` is on a sub-controller without the class-level guard. Cleanest: split into two `@Controller()` classes — `NcOnlyOfficeController` (basic-auth routes) and `NcOnlyOfficeCallbackController` (token-from-query). Keeps the auth surface obvious.

**Step 4.** Run jest. Expect PASS.

**Step 5.** Commit: `feat(custom-mobile-compat): NC OnlyOffice /track callback dispatch`.

### Task 3.2 — Lock-parity manual test (per scope doc)

Per scope doc `2026-04-26-nc-onlyoffice-connector-scope.md` § "Lock parity test":

1. User A opens `.docx` in OnlyOffice mobile via NC connection → lock created.
2. User B opens same file in classic Sync-in UI → sees existing lock, gets read-only.
3. User A closes editor → lock removed (verify by re-checking User B's view).
4. User A opens, then force-quits the mobile app → lock should release on TTL expiry per existing OnlyOffice flow.

If any step fails, return to step 1 of the debugging skill — don't band-aid.

**Step 6.** Open PR `feat(custom-mobile-compat): NC OnlyOffice connector — phase 3 (/track)`.

---

## Phase 4 — `/empty` and `/save` endpoints (create + force-save)

**Files:**
- Modify: `nc-onlyoffice.controller.ts` — implement `empty()` and `save()`
- Modify: `nc-onlyoffice.controller.spec.ts` — add tests

### Task 4.1 — `/empty`: create blank document from sample

**Why:** NC mobile's "+ Create document" action calls `POST /index.php/apps/onlyoffice/empty?fileId=<parentDirId>&name=<filename>`. We use `FilesManager.mkFile(user, space, /*overwrite*/ false, /*checkLocks*/ true, /*checkDocument*/ true)` — the third argument enables sample-template copy when extension matches `DOCUMENT_TYPE` (already the upstream "create new document" path used by classic UI).

**Step 1.** Failing test (parent dir resolution + mkFile dispatch + return file metadata in NC envelope).

**Step 2.** Implement:

```ts
@Post(NC_ROUTE.ONLYOFFICE_EMPTY.slice(1))
async empty(
  @Req() req: FastifyRequest & { user: UserModel },
  @Query('fileId') parentId: string,
  @Query('name') name: string
) {
  // resolve parent dir → SpaceEnv
  // build child SpaceEnv at parent + name
  // call filesManager.mkFile(user, space, false, true, true)
  // return { fileId: <new-db-id>, etag, size, mtime } shaped per NC plugin response
}
```

**Step 3.** Tests + commit.

### Task 4.2 — `/save`: force-save acknowledgement

**Why:** NC mobile occasionally posts to `/save?fileId=<id>` to nudge a save. Sync-in's existing flow handles save via `/track` status `6`/`7` from the doc server. Our `/save` endpoint can either:
- (a) Issue a force-save command to the doc server (`POST /coauthoring/CommandService.ashx` with `c=forcesave`), or
- (b) Return 200 OK and rely on the next `/track` status 6.

**Recommendation:** (b) for v1 — the round-trip is best-effort from the mobile app's perspective; OnlyOffice itself triggers force-save via its own internal scheduling. We can revisit if real-world testing shows lost edits.

**Step 1.** Implement as a no-op returning `{ status: 'ok' }`.

**Step 2.** Test + commit.

**Step 3.** Open PR `feat(custom-mobile-compat): NC OnlyOffice connector — phase 4 (/empty, /save)`.

---

## Phase 5 — Manual smoke + handoff doc

**Files:**
- Create: `docs/plans/2026-04-29-nc-onlyoffice-smoke-checklist.md` (test plan + observed results)

### Task 5.1 — End-to-end round-trip

1. Install OnlyOffice Documents on iOS + Android.
2. Add Nextcloud connection to Sync-in dev server (Basic-Auth via `AUTH_SCOPE.MOBILE_NC` app-password).
3. **Open** an existing `.docx` → edits persist after close (verify content via classic UI).
4. **Create** a new `.xlsx` → file appears in personal space, opens with template content.
5. **Concurrent edit** with classic UI: lock semantics match Phase 3 § Lock-parity.
6. **Mimetype gate**: tap a `.pdf` → mobile app should not offer "Edit" (capability omits PDF mime).

### Task 5.2 — Document risks observed in real testing

JWT clock skew (per scope doc § Risk) — record any intermittent "couldn't open" errors with doc-server clock offset.

### Task 5.3 — Open final PR

`docs(custom-mobile-compat): NC OnlyOffice connector smoke results`.

---

## File touch summary

| File | Phase | Disposition |
|---|---|---|
| `custom-mobile-compat/controllers/nc-onlyoffice.controller.ts` | 1, 2, 3, 4 | Create + iterate |
| `custom-mobile-compat/controllers/nc-onlyoffice.controller.spec.ts` | 1, 2, 3, 4 | Create + iterate |
| `custom-mobile-compat/services/nc-onlyoffice-translator.service.ts` | 2 | Create |
| `custom-mobile-compat/services/nc-onlyoffice-translator.service.spec.ts` | 2 | Create |
| `custom-mobile-compat/constants/routes.ts` | 1 | Modify (additive) |
| `custom-mobile-compat/constants/capabilities.ts` | 1 | Modify (additive) |
| `custom-mobile-compat/constants/capabilities.spec.ts` | 1 | Modify (additive) |
| `custom-mobile-compat/custom-mobile-compat.module.ts` | 1, 2 | Modify (additive) |
| `files/modules/only-office/only-office.module.ts` | 1 | `mod(only-office)` — add `exports` |
| `files/files.module.ts` | 1 | `mod(files)` — re-export `OnlyOfficeModule` conditionally |

Two `mod(...)` commits, total ~3 lines of upstream change. Everything else is additive under `custom-mobile-compat/`.

## Estimate

2–3 days end-to-end if the doc-server reachability assumption holds (it does, per pre-condition). Phase 3 (`/track`) carries the most risk because of dual-auth (token-from-query bypass of basic-auth) — budget half a day for that controller-split refactor.
