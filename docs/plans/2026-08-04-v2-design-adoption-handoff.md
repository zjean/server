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
| **3** | **Inspector (D4, D5)** | — | **next** |
| 4 | Search (D6) | — | not started |
| 5 | Share dialog (D7) | — | not started |
| 6 | Gallery + upload dock (D8) | — | not started |
| 7 | Mobile (M1–M6) | — | not started |
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

### Two things deferred out of Phase 1 that Phase 5 needs

- **Dialog geometry consolidation** — 560px / `--si-r3` / `--si-shadow3` /
  `--si-scrim` across the eight dialog components.
- **Select/menu extension** of `context-menu.component.ts`.

Both are additive. Fold them into Phase 5, which is the first phase that needs
either.

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

### Phase 3 — the inspector (next)

- The plan's §5 is accurate. The rail deletion is decided.
- `app-v2-tabs` already exists with the `fill` layout the inspector wants. **The
  `fill` layout suppresses icons deliberately** — four labelled tabs with icons and
  counts do not fit 340px, and the design draws that strip label-only. Pass icons
  anyway; the `inline` layout uses them.
- Do not touch two things in the OnlyOffice path while you are in here, both
  documented in CLAUDE.md and both load-bearing: `changeHistory: false` is
  vestigial and must stay false, and **both** history handlers must re-mount the
  editor.
- `dock-rail.component.*` gets deleted; `dock-rail.service.ts` may still hold the
  tab list that `dock-panel` reads — check before deleting either.

### Phase 4 — search

- **No backend work needed.** `FileContentModel` already carries
  `matches: string[]`, and full-text is already gated on
  `files.contentIndexing.enabled` (400 when disabled).
- The 48px `lg` input already exists in `app-v2-input` and is for this screen only.

### Phase 5 — share dialog

- **Read the classic implementation first.** `shares-manager.service.ts:581` treats
  `link.id < 0` as "new link"; anything else is update-by-id and 404s for unknown
  ids. This exact detail has produced a v2 bug before. CLAUDE.md's
  classic-UI-as-ground-truth rule exists because of this family of mistake.
- Fold in the two deferred Phase 1 items here (§2 above).

### Phase 6 — gallery

- `file-browser-gallery.scss` is already split out and carries a header comment
  saying phase 6 rebuilds it to D8.

### Phase 7 — mobile

- **The bulk bar positions against `.personal`, not the viewport** — `.personal`
  gained `position: relative` in Phase 2 for this. A viewport-fixed bar would sit
  over the mobile bottom tab bar.
- The bottom tab bar goes 4 tabs → 5 (`Files · Spaces · Shared · Recents · Search`),
  displacing Settings into the drawer footer where it already is.
- Sheet snapping must be CSS + `afterNextRender`, not rAF — see §4.

### Phase 8 — keyboard

- The empty state already **prints** `N new · U upload · ⌘F filter`. None of `N` or
  `U` is **bound** yet. That is this phase's job, and the printed hints are
  currently a promise the app does not keep.

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
