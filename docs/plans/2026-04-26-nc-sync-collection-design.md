# Nextcloud mobile incremental sync via WebDAV `REPORT` — scope

Date: 2026-04-26

## Why

NC iOS / Android use **`REPORT` with `<d:sync-collection>` (RFC 6578)** as
their primary refresh mechanism. The client passes a server-issued
`<d:sync-token>` and the server returns just the deltas (creates / updates /
deletes) since that token. Stock NC supports it; we 404 the verb today, so
mobile can only refresh on user-triggered actions (pull-to-refresh,
foregrounding, periodic timer).

Live evidence from the maintainer's logs:

```
WARN  REPORT /remote.php/dav/files/janwiebe  →  404
```

Implementing this turns "auto-refresh after another-device or server-side
change" from "manual-only" into "~1s push-style".

## Protocol summary (RFC 6578)

Request:

```xml
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>http://sync-in.test/ns/sync/v1/<token>|""</d:sync-token>
  <d:sync-level>1 | infinity</d:sync-level>
  <d:limit><d:nresults>500</d:nresults></d:limit>   <!-- optional -->
  <d:prop>...</d:prop>
</d:sync-collection>
```

Response (`207 Multi-Status`):

- `<d:response>` per **add/update**: full prop block, status `200 OK`.
- `<d:response>` per **delete**: just `<d:href>`, status `404 Not Found`.
- A `<d:sync-token>` element at the end with the *new* server token.
- If `412 Precondition Failed` → token too old (pruned), client retries with empty token.

Initial sync: client sends empty `<d:sync-token>`. Server returns the entire
listing as adds plus the current token.

## Design

### Pure isolation (same discipline as the rest of mobile-compat)

All new code lives under `backend/src/applications/custom-mobile-compat/`.
Hooks into existing custom-mobile PUT / DELETE / MOVE / MKCOL paths —
`NcDavController` already wraps `webdav.put()` for the DB-row insert (PR
#84/#85), same hook gets a sync-log append.

### New module pieces

| File | Purpose |
|---|---|
| `controllers/nc-sync.controller.ts` | `REPORT /remote.php/dav/files/:user[/*]` handler — parses the body, validates token, returns deltas + new token |
| `services/nc-sync-log.service.ts` | Append/query the change log; mint + validate sync tokens |
| `schemas/nc-sync-events.schema.ts` | New table `nc_sync_events` (id, ownerId, spaceId, path, name, type, ts) — kept out of `files` so we don't touch upstream schema |

### Sync-token format

Opaque to the client. We use a sequence number from the change log row id (or `created_at` ns timestamp).

`<d:sync-token>http://sync-in/ns/sync/v1/<seq></d:sync-token>` — the URN form
NC clients expect. Internally just `<seq>`.

### When to append a sync event

Wrap each upstream verb in `NcDavController.invokeWebDAV`:

```text
PUT     → after webdav.put() succeeds → log {type: create-or-update, path, name}
DELETE  → after webdav.delete()       → log {type: delete, path, name}
MOVE    → after webdav.copyMove()     → log delete(src) + create(dst)
COPY    → after webdav.copyMove()     → log create(dst)
MKCOL   → after webdav.mkcol()        → log {type: create, path, name, isDir: true}
```

Trashbin DELETE → emits as a delete event (the file disappears from the user's view).

### Pruning

`nc_sync_events` rows older than `30 days` are dropped by a daily cron.
Tokens older than the prune horizon return `412 Precondition Failed` so the
client knows to do a full re-sync.

### Multi-process safety

DB-backed (MySQL `nc_sync_events` table) so multiple Sync-in containers see
the same sequence stream. In-memory was tempting for v1 but breaks on a
multi-instance deploy.

### Capability advertisement

`/ocs/v2.php/cloud/capabilities` adds:

```json
"dav": {
  ...,
  "sync-token": true   // signals REPORT sync-collection support
}
```

NC iOS reads this and switches from PROPFIND-polling to REPORT-incremental.

## Out of scope (call out so we don't accidentally bite this off)

- Push notifications (`/ocs/v2.php/apps/notifications/...`). Sync-collection
  alone gets us most of the UX win at lower cost.
- Cross-user sync events (e.g. another user shares with you). Initially scoped
  to the requesting user's own changes only.
- Move/rename atomicity beyond emit-delete-then-create. Real NC does the same
  thing per RFC 6578 §3.6.

## Risk

- **Schema migration** — new `nc_sync_events` table needs a Sync-in DB
  migration. Custom migrations need a `mod(...)` discipline-friendly path
  (separate file under `db/migrations/custom/...` or similar).
- **Disk + DB pressure** — every PUT/DELETE adds a row. ~30 days × tens of
  uploads/day per user = thousands of rows. Indexes on `(ownerId, id)` and
  pruning policy keep it bounded.
- **MOVE handling for large directory renames** — moving a folder with 1000
  files needs 2000 events emitted. Acceptable if batched (single
  transaction).

## Implementation order (4 phases)

1. **Sync-log table + service** — schema, append helper, query-since helper.
   Tests: unit-level on the service.
2. **REPORT controller** — parses sync-collection body, glues to the service,
   emits 207 Multi-Status XML. Tests: controller-level with mocked service.
3. **Wire hooks into existing verb handlers** — append on PUT/DELETE/MOVE/COPY/MKCOL.
   Tests: extend `nc-dav.controller.spec.ts`.
4. **Capability advertisement + manual smoke** — flip the `sync-token: true`
   flag, verify NC iOS picks it up and stops 404-ing the REPORT.

Roughly 1–2 days of focused work per phase, more if the schema migration
path needs upstream alignment.

## Decision needed before phase 1

Per CLAUDE.md fork-maintenance discipline: **do we add custom DB tables in
this repo, or upstream the migration?** A custom-only `nc_sync_events`
table keeps the work isolated; an upstream contribution is a longer
conversation. Recommendation: keep it custom (it's NC-protocol-specific
state, not generally useful to Sync-in).
