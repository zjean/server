# Sync-In v2 UI redesign — milestone 3 plan

**Status**: design approved, not yet implemented
**Date**: 2026-04-23
**Predecessor**: [2026-04-22-v2-ui-redesign-design.md](2026-04-22-v2-ui-redesign-design.md) (milestone 2, shipped in PRs #8–#14)

---

## 0 · What shipped in milestone 2

- `/v2` scaffold with design tokens, fonts, layout chrome (title bar, app rail, left nav, dock rail), `V2BreadcrumbService`, opt-in toggle in classic, sticky `localStorage` redirect.
- 57-icon set + Avatar, AvatarStack, FileGlyph, Logo, Pill, Button, IconButton primitives.
- `/v2/recents` with two-panel Files + Comments, editorial Instrument Serif greeting.
- `/v2/personal[/**]` list-view file browser wired to `${API_SPACES_BROWSE}/files/personal/…`.
- `/v2/viewer?path=…` image viewer with prev/next, fullscreen, info dock, keyboard shortcuts.

Every left-nav target other than those three routes renders a placeholder "Not migrated yet" screen with an "Open in classic UI" escape hatch. Milestone 3 replaces each placeholder with a real screen and wires the remaining app-rail entries.

## 1 · Scope

Ten screens / features to land, in ten PRs. Each is an independent feature branch off `main` (except where dependencies force stacking), merged squash.

| # | Branch | Scope | Est. LOC |
|---|---|---|---|
| 1 | `feat/v3-browser-grid-gallery` | Re-enable the grid + gallery toggles on `/v2/personal`; add `FileCardComponent` + `GalleryCardComponent`; persist mode via localStorage | ~350 |
| 2 | `feat/v3-spaces` | `/v2/spaces` index screen + four-tab Create Space modal | ~700 |
| 3 | `feat/v3-shared` | `/v2/shared/{with-me,with-others,via-links}` three sibling screens backed by existing shares services | ~600 |
| 4 | `feat/v3-trash` | `/v2/trash` with per-row Restore + bulk "Empty trash" | ~350 |
| 5 | `feat/v3-file-detail` | `/v2/file?path=…` full preview + right inspector (Info / Comments / Activity / Sharing), reuses `CommentsService` | ~700 |
| 6 | `feat/v3-transfers` | Transfers popover triggered from title-bar right-edge pill; consumes existing `FilesTasksService` | ~400 |
| 7 | `feat/v3-search` | `/v2/search` + AppRail "Search" entry enabled; wires `FilesService.search` | ~350 |
| 8 | `feat/v3-settings` | `/v2/settings` + AppRail entry enabled; account + security + app passwords + 2FA | ~600 |
| 9 | `feat/v3-people` | `/v2/people` + AppRail entry enabled; user directory with online-status avatars | ~400 |

A prerequisite docs PR (this file) lands first. All additions stay under `frontend/src/app/applications/custom-v2/`; only tiny `mod()` touches to upstream files are permitted (e.g. to enable a classic service's v2-consumable method).

## 2 · Dependencies and ordering

Most PRs are independent and can land in any order. Forced order:

- `feat/v3-transfers` **after** scaffold to add a `[titleBarRight]` slot consumer (trivial, but requires title-bar content projection already exists — it does, from PR #3).
- `feat/v3-shared` **after** `feat/v3-spaces` if we reuse a common "FileList" abstraction extracted during the spaces PR. Otherwise order-independent.
- `feat/v3-file-detail` **after** `feat/v3-browser-grid-gallery` so the detail "Previous / Next" navigator can walk siblings pulled from the same browser listing.

Nothing depends on PRs beyond the scaffold/chrome/primitives that shipped in milestone 2.

## 3 · Per-screen notes

### `feat/v3-browser-grid-gallery`

Re-enable the disabled grid + gallery segments in `PersonalComponent`. Adds two new view components backed by the same `filteredFiles()` signal:

- **Grid** (180px tiles, 108px header with FileGlyph + comment pill, filename + `<size> · <modified>` line).
- **Gallery** (240px cards, `aspect-ratio: 4/3` color-gradient header with glyph + type tag, name + modified footer). Matches `browser.jsx` lines 162–266.

Persist the chosen mode in `localStorage.ui.personal.viewMode` so return visits remember.

### `feat/v3-spaces`

Two halves:

- **Index**: table with columns Name / Quota / Members / Modified. Click navigates to `/v2/spaces/<alias>` (falls through to classic spaces browser for m3). Data from `SpacesService.listSpaces()`.
- **Create Space modal**: centered overlay, four tabs (Settings / Files / Members / Links), wired to the existing `SpacesService` creation endpoint. Settings tab is the minimum viable scope; Files / Members / Links tabs show their placeholder content per `spaces.jsx` and can be filled in follow-up work if needed. Submit button disabled until name + at least one manager are set.

### `feat/v3-shared`

Three screens under `/v2/shared/{with-me,with-others,via-links}`. Shared layout pattern: editorial header ("Shared · With me"), sticky column header, row grid (Name / Shared-by / Size / Modified / More). Backed by:

- **With me**: `SharesService.listSharedWithMe()` or equivalent (classic `shared.component.ts` calls API directly — we can reuse).
- **With others**: shares *you* own as a list with recipient avatars.
- **Via links**: link-based shares from `LinksService`.

If the classic UI reveals an existing shared API that returns a uniform shape, a thin adapter in `custom-v2/adapters/` reshapes it; otherwise the component queries the service directly.

### `feat/v3-trash`

`/v2/trash` wired to `${API_SPACES_BROWSE}/trash`. Toolbar: title + Restore + **Empty trash** (danger kind) + right-aligned item count. Rows show Name / Origin / Size / Deleted columns, dimmed (0.7 opacity) to signal trashed state. Per-row action menu for Restore + Delete permanently.

### `feat/v3-file-detail`

`/v2/file?path=…` renders a full file page:

- Toolbar: FileGlyph + filename + metadata monoline · Share / Download / Favorite primary + ghost buttons · prev/next of siblings · more menu.
- Preview stage: embeds the right viewer for the file type (image → v2 viewer inline; pdf → iframe to classic `API_FILES_OPERATION`; otherwise a download CTA).
- Right inspector (`info` / `comment` / `activity` / `shareTree` tabs from the dock rail — clicking a dock tab opens the inspector instead of the generic "Coming soon" panel for these specific tabs). Wired to `CommentsService` for threads; Info reuses the FileProps already loaded.

### `feat/v3-transfers`

Docked popover triggered by a "N tasks" pill rendered into the title bar's `[titleBarRight]` slot. Content from the existing `FilesTasksService.filesActiveTasks` + `clientSyncTasksCount` observables that the classic right-sidebar already consumes. Popover shows uploading + queued + done sections with per-row progress; "Clear done" action.

Positions as a fixed overlay below the title bar, 340px wide, dismissible by outside click or Esc.

### `feat/v3-search`

New screen at `/v2/search` with a prominent search input, result list using the `FileGlyph` + name + path pattern from Recents. Enables the AppRail "Search" entry (currently disabled). Ships as server-backed search using `FilesService.search(SearchFilesDto)`.

Cmd/Ctrl+K global shortcut registered on `LayoutV2Component` navigates to `/v2/search` and focuses the input.

### `feat/v3-settings`

`/v2/settings` with a left sub-nav (Account / Security / App passwords / Language / About), content panels for each. Enables the AppRail "Settings" entry. Account = existing user profile form fields; Security = 2FA enrollment / recovery codes (classic uses `user-profile.component.ts` dialog flow — reuse via same service methods, just new chrome); App passwords = list + generate.

### `feat/v3-people`

`/v2/people` directory with a left-aligned user list and a right-side profile panel when selected. Each row = Avatar (hue-coded by user id) + name + role pill + online status dot. Data from `StoreService.onlineUsers` / existing users API. Enables the AppRail "People" entry.

## 4 · Shared-across-milestone work

A few helpers may get factored out during the milestone:

- `custom-v2/components/empty-state.component.ts` — a generic empty-state card (icon + title + lede) currently duplicated in Recents and Personal. Extract when the third usage lands.
- `custom-v2/components/overlay.component.ts` — positioned dialog / popover host (used by Create Space modal, Transfers popover, any future dialog). Extracted in whichever PR first needs it (`feat/v3-spaces` or `feat/v3-transfers`).
- `custom-v2/utils/mime-to-glyph.ts` — already exists from PR #4; no changes expected.

Extraction PRs are not separate; they land inside the first PR that needs them.

## 5 · Risks and mitigations

- **Service surface gaps** — the handoff design assumed endpoints we may not have (e.g. "Shared with others" as a single list, transfers as a feed). *Mitigation*: spike each PR against the actual service at the start; trim the design rather than fabricate endpoints.
- **Growing component-style budget** — Angular's 8 kB per-component CSS budget already cost us once; the detail page has the most CSS. *Mitigation*: split long `styleUrls` as in PR #3, or raise the `anyComponentStyle` budget in `angular.json` via a `mod()` commit if it becomes the bottleneck twice.
- **Upstream drift** — milestone 3 is larger than milestone 2. Keep PRs small and merge promptly; never let a branch sit long enough for an upstream sync PR to collide.
- **i18n** — all new user-visible strings go through `l10nTranslate` with English-as-key (matches the fork's convention). Non-English locales get the keys in a follow-up translations PR; fallbacks render the English until then.

## 6 · What's next

- This document is approved; implementation follows PR sequence in §1.
- After milestone 3 lands, the remaining redesign work is polish + missing upstream features (search ranking, admin surfaces, electron chrome). A milestone-4 plan will be written only if upstream grows new user-visible features that need v2 treatment.
