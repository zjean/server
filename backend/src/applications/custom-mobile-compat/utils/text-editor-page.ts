// HTML page for the in-app text editor served at
// /custom-mobile-compat/text-editor?token=…
//
// Self-contained: inline CSS, inline JS that fetches /content and PUTs it
// back. No external CDN — works behind any reverse proxy and survives
// offline edits-not-yet-saved without losing the user's work to an asset
// fetch failure.
//
// CodeMirror is loaded as an ES module from /custom-mobile-compat/text-editor/
// codemirror.bundle.js when present; if the bundle isn't built yet (or fails
// to load), the page falls back to a plain <textarea> so the feature stays
// functional. The `data-bundle-url` attribute hands the URL to the inline
// loader.
//
// Token-only auth: every fetch includes `?token=<jwt>` — WKWebView does not
// share Basic Auth from the OCS path, so cookies/Authorization are unusable.

import { escapeHtml } from './nc-html'
import { NC_MOBILE_BRIDGE_JS } from './nc-mobile-bridge'

export interface TextEditorPageOptions {
  token: string
  fileName: string
  // Best-guess language id passed to CodeMirror (markdown, javascript, json, …)
  language: string
  // Display-only readonly hint (e.g., when the file exceeds the size cap).
  // The PUT endpoint enforces independently.
  readOnly?: boolean
  readOnlyReason?: string
}

export function renderTextEditorPage(opts: TextEditorPageOptions): string {
  const safeName = escapeHtml(opts.fileName)
  const safeToken = escapeHtml(opts.token)
  const safeLang = escapeHtml(opts.language)
  const readOnly = opts.readOnly === true
  const safeReason = readOnly ? escapeHtml(opts.readOnlyReason ?? 'This file is read-only.') : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="color-scheme" content="light dark" />
<title>${safeName}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --border: #e5e7eb;
    --accent: #0082c9; --accent-fg: #ffffff; --err: #b91c1c; --warn-bg: #fef3c7;
    --toolbar-bg: #f9fafb; --toolbar-shadow: rgba(0,0,0,0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --fg: #e5e7eb; --muted: #94a3b8; --border: #334155;
      --accent: #38bdf8; --accent-fg: #0b1220; --err: #f87171; --warn-bg: #422006;
      --toolbar-bg: #1e293b; --toolbar-shadow: rgba(0,0,0,0.3);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    padding-top: max(8px, env(safe-area-inset-top));
    background: var(--toolbar-bg); border-bottom: 1px solid var(--border);
    box-shadow: 0 1px 0 var(--toolbar-shadow);
    flex-shrink: 0;
  }
  .name { flex: 1; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name .dot { display: none; color: var(--accent); margin-right: 4px; }
  .name.dirty .dot { display: inline; }
  .btn { padding: 7px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .status { font-size: 12px; color: var(--muted); margin-left: 8px; }
  .status.err { color: var(--err); }
  .editor-host { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  textarea.fallback {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; outline: 0; resize: none; padding: 12px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    background: var(--bg); color: var(--fg); white-space: pre; tab-size: 2;
  }
  .banner {
    background: var(--warn-bg); color: var(--fg); padding: 8px 12px;
    font-size: 13px; border-bottom: 1px solid var(--border); display: none;
  }
  .banner.show { display: block; }
  .cm-host { position: absolute; inset: 0; }
  /* CodeMirror's internal styles are bundled into its JS, but a few
     positioning rules need to come from us so the editor fills the host. */
  .cm-host .cm-editor { height: 100%; font-size: 13px; }
  .cm-host .cm-scroller { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
</style>
</head>
<body
  data-token="${safeToken}"
  data-language="${safeLang}"
  data-readonly="${readOnly ? '1' : '0'}"
  data-bundle-url="/custom-mobile-compat/text-editor/codemirror.bundle.js"
>
  <div class="toolbar">
    <span class="name" id="name"><span class="dot">•</span><span id="name-text">${safeName}</span></span>
    <span class="status" id="status">Loading…</span>
    <button class="btn" id="close-btn" type="button">Close</button>
    <button class="btn primary" id="save-btn" type="button" disabled>Save</button>
  </div>
  <div class="banner" id="banner">${safeReason}</div>
  <div class="editor-host">
    <div class="cm-host" id="cm-host" hidden></div>
    <textarea class="fallback" id="fallback" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"></textarea>
  </div>
<script>
(async () => {
${INLINE_BOOTSTRAP_JS}
})()
</script>
</body>
</html>`
}

// Inline bootstrap. Loads the file content, wires save/close, and tries to
// upgrade the textarea to a CodeMirror editor by importing the bundle.
// Kept as a string constant so the HTML template stays a pure function.
const INLINE_BOOTSTRAP_JS = `
${NC_MOBILE_BRIDGE_JS}
const body = document.body
const token = body.dataset.token
const language = body.dataset.language
const readOnly = body.dataset.readonly === '1'
const bundleUrl = body.dataset.bundleUrl

const $ = (id) => document.getElementById(id)
const status = $('status')
const banner = $('banner')
const saveBtn = $('save-btn')
const closeBtn = $('close-btn')
const nameEl = $('name')
const fallback = $('fallback')
const cmHost = $('cm-host')

// Belt-and-suspenders: on very slow/loaded devices viewDidAppear can fire
// after the 700 ms server delay, meaning the initial didFinishNavigation fires
// before the spinner starts. history.pushState triggers a same-document
// didFinishNavigation on modern WKWebView (more reliably than hash assignment)
// and gives NCActivityIndicator.stop() a second chance. Two attempts cover a
// wide timing range without being intrusive to normal users.
let _psn = 0
const _ps = () => { try { history.pushState(null, '', location.pathname + location.search + '#_s' + (++_psn)) } catch {} }
setTimeout(_ps, 1200)
setTimeout(_ps, 2200)

// On iOS, the WKWebView frame shrinks when the keyboard appears but the
// CSS viewport may lag. visualViewport.height gives the actual visible
// height (keyboard excluded) and fires resize during the animation,
// keeping layout above the keyboard without waiting for UIKit.
function syncViewport() {
  document.documentElement.style.height = (window.visualViewport?.height ?? window.innerHeight) + 'px'
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport)
syncViewport()

// State shared across loaders. The active editor's read/write API is unified
// through this object so save logic doesn't care whether CodeMirror loaded.
const editor = {
  get value() { return fallback.value },
  set value(v) { fallback.value = v },
  setReadOnly(ro) { fallback.readOnly = ro },
  focus() { fallback.focus() },
  onChange(fn) { fallback.addEventListener('input', fn) }
}

let etag = null
let dirty = false
let saving = false

function setStatus(msg, kind) {
  status.textContent = msg || ''
  status.classList.toggle('err', kind === 'err')
}
function setDirty(d) {
  dirty = d
  nameEl.classList.toggle('dirty', d)
  saveBtn.disabled = !d || saving || readOnly
}

async function loadContent() {
  setStatus('Loading…')
  try {
    const r = await fetch(\`/custom-mobile-compat/text-editor/content?token=\${encodeURIComponent(token)}\`, {
      headers: { 'Accept': 'text/plain' }
    })
    if (!r.ok) throw new Error(\`HTTP \${r.status}\`)
    etag = r.headers.get('ETag')
    const text = await r.text()
    editor.value = text
    setStatus('Ready')
    setDirty(false)
    if (readOnly) {
      banner.classList.add('show')
      editor.setReadOnly(true)
      saveBtn.disabled = true
    }
  } catch (e) {
    setStatus('Failed to load: ' + e.message, 'err')
  }
}

async function save() {
  if (saving || !dirty || readOnly) return
  const content = editor.value
  // Guard: refuse to overwrite a previously-loaded file with empty content
  // without explicit confirmation. etag being set means we successfully
  // loaded content at least once. This catches silent WKWebView fetch-body
  // loss bugs before they reach the server.
  if (!content && etag && !confirm('Save empty file? This will erase all content.')) return
  saving = true
  saveBtn.disabled = true
  setStatus('Saving…')
  try {
    // Use Blob body so WKWebView sends a proper Content-Length header.
    // Passing a plain string can silently drop the body on some iOS/WebKit
    // versions when the WKWebView uses a non-persistent data store.
    const blob = new Blob([content], { type: 'text/plain; charset=utf-8' })
    const headers = etag ? { 'If-Match': etag } : {}
    const r = await fetch(\`/custom-mobile-compat/text-editor/content?token=\${encodeURIComponent(token)}\`, {
      method: 'PUT',
      headers,
      body: blob
    })
    if (r.status === 412) {
      setStatus('File changed on server — reload to merge', 'err')
      return
    }
    if (!r.ok) throw new Error(\`HTTP \${r.status}\`)
    etag = r.headers.get('ETag') || etag
    setStatus('Saved')
    setDirty(false)
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'err')
  } finally {
    saving = false
    if (dirty && !readOnly) saveBtn.disabled = false
  }
}

editor.onChange(() => setDirty(true))
saveBtn.addEventListener('click', save)
closeBtn.addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return
  // Both host shapes, plus a browser fallback — see nc-mobile-bridge.ts.
  __ncBridge.close()
})
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
})

// Try to upgrade to CodeMirror. Best-effort — failures fall back to textarea.
async function upgradeToCodeMirror() {
  try {
    const mod = await import(bundleUrl)
    if (typeof mod.mountCodeMirror !== 'function') return
    const initial = editor.value
    const cm = mod.mountCodeMirror(cmHost, { initial, language, readOnly })
    cmHost.hidden = false
    fallback.style.display = 'none'
    editor.value = initial // fallback retains for restore-on-failure
    Object.defineProperty(editor, 'value', { get: () => cm.getValue(), set: (v) => cm.setValue(v) })
    editor.setReadOnly = (ro) => cm.setReadOnly(ro)
    editor.focus = () => cm.focus()
    editor.onChange = (fn) => cm.onChange(fn)
    cm.onChange(() => setDirty(true))
    if (readOnly) cm.setReadOnly(true)
  } catch {
    // Bundle not present yet, or failed to load — silently keep textarea.
  }
}

await loadContent()
// Reveal the page. On stock NC Android the WebView is INVISIBLE until this
// call lands (EditorWebView.java::hideLoading), so it must run on the failure
// path too — loadContent() swallows its own errors into the status line, which
// the user can only read once the WebView is showing.
__ncBridge.loaded()
upgradeToCodeMirror() // fire-and-forget: don't block window load / iOS spinner
editor.focus()
`
