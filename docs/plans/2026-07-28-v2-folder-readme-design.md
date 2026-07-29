# Design — Folder readme banner in `custom-v2` (zjean/server fork)

- **Status:** Accepted
- **Date:** 2026-07-28
- **Scope:** `frontend/src/app/applications/custom-v2` only. **No backend changes.** No upstream files touched.
- **Modelled on:** Nextcloud's "Rich Workspaces" (the `nextcloud/text` app), deliberately diverging on two points — see §8.

All `file:line` citations were verified against `main` at commit `aa0648a1` on 2026-07-28.

---

## 0. Correction (2026-07-29) — the two host screens became one, so the integration did too

**Read this before any `personal.component.ts` / `space-files.component.ts` citation below.** Issue #346 (PR #371 and
its predecessors, merged into `main` after this branch was written) consolidated the two ~1100-line browse screens
behind a single abstract `FileBrowserBase` (`custom-v2/screens/files/file-browser.base.ts`) plus one shared template
(`file-browser.component.html`). `personal.component.ts` is now 122 lines and `space-files.component.ts` 172; both are
thin `FileBrowserRepository` strategies. `space-files.component.html` and `.scss` were **deleted** — the shared pair
replaces them.

Every host-side line-number citation in §1, §5, §6 and §7 below therefore points at code that no longer exists at that
line. What the citations *described* is still true; only the location changed. As merged onto this refactor:

| §1/§6 said (two screens) | Now (one base) |
|---|---|
| a `permissions` signal per screen | `file-browser.base.ts` `permissions` signal, set in `loadFiles()`'s success *and* error paths |
| a `hasFolderReadme` computed per screen | one computed on the base, feeding both the New-menu and the FAB-sheet builders |
| a byte-identical `newFolderDescription()` in each screen | one method on the base, next to `newMarkdownFile()` |
| a `viewChild(FolderReadmeComponent)` per screen | one `readmeBanner` viewChild on the base |
| **three** dispatch sites (§6's table), because `personal.onFabSheetSelect` duplicated the whole `switch` | **ONE** `case 'new-folder-description'` in the base's `dispatchNewEntry`; the FAB sheet delegates to it (`onFabSheetSelect`), so the asymmetry §6 warned about is gone |
| one template line per screen template | one block in the shared `file-browser.component.html`, same structural spot (after the drop-overlay, before `@if (loading())`) |

So §1's "Correction (2026-07-28)" — that the integration cost is small but not zero, and duplicated across two screens
— is now **half** true: the cost is no longer duplicated, and `hasFolderReadme` is derived once rather than twice.
What genuinely remains in each subclass is a single `FolderReadmeComponent` entry in its `imports` array, which is
unavoidable: the shared template renders `<app-v2-folder-readme>`, and a standalone component's template dependencies
must be declared on that component. Every other component in the shared template is declared twice for the identical
reason.

Readme behaviour is identical on both screens, so **none of it belongs in `FileBrowserRepository`** — that seam is
explicitly for "where the files come from and how they are addressed on the wire", and its header calls itself a
preservation boundary rather than a normalisation opportunity. Nothing readme-related was added to it.

The route collapse this design's §5 depends on (one `{ path: '**' }` child per browse screen) survived the merge
untouched — `main` never edited `v2.routes.ts` — so §5's in-place-reload premise still holds, now via
`FileBrowserBase`'s single `repository.navigation()` subscription instead of two per-screen ones.

§9's "there is no frontend test runner" is also **obsolete**: the same refactor brought `npm run -w frontend test`
(vitest), and this branch now ships `custom-v2/utils/folder-readme.spec.ts` covering the three precedence cases §11's
case 3 could not build on a case-insensitive host. See §13.

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
`space-files`, for the reason in §6. `dirPath` is passed as a pre-joined string because each screen already builds
that prefix its own way — `personal` from `SPACE_ALIAS.PERSONAL` + segments, `space-files` from the route `alias` —
and `buildSpaceFilePath` (`custom-v2/utils/file-model-stub.ts`) already exists for it.

**Correction (2026-07-28): "nothing leaks into either screen" overstated it — the integration cost is small, but it
is not zero.** As shipped, both screens:

- import `FOLDER_README_NAMES` and `pickFolderReadme` from `custom-v2/utils/folder-readme.ts` directly (not only
  through the banner's inputs),
- each gained a `hasFolderReadme` computed signal that re-derives `pickFolderReadme(this.files()) !== null` to gate
  the New-menu entry (§6) — the exact same derivation the banner performs internally to decide whether it has
  anything to render, computed twice,
- each carry a byte-identical ~16-line `newFolderDescription()` method (the New-menu creation handler from §6) with no
  shared helper between them.

None of this is a defect — it is the accepted price of the "two 1100-line near-duplicate screens, no shared base
class" starting condition this feature builds on, and it is small relative to that duplication's existing scale. But
it is readme-specific code living in both host screens, not nothing, and a reader relying on the original sentence
would miss it when auditing what these screens depend on.

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

**Correction (2026-07-28): "verbatim" describes the expression, not the input it runs on.** The `readme` fed into it is
not the raw listing row. `readme()` (`folder-readme.component.ts:256-264`) strips a lock from the row **before** the
expression above ever sees it, when **all** of the following hold:

- the lock is exclusive,
- `lock.app === SERVER_NAME` — i.e. taken through the plain Sync-in API's lock route, not `'WebDAV'` (sync clients,
  which stay opaque and correctly render read-only), and
- `lock.owner.id` is a **number** equal to the current user's own numeric id — guarded so two `undefined`s are never
  compared equal, which would strip a stranger's lock whenever neither side has resolved an id yet.

This exists because the banner's own editor takes exactly this shape of lock on itself: Edit → Save re-reads the row
while the banner still holds the lock it just took, and without the strip that row comes back looking like "locked by
a stranger," hiding the Edit button behind its own successful save.

**The consequence worth a reader's attention, and the reason `writeable` is no longer simply "verbatim":** the strip
cannot distinguish "a lock this banner's editor is holding" from "a lock any other same-user, same-app session is
holding" — including **server-side operation locks**, which take the identical shape (app `Sync-in`, numeric owner id,
`isExclusive: true`, no `info`). Those are taken by upload PATCH (`files-manager.service.ts:316`), upload PUT (`:155`),
download-from-url (`:691`), compress (`:736`), extract (`:791`), and versioning restore
(`custom-versioning/services/versioning.service.ts:465`). So: opening Edit on `README.md` while, say, a
download-from-url task is mid-write to that same file, then closing the editor, deletes that operation's lock — the
banner's own `MarkdownViewComponent.ngOnDestroy` unlocks unconditionally, believing the lock is its own. Bounded (short
TTL, same owner, the banner holds its own refreshed lock throughout the edit) and accepted, but real — this is not a
theoretical edge case, it is the direct, necessary cost of the strip above, and it is not limited to the banner's own
prior edit. Full reasoning and the exact gating are in the code comment at `folder-readme.component.ts:221-255`.
**Anyone consolidating this contract for [issue #372](https://github.com/zjean/server/issues/372) or
[issue #382](https://github.com/zjean/server/issues/382) needs this divergence, not just the verbatim expression** —
copying only the expression and not the strip (or vice versa) changes which locks the banner treats as its own.

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

Content in read mode is a `GET` of the stub's `dataUrl`, built with `buildFileModelStub(props, fullPath)`
(`custom-v2/utils/file-model-stub.ts`) — the same call `markdown-view` makes at line 693. **Corrected 2026-07-28: this
is cached, not re-fetched unconditionally.** `load()` (`folder-readme.component.ts:555`) keys on
`` `${file.id}:${file.mtime}` `` in `lastLoadKey`, and re-fetches only when that key changes. This is not a staleness
risk: `mtime` moves on every write to the file, including a write made from a different tab, a different user, or
WebDAV/sync — there is no path that changes the readme's content without also changing its `mtime`, so the cache key
tracks content, not merely identity. Two more mechanisms make the cache safe rather than merely fast:

- **A post-await staleness guard.** `load()` checks `this.lastLoadKey !== key` both immediately after the `GET`
  resolves and in its `catch` (:563 and :566), so a request superseded by a newer folder's load while in flight cannot
  overwrite the view with older content — the last key set wins, not the last response to arrive.
- **Reset to `null` on disappearance.** The navigation effect (:387) clears `lastLoadKey` to `null` whenever
  `dirPath`/`readme()` resolve to nothing (no readme, or mid-hop). Without this, re-entering a folder whose readme is
  **unchanged** would hit the cache-hit early-return while the content had already been blanked by the same effect,
  leaving an empty banner — the bug fixed in `703195ce`. The reset is what makes that fix work; deleting `lastLoadKey`
  as an over-eager "simplification" reintroduces exactly that bug.

**Accepted cost of the reset:** returning to a folder whose readme has not changed since you left re-issues the `GET`
for content already fetched once earlier in the session — a duplicate request, not a staleness risk. (Precisely: the
key is nulled when the destination has *no* readme, and simply overwritten by the destination's own key when it has
one. Either way the return visit misses the cache.) A couple of KB, so this is judged worth paying to keep the reset-on-disappearance fix
simple.

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

**Two side effects of that route collapse, outside this feature's own scope but worth recording because they affect
the whole v2 browse tree, not just the banner.** Collapsing `{ path: '' }` + `{ path: '**' }` into one `{ path: '**' }`
entry means **every** piece of component-local state that used to reset on a root↔subfolder hop (because that hop used
to destroy and recreate the screen) now survives it, not only the readme banner's own state:

- **Filter text now survives root↔subfolder hops.** It always survived subfolder↔subfolder hops (same route config
  before this change too); now a filter typed at the root is still active after navigating into a subfolder, and vice
  versa. Previously the two shapes behaved differently for the same user action.
- **View mode (list/grid/gallery) now survives the same hops**, for the identical reason — `mode` is component-local
  state that a destroy-and-recreate used to reset to the `localStorage`-persisted default, and no longer does.

Both are user-visible behaviour changes on the Personal and space browse screens generally, made *for* this feature's
benefit (the auto-save on navigate needs the component to survive the hop) but not scoped *to* this feature. Neither
was flagged as a defect during Task 7 verification; recorded here so a future reader does not mistake either for
unrelated drift.

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
- **Expanded/collapsed state is not persisted. Every folder opens collapsed.** Revised 2026-07-29 after seeing it in
  screenshots: the original decision persisted the state in `localStorage` under a single global key
  `ui.folderReadme.expanded`, and the consequence read badly in practice — expanding one long readme left *every* other
  folder opening "expanded", including two-line ones, showing a live **Show less** control against content that was
  never clipped. Per-folder persistence was considered and rejected as more state than the feature earns. The state now
  lives only in the component's `expanded` signal, and the navigation effect resets it on every `dirPath` change,
  because the host screens reload in place on an in-screen hop and the component would otherwise carry the previous
  folder's state forward. Cross-screen hops destroy the component and so start collapsed for free.

**Rationale.** `30vh` collapsed and the fade are lifted from NC (`RichWorkspace.vue` styles: `max-height: 30vh`
unfocused, `50vh` focused, plus a `linear-gradient` `:after`). The `60vh` expanded cap is a deliberate divergence:
NC's expansion is bounded by their focus-driven `max-height`, and an unbounded banner would put the file list
off-screen on a 200-line readme even *after* the user expanded it — the very problem the collapse exists to solve.
The storage key follows the established `ui.<scope>.<setting>` convention (`ui.version` in `v2.constants.ts:33`,
`ui.personal.viewMode` at `personal.component.ts:74`, `ui.space.viewMode` at `space-files.component.ts:75`).

**i18n.** New strings go in `frontend/src/i18n/custom/{en,nl}.json` per `CLAUDE.md` — never in the upstream bundles.

**Correction (2026-07-28): `Edit` is not one of the new strings — it already exists upstream, and must stay there.**
Upstream's `frontend/src/i18n/nl.json` already has `"Edit": "Bewerken"`; upstream's `en.json` has no `Edit` key at
all and correctly falls through to the literal `Edit` for English, matching the identity-mapping pattern `CLAUDE.md`
describes for short static strings. The code is right to **not** add `Edit` to the custom bundle: doing so would
create a second `Edit` key that shadows the upstream Dutch translation for every other screen that already uses it,
purely to satisfy this feature's own English literal (which already renders correctly via the existing fallthrough).
`Show more`, `Show less`, and `Folder description` are the actual new strings this feature adds — none existed in
either bundle before this feature, and all three now live in `frontend/src/i18n/custom/{en,nl}.json`. They are short
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
8. Edit → **navigate to another folder** → auto-saves the pending edit into the folder you left, then releases the
   lock; no prompt (§5 supersedes the original prompt-on-navigate design with this). Verify by reopening the folder as
   a second user.
9. Read-only space (no `m` in permissions) → banner renders, **no** Edit button.
10. Readme exclusively locked by another user → no Edit button.
11. `+ New → Folder description` in an empty folder → creates `Readme.md`, banner appears in edit mode; the entry is
    then hidden.
12. Filter active → banner hidden; clearing the filter restores it.

**Cases 13–18, added in Task 7 because they are cheap and catch the two bug classes this codebase has hit before.**
§11 reports results for these under the same numbering; folded in here so the definitions and the results match one
table instead of splitting the matrix across two documents.

13. Dark theme, all of the above visible states. Expected: no white-on-white, the fade blends into the card.
14. Browser console across the whole matrix. Expected: no errors, and no `Failed to load folder description` toast
    except where deliberately provoked.
15. **Navigation round-trip.** Folder with a readme → subfolder without one → back. Expected: content renders again,
    not an empty banner. Then, with a slow connection throttled if possible, navigate quickly between two folders
    that both have readmes and confirm neither ever shows the other's content.
16. **Mid-edit navigation across every hop shape.** With unsaved text in the editor, leave the folder each of these
    ways and confirm the auto-save toast fires, the content lands in the **originating** folder's readme (verify via
    the API, not the DOM), and the lock reads `null` afterwards:
    - subfolder → sibling subfolder (both with readmes)
    - **root → subfolder, and subfolder → root** — these crossed a route boundary before the single-route fix (§5)
      and silently discarded the edit
    - folder with a readme → folder **without** one (this unmounts the section mid-save; content must still persist)
    - inside a space, not just Personal
17. **Own-lock scope.** Open the readme in a second browser tab, or hold a lock via the DAV/sync client, then open
    and close the banner's editor in the first tab. Expected: closing the banner does **not** delete the other
    session's lock. A lock held by another app must render the banner read-only rather than being treated as absent.
18. **Leaving the browse screen entirely, mid-edit.** With unsaved text, leave via the sidebar to Recents, from
    Personal into a space, and by opening a file in file-detail. Expected in all three: the lock is released (the
    banner is destroyed, so the editor's own `ngOnDestroy` unlocks). **Known and accepted:** the unsaved text is
    discarded with no toast, because a destroyed component cannot run the auto-save — documented at
    `folder-readme.component.ts`. Confirm the lock is genuinely released; do not treat the missing toast as a new
    defect.

---

## 10. Open questions

None blocking. Two things recorded as knowingly accepted:

- `.Readme.md` on a `showHiddenFiles = true` server is not promoted to the banner (§2).
- v2 file-detail's missing `isWriteable` check (§3) remains a separate bug on a separate surface.

---

## 11. Verification record

Matrix from §9 (extended to 18 cases per Task 7's brief) run on 2026-07-28 against commit `cd9bd130`, dev stack on
`localhost:8081` (this worktree's own backend + freshly built `dist/static`), driven by `agent-browser`.

**Result as first run, over the 18-row table below: 13 passed, 1 partial pass (case 8), 3 not tested (cases 3, 9, 10),
1 FAILED (case 5) — 13 + 1 + 3 + 1 = 18. Case 5 was then fixed in `3e935a80` and re-verified; see the amendment below
the table.** Case 8's "partial pass" is counted on its own line rather than folded into either "passed" or "not
tested": its core mechanism (auto-save into the originating folder, lock released) was directly verified, but the
row's "verify as a second user" clause was not — genuinely partial, not fully either state.

### Standing limitation of this verification harness — read before trusting any row

`agent-browser`'s bundled headless Chromium **never runs the page's "update the rendering" steps.** Confirmed by
instrumentation while diagnosing case 5: `requestAnimationFrame` callbacks are scheduled but never fire (2 schedules,
0 fires), and neither `ResizeObserver` nor native `resize` events are deliverable. Chrome is not installed on this
machine, so there is no frame-producing browser to cross-check against.

Two consequences, both load-bearing for how much this table is worth:

1. **Behaviour implemented inside rAF or `ResizeObserver` reads as broken here even when it works in a real browser.**
   That is precisely what case 5's failure turned out to be — see the amendment.
2. **Such behaviour therefore cannot be verified here at all.** Any future row covering frame-dependent code should be
   recorded as *not tested*, not as passed. Angular's `afterNextRender` is exempt: the framework races `setTimeout`
   against `rAF` (`scheduleCallbackWithRafRace`), so it fires either way — which is why the fix uses it.

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

### Amendment — case 5, after the fix in `3e935a80`

**Verdict: pass.** Re-verified on 2026-07-28 against `3e935a80` on the same stack.

The root cause was **not** a render-timing race as first suspected, and not a defect in the collapse logic itself: the
single `requestAnimationFrame` that `measureOverflow()` scheduled **never ran**, for the harness reason above, so
`overflowing` stayed at its initialiser `false` and every consumer of it — the fade, the Show more control, and the
already-fixed re-measure-on-collapse — was dead. The `!host` guard was never even reached.

Fixed by scheduling through Angular's `afterNextRender` instead of a bare `rAF`, plus an `effect` on the `readHost`
viewChild and a `resize` listener. Re-measured after the fix: long readme `scrollHeight 2588` / `clientHeight 270` with
the fade resolving to `linear-gradient(rgba(0,0,0,0), oklch(0.275 0.052 255))` and Show more present; short readme
`100/100` with neither; the full toggle cycle working; and the expand → **reload** → Show less sequence keeping the
control. Both Personal and a space. Edit mode unaffected.

**Honest scope of what this proves.** Because a bare `rAF` does fire in a real browser, **the original failure was
substantially an artifact of this harness, and the feature was probably not broken for real users.** The fix is still
the right change — `afterNextRender` is the framework's render contract and is robust where a bare `rAF` is fragile
(background tabs, occluded windows) — but it should not be recorded as having repaired a confirmed user-facing bug.
Case 13's fade check, which had to force the class by hand because case 5 blocked reaching it, is now reachable
naturally.

**The resize listener's last link is verified only with a synthetic event**, since this harness dispatches no native
`resize`. Real resize behaviour is untested.

### Scope of this record, precisely

This table is not one snapshot — read it as two, and note what was **not** re-run.

- **17 of 18 rows** (all but case 5) reflect a run against `cd9bd130`.
- **Case 5, and case 13's fade specifically**, were re-checked against `3e935a80` — the commit right after `cd9bd130`
  that changed the shared measurement/render path (`measureOverflow()` moved from a bare `rAF` to `afterNextRender`,
  plus the new `readHost` viewChild effect and the `resize` listener).
- That commit's blast radius is wider than the two rows re-checked: rows 1, 2, 4, 6, 7, 9, 10, 11, 12, 15, 16, 17, and
  18 all render the read-mode banner through the same measurement path, and were **not** re-verified after it changed.
  They are recorded as they stood against `cd9bd130`, on the strength that `3e935a80` was a scheduling-mechanism swap
  (bare `rAF` → `afterNextRender`) rather than a change to what gets measured or when the read-mode branch renders —
  but that is an inference from reading the diff, not a re-observation.
- The fix wave in this document (C1–C3, D1–D13) touched `folder-readme.component.ts`'s resize handling again (C3) and
  `markdown-view.component.ts`'s save-outcome logic (C1) and `space-files.component.ts`'s space-name reset (C2). None
  of those commits are reflected in the table above — **this record's browser matrix was not re-run for this fix
  wave**, per the maintainer's explicit instruction not to re-run it. C1 and C2 have their own targeted browser
  verification in the fix-wave report; C3 does not, for the reason given at C3's entry there.

### Known untested transition: editing with a filter active, then Cancel

Not previously listed as a gap, so recording it as one now rather than leaving it implicit. The filter gate in both
templates is `@if (!filter() || readmeBanner()?.isEditing())` (Task 6) — it keeps the banner mounted while editing so
a filter keystroke cannot silently discard unsaved text. Neither Task 6's browser check nor case 12 above exercised
**editing with a filter active, then leaving edit mode** (via Cancel, or via the auto-save teardown on folder change)
while that filter is still non-empty: Task 6's check stopped once it confirmed the banner stayed mounted and the text
survived a filter keystroke, and case 12 above never had an editor open at all.

The reason this is worth flagging rather than assumed-fine: `readmeBanner()?.isEditing()` reads a `viewChild` signal
of the very component the `@if` gates — the query and its target are the same component. When editing ends and
`closeEditor()` sets `editing` back to `false`, the guard's own truth value flips from "keep it mounted" to "hide it"
in the same signal graph that decides whether it exists at all. This **does** converge correctly by inspection: the
next change-detection pass evaluates `filter() && !isEditing()` as true and the `@if` resolves to hidden, and nothing
about the viewChild query itself is invalidated by the component's own signal changing (only its *destruction* would
invalidate the query, and destruction happens as a result of the `@if` going false, not a cause of it) — so there is
no cycle here, just an untested path. Recorded as **not tested**, not as passed.

### Note on case 3 with a production implication

Case 3 (precedence between two coexisting names) could not be built because this host's filesystem is case-insensitive
(macOS APFS default), so `README.md` and `readme.md` collapse into one entry. Worth recording that this is not purely a
test-rig quirk: **on any case-insensitive deployment the precedence list can never be exercised either**, because only
one of the three names can exist in a folder at a time. Precedence matters only on case-sensitive hosts (typical Linux
deployments), where it remains unverified by observation.

**Fixtures used:** all built fresh under `files/personal/t7-case*` and `files/readme-test-space/t7-space-*` via the
`make` → `UNLOCK` → `upload` → `UNLOCK` CSRF dance, rather than trusting pre-existing contaminated fixtures from
earlier tasks. Personal's root `README.md` (previously ~88 lines of filler) was overwritten with a known marker for
the root-hop case-16 test. No fixture cleanup was performed afterward; the `t7-case*` / `t7-space-*` folders remain on
disk for anyone who wants to re-inspect the evidence.

---

## 12. Security note — auto-rendered markdown as a trust surface

Added 2026-07-28, at the final whole-branch review's request, recording reasoning that had been done but not written
down.

**Why this needed a dedicated look.** The banner is a broader trust surface than v2's existing markdown viewer. Opening
a `.md` file in file-detail is a user action directed at one specific file the user chose. The readme banner is not:
it renders automatically, for every user who opens the folder, with no click required, and its content is controlled
by **anyone with write access to that folder** — which, on a shared space, is not necessarily the person viewing it.
A malicious or compromised writeable-space member could put content in `Readme.md` that every other member of that
space renders passively just by browsing to the folder.

**The question:** can content in a folder's `Readme.md`, rendered through the same TipTap/ProseMirror pipeline as edit
mode (§4), execute script or otherwise act on behalf of the viewer, given that rendering here is unconditional and
requires no viewer intent?

**Conclusion: no vulnerability found**, for three independent reasons — any one of which would already block script
execution, so this is not resting on a single control:

1. **No raw-HTML node in the schema.** ProseMirror's document model is defined by the schema TipTap builds from the
   configured extensions (StarterKit, TaskList/TaskItem, TableKit, Image, Markdown — the same set in both read mode
   and edit mode, §4). That schema admits no node type that carries arbitrary HTML. Markdown input containing a raw
   `<script>` tag or an `on*` attribute has nowhere to go in the resulting document — the parser either drops it or
   folds it into a text node, but there is no node that would let the browser execute it, because ProseMirror never
   hands unescaped HTML to `innerHTML` for content it parsed as a document node.
2. **The Link extension sanitizes URI schemes.** TipTap 3.25's Link extension (`StarterKit.configure({ link: {
   openOnClick: false } })`, §4) validates `href` values against an allowed-protocol list before accepting them as a
   link mark — a `javascript:` URI is rejected, not rendered as a clickable link. `openOnClick: false` additionally
   means read mode never navigates on a click at all.
3. **`allowBase64` images cannot execute.** `Image.configure({ allowBase64: true })` (§4) permits `data:` URIs in
   `src`, but an `<img>` element's `src` is fetched and decoded as image data by the browser's image pipeline — it is
   not a script execution context regardless of what bytes the data URI carries. This is a deliberate, narrow
   allowance (embedding an image inline in the markdown without a separate upload) and does not open a script path.

**What this does not cover.** This is a client-rendering-surface review, not a full security audit of the feature.
Access control (who can write `Readme.md` in the first place) is governed by the same space/folder permission model as
every other file in that folder — nothing here changes who can write it, only what happens when it is rendered. The
pre-existing gap noted in §3 (`file-detail`'s missing `isWriteable` check) is a separate, already-recorded issue on a
separate surface.
