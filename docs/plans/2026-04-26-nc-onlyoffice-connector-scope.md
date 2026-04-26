# NC OnlyOffice connector for the OnlyOffice mobile app — scope

Date: 2026-04-26

## Why

The OnlyOffice Documents mobile app speaks the **Nextcloud OnlyOffice
connector protocol** (the `/index.php/apps/onlyoffice/...` endpoints exposed
by NC's official OnlyOffice plugin). When a user adds a "Nextcloud"
connection in the OnlyOffice app, those endpoints drive the entire
open-edit-save loop. Sync-in's existing OnlyOffice integration lives at
`/api/spaces/onlyoffice/...` for the v2/v3 web SPA only — different
routing, different JWT signing scheme, iframe-only — so the OnlyOffice
mobile app sees a 404 and falls back to "no editing".

This scope is a custom-mobile-compat translation shim: same endpoints NC's
plugin exposes, mapped to Sync-in's existing OnlyOffice service.

## Endpoints to expose

| Method + path | Purpose |
|---|---|
| `GET /index.php/apps/onlyoffice/config?fileId=<id>` | Returns the JWT-signed editor config the mobile app hands to its embedded OnlyOffice editor: `{document: {url, fileType, key}, editorConfig: {callbackUrl, mode, user, lang}, type, token}` |
| `POST /index.php/apps/onlyoffice/track` | Callback the OnlyOffice document server hits when the doc is saved (status 1=editing, 2=saved, etc.). Translates into a Sync-in writeback. |
| `POST /index.php/apps/onlyoffice/empty?fileId=<parentId>&name=<name>` | Creates a blank `.docx`/`.xlsx`/`.pptx` from a template, returns the new file metadata. |
| `POST /index.php/apps/onlyoffice/save?fileId=<id>` | Explicit save trigger from the mobile app. |
| (capability) `files.onlyoffice` in `/ocs/v2.php/cloud/capabilities` | Tells the mobile app integration is available + which mimetypes are editable |

## Design

### Pure isolation

Same discipline as the other custom-mobile-compat work: all new code under
`backend/src/applications/custom-mobile-compat/`. Reuses Sync-in's
existing OnlyOffice service via DI — no `mod(...)` to upstream OnlyOffice.

### New module pieces

| File | Purpose |
|---|---|
| `controllers/nc-onlyoffice.controller.ts` | The four NC-shape endpoints |
| `services/nc-onlyoffice-translator.service.ts` | Map between NC's `{document, editorConfig, type, token}` JSON and Sync-in's existing OnlyOffice config payload + JWT signing scheme |
| `constants/onlyoffice-routes.ts` | The four `/index.php/apps/onlyoffice/...` paths |

### Capability advertisement

Add to `constants/capabilities.ts`:

```json
"files": {
  ...,
  "onlyoffice": {
    "version": "9.0.0",
    "mimetypes": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ],
    "templates": ["docx", "xlsx", "pptx"]
  }
}
```

(Versions / mimetypes mirror what NC's plugin advertises; mobile app reads
this to enable the OnlyOffice "Open with" action on supported files.)

### JWT signing reconciliation

NC's plugin uses a single shared secret (`ONLYOFFICE_JWT_SECRET`) signed
with HS256 — both the config payload and the `/track` callback verify
against it. Sync-in's existing OnlyOffice service already signs with the
configured `applications.files.onlyoffice.secret`; we reuse that secret +
algorithm. The translator just needs to repackage the payload fields into
the NC JSON shape.

### File-id resolution

NC mobile passes `fileId=<oc:fileid>` (a real DB id thanks to
PR #84/#85/#86). Translator does
`filesQueries.getUserFile(user.id, id)` (or `getSpaceFile` for shared
spaces — same pattern as `nc-extras.controller.preview`) to resolve it
into a Sync-in `SpaceEnv`, then hands to Sync-in's OnlyOffice service to
build the document URL with embedded basic-auth.

### Callback URL

The `editorConfig.callbackUrl` MUST be reachable by the OnlyOffice
**document server** (not the mobile app — the doc server is a separate
service that proxies edits). Format:

```
https://sync-in.example.com/index.php/apps/onlyoffice/track?fileId=<id>&token=<jwt>
```

Server validates the inbound JWT, then dispatches into Sync-in's existing
callback handler (`OnlyOfficeManager.callbackHandler` or equivalent).

## Out of scope

- **Collabora / Richdocuments** (`/apps/richdocuments/...`) — separate
  protocol, separate plugin in NC. Skip unless the maintainer also wants
  it; same shape of work would scope similarly.
- **OnlyOffice Forms** — different mimetype, different open path; skip.
- **Anonymous public links** to OnlyOffice docs — would need
  share-link infrastructure we don't expose to mobile yet.

## Risk

- **OnlyOffice document server URL** — must be reachable from BOTH the
  mobile app (to load `web-apps/apps/api/documents/api.js`) AND Sync-in
  (to fire callbacks). The maintainer's network setup matters; usually
  fine if both run on the same domain or the doc server is publicly
  reachable.
- **JWT clock skew** — config payloads have a short TTL; doc-server clock
  drift causes intermittent "couldn't open document" errors. Use the same
  `iat`/`exp` Sync-in already uses.
- **File-format whitelisting** — NC's plugin gates on mimetype before
  emitting config. Match that gate so we don't return a config for, say,
  a PDF (which the OnlyOffice mobile app would try to edit, fail, and
  surface as a generic error).

## Implementation order (4 phases)

1. **Translator service** — maps Sync-in OnlyOffice config → NC shape,
   JWT signing reuse. Tests: unit-level; mock the existing OnlyOffice
   service.
2. **`nc-onlyoffice.controller.ts`** — four endpoints, glued to the
   translator. Tests: controller-level with mocked translator.
3. **Track callback dispatch** — receive NC-shape POST, validate JWT,
   route into Sync-in's existing OnlyOffice writeback. Tests: focused
   on the JWT validation + routing.
4. **Capability flag + manual smoke** — flip `files.onlyoffice` in
   capabilities, install OnlyOffice mobile, add NC connection to the
   server, open a `.docx` round-trip.

Roughly 2–3 days end-to-end, more if the JWT signing scheme needs
reconciliation work between NC's expected payload shape and Sync-in's
current one.

## Decision needed before phase 1

**Confirm the OnlyOffice document server is publicly reachable** at the
same URL the mobile app and Sync-in container both see. If not, the
config payload's `documentServerUrl` needs to be configurable per-client
(e.g. internal URL for Sync-in callbacks vs. public URL for the mobile
app) — small but real complication.
