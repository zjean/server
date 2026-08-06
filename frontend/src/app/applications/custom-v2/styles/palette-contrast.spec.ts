import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Enforces the RULES the palette is supposed to satisfy, rather than the VALUES it
// happens to hold. `tokens.spec.ts` pins values, which is what stops a deliberate
// decision being silently undone; this file pins relationships, which is what stops
// a well-intentioned recolour from breaking something no build can see.
//
// It exists because that has now happened three times in this area, and every
// instance shared one shape: a declaration that was correct before a hue or
// lightness change and wrong after it, with nothing failing in between.
//
//   · A surface moved to where the design said it belonged and made its own text
//     WORSE (--si-rose measured 3.35 on bg1 but 2.71 on bg5).
//   · A surface moved and its hover kept pointing at a value that used to be
//     lighter than it and now was darker — so the hover dented instead of lifting.
//   · The header's own contrast grid printed one sub-floor cell UNBRACKETED, and
//     the usage rule was then derived from the typo rather than from the number.
//     That licensed --si-fg-tertiary on every bg3 surface and three shipped call
//     sites took it up.
//
// Each of the three is a test below. None of them is a value assertion, and none of
// them would have been caught by one.

const TOKENS = fileURLToPath(new URL('./_tokens.scss', import.meta.url))
const src = readFileSync(TOKENS, 'utf8')

/* ── reading the token file ───────────────────────────────────────────────── */

// `token()`/`tokenRgba()` must not search `src` directly: this file is majority
// prose, and that prose quotes hexes constantly (every deviation and every worked
// example in the header). A comment like `// --si-bg5: #2d3137;` would match the
// declaration regex just as well as the real one three lines below it — matching
// whichever comes first in the file is not "safe today", it is untested. Stripped
// once, here, and used only for token lookups — `src` itself stays intact for the
// header-grid test below, which deliberately reads `//` comment lines as data.
// `(^|[^:])` guards a literal "//" that isn't a comment marker (there are none in
// this file today, but the guard costs nothing and matches the same idiom
// `tokens.spec.ts` already uses for the same job).
const declarationsOnly = src.replace(/(^|[^:])\/\/.*$/gm, '$1')

// The design ships final sRGB hex and _tokens.scss declares it once per token, so
// this needs no colour-space conversion and no CSS engine — which is the whole
// reason the file is plain hex (see its header). A token declared as anything but
// a literal hex is not resolved here; it is reported, so a future `var()` or
// `oklch()` cannot silently drop a rule from this suite.
const token = (name: string): string => {
  const m = new RegExp(`--si-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(declarationsOnly)
  if (!m) throw new Error(`--si-${name} is not declared as a literal 6-digit hex in _tokens.scss; this suite cannot measure it`)
  return m[1].toLowerCase()
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const toLinear = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const round2 = (n: number): number => Math.round(n * 100) / 100

// A separate reader from `token()` on purpose, not a relaxation of it. `token()`
// deliberately throws on anything but a literal 6-digit hex, which is what stops a
// future `var()` or `oklch()` from silently dropping a rule from this suite — the
// `*-soft` washes are legitimately `rgba(...)`, so they need their own parser rather
// than a weakened one shared with every opaque token.
const tokenRgba = (name: string): { r: number; g: number; b: number; a: number } => {
  const m = new RegExp(`--si-${name}:\\s*rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([0-9.]+)\\s*\\)\\s*;`).exec(declarationsOnly)
  if (!m) throw new Error(`--si-${name} is not declared as a literal rgba(...) in _tokens.scss; this suite cannot measure it`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) }
}

// Composites a translucent wash over an opaque bed, rounding each channel to an
// 8-bit integer the way a browser's own compositor does — this file does no alpha
// math anywhere else, so it is not enough to blend in floating point and truncate
// once at the end.
const compositeOverBed = (wash: { r: number; g: number; b: number; a: number }, bedHex: string): string => {
  const [br, bg, bb] = channels(bedHex)
  const mix = (fg: number, bed: number): number => Math.round(fg * wash.a + bed * (1 - wash.a))
  const toHex = (c: number): string => c.toString(16).padStart(2, '0')
  return `#${toHex(mix(wash.r, br))}${toHex(mix(wash.g, bg))}${toHex(mix(wash.b, bb))}`
}

/* ── the system's own vocabulary ──────────────────────────────────────────── */

// In ladder order. `bg-band` sits between bg2 and bg3 and `bg4` does not exist —
// both facts are load-bearing and documented in _tokens.scss.
const SURFACES = ['bg0', 'bg1', 'bg2', 'bg-band', 'bg3', 'bg5', 'bg6'] as const
// The surfaces --si-fg-tertiary is licensed to carry TEXT on. Narrower than the
// full ladder; the sweep that settled 50 call sites depends on exactly this list.
const TERTIARY_TEXT_SURFACES = ['bg0', 'bg1', 'bg2', 'bg-band'] as const

const AA_TEXT = 4.5 // SC 1.4.3, normal-size text
const NON_TEXT = 3.0 // SC 1.4.11, meaningful non-text: glyphs, control boundaries

describe('palette — text tiers against every surface', () => {
  it('keeps --si-fg usable on all seven surfaces', () => {
    for (const s of SURFACES) {
      expect(contrast(token('fg'), token(s)), `--si-fg on --si-${s}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  // This is the rule the "lift everything" option would have broken: muted fell to
  // 4.26 on bg6. It is stated in the header as a rule, so it is tested as one.
  it('keeps --si-fg-muted usable on all seven surfaces', () => {
    for (const s of SURFACES) {
      expect(contrast(token('fg-muted'), token(s)), `--si-fg-muted on --si-${s}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('keeps --si-fg-tertiary usable as text on bg0–band', () => {
    for (const s of TERTIARY_TEXT_SURFACES) {
      expect(contrast(token('fg-tertiary'), token(s)), `--si-fg-tertiary on --si-${s}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  // The other half of the same rule, and the half that is easy to lose. If tertiary
  // ever clears 4.5 on bg3, its licence has WIDENED — which may be fine, but it
  // makes the header's "bg3 is the last band before tertiary fails" false and
  // silently re-permits the call sites the sweep moved to muted. Failing here forces
  // that to be a decision.
  it('keeps --si-fg-tertiary BELOW the text floor on bg3 and above, so the sweep’s rule stays true', () => {
    for (const s of ['bg3', 'bg5', 'bg6'] as const) {
      expect(contrast(token('fg-tertiary'), token(s)), `--si-fg-tertiary on --si-${s}`).toBeLessThan(AA_TEXT)
    }
  })

  // Tertiary is legal for GLYPHS everywhere — icons, chevrons, the toggle knob —
  // which is why the sweep deliberately left those call sites alone.
  it('keeps --si-fg-tertiary legal as a glyph on all seven surfaces', () => {
    for (const s of SURFACES) {
      expect(contrast(token('fg-tertiary'), token(s)), `--si-fg-tertiary glyph on --si-${s}`).toBeGreaterThanOrEqual(NON_TEXT)
    }
  })
})

describe('palette — the focus ring, which has the least headroom in the system', () => {
  // The ring is the tightest constraint in the palette: it clears 3:1 only up to a
  // surface at OKLab L≈0.348, and bg6 is the lightest surface. Lightening bg6 breaks
  // it, and nothing else in the build notices.
  it('clears 3:1 on all seven surfaces', () => {
    for (const s of SURFACES) {
      expect(contrast(token('focus-ring'), token(s)), `--si-focus-ring on --si-${s}`).toBeGreaterThanOrEqual(NON_TEXT)
    }
  })
})

describe('palette — the input boundary, i.e. why --si-border is its own value', () => {
  // The header claims --si-border clears 3:1 "everywhere", not just on the input
  // fill and inside a dialog — it doubles as --si-fg-tertiary, so its own tightest
  // surface is bg6 (3.66), not bg5. Testing only bg3/bg5 would miss a regression on
  // any of the other five surfaces this token is also asked to identify a boundary
  // on.
  it('gives --si-border 3:1 on all seven surfaces', () => {
    for (const s of SURFACES) {
      expect(contrast(token('border'), token(s)), `--si-border on --si-${s}`).toBeGreaterThanOrEqual(NON_TEXT)
    }
  })

  // The measurement that makes deviation 2 necessary rather than stylistic. If this
  // ever passes 3:1, --si-border could legitimately become an alias again — so it is
  // asserted in the direction that keeps the reason visible.
  it('confirms --si-line-strong could NOT do that job', () => {
    expect(contrast(token('line-strong'), token('bg3')), '--si-line-strong on the bg3 input fill').toBeLessThan(NON_TEXT)
  })

  it('confirms the fill alone identifies nothing, which is what the boundary is for', () => {
    expect(contrast(token('bg3'), token('bg2')), 'input fill against the content plane').toBeLessThan(1.5)
  })
})

describe('palette — lines must LIFT off the surface they are drawn against', () => {
  // Each line's job is to read as a raised hairline on one particular surface. A
  // line is only correct RELATIVE to that surface, so a ramp that moves the surfaces
  // without moving the lines inverts them: the same declaration that lifts today
  // dents afterwards. Nothing about that fails a build, and it is invisible in a
  // screenshot at these step sizes.
  const ANCHORS: [string, string][] = [
    ['line-subtle', 'bg3'], // table + section rules, and card interiors
    ['line', 'bg5'], // card outlines, menu separators
    ['line-strong', 'bg6'] // hovered input outline, dashed drop targets
  ]

  for (const [line, surface] of ANCHORS) {
    it(`keeps --si-${line} lighter than --si-${surface}`, () => {
      expect(luminance(token(line)), `--si-${line} must be lighter than --si-${surface}, or it dents instead of lifting`).toBeGreaterThan(
        luminance(token(surface))
      )
    })
  }
})

describe('palette — the surface ladder', () => {
  it('rises monotonically from bg0 to bg6', () => {
    const ls = SURFACES.map((s) => luminance(token(s)))
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i], `--si-${SURFACES[i]} must be lighter than --si-${SURFACES[i - 1]}`).toBeGreaterThan(ls[i - 1])
    }
  })

  // Both bounds are measured, not guessed: the six steps in this ramp run from
  // 1.038 (bg1→bg2) to 1.109 (bg5→bg6), so 1.15/1.02 gives real headroom on each
  // side without being loose enough to let either failure mode back in.
  it('has no step large enough to read as skipping a plane', () => {
    // The design bans skipping two steps between adjacent planes. Expressed as a
    // contrast ceiling between neighbours, which is the measurable form of it. The
    // old ceiling here (1.6) had 44% of slack over the measured maximum (1.109) —
    // loose enough that it could never fire, which is worse than no test.
    for (let i = 1; i < SURFACES.length; i++) {
      const step = contrast(token(SURFACES[i]), token(SURFACES[i - 1]))
      expect(step, `the step from --si-${SURFACES[i - 1]} to --si-${SURFACES[i]}`).toBeLessThan(1.15)
    }
  })

  // The floor matters more than the ceiling for THIS ramp: its one recorded defect
  // is compression, not skipping — bg3→bg5 already measures 1.077, the second-
  // smallest step (spec §3) — so a future edit is far more likely to collapse two
  // adjacent planes into one indistinguishable step than to skip one. A step this
  // small still passes the ceiling above, which is exactly why it needs its own
  // lower bound: two planes are no longer separated once their own step disappears
  // into rounding, and nothing else in this file would notice that happening.
  it('has no step small enough to read as the same plane twice', () => {
    for (let i = 1; i < SURFACES.length; i++) {
      const step = contrast(token(SURFACES[i]), token(SURFACES[i - 1]))
      expect(step, `the step from --si-${SURFACES[i - 1]} to --si-${SURFACES[i]}`).toBeGreaterThan(1.02)
    }
  })
})

describe('palette — the header’s contrast grid must not lie', () => {
  // The grid in _tokens.scss's header is load-bearing documentation: the usage rules
  // for each text tier are derived from it. It has been wrong once, and the wrong
  // cell was not a wrong NUMBER — it was a correct number printed without its
  // brackets, from which a false rule was then read. So both are checked.
  const TIERS: [string, string][] = [
    ['fg', 'fg'],
    ['muted', 'fg-muted'],
    ['tertiary', 'fg-tertiary'],
    ['quiet', 'fg-ghost']
  ]

  for (const [label, tokenName] of TIERS) {
    it(`states ${label}'s seven ratios correctly, and brackets exactly the sub-floor ones`, () => {
      const row = new RegExp(`^//\\s+${label}\\s+(.+)$`, 'm').exec(src)
      expect(row, `the header grid has no row for '${label}'`).not.toBeNull()

      const cells = row![1].trim().split(/\s+/)
      expect(cells, `${label}: expected one cell per surface`).toHaveLength(SURFACES.length)

      cells.forEach((cell, i) => {
        const surface = SURFACES[i]
        const bracketed = cell.startsWith('[')
        const stated = Number.parseFloat(cell.replace(/[[\]]/g, ''))
        const actual = round2(contrast(token(tokenName), token(surface)))

        expect(stated, `${label} on ${surface}: header says ${cell}, measures ${actual}`).toBeCloseTo(actual, 2)
        expect(bracketed, `${label} on ${surface} measures ${actual}; a cell must be bracketed if and only if it is below ${AA_TEXT}`).toBe(
          actual < AA_TEXT
        )
      })
    })
  }
})

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

describe('palette — ink on its own soft fill, composited over every bed', () => {
  // _tokens.scss's header states a rule this file could not previously check: "Ink
  // on its own soft fill … worst bed being bg6 … All clear 4.5." That line is not a
  // token-value assertion — the soft fill is a translucent `rgba()` wash, and its
  // apparent colour (and therefore its ink's contrast) depends on whichever surface
  // it sits over, which is exactly the composited-alpha case `token()` refuses to
  // read and this suite otherwise never computes. The margin is thin: secondary
  // measures 4.56 on bg6 now, down from 4.72 before this branch's ramp lightened —
  // 0.06 of headroom. Nothing enforced that, so a future `bg6` lift could take it
  // under 4.5 without failing anything else in this file.
  const SEMANTIC_PAIRS = [
    ['accent', 'accent'], // brand
    ['green', 'success'],
    ['amber', 'warning'],
    ['rose', 'danger'],
    ['cyan', 'info'],
    ['neutral', 'neutral'],
    ['violet', 'secondary']
  ] as const

  for (const [family, role] of SEMANTIC_PAIRS) {
    it(`keeps --si-${family}-ink readable on --si-${family}-soft over all seven surfaces (${role})`, () => {
      const wash = tokenRgba(`${family}-soft`)
      const ink = token(`${family}-ink`)
      for (const s of SURFACES) {
        const bed = compositeOverBed(wash, token(s))
        expect(contrast(ink, bed), `--si-${family}-ink on --si-${family}-soft over --si-${s} (composited to ${bed})`).toBeGreaterThanOrEqual(AA_TEXT)
      }
    })
  }
})
