# draw.io Integration Design

**Date:** 2026-05-06
**Branch:** `feat/drawio-integration`

> **Status (2026-05-26):** Shipped. See companion plan doc `2026-05-06-drawio-integration-plan.md`.

## Goal

Integrate draw.io diagram editing into the custom v2 Angular web UI. Users can create, open, and edit `.drawio` and `.dwb` files directly in the browser using the draw.io embed protocol. The integration is isolated under `custom-*` paths so upstream merges land cleanly.

---

## Decisions Made

| Question | Decision |
|---|---|
| Editor hosting | Start with hosted `app.diagrams.net?embed=1`; switch to self-hosted via one config value |
| Mobile NC app | Defer — web UI first, mobile bolt-on in a follow-up phase |
| File creation | "New diagram" button in files toolbar |
| Thumbnails | Generic diagram icon — no sidecar PNG |
| Offline mode | Not implemented; desktop sync client + draw.io Desktop is the recommended offline workflow |

---

## Architecture

Three layers, each self-contained:

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Angular v2)                              │
│  • MIME classification: .drawio → SHORT_MIME.DIAGRAM│
│  • New diagram action in files toolbar              │
│  • FilesViewerDrawioComponent (iframe + postMessage)│
└─────────────────────────────────┬───────────────────┘
                                  │ HTTP (load/save/new)
┌─────────────────────────────────▼───────────────────┐
│  Backend (NestJS — CustomDiagramsModule)            │
│  • GET  /diagrams/load?fileId=  → xml + etag        │
│  • PUT  /diagrams/save          → etag check + write│
│  • POST /diagrams/new           → blank file + fileId│
└─────────────────────────────────┬───────────────────┘
                                  │ reuses FilesManager
┌─────────────────────────────────▼───────────────────┐
│  Storage (unchanged)                                │
│  .drawio files stored as regular files in spaces   │
└─────────────────────────────────────────────────────┘
```

Standard file operations (rename, move, delete, share) work unchanged — `.drawio` is just a file.

**Self-hosted upgrade path:** `DRAWIO_URL` env var (default: `https://app.diagrams.net`). Switching to a self-hosted instance is a one-line config change with no frontend rebuild.

---

## Backend

### Module isolation strategy

```
backend/src/applications/
  custom-features/
    custom-features.module.ts        ← aggregator; imported ONCE into applications.module.ts
  custom-diagrams/
    custom-diagrams.module.ts
    custom-diagrams.controller.ts
    custom-diagrams.service.ts
    dto/
      load-diagram.dto.ts
      save-diagram.dto.ts
      new-diagram.dto.ts
```

**One upstream file touch:** `applications.module.ts` gets one import + one array entry for `CustomFeaturesModule`. Committed as `mod(app): register CustomFeaturesModule`. All future custom backend modules are added to `custom-features.module.ts` only — zero further upstream touches.

### Endpoints

#### `GET /diagrams/load?fileId=:id`

- Auth: session, read permission on file
- Reads file content + metadata via `FilesManager`
- Returns:

```typescript
{
  xml: string        // file content (space for new/empty files)
  etag: string       // current file etag for optimistic locking
  mtime: number      // last modified timestamp
  name: string       // filename
  isWritable: boolean
  editorUrl: string  // resolved from DRAWIO_URL env var
}
```

- Errors: 403 (no access), 404 (not found), 413 (file too large — 10 MB limit)

#### `PUT /diagrams/save`

Body:
```typescript
{ fileId: number, xml: string, etag: string }
```

- Auth: session, write permission on file
- Reads current file etag, compares with client-provided etag
- **409** if etag mismatch (concurrent edit — file was modified elsewhere)
- Writes new content via `FilesManager`
- Returns: `{ etag: string, mtime: number }`

#### `POST /diagrams/new`

Body:
```typescript
{ spaceId: number, path: string, name: string }
```

- Auth: session, write permission in space
- Creates file with a single space character (`" "`) as content — the draw.io editor initialises the proper `<mxfile>` XML on first load/save
- Returns: `{ fileId: number, path: string, name: string }`

> **Why a space, not an XML stub?**
> The upstream draw.io-nextcloud app uses `$template = " "` intentionally. The editor detects empty/whitespace content and generates correct `<mxfile>` XML (with host, version, timestamps, page id) itself. Writing our own XML stub would hardcode metadata the editor owns.

---

## Frontend

### MIME classification

Two small changes to existing utilities:

- `classify-file.ts` — add `.drawio` / `.dwb` extensions → `SHORT_MIME.DIAGRAM` (new enum value)
- `mime-to-glyph.ts` — map `application/x-drawio` and `application/x-drawio-wb` → `'diagram'` glyph icon

### FilesViewerDialogComponent

Add `DIAGRAM` branch → `FilesViewerDrawioComponent` in the existing viewer routing switch. Import `FilesViewerDrawioComponent` as a standalone component alongside the existing viewers.

### FilesViewerDrawioComponent (new)

Standalone Angular component. Opens as full-screen overlay (same pattern as Collabora/OnlyOffice).

**postMessage protocol (`proto=json`):**

```
Component init
  → GET /diagrams/load?fileId=X  → { xml, etag, mtime, name, isWritable, editorUrl }
  → render <iframe [src]="editorUrl + '?embed=1&spin=1&proto=json'">

draw.io → { event: 'init' }
  → postMessage({ action: 'load', xml })

draw.io → { event: 'save', xml }
  → PUT /diagrams/save { fileId, xml, etag }
     200 → update local etag, postMessage({ action: 'status', message: '' })
     409 → toast "File was modified by someone else"

draw.io → { event: 'autosave', xml }
  → same as save

draw.io → { event: 'exit' }
  → close viewer, refresh file list
```

**Read-only mode:** when `isWritable === false`, pass `&chrome=0` to the iframe URL to disable the toolbar. Intercept `save`/`autosave` events and do nothing.

### New diagram action

Add "New diagram" entry to the existing new-file creation menu (alongside "New folder"). On click:
1. Prompt for name (default: `Untitled diagram.drawio`)
2. `POST /diagrams/new` → returns `{ fileId, path, name }`
3. Immediately open `FilesViewerDrawioComponent` with the returned `fileId`
4. On exit: refresh file list

---

## Offline Mode

**Not implemented in the web UI.**

The draw.io iframe requires the editor app to load (hosted or self-hosted). Even with service worker caching of the editor assets, saving requires a backend connection. The Sync-in web app is inherently server-dependent.

**Supported offline workflow:** sync desktop client + draw.io Desktop app (Electron, works fully offline). Files sync back on reconnect.

**LAN / air-gapped environments:** set `DRAWIO_URL` to a self-hosted draw.io instance. Eliminates the external internet dependency without any service worker complexity.

---

## NC Mobile Compatibility (Future Phase)

Deferred. The backend endpoints built here are exactly what a future mobile integration needs. The bolt-on requires only additions to `custom-mobile-compat` — no changes to `custom-diagrams` or the web UI.

**What the future phase looks like:**

1. **Capabilities** — add `directEditing` entry for `application/x-drawio` in `capabilities.ts`
2. **OCS controller** (`NcDirectEditingDiagramsController`) — handles `open` and `create` OCS requests, generates a one-time token, returns a webview URL like `/diagrams/edit?token=XYZ`
3. **Editor page endpoint** — `GET /diagrams/edit?token=XYZ` serves a minimal HTML page embedding the draw.io iframe, connected to `/diagrams/load` and `/diagrams/save` via token auth
4. **Token auth** — extend `CustomDiagramsService` to accept token-based auth alongside session auth (additive, existing web UI path unaffected)

---

## Files to Create / Modify

### New files (all `custom-*`, zero upstream conflict)

```
backend/src/applications/custom-features/
  custom-features.module.ts

backend/src/applications/custom-diagrams/
  custom-diagrams.module.ts
  custom-diagrams.controller.ts
  custom-diagrams.service.ts
  dto/load-diagram.dto.ts
  dto/save-diagram.dto.ts
  dto/new-diagram.dto.ts

frontend/src/app/applications/custom-v2/components/
  files-viewer-drawio/
    files-viewer-drawio.component.ts
    files-viewer-drawio.component.html
    files-viewer-drawio.component.scss
```

### Modified files (minimal upstream touches)

| File | Change | Commit convention |
|---|---|---|
| `backend/src/applications/applications.module.ts` | +1 import, +1 array entry for `CustomFeaturesModule` | `mod(app): register CustomFeaturesModule` |
| `frontend/src/app/applications/custom-v2/utils/classify-file.ts` | Add `.drawio`/`.dwb` → `SHORT_MIME.DIAGRAM` | `feat(v2/diagrams): add drawio MIME classification` |
| `frontend/src/app/applications/custom-v2/utils/mime-to-glyph.ts` | Add diagram glyph mapping | same commit |
| `frontend/src/app/applications/custom-v2/components/files-viewer-dialog/files-viewer-dialog.component.ts` | Add `DIAGRAM` branch + import | same commit |
| `frontend/src/app/applications/custom-v2/screens/files/files.component.ts` | Add "New diagram" menu entry | `feat(v2/diagrams): new diagram action in files toolbar` |

---

## References

- [draw.io embed protocol docs](https://www.drawio.com/doc/faq/embed-mode)
- [draw.io-nextcloud (deprecated)](https://github.com/jgraph/drawio-nextcloud) — PHP reference implementation
- [jgraph/drawio](https://github.com/jgraph/drawio) — editor source; `EditorUi.js` for postMessage events
- Existing editor integrations: `backend/src/applications/files/modules/only-office/`, `collabora-online/`
- NC direct editing API (future mobile phase): `nextcloud/server` `apps/files/lib/Controller/DirectEditingController.php`
