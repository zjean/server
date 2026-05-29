# v2 folder size action — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `●` placeholder rendered in the size column of v2 folder rows pressable, and add a parallel "Calculate size" entry to the row context menu, so the user can compute and see the recursive byte total of a folder on demand. Closes [#253](https://github.com/zjean/server/issues/253).

**Architecture:** Backend already exposes `GET /spaces/operation/getSize/<path>` returning `{ size: number }` (recursive walk; see `backend/src/applications/files/services/files-manager.service.ts:784`). The classic UI lazy-calls it from the sidebar (`frontend/src/app/applications/files/services/files.service.ts:246`). v2 will reuse the same `FilesService.getSize(file)` method via a new tiny `FolderSizeService` that owns a `WritableSignal<Map<fileId, FolderSizeState>>` cache, so both `personal` and `space-files` screens render the same loading/result UI without duplicating state. The `●` in the row template becomes a button bound to `folderSize.compute(file)`; the row's size cell renders from `folderSize.state(file.id)`. A menu item with the same handler appears for folders only.

**Tech Stack:** Angular 19 standalone components with signal-based state, existing `FilesService` (RxJS Observable), `ToastService`, `app-v2-icon` / `app-v2-icon-btn`, `toBytes` pipe, angular-l10n.

**Scope decisions (intentional):**

- Only `personal` and `space-files` screens get the action. `trash-bin` keeps its `●` static — folder-size in a trash bin is a weird ask and the trash data model uses different ids/paths; out of scope.
- No spec files. There is no existing test infrastructure for any component under `frontend/src/app/applications/custom-v2/`; introducing it here would be scope creep. Verification is by browser smoke (v2-dev-loop-verify skill).
- Cache lives in-memory only, keyed by `file.id`, cleared on folder navigation. Not persisted — folder contents change, recomputation is cheap, and there's no good cache-invalidation signal from the backend.
- No new column. The result replaces the `●` in-place within the existing `.file-row__size` cell.

---

## Task 1 — Add the `FolderSizeService` (shared state)

**Files:**
- Create: `frontend/src/app/applications/custom-v2/services/folder-size.service.ts`

**Step 1: Read the contract source**

Skim before coding:
- `frontend/src/app/applications/files/services/files.service.ts:246-248` — confirm signature `getSize(file: FileModel): Observable<number>`.
- `frontend/src/app/applications/custom-v2/components/toast.service.ts` — confirm `error()` signature for error path.

**Step 2: Write the service**

```typescript
import { HttpErrorResponse } from '@angular/common/http'
import { Injectable, inject, signal } from '@angular/core'
import { FilesService } from '../../files/services/files.service'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { ToastService } from '../components/toast.service'
import { buildFileModelStub } from '../utils/file-model-stub'

export type FolderSizeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; bytes: number }
  | { status: 'error' }

const IDLE: FolderSizeState = { status: 'idle' }

@Injectable({ providedIn: 'root' })
export class FolderSizeService {
  private readonly filesService = inject(FilesService)
  private readonly toast = inject(ToastService)

  private readonly map = signal<ReadonlyMap<number, FolderSizeState>>(new Map())

  state(fileId: number): FolderSizeState {
    return this.map().get(fileId) ?? IDLE
  }

  // `fullPath` must be the full server path (`<repository>/<alias>/<segments>/<name>`),
  // not `FileProps.path` (DB-relative). `FilesService.getSize` builds the request URL
  // from `path`, so the v2 caller must assemble the full path the same way other
  // FilesService calls do — see `buildFileStub` in personal.component.ts.
  compute(file: FileProps, fullPath: string): void {
    if (!file.isDir) return
    const current = this.map().get(file.id)
    if (current?.status === 'loading' || current?.status === 'done') return
    this.set(file.id, { status: 'loading' })
    const stub = buildFileModelStub(file, fullPath)
    this.filesService.getSize(stub).subscribe({
      next: (bytes: number) => this.set(file.id, { status: 'done', bytes }),
      error: (e: HttpErrorResponse) => {
        this.set(file.id, { status: 'error' })
        this.toast.error(e.error?.message ?? 'Size calculation failed')
      }
    })
  }

  clear(): void {
    if (this.map().size === 0) return
    this.map.set(new Map())
  }

  private set(id: number, state: FolderSizeState): void {
    const next = new Map(this.map())
    next.set(id, state)
    this.map.set(next)
  }
}
```

**Step 3: Commit**

```bash
git add frontend/src/app/applications/custom-v2/services/folder-size.service.ts
git commit -m "feat(custom-v2): add FolderSizeService for on-demand folder-size calc

Tiny signal-backed cache wrapping FilesService.getSize so per-row size
state survives component re-renders and can be shared between v2 list
screens. Refs #253."
```

---

## Task 2 — Wire `personal` screen: TS

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts` — inject service, expose helper, add menu item, clear cache on folder nav.

**Step 1: Read the area**

- Current injects at `personal.component.ts:106-113`.
- `menuItems` computed at `personal.component.ts:211-239`.
- `loadFiles()` is called on URL navigation in `ngOnInit` at the `route.url.subscribe(...)` block — find it (grep `loadFiles()`).

**Step 2: Inject the service**

Add alongside the existing injects (after `private readonly filesService = inject(FilesService)` at line ~106):

```typescript
private readonly folderSize = inject(FolderSizeService)
```

Add the import at the top:

```typescript
import { FolderSizeService } from '../../services/folder-size.service'
```

**Step 3: Expose two helpers used by the template**

Add as protected methods anywhere in the class body (e.g. near the other small helpers around `mimeToGlyph`):

```typescript
protected folderSizeState(fileId: number) {
  return this.folderSize.state(fileId)
}

protected calculateFolderSize(file: FileProps): void {
  // Mirror the path-building done in `buildFileStub` so FilesService.getSize
  // receives the full server path it needs to construct the URL.
  const fullPath = buildSpaceFilePath(
    SPACE_REPOSITORY.FILES,
    SPACE_ALIAS.PERSONAL,
    this.pathSegments().map((s) => s.path),
    file.name
  )
  this.folderSize.compute(file, fullPath)
}
```

**Step 4: Add the menu item**

In the `menuItems` computed array (currently lines 215-238), insert a new entry after `'rename'` and before `'copy'` (so destructive/move actions stay grouped at the bottom):

```typescript
{
  id: 'size',
  label: 'Calculate size',
  icon: 'calculator',
  disabled: !f.isDir,
  action: () => this.calculateFolderSize(f)
},
```

Verify `'calculator'` exists as an `app-v2-icon` name — grep:

```bash
grep -rn "calculator" frontend/src/app/applications/custom-v2/components/icon/
```

If it doesn't exist, fall back to `'sigma'` if present, else use `'eye'` temporarily and flag in the PR description for an icon decision. Don't invent a new SVG in this PR.

**Step 5: Clear cache on folder navigation**

The `route.url.subscribe` block at the top of `ngOnInit` already triggers `loadFiles()` whenever the path changes. Add a `this.folderSize.clear()` line right next to `this.clearSelection()` so any cached folder-size results from the previous folder don't leak into the next view.

```typescript
this.urlSubscription = this.route.url.subscribe(() => {
  this.syncBreadcrumbs()
  this.clearSelection()
  this.folderSize.clear()
  this.loadFiles()
})
```

**Step 6: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts
git commit -m "feat(custom-v2): personal screen — wire FolderSizeService + menu entry

Refs #253."
```

---

## Task 3 — Wire `personal` screen: template + styles

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.html:145-151` (the `.file-row__size` block).
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.scss` (style the new button).

**Step 1: Replace the static dot with a button**

Current block (lines 145-151):

```html
<div class="file-row__size">
  @if (!f.isDir) {
    {{ f.size | toBytes: 1 : true }}
  } @else {
    ●
  }
</div>
```

Replace the `@else` branch so the dot becomes a per-state button:

```html
<div class="file-row__size">
  @if (!f.isDir) {
    {{ f.size | toBytes: 1 : true }}
  } @else {
    @let s = folderSizeState(f.id);
    @switch (s.status) {
      @case ('done') {
        <span class="file-row__size-value">{{ s.bytes | toBytes: 1 : true }}</span>
      }
      @case ('loading') {
        <span class="file-row__size-loading" aria-live="polite">…</span>
      }
      @default {
        <button
          type="button"
          class="file-row__size-trigger"
          (click)="$event.stopPropagation(); calculateFolderSize(f)"
          [attr.title]="'Calculate size' | translate: locale.language"
          [attr.aria-label]="'Calculate size' | translate: locale.language"
        >
          ●
        </button>
      }
    }
  }
</div>
```

Notes:
- `$event.stopPropagation()` is required — the parent `<button class="file-row">` (line 115) would otherwise swallow the click as a row activation. Mirror the pattern at line 123 (`(click)="$event.stopPropagation(); toggleSelection(f)"`).
- `@let` is Angular 19 control flow. If the codebase uses `@let` already, confirm it parses cleanly; if not, hoist to a local `const` via a small accessor method (`folderSizeState(f.id)` called twice is also fine — the signal read is cheap).
- The `●` is intentionally preserved as the idle glyph for visual continuity with the current UI.

**Step 2: Add minimal styles**

Append to `personal.component.scss`:

```scss
.file-row__size-trigger {
  background: transparent;
  border: 0;
  padding: 0 4px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  line-height: inherit;
  border-radius: 4px;
  opacity: 0.55;
  transition: opacity 120ms ease;

  &:hover,
  &:focus-visible {
    opacity: 1;
    background: var(--v2-hover-bg, rgba(0, 0, 0, 0.06));
  }
}

.file-row__size-loading {
  opacity: 0.6;
  letter-spacing: 1px;
}
```

**Verify the colour token:** grep for `--v2-hover-bg` in `custom-v2/`. If it doesn't exist, pick the closest token already used in the file (`personal.component.scss` likely has hover styles for `.file-row` — copy the exact rgba/var). Don't introduce a new token in this PR.

**Step 3: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/personal/personal.component.{html,scss}
git commit -m "feat(custom-v2): personal screen — clickable folder size dot

Replaces the static ● placeholder with a button that triggers
FolderSizeService.compute and renders the result in-place. Refs #253."
```

---

## Task 4 — Wire `space-files` screen (parity)

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.html` (around line 143-147, the same `.file-row__size` block).
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.scss` (append the same two style blocks).

**Step 1: Mirror Task 2 in space-files.component.ts**

Same changes:

1. Import `FolderSizeService` and inject it alongside `FilesService`.
2. Add `folderSizeState(id)` and `calculateFolderSize(f)` helpers. In `calculateFolderSize`, build `fullPath` using `buildSpaceFilePath` with the **space-files** repository/alias (NOT `SPACE_ALIAS.PERSONAL` as in the personal screen — read the existing `buildFileStub` equivalent in this component to see the correct args).
3. Insert the `{ id: 'size', label: 'Calculate size', ... }` menu item in the same position relative to rename/copy.
4. Call `this.folderSize.clear()` wherever `loadFiles()` is invoked on path change. Grep for the equivalent navigation subscription.

**Step 2: Mirror Task 3 in space-files.component.html**

Same template swap for the `@else { ● }` block.

**Step 3: Mirror Task 3's SCSS append**

Same two style blocks.

**Step 4: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/space/space-files.component.{ts,html,scss}
git commit -m "feat(custom-v2): space-files screen — clickable folder size dot

Mirrors personal screen wiring of FolderSizeService. Refs #253."
```

---

## Task 5 — i18n keys

**Files:**
- Modify: `frontend/src/i18n/custom/en.json`
- Modify: `frontend/src/i18n/custom/nl.json`

**Step 1: Add identity-mapped EN keys**

Add to `en.json` (top-level object, alphabetical-ish — sort by inspecting current order):

```json
"Calculate size": "Calculate size",
"Size calculation failed": "Size calculation failed",
```

**Step 2: Add NL translations**

Add to `nl.json`:

```json
"Calculate size": "Mapgrootte berekenen",
"Size calculation failed": "Berekening van grootte mislukt",
```

(Phrasing — "Bereken grootte" is the literal imperative, but "Mapgrootte berekenen" (folder-size calculate) reads more natural in NL UI labels. Use the imperative form `Bereken grootte` if you prefer concision; either is fine — match whatever the rest of the bundle uses for similar action labels by skimming `nl.json` for verb forms.)

**Step 3: Validate JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('frontend/src/i18n/custom/en.json','utf8')); console.log('ok')"
node -e "JSON.parse(require('fs').readFileSync('frontend/src/i18n/custom/nl.json','utf8')); console.log('ok')"
```

Expected: `ok` from both.

**Step 4: Commit**

```bash
git add frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(custom-v2): i18n keys for folder-size action

Refs #253."
```

---

## Task 6 — Browser verification (REQUIRED SUB-SKILL: v2-dev-loop-verify)

Use the `v2-dev-loop-verify` skill to:

1. Start the local dev server.
2. Log in (`sync-in` / `password`).
3. Switch to v2 (`/#/v2/files/personal` or the "Probeer de nieuwe UI" toggle).
4. Verify the **personal** screen:
   - Folder rows show `●` (idle).
   - Click `●` → it briefly shows `…` → renders the byte total via `toBytes` (e.g. `12.5 MB`).
   - The row-click handler does NOT fire (no navigation into the folder when clicking the dot).
   - Right-click → menu shows "Calculate size" enabled for folders, disabled for files.
   - Menu-trigger path produces the same result as the inline button.
   - Navigate into a sub-folder and back → previous folder's sizes are forgotten (reset on nav).
   - Error path: temporarily rename the folder on disk to provoke a 404, click `●`, confirm error toast and that the row reverts to `●` (state goes `loading` → `error` → next click retries).
5. Repeat all checks on a **space** screen (`/#/v2/files/spaces/<some-space>`).
6. Capture two screenshots (one of a computed size, one of the right-click menu open) and attach them to the PR description.

**Do not skip this step.** v2 design-token bugs are only catchable in the browser.

---

## Task 7 — Open the PR

Use the `tackle-issues` skill conventions:

```bash
gh pr create --repo zjean/server --base main --head feat/v2-folder-size-action \
  --title "feat(custom-v2): clickable folder-size dot + 'Calculate size' menu item" \
  --body "$(cat <<'EOF'
## Summary
- The `●` placeholder rendered in the size column of v2 folder rows is now a button that triggers a recursive folder-size calculation, replacing itself with the human-readable byte total when done.
- Mirror action available from the row's context menu as "Calculate size".
- Backend endpoint already exists (`GET /spaces/operation/getSize/*`, used by the classic sidebar); no backend changes.

## Implementation
- New `FolderSizeService` (`custom-v2/services/folder-size.service.ts`) — signal-backed cache keyed by `file.id`, calls existing `FilesService.getSize`. Cleared on folder navigation.
- Wired into both `personal` and `space-files` screens. Trash-bin intentionally not in scope.

## Test plan
- [x] Personal screen: click `●` on a folder → loading state → byte total renders inline.
- [x] Space screen: same.
- [x] Menu entry "Calculate size" enabled for folders, disabled for files; identical effect to the inline button.
- [x] Navigation clears the cache (previous folder's results don't leak).
- [x] Error toast on 404.
- [x] Screenshots attached.

Closes #253.
EOF
)"
```

Squash and merge when CI is green and review is resolved.

---

## Risks / followups (NOT in this PR)

- The same dot lives in `trash-bin.component.html:77`. Out of scope; can ship as a follow-up if requested.
- The `FileProps` cast to `FileModel` in `FolderSizeService.compute` papers over a type mismatch between the v2 wire shape and the classic `FileModel`. Long term, `FilesService.getSize` should accept `Pick<FileModel, 'path'>`. Out of scope for #253.
- No unit tests for the service. Adding spec infrastructure for v2 is a separate, larger PR.
