# PDF.js Default Viewer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** PDFs always open in PDF.js by default; users with write permission and OnlyOffice available can switch to OnlyOffice via the pen icon in the viewer header.

**Architecture:** Remove the auto-redirect that routes PDFs to OnlyOffice when the user is writeable. Instead, introduce a local `activeViewer` signal in the dialog component that starts as `SHORT_MIME.PDF` and can be toggled to `SHORT_MIME.DOCUMENT` (OnlyOffice) via the header icon. The header icon becomes a clickable button only when the file is a PDF and OnlyOffice is available.

**Tech Stack:** Angular signals, `@switch` template control flow, FontAwesome icons

---

## Context

No frontend unit tests exist in this project — skip TDD for frontend changes. Backend is unchanged.

**Key files:**
- `frontend/src/app/applications/files/services/files.service.ts` — `viewerHook()` at line 354
- `frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.ts`
- `frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.html`

---

### Task 1: Remove the PDF-to-OnlyOffice redirect in `viewerHook`

**Files:**
- Modify: `frontend/src/app/applications/files/services/files.service.ts:354-357`

**Step 1: Remove the redirect block**

In `viewerHook`, delete these 3 lines:
```typescript
if (isWriteable && file.shortMime === SHORT_MIME.PDF && file.isEditable) {
  return SHORT_MIME.DOCUMENT
}
```

After the removal, `viewerHook` should look like:
```typescript
private async viewerHook(file: FileModel, isWriteable = false): Promise<string> {
  if (file.shortMime === SHORT_MIME.TEXT) {
    if (file.size < MAX_TEXT_FILE_SIZE) {
      return SHORT_MIME.TEXT
    }
    // Download if too large
    throw new Error('No editor found')
  }
  return file.shortMime
}
```

Note: the `isWriteable` parameter becomes unused — remove it from the signature and the two call sites:
- Signature: `private async viewerHook(file: FileModel): Promise<string>`
- Call site at line 298: `hookedShortMime = await this.viewerHook(file)` (remove `isWriteable` arg)

**Step 2: Commit**
```bash
git add frontend/src/app/applications/files/services/files.service.ts
git commit -m "fix(frontend:files): remove pdf-to-onlyoffice redirect in viewerHook"
```

---

### Task 2: Add `activeViewer` signal and toggle logic to the dialog component

**Files:**
- Modify: `frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.ts`

**Step 1: Add `activeViewer` signal**

Replace:
```typescript
@Input({ required: true }) hookedShortMime: string
```
with:
```typescript
@Input({ required: true }) hookedShortMime: string
protected activeViewer = signal<string>('')
```

**Step 2: Initialize `activeViewer` in `ngOnInit`**

Add this line at the start of `ngOnInit()`:
```typescript
this.activeViewer.set(this.hookedShortMime)
```

So `ngOnInit` becomes:
```typescript
ngOnInit() {
  this.activeViewer.set(this.hookedShortMime)
  this.isReadonly.set(this.mode === FILE_MODE.VIEW)
  this.openedFile = { id: this.currentFile.id, name: this.currentFile.name, mimeUrl: this.currentFile.mimeUrl }
  this.onResize()
}
```

**Step 3: Add `canToggleViewer` computed and `toggleViewer()` method**

Add after the existing `protected directoryImages = computed(...)` line:
```typescript
protected canToggleViewer = computed(
  () => this.isWriteable && this.currentFile?.isEditable && this.currentFile?.shortMime === SHORT_MIME.PDF
)
```

Add the toggle method before `ngOnDestroy()`:
```typescript
protected toggleViewer(): void {
  if (this.activeViewer() === SHORT_MIME.PDF) {
    this.editorProvider.onlyoffice = true
    this.activeViewer.set(SHORT_MIME.DOCUMENT)
    this.isReadonly.set(false)
  } else {
    this.activeViewer.set(SHORT_MIME.PDF)
    this.isReadonly.set(true)
  }
}
```

**Step 4: Fix `onClose` to use `activeViewer()` instead of `hookedShortMime`**

Replace:
```typescript
if (this.currentFile.isEditable && this.hookedShortMime === SHORT_MIME.TEXT) {
```
with:
```typescript
if (this.currentFile.isEditable && this.activeViewer() === SHORT_MIME.TEXT) {
```

**Step 5: Commit**
```bash
git add frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.ts
git commit -m "feat(frontend:files): add activeViewer signal and toggleViewer to pdf dialog"
```

---

### Task 3: Update the dialog template

**Files:**
- Modify: `frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.html`

**Step 1: Switch on `activeViewer()` instead of `hookedShortMime`**

Replace:
```html
@switch (hookedShortMime) {
```
with:
```html
@switch (activeViewer()) {
```

**Step 2: Make the header icon a toggle button for PDFs**

Replace the current static icon in the header:
```html
<fa-icon [icon]="isReadonly() ? icons.faEye : icons.faPen"></fa-icon>
```
with a conditional: plain icon for non-toggleable files, clickable button for PDF with OnlyOffice:
```html
@if (canToggleViewer()) {
  <button (click)="toggleViewer()" class="btn btn-link p-0 text-white" type="button" [attr.aria-label]="isReadonly() ? 'Edit in OnlyOffice' : 'View in PDF.js'">
    <fa-icon [icon]="isReadonly() ? icons.faEye : icons.faPen"></fa-icon>
  </button>
} @else {
  <fa-icon [icon]="isReadonly() ? icons.faEye : icons.faPen"></fa-icon>
}
```

**Step 3: Commit**
```bash
git add frontend/src/app/applications/files/components/dialogs/files-viewer-dialog.component.html
git commit -m "feat(frontend:files): make pdf viewer header icon toggle between pdf.js and onlyoffice"
```

---

## Manual Testing Checklist

After all tasks, verify in the browser:

1. **PDF, read-only user** — PDF opens in PDF.js, no toggle icon visible
2. **PDF, write permission, OnlyOffice disabled** — PDF opens in PDF.js, no toggle icon visible  
3. **PDF, write permission, OnlyOffice enabled** — PDF opens in PDF.js, eye icon is clickable
4. **Click pen icon on PDF** — switches to OnlyOffice, pen icon shown
5. **Click eye icon while in OnlyOffice (PDF)** — switches back to PDF.js, eye icon shown
6. **Non-PDF document (docx)** — still opens directly in OnlyOffice as before
7. **Image/media/text files** — unaffected
