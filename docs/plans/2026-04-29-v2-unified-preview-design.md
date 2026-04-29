# v2 Unified Preview — design + phased plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` once a phase is approved. Each phase below is a separately mergeable PR.

**Goal:** Replace the four divergent v2 preview surfaces (image route, pdf route, file-detail page with OnlyOffice toggle, text-editor dialog) with a single unified preview component that switches by mime type and renders either as a chrome-on-top overlay (default click) or as a chromeless full-page route (middle-click / Cmd-click → new tab).

**Architecture:** One `PreviewComponent` that picks an internal sub-view (image / pdf / office / text-code / av) by mime. A `PreviewOverlayService` mounts it in the app shell over the current v2 route and pushes a synthetic URL via `Location.go(...)` so the preview is shareable, deep-linkable, and dismissible via browser back. A standalone top-level route (`/v2/preview?path=...`) renders the same component without overlay chrome — that's what middle-click hits. A `previewLink` directive on `<a href>` is the single click entry-point: left-click → `event.preventDefault()` + `service.open(...)`; middle-click and modified clicks fall through to native browser behavior.

**Tech stack:** Angular standalone components, signals, HashLocationStrategy (existing), pdf.js (already bundled at `frontend/src/assets/pdfjs/`), `OnlyOfficeComponent` (existing in `applications/files/components/utils/`), `@acrodata/code-editor` (CodeMirror, already used by file-detail).

---

## Why this matters

Today, opening a file in v2 produces four wildly different experiences:

| Today                | Surface                            | Triggered by                          |
| -------------------- | ---------------------------------- | ------------------------------------- |
| Images               | Routed full-screen `/v2/viewer`    | `router.navigate(...VIEWER...)`       |
| PDFs                 | New browser tab `/v2/pdf`          | `openPdfInNewTab(path)` (`window.open`) |
| Office, generic      | Routed page `/v2/file` with tabs   | `router.navigate(...FILE...)`         |
| Text/code            | Modal dialog mounted in v2 layout  | `textEditorDialog.open(...)`          |

This is bad UX (each preview "feels different") and worse for maintenance: every screen (`personal`, `recents`, `search`, `space-files`) has the same dispatch ladder duplicated, and any new file class adds a fifth divergent surface.

## Architecture

### Three modes, one component

```
PreviewComponent (single, dispatches by mime internally)
   │
   ├── overlay mode    — mounted by PreviewOverlayService into app shell, fixed-position over v2 route
   ├── standalone mode — rendered at /v2/preview route, full viewport, chromeless
   └── (no third mode — overlay and standalone share 100% of inner rendering)
```

### URL contract

- Overlay mode URL (pushed via `Location.go`, *not* router navigation): `/#/v2/<from-path>?preview=<encoded path>`
  - `<from-path>` is the underlying route that's "behind" the overlay (e.g. `personal/folder`).
  - `preview=` query param is what the overlay uses to render. Browser back unsets it.
  - Refreshing this URL → router resolves to the underlying screen + the screen *or app shell* sees `preview=...` and re-mounts the overlay. (Single source of truth for "is the overlay open?" is `route.queryParamMap.get('preview')`.)
- Standalone (new-tab) URL: `/#/v2/preview?path=<encoded path>` — chromeless, no v2 sidebar/header.

### Click semantics — a single anchor element

Every file row renders the file name as `<a [previewLink]="path" href="…">`. The directive:

1. Computes `href` as `/#/v2/preview?path=<encoded>` (so middle-click / Cmd-click / right-click → new-tab → standalone route, with no JS involvement — this is the kicker that the user asked for).
2. On `click` (left-button only, no modifier keys): `event.preventDefault()`, then call `previewOverlay.open(path, file)`.
3. Modified left-clicks (Cmd/Ctrl/Shift) fall through to native — opens in new tab/window naturally.

This is exactly how `RouterLink` makes Angular routing co-exist with browser-native middle-click — we're reproducing that pattern for our overlay mode.

### Sub-view dispatch table

```
mime / extension          → sub-view
────────────────────────────────────────────────────────────────
image/*                   → ImagePreviewView (existing viewer.component logic)
application/pdf           → PdfPreviewView (iframe to bundled pdf.js)
isOfficeExtension(name)   → OfficePreviewView (OnlyOfficeComponent + lock plumbing)
isTextViewerMime(mime)    → TextCodePreviewView (CodeMirror, edit + save)
audio/*, video/*          → MediaPreviewView (native <audio>/<video>)
otherwise                 → DefaultPreviewView (icon + name + download/open-with)
```

The existing `mime-to-glyph.ts` predicates already power this.

### What stays vs. what goes

| Today                                   | Disposition                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `screens/viewer/` (image route)         | **Delete** after Phase A — folded into `PreviewComponent`'s `ImagePreviewView`.                                                          |
| `screens/pdf-viewer/` (chromeless pdf)  | **Delete** after Phase B — folded into `PdfPreviewView`. Standalone-mode `PreviewComponent` is the new chromeless target.                |
| `screens/file-detail/`                  | **Keep** — but slim it down. It remains the *file detail* page: comments, activity, sharing tabs, file metadata. Preview UI moves out.   |
| `components/text-editor-dialog.*`       | **Delete** after Phase D — folded into `TextCodePreviewView`.                                                                            |
| `utils/open-pdf.ts`                     | **Delete** after Phase B — replaced by anchor href + service.                                                                            |

### OnlyOffice lock lifecycle (load-bearing)

The current file-detail component does this:

1. On office file load → `GET /api/.../only-office/settings/<path>`
2. If `cfg.hasLock && !stub.lock` → `stub.createLock(cfg.hasLock)` (re-attach)
3. If not read-only and no lock → `stub.createLock({app: ONLY_OFFICE_APP_LOCK, isExclusive: false})`
4. On unmount / save → ngx-bootstrap modal close + lock cleanup via `OnlyOfficeComponent` internals.

The `OnlyOfficeComponent` is mid-modified upstream code with internal lock teardown. **`PreviewComponent` must invoke `OnlyOfficeComponent` exactly the same way `file-detail` does today** — same FileModel stub, same `applyOfficeLock(cfg)`, same teardown on close. Deviation will leave dangling locks. See `applications/files/components/utils/only-office.component.ts` (classic) for the unmount path.

### Sibling navigation (prev/next)

The image viewer has prev/next over image siblings in the same folder. `PreviewComponent` generalizes this: prev/next over **same-mime-class siblings** (images go image→image, pdfs go pdf→pdf, etc.). Implementation: same `API_SPACES_BROWSE` call, filter by `is{Image,Pdf,...}Mime` matching the current file's class.

---

## Phased rollout

Each phase is a self-contained PR. Order matters because shared infrastructure (overlay service, anchor directive, base component) lands in Phase A and the rest layer on top.

### Phase A — Overlay infrastructure + image preview migration

**Why this phase:** stand up the overlay/anchor/route plumbing on the simplest sub-view (image), prove the end-to-end UX (click → overlay; middle-click → new tab; back-button dismisses), retire the `viewer` route.

**Files:**
- Create: `frontend/src/app/applications/custom-v2/preview/preview.component.ts`
- Create: `frontend/src/app/applications/custom-v2/preview/preview.component.scss`
- Create: `frontend/src/app/applications/custom-v2/preview/preview-overlay.service.ts`
- Create: `frontend/src/app/applications/custom-v2/preview/preview-link.directive.ts`
- Create: `frontend/src/app/applications/custom-v2/preview/views/image-view.component.ts`
- Modify: `frontend/src/app/app.routes.ts` (add `/v2/preview` standalone route, remove `/v2/viewer`)
- Modify: `frontend/src/app/applications/custom-v2/layout/layout-v2.component.html` (mount `<app-v2-preview-overlay>` at the layout root)
- Modify: `frontend/src/app/applications/custom-v2/v2.constants.ts` (drop `VIEWER`, add `PREVIEW`)
- Modify: `screens/personal/personal.component.{ts,html}`, `screens/recents/recents.component.{ts,html}`, `screens/search/search.component.{ts,html}`, `screens/space/space-files.component.{ts,html}` — remove `if (isImageMime) router.navigate(VIEWER)`, replace file-row name span with `<a previewLink ...>`
- Delete: `screens/viewer/` (entire directory, after migration verified)

**Step 1 — Write a failing e2e-style spec** for the overlay open/close/back-button cycle on an image. (Use the existing test pattern under `frontend/src/...`; keep it light — assert the overlay element appears, URL changes, back-button hides it.)

**Step 2 — Stand up `preview-overlay.service.ts`:** signal-based `current = signal<{path, file} | null>(null)`, `open(path, file)` sets it and pushes URL with `Location.go`, `close()` calls `Location.back()`. Subscribe to popstate to clear `current` when the synthetic URL is gone.

**Step 3 — `preview-link.directive.ts`:** `[previewLink]` input is `path`, host binding writes `href="/#/v2/preview?path=<encoded>"`, `(click)` handler skips when modifier keys / non-primary button, otherwise `preventDefault()` + `service.open(...)`.

**Step 4 — `preview.component.ts`:** accepts inputs `path`, `mime`, `isOverlay` (overlay vs standalone styling). Internally dispatches to view components. For Phase A only `ImageView` is wired; everything else falls through to a "Open with download" stub.

**Step 5 — `image-view.component.ts`:** port of `viewer.component.ts` rendering (img element, fullscreen, prev/next, info pane). Reuse `siblings` loading via `API_SPACES_BROWSE`.

**Step 6 — Wire the standalone route** at `/v2/preview` (top-level, sibling of v2 layout, like the current pdf route). It mounts `PreviewComponent` with `isOverlay=false`.

**Step 7 — Mount `<app-v2-preview-overlay>`** in `layout-v2.component.html` at the layout root (after the main outlet, position:fixed; z-index above sidebar). It reads `overlay.current()` and renders `<app-v2-preview [isOverlay]=true>` inside a fullscreen backdrop.

**Step 8 — Migrate dispatch sites.** In each list screen's `openEntry()`, drop the `if (isImageMime)` branch — it's handled by the anchor element on the row. Verify `router.navigate(...VIEWER...)` calls are removed.

**Step 9 — Rip out the old route + component.** Remove `/v2/viewer` from `app.routes.ts`, delete `screens/viewer/`. `V2_ROUTES.VIEWER` → drop.

**Step 10 — Manual verification:**
- Click an image in `/v2/personal` → overlay over personal screen, list still visible behind backdrop
- Cmd/middle-click an image → new tab, chromeless full-screen viewer at `/v2/preview?path=...`
- Browser back → overlay dismisses, returns to underlying screen at correct scroll position
- Refresh while overlay is open → page reloads with overlay re-mounted (URL drives it)
- Same checks under `/v2/recents`, `/v2/search`, `/v2/spaces/<...>`

**Step 11 — Commit.** One PR titled `feat(custom-v2): unified preview infrastructure + image migration`.

---

### Phase B — PDF inside the unified preview

**Files:**
- Create: `preview/views/pdf-view.component.ts` (port of `pdf-viewer.component.ts` iframe wrapper)
- Modify: `preview.component.ts` (dispatch `application/pdf` → `PdfView`)
- Modify: dispatchers in `personal`, `recents`, `search`, `space-files` — drop `if (isPdfMime) openPdfInNewTab(...)` (the anchor handles it)
- Modify: `app.routes.ts` (remove `/v2/pdf` top-level route)
- Delete: `screens/pdf-viewer/`, `utils/open-pdf.ts`
- Modify: `v2.constants.ts` (drop `PDF`)

**Verification:**
- Click `.pdf` → overlay shows pdf.js viewer over the underlying screen
- Cmd/middle-click `.pdf` → new tab opens chromeless `/v2/preview?path=...` with pdf.js
- Pdf.js controls (search, page nav, download) work inside both surfaces
- Closing overlay returns to list with no scroll loss

**Note on iframe relative URL:** `assetsUrl` resolves to `assets/...` and depends on `<base href="/">` (already in place). No change needed; just preserve the resolution from the existing `pdf-viewer.component.ts`.

---

### Phase C — Office (OnlyOffice) inside the unified preview

This is the riskiest phase because of lock plumbing.

**Files:**
- Create: `preview/views/office-view.component.ts` — moves `loadOfficeConfig`, `applyOfficeLock`, `onOfficeSave`, `pdfStage` toggle out of `file-detail.component.ts`
- Modify: `preview.component.ts` (dispatch `isOfficeExtension(name)` → `OfficeView`; for PDFs add an internal toggle `pdf ↔ office` like file-detail does today)
- Modify: `file-detail.component.ts` (remove all OnlyOffice rendering and lock code; the page now shows metadata + tabs only — preview itself happens via the overlay if the user clicks the file from inside file-detail, or already happened before they got here)
- Modify: `file-detail.component.html` (remove preview area, keep info/comments/activity/share tabs)

**Lock parity test (manual but mandatory):**
1. User A opens a `.docx` via overlay → lock created
2. User B opens same file → sees existing lock, gets read-only mode
3. User A closes overlay → lock removed
4. User B refreshes → can edit
5. User A opens overlay, force-quits browser → lock should release on next session via classic teardown path (verify lock TTL/heartbeat behavior unchanged from today's file-detail flow)

If any of those break, the OfficeView teardown is wrong — return to phase 1 of debugging skill, don't band-aid.

---

### Phase D — Text/code inside the unified preview

**Files:**
- Create: `preview/views/text-code-view.component.ts` — full port of `text-editor-dialog.component.ts` (CodeMirror, lock acquire/release, dirty state, save)
- Modify: `preview.component.ts` (dispatch `isTextViewerMime(mime)` → `TextCodeView`)
- Modify: `personal.component.ts`, `space-files.component.ts` — drop `textEditorDialog.open(...)` calls (anchor handles it)
- Modify: `layout-v2.component.html` — remove `<app-v2-text-editor-dialog />`
- Delete: `components/text-editor-dialog.{component,service}.ts`

**Watch for:** the dialog's lock acquire/release uses the same `LOCK`/`UNLOCK` flow as office. Reuse the same teardown rule — `ngOnDestroy` of `TextCodeView` must release locks. If the user navigates away (overlay close, browser back, full route change) the lock must be gone.

---

### Phase E — Polish + sweep

- Audio/video sub-view (small `MediaView` with native `<audio>`/`<video>` elements)
- Default sub-view (icon + name + "Open with…" + download for unrenderable types)
- Audit `screens/file-detail/` post-Phase C: it should be much smaller. Decide whether to keep it as a "file info" route or fold its tabs into the overlay's right-side inspector. (Recommendation: **keep as-is for now** — comments + activity + sharing are conceptually different from "preview the file"; users navigate to file-detail explicitly via "View details", not via the row.)
- Update i18n keys: any new visible string goes through `custom.preview.*` keys in `en.json` + `nl.json` (per `feedback_angular_l10n_interpolation` memory).

---

## Open questions to resolve before Phase A starts

1. **Overlay scroll lock:** when overlay is open, body scroll on the underlying screen should freeze. Add `overflow:hidden` on `<body>` while `overlay.current()` is non-null.
2. **Mobile (< 768px):** does overlay take full viewport without backdrop? Probably yes — same as text-editor dialog today behaves on mobile. Check `2026-04-28-v2-mobile-sidebars-design.md` for current breakpoints.
3. **Keyboard shortcuts inside overlay:** Esc closes (mirrors viewer + dialog today), arrow keys for sibling nav (mirrors viewer today). Standardize across sub-views.
4. **Deep-link to office in edit mode** vs view mode: today's file-detail just renders by mime; the office config dictates editability. Same behavior in `OfficeView` — no new toggle.
5. **`from` URL param:** when overlay opens at `/v2/personal/foo?preview=path/x.png` the `personal` route resolves underneath. But what if the user opens overlay from `/v2/recents` and navigates inside the overlay to a file in a different folder? The overlay URL should track the *new* file but the "behind" route stays on recents. Verify that's the case (likely is — `Location.go` only changes the query string, not the path).

## Non-goals

- No reorganization of the file-detail page's tab structure (info / comment / activity / share) in this milestone.
- No rework of classic UI; v2 unification only.
- No change to the OnlyOffice / Collabora server-side flow.
- No new file types beyond what we already render.
