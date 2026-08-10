import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Enforces the one rule the light theme depends on: no component in custom-v2
// names a colour directly. Every colour goes through a token, so a light theme is
// a second `[data-theme]` block that redefines surfaces, text and lines — and
// nothing else has to change.
//
// This is a test rather than a convention because a convention is exactly what
// produced the ~70 raw colours this adoption had to clean up. Nobody added them
// in bad faith; there was just nothing to notice them.
//
// Two files are exempt, each for a reason that is about the colour NOT being app
// chrome. Both are allowlisted WITH AN EXPECTED COUNT, so an exemption cannot
// quietly grow: adding a raw colour to an exempt file changes the count and fails
// this test just as loudly as adding one anywhere else. Bumping a count is a
// deliberate, reviewable act.

const V2 = fileURLToPath(new URL('..', import.meta.url))
const TOKENS = 'styles/_tokens.scss'

const EXEMPT: Record<string, { count: number; why: string }> = {
  'screens/file-detail/file-detail.component.scss': {
    count: 2,
    why: 'the canvas an embedded document or video composites onto. A PDF is authored against white and letterbox bars belong black, whatever the app theme is.'
  },
  'preview/diagram-view.component.ts': {
    count: 2,
    why: 'colours inside a generated print document, which is not app DOM. A diagram printed on a dark ground wastes ink and loses stroke contrast on paper.'
  }
}

// Three classes of false positive had to be handled, and each one was frequent
// enough on its own to bury the real signal:
//
//  • `#419`, `#398`, `#305` — PR and issue references. This codebase cites them
//    constantly, in `//`, `/* */` AND `<!-- -->` comments, the last of these
//    inside `.html` files and inside template strings in `.ts` files. All three
//    comment syntaxes are stripped. Block comments go first so a `//` sitting
//    inside a `/* … */` cannot terminate anything.
//  • `&#9744;` `&#123;` — HTML entities. `&#9744;` is a ballot box, not a
//    four-digit hex colour, so a `#` preceded by `&` is not a colour.
//  • `color-mix(` — not a colour, a function OVER colours. Its arguments are
//    scanned like any other text, so a raw colour inside one is still caught,
//    while `color-mix(in oklab, var(--si-a), var(--si-b))` correctly passes.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const RAW_COLOUR = /(?<!&)#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const sources = walk(V2)
  .filter((f) => /\.(ts|scss|html)$/.test(f))
  .filter((f) => !f.endsWith('.spec.ts'))
  .map((f) => relative(V2, f))
  .filter((f) => f !== TOKENS)
  .sort()

const rawColoursIn = (rel: string): string[] => [...stripComments(readFileSync(join(V2, rel), 'utf8')).matchAll(RAW_COLOUR)].map((m) => m[0])

describe('custom-v2 colour discipline', () => {
  it('finds sources to check (guards against the walk silently matching nothing)', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('components/button.component.ts')
  })

  it('names no colour outside _tokens.scss', () => {
    const offenders = sources
      .filter((f) => !(f in EXEMPT))
      .map((f) => ({ file: f, colours: rawColoursIn(f) }))
      .filter((r) => r.colours.length > 0)

    expect(
      offenders.map((o) => `${o.file}: ${o.colours.join(' ')}`),
      'every colour must go through a --si-* or --fc-* token. If it genuinely is not app chrome, add it to EXEMPT with a reason.'
    ).toEqual([])
  })

  for (const [file, { count, why }] of Object.entries(EXEMPT)) {
    it(`${file} keeps exactly ${count} exempt colour(s) — ${why}`, () => {
      expect(sources, 'exempt file no longer exists; drop it from EXEMPT').toContain(file)
      expect(rawColoursIn(file)).toHaveLength(count)
    })
  }
})

// The quiet tier clears nothing — it is below 4.5:1 on all seven surfaces and below
// 3:1 as well, so _tokens.scss allows it only where the tone is not what carries the
// meaning. That was a convention, and #451 found it had drifted at 16 of 19 call
// sites: a drop-target instruction, an offline presence dot, the name of a control,
// a version's size, a comment's timestamp, three keyboard hints. None failed a build.
//
// So the surviving sites are listed rather than counted in aggregate, with the reason
// each is legal. A new `--si-fg-ghost` anywhere fails this test until someone writes
// down why the tone is not the carrier — which is the same question the audit asked,
// asked at the moment the declaration is added instead of a release later.
//
// Both categories here are ones the rendered-tree audit deliberately SKIPS
// (docs/tools/v2-contrast-audit.js), so this is not a duplicate of it: the audit
// cannot see these, and would not have found the drift in them.
const QUIET_ALLOWED: Record<string, { count: number; why: string }> = {
  'components/pagination.component.ts': {
    count: 1,
    why: 'a disabled step. SC 1.4.3 exempts an inactive component, and a step that reads as brightly as a live one is itself a defect.'
  },
  'components/tabs.component.ts': {
    count: 1,
    why: 'a disabled tab, for the same reason — the dimness IS the statement that it cannot be opened.'
  },
  'screens/people/people.component.scss': {
    count: 1,
    why: 'the offline dot in the DETAIL header, which prints the status word beside it. The dot repeats what the word already says. The avatar dot in the row has no such label and is tertiary.'
  }
}

describe('custom-v2 quiet tier — never the sole carrier of meaning', () => {
  const quietSitesIn = (rel: string): number => [...stripComments(readFileSync(join(V2, rel), 'utf8')).matchAll(/var\(--si-fg-ghost\)/g)].length

  it('uses --si-fg-ghost only at sites with a written justification', () => {
    const undocumented = sources.filter((f) => f !== TOKENS && !(f in QUIET_ALLOWED) && quietSitesIn(f) > 0)
    expect(
      undocumented,
      'the quiet tier clears no contrast floor. If the tone is genuinely not what carries the meaning here, add the file to QUIET_ALLOWED with the reason; otherwise use --si-fg-tertiary (glyphs, metadata) or --si-fg-muted (prose, and anything on bg3 or deeper).'
    ).toEqual([])
  })

  for (const [file, { count, why }] of Object.entries(QUIET_ALLOWED)) {
    it(`${file} keeps exactly ${count} quiet site(s) — ${why}`, () => {
      expect(sources, 'allowlisted file no longer exists; drop it from QUIET_ALLOWED').toContain(file)
      expect(quietSitesIn(file)).toBe(count)
    })
  }
})

// The accent-hue swap broke 21 declarations that were correct under the old warm
// accent and silently wrong under cobalt, in three distinct ways. Each is worth a
// test, because none of them fails a build and two of them look deliberate.
describe('custom-v2 accent discipline', () => {
  const tokensSrc = readFileSync(join(V2, TOKENS), 'utf8')
  const declarations = sources
    .filter((f) => /\.(scss|ts)$/.test(f))
    .flatMap((f) =>
      stripComments(readFileSync(join(V2, f), 'utf8'))
        .split('\n')
        .map((line, i) => ({ file: f, line: i + 1, text: line.trim() }))
    )

  // accent-600 measures 3.09:1 on the content plane and ~2.7 on its own 10% tint,
  // so it fails as text — while the old warm accent at L 0.70 passed, which is
  // exactly why 21 of these existed. Brand-as-type is accent-400
  // (--si-accent-ink, 6.27:1 on the tint); brand-as-ink-on-the-fill is
  // --si-accent-fg. The bare token is a FILL and nothing else.
  //
  // This is not a fact about the accent. EVERY token with an `-ink` partner is a
  // fill, and the partner exists precisely because the fill does not clear 4.5:1 as
  // type — that is what the pair is FOR. So the rule is derived from _tokens.scss
  // rather than hand-listed: any `--si-X` for which `--si-X-ink` is declared is
  // caught. A new semantic colour is covered the moment its pair is defined, and a
  // hand-maintained list cannot silently fall behind.
  //
  // Measured before the sweep that made this pass (2026-08-05), worst surface first:
  //   rose   2.55 on bg6 · 2.95 on bg5 · 3.64 on bg2   — 25 declarations, 14 files
  //   cyan   3.55 on bg5 · 3.99 on bg3 · 4.37 on bg2   — the diff hunk header
  //   green  4.56 on its own soft fill over bg5        — marginal, not failing
  //   violet identical to its own ink; a no-op, swept for uniformity
  // The rose set is the one that mattered: it was the `Delete` item in the context
  // menu and the error text in six dialogs — the two places a user is least able to
  // afford unreadable copy. See the handoff's §2.1 follow-up 2.
  const INK_PAIRED = [...tokensSrc.matchAll(/^\s*--si-([a-z]+)-ink:/gm)].map((m) => m[1])

  it('finds the ink-paired families (guards against the regex matching nothing)', () => {
    expect(INK_PAIRED).toEqual(expect.arrayContaining(['accent', 'rose', 'amber', 'green', 'cyan']))
  })

  it('never uses a fill token as a text colour — the -ink partner is the type tone', () => {
    // `nav` has no -ink of its own; it resolves to the accent and fails identically.
    const families = [...INK_PAIRED, 'nav'].join('|')
    const re = new RegExp(`^(?!.*-color:)color:\\s*var\\(--si-(${families})\\)\\s*;`)
    const offenders = declarations.filter((d) => re.test(d.text)).map((d) => `${d.file}:${d.line}`)
    expect(offenders, 'use the --si-<name>-ink partner as type; the bare token is a fill').toEqual([])
  })

  // The mirror image: a semantic or brand `-ink` tone is sized to be read as
  // type against a soft fill. Using one AS the fill inverts the pair and washes
  // the shape out.
  it('never uses an -ink tone as a fill, border or outline', () => {
    const offenders = declarations
      .filter((d) => /^(background|border|outline|accent-color)[a-z-]*:[^;]*var\(--si-[a-z]+-ink\)/.test(d.text))
      .map((d) => `${d.file}:${d.line}`)
    expect(offenders, '-ink tones are type colours; fill with the base tone').toEqual([])
  })

  // The favourite star was `--si-accent` because the accent used to be gold. A
  // star is state, not a control, so under cobalt it both broke "cobalt means
  // action" and contradicted the design's amber favourite badge.
  it('draws the favourite star in amber, not the accent', () => {
    for (const f of ['screens/files/file-browser.component.scss', 'screens/favorites/favorites.component.scss']) {
      const src = readFileSync(join(V2, f), 'utf8')
      expect(src, `${f}: the favourite star must be --si-amber-ink`).toMatch(/--si-amber-ink/)
    }
  })

  // "Periwinkle marks Space identity so cobalt stays reserved for Create space."
  it('marks Space identity in periwinkle', () => {
    const src = readFileSync(join(V2, 'screens/spaces/spaces.component.scss'), 'utf8')
    expect(src).toMatch(/--si-violet-soft/)
  })
})

describe('custom-v2 token file', () => {
  const tokens = readFileSync(join(V2, TOKENS), 'utf8')

  // The three deviations documented in _tokens.scss, pinned so a later
  // "let's match the mockups exactly" pass cannot silently undo them. Each was
  // measured against its own stated floor and failed; the header carries the
  // numbers.
  it('keeps the focus ring opaque — the design’s 60% alpha fails 3:1 on every surface', () => {
    expect(tokens).toMatch(/--si-focus-ring:\s*#4c7ef3;/i)
  })

  it('keeps --si-border independent of --si-line-strong, which measures 1.56 on the input fill', () => {
    expect(tokens).toMatch(/--si-border:\s*#8a9097;/i)
    expect(tokens).not.toMatch(/--si-border:\s*var\(--si-line-strong\)/)
  })

  it('keeps --si-amber a real warning colour, not an accent alias', () => {
    expect(tokens).not.toMatch(/--si-amber:\s*var\(--si-accent\)/)
    expect(tokens).toMatch(/--si-amber:\s*#c9932f;/i)
  })
})
