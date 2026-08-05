# v2 background palette — cool slate, lifted floor

**Date:** 2026-08-05
**Status:** design approved, not yet implemented
**Scope:** `frontend/src/app/applications/custom-v2/styles/_tokens.scss` and two references to a value it owns

The v2 app chrome reads as dark brown and near-black. This replaces the surface, line and
type ramps with a cool slate at a lifted floor. It changes **26 token values and no
component**; the accent, semantic and file-type palettes are untouched.

Every figure in this document was computed from the hex values as written, by WCAG 2.x
relative luminance, and can be recomputed from them. The generator is in the session
scratchpad; if a number here disagrees with `_tokens.scss`, recompute rather than
reconciling by hand.

---

## 1. Why the surfaces were not the problem

The premise the request started from — "the background is dark brown" — is measurably
false about the *background*, and this is the single most useful thing this exercise
found. In OKLab, the seven shipping surfaces measure **0.003–0.008 chroma**: effectively
achromatic. Their `R−B` spread is 2–7 of 255.

The warmth lives in the **type and line** tokens, which are two to four times more
chromatic:

| token | value | chroma | hue |
|---|---|---|---|
| `--si-fg` | `#f5f2ee` | 0.006 | 75° — a cream, not a white |
| `--si-fg-muted` | `#b8b2a9` | **0.014** | 78° |
| `--si-fg-tertiary` / `--si-border` | `#8a857d` | **0.013** | 80° |
| `--si-line-strong` | `#4a453f` | 0.012 | 72° |
| `--si-bg6` (the warmest surface) | `#383431` | 0.008 | 59° |

**Consequence, and the reason this is written down:** rotating only the seven `bg` tokens
is a nearly invisible change that leaves the complaint intact. Anyone revisiting this must
move the type ramp with the ground or not at all.

The "near-black" half of the complaint is the substantive one: `bg0` sits at OKLab
L=0.169 and the content plane at L=0.214.

## 2. The constraint that shaped the choice

**The top of the ramp has 0.02 of lightness headroom.** The focus ring `#4c7ef3` clears
SC 1.4.11's 3:1 only up to a surface at L=0.348, and `bg6` is L=0.328 today, measuring
3.28. A tertiary glyph clears to L=0.356 (`bg6` = 3.36).

So lightening `bg5`/`bg6` breaks the focus ring and every chevron, toggle knob and icon on
menus, dialogs and tooltips — **silently, with no build failure**. This is the defect class
the design-adoption handoff records twice.

Three candidates were rendered as the real chrome and measured (`docs/v2-background-options.html`):

| | canvas | ring on bg6 | forced retunes |
|---|---|---|---|
| cool, same darkness | `#0c1014` | 3.28 | none |
| **cool + lift the floor** ← chosen | `#181c21` | 3.14 | tertiary |
| cool + lift everything | `#1d2228` | 4.05 | ring → accent-400, plus muted and tertiary |

Lifting everything was rejected: it forces the ring to `#8fadfa`, which is *lighter than
the accent-600 button fill it surrounds*, and drops `muted` to 4.26 on `bg6` — breaking the
stated rule that `muted` is usable on every surface.

**Chosen: lift the five surfaces that carry almost every pixel, hold `bg5`/`bg6` so the
ring never moves.** Hue 255°, the cobalt family, so the accent reads as native to the
ground.

## 3. The palette

```scss
// Surfaces — cool slate, OKLab hue 255°
--si-bg0: #181c21;      // was #100f0e
--si-bg1: #1d2126;      // was #161513
--si-bg2: #20242a;      // was #1a1917
--si-bg-band: #23272d;  // was #1e1c1a
--si-bg3: #272c31;      // was #232120
--si-bg5: #2d3137;      // was #2d2a28
--si-bg6: #34383e;      // was #383431

// Lines — lifted WITH the surfaces, see §4.1
--si-line-subtle: #303235;  // was #2a2725
--si-line: #35383c;         // was #35312e
--si-line-strong: #454950;  // was #4a453f
--si-border: #8a9097;       // was #8a857d — the tertiary tone, per deviation 2

// Text
--si-fg: #f0f3f6;           // was #f5f2ee
--si-fg-muted: #adb4bc;     // was #b8b2a9
--si-fg-tertiary: #8a9097;  // was #8a857d — lifted, see §4.2
--si-fg-ghost: #5b5f65;     // was #635e58

--si-focus-ring: #4c7ef3;   // UNCHANGED. Holding bg5/bg6 is what buys this.

--si-scrim: rgba(7, 11, 15, 0.6);       // was rgba(11, 10, 9, 0.6)
--si-media-veil: rgba(7, 11, 15, 0.45); // was rgba(11, 10, 9, 0.45)

--si-neutral: #454950;      // was #4a453f — tracks line-strong
--si-neutral-ink: #adb4bc;  // was #b8b2a9 — tracks muted

--si-chrome-bg: #181c21;      // was #100f0e
--si-chrome-bg-dark: #181c21; // was #100f0e

// The five dark avatar inks — DECOUPLED from bg0, see §4.3
--si-avatar-2-fg: #0c0f14;  // and -3-fg, -4-fg, -5-fg, -6-fg. Was #100f0e.
                            // --si-avatar-1-fg stays #ffffff (cobalt is the one
                            // tone dark enough for white); the six avatar TONES
                            // themselves are unchanged.
```

Lightness ladder `0.225 → 0.245 → 0.260 → 0.272 → 0.290 → 0.312 → 0.340`, steps
`0.020 · 0.015 · 0.012 · 0.018 · 0.022 · 0.028` (today `0.027 · 0.018 · 0.014 · 0.022 ·
0.037 · 0.041`).

**Accepted cost:** the ladder compresses at the top. `bg5` on `bg2` measures 1.19 and `bg6`
on `bg5` 1.11, so dialogs and context menus lean more on `--si-shadow2`/`3` and less on
value than they do today. This was visible in the rendered comparison and accepted.

### Measured contrast, text tier × surface

```
                bg0    bg1    bg2   band    bg3    bg5    bg6
  fg          15.37  14.53  14.00  13.47  12.65  11.74  10.59
  muted        8.18   7.73   7.45   7.17   6.73   6.25   5.63
  tertiary     5.31   5.02   4.84   4.66  [4.37] [4.06] [3.66]
  quiet       [2.66] [2.52] [2.43] [2.34] [2.19] [2.04] [1.84]
  focus ring   4.55   4.30   4.15   3.99   3.75   3.48   3.14
```

`[n]` = below 4.5:1, not usable for normal-size text. The rules the shipped system states
all survive: `fg` and `muted` usable everywhere; **`tertiary` remains a bg0–band tier**;
`quiet` clears nothing and stays decorative. Tertiary as a *glyph* clears 3:1 on all seven
(3.66 worst), so the glyph and disabled-control exemptions are unaffected.

Ink on its own soft fill, worst bed `bg6`: accent 4.80 · success 5.22 · warning 5.34 ·
danger 4.65 · info 5.55 · neutral 4.67 · secondary 4.56. All clear 4.5, tighter than
today's 4.72–5.82 because the bed lightened.

Fill inks are unchanged because the fills are: white on accent-600 5.05, accent-700 7.28,
danger 4.83; white on accent-500 still 3.76, which is still why accent-500 never carries
white body text.

## 4. The four decisions that are not obvious

### 4.1 The line ramp must move WITH the surfaces, keeping its offset

Cooling the three line tokens while leaving their lightness alone **inverts** them:

| | today | if lines hold still | corrected |
|---|---|---|---|
| `line-subtle` vs `bg3` | +0.025 L — a rule lifts off a card | −0.015 L — the same rule **dents** | `#303235`, +0.025 |
| `line` vs `bg5` | +0.029 L | +0.004 L — effectively invisible | `#35383c`, +0.029 |
| `line-strong` vs `bg6` | +0.065 L | +0.053 L | `#454950`, +0.065 |

So each line keeps its **offset from the surface it is drawn against**, not its absolute
value. This is the same fact as the handoff's "a surface move also has to re-point its
hover", seen from the other end: `bg3` is darker than `bg5`, so a value that lifts on one
dents on the other, and card outlines and table rules are subject to it exactly as hovers
are.

### 4.2 `--si-fg-tertiary` lifts to L=0.650, and deliberately not further

At the ground's own lightness the tertiary tone cleared `band` by 0.04 — a rounding-level
margin on the one tier whose licence a 50-call-site sweep just settled. `#8a9097` (L=0.650)
gives `band` **4.66**.

`bg3` measures **4.37** and still fails, which is the point. One further step would take
`bg3` to 4.54 — safe in itself, but it would silently widen the rule from "bg0–band" to
"bg0–bg3" and falsify the token header's note about `bg3` being the last band before
tertiary fails. **Preserving the shipped rule verbatim is worth more than the extra
margin.**

### 4.3 The avatar dark inks stop tracking `bg0`

They are `#100f0e` today, which is *incidentally* `bg0`'s value — the coupling is not
meaningful, and `bg0` is no longer dark enough to be an ink. Re-pointing them to the new
`bg0` would drop tones 2–6 to 5.60–7.83. Their own cooled near-black `#0c0f14` holds
**7.63 · 8.78 · 6.28 · 7.13 · 7.01**, preserving today's measured range. White on
avatar-1 cobalt stays 5.05.

### 4.4 `--si-scrim` changes hue only, never lightness

`rgba(11, 10, 9)` is OKLab L=0.146. Deriving the cooled scrim from a round number instead
of from that measurement yields `rgba(2, 3, 6)` — a near-pure black, i.e. a lightness change
nobody asked for. The correct value is `rgba(7, 11, 15)`, the same L cooled. `--si-media-veil`
follows at its own 0.45 alpha.

## 5. The three documented deviations, re-verified

None is weakened; the second is strengthened.

1. **Focus ring stays opaque accent-500.** The design's `rgba(76,126,243,0.6)` composited
   over the new `bg2` measures **2.35** — still failing 3:1. Opaque measures 4.55 → 3.14
   across the seven.
2. **`--si-border` stays independent of `--si-line-strong`.** `line-strong` on the input
   fill now measures **1.56** (was 1.69), so the argument is stronger. The fill alone is
   1.11 on the content plane and 1.15 in a dialog — still identifying nothing. `--si-border`
   `#8a9097` measures 4.37 on the fill and 4.06 in a dialog.
3. **`--si-amber` stays a real warning colour.** Untouched by this change; restated only so
   a future reader does not assume a palette change revisited it.

## 6. Files

| File | Change |
|---|---|
| `custom-v2/styles/_tokens.scss` | 26 values; header contrast grid, the three deviations' measured lists, and the ink-on-soft-fill line all recomputed |
| `custom-v2/styles/tokens.spec.ts:184` | pins `--si-border: #8a857d` literally → `#8a9097` |
| `custom-v2/components/input.component.ts:15` | a comment naming `#8A857D` |
| `docs/v2-background-options.html` | refresh with the corrected line ramp and tertiary, so the shared reference agrees with the build |

A grep of every warm value across `frontend/src` and `backend/src` found **nothing else**:
no manifest, no `theme-color`, no `index.html` background, no classic-UI collision. The two
`EXEMPT` files in `tokens.spec.ts` — a PDF canvas and a print diagram — are deliberately
outside the theme and stay untouched.

## 7. Verification

1. `npm run test` at the root — what CI runs. `tokens.spec.ts` is the gate that fails first
   if a raw colour or a fill-as-type slipped in.
2. `docs/tools/v2-contrast-audit.js` against the rendered tree, **per state**: rest, row
   hover, dialog open, mobile bottom sheet. Read the emitted fg-on-bg pairs *even on a clean
   run* — a clean run is what hides a tone surviving where it should not. Run per state, not
   per route; a route that silently redirects audits the wrong screen.
3. Browser-verify the chrome per the `v2-dev-loop-verify` recipe: build the frontend, let
   the backend serve it on `:8080`, drive with `agent-browser`. Verify by **computed style**,
   not by eye — a 0.02 lightness step is not reliably visible in a screenshot, and this whole
   change is made of 0.02 steps.
4. Specifically check the two things §4.1 predicts: a card outline on `bg3` and a menu
   separator on `bg5` must still read as lifting, not denting.

## 8. Out of scope

- **A light theme.** Every ink, soft alpha, shadow and scrim would need a second value; it
  is a separate project, not a background swap.
- **The accent, semantic and file-type palettes.** Held fixed so this change is about the
  ground alone. The soft-fill inks were re-measured (§3) because their beds moved, but no
  value changes.
- **The command palette**, still a maintainer decision not to build.
