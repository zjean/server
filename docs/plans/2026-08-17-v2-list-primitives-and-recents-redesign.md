# v2 list primitives, and the recents redesign

**Status:** shipped, in four commits on `feat/v2-list-primitives-recents-redesign`.
**Brief:** "a better UI design for `/v2/recents`, fresher, dark mode only."

Read this before touching `custom-v2/components/file-row.component.ts`,
`section-head.component.ts`, `timestamp.component.ts` or `styles/_card.scss`. It records
what the audit found, the two design ideas that were tried and rejected *after* rendering
them, and the traps.

---

## 1. What the brief turned into, and why

Two things about the brief resolved themselves immediately:

- **"Dark mode only" was already true.** `custom-v2` has one ramp, declared on `.v2-root`,
  no `prefers-color-scheme` and no light theme anywhere. There was nothing to remove.
- **"Fresher" did not need new visual language.** The design system already states rules
  this screen ignored, and applying them *is* the redesign. That framing is what kept the
  change inside a palette whose every value is measured and test-enforced.

The audit then found the interesting part: the defects were not recents-specific. The card
and row patterns had been copy-pasted rather than shared — **8 independent row
implementations and 5 card implementations** — so bugs had propagated with the copies.

| Defect | Sites | Screens |
|---|---|---|
| `:hover` re-declaring the resting `--si-bg3` — hover moves nothing but the border | 5 | admin, recents ×2, settings, spaces |
| `:active { transform: translateY(1px) }`, banned by `_tokens.scss` ("NO CONTROL EVER MOVES ON PRESS") | 3 | recents ×2, spaces |
| A child painting the same surface as its parent — an invisible panel | 2 | recents |
| A real `<button>` nested inside `<button class="…-row/card">` | 4 | shared, trash, trash-bin, spaces |
| Paths rendered in **sans**, against the rule that Plex Mono is for what a system produced | most list screens | recents, favorites, shared, trash |

The invisible panel is worth a number: `.pinned-card` and `.pinned-card__thumb` both measured
`rgb(39,44,49)`, and the panel was 96×249px — **53% of the card's height** was a surface that
could not be seen.

## 2. What shipped

**Phase 1 — primitives.** `styles/_card.scss` (`.v2-card`, `.v2-card--interactive`,
`.v2-media-well`, and the `.v2-stretch-*` trio), `components/file-row.component.ts`,
`section-head.component.ts`, `timestamp.component.ts`, `utils/{date-buckets,format-timestamp,file-origin}.ts`.

**Phase 2 — recents**, rebuilt on them. Its stylesheet went 411 → ~250 lines.

**Phase 3 — favorites** converted to the row primitive; **shared** and **trash** got the
nested-button fix and the shared timestamp but were NOT converted (see §4).

**Phase 4 — spaces and admin** adopt `.v2-card`; `settings`' dead copy deleted.

### The five levers that made recents "fresher"

Each is a rule the system already states and the screen ignored:

1. **The media well is visible**, carrying the file-type tint plus `--si-media-stripe` —
   whose own docstring says "media placeholders are striped, never coloured blocks" and which
   had one consumer. It renders a real server thumbnail for images. Card: 180px → **157px**.
2. **Paths are mono**, via `.v2-mono-path` — a role documented for exactly this ("space paths
   in search results and favourites") that recents rendered in sans.
3. **Dates are absolute** ("3 Aug"), relative phrasing in the tooltip, in a real `<time>`.
4. **The title takes `.v2-page-title`** (`--si-text-16`), a role documented as "the design's
   one-per-page title" that had **no consumers**.
5. **Origin is shown** (Personal / Space / Shared) from `shareId`/`spaceId`, which were
   already in every payload.

A pattern worth noticing: three of those five are roles or tokens that existed, were
documented, and had zero or one call site. The system was further ahead than the screens were.

## 3. Two designs rejected after rendering them

Both looked right in the abstract and were wrong on screen. Recorded because the reasoning
generalises.

**A coloured origin badge.** `--si-violet` is the tone that actually means Space identity and
"shared with others" — and it is documented **"CAPPED AT ONE INSTANCE PER VIEW"**. Origin is a
property of every row, so sixteen violet badges is not a near-miss, it is the inverse of the
rule. Falling back to a neutral badge keeps the budget but spends an element and a column on
styling rather than information.

**An origin text prefix.** Shipped, rendered, and immediately wrong: almost every file on a
given instance shares one origin, so the column read `Space · …` **sixteen times**. The same
ubiquity problem in words instead of colour — and it pushed the part that actually varies (the
path) to the right, behind a constant.

**What worked** was the glyph the location line already had, which was a hard-coded `folder`
on every row regardless of origin. It now uses the left nav's own marks (Personal `folder`,
Spaces `box`, Shared `share`), so the mark beside a path matches the sidebar entry the file
lives under — no width, no colour, and the words survive as the glyph's accessible name.

**A third thing was left alone deliberately.** The date stays in a right-aligned column even
though a measurement put **758px** between a filename and its date at 1440px. A right-aligned
column of tabular dates is itself scannable; pulling each date against a name of whatever
length makes the column ragged, trading one legibility for a worse one. The lever used was the
container cap (1080px) plus a hover that finally works.

## 4. Where the row primitive does and does not fit

`<app-v2-file-row>` is a **list** row: tile, name, location line, date, plus badge and action
slots. Favorites fit it exactly.

`shared`, `trash` and `trash-bin` are **tables** with sticky headers whose columns must align
with their rows. Forcing the primitive on them would break that alignment and rename their
description/count columns to "path". They got the defect fix, not the conversion. **Do not
"finish the job" by converting them** — the shape is genuinely different.

`screens/files/*` and `screens/people/*` are out of scope permanently: the file-browser row is
the consolidated base directive from #346 (density, selection, drag-and-drop), and `people-row`
lists users, not files.

## 5. Traps, all found by measuring

1. **`.row` collides with Bootstrap.** The row primitive's class was `row`; Bootstrap is loaded
   globally for the classic UI and owns `.row` (`margin-inline: -12px`) and `.row > *`
   (`width: 100%; padding-inline: 12px`). **View encapsulation does not protect against this** —
   it scopes the selectors a component writes, not a global selector that matches an element in
   its template. Result: every row 24px wider than its container (a horizontal scrollbar inside
   the list at 375px) and an *empty* projection slot rendering 24px wide. It is the
   `code { color }` collision from the design-adoption handoff reached through a class name, and
   `tokens.spec.ts` cannot see it because nothing names a colour and no declaration is wrong
   alone. **Namespace anything that could be a utility name** — `row`, `card`, `badge`, `col`,
   `active`, `show`, `container`. Every new class here was swept against the global bundle.
2. **A backtick inside an inline `styles:` block breaks the build, and the error names no file.**
   Hit while writing a comment containing `` `.v2-card` ``. The failure reads
   "Failed to resolve styles at position 0 to a string". Use `/* */` in inline styles.
3. **`input()` needs an injection context, so a spec cannot just `new` the component.** Unlike
   `@Input()`. Use `Injector.create({providers: []})` + `runInInjectionContext`.
4. **dayjs reads an all-digits string as a date string, not epoch millis.** `"1785748925114"`
   formats as **4 Feb 1791** — plausible, silently wrong, and invisible to the declared types.
   A spec caught it. `format-timestamp` coerces digit-only strings and leaves ISO intact.
5. **agent-browser's `mouse move` does not establish `:hover` on the first call after a page
   load.** A card reported `matches(':hover') === false` with the pointer squarely inside it. A
   preceding move to another point fixes it. **Read `matches(':hover')` before concluding a
   hover rule is broken** — this nearly caused a "fix" to working CSS.
6. **Capping a container does not move viewport media queries.** After capping the body to
   1080px, a `@media (max-width: 1100px)` rule still never fired at 1440px, so four cards were
   squeezed into a track width the breakpoints knew nothing about. The grids use
   `repeat(auto-fill, minmax(240px, 1fr))` now and need no breakpoints.
7. **A `<span>` may not contain a `<div>`.** Making a card's content into a button's content
   forced its inner elements to spans, and an inline element ignores flex, width and
   `-webkit-line-clamp` — so `display` had to become explicit in several places.
8. **Moving content into a stretched target breaks `margin-top: auto` chains.** It reintroduced
   #399 (footers at different heights across a row) because the target sized to its content
   instead of filling the card. Caught by measuring footer tops per row.

## 6. Verification

Root `npm run test` (what CI runs): **2433 backend + 653 frontend specs, lint clean, exit 0**.
Build exits 0 with no per-sheet budget error; `v2.scss` is 5.19 kB of its 14 kB ceiling.

Browser-verified with `agent-browser` at 320 / 375 / 414 / 768 / 1440:

- card hover measures **bg3 → bg5** (`rgb(39,44,49)` → `rgb(45,49,55)`) on recents, spaces and
  admin, where all three previously measured the same value at rest and on hover
- `transform: none` on press
- the focus ring lands on the **row/card**, not the stretched button, with the inner button's
  own outline suppressed
- the tertiary re-point resolves `#8a9097` → `#adb4bc` inside a row
- `docs/tools/v2-contrast-audit.js`: **0 fails** on recents at rest, on recents with a card
  hovered (which is where the re-point earns its keep — `#adb4bc on #2d3137` appears and no
  tertiary survives on bg3 or bg5), and on trash
- zero horizontal overflow at every width; filenames never wrap to two lines
- shared and trash: header and row columns measure identical, and hit-testing confirms the
  middle cells fall through to the target while the actions cell stays clickable

### What could NOT be verified on this data, and why

- **Real image thumbnails.** The dev fixture's recents rows reference files that 404 — the DB
  has rows without backing files — so `FileThumb` takes its glyph fallback. Correct behaviour
  for a missing file, but the image path itself is untested here.
- **Date differentiation on recents.** All twenty fixture rows share one *second*
  (`…925114`, `…925092`, `…925066`), so absolute dates render identically there no matter what
  the formatter does. Favorites has genuinely different mtimes and does differentiate
  (3 Aug ×3, 8 Aug) — that is where the change is demonstrable.
- **Trash rows** did not exist ("0 items across 0 bins"); a file was created and deleted through
  the API to populate a bin. One empty `trash-probe.md` remains in the dev trash.

## 7. Left undone, deliberately

- **`trash-bin` still nests a button inside a button.** Its `styleUrl` is
  `../files/file-browser.component.scss`, so its `.file-row` IS the file-browser row. Fixing it
  means editing that stylesheet.
- **No new controls.** Recents remains the only list screen with no filter, sort or density,
  while the file browser has all three. Requested explicitly; a filter was scoped out.
- **Mobile card band.** Four stacked cards occupy ~680px before the list starts at 375px. Not a
  regression (the previous design was slightly worse), but a horizontal card layout on narrow
  widths would compress it.
- **The other five row implementations** (`people-row`, the two `bin-row`/`share-row` variants
  in their own files, `file-card`, `gallery-tile`) are untouched.
