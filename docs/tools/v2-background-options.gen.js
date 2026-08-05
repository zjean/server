// Generates a self-contained HTML decision aid: the v2 app chrome rendered under
// each candidate background palette, with every contrast figure computed here
// rather than typed, so the page cannot disagree with the maths.
const fs = require('fs')

/* ── colour maths ─────────────────────────────────────────────────────────── */
const hex = (h) => h.replace('#', '').match(/../g).map((x) => parseInt(x, 16))
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const unlin = (c) => { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(v * 255))) }
const Y = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
const cr = (a, b) => { const [l, d] = [Y(hex(a)), Y(hex(b))].sort((x, y) => y - x); return (l + 0.05) / (d + 0.05) }
const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
function oklab(rgb) {
  const [r, g, b] = rgb.map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180 / Math.PI) + 360) % 360 }
}
function fromOklab(L, C, h) {
  const A = C * Math.cos(h * Math.PI / 180), B = C * Math.sin(h * Math.PI / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)]
}
const ok = (L, C, h) => toHex(fromOklab(L, C, h))
const f = (n) => n.toFixed(2)

/* ── today's values, as shipped in _tokens.scss ───────────────────────────── */
const SURF = ['bg0', 'bg1', 'bg2', 'band', 'bg3', 'bg5', 'bg6']
const CURRENT = {
  bg0: '#100f0e', bg1: '#161513', bg2: '#1a1917', band: '#1e1c1a', bg3: '#232120', bg5: '#2d2a28', bg6: '#383431',
  'line-subtle': '#2a2725', line: '#35312e', 'line-strong': '#4a453f', border: '#8a857d',
  fg: '#f5f2ee', muted: '#b8b2a9', tertiary: '#8a857d', quiet: '#635e58',
  ring: '#4c7ef3', scrim: 'rgba(11,10,9,0.6)',
}
const CUR_L = SURF.map((k) => oklab(hex(CURRENT[k])).L)          // 0.169 … 0.328
// Lightness of the non-surface tones, so a rotated ramp keeps its own ladder.
const TONE_L = { 'line-subtle': 0.275, line: 0.316, 'line-strong': 0.393, border: 0.619, fg: 0.962, muted: 0.766, tertiary: 0.619, quiet: 0.485 }
const TONE_C = { 'line-subtle': 0.006, line: 0.008, 'line-strong': 0.012, border: 0.013, fg: 0.006, muted: 0.014, tertiary: 0.013, quiet: 0.011 }
const RINGS = ['#4c7ef3', '#8fadfa', '#a9c0fb']                   // accent 500 / 400 / 300

/* ── build a palette, then repair whatever the lift broke ─────────────────── */
// Each candidate is expressed as a lightness ladder + a hue + a chroma scale.
// Three tones are then LIFTED IF NEEDED so the palette keeps the rules the
// shipped system already states, rather than quietly dropping them:
//   · muted must clear 4.5 on every surface  (stated in _tokens.scss's header)
//   · tertiary must clear 4.5 on bg0..band   (the rule the 50-site sweep settled)
//   · the focus ring must clear 3.0 on bg6   (SC 1.4.11)
function build({ Ls, hue, cScale = 1, coolType = true, tertiaryL = null }) {
  const p = {}
  SURF.forEach((k, i) => { p[k] = ok(Ls[i], coolType || true ? 0.012 * cScale : 0, hue) })
  // Lines are positioned RELATIVE to the ramp: each keeps the offset it has today
  // from the surface it is drawn against. Held at an absolute lightness they invert
  // on a lifted ramp — a rule that lifts off a card starts denting into it (§4.1).
  // Offset from the NOMINAL ladder value, not from the quantized hex of the
  // surface: re-deriving it from the rounded 8-bit colour shifts the result by a
  // unit and makes the spec and this page disagree over nothing.
  const LINE_ANCHOR = { 'line-subtle': [4, 0.025], line: [5, 0.029], 'line-strong': [6, 0.065] }
  for (const k of Object.keys(TONE_L)) {
    const anchor = LINE_ANCHOR[k]
    const L = anchor ? Ls[anchor[0]] + anchor[1] : TONE_L[k]
    p[k] = coolType ? ok(L, TONE_C[k] * cScale, hue) : CURRENT[k]
  }
  const moved = []
  // muted: lift until it clears 4.5 on the lightest surface.
  let mL = TONE_L.muted
  while (cr(p.muted, p.bg6) < 4.5 && mL < 0.95) { mL += 0.005; p.muted = ok(mL, TONE_C.muted * cScale, coolType ? hue : 78) }
  if (mL > TONE_L.muted) moved.push(`muted lifted L ${TONE_L.muted.toFixed(3)}→${mL.toFixed(3)} so it still clears 4.5 on every surface`)
  // tertiary: lift until it clears 4.5 on `band`, keeping the bg0..band licence.
  // `tertiaryL`, when given, is the value the SPEC fixed for this ramp
  // (2026-08-05-v2-background-palette-design.md §4.2). The search below is how
  // that value was found; it is not how it is reproduced, and re-deriving it by
  // iteration lands 0.004 away and puts the page out of step with the build.
  let tL = tertiaryL ?? TONE_L.tertiary
  if (tertiaryL) p.tertiary = ok(tL, TONE_C.tertiary * cScale, hue)
  while (!tertiaryL && cr(p.tertiary, p.band) < 4.62 && tL < 0.95) { tL += 0.005; p.tertiary = ok(tL, TONE_C.tertiary * cScale, coolType ? hue : 80) }
  if (tL > TONE_L.tertiary) moved.push(`tertiary lifted L ${TONE_L.tertiary.toFixed(3)}→${tL.toFixed(3)} so it stays legal as text on bg0–band`)
  p.border = p.tertiary // --si-border is the tertiary tone by design (deviation 2)
  // ring: the darkest accent step that still clears 3:1 on bg6.
  p.ring = RINGS.find((r) => cr(r, p.bg6) >= 3.0) || RINGS[RINGS.length - 1]
  if (p.ring !== CURRENT.ring) moved.push(`focus ring moved ${CURRENT.ring} → ${p.ring} (accent-500 measures ${f(cr(CURRENT.ring, p.bg6))} on the lifted bg6, below 3:1)`)
  // glyph check: tertiary as a non-text glyph on the two overlay surfaces.
  const glyphFails = ['bg5', 'bg6'].filter((k) => cr(p.tertiary, p[k]) < 3.0)
  const sc = oklab(hex(p.bg0))
  p.scrim = `rgba(${fromOklab(0.146, 0.012 * cScale, hue).join(',')},0.6)`
  p.chrome = p.bg0
  return { p, moved, glyphFails, hue, Ls }
}

const LIFT_FLOOR = [0.225, 0.245, 0.260, 0.272, 0.290, 0.312, 0.340]
const LIFT_ALL = CUR_L.map((L) => L + 0.08)

const OPTIONS = [
  {
    id: 'current', name: 'Current', tag: 'shipping today',
    blurb: 'The warm neutral ramp as shipped. Here as the baseline only — every figure below is measured against it.',
    palette: { p: { ...CURRENT, chrome: CURRENT.bg0 }, moved: [], glyphFails: [], hue: 68, Ls: CUR_L },
    cost: 'n/a', group: 'base',
  },
  {
    id: 'cool-hold', name: 'Option 1 · Cool, same darkness', tag: 'zero risk',
    blurb: 'Surfaces, type and lines rotated to a cool slate at <em>identical luminance</em>. Every contrast ratio in the token header stays valid to within 0.05, so nothing needs re-auditing. Kills the brown; the app stays as dark as it is now.',
    palette: build({ Ls: CUR_L, hue: 255 }),
    cost: '~18 token values · no call-site edits · no re-audit', group: 'lightness',
  },
  {
    id: 'cool-lift', name: 'Option 2 · Cool + lift the floor', tag: 'recommended',
    blurb: 'Lifts the five surfaces that cover almost every pixel off near-black, while holding <code>bg5</code>/<code>bg6</code> near where they are so the focus ring never has to move. The ladder compresses a little, so dialogs and menus lean more on shadow and less on value.',
    palette: build({ Ls: LIFT_FLOOR, hue: 255, tertiaryL: 0.650 }),
    cost: '~20 token values · no call-site edits · header grid recomputed', group: 'lightness',
  },
  {
    id: 'cool-lift-all', name: 'Option 3 · Cool + lift everything', tag: 'biggest change',
    blurb: 'A genuinely mid-slate app. This is the option that spends the headroom at the top of the ramp, so the focus ring and two text tones have to be retuned with it, and the rendered-tree audit has to be re-run per state (hover, dialog, sheet, mobile).',
    palette: build({ Ls: LIFT_ALL, hue: 255, cScale: 1.15 }),
    cost: '~23 token values · ring + 2 tones retuned · full re-audit', group: 'lightness',
  },
  {
    id: 'hue-graphite', name: 'Graphite', tag: 'hue · 0° chroma',
    blurb: 'Option 2\'s lightness with all chroma removed — a true neutral. The most literal reading of "no brown": nothing tints anything.',
    palette: build({ Ls: LIFT_FLOOR, hue: 255, cScale: 0.001, tertiaryL: 0.650 }), group: 'hue',
  },
  {
    id: 'hue-slate', name: 'Cool slate · 255°', tag: 'hue · recommended',
    blurb: 'Option 2 as proposed. Shares its hue family with the cobalt accent, so the accent reads as native to the ground rather than applied on top of it.',
    palette: build({ Ls: LIFT_FLOOR, hue: 255, tertiaryL: 0.650 }), group: 'hue',
  },
  {
    id: 'hue-teal', name: 'Teal slate · 195°', tag: 'hue',
    blurb: 'Cooler and greener. Sits further from cobalt on the wheel, so the accent pops harder — which is either the point or too much, depending on how loud you want the one primary action to be.',
    palette: build({ Ls: LIFT_FLOOR, hue: 195, tertiaryL: 0.650 }), group: 'hue',
  },
  {
    id: 'hue-indigo', name: 'Indigo · 290°', tag: 'hue',
    blurb: 'Violet-leaning. Careful here: it is the same family as <code>--si-violet</code>, the secondary reserved for Space marks and public links, so a ground this hue makes that signal harder to read as a signal.',
    palette: build({ Ls: LIFT_FLOOR, hue: 290, tertiaryL: 0.650 }), group: 'hue',
  },
]

/* ── measured tables ──────────────────────────────────────────────────────── */
const TIERS = ['fg', 'muted', 'tertiary', 'quiet']
function grid(p) {
  let rows = ''
  for (const t of TIERS) {
    let cells = ''
    for (const s of SURF) {
      const r = cr(p[t], p[s])
      const need = t === 'fg' || t === 'muted' ? 4.5 : t === 'tertiary' ? 4.5 : 99
      const cls = t === 'quiet' ? 'na' : r >= need ? 'ok' : t === 'tertiary' ? 'sub' : 'bad'
      cells += `<td class="${cls}">${f(r)}</td>`
    }
    rows += `<tr><th>${t}</th>${cells}</tr>`
  }
  let ring = ''
  for (const s of SURF) { const r = cr(p.ring, p[s]); ring += `<td class="${r >= 3 ? 'ok' : 'bad'}">${f(r)}</td>` }
  rows += `<tr class="rule"><th>focus ring</th>${ring}</tr>`
  let glyph = ''
  for (const s of SURF) { const r = cr(p.tertiary, p[s]); glyph += `<td class="${r >= 3 ? 'ok' : 'bad'}">${f(r)}</td>` }
  rows += `<tr><th>tertiary glyph</th>${glyph}</tr>`
  return `<table class="grid"><thead><tr><th></th>${SURF.map((s) => `<th>${s}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
}
function styleVars(p) {
  return SURF.map((s) => `--si-${s === 'band' ? 'bg-band' : s}:${p[s]}`)
    .concat([`--si-line-subtle:${p['line-subtle']}`, `--si-line:${p.line}`, `--si-line-strong:${p['line-strong']}`,
      `--si-border:${p.border}`, `--si-fg:${p.fg}`, `--si-fg-muted:${p.muted}`, `--si-fg-tertiary:${p.tertiary}`,
      `--si-fg-ghost:${p.quiet}`, `--si-focus-ring:${p.ring}`, `--si-scrim:${p.scrim}`, `--si-chrome-bg:${p.chrome}`])
    .join(';')
}
function tokenBlock(o) {
  const p = o.palette.p
  const line = (k, v, note) => `  --si-${k}: ${v};${note ? ` // ${note}` : ''}`
  const was = (k) => CURRENT[k] && CURRENT[k] !== p[k] ? `was ${CURRENT[k]}` : ''
  return [
    ...SURF.map((s) => line(s === 'band' ? 'bg-band' : s, p[s], was(s))),
    '',
    line('line-subtle', p['line-subtle'], was('line-subtle')),
    line('line', p.line, was('line')),
    line('line-strong', p['line-strong'], was('line-strong')),
    line('border', p.border, was('border')),
    '',
    line('fg', p.fg, was('fg')),
    line('fg-muted', p.muted, was('muted')),
    line('fg-tertiary', p.tertiary, was('tertiary')),
    line('fg-ghost', p.quiet, was('quiet')),
    '',
    line('focus-ring', p.ring, was('ring')),
    line('scrim', p.scrim, was('scrim')),
    line('chrome-bg', p.chrome, ''),
    line('chrome-bg-dark', p.chrome, ''),
  ].join('\n')
}

/* ── the chrome mockup ────────────────────────────────────────────────────── */
const NAV = [
  ['sec', 'Workspace'], ['item', 'Search'], ['active', 'Recents'], ['item', 'Favorites'],
  ['item', 'Personal'], ['item', 'Spaces'], ['sec', 'Shared'], ['item', 'With me'], ['item', 'Via links'],
]
const ROWS = [
  ['Security policy.md', 'company-handbook/Policies', '2 days ago'],
  ['Remote work.md', 'company-handbook/Policies', '2 days ago'],
  ['query-timings.csv', 'benchmarks', '3 days ago'],
  ['Retention job benchmark.md', 'benchmarks', '4 days ago'],
]
function mock(o, big) {
  const p = o.palette.p
  return `<div class="chrome ${big ? 'chrome--big' : ''}" style="${styleVars(p)}">
  <div class="chrome__nav">
    <div class="brand"><span class="brand__dot"></span><span class="brand__t">Sync-In<em>FILES</em></span></div>
    ${NAV.map(([k, t]) => k === 'sec' ? `<div class="navsec">${t}</div>`
      : `<div class="navitem${k === 'active' ? ' is-active' : ''}"><i></i>${t}</div>`).join('\n    ')}
  </div>
  <div class="chrome__main">
    <div class="chrome__top"><div class="crumb"><i></i>Recents</div><div class="search">Search files…<kbd>⌘K</kbd></div><div class="av">Sy</div></div>
    <div class="chrome__content">
      <h3>Recents</h3>
      <p class="sub">Files you and your collaborators have touched recently.</p>
      <div class="eyebrow">Pick up where you left off <span class="pill">4</span></div>
      <div class="cards">
        ${['doc', 'sheet', 'doc', 'image'].map((t, i) => `<div class="card${i === 0 ? ' is-hover' : ''}">
          <div class="tile tile--${t}"></div><div class="cname">${['Sync engine notes.md', 'query-timings.csv', 'Retention job.md', 'diagram.png'][i]}</div>
          <div class="cmeta">${['/', 'benchmarks', 'benchmarks', 'Documents'][i]} · 2 days ago</div></div>`).join('')}
      </div>
      <div class="eyebrow">Earlier <span class="pill">16</span></div>
      <div class="tbl">
        <div class="thead"><span>Name</span><span>Location</span><span>Modified</span></div>
        ${ROWS.map((r, i) => `<div class="trow${i % 2 ? ' is-band' : ''}${i === 2 ? ' is-sel' : ''}"><span class="tn"><i class="dot"></i>${r[0]}</span><span class="tm">${r[1]}</span><span class="tm">${r[2]}</span></div>`).join('')}
      </div>
      ${big ? `<div class="ctlrow">
        <button class="btn btn--primary">Share</button>
        <button class="btn">Rename</button>
        <button class="btn btn--focus">Focused control</button>
        <span class="chip">read-only</span>
        <span class="input">filename.md</span>
      </div>` : ''}
    </div>
    ${big ? `<div class="scrim"></div>
    <div class="dialog">
      <div class="dlg__h">Delete 3 items?</div>
      <div class="dlg__b">They move to the trash and are removed after 30 days. <span class="q">This cannot be undone.</span></div>
      <div class="dlg__f"><button class="btn">Cancel</button><button class="btn btn--danger">Delete</button></div>
    </div>` : ''}
    <div class="menu"><div class="mi">Open</div><div class="mi">Rename<span class="k">F2</span></div><div class="msep"></div><div class="mi mi--d">Delete</div></div>
    <div class="tip">Tooltip · bg6</div>
  </div>
</div>`
}

/* ── page ─────────────────────────────────────────────────────────────────── */
const swatchRow = (o) => `<div class="sw">${SURF.map((s) => `<span style="background:${o.palette.p[s]}" title="${s} ${o.palette.p[s]}"></span>`).join('')}
  <span class="swgap"></span>${TIERS.map((t) => `<span class="swt" style="background:${o.palette.p[t]}" title="${t} ${o.palette.p[t]}"></span>`).join('')}</div>`

function notes(o) {
  const out = []
  if (o.palette.moved.length) out.push(...o.palette.moved.map((m) => `<li class="n-move">${m}</li>`))
  if (o.palette.glyphFails.length) out.push(`<li class="n-bad">tertiary glyphs still fail 3:1 on ${o.palette.glyphFails.join(' and ')} even after the lift — those icons would need their own tone</li>`)
  const dl = o.palette.Ls
  const steps = dl.slice(1).map((x, i) => (x - dl[i]).toFixed(3))
  const curSteps = CUR_L.slice(1).map((x, i) => (x - CUR_L[i]).toFixed(3))
  if (o.id !== 'current') out.push(`<li>lightness steps <code>${steps.join(' · ')}</code> <span class="dim">(today <code>${curSteps.join(' · ')}</code>)</span></li>`)
  if (!out.length) out.push('<li class="n-ok">nothing had to be retuned — every rule the shipped system states still holds</li>')
  return `<ul class="notes">${out.join('')}</ul>`
}

const card = (o) => `<section class="opt" id="opt-${o.id}" data-id="${o.id}">
  <header class="opt__h">
    <div><h2>${o.name}</h2>${o.tag ? `<span class="tag tag--${o.id === 'cool-lift' || o.tag.includes('recommended') ? 'rec' : 'x'}">${o.tag}</span>` : ''}</div>
    <button class="pick" data-pick="${o.id}">Preview large ↑</button>
  </header>
  <p class="opt__b">${o.blurb}</p>
  ${swatchRow(o)}
  <div class="opt__mock">${mock(o, false)}</div>
  ${notes(o)}
  ${grid(o.palette.p)}
  <details><summary>_tokens.scss values</summary><pre>${tokenBlock(o)}</pre></details>
</section>`

const CSS = fs.readFileSync(__dirname + '/v2-background-options.css', 'utf8')
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>v2 app chrome — background palette options</title>
<style>${CSS}</style>
</head>
<body>
<div class="page" data-shell="dark">
<header class="head">
  <h1>v2 app chrome — background options</h1>
  <p class="lede">The chrome rendered under each candidate ground. Every contrast figure on this page is computed from the hex values shown, by WCAG 2.x relative luminance — nothing here is typed by hand.</p>
  <div class="finding">
    <strong>One measurement worth reading first.</strong> The surfaces shipping today are <em>not</em> brown — all seven measure
    0.003–0.008 chroma in OKLab, i.e. effectively neutral. The warmth lives in the <em>type and line</em> tokens, which are two to
    four times more chromatic (<code>--si-fg-muted</code> 0.014 · <code>--si-fg-tertiary</code> 0.013 · <code>--si-fg</code> is a
    cream, not a white). So rotating only the seven <code>bg</code> tokens is a nearly invisible change. Every option below moves
    the type ramp with the ground.
    <br><br>
    <strong>And one constraint.</strong> The top of the ramp has 0.02 of lightness headroom: the focus ring clears SC 1.4.11's 3:1
    only up to a surface at L=0.348, and <code>bg6</code> is L=0.328 today. Lightening the overlay surfaces breaks the focus ring
    and every tertiary glyph on menus, dialogs and tooltips — silently, with no build failure. That is the whole reason options 2
    and 3 differ.
  </div>
  <div class="ctl">
    <span class="ctl__l">Page behind the mockups</span>
    <button data-shell="dark" class="on">near-black</button><button data-shell="mid">mid grey</button><button data-shell="light">light</button>
    <span class="ctl__l ctl__l--2">Type ramp</span>
    <button data-type="cool" class="on">cooled with the ground</button><button data-type="warm">keep today's warm type</button>
  </div>
</header>

<div class="viewer">
  <div class="viewer__h"><h2 id="vname">Option 2 · Cool + lift the floor</h2><span class="dim" id="vhint">click “Preview large” on any option below</span></div>
  <div id="vmount"></div>
</div>

<div class="grp"><h2 class="grph">How far the lightness moves</h2><p class="grpb">The hue swap is cheap and identical in all three. The <em>lightening</em> is what cascades — that is the real choice.</p></div>
${OPTIONS.filter((o) => o.group === 'base' || o.group === 'lightness').map(card).join('')}

<div class="grp"><h2 class="grph">Which hue family</h2><p class="grpb">All four at Option 2's lightness, so only the hue differs. The cobalt accent is held fixed in every one — we are comparing grounds, not accents.</p></div>
${OPTIONS.filter((o) => o.group === 'hue').map(card).join('')}

<footer class="foot">Tell me the option id you want — e.g. <code>option 2, teal</code> — and I'll write the design doc and the token diff.</footer>
</div>
<script>
const MOCKS = ${JSON.stringify(Object.fromEntries(OPTIONS.map((o) => [o.id, mock(o, true)])))};
const NAMES = ${JSON.stringify(Object.fromEntries(OPTIONS.map((o) => [o.id, o.name])))};
const WARM = ${JSON.stringify({ fg: CURRENT.fg, muted: CURRENT.muted, tertiary: CURRENT.tertiary, quiet: CURRENT.quiet })};
const page = document.querySelector('.page');
let current = 'cool-lift';
function paint() {
  document.getElementById('vmount').innerHTML = MOCKS[current];
  document.getElementById('vname').textContent = NAMES[current];
  applyType();
}
function applyType() {
  const warm = page.dataset.type === 'warm';
  document.querySelectorAll('.chrome').forEach((c) => {
    if (warm) {
      c.style.setProperty('--si-fg', WARM.fg); c.style.setProperty('--si-fg-muted', WARM.muted);
      c.style.setProperty('--si-fg-tertiary', WARM.tertiary); c.style.setProperty('--si-fg-ghost', WARM.quiet);
    } else { ['--si-fg','--si-fg-muted','--si-fg-tertiary','--si-fg-ghost'].forEach((v) => c.style.removeProperty(v)); }
  });
}
document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) { current = pick.dataset.pick; paint(); document.querySelector('.viewer').scrollIntoView({behavior:'smooth', block:'start'}); return; }
  const shell = e.target.closest('[data-shell]');
  if (shell && shell.tagName === 'BUTTON') {
    page.dataset.shell = shell.dataset.shell;
    document.querySelectorAll('[data-shell]').forEach((b) => b.tagName === 'BUTTON' && b.classList.toggle('on', b === shell));
    return;
  }
  const ty = e.target.closest('[data-type]');
  if (ty && ty.tagName === 'BUTTON') {
    page.dataset.type = ty.dataset.type;
    document.querySelectorAll('[data-type]').forEach((b) => b.tagName === 'BUTTON' && b.classList.toggle('on', b === ty));
    applyType();
  }
});
paint();
</script>
</body>
</html>`

fs.writeFileSync(__dirname + '/../v2-background-options.html', html)
console.log('written', html.length, 'bytes')
// Console summary, so the numbers are also checkable outside the page.
for (const o of OPTIONS) {
  const p = o.palette.p
  console.log(`\n${o.name}  hue ${Math.round(o.palette.hue)}°  ring ${p.ring}`)
  console.log('  surfaces ' + SURF.map((s) => p[s]).join(' '))
  console.log('  fg ' + f(cr(p.fg, p.bg0)) + '..' + f(cr(p.fg, p.bg6)) +
    '  muted ' + f(cr(p.muted, p.bg0)) + '..' + f(cr(p.muted, p.bg6)) +
    '  ring on bg6 ' + f(cr(p.ring, p.bg6)) + '  tertGlyph on bg6 ' + f(cr(p.tertiary, p.bg6)))
  o.palette.moved.forEach((m) => console.log('  ! ' + m))
  if (o.palette.glyphFails.length) console.log('  !! glyph fails on ' + o.palette.glyphFails.join(', '))
}
