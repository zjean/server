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

// The design ships final sRGB hex and _tokens.scss declares it once per token, so
// this needs no colour-space conversion and no CSS engine — which is the whole
// reason the file is plain hex (see its header). A token declared as anything but
// a literal hex is not resolved here; it is reported, so a future `var()` or
// `oklch()` cannot silently drop a rule from this suite.
const token = (name: string): string => {
  const m = new RegExp(`--si-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(src)
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
  it('gives --si-border 3:1 on the input fill and inside a dialog', () => {
    expect(contrast(token('border'), token('bg3')), '--si-border on the bg3 input fill').toBeGreaterThanOrEqual(NON_TEXT)
    expect(contrast(token('border'), token('bg5')), '--si-border on a bg5 dialog').toBeGreaterThanOrEqual(NON_TEXT)
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

  it('has no step large enough to read as skipping a plane', () => {
    // The design bans skipping two steps between adjacent planes. Expressed as a
    // contrast ceiling between neighbours, which is the measurable form of it.
    for (let i = 1; i < SURFACES.length; i++) {
      const step = contrast(token(SURFACES[i]), token(SURFACES[i - 1]))
      expect(step, `the step from --si-${SURFACES[i - 1]} to --si-${SURFACES[i]}`).toBeLessThan(1.6)
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
