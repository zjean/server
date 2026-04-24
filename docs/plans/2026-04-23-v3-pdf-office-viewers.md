# v3 PDF toggle + OnlyOffice embed (milestone 4, phases 4.9 + 4.11-office)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phases 4.9 + office part of 4.11

## Why this combines two phases

Phase 4.9 wants a **toggle-to-OnlyOffice** from the PDF viewer. Phase 4.11 wants the OnlyOffice iframe for office docs (.docx/.xlsx/.pptx). Both need the same OnlyOffice URL-building + iframe infrastructure, so one phase is cheaper than two. The media part of 4.11 already shipped (phase 4.11-media).

## Current state of play

- `/v2/file` already previews PDFs via `<iframe [src]="previewUrl()">` — the browser's built-in PDF viewer (which in Firefox is PDF.js, in Chrome is Chrome's viewer). The phase 4.9 spec from `docs/plans/2026-03-31-pdf-viewer-default.md` was written for classic — its ideas carry over but the concrete file paths don't.
- OnlyOffice exists as a classic integration. The server endpoint is `/api/app/files/onlyoffice/...` and the OnlyOffice Document Server runs alongside.

## Goals

### 4.9 PDF toggle

- Keep PDF.js (via the iframe) as the default.
- If the user has write permission AND OnlyOffice is available for PDFs, show a pen icon on the viewer that toggles to OnlyOffice edit mode.

### 4.11 office embed

- When the file is a recognized office mime (docx/xlsx/pptx/ods/odt/odp/etc.), embed OnlyOffice in the stage instead of the "Preview not available" fallback.
- Read-only view if the user lacks write permission; edit mode otherwise.

## Non-goals

- **Collabora** (alternative to OnlyOffice) — explicitly deferred in §4 of main plan.
- **Real-time collaboration indicator** — OnlyOffice renders its own; don't overlay.

## Architecture

### Classic reuse

- `OnlyOfficeService.getEditorConfig(file, mode)` — returns an iframe URL + token. Check the exact signature before coding.
- `FileEditorProviders` interface from backend tells which providers support which mimes.

### New computed / UI

- `file-detail.component.ts`:
  - `isOffice = computed(() => isOnlyOfficeMime(this.file()?.mime))`
  - `activeViewer = signal<'pdf'|'office'>('pdf')` — used only when file is a PDF and user is writeable.
  - `canToggleToOffice = computed(...)` — true iff PDF + writeable + OnlyOffice-available-for-PDF.
  - `officeEmbedUrl = signal<string | null>(null)` — fetched on demand.

### Template

```html
@if (isOffice() || (isPdf() && activeViewer() === 'office')) {
  <iframe class="detail__iframe" [src]="officeEmbedUrl()" [title]="f.name"></iframe>
} @else if (isPdf()) {
  <iframe class="detail__iframe" [src]="previewUrl()" [title]="f.name"></iframe>
  @if (canToggleToOffice()) {
    <button class="detail__toggle-office" (click)="activeViewer.set('office')">
      <app-v2-icon name="pencil" [size]="14" />
    </button>
  }
}
```

## Tasks

1. Probe classic's OnlyOffice service signature, commit a small wrapper `utils/office.ts` with `isOnlyOfficeMime` + `fetchOfficeEmbedUrl`. ~80 LOC.
2. Wire `isOffice` + template iframe for office mimes. ~50 LOC.
3. Wire PDF → office toggle button + icon. ~40 LOC.
4. i18n ("Edit in OnlyOffice" / "View as PDF"). ~20 LOC.

## Manual test checklist

1. Open `.docx` → OnlyOffice loads in the stage; can edit.
2. Open `.xlsx` → OnlyOffice sheet view.
3. Open `.pdf` as read-only user → PDF.js, no toggle visible.
4. Open `.pdf` as writeable user → PDF.js + pen icon visible.
5. Click pen icon → OnlyOffice loads in edit mode.
6. Back-button or toggle to pdf view → returns to PDF.js.
7. Unknown office-ish mime → falls through to "Preview not available".

## Follow-ups (NOT here)

- Collabora adapter.
- Locally-running OnlyOffice in development (devcontainer).
- Inline commenting flow integrated with OnlyOffice comments.

## Open questions

1. **Detect OnlyOffice availability** — does the backend expose an endpoint like `GET /api/app/files/editors`? Or do we assume available and handle 404s gracefully? Need to check.
2. **Token lifetime / refresh** — OnlyOffice JWT usually expires; v2 should handle refresh on iframe reload.
3. **Which mime list counts as "office"?** Start with: application/vnd.openxmlformats-officedocument.*, application/msword, application/vnd.oasis.opendocument.*, application/vnd.ms-excel, application/vnd.ms-powerpoint.
