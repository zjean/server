# Handoff — v2 design-system adoption, phases 3–8

**Date:** 2026-08-04
**For:** a fresh agent session picking this up
**Authority on design:** [`2026-08-03-v2-design-system-adoption-plan.md`](2026-08-03-v2-design-system-adoption-plan.md)
**Authority on the design itself:** Claude Design project `4d96b99d-7b88-4478-bd57-7bfc169b5b0a`, read via the `claude_design` MCP (`DesignSync`)

---

## 1. Read this first, in this order

1. This file, all of it. It is the traps, not the design.
2. The plan's **outcome sections** — §2.13, §3.1, §4.7, §4.8. Each records what the
   phase settled *and what the plan got wrong about it*. They are short and they
   will save you from re-deriving four things.
3. The plan's section for the phase you are starting.
4. `custom-v2/styles/_tokens.scss`, header comment. It documents three measured
   deviations from the design and the reason for each. **Do not "restore" the
   design's values there** — each one fails its own stated floor, with numbers.

Only then open the design project.

---

## 2. Where it stands

| Phase | What | PR | State |
|---|---|---|---|
| 0 | Tokens + type substrate | #432 | merged |
| 1 | Primitives, verified in `_kit` | #433 | merged |
| 2 | File browser chrome (D1, D2) | #434 | merged |
| 2b | Grid view | #435 | merged |
| 3 | Inspector (D4, D5) | #437 | merged |
| 4 | Search (D6) | #438 | merged |
| 5 | Share dialog (D7) | #440 | merged |
| 6 | Gallery + upload dock (D8) | #441 | merged |
| 7a | Mobile frame (bands, tabs, rows, touch) | #442 | open |
| **7b** | **Mobile sheets (M3, M5, M6)** | — | **next — verify on a real device** |
| 8 | Keyboard hints + session error strip | — | not started |

Everything merged is on `develop` as of `13d30cda`.

### Decisions the maintainer has made — do not re-open these

- **Full skin adoption, skin first.** Not "structure first". Done in #432.
- **IBM Plex Sans/Mono**, and the existing `app-v2-icon` component extended with
  missing Lucide glyphs rather than adding `lucide-angular`.
- **No light theme.** But "zero raw colours in component styles" is an *enforced*
  rule — `styles/tokens.spec.ts` fails the build otherwise.
- **Sequential PRs**, one phase each, desktop before mobile. Not one long branch.
- **Density default stays `comfortable` (44px)**, even though it moves existing
  users down from 56px. Asked and confirmed 2026-08-04.
- **Grid got its own phase** (2b) rather than riding along with gallery.
- Taken at the design's own recommendation, and the maintainer has had three
  chances to veto each: density `1b`, toolbar `3b`, panel `2a`, keyboard `4b`;
  density stored per-view in `localStorage`; **the icon dock rail gets deleted**;
  no command palette this programme.

### Phase 3 read the plan's §5.5 before anything else

It records what the phase settled, including the two design instructions that could
NOT be transcribed (comment threading and the editor's edit/preview segmented — the
backend has neither), the `dockOpen` vs `dockVisible` distinction, and one finding
left for later with its measurement: **`color: var(--si-rose)` at 31 declarations
across 20 files**, where `--si-rose` is a fill and measures ~3.6:1 as type. That
sweep wants its own PR.

### The phase-1 deferrals are done — and one thing is newly owed

Both landed in #440: `app-v2-select` (a trigger over the existing context menu) and
the dialog geometry, now `styles/_dialog.scss`. A `app-v2-toggle` had to be written
too — phase 1 listed it and shipped only the checkbox.

**Newly owed: migrate the other seven dialogs to `_dialog.scss`.** Only the share
dialog uses it so far. The rest still carry their own `border-radius: 10px` (the
design says 12) and their own centring block. Mechanical, but it is seven dialogs to
re-verify, so it wants its own PR.

---

## 3. The traps. This is the important part.

Each of these cost real time in phases 0–2b. None of them fails in a way that
points at itself.

### 3.1 Never grep build output for errors. Check the exit code.

```bash
# WRONG — never matches. ANSI colour codes split the brackets:
#   ✘ [41;31m[[41;97mERROR[41;31m]
npm run -w frontend build 2>&1 | grep -c '\[ERROR\]'

# RIGHT
npm run -w frontend build >/tmp/b.log 2>&1; echo "EXIT=$?"
```

**Three builds in Phase 1 read as clean while failing.** This is the single
highest-value item in this document.

### 3.2 A backtick inside a CSS comment inside `styles: [\`…\`]` terminates the literal

The compiler says *"Failed to resolve styles at position 1 to a string. Value could
not be determined statically"* **and names no file**. Do not put backticks in
comments inside a component's inline styles.

### 3.3 `focus` does not bubble; `focusin` does

Any directive placed on a **component host** (`app-v2-icon-btn`, etc.) sees
`mouseenter` fine — it fires on ancestors — but never sees `focus`, because the
element that actually receives focus is the `<button>` inside. The tooltip shipped
working on hover and invisible to every keyboard user until this was found.

### 3.4 Anything mounted outside `.v2-root` has no tokens

Every `--si-*` is scoped to `.v2-root`. A node appended to `document.body`
resolves them all to nothing and renders unstyled. `tooltip.directive.ts` appends
to `.v2-root` for exactly this reason.

### 3.5 When a token's hue or meaning changes, grep its consumers AND its `-ink` partner

Phase 0 changed the accent from warm kraft to cool cobalt and broke **24
declarations** that were correct before — 21 using the accent fill as *type* (3.48:1,
fails), a favourite star that was accent *because the accent used to be gold*, and
Space identity marks that should be periwinkle.

Phase 1 then found a **25th** that Phase 0's grep missed: `.pill--amber` resolved
its ink through `--si-accent-ink`, i.e. blue text on an amber fill. The grep looked
for `color: var(--si-accent)` and this was the `-ink` variant on a different
background.

`styles/tokens.spec.ts` now pins all of these shapes. **If you change a semantic
colour, check its `-ink` partner too.**

### 3.6 `border-color:` contains the substring `color:`

A naive `s.replace('color: var(--si-accent);', …)` also rewrites
`border-color: var(--si-accent);`. This silently converted eight drag-over rings and
focus borders in Phase 0 before it was caught. Anchor on line start, or match the
property name.

### 3.7 There is no surface step to spend between the page and a card

The content plane is `--si-bg2`. A card sits at `--si-bg3`. There is nothing
*between* them, so a card's inner region cannot be "one step down" — set it to
`bg2` and it becomes invisible against the page. Phase 2b lost an afternoon to
this: the grid card's header vanished and its badge strip floated outside the card.

### 3.8 Preserve i18n key order; do not re-sort

`frontend/src/i18n/custom/{en,nl}.json` are **not** alphabetically sorted. Writing
them back sorted turns 18 additions into a 466-line diff per file. Append new keys
and leave the order alone.

```python
old = json.loads(subprocess.run(['git','show',f'HEAD:{path}'],capture_output=True,text=True).stdout)
merged = {**old, **{k: v for k, v in new.items() if k not in old}}
```

### 3.9 `anyComponentStyle` is 14 kB per stylesheet, and it is an ERROR

Two component sheets have already crossed it. The fix is **more `styleUrls`
entries**, not a bigger budget — Angular measures per sheet, and the split has
been the honest shape both times (`fonts.scss` out of `v2.scss`;
`file-browser-{grid,gallery}.scss` out of the browser sheet).

### 3.10 Run the ROOT `npm run test`, not the workspace one

```bash
npm run test          # lint (ng lint, prettier-as-error) + backend + frontend
npm run -w frontend test   # NO LINT. This is what let a prettier error reach CI.
```

`ng lint` runs prettier as an ESLint **error**, so one long line fails the build.
`npx prettier --write "src/app/applications/custom-v2/**/*.{ts,html,scss}"` fixes
essentially all of it.

### 3.11 The test harness needs a provider for anything the base newly injects

`screens/files/testing/file-browser-harness.ts` builds providers by hand — there is
no TestBed. Phase 2 injected `L10nTranslationService` into `FileBrowserBase` and
289 tests failed with `NG0201` until the harness got a stub. The stub returns the
**key plus its params**, not prose, so copy edits are not test failures.

---

## 4. agent-browser: what actually works

Chrome is not installed on this machine. Use `agent-browser` (`/opt/homebrew/bin`),
not the chrome-devtools MCP.

**Stack:**
```bash
npm run dev:db && npm run dev:migrate     # DB is usually already up
npm run -w frontend build                  # → dist/static
npm run dev:backend                        # :8080 serves API *and* the built frontend
```
Single origin, hash routing, no proxy, no `ng serve`. Rebuild (~8s) after a
frontend change — there is no HMR.

**A backend may already be running.** `lsof -nP -iTCP:8080 -sTCP:LISTEN -t` before
starting another.

### The five things that waste time

1. **CDP screenshots wedge a session after it has been driven a while.** `eval`
   keeps working; `screenshot` times out. **Close the session and open a new one**
   — do not retry. Budget ~3–5 screenshots per session.
2. **Always pass `--session <name>`.** The default session is shared.
3. **A fresh session has fresh cookies AND fresh localStorage.** So view mode and
   density reset to defaults, and you must log in again.
4. **Refs go stale immediately.** `snapshot -i` before using `@eN`, and re-snapshot
   after anything that changes the page. Refs from another session are meaningless.
5. **`fill` needs a beat between calls.** Two `fill`s back to back put both values
   in the *first* field, leaving Sign-in disabled and no error anywhere. Sleep 1s
   between them, then `snapshot -i` to confirm before clicking.

### Login
```bash
agent-browser --session s open "http://localhost:8080/" ; sleep 3
agent-browser --session s set viewport 1440 900       # NOT `--viewport`; there is no such flag
agent-browser --session s snapshot -i                  # get fresh refs
agent-browser --session s fill @e2 "sync-in" ; sleep 1
agent-browser --session s fill @e3 "password" ; sleep 1
agent-browser --session s snapshot -i                  # confirm both fields + button enabled
agent-browser --session s click @e1 ; sleep 6
agent-browser --session s open "http://localhost:8080/#/v2/<route>"
```

### `eval` gotchas
- It is **not** an async context that awaits. Wrap in an IIFE and return a string:
  `'(()=>{ … ; return JSON.stringify(x) })()'`.
- **Every eval shares one scope.** `const t = …` twice in a session throws
  *"Identifier 't' has already been declared"*. Use an IIFE every time.
- Multi-line eval via shell heredoc breaks on parens; pass a file's contents with
  `agent-browser --session s eval "$(cat script.js)"`.
- No `requestAnimationFrame`, no `ResizeObserver`, no native `resize` in this
  Chromium. rAF-dependent code cannot be verified here — use `afterNextRender`.
- The scroll container is `.layout-v2__content`, not `window`. `scrollIntoView`
  lands under the 56px sticky top bar; offset by ~120px if you want the heading
  visible.

### Measurement beats screenshots for anything numeric

A canvas-composited contrast readback caught things eyeballing did not, and it
**agreed with the computed table exactly** where comparable. There is a working
readback script pattern in the Phase 0 record; for pure-hex tokens a direct WCAG
computation in node is exact and simpler.

---

## 5. Workflow (from CLAUDE.md — the parts that bite)

```bash
git checkout develop && git pull
git checkout -b feat/v2-<topic>
# … work, then:
npm run test                                   # ROOT. lint + backend + frontend
gh pr create --repo zjean/server --base develop --head feat/v2-<topic> …
```

- **`--repo zjean/server` on every `gh pr create`.** Without it, `gh` can resolve
  to `Sync-in/server` (upstream) because this clone has an `upstream` remote.
- **Squash-merge** feature PRs.
- **`develop` is strict-checked**, so each phase must be merged before the next
  branches off it. A batch of N PRs costs N−1 rebases.
- **Do not self-merge.** The maintainer merges. Report green and stop.
- Remotes use the `github-prive` SSH alias. If `git push` fails with
  *Permission denied (publickey)* the key is not loaded — ask the user to
  `ssh-add`. `gh` works regardless because it is HTTPS.
- UI-facing PRs need screenshots committed under `docs/screenshots/` and embedded
  in the PR body at a raw URL pinned to the head SHA:
  ```bash
  SHA=$(git rev-parse HEAD)
  echo "![x](https://github.com/zjean/server/raw/$SHA/docs/screenshots/<file>.png)"
  ```
  Take the shots, `git add`, commit, push, **then** compute the SHA for the body.

---

## 6. Per-phase notes not in the plan

### Phase 3 — the inspector (shipped in #437)

Read the plan's **§5.5** for the outcome. Three things it left in place that later
phases touch:

- `dock-rail.component.*` and `dock-panel.component.ts` are gone;
  `dock-rail.service.ts` is now `inspector.service.ts` (`InspectorService`), and
  the ONE panel is `layout/inspector-panel.component.*`. `file-detail` has no
  inspector of its own any more.
- The panel's two pinned-bottom regions (the comments composer, the versions quota
  footer) mean **`.insp__body` does not scroll** — each tab owns its own scroll
  region. A tab added later has to bring its own `.insp__scroll`.
- The mobile sheet still reserves nothing for a rail (`right: 0`), and the mobile
  inspector toggle is a stopgap in the title bar. **Phase 7 owns replacing it**
  with whatever M1–M6 draws.

### Phase 4 — search (shipped in #438)

Read the plan's **§6.1**. Three of its findings apply to every later phase, not just
to search:

- **Never name a class `.row`.** Bootstrap is loaded globally for the classic UI and
  its `.row > * { width: 100% }` stacks every child of one. It is the only such
  collision in `custom-v2` today — a sweep cleared `.chip`, `.group`, `.field`,
  `.tabs` and `.pill` — but the next generic name may not be.
- **`:not(:has(*))` has zero specificity**, so a rule using it must come after the
  rule it overrides. It failed silently the first time.
- **Backend-supplied strings may contain markup.** Full-text snippets arrive with
  `<mark>` in them. Parse markers into segments; do not bind `innerHTML`, and do not
  assume a server string is plain text just because its type is `string`.

### Phase 5 — share dialog (shipped in #440, after the fixes in #439)

Read the plan's **§7.1**. The rule that mattered most: reading classic first found
**three shipped wire bugs** before a line of the dialog was written — including a 500
on every link creation. Two more things later phases will hit:

- **`GET /shares/:id` does not describe a share's links** — a link member has a
  `linkId` and nothing else. Its uuid and expiry need `getLinkOnShare`.
- **Absence is a deletion.** The share PUT rebuilds the member set from the body, so
  a field you leave out is a thing you delete. `UpdateShareParams.links` is required
  for exactly this reason.

### Phase 6 — gallery and the dock (shipped in #441)

Read the plan's **§8.1**. Three things phase 7 inherits:

- **The transfers pill is gone from both bars.** The aggregate is
  `layout/upload-dock.component.*`, bottom-right, and on mobile it already offsets
  itself above the bottom tab bar. M1–M6 decides whether that is where it belongs.
- **`TransfersService` is the one source for in-flight numbers** — active tasks with a
  250ms re-publish (progress is mutated in place), plus rate and ETA over a trailing
  window. Do not add a second timer.
- **`store.filesEndedTasks` is a day of SERVER history, not this session's transfers.**
  `loadAll` seeds it from `GET /files/tasks` at login and the cache holds finished tasks
  for `CACHE_TASK_TTL` (86400s), so #441's dock rose out of the corner on a fresh load to
  report last night's deletions — and closing it did not help, because it only emptied
  the client's copy. Fixed in #443 by `services/transfer-ledger.ts`: announceable means
  **watched running here and not since dismissed**, per task id. Two corollaries worth
  keeping: `watch()` must be fed from a plain subscription (an `effect` coalesces and
  would miss a fast task's active value), and `Clear done` deletes server-side through
  `FilesTasksService.removeSelectedTasks` — the one upstream `mod` in that PR.
- **The dock and the bulk bar collided at 1280px, not below 600.** Both are
  bottom-anchored, and the dock's 360px covered the bar from x896 rightwards including
  `Delete`; the earlier note here guessed narrow widths and was wrong. Fixed in #443 with
  `--si-dock-lift`, set by `.v2-root:has(.bulk-bar)` in the layout's sheet and read by the
  dock, which keeps its two resting positions. Anything else that grows a bottom bar
  should set that variable rather than re-solving it.

### Phase 7 — mobile, in THREE PRs: 7a (#442), M3 + long-press (#444), M5 + M6 (#445)

The split and the verification method are maintainer decisions (2026-08-04) — see the
plan's §9.1. **7b is M3 (info bottom sheet, 50%/92%), M5 (share sheet) and M6
(long-press action sheet), and it is to be verified on a real Android device via
`agent-device`**, not by measurement: measured CSS is not evidence that a drag works.

What 7a already put in place, so 7b does not re-derive it:

- The four bands are in `layout-v2.service.ts` as `railForced` / `dockOverlay` /
  `isMobile`, all off ONE `viewportWidth` signal. Do not add a fourth breakpoint
  constant — `RAIL_BREAKPOINT` and `DOCK_OVERLAY_BREAKPOINT` are deliberately the same
  1180 because they are one decision.
- Touch sizing is global (`styles/_touch.scss`) and grows the target without moving the
  box. A sheet action wants 52px; that rule is already there and keyed on `.as__item`.
- **The bulk bar positions against `.personal`, not the viewport** — `.personal` gained
  `position: relative` in Phase 2 for this. A viewport-fixed bar would sit over the
  bottom tab bar. The upload dock IS viewport-fixed; they no longer collide (`--si-dock-lift`,
  #443), but the mobile case of both plus the tab bar is still unmeasured — M6 replaces the
  bulk bar with an action sheet, so check which of the two you are actually looking at.
- Sheet snapping must be CSS + `afterNextRender`, not rAF — see §4. On a real device
  that limitation does not apply, which is the other reason 7b goes to `agent-device`.

**What 7b settled, and the four traps it found:**

- **The sheet shell is `styles/_sheet.scss` + `components/sheet-drag.directive.ts` +
  `utils/sheet-snap.ts`.** Three surfaces use it (inspector, action sheet, and — through
  `_dialog.scss` — every dialog). The height travels as `--si-sheet-h` because a drag has
  to paint values BETWEEN the snaps; swapping classes cannot. Two drag modes: `snap` for a
  panel, `dismiss` for an auto-height list.
- **A touchscreen has no hover, and the row checkbox AND the row `⋯` are `opacity: 0`
  until `:hover`.** So mobile could not select a row at all, which put the inspector out of
  reach — `M6`'s long-press had to ship with `M3` (#444) rather than after it. Anything else
  gated on `:hover` is invisible on a phone; grep for it before assuming a control is
  reachable.
- **The dismissal threshold has to be measured on the device.** A third of the sheet's
  height capped at 160px read as "broken" — an ordinary thumb pull did nothing on a sheet
  that had grown to 92vh from eleven actions. It is a quarter capped at 100px, and it can
  afford to be generous because a drag can only START on the handle.
- **`agent-device open` opens a NEW TAB and returns before the page is up.** A press issued
  immediately after it lands on nothing, which reads exactly like a broken handler. Sleep,
  or screenshot first.
- **Every dialog is a sheet on mobile** (`_dialog.scss`, `.v2-root.layout-v2--mobile`), and
  the footer becomes a `column-reverse` stack so the primary is full width — the design
  states that rule twice. Only the share dialog has a `.v2-dialog__footer` today; the other
  seven still owe the migration, and they get the sheet geometry for free when they land.

### Phase 8 — keyboard and the session strip (#446)

- The empty state's printed hints are **kept** now: `N` opens the New menu (the sheet on
  mobile), `U` opens the file picker. Also bound: `F2` rename, `F` favourite, `⌘⇧S` share,
  and `?` for the shortcut sheet. `⌘F` / `⌘A` / `⌫` / `Esc` / `⌘I` / `⌘B` / `⌘K` were
  already there.
- **`utils/shortcut-label.ts` is the one place a modifier is spelled**, and
  `shortcutGroups()` is the list the `?` sheet renders. Only bound shortcuts belong in it —
  the plan's hint set names a `⌘K` command palette, and `⌘K` exists but focuses the top
  bar's search field, so it is listed as *Search files*. There is no palette.
- **A bare-key shortcut needs two guards, not one**: no modifier (⌘N is the browser's), and
  not while typing — and "typing" includes `isContentEditable`, because the markdown editor
  and the comment composer are both contenteditable and would otherwise swallow a `?`.
- **Escape belongs to whatever is on top.** Cancelling a rename also cleared the file
  selection, because the dialog and the browser's key handler both act on one keypress. The
  browser's handler now bails if `.v2-dialog, .v2-sheet, .ctx-menu` is in the DOM — cheaper
  than making eight dialogs call `preventDefault`, and it fails in the safe direction.
- **The session strip is the design's error level 3**, amber (offline is a condition, not a
  failure), `role="status" aria-live="polite"`, measured at 7.9:1. Two of the design's three
  clauses for that level are NOT implemented and the component says why in its own doc:
  "disables write actions" would lie exactly when it matters (`navigator.onLine` is true
  behind a captive portal), and "queues local edits with a count" has nothing queueing them.
- **A frozen CSS animation is invisible, and that is how agent-browser renders one.** The
  headless Chromium that fires no rAF also never advances an animation's clock, so every
  sheet sat frozen at its FROM keyframe — `translateY(100%)`, i.e. exactly its own height
  below the fold. Any geometry measured there was of an off-screen element. The keyframe now
  starts at **12%**, which reads the same on a device and leaves the sheet measurable in the
  harness. If you add an entrance animation, do not start it anywhere that hides the element.

---

## 7. State of the machine right now

- A dev backend is running on `:8080` (PID at time of writing: `68924`). Kill it
  when done, or reuse it.
- `dist/static` holds a current build of `develop`.
- Local phase branches are deleted; `develop` is `13d30cda`.
- No stray test fixtures — the `Q3 handover` folder created for the empty-state
  screenshot was deleted via the API.
- Several `agent-browser` sessions may be open. `agent-browser --session <n> close`.

---

## 8. One honest summary of the run so far

The design is internally consistent and mostly transcribable. What was *not*
transcribable, and what took the time, was the collision between it and a codebase
that had its own coherent system: **the hue swap alone broke 25 declarations that
were correct before it**, none of which fails a build, and two of which look
deliberate in a diff.

The pattern that found them was always the same — render it, then measure it. Two
of the design's own values fail its own stated floors when measured, and the
grep-based approaches missed a quarter of the accent bugs. Assume the same is true
of the phases ahead.
