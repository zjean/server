// HTML page for the in-app office editor served at
// /custom-mobile-compat/office-editor?token=…
//
// This is the mobile equivalent of what the v2 web UI does in
// OnlyOfficeComponent: load the document server's api.js, then hand it the
// config OnlyOfficeManager produced. The page is deliberately thin — it owns no
// save path, no lock handling and no versioning. All of that already happens
// through the callbackUrl inside the config, which points at Sync-in's own
// OnlyOffice callback route, so a mobile save takes exactly the same path (and
// the same version snapshot) as a save from the browser.
//
// Upstream's equivalent is ONLYOFFICE/onlyoffice-nextcloud's DirectEditor::open,
// which renders the SAME editor template it uses in the browser and widens the
// CSP for the document server's origin. This page is that idea, minus the parts
// of the template that only make sense inside Nextcloud's own chrome.
//
// Everything the host app needs is in nc-mobile-bridge.ts; read the comment
// there before touching the __ncBridge calls below.

import { escapeHtml } from './nc-html'
import { NC_MOBILE_BRIDGE_JS } from './nc-mobile-bridge'

export interface OfficeEditorPageOptions {
  // Absolute base URL of the document server, exactly as OnlyOfficeManager
  // resolved it (an external server, or our own origin + the nginx proxy path).
  documentServerUrl: string
  // The signed OnlyOffice config. Passed through untouched — it carries the
  // payload token, and re-signing it anywhere but OnlyOfficeManager would put a
  // second signing site in the fork.
  config: unknown
  fileName: string
}

// JSON destined for a <script> block. Escaping every '<' keeps a filename
// containing a closing script tag from ending the block early; the escape is
// legal JSON and parses back to '<', so the value the page reads is unchanged.
// U+2028 / U+2029 are line terminators to a JS parser but legal raw inside a
// JSON string, which matters because the block is read via textContent.
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// The CSP source that lets api.js load and the editor iframe render.
//
// Upstream widens exactly these two directives and no others: the parent page
// only loads api.js and hosts an iframe, and every request the editor itself
// makes happens inside that iframe, under the document server's own origin and
// CSP. Returns '' when the document server is a path on our own origin (the
// nginx proxy deployment), which 'self' already covers.
export function documentServerCspSource(documentServerUrl: string): string {
  try {
    return new URL(documentServerUrl).origin
  } catch {
    return ''
  }
}

export function officeEditorCsp(documentServerUrl: string): string {
  const ds = documentServerCspSource(documentServerUrl)
  const extra = ds ? ` ${ds}` : ''
  return ["default-src 'self'", `script-src 'self' 'unsafe-inline'${extra}`, "style-src 'self' 'unsafe-inline'", `frame-src 'self'${extra}`].join(
    '; '
  )
}

export function renderOfficeEditorPage(opts: OfficeEditorPageOptions): string {
  const apiBase = opts.documentServerUrl.endsWith('/') ? opts.documentServerUrl : `${opts.documentServerUrl}/`
  // Same path the web components use (only-office.component.ts:29).
  const apiJsUrl = escapeHtml(`${apiBase}web-apps/apps/api/documents/api.js`)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(opts.fileName)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  /* NCViewerDirectEditing sets scrollView.isScrollEnabled = false, so the page
     must never rely on the host scrolling it — the editor iframe scrolls its own
     content. */
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #office-editor { position: absolute; inset: 0; }
  .placeholder {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center; font-size: 15px; line-height: 1.5; opacity: 0.7;
  }
  .placeholder.err { opacity: 1; }
</style>
</head>
<body>
  <div class="placeholder" id="placeholder">Opening document…</div>
  <div id="office-editor"></div>
<script type="application/json" id="oo-config">${embedJson(opts.config)}</script>
<script src="${apiJsUrl}"></script>
<script>
${NC_MOBILE_BRIDGE_JS}
${INLINE_BOOTSTRAP_JS}
</script>
</body>
</html>`
}

const INLINE_BOOTSTRAP_JS = `
const placeholder = document.getElementById('placeholder')

function fail(message) {
  placeholder.textContent = message
  placeholder.classList.add('err')
  // Reveal whatever we managed to render — on stock NC Android nothing is
  // visible at all until this lands.
  __ncBridge.loaded()
}

// Belt-and-suspenders for the iOS spinner, same as the text editor page:
// NCActivityIndicator starts in viewDidAppear (after the push animation) and
// stops in didFinishNavigation, so a page that finishes loading first leaves the
// spinner up forever. A same-document pushState gives stop() another chance.
let _psn = 0
const _ps = () => { try { history.pushState(null, '', location.pathname + location.search + '#_s' + (++_psn)) } catch {} }
setTimeout(_ps, 1200)
setTimeout(_ps, 2200)

if (typeof DocsAPI === 'undefined') {
  fail('The document server could not be reached. Try again later.')
} else {
  let config = null
  try {
    config = JSON.parse(document.getElementById('oo-config').textContent)
  } catch (e) {
    config = null
  }
  if (!config) {
    fail('This document could not be opened.')
  } else {
    config.events = {
      // Both fire once the editor is usable. Revealing on either is safe — the
      // bridge's loaded() is idempotent on both hosts.
      onAppReady: () => __ncBridge.loaded(),
      onDocumentReady: () => { placeholder.remove(); __ncBridge.loaded() },
      // Setting this handler is ALSO what makes the document server render its
      // close control — the same mechanism by which onRequestHistory gates the
      // history panel. Without it the editor has no in-document way back.
      onRequestClose: () => __ncBridge.close(),
      onError: (e) => fail('The editor reported an error' + (e && e.data ? ' (' + e.data + ')' : '') + '.')
    }
    try {
      new DocsAPI.DocEditor('office-editor', config)
      // Reveal immediately rather than waiting for onAppReady. The document
      // server can take several seconds, and on Android the alternative to
      // showing our placeholder is a blank screen and then a timeout snackbar.
      __ncBridge.loaded()
    } catch (e) {
      fail('The editor could not be started.')
    }
  }
}
`
