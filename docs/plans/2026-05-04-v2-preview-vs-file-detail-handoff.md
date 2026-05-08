# V2 preview overlay vs file-detail screen — UX handoff

## Status

Investigation only. No code changes proposed in a PR yet — handoff doc per request.

## What the user observed

1. **"Click the comments icon on a file row → I get the *extended* preview dialog. Click the row itself → I get a smaller one with only some file info."**
2. **"Clicking Next in the dialog opens a new one *over* the existing — I have to click Close twice (or more) to dismiss everything."**

## Root cause #1 — two different open paths

There are two unrelated UIs that show file content + metadata in v2, and the row's two click affordances each open a different one:

| Trigger | Goes to | Component |
|---|---|---|
| Click anywhere on the row (and the file is *previewable*) | **Preview overlay** (small, sits over the current screen) | `custom-v2/preview/preview.component.*` (mode=`overlay`), opened via `PreviewOverlayService.open(...)` |
| Click the green comments-pill icon on the row | **File-detail screen** (full-width route at `/v2/file?path=…&tab=comment`) | `custom-v2/screens/file-detail/file-detail.component.*` |

The row click handler is `personal.component.ts:367 onRowClick` → `openEntry` → `previewOverlay.open(...)`.
The comments icon is wired at `personal.component.html:133` → `openComments` (`personal.component.ts:632`):

```ts
protected openComments(file: FileProps): void {
  if (file.isDir) return
  const segs = this.pathSegments().map((s) => s.path)
  const fullPath = [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs, file.name].join('/')
  this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath, tab: 'comment' } })
}
```

(Same pattern in `space-files.component.ts:618`.)

This was reasonable before #149: the preview overlay had no comments tab, so the icon had to take you to the heavier file-detail screen. After #149 the **preview overlay now has its own Comments tab**, so the comments-icon route is doubly bad — it's heavier *and* visually inconsistent with the regular row click.

### Recommended fix

Make `openComments` open the **preview overlay** with the comments tab pre-selected, instead of routing to the file-detail screen:

```ts
// New: PreviewOverlayService accepts a "default tab" hint
this.previewOverlay.open(fullPath, file, { initialTab: 'comments' })
```

Implementation sketch:

1. **`PreviewOverlayService.open(path, fileHint, opts?)`** — extend the signature to carry `{ initialTab?: 'info' | 'comments' }`. Stash the value on the service.
2. **`PreviewComponent`** — read the initial tab from the overlay service in `constructor` / on file load and call `this.infoTab.set(opts.initialTab)`. Make sure the info aside auto-opens when an explicit tab was requested (today the user has to click the info icon to even see the kv pane).
3. Update `openComments` callers in `personal.component.ts` and `space-files.component.ts` (and any other screen that has the comments-pill on a row) to call the overlay with `initialTab: 'comments'`. Drop the router-navigate to `/v2/file`.

Folders: `openComments` already early-returns for folders, so no change there.

The file-detail screen stays as the explicit "give me the full screen for this file" affordance — reachable via context menu / keyboard / direct URL — but it stops being the surprise destination of a single-click.

## Root cause #2 — file-detail Next pushes new history entries

`file-detail.component.ts:120-149`:

```ts
protected next(): void {
  const sibs = this.siblings()
  if (!sibs.length) return
  const idx = (this.currentIndex() + 1 + sibs.length) % sibs.length
  this.goTo(`${this.parentPath()}/${sibs[idx].name}`)
}

protected close(): void {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    this.router.navigate(['/', V2_PATH, V2_ROUTES.RECENTS])
  }
}

private goTo(path: string): void {
  this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path } })
}
```

`goTo` does **not** pass `replaceUrl: true`. Every Next click pushes a new entry onto the browser history stack. Then `close()` calls `window.history.back()`, which only walks back **one** entry — so the user has to click Close once per Next they pressed earlier to actually exit the file-detail screen.

The v2 preview overlay does not have this bug because its `goTo` (`preview.component.ts:247-253`) uses `replaceUrl: true` in standalone mode and uses the overlay service in overlay mode (which mutates URL state in place):

```ts
private goTo(path: string): void {
  if (this.mode() === 'overlay') {
    this.overlay.open(path, null)
  } else {
    this.router.navigate(['/', V2_PATH, V2_ROUTES.PREVIEW], { queryParams: { path }, replaceUrl: true })
  }
}
```

The user's "stacked dialogs" intuition is roughly right — what they're stacking are **history entries**, which the file-detail's `close()` walks through one at a time, looking like dialogs to dismiss.

### Recommended fix

In `file-detail.component.ts:148-150`, add `replaceUrl: true`:

```ts
private goTo(path: string): void {
  this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], {
    queryParams: { path },
    replaceUrl: true
  })
}
```

That's a one-line change. After the fix, prev/next mutates the URL in place; `close()` goes back to whatever screen the user came from (the file list), in a single click.

If fix #1 lands first, this still matters — direct deep-links to `/v2/file?path=…` are a real flow (open in new tab, share a link), and Next/Prev within that view should not balloon history.

## Files & line refs

| Concern | File | Line |
|---|---|---|
| Comments icon → file-detail (bad) | `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts` | 632 |
| Same in space view | `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts` | 618 |
| Comments-pill render | `personal.component.html` | 130-140 |
| Same in space view | `space-files.component.html` | 128 area |
| Preview overlay service (extend signature) | `custom-v2/preview/preview-overlay.service.ts` | full file ~138 lines |
| Preview consumes tab hint | `custom-v2/preview/preview.component.ts` | 109 (`infoTab`), 178 (effect that resets to 'info') |
| File-detail Next history bug | `custom-v2/screens/file-detail/file-detail.component.ts` | 148-150 |

## Reproduction

### #1 (UI inconsistency)

1. Open `/v2/personal`
2. Pick any non-folder file that has comments (green comment pill on the row)
3. Click *the comments pill* → full-width file-detail screen (URL: `/v2/file?path=…&tab=comment`)
4. Hit back, then *click anywhere else on the row* → small preview overlay (URL: `/v2/personal?preview=…`)

Two different UIs for "show me this file's comments" / "show me this file."

### #2 (close-twice)

1. Open any non-folder file via the comments pill (lands in file-detail screen)
2. Click Next 2-3 times to navigate to siblings
3. Click Close (the X)
4. Observe: you're back in file-detail on the previous file, not at the file list. Click Close again. Repeat until exhausted.

## Testing notes for whoever picks this up

- Both fixes are frontend-only, no backend changes.
- No existing unit tests for these components — manual smoke is the bar.
- Manual smoke checklist after fixes:
  - Click the comments pill on a row → preview overlay opens with the Comments tab active and the info aside expanded.
  - Click anywhere else on the row → preview overlay opens with Info tab active (current behavior preserved).
  - In `/v2/file?path=…` (direct deep-link), Prev/Next mutates the URL but does not stack history. Close exits in a single click.
- Run `npx ng lint` and `npx ng build --configuration development` from `frontend/` after the changes; both should stay clean.

## Out of scope here

- Fixing the comments-pill discoverability (e.g., a click target that isn't `event.stopPropagation()`'d).
- Whether the file-detail screen should still exist at all once the preview overlay handles its responsibilities. That's a bigger product call.
- Same bugs likely exist in `screens/space/space-files.component.*`, `screens/recents/recents.component.*`, etc. — the comments-pill pattern is mirrored across browse screens. Fix in one, then sweep the other callers in the same PR.
