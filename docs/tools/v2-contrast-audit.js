// Surface-outward contrast audit for the v2 tree. Paste into a driven browser:
//
//   agent-browser --session x eval -b "$(base64 -i docs/tools/v2-contrast-audit.js | tr -d '\n')"
//
// Returns { url, checked, fails[], tones{} } as JSON. `tones` is every distinct
// foreground-on-background pair it saw with a count — read that even when `fails`
// is empty, because it is what shows a tone surviving somewhere it should not
// (e.g. tertiary still resolving to #8a857d inside a bottom sheet).
//
// Why this exists, and why the report is shaped this way, is in
// frontend/src/app/applications/custom-v2/styles/_tokens.scss, with the tertiary
// tier. The short version: a declaration's surface depends on where its element
// mounts, so it cannot be read out of the stylesheet — but it CAN be read out of
// the rendered tree, and doing so also catches conditional failures (correct at
// rest, wrong on hover; correct on desktop, wrong in the mobile sheet) that no
// static reading finds.
//
// Two things it deliberately does NOT flag, because both are legal and a
// mechanical sweep of them does damage:
//   • glyphs (no own text, svg/path) — SC 1.4.11 asks 3:1, not 4.5
//   • disabled controls — SC 1.4.3 exempts an inactive component
//
// Three limits worth knowing before trusting a clean run:
//   • It only sees what is MOUNTED. Drive the state (open the dialog, hover the
//     row, switch the view mode) and re-run; a route that silently redirects
//     audits the wrong screen, so check the returned `url` rather than assuming.
//   • It resolves a background by walking ancestors for the first non-transparent
//     background-COLOR. Text over a background-image or gradient is not measured.
//   • It reads computed styles only, so it is immune to agent-browser's headless
//     Chromium firing no rAF and never advancing an animation clock — an
//     off-screen bottom sheet still reports correct colours.
(() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }
  }
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05) }
  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')

  const root = document.querySelector('.v2-root')
  if (!root) return JSON.stringify({ error: 'no .v2-root' })

  // Effective background: first ancestor (self included) with a non-transparent
  // background-color. Composites over what is behind it if it is semi-transparent.
  const bgOf = (el) => {
    const stack = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const p = parse(getComputedStyle(n).backgroundColor)
      if (p && p.a > 0) { stack.push(p); if (p.a >= 0.999) break }
    }
    if (!stack.length) return [16, 15, 14]
    let base = stack[stack.length - 1].rgb
    for (let i = stack.length - 2; i >= 0; i--) {
      const t = stack[i]
      base = base.map((c, k) => Math.round(t.rgb[k] * t.a + c * (1 - t.a)))
    }
    return base
  }

  const path = (el) => {
    const bits = []
    for (let n = el; n && n !== root && bits.length < 4; n = n.parentElement) {
      bits.unshift(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''))
    }
    return bits.join(' > ')
  }

  const fails = []
  const tones = {}
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    // Only elements that own text directly — otherwise a wrapper is counted for
    // every string beneath it and the report is all duplicates.
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ')
    const isGlyph = !own && (el.tagName === 'svg' || el.tagName === 'path')
    if (!own && !isGlyph) continue
    const fg = parse(cs.color)
    if (!fg || fg.a === 0) continue
    const bg = bgOf(el)
    const r = ratio(fg.rgb, bg)
    const size = parseFloat(cs.fontSize)
    const weight = parseInt(cs.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const disabled = el.disabled === true || el.closest('[disabled],:disabled,.tabs__tab--disabled') !== null
    const floor = isGlyph ? 3 : large ? 3 : 4.5
    const key = hex(fg.rgb) + ' on ' + hex(bg)
    tones[key] = (tones[key] || 0) + 1
    if (r < floor && !disabled) {
      fails.push({ ratio: +r.toFixed(2), floor, size, weight, glyph: isGlyph, fg: hex(fg.rgb), bg: hex(bg), text: own.slice(0, 48), at: path(el) })
    }
  }
  fails.sort((a, b) => a.ratio - b.ratio)
  // Every distinct fg-on-bg pair seen, so a tone that is legal but unexpected
  // (e.g. tertiary surviving inside a sheet) is visible even with zero failures.
  return JSON.stringify({ url: location.hash, checked: Object.values(tones).reduce((a, b) => a + b, 0), fails, tones }, null, 1)
})()
