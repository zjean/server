# v2 Cool-Slate Background Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v2's warm near-black surface, line and type ramps with a cool slate at a lifted floor, so the app chrome no longer reads as dark brown or black.

**Architecture:** A pure token change. All 26 values live in one file, `custom-v2/styles/_tokens.scss`, and no component is touched — v2 components are forbidden from naming colours, and `tokens.spec.ts` enforces that. Two references to a value the token file owns (one test assertion, one comment) follow it. The accent, semantic and file-type palettes are held fixed.

**Tech Stack:** SCSS custom properties under a single `.v2-root` scope; Vitest (`environment: node`, no TestBed) for the token specs; `agent-browser` for the rendered check.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-05-v2-background-palette-design.md`. Every task's requirements implicitly include these.

- **No component under `custom-v2/` may name a colour.** Every colour goes through a `--si-*` or `--fc-*` token. Enforced by `styles/tokens.spec.ts`.
- **`--si-focus-ring` stays `#4c7ef3`.** Holding `bg5`/`bg6` near their current lightness is what buys this. It must clear 3:1 on all seven surfaces.
- **`--si-fg-tertiary` is a bg0–band text tier.** It must clear 4.5 on `bg0`, `bg1`, `bg2`, `bg-band` and must stay **below** 4.5 on `bg3`, `bg5`, `bg6`. Widening that licence is a separate decision, not a side effect.
- **`--si-fg` and `--si-fg-muted` must clear 4.5 on all seven surfaces.**
- **`--si-border` stays independent of `--si-line-strong`** and must clear 3:1 on the `bg3` input fill.
- **Lines keep their offset from the surface they are drawn against**, not their absolute lightness. `line-subtle` > `bg3`, `line` > `bg5`, `line-strong` > `bg6`, by luminance.
- **`--si-amber` is not an accent alias** (`#c9932f`), and the accent, semantic, file-type and avatar *tone* palettes do not change.
- Hue is OKLab **255°** throughout — surfaces, lines and type.
- Every contrast figure written into `_tokens.scss` must be the computed value, to 2dp, and a grid cell is bracketed **if and only if** it is below 4.5.

**The net is already in place.** `styles/palette-contrast.spec.ts` (committed in `271be1a2`) asserts all of the above as *rules* and is green on the current palette. It is how each task below is verified. Its grid test couples the header's table to the token values, so **the header grid must be updated in the same task as the ramp** or the suite goes red.

**Test commands.** Fast loop for one file:

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts
```

Before pushing, run what CI runs — `npm run test` at the **root**. `npm -w frontend test` skips lint, and `ng lint` treats prettier violations as errors.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `custom-v2/styles/_tokens.scss` | the only place a v2 colour is named | 26 values + header documentation |
| `custom-v2/styles/palette-contrast.spec.ts` | the palette's rules | one assertion added (Task 2) |
| `custom-v2/styles/tokens.spec.ts` | the palette's deliberate decisions, as values | one assertion's value (Task 1) |
| `custom-v2/components/input.component.ts` | the input control | one comment (Task 1) |
| `docs/plans/2026-08-04-v2-design-adoption-handoff.md` | entry point for `custom-v2` work | a pointer (Task 3) |
| `docs/plans/2026-08-03-v2-design-system-adoption-plan.md` | the authority on design | a pointer (Task 3) |

---

### Task 1: The ramp — surfaces, lines, border, text, and the header grid

The atomic change. Surfaces, lines and type must move together: a lifted ramp with unlifted lines inverts them, and the header grid test fails the moment values move without the documentation.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/styles/_tokens.scss` (surfaces ~169-175, lines ~187-193, text ~202-205, header grid ~68-72)
- Modify: `frontend/src/app/applications/custom-v2/styles/tokens.spec.ts:183-186`
- Modify: `frontend/src/app/applications/custom-v2/components/input.component.ts:15`
- Test: `frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts` (exists, unchanged)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the 15 token values below. Task 2 reads `--si-line-strong` (`#454950`) and `--si-fg-muted` (`#adb4bc`) to derive the neutral pair, and `--si-bg0` (`#181c21`) to state what the avatar inks are no longer tracking.

- [ ] **Step 1: Update the two value assertions that pin the old palette**

In `tokens.spec.ts`, replace the `--si-border` test (currently lines 183-186) with:

```typescript
  it('keeps --si-border independent of --si-line-strong, which measures 1.56 on the input fill', () => {
    expect(tokens).toMatch(/--si-border:\s*#8a9097;/i)
    expect(tokens).not.toMatch(/--si-border:\s*var\(--si-line-strong\)/)
  })
```

- [ ] **Step 2: Run both specs to verify the new assertion fails**

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/
```

Expected: `tokens.spec.ts` FAILS on `keeps --si-border independent of --si-line-strong` — the file still says `#8a857d`. `palette-contrast.spec.ts` still passes 18/18, because the old palette satisfies the rules.

- [ ] **Step 3: Swap the seven surfaces**

Replace the seven surface declarations, keeping every comment on them:

```scss
  --si-bg0: #181c21; // surface-0   · app canvas, sidebar, page gutters
  --si-bg1: #1d2126; // surface-0.5 · top bar, right panel, empty-state panel
  --si-bg2: #20242a; // surface-1   · content plane: file table, detail body
  --si-bg-band: #23272d; // surface-1.5 · the alternating table band (see below)
  --si-bg3: #272c31; // surface-2   · cards, row hover, input fill, chips, code
  --si-bg5: #2d3137; // surface-3   · dialogs, context menus, sheets, popovers
  --si-bg6: #34383e; // surface-4   · tooltips, pressed, drag-over, segmented-on
```

- [ ] **Step 4: Swap the lines and the border**

```scss
  --si-line-subtle: #303235; // table + section rules; the default and commonest
  --si-line: #35383c; // card outlines, menu separators
  --si-line-strong: #454950; // hovered input outline, dashed drop targets, frames

  // NOT an alias of line-strong — see deviation 2 in the header. This is the
  // resting boundary of anything interactive whose fill cannot identify it.
  --si-border: #8a9097;
```

Each line's lightness is its anchor surface plus a fixed offset — `line-subtle` = `bg3` + 0.025 L, `line` = `bg5` + 0.029 L, `line-strong` = `bg6` + 0.065 L. Add this note above the line block:

```scss
  // These are positioned RELATIVE to the ramp: each holds a fixed lightness offset
  // above the surface it is drawn against (subtle→bg3 +0.025 L, line→bg5 +0.029,
  // strong→bg6 +0.065). Held at an absolute value instead, a ramp change inverts
  // them — the same declaration that lifts off a card starts denting into it, which
  // fails no build and is invisible in a screenshot at these step sizes.
  // `palette-contrast.spec.ts` asserts each one is lighter than its anchor.
```

- [ ] **Step 5: Swap the four text tones**

```scss
  --si-fg: #f0f3f6; // primary   · file names, titles, values
  --si-fg-muted: #adb4bc; // secondary · body copy, nav labels, descriptions
  --si-fg-tertiary: #8a9097; // tertiary  · metadata, sizes, timestamps (bg0–band)
  --si-fg-ghost: #5b5f65; // quiet     · disabled labels, column heads. Decorative.
```

`--si-fg-tertiary` is lifted relative to a straight hue rotation (OKLab L 0.619 → 0.650). Add above it:

```scss
  // Lifted 0.031 L above a straight rotation, and deliberately no further. At the
  // ground's own lightness it cleared `band` by 0.04 — a rounding-level margin on
  // the one tier whose licence a 50-call-site sweep settled. This gives band 4.66.
  // One further step would take bg3 to 4.54: safe in itself, but it would widen the
  // rule from bg0–band to bg0–bg3 and silently re-permit the call sites the sweep
  // moved to muted. `palette-contrast.spec.ts` asserts BOTH directions.
```

- [ ] **Step 6: Replace the header's contrast grid**

The grid at ~lines 68-72 becomes exactly:

```scss
//                bg0    bg1    bg2   band    bg3    bg5    bg6
//   fg        15.37  14.53  14.00  13.47  12.65  11.74  10.59
//   muted      8.18   7.73   7.45   7.17   6.73   6.25   5.63
//   tertiary   5.31   5.02   4.84   4.66  [4.37] [4.06] [3.66]
//   quiet     [2.66] [2.52] [2.43] [2.34] [2.19] [2.04] [1.84]
```

The prose under the grid says tertiary is a "bg0–BAND tier, NOT bg0–bg3" and explains that bg3 is the last band before it fails. That stays true and needs no edit.

- [ ] **Step 7: Update the comment in `input.component.ts`**

Line 15 names the old value. Change `--si-border (#8A857D,` to `--si-border (#8A9097,`. Check the surrounding sentence for a stale ratio and correct it to **1.56** if it quotes `line-strong` on the fill.

- [ ] **Step 8: Run both specs — everything green**

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/
```

Expected: PASS. `palette-contrast.spec.ts` 18/18 and `tokens.spec.ts` all green. If the grid test fails, the header numbers disagree with the values — trust the test and recompute, do not adjust the test. If a "must be lighter than" test fails, a line was missed in Step 4.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/applications/custom-v2/styles/_tokens.scss \
        frontend/src/app/applications/custom-v2/styles/tokens.spec.ts \
        frontend/src/app/applications/custom-v2/components/input.component.ts
git commit -m "$(cat <<'MSG'
feat(custom-v2): cool the surface, line and type ramps and lift the floor

The seven surfaces move to a cool slate (OKLab hue 255°) and the bottom five lift
off near-black. The type ramp moves with them, which is the part that actually
removes the brown: the surfaces were already near-neutral at 0.003-0.008 chroma,
while --si-fg-muted and --si-fg-tertiary were two to four times more chromatic and
--si-fg was a cream rather than a white.

bg5 and bg6 are held near their current lightness so --si-focus-ring does not have
to move; it measures 4.55 down to 3.14 across the seven, still clearing SC 1.4.11.

Lines keep their OFFSET from the surface they are drawn against rather than their
absolute lightness. Held still, a lifted ramp inverts them and a card outline that
lifts today starts denting.

--si-fg-tertiary lifts 0.031 L and deliberately no further, so it still clears 4.5
on bg0-band and still fails on bg3 — the licence the 50-call-site sweep settled
stays true verbatim.
MSG
)"
```

---

### Task 2: The dependent tones — scrim, veil, neutral, chrome, avatar inks

Seven more declarations that were derived from the old ramp. Each is separable from the ramp itself: a reviewer could accept Task 1 and reject any of these.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/styles/_tokens.scss` (chrome ~243-244, neutral ~293-295, avatar inks ~312-323, scrim ~329, veil ~348)
- Test: `frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts`

**Interfaces:**
- Consumes: `--si-line-strong` = `#454950` and `--si-fg-muted` = `#adb4bc` from Task 1; `--si-bg0` = `#181c21`.
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing test for the avatar inks**

The five dark avatar inks currently equal the old `bg0`. Nothing asserts they are dark enough to be inks, which is exactly how re-pointing them at the new `bg0` would slip through. Append to `palette-contrast.spec.ts`:

```typescript
describe('palette — avatar inks, which are NOT the canvas', () => {
  // The five dark inks equalled --si-bg0 before the ramp lifted, which was
  // incidental rather than meaningful: bg0 is a surface and these are type. Once bg0
  // rises they must stop tracking it, and this is what makes that visible — pointing
  // them back at bg0 drops the worst pair from 6.28 to 5.60 without failing anything
  // else in the suite.
  const DARK_INK_TONES = ['avatar-2', 'avatar-3', 'avatar-4', 'avatar-5', 'avatar-6'] as const

  for (const tone of DARK_INK_TONES) {
    it(`keeps --si-${tone}-fg readable on --si-${tone}`, () => {
      expect(contrast(token(`${tone}-fg`), token(tone)), `--si-${tone}-fg on --si-${tone}`).toBeGreaterThanOrEqual(AA_TEXT)
    })
  }

  it('keeps the dark avatar ink darker than the app canvas, so it cannot silently become a surface alias', () => {
    expect(luminance(token('avatar-2-fg')), 'the dark avatar ink must not track --si-bg0').toBeLessThan(luminance(token('bg0')))
  })

  it('keeps white on the one avatar tone dark enough for it', () => {
    expect(contrast(token('avatar-1-fg'), token('avatar-1'))).toBeGreaterThanOrEqual(AA_TEXT)
  })
})
```

- [ ] **Step 2: Run it — and expect it to PASS**

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts
```

Expected: **PASS.** This is a characterization test, not a failing one, and it is worth being clear about why rather than pretending otherwise: after Task 1 the inks are still `#100f0e`, which is genuinely darker than the new `bg0` (`#181c21`) and still measures 6.26–8.76 on its tones. Every new assertion holds *before* Step 3.

What Step 3 buys is durability, not a fix. So prove the test can fail before trusting it — temporarily set one ink to the new canvas value, which is the exact mistake the assertion exists to catch:

```bash
# in _tokens.scss, temporarily:  --si-avatar-2-fg: #181c21;
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts
# Expected: FAIL on 'keeps the dark avatar ink darker than the app canvas'
git checkout -- frontend/src/app/applications/custom-v2/styles/_tokens.scss
```

The `checkout` is safe here and only discards the perturbation: Task 1 is already committed, and this step runs before any Task 2 edit to `_tokens.scss`. Do not leave the perturbation in.

- [ ] **Step 3: Decouple the avatar inks**

Replace the five dark ink values, and add the note that stops them being re-coupled:

```scss
  // The five dark inks are NOT --si-bg0. They held bg0's value while bg0 was a
  // near-black, which was incidental — a surface and a type tone that happened to
  // coincide. bg0 is now L 0.225 and no longer dark enough to be an ink: pointing
  // these back at it drops tones 2–6 to 5.60–7.83. Their own value holds
  // 7.63 · 8.78 · 6.28 · 7.13 · 7.01.
  --si-avatar-1: #3a66e0; // cobalt
  --si-avatar-1-fg: #ffffff;
  --si-avatar-2: #7fae8e; // green
  --si-avatar-2-fg: #0c0f14;
  --si-avatar-3: #b3a6ee; // periwinkle
  --si-avatar-3-fg: #0c0f14;
  --si-avatar-4: #c08578; // clay
  --si-avatar-4-fg: #0c0f14;
  --si-avatar-5: #b79a5f; // ochre
  --si-avatar-5-fg: #0c0f14;
  --si-avatar-6: #b192b8; // mauve
  --si-avatar-6-fg: #0c0f14;
```

- [ ] **Step 4: Cool the scrim and the veil — hue only, never lightness**

```scss
  --si-scrim: rgba(7, 11, 15, 0.6);
```

and

```scss
  --si-media-veil: rgba(7, 11, 15, 0.45);
```

Add to the scrim's comment block:

```scss
  // Cooled to the ramp's hue at its EXISTING lightness. rgba(11,10,9) is OKLab
  // L=0.146; deriving the cooled value from a round number instead of from that
  // measurement yields rgba(2,3,6) — a near-pure black, i.e. a lightness change
  // nobody asked for.
```

- [ ] **Step 5: Re-point the neutral pair and the chrome tokens**

```scss
  --si-neutral: #454950; // Neutral · counts, offline, "no change". Default badge.
  --si-neutral-ink: #adb4bc;
```

and

```scss
  --si-chrome-bg: #181c21;
  --si-chrome-bg-dark: #181c21;
```

`--si-neutral` tracks `line-strong` and `--si-neutral-ink` tracks `fg-muted`, as they did before. `--si-neutral-soft` is an alpha and does not change.

- [ ] **Step 6: Run the full styles suite**

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/
```

Expected: PASS, now including the new avatar block. The `--si-neutral-soft` wash composited on `bg6` should still clear 4.5 against `--si-neutral-ink` — Task 3 records the figure (4.67); if a future change breaks it, the soft-ink line in the header is the place it is documented.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/styles/_tokens.scss \
        frontend/src/app/applications/custom-v2/styles/palette-contrast.spec.ts
git commit -m "$(cat <<'MSG'
feat(custom-v2): re-point the tones derived from the old ramp

Five dark avatar inks, the scrim, the media veil, the neutral pair and the two
chrome tokens all held values derived from the warm near-black ramp.

The avatar inks stop tracking --si-bg0. They held its value while bg0 was a
near-black, which was incidental — a surface and a type tone that coincided. bg0 is
now L 0.225 and no longer dark enough to be an ink; pointing them back at it would
drop tones 2-6 to 5.60-7.83, so they take their own #0c0f14 and hold 6.28-8.78. A
test now asserts the ink is darker than the canvas, because that coupling is the
kind that silently returns.

The scrim changes hue only, never lightness: rgba(11,10,9) is OKLab L=0.146, and
deriving the cooled value from a round number instead lands on rgba(2,3,6) — a
near-pure black nobody asked for.
MSG
)"
```

---

### Task 3: The header's prose — the deviations, the soft-fill inks, and the doc pointers

Documentation only, and separable: it changes no rendered pixel. The spec's §6 file table omitted the two design documents; they are included here because `CLAUDE.md` makes the handoff the entry point for `custom-v2` work and both record the old ramp.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/styles/_tokens.scss` (header, ~lines 1-156)
- Modify: `docs/plans/2026-08-04-v2-design-adoption-handoff.md`
- Modify: `docs/plans/2026-08-03-v2-design-system-adoption-plan.md`

**Interfaces:**
- Consumes: every value from Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Update deviation 1's measured figures**

The header states the focus ring's seven measurements and the composited alpha version. Replace them with:

- opaque accent-500: `4.55 · 4.30 · 4.15 · 3.99 · 3.75 · 3.48 · 3.14`
- the design's `rgba(76,126,243,0.6)` composited over `bg2`: **2.35** — still failing 3:1 on every surface.

- [ ] **Step 2: Update deviation 2's measured figures**

- `--si-line-strong` on the `bg3` input fill: **1.56** (was 1.69) — the argument is *stronger*, not weaker.
- the fill alone: **1.11** against the content plane, **1.08** inside a dialog (bg3 on bg5 —
  a prior draft of this step paired bg3 against bg1 instead and got 1.15; the corrected
  1.08 is *less* identifying, so the argument is stronger still).
- `--si-border` `#8a9097` across the seven: `5.31 · 5.02 · 4.84 · 4.66 · 4.37 · 4.06 · 3.66`.

Deviation 3 (`--si-amber`) is untouched by this change. Leave its text alone.

- [ ] **Step 3: Update the ink-on-soft-fill line**

```
// Ink on its own soft fill (the fill composited over each bed first), worst bed
// being bg6: accent 4.80 · success 5.22 · warning 5.34 · danger 4.65 ·
// info 5.55 · neutral 4.67 · secondary 4.56. All clear 4.5.
```

These are tighter than the previous 4.72–5.82 because the bed lightened. The fill inks below them are unchanged, because the fills are: white on accent-600 5.05, accent-700 7.28, danger 4.83, and white on accent-500 still 3.76.

- [ ] **Step 4: Rewrite the header's opening premise**

The header opens by describing "a warm neutral base". Replace that framing, and record the finding that motivated the change — that the surfaces were never the warm part:

```scss
// Sync-In v2 design tokens — cool slate + cobalt.
//
// ─── The ramp is cool as of 2026-08-05 ───────────────────────────────────
// The chrome read as dark brown and near-black. Measuring it first showed the
// premise was false about the BACKGROUND: all seven surfaces sat at 0.003–0.008
// OKLab chroma, i.e. effectively neutral. The warmth was in the TYPE and LINE
// tokens, two to four times more chromatic, and --si-fg was a cream rather than a
// white. Rotating only the seven `bg` tokens would have been a nearly invisible
// change. If you are ever asked to recolour the ground again: the type ramp moves
// with it, or nothing moves.
//
// The floor also lifted (bg0 L 0.169 → 0.225) while bg5/bg6 were held, because the
// top of the ramp has ~0.02 of lightness headroom: the focus ring clears 3:1 only
// up to a surface at L≈0.348. Lightening the overlay surfaces breaks the ring and
// every tertiary glyph on menus, dialogs and tooltips, and no build notices.
// Design: docs/superpowers/specs/2026-08-05-v2-background-palette-design.md
```

Keep the "Plain hex, on purpose" section — it is still true and `palette-contrast.spec.ts` depends on it.

- [ ] **Step 5: Add a pointer to the two design documents**

Neither document is rewritten — both are dated records. Add a note near the top of each, so a reader does not take their ramp values as current:

> **The surface ramp changed on 2026-08-05.** The warm neutral values recorded here are
> superseded by the cool slate in `_tokens.scss`; the reasoning is in
> `docs/superpowers/specs/2026-08-05-v2-background-palette-design.md`. Everything else
> in this document still stands — in particular the focus-ring, `--si-border` and
> `--si-amber` deviations, all three re-verified against the new ramp.

- [ ] **Step 6: Verify nothing regressed and no raw colour crept in**

```bash
npx vitest run --config frontend/vitest.config.mts frontend/src/app/applications/custom-v2/styles/
```

Expected: PASS. `tokens.spec.ts`'s comment-stripping handles `//`, `/* */` and `<!-- -->`, so hex values written inside the header comments are correctly ignored — but the grid test does read them, so a mistyped grid number fails here.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/styles/_tokens.scss \
        docs/plans/2026-08-04-v2-design-adoption-handoff.md \
        docs/plans/2026-08-03-v2-design-system-adoption-plan.md
git commit -m "$(cat <<'MSG'
docs(custom-v2): bring the token header and the design docs to the cool ramp

Recomputes the two measured lists the header states — deviation 1's seven focus-ring
figures and deviation 2's input-boundary figures — plus the ink-on-soft-fill line,
whose numbers moved because the bed lightened even though no semantic value changed.

All three documented deviations survive the new ramp, and the second is stronger:
--si-line-strong on the input fill now measures 1.56 rather than 1.69, so --si-border
has more reason to stay independent, not less.

Rewrites the header's opening premise to record the finding that motivated the
change, because it is the thing a future recolour would otherwise rediscover the
hard way: the surfaces were never the warm part.

The two design documents keep their warm values as dated records and gain a pointer,
rather than being rewritten.
MSG
)"
```

---

### Task 4: Verify in the browser, by measurement

The suite proves the palette's arithmetic. It cannot prove the app renders it, that no surface was missed, or that a component mounting on two surfaces landed legally on both.

**Files:**
- No source changes expected. If the audit finds a failure, fix it and note it here.

**Interfaces:**
- Consumes: the whole palette.
- Produces: nothing.

- [ ] **Step 1: Run what CI runs**

```bash
npm run test
```

Expected: PASS. This is the gate — `npm -w frontend test` skips lint, and `ng lint` treats prettier violations as errors. A failure in `cache.e2e-spec.ts`'s TTL case is a known flake; re-run before investigating a frontend-only diff.

- [ ] **Step 2: Build and serve**

```bash
npm -w frontend run build
npm run dev:db && npm run dev:migrate   # only if the DB is not already up
npm -w backend run start:dev
```

The backend serves the built frontend on `:8080` — a single origin, no proxy, no `ng serve`. Log in as `sync-in` / `password`.

- [ ] **Step 3: Reach the v2 layout**

```bash
agent-browser --session palette open "http://localhost:8080/" --viewport 1440x900
# log in, then:
agent-browser --session palette eval "localStorage.setItem('ui.version','v2'); 'ok'"
agent-browser --session palette open "http://localhost:8080/index.html?v=1#/v2/files/personal"
```

Always pass `--session`; the default session is shared and persists cookies. A same-URL `open` after a rebuild is a no-op, hence the `?v=` cache-bust. Set the viewport **before** first load or the app's breakpoint state stays stale.

- [ ] **Step 4: Verify by computed style, not by eye**

This change is made almost entirely of 0.02 lightness steps, which are **not reliably visible in a screenshot**. Read the rendered values:

```bash
agent-browser --session palette eval "
const lum=(s)=>{const[r,g,b]=s.match(/\d+/g).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4});return 0.2126*r+0.7152*g+0.0722*b};
const bg=(sel)=>getComputedStyle(document.querySelector(sel)).backgroundColor;
JSON.stringify({canvas:bg('.layout-v2__body'), nav:bg('.left-nav'), topbar:bg('.topbar')})"
```

Expected: `canvas` = `rgb(24, 28, 33)`, and the nav one step lighter. Any `rgb` whose channels are equal or descending left-to-right is a surface that did not get the cool hue.

- [ ] **Step 5: Run the contrast audit, per state**

```bash
node docs/tools/v2-contrast-audit.js
```

Run it **per state, not per route** — rest, row hover, dialog open, and the mobile bottom sheet each change the answer, and a route that silently redirects audits the wrong screen. Read the emitted fg-on-bg pairs **even on a clean run**: a clean run is what hides a tone surviving where it should not.

- [ ] **Step 6: Check the two things the line change predicts**

A card outline on `bg3` and a menu separator on `bg5` must read as *lifting*, not denting:

```bash
agent-browser --session palette eval "
const lum=(s)=>{const[r,g,b]=s.match(/\d+/g).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4});return 0.2126*r+0.7152*g+0.0722*b};
const s=getComputedStyle(document.querySelector('.file-card'));
JSON.stringify({lifts: lum(s.borderTopColor)>lum(s.backgroundColor), bg:s.backgroundColor, border:s.borderTopColor})"
```

`.file-card` is the grid card (`screens/files/file-browser-grid.scss:19`), so switch the browser to grid view first. Expected: `lifts: true`. Repeat with a context menu open for its separator.

- [ ] **Step 7: Capture screenshots for the PR**

UI-facing PRs need agent-browser screenshots committed under `docs/screenshots/` and embedded in the PR body via a raw URL pinned to the head commit SHA. Capture the files list, a dialog, a context menu and the mobile layout. Pass an **absolute** path to `screenshot` — a relative path resolves against a working directory the tool resets.

If `captureScreenshot` starts failing partway through, restart the browser rather than retrying: a long-driven session wedges permanently, while a fresh one takes dozens of shots fine.

- [ ] **Step 8: Commit the screenshots and open the PR**

```bash
git add docs/screenshots/
git commit -m "docs(custom-v2): screenshots of the cool-slate ramp"
git push -u origin feat/v2-cool-slate-palette
gh pr create --repo zjean/server --base develop --head feat/v2-cool-slate-palette \
  --title "feat(custom-v2): cool slate background ramp" --body-file docs/superpowers/plans/pr-body.md
```

Write `pr-body.md` first, following `.github/PULL_REQUEST_TEMPLATE.md`. It must cover:

- **What and why** — the surfaces were already near-neutral (0.003–0.008 chroma); the brown was in the type and line tokens. Link the spec.
- **The headroom constraint** — why `bg5`/`bg6` were held and the focus ring did not move.
- **Screenshots** — raw URLs pinned to the head commit SHA, per the template. Before/after for the files list, a dialog and a context menu.
- **How it was verified** — `palette-contrast.spec.ts`'s rule assertions, the per-state contrast audit, and the computed-style checks from Steps 4 and 6, stating that a 0.02 lightness step is not visible in a screenshot and was therefore measured.

Delete `pr-body.md` after the PR is created, or write it outside the repo. Base `develop`, always `--repo zjean/server`, squash-merge. The branch must be up to date with `develop` before merge and `test` must be green.

---

## Verification Summary

| Claim | How it is verified |
|---|---|
| every text tier is legal on every surface it is used on | `palette-contrast.spec.ts`, both directions for tertiary |
| the focus ring still clears 3:1 everywhere | `palette-contrast.spec.ts` |
| lines lift rather than dent | `palette-contrast.spec.ts` + Task 4 Step 6 in the browser |
| the header's grid tells the truth | `palette-contrast.spec.ts`, numbers **and** brackets |
| the three deviations survive | `tokens.spec.ts` (values) + `palette-contrast.spec.ts` (reasons) |
| no component names a colour | `tokens.spec.ts` |
| the app actually renders the ramp | Task 4, by computed style |
| no tone survives on a surface it is illegal on | `docs/tools/v2-contrast-audit.js`, per state |
