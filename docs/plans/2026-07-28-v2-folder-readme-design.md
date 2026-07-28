# Design — Folder readme banner in `custom-v2` (zjean/server fork)

- **Status:** Accepted
- **Date:** 2026-07-28
- **Scope:** `frontend/src/app/applications/custom-v2` only. **No backend changes.** No upstream files touched.
- **Modelled on:** Nextcloud's "Rich Workspaces" (the `nextcloud/text` app), deliberately diverging on two points — see §8.

All `file:line` citations were verified against `main` at commit `aa0648a1` on 2026-07-28.

---

## Context

In the v2 UI, a folder's `README.md` is just another row. Nextcloud renders it above the listing as a folder
description with an inline editor, which turns a folder into something self-documenting. We want the same, without
inventing a second markdown pipeline and without a backend endpoint.

Three facts about the existing code decide almost every choice below:

1. **A full markdown editor already exists in v2.** `custom-v2/preview/markdown-view.component.ts` (767 lines) is a
   TipTap WYSIWYG editor with a CodeMirror source mode, a formatting toolbar, and a complete lock → load → save →
   unlock lifecycle. TipTap is already in the v2 bundle (every route in `v2.routes.ts` is eagerly imported), so
   reusing it costs no bundle weight.
2. **The browse response already carries everything detection needs.** `SpaceFiles`
   (`backend/src/applications/spaces/interfaces/space-files.interface.ts:3-7`) is `{ files: FileProps[]; hasRoots:
   boolean; permissions: string }`. The readme is already in `files[]` and the permission string is already there.
   Detection is a pure function over data the screen has loaded — no request, no endpoint.
3. **The host screens are not destroyed when you change folders.** `PersonalComponent` reloads in place from a
   `route.url` subscription (`personal.component.ts:327`); `SpaceFilesComponent` does the same from
   `combineLatest([route.params, route.url])` (`space-files.component.ts:311`). This is the single most dangerous
   fact in this design — see §5.

---

## 1. Component shape

One self-contained component, plus one pure helper:

| Path | Role |
|---|---|
| `custom-v2/utils/folder-readme.ts` | `pickFolderReadme(files): FileProps \| null` — pure, no I/O |
| `custom-v2/components/folder-readme.component.ts` | `<app-v2-folder-readme>` — the banner |

**Decision.** The banner takes three inputs and derives everything else:

```ts
readonly dirPath = input.required<string>()      // e.g. 'files/personal/docs'
readonly files = input.required<FileProps[]>()   // the array the screen already loaded
readonly permissions = input.required<string>()  // SpaceFiles.permissions, verbatim
```

**Rationale.** The two host screens are ~1100-line near-duplicates (`personal.component.ts` 1114,
`space-files.component.ts` 1130). Every fact this feature needs is already in their local state, so the integration
cost per screen is one template line plus a `case` in each of its new-entry dispatchers — two for `personal`, one for
`space-files`, for the reason in §6. Nothing about readmes leaks into either screen. `dirPath` is passed as a pre-joined string because each screen already builds that
prefix its own way — `personal` from `SPACE_ALIAS.PERSONAL` + segments, `space-files` from the route `alias` — and
`buildSpaceFilePath` (`custom-v2/utils/file-model-stub.ts`) already exists for it.

---

## 2. Detection

**Decision.** `pickFolderReadme` returns the first non-directory entry matching, in order:

```
Readme.md    README.md    readme.md
```

Exact-case comparison. No match → `null` → the banner renders nothing.

**Rationale.** This is Nextcloud's list and its precedence order, from
`nextcloud/text` `lib/Service/WorkspaceService.php` (`SUPPORTED_STATIC_FILENAMES`), minus two entries:

- **`.Readme.md` (hidden) is dropped.** `spaces-browser.service.ts:137` skips any entry whose name starts with `.`
  unless `configuration.applications.files.showHiddenFiles` is set, and that defaults to `false`
  (`files.config.ts:229`). A hidden readme is therefore *not in `files[]`* on a default server, so supporting it
  would mean either a backend endpoint or a speculative `GET` that 404s on every folder without one. Neither is worth
  it. **Consequence to accept knowingly:** on a server with `showHiddenFiles = true`, a `.Readme.md` shows as an
  ordinary row and is *not* promoted to the banner.
- **The l10n-translated `Readme.md` variant is dropped.** Upstream prepends `$l10n->t('Readme') . '.md'` to the list.
  Nobody names the file `Leesmij.md`, and we ship only `en` + `nl`.

The `isDir` exclusion matters: a *directory* called `README.md` is legal, and upstream guards against exactly this
(`$cacheEntry->getMimeType() !== ICacheEntry::DIRECTORY_MIMETYPE`).

The readme also **stays a normal row in the listing** — renaming and deleting it must remain reachable. Same as NC.

---

## 3. Writeability

**Decision.** Copy classic's contract verbatim:

```ts
writeable = permissions.includes(SPACE_OPERATION.MODIFY) && !readme.lock?.isExclusive
```

When false, no Edit button renders.

**Rationale.** This is exactly `frontend/src/app/applications/files/services/files.service.ts:314` — the
classic-UI-as-ground-truth rule in `CLAUDE.md` applies, and this is the one place the backend's permission convention
is expressed on the client. `SPACE_OPERATION.MODIFY` is `'m'` (`spaces/constants/spaces.ts:6-10`); the permission
string is a `:`-joined operation list, so `includes` is the established test.

**Pre-existing gap, deliberately not fixed here.** `file-detail.component.html:61` mounts
`<app-v2-preview-markdown-view [path] [file]>` without `isWriteable`, which defaults to `true`
(`markdown-view.component.ts:456`). In a read-only space, v2's file-detail therefore presents an editable-looking
markdown editor and relies on the lock call or the upload 403ing. That is a separate bug on a separate surface; this
design only ensures the banner does not inherit it.

---

## 4. Read-only render, and the swap into edit mode

**Decision.** Two distinct modes, never both mounted:

- **Read mode (default).** The banner owns **one** TipTap `Editor` with `editable: false`, constructed once in the
  component and fed via `setContent` whenever the resolved readme changes. Extension set copied from
  `markdown-view.component.ts:459-471` (StarterKit, TaskList/TaskItem, TableKit, Image, Markdown).
- **Edit mode.** Clicking Edit unmounts the read-only render and mounts the existing `MarkdownViewComponent` with
  `isWriteable=true`.

Content in read mode is one `GET` of the stub's `dataUrl` per resolved readme, built with `buildFileModelStub(props,
fullPath)` (`custom-v2/utils/file-model-stub.ts`) — the same call `markdown-view` makes at line 693. **No caching:** a
readme is a couple of KB, and a stale folder description is worse than a round-trip.

**Rationale.**

*Why TipTap for read mode rather than a lightweight markdown-to-HTML renderer.* Read mode and edit mode then render
through the identical pipeline, so clicking Edit does not reflow the text. It also adds no dependency. Nextcloud
reached the same conclusion — their read-only `RichTextReader` is the same editor in disabled state
(`nextcloud/text` `src/views/RichWorkspace.vue`).

*Why the editor is constructed once, not per folder.* Because the host screen survives folder navigation (§context
fact 3), the banner instance does too. One `Editor` per screen lifetime, content swapped on navigation — instead of a
ProseMirror construction on every folder visit.

*Why `MarkdownViewComponent` is reused as-is for edit mode, rather than extracted or reimplemented.* It already does
the entire job, including the parts that are easy to get wrong: it acquires an exclusive lock in `openFile`
(`markdown-view.component.ts:692`), unlocks in `ngOnDestroy` (:517-526), and confirms discard of unsaved changes in
`canClose` (:668). Reimplementing a slim inline editor would duplicate that lifecycle — the third copy of it in the
codebase. **And its lock-on-open, which would be wrong for a component that mounts on every folder visit, is exactly
right for one that only ever mounts after a deliberate Edit click.**

**Two additive changes to `markdown-view.component.ts`**, both defaulted so `file-detail` is bit-for-bit unaffected:

| Change | Why |
|---|---|
| `inline = input(false)` | Renders a Cancel/Done control, and relaxes the full-stage sizing: `:host { height: 100% }` (:243) and `.md-view__source { position: absolute; inset: 0 }` (:334) assume a filling parent. |
| `(done)` output | Cancel routes through the component's **existing** `canClose()` confirm, so the unsaved-changes prompt is not reimplemented in the banner. The banner cannot read `isModified` itself — it is `protected`. |

The banner wraps the editor in a fixed-height container so the inner `height: 100%` resolves.

---

## 5. The lock-leak trap

**This is the failure mode most likely to reach a green build.**

`PersonalComponent` and `SpaceFilesComponent` reload in place on folder change (`personal.component.ts:327`,
`space-files.component.ts:311`) — **for hops that stay within one route config.**

**Correction, measured during Task 4 (2026-07-28):** they were *not* reused for every hop. `v2.routes.ts` registered
each browse screen under **two** child configs — `{ path: '' }` and `{ path: '**' }` — both pointing at the same
component, so root↔subfolder navigation crossed configs and Angular destroyed and recreated the screen. The lock
invariant survived that (the embedded editor's own `ngOnDestroy` still unlocked), but the auto-save teardown never ran,
so an unsaved edit was silently lost on exactly that hop. Fixed by collapsing each screen to a single wildcard route
entry, which makes the reuse premise true uniformly. Without that fix the feature's save behaviour would have looked
random to a user: identical mid-edit navigation saving or discarding depending on whether the hop happened to cross a
route boundary.

With one route entry per screen, the screens are **not** destroyed on folder change, so:

- `MarkdownViewComponent.ngOnDestroy` — the only thing that releases the lock — **does not fire** when the user walks
  to another folder while editing.
- `CloseGuardService` does not help. It is a single-slot manual guard (`custom-v2/preview/close-guard.service.ts`)
  that only `file-detail`'s `close()` consults. It is not a router guard and registering the banner into it would
  clobber whatever `file-detail` put there.

**Decision (revised 2026-07-28, during implementation — supersedes the original prompt-on-navigate design).** The
banner resets explicitly on `dirPath` change: it **auto-saves** any pending edit, then unmounts
`MarkdownViewComponent`, whose `ngOnDestroy` releases the lock.

**Why not the prompt this section originally specified.** Prompting requires the ability to *cancel*, and folder
navigation cannot be cancelled here — by the time `dirPath` changes, the host screen has already reloaded (that is
the very fact this section is about). A discard prompt would therefore offer a "stay" choice it cannot honour, and
taking that choice leaves the editor mounted while `readme()` has already re-resolved to the next folder's file,
so `markdown-view` re-opens a different file with unsaved content pending. The decline branch produces a broken
state, not merely a misleading one. `requestClose()` still guards the **Cancel button**, where a decline *can* be
honoured because nothing has navigated.

Maintainer's ruling was auto-save over discard-with-toast. The trade accepted: navigating away commits text the user
never explicitly saved, which for a folder description is visible to everyone with access to the folder. On save
failure the lock is released anyway and the loss is reported — a stale exclusive lock harms every other user of the
folder, so it is the greater harm.

**Two mechanisms make this safe, and both are load-bearing:**

1. **The editor's target is frozen when edit mode opens** (`editTarget`), not derived from `readme()`. Without this,
   `dirPath` changing mid-save swings the editor's `[path]`/`[file]` bindings to the *new* folder's readme, and the
   in-flight save can land in the wrong file. Writing folder A's description into folder B is the worst outcome this
   feature can produce.
2. **`saveNowIfModified()` never throws** and reports `'clean' | 'saved' | 'failed'`, because its caller is mid-
   teardown and must complete the unmount either way.

**Rationale.** A leaked exclusive lock on a readme is silent for the user who leaked it and total for everyone else —
the next person to open that folder gets a permanently read-only banner attributed to a colleague who has moved on.
This is the same class of bug as the `filesLockManager.create`-vs-`createOrRefresh` trap recorded in `CLAUDE.md`.

---

## 6. Creating a readme

**Decision.** A `new-folder-description` entry in the existing New menu, hidden when the folder already has a readme.
It creates `Readme.md` with **no name prompt** and enters edit mode directly — no navigation away from the folder.

Touch points — **three** dispatch sites, not four, because the two screens are asymmetric here:
`space-files.onFabSheetSelect` (:854) delegates to `dispatchNewEntry`, whereas `personal.onFabSheetSelect` (:1012)
duplicates the entire `switch`. Miss that and the mobile FAB entry is dead on exactly one of the two screens.

| Site | Change |
|---|---|
| `custom-v2/screens/files/new-entry-menu.ts` | one entry in `buildNewEntryMenu` + one in `buildNewEntrySheetItems`, and `NewEntryId` gains `'new-folder-description'` |
| `personal.component.ts:817` `dispatchNewEntry` | one `case` |
| `personal.component.ts:1012` `onFabSheetSelect` | one `case` (duplicated switch) |
| `space-files.component.ts:820` `dispatchNewEntry` | one `case` — covers its FAB too |

Creation reuses the path `newMarkdownFile` already takes (`personal.component.ts:943-961`): `filesService.make('file',
'Readme.md', dirPath, true)` — which creates an **empty** file, `asCallBack: true` meaning "return the observable
rather than self-subscribing" (`files.service.ts:163-177`) — then `refresh()`. It diverges in two ways: no
`promptDialog` (the name is fixed), and no `router.navigate` to file-detail (we want the banner, in place).

**Rationale.** Current Nextcloud renders nothing at all in a folder without a readme and puts discovery in the `+`
menu; a permanent "Add a folder description…" strip above every writeable folder would be more discoverable at the
cost of chrome on every listing forever. The menu entry costs ~6 lines and adds nothing to the default view.

---

## 7. Layout, collapse, and placement

**Decision.**

- Banner sits between the screen toolbar and the list container.
- **Hidden while a filter is active.** Filtering is a find-in-folder action; it wants rows, not prose.
- Collapsed to `max-height: 30vh` with a bottom fade gradient, applied **only when the content actually overflows**.
- Expanded is capped at `60vh` with internal scroll, **not unbounded**.
- Expanded/collapsed state persists in `localStorage` under `ui.folderReadme.expanded` — global, not per folder.

**Rationale.** `30vh` collapsed and the fade are lifted from NC (`RichWorkspace.vue` styles: `max-height: 30vh`
unfocused, `50vh` focused, plus a `linear-gradient` `:after`). The `60vh` expanded cap is a deliberate divergence:
NC's expansion is bounded by their focus-driven `max-height`, and an unbounded banner would put the file list
off-screen on a 200-line readme even *after* the user expanded it — the very problem the collapse exists to solve.
The storage key follows the established `ui.<scope>.<setting>` convention (`ui.version` in `v2.constants.ts:33`,
`ui.personal.viewMode` at `personal.component.ts:74`, `ui.space.viewMode` at `space-files.component.ts:75`).

**i18n.** New strings go in `frontend/src/i18n/custom/{en,nl}.json` per `CLAUDE.md` — never in the upstream bundles.
None of `Edit`, `Show more`, `Show less`, `Folder description` exists in either bundle today. All four are short
static strings, so they use the plain-English-literal-as-key convention (no `v2_` prefix, which is reserved for
parameterised keys).

---

## 8. Where this deliberately diverges from Nextcloud

| Nextcloud | Here | Why |
|---|---|---|
| Editor is **always live**; no Edit button. Menubar hidden until focus, saves flow through the collaborative session. | **Read-only render + explicit Edit button.** | We have no collaborative editing. Our editor takes an *exclusive lock*, so an always-live banner would lock every folder's readme for anyone merely browsing. |
| Content arrives as a **DAV property** (`{http://nextcloud.org/ns}rich-workspace`, `nextcloud/text` `lib/DAV/WorkspacePlugin.php`), cached server-side for 1h keyed on `fileid_etag`. | Detected client-side from `files[]`; content fetched with one `GET`. | Our browse response already carries the file list and permissions (§context fact 2). A property/endpoint would only be needed for the hidden-file case we dropped in §2. |
| Supports hidden `.Readme.md` and a translated filename. | Three exact names. | §2. |

---

## 9. Verification

**There is no frontend test runner.** `frontend/src` contains **zero** `.spec.ts` files and `frontend/package.json`
has no test script — only `ng`, `build`, `lint`. Introducing one is out of scope for this feature. So:

- `npm run -w frontend lint`
- `npm run -w frontend build`
- Browser-verify per the `v2-dev-loop-verify` skill: build the frontend, let the backend serve it on `:8080` (single
  origin, no `ng serve`), drive with `agent-browser`.

Browser matrix — each row is a case the pure-function-plus-signals design cannot prove on its own:

1. Folder with no readme → no banner, listing unchanged.
2. Each of `Readme.md`, `README.md`, `readme.md` alone → banner renders.
3. Two coexisting (e.g. `README.md` + `readme.md`) → precedence picks the earlier one.
4. A **directory** named `README.md` → no banner.
5. Long readme → collapsed at 30vh with fade; Show more → 60vh with internal scroll; state survives navigation and
   reload.
6. Edit → modify → Save → banner and the listing row both reflect the new content/mtime.
7. Edit → modify → Cancel → discard prompt appears; declining keeps edit mode.
8. Edit → **navigate to another folder** → prompt fires, lock is released (§5). Verify by reopening the folder as a
   second user.
9. Read-only space (no `m` in permissions) → banner renders, **no** Edit button.
10. Readme exclusively locked by another user → no Edit button.
11. `+ New → Folder description` in an empty folder → creates `Readme.md`, banner appears in edit mode; the entry is
    then hidden.
12. Filter active → banner hidden; clearing the filter restores it.

---

## 10. Open questions

None blocking. Two things recorded as knowingly accepted:

- `.Readme.md` on a `showHiddenFiles = true` server is not promoted to the banner (§2).
- v2 file-detail's missing `isWriteable` check (§3) remains a separate bug on a separate surface.

---

## 11. Verification record

Matrix from §9 (extended to 18 cases per Task 7's brief) run on 2026-07-28 against commit `cd9bd130`, dev stack on
`localhost:8081` (this worktree's own backend + freshly built `dist/static`), driven by `agent-browser`.

**Result: 1 case FAILED (case 5). 14 passed. 3 not tested (environment), plus a 4th (case 3) newly found not-testable
in this environment.**

| Case | Result | Note |
|---|---|---|
| 1 | pass | `t7-case1` (empty dir): no `.fr` content rendered, component present but empty. |
| 2 | pass | `Readme.md`, `README.md`, `readme.md` each alone in their own folder all render, each showing its own name/content — the only end-to-end exercise of `FOLDER_README_NAMES`. |
| 3 | **not tested** | Could not build the fixture: this host's filesystem (macOS APFS, default case-insensitive mode) collapses `README.md` and `readme.md` into a single directory entry — writing both in one folder leaves only one physical file (confirmed with a plain `touch README.md; touch readme.md; ls` outside the app, and via the browse API returning one entry named `readme.md` holding the second file's content). Precedence order was not code-reviewed as a substitute for observation per the task's rule against inferring a pass from source reading. This is a **newly discovered** environment limitation, not one of the three pre-declared exclusions. |
| 4 | pass | A **directory** literally named `README.md` (`t7-case4/README.md/`) is excluded by `isDir`; no banner. |
| 5 | **FAILED** | Collapsed long readmes never set `overflowing()` true: no fade, no "Show more" control, even though the DOM proves real overflow (`scrollHeight` 3880px vs `clientHeight` 173px on a 120-paragraph fixture; reproduced again with a much shorter 15-paragraph, 572px fixture). Reproduced across a fresh navigation, a full page reload, and 10+ second waits — not a load-timing race. Forcing `expanded=true` via `localStorage['ui.folderReadme.expanded']` shows the 60vh/scroll mechanics themselves work (`Show less` renders, `max-height: 346.2px`, `overflow-y: auto`), so the bug is isolated to the collapsed-state overflow measurement. Also reproduced the exact regression the brief warned about: expand → **reload** → click "Show less" → the toggle vanishes with **no way back** to expand (confirmed twice, with and without an intervening reload). See full evidence in the Task 7 report. |
| 6 | pass | Edit → append marker → Save: raw `GET` of the file confirms the new content, listing row shows updated size (67B) and mtime; closing the editor shows the banner in read mode with the new content. |
| 7 | pass | Edit → append marker → Cancel → a Cancel/Discard confirm dialog appears; declining ("Cancel" in the dialog) keeps edit mode with the unsaved text intact and the server file unmodified (verified via `GET`); accepting ("Discard") closes the editor, discards the edit, and releases the lock (`lock: null` afterward). |
| 8 | partial pass | Core mechanism verified via API: editing with unsaved text, then navigating to a sibling folder, auto-saves the marker into the **originating** folder (`GET` confirms) and releases the lock (`lock` absent from the listing afterward). The design's own §5 supersedes the "prompt fires" wording carried in this section and the brief with **auto-save, no prompt** — observed behaviour matches that later design, not the original text here. The "verify as a second user" clause is **not tested** — no second user account exists in this environment. |
| 9 | **not tested** | No space where the current user lacks `m` permission exists in this environment. |
| 10 | **not tested** | No second user account exists to hold an exclusive lock as "another user." (A DAV lock — same mechanism used for case 17 — was deliberately not substituted here per the task's explicit instruction not to spend effort finding a workaround for this case.) |
| 11 | pass | `+ New → Folder description` in an empty folder creates `Readme.md`, opens the banner directly in edit mode; content saved via the editor round-trips via `GET`; the `Folder description` menu entry disappears from `+ New` once the folder has a readme. |
| 12 | pass | Banner is present by default, disappears the instant the filter box has text, reappears the instant the filter is cleared. |
| 13 | pass (structural only) | No second theme exists in v2 to do a real dark/light comparison (as pre-declared). Verified instead that colours resolve from tokens: `.fr` background computes to `oklch(0.275 0.052 255)` (`--si-bg1` on `.v2-root`), border to `--si-border`, the collapsed-fade gradient's terminal colour (forced via a class toggle since case 5 blocks reaching it naturally) also resolves to the same `--si-bg1` value, and the read-mode text colour resolves to `--si-fg` (near-white). No `rgb(255,255,255)` or hard-coded white/black found anywhere in the chain. |
| 14 | pass | Zero console errors and zero unexpected "Failed to load folder description" messages across the entire matrix (~45 navigations). The error path itself was not deliberately provoked to confirm the message can still surface when it should — a minor gap, not a failure. |
| 15 | pass | Readme folder → no-readme subfolder → back: content renders again correctly, not an empty banner. Three rapid round-trips between two folders that both have distinct readmes (`QUICK-A` / `QUICK-B`) never showed the other folder's content. No network-throttling capability was available in `agent-browser` to manufacture a worse race than plain rapid navigation; the result is consistent with the `lastLoadKey` cache-key guard in the code but is weaker evidence of the race specifically than a throttled test would be. |
| 16 | pass | All five required hop shapes tested with concrete evidence: sibling→sibling, root→subfolder, subfolder→root, has-readme→without-readme (unmounts the section mid-save), and inside a space (not just Personal). Every hop: the auto-save toast fired (literal text captured: `Saved "README.md"`), the edited content landed in the **originating** folder only (verified via raw `GET`, destination's own readme left untouched), and the lock read `null` afterward. |
| 17 | pass | Used a real WebDAV `LOCK` (`curl -X LOCK`, `app: 'WebDAV'`) as the "another app" lock per the task's guidance that this exercises the stranger's-app path properly. With that lock held, the banner rendered read-only (no Edit button) rather than treating the lock as absent; the lock was untouched by navigating in and out of the folder (nothing in our own component could touch it, since no editor could ever open); cleanly released via `curl -X UNLOCK` afterward. The literal two-same-user-tab variant was not separately re-driven — the component's own code comments already document that scenario as an accepted, known limitation (a second same-user/same-app tab's lock **is** treated as our own and closing one editor **does** release the shared lock), which is a different, already-acknowledged trade-off from the stranger's-app path this case is really guarding. |
| 18 | pass | All three "leave the browse screen entirely" hops tested: sidebar → Recents, Personal → a space, and opening a different file into file-detail. In every case the lock read `null` afterward (confirmed via API) and the unsaved edit was silently discarded with no toast — exactly the documented, accepted behaviour (a destroyed component cannot run the auto-save). |

**Fixtures used:** all built fresh under `files/personal/t7-case*` and `files/readme-test-space/t7-space-*` via the
`make` → `UNLOCK` → `upload` → `UNLOCK` CSRF dance, rather than trusting pre-existing contaminated fixtures from
earlier tasks. Personal's root `README.md` (previously ~88 lines of filler) was overwritten with a known marker for
the root-hop case-16 test. No fixture cleanup was performed afterward; the `t7-case*` / `t7-space-*` folders remain on
disk for anyone who wants to re-inspect the evidence.
