// HTML page for the in-app markdown editor served at
// /custom-mobile-compat/text-editor?token=… when the file's language is
// `markdown`. Sibling of text-editor-page.ts (CodeMirror) — the controller
// dispatches based on the inferred language so non-markdown files stay on
// the CodeMirror page.
//
// Self-contained: inline CSS, inline JS that fetches /content and PUTs it
// back. TipTap is dynamic-imported from
// /custom-mobile-compat/text-editor/tiptap.bundle.js with a textarea
// fallback in case the bundle fails to load.
//
// Token-only auth — same as text-editor-page.ts. WKWebView does not share
// the OCS Basic Auth header, so every /content fetch carries ?token=<jwt>.

import { escapeHtml } from './nc-html'
import { NC_MOBILE_BRIDGE_JS } from './nc-mobile-bridge'

export interface MarkdownEditorPageOptions {
  token: string
  fileName: string
  readOnly?: boolean
  readOnlyReason?: string
}

export function renderMarkdownEditorPage(opts: MarkdownEditorPageOptions): string {
  const safeName = escapeHtml(opts.fileName)
  const safeToken = escapeHtml(opts.token)
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
    --tool-bg-hover: rgba(0,0,0,0.05); --tool-bg-active: rgba(0,0,0,0.09);
    --code-bg: rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --fg: #e5e7eb; --muted: #94a3b8; --border: #334155;
      --accent: #38bdf8; --accent-fg: #0b1220; --err: #f87171; --warn-bg: #422006;
      --toolbar-bg: #1e293b; --toolbar-shadow: rgba(0,0,0,0.3);
      --tool-bg-hover: rgba(255,255,255,0.07); --tool-bg-active: rgba(255,255,255,0.13);
      --code-bg: rgba(255,255,255,0.08);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar {
    display: flex; align-items: center; gap: 6px; padding: 8px 12px;
    padding-top: max(8px, env(safe-area-inset-top));
    background: var(--toolbar-bg); border-bottom: 1px solid var(--border);
    box-shadow: 0 1px 0 var(--toolbar-shadow);
    flex-shrink: 0; flex-wrap: wrap; row-gap: 6px;
  }
  .name { flex: 1 1 auto; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 100px; }
  .name .dot { display: none; color: var(--accent); margin-right: 4px; }
  .name.dirty .dot { display: inline; }
  .btn { padding: 7px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .status { font-size: 12px; color: var(--muted); margin-left: 8px; }
  .status.err { color: var(--err); }
  .format-bar {
    display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap;
  }
  .format-bar.hidden { display: none; }
  .tool {
    appearance: none; background: transparent; border: none; border-radius: 6px;
    color: var(--muted); cursor: pointer; font: inherit; height: 30px; min-width: 32px;
    padding: 0 6px; font-size: 13px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 120ms ease, color 120ms ease;
  }
  .tool:hover { background: var(--tool-bg-hover); color: var(--fg); }
  .tool.active { background: var(--tool-bg-active); color: var(--fg); }
  .tool.bold { font-weight: 700; }
  .tool.italic { font-style: italic; }
  .tool.strike { text-decoration: line-through; }
  .tool.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
  .banner {
    background: var(--warn-bg); color: var(--fg); padding: 8px 12px;
    font-size: 13px; border-bottom: 1px solid var(--border); display: none;
  }
  .banner.show { display: block; }
  .editor-host { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  textarea.fallback {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; outline: 0; resize: none; padding: 12px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    background: var(--bg); color: var(--fg); white-space: pre; tab-size: 2;
  }
  .tt-host { position: absolute; inset: 0; overflow: auto; padding: 16px 18px 48px; }
  .tt-host .ProseMirror {
    outline: none; min-height: 100%; font-size: 16px; line-height: 1.6;
  }
  .tt-host .ProseMirror h1 { font-size: 1.7em; font-weight: 700; margin: 0.7em 0 0.3em; }
  .tt-host .ProseMirror h2 { font-size: 1.4em; font-weight: 700; margin: 0.7em 0 0.3em; }
  .tt-host .ProseMirror h3 { font-size: 1.2em; font-weight: 600; margin: 0.6em 0 0.3em; }
  .tt-host .ProseMirror p { margin: 0.5em 0; }
  .tt-host .ProseMirror ul, .tt-host .ProseMirror ol { padding-left: 1.4em; margin: 0.5em 0; }
  .tt-host .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
  .tt-host .ProseMirror ul[data-type="taskList"] li { display: flex; gap: 0.4em; align-items: flex-start; }
  .tt-host .ProseMirror ul[data-type="taskList"] li > label { flex-shrink: 0; margin-top: 0.2em; }
  .tt-host .ProseMirror blockquote { margin: 0.5em 0; padding-left: 1em; border-left: 3px solid var(--border); color: var(--muted); }
  .tt-host .ProseMirror code { background: var(--code-bg); padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  .tt-host .ProseMirror pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow: auto; }
  .tt-host .ProseMirror pre code { background: none; padding: 0; }
  .tt-host .ProseMirror a { color: var(--accent); text-decoration: underline; }
  .tt-host .ProseMirror table { border-collapse: collapse; margin: 0.6em 0; width: 100%; }
  .tt-host .ProseMirror th, .tt-host .ProseMirror td { border: 1px solid var(--border); padding: 6px 8px; }
  .tt-host .ProseMirror img { max-width: 100%; height: auto; }
</style>
</head>
<body
  data-token="${safeToken}"
  data-readonly="${readOnly ? '1' : '0'}"
  data-bundle-url="/custom-mobile-compat/text-editor/tiptap.bundle.js"
>
  <div class="toolbar">
    <span class="name" id="name"><span class="dot">&bull;</span><span id="name-text">${safeName}</span></span>
    <nav class="format-bar hidden" id="format-bar" role="toolbar" aria-label="Formatting">
      <button type="button" class="tool" data-cmd="h1" title="Heading 1">H1</button>
      <button type="button" class="tool" data-cmd="h2" title="Heading 2">H2</button>
      <button type="button" class="tool" data-cmd="h3" title="Heading 3">H3</button>
      <span class="sep"></span>
      <button type="button" class="tool bold" data-cmd="bold" title="Bold">B</button>
      <button type="button" class="tool italic" data-cmd="italic" title="Italic">I</button>
      <button type="button" class="tool strike" data-cmd="strike" title="Strikethrough">S</button>
      <button type="button" class="tool mono" data-cmd="code" title="Inline code">&lt;/&gt;</button>
      <span class="sep"></span>
      <button type="button" class="tool" data-cmd="bullet" title="Bulleted list">&bull;</button>
      <button type="button" class="tool" data-cmd="ordered" title="Numbered list">1.</button>
      <button type="button" class="tool" data-cmd="task" title="Task list">&#9744;</button>
      <span class="sep"></span>
      <button type="button" class="tool" data-cmd="quote" title="Blockquote">&laquo;</button>
      <button type="button" class="tool mono" data-cmd="codeblock" title="Code block">&#123;&#125;</button>
      <button type="button" class="tool" data-cmd="link" title="Link">&#128279;</button>
    </nav>
    <span class="status" id="status">Loading…</span>
    <button class="btn" id="close-btn" type="button">Close</button>
    <button class="btn primary" id="save-btn" type="button" disabled>Save</button>
  </div>
  <div class="banner" id="banner">${safeReason}</div>
  <div class="editor-host">
    <div class="tt-host" id="tt-host" hidden></div>
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

// Inline bootstrap — load content, wire save/close, upgrade textarea to
// TipTap. Mirrors the codemirror page's flow so the only diff between the
// two is the editor module and the toolbar UI.
const INLINE_BOOTSTRAP_JS = `
${NC_MOBILE_BRIDGE_JS}
const body = document.body
const token = body.dataset.token
const readOnly = body.dataset.readonly === '1'
const bundleUrl = body.dataset.bundleUrl

const $ = (id) => document.getElementById(id)
const status = $('status')
const banner = $('banner')
const saveBtn = $('save-btn')
const closeBtn = $('close-btn')
const nameEl = $('name')
const fallback = $('fallback')
const ttHost = $('tt-host')
const formatBar = $('format-bar')

let _psn = 0
const _ps = () => { try { history.pushState(null, '', location.pathname + location.search + '#_s' + (++_psn)) } catch {} }
setTimeout(_ps, 1200)
setTimeout(_ps, 2200)

function syncViewport() {
  document.documentElement.style.height = (window.visualViewport?.height ?? window.innerHeight) + 'px'
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport)
syncViewport()

// Unified editor handle. Starts pointing at the textarea fallback; gets
// reassigned to a TipTap-backed adapter once the bundle loads.
const editor = {
  get value() { return fallback.value },
  set value(v) { fallback.value = v },
  setReadOnly(ro) { fallback.readOnly = ro },
  focus() { fallback.focus() },
  onChange(fn) { fallback.addEventListener('input', fn) },
  isActive() { return false },
  exec() { /* no-op until TipTap mounts */ }
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
  if (!content && etag && !confirm('Save empty file? This will erase all content.')) return
  saving = true
  saveBtn.disabled = true
  setStatus('Saving…')
  try {
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

// Upgrade textarea → TipTap. Best-effort; on failure the textarea remains
// active so the user can still edit raw markdown.
async function upgradeToTipTap() {
  try {
    const mod = await import(bundleUrl)
    const mountTipTap = mod.mountTipTap || (window.NcMarkdownEditor && window.NcMarkdownEditor.mountTipTap)
    if (typeof mountTipTap !== 'function') return
    const initial = editor.value
    const tt = mountTipTap(ttHost, { initial, readOnly })
    ttHost.hidden = false
    fallback.style.display = 'none'

    // Re-point the editor handle at the TipTap-backed implementation.
    Object.defineProperty(editor, 'value', { get: () => tt.getValue(), set: (v) => tt.setValue(v) })
    editor.setReadOnly = (ro) => tt.setReadOnly(ro)
    editor.focus = () => tt.focus()
    editor.onChange = (fn) => tt.onChange(fn)
    editor.isActive = (name, attrs) => tt.isActive(name, attrs)
    editor.exec = (cmd) => runCommand(tt, cmd)
    tt.onChange(() => setDirty(true))
    tt.onSelectionChange(() => refreshFormatBar(tt))
    if (readOnly) tt.setReadOnly(true)

    formatBar.classList.remove('hidden')
    refreshFormatBar(tt)
    formatBar.addEventListener('click', (e) => {
      const target = e.target
      if (!target || target.tagName !== 'BUTTON') return
      const cmd = target.dataset.cmd
      if (!cmd) return
      runCommand(tt, cmd)
      refreshFormatBar(tt)
    }, { passive: true })
  } catch (e) {
    console.warn('TipTap upgrade failed; using textarea fallback', e)
  }
}

function runCommand(tt, cmd) {
  if (readOnly) return
  const ed = tt.editor
  const chain = ed.chain().focus()
  switch (cmd) {
    case 'h1': chain.toggleHeading({ level: 1 }).run(); break
    case 'h2': chain.toggleHeading({ level: 2 }).run(); break
    case 'h3': chain.toggleHeading({ level: 3 }).run(); break
    case 'bold': chain.toggleBold().run(); break
    case 'italic': chain.toggleItalic().run(); break
    case 'strike': chain.toggleStrike().run(); break
    case 'code': chain.toggleCode().run(); break
    case 'bullet': chain.toggleBulletList().run(); break
    case 'ordered': chain.toggleOrderedList().run(); break
    case 'task': chain.toggleTaskList().run(); break
    case 'quote': chain.toggleBlockquote().run(); break
    case 'codeblock': chain.toggleCodeBlock().run(); break
    case 'link': {
      const prev = ed.getAttributes('link').href
      const url = window.prompt('URL', prev || 'https://')
      if (url === null) return
      const linkChain = ed.chain().focus().extendMarkRange('link')
      if (!url.trim()) linkChain.unsetLink().run()
      else linkChain.setLink({ href: url.trim() }).run()
      break
    }
  }
}

function refreshFormatBar(tt) {
  const items = [
    ['h1', 'heading', { level: 1 }],
    ['h2', 'heading', { level: 2 }],
    ['h3', 'heading', { level: 3 }],
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['strike', 'strike'],
    ['code', 'code'],
    ['bullet', 'bulletList'],
    ['ordered', 'orderedList'],
    ['task', 'taskList'],
    ['quote', 'blockquote'],
    ['codeblock', 'codeBlock'],
    ['link', 'link']
  ]
  for (const [data, name, attrs] of items) {
    const btn = formatBar.querySelector('[data-cmd="' + data + '"]')
    if (!btn) continue
    const active = attrs ? tt.isActive(name, attrs) : tt.isActive(name)
    btn.classList.toggle('active', !!active)
  }
}

await loadContent()
// Reveal the page. On stock NC Android the WebView is INVISIBLE until this
// call lands (EditorWebView.java::hideLoading), so it must run on the failure
// path too — loadContent() swallows its own errors into the status line, which
// the user can only read once the WebView is showing.
__ncBridge.loaded()
await upgradeToTipTap()
`
