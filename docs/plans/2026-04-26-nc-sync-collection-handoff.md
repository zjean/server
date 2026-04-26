# NC sync-collection — session handoff

Date: 2026-04-26
Last PR shipped this session: **#92** (phase 1)

## Where we are

PRs merged this session that landed mobile-compat fixes:

| PR | What |
|---|---|
| #79 | OCS v2 `meta.statuscode = 200` (was 100) |
| #80 | `provisioning_api` capability |
| #81 | Advertise NC v33 server identity |
| #82 | `WWW-Authenticate` realm "Nextcloud" → "Sync-in" |
| #83 | Positive `oc:fileid` (abs of -inode placeholder) |
| #84 | Personal-space DB row insert after PUT |
| #85 | Shared-space DB row insert after PUT |
| #86 | `await` the DB-row insert before PUT returns (race fix for thumbnails) |
| #87 | Children inherit `space.permissions` (root keeps stripped envPermissions — restores Move-to-trash) |
| #88, #89 | Sync-collection design doc |
| #90 | Omit `<oc:favorite>` until upstream supports favorites |
| #91 | OnlyOffice mobile connector design doc |
| **#92** | **Sync-collection phase 1 — sync-log table + service** ← last work this session |

## Pick up here next session

Phase 2 of the sync-collection work, per
`docs/plans/2026-04-26-nc-sync-collection-design.md`.

### Phase 2 — REPORT verb controller

New file: `backend/src/applications/custom-mobile-compat/controllers/nc-sync.controller.ts`.

Route: `REPORT /remote.php/dav/files/:user[/*]`.

Body shape (XML):

```xml
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>http://sync-in/ns/sync/v1/<seq></d:sync-token>
  <d:sync-level>1 | infinity</d:sync-level>
  <d:limit><d:nresults>500</d:nresults></d:limit>  <!-- optional -->
  <d:prop>...</d:prop>
</d:sync-collection>
```

Response shape (`207 Multi-Status` XML):

- One `<d:response>` per add/update with full prop block (status `200 OK`).
  Use the same prop builder `nc-propfind.service.ts:buildResponse` already
  uses — extract it into a shared helper if cleanest.
- One `<d:response>` per delete with just `<d:href>` and status `404 Not Found`.
- Trailing `<d:sync-token>http://sync-in/ns/sync/v1/<newSeq></d:sync-token>`.

### Algorithm

1. Parse the body. `fast-xml-parser` is already a dep (`nc-propfind` uses it).
   Pull the `<d:sync-token>` value; strip the URN prefix to get `sinceId`
   (`0` for empty / first sync).
2. Look up the user's space + repository from the URL the same way
   `NcDavController.dispatchFiles` does (re-use `NcPathResolverService`).
3. `events = await syncLogService.since({ ownerId: user.id, sinceId, spaceAlias, limit: 500 })`
4. If `events.length === 0`:
   - Return `<d:multistatus>` with the same sync-token client sent.
5. For each event:
   - **create / update**: stat the file (use `getProps` from `files/utils/files`)
     and emit a full prop block. Re-use the `nc-propfind` builder.
   - **delete**: emit just `<d:href>` and `<d:status>HTTP/1.1 404 Not Found</d:status>`.
6. Trailing `<d:sync-token>` = `URN_PREFIX + lastEvent.id`.
7. If `sinceId > 0` and `sinceId < (await syncLogService.currentToken()) - 100000` (or
   beyond the prune horizon — needs a "minimum kept token" query): respond
   `412 Precondition Failed` so the client does a full re-sync.

### Wiring

- Register the controller in `CustomMobileCompatModule.controllers` (always,
  not gated on auth.provider).
- The REPORT verb isn't a standard NestJS HTTP method. Use
  `@All('remote.php/dav/files/:user')` and `@All('remote.php/dav/files/:user/*')`
  (already exist in `NcDavController`) but add a method-switch on `req.method`
  for `'REPORT'` *before* falling through to existing PROPFIND/GET/etc.
  Cleanest: a new dispatcher entry `case 'REPORT': return this.syncReport(req, res)`
  in `NcDavController.invokeWebDAV`. New service method does the work.

### Tests

- Service-level: extract the XML body parser into a pure function and test it.
- Controller-level: mock `NcSyncLogService.since` returning canned events,
  assert the emitted XML has the right `<d:response>` count + the trailing
  `<d:sync-token>`.

### Known gotcha

`req.method === 'REPORT'` may not be passed through Fastify by default — some
HTTP servers normalize unknown verbs. Verify by curling REPORT against the
running container before assuming the route hits.

## Phase 4 (after phase 2)

`docs/plans/2026-04-26-nc-sync-collection-design.md` lists this:

- Add `dav.sync-token: true` to `constants/capabilities.ts` so NC iOS
  switches from PROPFIND-polling to REPORT-incremental.
- Manual smoke: upload from web UI, observe iOS list refreshing within ~1s.

## Other open work (not started)

- **OnlyOffice mobile connector** (`docs/plans/2026-04-26-nc-onlyoffice-connector-scope.md`) — 4 phases, ~2-3 days. Independent of sync-collection.
- **Favorites upstream contribution** (`docs/plans/2026-04-26-nc-favorites-disabled.md`) — 2-4 days, `upstream-contrib/` branch. Independent.

## How to start the next session

1. `git checkout main && git pull` — pick up PR #92's merge.
2. Re-read `docs/plans/2026-04-26-nc-sync-collection-design.md` and this
   handoff.
3. Branch off main: `git checkout -b feat/nc-sync-controller-phase2`.
4. Skim `backend/src/applications/custom-mobile-compat/controllers/nc-dav.controller.ts:230-271` (the verb dispatcher) and
   `backend/src/applications/custom-mobile-compat/services/nc-propfind.service.ts:76-140` (the prop builder).
5. Start with the XML body parser as a pure function (testable without a controller).
6. Build outward.
