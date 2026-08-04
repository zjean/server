# Adopting the Claude Design system into `custom-v2`

**Date:** 2026-08-03
**Design project:** `4d96b99d-7b88-4478-bd57-7bfc169b5b0a` — *Sync-In Design System v1.0, dark-first*
**Source files read:** `01 Foundations`, `02 Components`, `03 Patterns`, `04 Desktop Screens`, `05 Mobile Screens`, `SyncNav`
**Decision sheet:** https://claude.ai/code/artifact/1a8a66ae-7766-493a-9473-80548628f363

---

## 0. What was decided before planning

Four questions were put to the maintainer. The answers set the shape of everything below.

| # | Question | Decision |
|---|---|---|
| Q1 | Skin now, or structure first? | **Full adoption, skin first.** Phase 0 replaces surfaces, text tiers, accent, file-type coding, radii, shadows and motion; every later phase is built in the new skin. |
| Q2 | Fonts and icons | **Adopt IBM Plex Sans + IBM Plex Mono; extend the existing `app-v2-icon` component** with the missing Lucide paths. No `lucide-angular` dependency. |
| Q3 | Light theme | **Out of scope.** Dark-only, but *zero raw colours in component styles* becomes an enforced rule, so light is a later drop-in. |
| Q7 | Delivery | **Sequential PRs, one phase each, desktop before mobile.** |

Three further decisions are taken at the design's own recommendation and are open to veto rather than blocking:

- **Q4 — density** is stored **per view in `localStorage`**, mirroring `viewModeStorageKey()`. No backend field, no migration.
- **Q5 — the icon dock rail is deleted.** The design evaluates that exact shape as option `2c` and disrecommends it ("it reintroduces unlabelled icons"). We build `2a`: docked panel, labelled tabs, one toggle button.
- **Q6 — no command palette in this programme.** We ship 4b's cheap half: shortcut hints printed where the action lives. ⌘K keeps focusing the top-bar search.

The four open explorations are taken at the design's recommendation throughout, which is also what all eight desktop screens are drawn in: **density `1b`, toolbar `3b`, panel `2a`, keyboard `4b`**.

---

## 1. The honest summary

The design is a **complete re-skin** and a **partial re-structure**.

The re-skin is total: warm-neutral surfaces replace deep navy, cobalt replaces kraft, IBM Plex replaces Geist/JetBrains, ten file-type hues replace four families, and every radius drops 1–2px. This reverses parts of `#419` and `#398`, deliberately, with the design as the new authority.

The re-structure is smaller than the mockups suggest, because v2's frame is already right. `SyncNav` **is** `left-nav.component` — 248px, `WORKSPACE` / `SHARED` / `ADMIN` grouping, accent tint plus a 2px marker on the active item, a rail collapse, and a user-plus-quota card in the footer. `list` / `grid` / `gallery` already exist and already persist per view. Nothing in the design is a screen we do not have; two things (a floating bulk-action bar, a density control) are genuinely new components, and one (the session error strip) is a new level of an existing concern.

**Where the work actually concentrates:** the file browser's chrome, the inspector, and the share dialog.

---

## 2. Phase 0 — the token and type substrate

One PR, `mod/v2-design-tokens`. Nothing structural changes; every screen should render recognisably but in the new skin. This is the riskiest phase because `_tokens.scss` carries a documented contrast table that this PR invalidates.

### 2.1 Surfaces — re-point, do not rename

The design ships seven steps but names five plus two halves. The repo ships seven under `--si-bg0…bg6`. The roles line up if the ladder is re-pointed rather than renamed — keeping the names avoids churning every declaration in v2 for no behaviour change.

| Repo token | Current | New | Design name | Role |
|---|---|---|---|---|
| `--si-bg0` | `#192231` | `#100F0E` | surface-0 | app canvas, sidebar, page gutters |
| `--si-bg1` | `#212938` | `#161513` | surface-0.5 | top bar, right panel, empty-state panel |
| `--si-bg2` | `#2a313e` | `#1A1917` | surface-1 | content plane — file table, detail body |
| *(new)* `--si-bg-band` | — | `#1E1C1A` | surface-1.5 | the alternating table band |
| `--si-bg3` | `#333a46` | `#232120` | surface-2 | cards, row hover, input fill, chips |
| `--si-bg5` | `#4a4f59` | `#2D2A28` | surface-3 | dialogs, context menus, sheets, popovers |
| `--si-bg6` | `#595e66` | `#383431` | surface-4 | tooltips, pressed, drag-over, segmented-active |
| `--si-bg4` | `#3e444e` | *retire* | — | see below |

`--si-bg4` is documented as "selected row". In the new system a selected row is **`--si-accent-soft` plus a 2px cobalt marker**, not a surface step — so `bg4` loses its only reason to exist. Alias it to `--si-bg3` in this PR and remove it in Phase 2 once the table is rebuilt, so no consumer breaks mid-phase.

The design adds one hard rule worth encoding in the file's header: **never place surface-1 directly on surface-1**, and never skip two steps between adjacent planes. Where two regions need separating and no step is available, use 24px of space.

### 2.2 Text — five tiers become four

The design's whole hierarchy budget is "four text values, three line values", and new emphasis must come from size and weight rather than from a new colour. v2 has five tiers, so one collapses.

| Repo token | New value | Design name | Note |
|---|---|---|---|
| `--si-fg` | `#F5F2EE` | text-primary | 15.7:1 on surface-1 |
| `--si-fg-muted` | `#B8B2A9` | text-secondary | 8.3:1 |
| `--si-fg-faint` | → alias of `--si-fg-muted` | — | **collapses.** Codemod in this PR; token removed in Phase 1 |
| `--si-fg-tertiary` | `#8A857D` | text-tertiary | 4.8:1 — **surfaces 0–2 only** |
| `--si-fg-ghost` | `#635E58` | text-quiet | decorative; never the sole carrier of meaning |

**Trap.** `text-tertiary` is only usable on surfaces 0–2 and `text-quiet` is not usable for meaning at all. The current ramp had `fg-tertiary` valid up to `bg4` and `fg-ghost` valid on `bg0`/`bg1`. So this PR must audit every `--si-fg-tertiary` on the new `bg5`/`bg6` (dialogs, menus, tooltips) and every `--si-fg-ghost` that carries meaning rather than decoration, and lift them a tier. Grep both tokens; expect a handful of real hits in the dialogs and the context menu.

### 2.3 Accent — cobalt, and the four values it needs

`#419`'s "one colour cannot be fill, ink and focus ring" lesson holds under cobalt just as it did under kraft, and the design agrees with it in its own words: `accent-500` "never carries white body text (3.76:1); filled buttons always use accent-600".

| Repo token | New value | Design name |
|---|---|---|
| `--si-accent` | `#3A66E0` | accent-600 — the one filled primary per view |
| `--si-accent-hover` | `#4C7EF3` | accent-500 — button hover, progress fill |
| `--si-accent-deep` | `#2B4EB8` | accent-700 — pressed, selected tab underline |
| `--si-accent-ink` | `#8FADFA` | accent-400 — accent *as type*: links, active nav label |
| `--si-accent-line` | `rgba(76,126,243,0.45)` | — |
| `--si-accent-soft` | `rgba(76,126,243,0.10)` | accent-tint — selected row, active nav wash |
| `--si-accent-fg` | `#ffffff` | white on accent-600 = 5.05:1 |
| *(new)* `--si-accent-100` | `#D8E2FE` | text on filled accent at large sizes |
| `--si-focus-ring` | `rgba(76,126,243,0.6)` | focus |

**Deliberate deviation, and the reason for it.** The design specifies the ring as a two-layer box-shadow: `0 0 0 2px {surface}, 0 0 0 4px rgba(76,126,243,0.6)`. That inner layer names the surface the control sits on, so every call site must know its own background — which is a raw colour at 60-odd call sites and breaks the moment a control moves. v2's existing `outline: 2px solid var(--si-focus-ring); outline-offset: 2px` produces the same two-band result from one rule, follows the element's border-radius for free, and costs no per-site knowledge. **Keep the outline; take the design's colour.** The positive offset stays load-bearing for the same reason it was introduced in `#396`: a cobalt ring drawn *on* a cobalt-600 fill is invisible.

### 2.4 Secondary — periwinkle

New role, but the repo already has a near-identical hue. Re-point `--si-violet` (`#b6a4ed`) to the design's `secondary-400 #B3A6EE`, add `--si-violet-deep #8B7BE0`, and keep `--si-violet-soft` at 14–18%.

Its use is **capped at one instance per view** and restricted to exactly three meanings: Space identity marks, public-link affordances, and the "shared with others" direction. If it ever competes with cobalt, drop it.

### 2.5 Semantics — and the `--si-amber` trap

The design ships five semantics as fill/ink pairs, which is the shape `#419` already generalised. Four map straight across:

| Repo | Ink | Fill | Design |
|---|---|---|---|
| `--si-green` | `#7ED39F` | `#57B87F` | Success — upload complete, saved, restored, sync healthy |
| `--si-rose` | `#F0908A` | `#C4483F` | Danger — delete, permanent removal, failed upload, revoke |
| `--si-cyan` | `#8CC7E8` | `#3E86AE` | Info — read-only notice, indexing, neutral system message |
| *(new)* `--si-neutral` | `#B8B2A9` | `#4A453F` | Neutral — counts, offline, "no change"; the default badge |

**The trap.** `--si-amber` is currently `var(--si-accent)` — an alias, on the reasoning that the brand *was* warm, so "brand tint" and "amber" were the same colour. With cobalt that identity dissolves: every `--si-amber` consumer (badges, avatars, folder chips, the co-editing lock pill) would silently turn blue. The design wants a real amber warning (`#E6BC63` ink / `#C9932F` fill — link expiring, quota above 85%, locked by someone else), and it wants folder chips to be *cobalt* (`#8FADFA`) because folders are the thing you most often want to hit.

So: **break the alias.** `--si-amber` becomes a real warning pair, and every consumer must be triaged into *warning* or *brand tint* by hand. Grep `--si-amber` before touching anything else in this PR — this is the one change here that fails silently and looks intentional.

### 2.6 File types — four families become ten hues

This reverses `#419`, whose comment reads: eight hues "spanned 300° of the wheel at near-maximum chroma and a mixed directory rendered as a rainbow". The design's answer to the same risk is different — it keeps ten hues but pins **saturation low and the tint at 14%**, so "a folder of mixed types doesn't turn into confetti — and so the cobalt accent still wins attention". The tile is the *only* place a file-type colour may appear; file names are always `text-primary`, because a coloured file name would break the "cobalt means action" contract.

The repo already has ten `--fc-*` name pairs, so this is a pure value swap with zero consumer churn:

| `--fc-*` | Design | Hex |
|---|---|---|
| `folder` | Folder | `#8FADFA` |
| `doc` | Markdown / doc | `#7C9CC4` |
| `default` | Plain text | `#A39A8E` |
| `sheet` | Spreadsheet | `#7FAE8E` |
| `image` | Image | `#B192B8` |
| `pdf` | PDF | `#C08578` |
| `archive` | Archive | `#B79A5F` |
| `code` | Code | `#6FA8A8` |
| `video` | Video | `#9A93D4` |
| `audio` | Audio | `#C48BA0` |

`--fc-deck` (presentations) has **no colour in the design.** Assign it the PDF tone `#C08578` — decks and PDFs are both "rendered pages" — and flag it as the one invented value in this PR.

### 2.7 Type — IBM Plex, and three settings that must go

```
- @fontsource-variable/geist
- @fontsource-variable/jetbrains-mono
+ @fontsource-variable/ibm-plex-sans   # 5.3.0, variable, verified published
+ @fontsource/ibm-plex-mono            # 5.3.0
```

Keep `@fontsource-variable/inter` in the fallback chain so a load lag does not flash `system-ui`.

`v2.scss` carries three settings that are **Geist/Inter-specific and must not survive the swap**:

- `font-feature-settings: 'ss01', 'cv11', 'cv03'` — those are Geist/Inter character variants. Plex has no such features, so they silently do nothing. Remove.
- `font-weight: 440` and `font-variation-settings: 'wght' 440` — the design limits weight to **400 / 500 / 600**. A 440 default puts every body string off the scale. Remove; set 400.
- `-webkit-font-smoothing: auto` — the design specifies `antialiased`. Change.

Keep `font-variant-numeric: tabular-nums`; the design wants mono data tabular by default and it is already global.

### 2.8 Type roles — a new `_type.scss`

`--si-text-1…15` stays exactly as it is. It is a record of the sizes v2 ships, it is unopinionated, and re-basing it would move pixels in 337 places for a naming difference.

What the design adds that a size token cannot express is a **role**: nine of them, each bundling size, weight, letter-spacing, family and colour, because the design's central diagnosis of the old UI is that "titles and metadata shared a size" — every role must differ from its neighbours in **at least two** of those axes.

Add `custom-v2/styles/_type.scss` with nine mixins:

| Role | Spec | Used for |
|---|---|---|
| `page-title` | 28 / 1.15 / 500 / −0.02em / primary | one per page, top-left of the content plane; never wraps to two lines |
| `section` | 18 / 1.35 / 500 / −0.01em / primary | panel headers, dialog titles, space card titles |
| `subsection` | 15 / 1.4 / 500 / primary | card headings, grouped setting labels, sheet titles |
| `body` | 14 / 1.5 / 400 / secondary | descriptions, dialog copy, comments — max 68ch |
| `body-strong` | 14 / 1.5 / 500 / primary | **file and folder names — the row's entry point** |
| `meta` | 12.5 / 1.45 / 400 / tertiary | sub-titles under a page title, secondary row line, helper text |
| `label` | 11 / 1 / 500 / 0.1em / caps / tertiary | sidebar group heads, panel section heads, column heads |
| `mono-data` | mono 12 / 1.45 / 400 / tertiary | sizes, timestamps, counts, version numbers |
| `mono-path` | mono 12 / 1.45 / 400 / secondary | space paths in search and favourites; keyboard shortcuts |

The division that governs every one of them: **IBM Plex Sans for anything a person wrote, IBM Plex Mono for anything a system produced.** Paths, byte sizes, timestamps, version numbers, shortcuts and token names are mono. File names are never mono.

### 2.9 Radii, shadows, motion

**Radii** — adopt the design's ladder. This reverses `#398`'s deliberate 6→7px call, with the design as the new authority; the visual delta is one pixel on every control.

| Repo | Current | New | Design | Used for |
|---|---|---|---|---|
| *(new)* `--si-r0` | — | `4px` | radius-xs | chips, badges, inline code |
| `--si-r1` | `7px` | `6px` | radius-sm | buttons, inputs, menu items |
| `--si-r2` | `10px` | `8px` | radius-md | cards, file-type tiles, toasts |
| `--si-r3` | `14px` | `12px` | radius-lg | dialogs, panels, sheets |
| *(new)* `--si-r5` | — | `16px` | radius-xl | mobile bottom-sheet top corners |
| `--si-r4` | `999px` | `999px` | radius-full | avatars, pills, toggles |

**Shadows** — the design is explicit that shadows are pure black at low alpha, because "a warm base plus a warm shadow turns muddy", and that elevation never substitutes for a surface step (overlays get both). Drop the `0 1px 0 oklch(1 0 0 / 0.0x) inset` top-edge highlights, which have no counterpart in the design.

```
--si-shadow0: none;                                   /* rows, sidebar, anything in flow */
--si-shadow1: 0 1px 2px rgba(0,0,0,0.45);             /* cards on hover, sticky toolbars */
--si-shadow2: 0 4px 12px -2px rgba(0,0,0,0.55);       /* popovers, dropdowns, tooltips */
--si-shadow3: 0 16px 40px -8px rgba(0,0,0,0.65);      /* dialogs, sheets, bulk action bar */
```

**Motion** — re-point, and add the two curves. 120ms stays the house transition, so the 103 declarations that use it are untouched.

```
--si-dur-1: 80ms;    /* was 100ms — hover value changes, icon colour */
--si-dur-2: 120ms;   /* unchanged — buttons, checkboxes, chips, row hover */
--si-dur-3: 180ms;   /* was 200ms — menus, tooltips, toasts, tab switch */
--si-dur-4: 260ms;   /* was 220ms — right panel, bottom sheet */
--si-ease-out: cubic-bezier(.2,.8,.3,1);   /* everything entering or settling */
--si-ease-in:  cubic-bezier(.4,0,1,1);     /* everything leaving */
```

`--si-ease` (plain `ease`) stays as an alias so nothing breaks in this PR; migrate call sites in Phase 1.

The governing note, worth keeping in the file: *nothing in a file manager should feel animated.* Rows and menus fade and translate ≤4px; the only motion above 200ms is a panel or sheet changing the layout.

### 2.10 The verification this PR owes

`_tokens.scss` currently carries a 5 × 7 contrast table plus per-token floors for `line-strong` and the focus ring. **This PR invalidates all of it and must replace it, not delete it.**

Method is already established in this repo and must be followed exactly: `oklch()` defeats `rgb()`-based contrast parsing, so measure by **canvas pixel readback against the rendered app**, not by parsing computed styles.

What has to be re-solved and written back into the header:

1. Four text tiers × seven surfaces, with the sub-4.5:1 cells marked, and the practical rule each implies.
2. `--si-line-strong` against every surface a bordered control occupies — it is aliased to `--si-border` and draws input, select and dialog boundaries, so WCAG 2.2 SC 1.4.11 wants 3:1. The design gives `line-strong #4A453F`, which is **considerably darker** than the current `#8d929c`; verify it clears 3:1 on the input fill (`bg3`) before accepting it, and reach for a lighter value if it does not. This is the single most likely place the design's values fail our floors, because the design uses `line-strong` only for hovered inputs and dashed drop targets, whereas we alias it to every bordered control.
3. The focus ring on all seven surfaces.
4. White on `accent-600` (design says 5.05:1) and on `accent-700` (7.28:1).

### 2.11 The raw-colour rule, enforced

Q3 made "no component references a raw colour" the precondition for a later light theme. Enforce it with a test rather than a convention, since a convention is what produced the current state.

Measured surface: **~70 real occurrences across ~12 files** — chiefly `rgba(0,0,0,…)` shadows and scrims, plus a handful of `#fff`, `#666`, `#111`, `#f5f5f7`. Most collapse into `--si-shadow*`, a new `--si-scrim: rgba(11,10,9,0.6)` (the design's dialog and sheet scrim), and `--si-accent-fg`.

**Trap for the test itself:** a naive `#[0-9a-f]{3}` match hits every PR reference in a comment — `#419`, `#398`, `#405` and dozens more. The test must match only inside a declaration value, or strip comments first. Get this wrong and the test is unrunnable noise.

### 2.12 Acceptance

- `npm -w frontend run build` clean; `npm -w frontend run test` green.
- Every v2 screen browser-verified against the new skin at 1440×900 (see §11).
- `_tokens.scss` header carries a fresh, measured contrast table — no stale numbers from `#419`.
- Zero raw colours in `custom-v2/**` outside `_tokens.scss`, proven by the new test.
- `--si-amber` triage complete: every former consumer is deliberately *warning* or *brand tint*.

---

### 2.13 What Phase 0 actually settled — read this before Phase 1

Shipped in **#432**. The phase came in roughly as scoped, but it found one whole
class of defect the plan did not anticipate, and two of the design's own values
failed their own floors. Do not re-derive any of this.

**The plan's biggest omission: the accent hue swap broke 24 declarations that
were correct under kraft.** §2.5 caught this pattern in one direction — the
`--si-amber` alias — and missed that it runs the other way too. A warm accent had
been standing in for "gold" and for "readable brand text", and cobalt is neither:

- **21 sites used the accent fill as type.** accent-600 measures 3.48:1 on the
  content plane and ~3.4 on its own tint, so it fails as text; kraft at L 0.70
  passed, which is exactly why they existed. All lifted to accent-400. Measured in
  situ afterwards, the active nav label reads **7.41:1**.
- **The favourite star was `--si-accent`** because the accent used to be gold.
  Under cobalt a star both breaks "cobalt means action" and contradicts the
  design's amber favourite badge. → `--si-amber-ink`.
- **Space identity marks were cobalt.** The design reserves the accent for the
  action beside them: "Periwinkle marks Space identity so cobalt stays reserved
  for Create space." → `--si-violet-soft` / `--si-violet`.

The lesson for the remaining phases: **when a token's hue changes, grep its
consumers and ask what each one was using it FOR**, not whether it still
compiles. Neither the build nor the type system sees any of this. `tokens.spec.ts`
now pins all three shapes.

**Two design values failed their own stated floors** (both now deviations in
`_tokens.scss`, both pinned by tests):

- The focus ring's `rgba(76,126,243,0.6)` composites to **2.55 → 2.03** across the
  seven surfaces and fails SC 1.4.11's 3:1 on every one. §2.3's deviation was
  written about the *implementation* (outline vs box-shadow) and had not measured
  the colour. Opaque accent-500 reads 5.09 → 3.28.
- `--si-line-strong` as `--si-border` measures **1.69** on the input fill, which
  §2.10 predicted. Resolved with `#8A857D` — the design's own text-tertiary tone,
  so no invented colour. Note *why* this matters more here than in the design: the
  design's inputs are fill-only, but that fill is 1.10:1 against the content
  plane, so it identifies nothing on its own.

**Three things done here that the plan had not scoped**, each because it was a
colour problem rather than a structural one:

- **Avatars.** They generated a per-user oklch hue, i.e. a login could put a
  colour on screen that no designer chose. Now six in-palette tones with
  per-tone measured ink (`AVATAR_TONE_COUNT`, `avatarTone()`), which also fixed a
  pre-existing split where `people.component.html` built its own ramp at a
  different L and C from the avatar component's — one person rendered as two.
- **The logo.** A kraft→navy conic gradient has no counterpart in a one-accent
  system, so the mark changed with the palette: a solid cobalt disc with a
  punched-out centre, per the design's own masthead.
- **`fonts.scss`.** `v2.scss` was already 1.38 kB into the `anyComponentStyle`
  warning band on develop; ~9 kB of font CSS pushed it past the error. The
  `@font-face` rules are their own `styleUrls` entry now — @font-face is global
  regardless, so the old co-location implied a scoping that was never real.

**Corrections to this plan's own text:** `--si-fg-faint` is *aliased* to
`--si-fg-muted`, not codemodded — the alias is what delivers the visual change,
and the ~150-site rename is cosmetic. Same for `--si-bg4` → `--si-bg3`. Both
renames belong in Phase 1. The raw-colour count was 63 by declaration-prefixed
grep; the test found more (template attributes, `accent-color`, entity
false-positives), so trust the test, not a grep.

**Phase 1 inherits two things already done:** the secondary button is filled
surface-3 with no border (it read as a disabled outline next to the filled
primary, and only looked right against the old ramp), and the avatar tones above.
It still owes the two alias retirements and the `--si-ease` call-site migration.

---

## 3. Phase 1 — primitives, verified in `_kit`

One PR, `feat/v2-design-primitives`. `screens/kit/` is the in-repo component gallery and is the right place to land and verify all of this before a single screen consumes it.

The governing rules, from the design:

- Controls are **32 / 36 / 44px** (sm / md / lg). Desktop uses md; touch targets are never below 44px.
- **Hover is always a surface step up. Active is a surface step plus a 1px inset. No control ever moves on press.**
- One primary per view; secondary for the two next-most-likely actions; ghost for everything else; icon-only *only* when the glyph is unambiguous **and** tooltipped.

| Component | File | Work |
|---|---|---|
| Button | `components/button.component.ts` | 5 kinds (primary, secondary, ghost, danger-quiet, danger-filled) × 6 states (default, hover, pressed, focus, loading, disabled) × 3 sizes, plus the **split** variant (action + overflow, 1px divider). Danger-filled is confirm-only. |
| Icon button | `components/icon-button.component.ts` | 32px; default / hover / active / disabled. Every instance gets a tooltip carrying its shortcut. |
| Input | new `components/input.component.ts` | **Filled, not outlined** — "the fill is what makes an input findable on a dark plane". 5 states incl. inline error. Placeholders describe *scope* ("Filter in Personal…"), never the control. |
| Select + menu | extend `context-menu.component.ts` | Select shows the current value, never a label. Menus open on the trigger's edge with 4px offset and `--si-shadow2`. Menu items: selected / rest / hover / disabled-with-reason. |
| Checkbox / radio / toggle | `components/checkbox.component.ts` + new | Checkbox off/on/mixed/disabled; radio; toggle off/on/disabled. **Toggle only for a setting that applies immediately with no Save.** |
| Segmented | new `components/segmented.component.ts` | Active = `--si-bg6`. Used for density, view mode, search scope, edit/preview. |
| Badge | `components/pill.component.ts` | 7 shapes, one per meaning: favourite, locked, link, shared·n, comments·n, version, read-only. **Favourite is the only icon-only badge.** |
| Chip | `components/pill.component.ts` | Recipient chips for the share dialog: avatar + name + dismiss, and group variant. |
| Avatar + stack | `components/avatar*.component.ts` | 24/28/32/40px, initials on a hue derived from user id, presence dot. **Stacks cap at 3 + count**; the overflow chip is last and never looks clickable. |
| Tooltip | new `components/tooltip.directive.ts` | 400ms in, none out. Carries the shortcut in mono. Required on every icon-only control. |
| Tabs | new `components/tabs.component.ts` | **Always labelled — icon-only tabs are forbidden.** Counts inline in the label. Active = 2px `--si-accent-hover` inset underline. |
| Breadcrumb + history | `layout/page-breadcrumb.component.ts` | Back/forward become **one joined 32px pair** at the far left, then a 20px gap, then the trail. Last crumb is primary and not a link. |
| Skeleton | new | Mirrors the exact row geometry. **2–5 rows max; never a spinner for a list.** |
| Empty state | `components/empty-state.component.ts` | Always offers the one action that resolves it. |
| Pagination | new | `1–50 of 214` in mono, then the page cluster. |
| Toast | `components/toast-host.component.ts` | The only place a background job may claim attention. Undo variant with an 8s window. |
| Dialog | `components/confirm-dialog.component.ts` | 560px, `--si-r3`, `--si-shadow3`, 60% scrim. **Title states the object; the primary button states the verb.** |
| Progress | `layout/transfers-popover.component.ts` | Per-file and aggregate. Determinate bar in `--si-accent-hover`. |

Also in this PR: retire `--si-fg-faint` and `--si-bg4`, and migrate `--si-ease` call sites to `--si-ease-out` / `--si-ease-in`.

**Icons.** Extend `icons/icon-v2.component.html` with the six Lucide glyphs the design names and we lack: `gallery-horizontal-end`, `panel-right-close`, `audio-lines`, `calendar-clock`, `link-2-off`, `search-x`. Existing glyphs must be re-checked against the design's spec: **1.5px stroke, no fills, `currentColor` only, 14 / 16 / 18 / 20px sizes**. Icons default to `--si-fg-tertiary` and lift to `--si-fg` on hover; **an icon is never cobalt unless its control is the active one.**

---

### 3.1 What Phase 1 actually settled

Shipped in **#433**. Six new primitives (segmented, input, tabs, tooltip, skeleton,
pagination), button and pill rebuilt, and phase 0's two token aliases retired.

**Two items from the table above did NOT ship and are deliberately deferred**, because
both are additive and neither blocks phases 2–7: the **dialog geometry
consolidation** (560px / `--si-r3` / `--si-shadow3` / `--si-scrim` across the eight
dialog components) and the **select/menu extension** of `context-menu.component.ts`.
Phase 5 is the first phase that actually needs either; fold them in there if they
have not landed sooner.

**The button size re-point is the change most likely to surprise you later.**
81 of 89 call sites were `size="sm"` at 28px — the whole app sat below the design's
smallest step. `sm` is now 32, `md` 36, `lg` 44, and `xs` stays 28 as an off-ladder
escape hatch for dense rows. Every toolbar in v2 therefore grew 4px. When a later
phase reads "the design's toolbar buttons are 36px", that means `size="md"`, which
is NOT what the screens pass today.

**One phase-0 defect surfaced here, and it is the same shape as the 24 the token
PR found:** `.pill--amber` still resolved its ink through `--si-accent-ink`, from
when the accent was the warm tone and `--si-amber` was its alias. Blue text on an
amber fill. The grep in phase 0 looked for `color: var(--si-accent)` and this was
`color: var(--si-accent-ink)` on an amber background — a pairing no single-token
grep finds. **If you touch a semantic colour, check its `-ink` partner too.**

**Three defects that only rendering caught**, none of which fails a build:

- **A backtick inside a CSS comment inside a `styles: [\`…\`]` template literal
  terminates the literal.** The compiler says "Failed to resolve styles at position
  1 to a string" and names no file. Worse, the failure was masked: `grep '\[ERROR\]'`
  over `ng build` output never matches, because ANSI colour codes split the
  brackets — three builds read as clean when they were broken. **Check the exit
  code, never grep the output.**
- **`focus` does not bubble.** The tooltip directive sits on a component host
  (`app-v2-icon-btn`), so the element that receives focus is the `<button>` inside
  it: the tooltip worked on hover and was invisible to every keyboard user.
  `focusin`/`focusout` bubble; `mouseenter` needs no equivalent fix because it
  fires on ancestors too.
- **Anything mounted outside `.v2-root` has no tokens.** The tooltip appends a node
  to the DOM, and `document.body` resolves every `--si-*` to nothing.

---

## 4. Phase 2 — the file browser (D1, D2)

One PR, `feat/v2-file-browser-chrome`. Files: `screens/files/file-browser.{base.ts,component.html,component.scss}`, `file-browser-repository.ts`, `screens/files/testing/file-browser-contract.ts`.

This is the largest structural phase. Since `#346` the two browser screens are one component, so all of it is edited once.

### 4.1 The header stack

The design's hierarchy is: page title (28px) → count line (mono meta) → **toolbar with one filled primary** → filter and view switch **on their own row** → table. The control row is separated from the title row deliberately, "so the primary action never sits next to a text field".

Toolbar `3b`: `New` (primary, filled) + `Upload` (secondary) + the view segmented cluster + `⋯`. `Download from URL` demotes to ghost. Currently `New` is `size="sm"`; the design's toolbar buttons are 36px (md).

### 4.2 The table

- Rows drop **56px → 44px** and gain a density control (36 / 44 / 56).
- **Banding replaces dividers.** Alternating `--si-bg2` / `--si-bg-band`; no row borders at all, because "no lines to fight the badges". Hover reads as a third value (`--si-bg3`).
- **Badges get their own 152px column**, so the name column has a single clean left edge. Favourite, lock, share count, link and comment count all move out of the name cell.
  - The lock badge stays an **action** (it opens the unlock dialog) and must keep a path on mobile — the existing comment in `file-browser.component.html` explains why it was in the name cell, and that reason must be honoured in the mobile layout of Phase 7.
- Selected row = `--si-accent-soft` + a 2px cobalt marker on the **inner** content's left edge — never a border.
- Drag-over = inset accent ring. Pending/optimistic = 50% opacity.
- Column grid: `34px 1fr 152px 96px 132px 36px`.

### 4.3 Selection — a floating bar, not a toolbar swap

Today, selecting rows replaces the toolbar's contents, which moves the primary action. The design forbids that: the bar **floats 16px above the content edge on `--si-shadow3`** and "never replaces the toolbar, so the primary action stays put".

Contents, in order: `2 selected` · `Select all 3` (accent text) · divider · Download (secondary) · Move (ghost) · Share (ghost) · spacer · **Trash (danger-quiet, isolated far right)** · dismiss.

Keyboard: `Esc` clears, `⌘A` selects all, shift-click ranges.

### 4.4 The list end — the fix for "the large empty canvas"

Content height is bounded by the list, not the viewport. After the last row: a **list footer** stating totals (`8 items · 6 files · 2 folders · 4.1 MB`, and the active sort), then a **dashed drop affordance** filling the remaining height. "A three-file folder ends with a footer, never with 600px of void."

### 4.5 The empty state (D2)

The empty state **is** the drop target: one bounded panel, max 560px, on `--si-bg1` with an inset hairline, **left-aligned to the content gutter — never vertically centred in the viewport**, so the page still reads top-down. Two actions, one filled (`New markdown file` / `New folder`), and a footer of shortcut hints (`N new · U upload · ⌘K commands`).

### 4.6 Tests

`file-browser-contract.ts` already pins view-mode persistence with `viewModeKey`. Add a `densityKey` to the contract in the same shape and cover: default is `comfortable`, a stored value is honoured, nonsense falls back. `viewModeStorageKey()` stays a component method for the reason `#346` recorded — the base's `mode` signal initialises before the subclass field holding the repository exists — and `densityStorageKey()` follows the same rule.

---

### 4.7 What Phase 2 actually settled

Shipped in **#434**. The header stack, table, selection model, list end and empty
state all landed as specced. Three notes for later phases:

- **The density default is a behavioural change, not just a token one.** v2 shipped
  56px rows — the *relaxed* step — so `comfortable` moves every existing user up a
  notch. The contract pins the default for that reason.
- **`repository.filterPlaceholder` is gone.** It was a per-screen constant that
  said "Filter in Personal…" three folders deep. The placeholder is now computed
  from `folderLabel()`. Any repository added later does not need the field.
- **The bulk bar is positioned against `.personal`, not the viewport.** A
  viewport-fixed bar would sit over the mobile bottom tab bar, so `.personal`
  gained `position: relative`. Phase 7 depends on that.

---

## 4.8 Phase 2b — grid view

**Maintainer decision (2026-08-04):** grid gets its own small phase rather than
riding along with gallery, because phase 7 re-lays-out whatever grid becomes and
doing it twice was the default outcome otherwise.

The design gives grid **no mockup** — D8 is the gallery, D3 is space cards, and the
Components page has no file card. So this phase applies the *conventions* rather
than transcribing a screen: the card rules from the Components page (surface step
at rest, `radius-md`, hover = next step + `shadow-sm`), D1's badge and selection
rules, and the sans/mono split.

Shipped in **#435**:

- **Card is flat at rest, lifts on hover.** It carried `shadow-1` permanently,
  which the design lists under "cards ON HOVER" — a card already lifted has nowhere
  to go, and thirty of them read as noise. Radius drops `radius-lg` → `radius-md`;
  dialog radius on a card reads as a floating surface.
- **Selection matches the row**: accent tint plus a 2px cobalt edge, as an inset
  ring rather than a left marker — a card has no row rhythm to preserve, and a 2px
  stripe down one side of a 180px tile reads as a defect.
- **One grouped badge strip, top-right**, replacing three scattered corners
  (comments top-right, favourite top-left, lock bottom-right). Favourite becomes a
  pill so all three are the same shape. Top-right and not bottom-left/top-left:
  bottom-left crowds the name, top-left is the selection chip's corner and a badge
  under the checkbox target is a mis-click waiting to happen.
- **Metadata is mono for the whole line**, not just the byte count. A size and a
  timestamp are both machine output; mixing families inside one line was the
  clearest remaining violation of the split in this component.

**Two traps this phase hit, both worth remembering:**

- **There is no surface step to spend between the page and a card.** The header was
  set to `bg2` on the reasoning that a step *down* makes a thumbnail read as inset
  — but `bg2` IS the content plane, so the header went invisible, the card appeared
  to start at its own body, and the badge strip floated outside it. The header is
  `transparent` and inherits the card's surface.
- **`file-browser.component.scss` crossed the 14 kB `anyComponentStyle` error
  budget** by 7 bytes. It is now three `styleUrls` entries — list + chrome, grid,
  gallery — which is the same fix as `fonts.scss` in #432 and also the honest
  shape: these are three independent view modes that share only the toolbar above
  them, and one 970-line file made that invisible.

The initial-bundle warning is now 993 kB over (was 958 on develop before phase 0).
That ~35 kB is the design system's own weight across phases 0–2b; the error
threshold is 5 MB, so it is a number to watch rather than act on.

---

## 5. Phase 3 — the inspector (D4, D5)

One PR, `feat/v2-inspector-tabs`. Files: `layout/dock-panel.component.ts`, `layout/dock-rail.component.*` (**deleted**), `layout/dock-rail.service.ts`, `layout/layout-v2.component.*`, `screens/file-detail/*`, `components/versions-panel.component.ts`, `components/comments-panel.component.ts`.

### 5.1 Panel `2a`

Docked at 340px, pushing content. **Four labelled tabs** with inline counts (`Properties` · `Comments 4` · `Versions 3` · `Activity`), each `flex: 1`, active carrying a 2px cobalt inset underline. Panel steps **down** in value to `--si-bg1` with no dividing border — the value change is the edge.

Shared rules: `⌘I` toggles; width drag-resizable **300–520px and remembered per user**; tab selection persists across files. Below 1180px it becomes an overlay (`2b`); below 768px a bottom sheet (Phase 7).

The rail is deleted and its single toggle button moves into the file identity band, where D4 draws it.

### 5.2 The file detail bands (D4)

Three bands above the document:

1. **Identity** — file-type tile, name + `markdown · 721 B · edited 14 min ago by you` in mono, **save state as a badge** (`✓ Saved` on success tint), icon actions, then `Share` as the one filled primary. The design calls out that the old `Read-only (user – Sync-in)` sentence is gone: save state is a badge, not prose.
2. **Editor bar** — edit/preview segmented, then heading / inline / block groups separated by hairline dividers, "so 14 icons read as 4 clusters". Right-aligned hint: `markdown · ⌘S saves a version`.
3. **Document** — the document sets its own **72ch measure**; the panel does not stretch the text.

### 5.3 Version cards (D5)

- **One primary per card.** `Restore` is a real button; `Preview` and `Download` are ghost; revert-to-here, copy link and delete move into `⋯`. **The current version has no actions at all.**
- Each card states its **delta and origin** — `+123 B` and `· 329 B · desktop sync` in mono under the author — so two same-minute versions are distinguishable.
- The quota note becomes a **footer below a divider** in `--si-fg-tertiary`, out of the scan path — not a card.

Two things to leave alone while in here, both load-bearing and documented in `CLAUDE.md`: the OnlyOffice `changeHistory: false` (vestigial, must not be flipped) and both history handlers re-mounting the editor.

### 5.4 Comments (D5)

Threaded list with 24px indent for replies, composer pinned to the bottom on its own `--si-bg2` band, `⌘↵ to post` hint, one filled `Comment` button.

---

### 5.5 What Phase 3 actually settled

Shipped in **#437**. The panel, the four labelled tabs, the version cards, the
comments composer and the D4 identity band all landed. Five things are worth
knowing before Phase 4.

**The phase's real content was a consolidation the plan did not name.** There were
TWO inspectors: the layout's dock panel (Info / Comments, opened from the icon
rail) and a second, near-identical aside built into `file-detail` (five unlabelled
glyph tabs, its own property table). D4 and D5 draw one panel. So `file-detail`
now publishes its file to `InspectorService` like every other screen and its aside
is deleted — which is why the file-detail diff is mostly subtraction, and why the
panel gained the Versions tab on the *browser* screens for free.

**`dockOpen` and `dockVisible` are not the same thing, and conflating them is a
bug.** Open-ness is the user's standing intent and survives navigation; what
renders is `dockOpen() && inspector.available()`. Rendering on `dockOpen` alone
left an empty panel sitting open on `/shared` and `/trash`, which register no
selection — and closing it on arrival would have cost a second ⌘I on the way back.
Pinned in `layout-v2.service.spec.ts`.

**Two of the design's own instructions could not be transcribed, both because the
backend has nothing behind them:**

- **Comment threading.** D5 draws a 24px reply indent plus Reply / Resolve.
  `Comment` carries `fileId` and `userId` and *no* parent or thread id, so every
  comment is top-level. An indent with no threading, or a Reply that posts another
  top-level comment, is a promise the server does not keep. The list is flat.
- **The editor bar's edit/preview segmented.** Our two markdown modes are
  *formatted vs source* and *edit vs read-only*, and the second one is a real
  server LOCK/UNLOCK (`markdown-view.toggleReadonly` → `filesService.lock`).
  Presenting a locking operation as a view switch would be worse than the icon
  button it replaced, so the icon buttons stay and only the `⌘S saves a version`
  hint was added — gated on `versions.availability()`, because on a server with
  versioning off the hint would be false.

Two smaller substitutions in the same family: D4's `edited 14 min ago **by you**`
drops the "by you" (no field on the browse response names a last editor), and the
version card's `Current` / `Original` tags are gone — `listVersions` returns
history only, never the live file, and thinning means the oldest surviving row is
not necessarily the original. Every row carries its signed byte delta instead,
measured against the next-newer content (the live file, for the newest row).

**Phase 1 shipped the icon button's active state as a plain surface step, i.e.
identical to hover.** The design's Components page specifies `rgba(76,126,243,0.14)`
+ accent-400 for it, and its own icon rule licenses that ("an icon is never cobalt
unless its control is the active one"). This phase depends on it — the panel
toggle's active state is the only feedback that the panel is open — so
`icon-button.component.ts` now uses `--si-accent-soft` / `--si-accent-ink`. That
touches eight `[active]` call sites, all of which are genuine toggles.

**One finding left for later, with its measurement:** `color: var(--si-rose)`
appears at **31 declarations across 20 files**. `--si-rose` (#C4483F) is a FILL; as
type it measures ~3.6:1 on the content plane, under the 4.5 a 13–14px string needs,
and `--si-rose-ink` is the pair's type tone. The four sites in files this phase
rewrote are fixed; the remaining ~27 are a mechanical sweep that wants its own PR
and its own measured table, not a drive-by inside a feature diff. It is the same
shape as the 25 accent bugs Phase 0/1 found.

Also here, and additive: `app-v2-btn` gained a `block` input (the panel's
full-width "Manage sharing" is the design's one instance), and the `panelRight`
glyph was added to `app-v2-icon`.

---

## 6. Phase 4 — search (D6)

One PR, `feat/v2-search-results`. Files: `screens/search/search.{ts,html,scss}`.

- The field is **48px — the only oversized input in the product**, "because it is the page's subject".
- Full-text becomes a **segmented control**, not a checkbox. Same signal, already wired: the backend gates it on `files.contentIndexing.enabled` and 400s when disabled.
- Results **group by space**, with a `label`-role group header and a hairline rule filling the remaining width.
- Path in `mono-path` under the name; the name stays sans 14/500. Matched terms render in cobalt.
- **Snippets need no backend work** — `FileContentModel` already carries `matches: string[]`.
- Filter pills: `All types` / `Any time` / active-filter pills in `--si-accent-soft` with a dismiss.
- Result meta: `5 results in 3 spaces · 41 ms`.
- **No-results gets its own copy**, distinct from the zero state and from the error state — the design forbids reusing "nothing here" across the three. Its actions: `Search names only`, `Include trash`, `Clear filters`.

### 6.1 What Phase 4 actually settled

Shipped in **#438**. The 48px field, the scope segmented, grouped results, match
highlighting, the facet chips and three distinct empty states all landed. Five
things for later phases.

**The backend already highlights full-text matches, and rendering that as text
prints markup on screen.** `files-content-store-mysql.service.ts:217` wraps every
matched term in `<mark>…</mark>` before returning `matches[]`, so a snippet arrives
with markup in it. Classic binds it with `[innerHTML]`
(`applications/search/components/search.component.html:69`); this screen parses the
markers into segments instead (`markSegments`), because the text AROUND the markers
is raw file content that the backend does not escape — a document containing
`<img onerror=…>` reaches the browser as markup, and Angular's sanitizer defangs the
handler but still renders the element. The same screen highlights NAMES itself, by
query, because the server marks only contents. Both paths return segments and the
template renders them with `@for`; nothing on this screen binds `innerHTML`.

**`.row` is not a usable class name anywhere in this app.** The classic UI loads
Bootstrap globally, and its `.row > * { width: 100% }` puts every child of a `.row`
on its own line — which is what the first render of the result row did. It cannot be
won with a class, because the rule targets the CHILDREN, which carry none of ours.
Renamed to `.result`. A sweep found this is the only collision in all of
`custom-v2`; `.chip`, `.group`, `.field`, `.tabs` and `.pill` are all clear of
Bootstrap's top-level selectors.

**The facets filter the fetched page, not the query.** `SearchFilesDto` carries
`content`, `fullText` and `limit` and nothing else — no type, no date range, no
trash flag. So `All types` and `Any time` narrow the ≤100 rows already returned,
which is honest only because the meta line counts what is ON SCREEN rather than
claiming a total. Two consequences: D6b's `Include trash` action does not exist
(there is no flag to set, so it is not offered), and a fourth empty state was
needed — "no results match these filters" is a different sentence from "no matches
for X", because in the second case the query DID match.

**Whether full-text is available is discovered, not configured.** `ServerConfig`
does not expose `files.contentIndexing.enabled`, and the endpoint 400s a full-text
query when it is off. So the screen asks by doing: a 400 settles it, the scope falls
back to names, the same query re-runs and the segmented stops offering a choice that
does not exist. Same shape as `VersionsService.availability`.

**The empty panel is a component now.** D6b's spec says "empty: same panel as D2",
so the panel phase 2 built inside `file-browser.component.html` moved to
`components/empty-panel.component.ts` and both screens use it — search with three
different copies, the browser with its own. Note the ordering trap in its
stylesheet: `:not(:has(*))` contributes **no specificity** (`:not()` takes its
argument's, and `*` has none), so the rule that collapses the footer has to come
AFTER the one it overrides or source order silently wins. Written first, it did
nothing and the panel drew a divider with empty space under it.

Two smaller notes: the input primitive gained a **trailing content slot** (the scope
segmented lives inside the field, per D6) and now suppresses
`::-webkit-search-cancel-button`, because `type="search"` was drawing a second clear
button beside the primitive's own. And group headers print space NAMES, which costs
one `listSpaces()` per visit — a result carries only the alias, which is a slug.

---

## 7. Phase 5 — the share dialog (D7)

One PR, `feat/v2-share-dialog`. Files: `components/share-dialog.component.ts`, `components/link-dialog.component.ts`.

**One dialog, two zones**, which is the substantive change — today sharing and links are two dialogs.

- **Top zone:** add-people row (input + permission select + `Invite` primary), then `WITH ACCESS · 3` and the access rows. Owner shows as text, not a control. **Inherited rights render disabled with their source named** (`group · 5 members · inherited from space`) — never hidden.
- **Divider**, then the **public link zone**: periwinkle link mark, description, enable toggle, the URL in mono with `Copy`, and the four options as a 2×2 grid of **inline rows — no "advanced" disclosure**: Expires, Password, Permission, Allow download.
- **Footer band:** `Revoke link` (danger-quiet, **left-aligned, far from `Done`**), then `Close esc`, then `Done` (primary).

Three roles everywhere, per the design's settled patterns: **view / edit / manage**.

Destruction follows the two-tier rule: revoking a link is *reversible* — act immediately, offer Undo in a toast for 8s. Only irreversible acts get a dialog.

**Ground-truth requirement.** Per `CLAUDE.md`, read the classic implementation before touching the wire calls — in particular `shares-manager.service.ts:581`, where `link.id < 0` means "new link" and anything else is update-by-id (which 404s for unknown ids). This exact detail has produced a v2 bug before.

---

## 8. Phase 6 — gallery and the upload dock (D8)

One PR, `feat/v2-gallery-upload`. Files: `screens/files/file-browser.component.{html,scss}`, `layout/transfers-popover.component.*`.

- Gallery is a **5-column grid of 4:3 tiles**, name on a single line under each, mono meta below.
- **Media placeholders are striped, never coloured blocks** — `repeating-linear-gradient` at 135°, 3.5% white. "The stripe says *image goes here*."
- In-flight items appear **as tiles in place** with a determinate bar at the bottom edge, a 45% scrim, and a spinner; their name renders in `--si-accent-ink`.
- The aggregate lives in a **bottom-right dock** (360px, `--si-bg5`, `--si-shadow3`) that collapses to a single line: `Uploading 3 of 5` / `4.2 MB/s · 12 s left`, a progress bar, then per-file rows with success / in-flight / failed-with-Retry states.

---

## 9. Phase 7 — mobile (M1–M6)

One PR, `feat/v2-mobile-relayout`. Files: `layout/{title-bar,bottom-tab-bar,left-nav,dock-panel}.*`, `components/action-sheet.component.ts`, `components/fab.component.ts`, `screens/files/file-browser.component.scss`.

Nothing new is invented — only re-laid out. Same tokens, three fewer columns, everything reachable with a thumb.

**Touch sizing.** Every tappable target is ≥44×44, even when the glyph inside is 17px: icon buttons keep a transparent 44px box and are pulled to the edge with negative margin so the visual rhythm still reads as 16px gutters. Rows 56px; drawer items 48px; sheet actions 52px; FAB 56px at `--si-r5`.

| Screen | Work |
|---|---|
| M1 · browser + bottom nav | Density is always `1c` on mobile: two-line 56px rows, metadata under the name, no columns. Badges become 12px glyphs beside the name. FAB replaces the primary button. **Bottom bar goes 4 tabs → 5:** `Files · Spaces · Shared · Recents · Search`, displacing Settings (which moves into the drawer footer, where it already is). |
| M2 · drawer | Largely present. 48px items, edge-swipe open, quota card in the footer. |
| M3 · viewer + info sheet | The inspector becomes a **bottom sheet snapping 50% / 92%**, tabs become pills, dismissed by drag or scrim tap, **primary action inside the sheet at full width — never in a header**. |
| M4 · search | Back + field + filter pills; results as two-line rows with snippets. |
| M5 · share sheet | The Phase 5 dialog re-laid out as a sheet. |
| M6 · long-press action sheet | Long-press enters selection; the sheet gets a file header and grouped actions with the destructive one in `--si-rose-ink`. |

**What is deliberately dropped on mobile:** the breadcrumb trail (replaced by back + parent name in the title block), density options, the badge column, hover states, keyboard hints. **Bulk selection stays**, entered by long-press.

**Responsive rules to encode** (four breakpoints, from the design):

| Breakpoint | Navigation | Right panel | Table & toolbar |
|---|---|---|---|
| ≥ 1440 | Sidebar 248px, groups expanded | Docked 340px, pushes content | Full columns; density switch visible |
| 1180–1439 | Sidebar 248px; groups collapse to active child | Docked, but content min-width 640px wins — drops to overlay if it would break that | Badges narrow to icons; density moves into `⋯` |
| 768–1179 | Icon rail 64px with tooltips; `⌘B` expands as overlay | Overlay at 340px with scrim | Size column drops; modified becomes relative-only; toolbar keeps New + Upload |
| < 768 | Drawer + 5-tab bar | Bottom sheet, 50% / 92% | Two-line 56px rows; FAB; long-press action sheet |

**Verification caveat.** Per the standing note, agent-browser's headless Chromium fires no `requestAnimationFrame`, no `ResizeObserver` and no native `resize`, and the viewport must be set **before** first load or breakpoint state stays stale. Sheet snapping must therefore be driven by `afterNextRender` and CSS, not by rAF, or it cannot be verified at all.

---

## 10. Phase 8 — keyboard hints and the session error strip

One PR, `feat/v2-keyboard-hints`. Small, and mostly markup.

**Ambient hints (4b).** Shortcuts printed where the action lives: on nav items, in tooltips, in menus, in the editor bar (`⌘S saves a version`), in the empty state (`N new · U upload · ⌘K commands`), in the dialog footer (`Close esc`), in the composer (`⌘↵ to post`). Plus a `?` shortcut sheet. The full set: `⌘K` palette · `⌘F` filter · `⌘I` panel · `⌘B` sidebar · `N` new · `U` upload · `F2` rename · `F` favourite · `⌘⇧S` share · `⌫` trash · `⌘A` select all · `?` sheet.

**Error levels.** The design defines three; we have two.

1. **Field** — inline, danger text. Exists.
2. **Action** — toast with Retry. Exists.
3. **Session** — a **persistent strip under the top bar**. New. Offline switches it on, disables write actions, and queues local edits with a count.

---

## 11. Cross-cutting requirements

**Per-PR discipline** (from `CLAUDE.md`):

- Branch off `develop`; base every PR on `develop`; `gh pr create --repo zjean/server --base develop …`.
- Squash-merge feature PRs. `develop` is strict-checked, so a batch of N PRs costs N−1 rebases — land them in order, not in parallel.
- UI-facing PRs need agent-browser screenshots committed under `docs/screenshots/` and embedded at the head SHA.
- Remotes use the `github-prive` SSH alias; the key must be `ssh-add`ed at session start or `git push` fails on publickey while `gh` still works.

**Browser verification recipe:** build the frontend and let the backend serve it on `:8080` (single origin, no proxy, no `ng serve`); drive it with agent-browser using an explicit `--session` name; cache-bust the document URL after every rebuild, because a stale `index.html` is served otherwise.

**i18n:** every new string goes in `frontend/src/i18n/custom/{en,nl}.json`. Parameterised strings need a defined `v2_`-prefixed snake_case key — an inline English-as-key string with `{{ placeholders }}` renders the placeholder literally. Short static strings use the English literal as the key.

**Testing:** `npm -w frontend run test` per PR. The file-browser contract suite is the only real frontend coverage and both browser screens run through it, so Phase 2 and Phase 7 must extend it rather than route around it. Backend is untouched by this programme — no `db:generate`, no e2e.

**Verify bulk CSS changes by computed-style diff, not by reading the diff.** Phase 0 is exactly the shape of change where this matters, and `-6px` → `-var(…)` is invalid CSS that silently computes to `0px`.

---

## 12. Sequence and dependencies

```
Phase 0  tokens + type substrate          ← blocks everything
   │
Phase 1  primitives, verified in _kit     ← blocks 2–7
   │
   ├── Phase 2  file browser (D1, D2)
   │      │
   │      └── Phase 6  gallery + upload dock (D8)
   │
   ├── Phase 3  inspector (D4, D5)
   ├── Phase 4  search (D6)
   └── Phase 5  share dialog (D7)
              │
Phase 7  mobile re-layout (M1–M6)         ← needs 2, 3, 5
   │
Phase 8  keyboard hints + error strip     ← touches everything, so last
```

Phases 2–5 are independent of each other and can be ordered by appetite; 6 needs 2, and 7 needs 2, 3 and 5. Phase 8 lands last because it adds a hint to nearly every surface the earlier phases rewrite.

---

## 13. Open, non-blocking

- **`--fc-deck`** has no colour in the design; the plan invents `#C08578` (the PDF tone). Confirm or replace.
- **`--si-line-strong`** at the design's `#4A453F` may fail 3:1 on the input fill. Phase 0 measures it; if it fails, we keep a lighter value and record the deviation. Do not accept the design's number unmeasured.
- **Q4 / Q5 / Q6** are taken at the design's recommendation (per-view `localStorage`, delete the rail, hints-not-palette). Each is reversible up to the phase that implements it.
- **Command palette** and **light theme** are explicitly out of scope and would each be their own programme.
