// Pure helpers for the drawio embed. They live outside the component because
// every one of them encodes a security or permission decision that has to be
// testable without a DOM (the v2 specs run in `environment: node`).

// Build the drawio embed URL.
//
// READ-ONLY. drawio's embed protocol has no `editable=0`; `chrome=0` is the
// documented way to mount the VIEWER instead of the editor, and it is what the
// diagrams.net "Embed > Viewer" snippet emits. Without it the canvas is fully
// editable no matter what the server said, and a user with read-only access
// could edit for twenty minutes and lose every change with no feedback (#497).
//
// `autosave=1` is dropped in the same breath: leaving it on would have drawio
// post save events we can only throw away, which is how the loss stayed silent.
export function buildEditorSrc(editorUrl: string, isWritable: boolean): string {
  const params = ['embed=1', 'spin=1', 'proto=json', ...(isWritable ? ['autosave=1'] : ['chrome=0']), 'keepmodified=1', 'dark=1']
  return `${editorUrl}?${params.join('&')}`
}

// ── Untrusted content coming back OUT of the editor ──────────────────────────
//
// Everything below guards the return leg of the export protocol. drawio hands
// back a payload over `postMessage` and the host feeds it to a same-origin sink
// — an anchor's `href`, and a document written into a popup we opened at
// `about:blank`, which INHERITS our origin and our CSP (and our CSP carries
// `'unsafe-inline'` in script-src). The attacker position is anyone who can put
// a `.drawio` file where the victim will open it: a share, a common space, an
// upload (#498).

// Media types a drawio export may legitimately carry. `text/html` is absent on
// purpose, and so is everything not on the list: an anchor click on a
// `javascript:` href runs in our origin.
const EXPORT_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/vnd.jgraph.mxfile',
  'text/plain',
  'text/xml',
  'application/xml'
])

// True only for a `data:` URL whose media type is one we expect an export to
// produce. A bare `data:,…` (no media type) defaults to text/plain per RFC 2397
// and is accepted; anything with a scheme other than `data:` is not.
export function isAllowedExportDataUrl(value: string): boolean {
  const match = /^data:([^;,]*)[;,]/.exec(value.trim())
  if (!match) return false
  const mediaType = match[1].trim().toLowerCase()
  return mediaType === '' || EXPORT_MEDIA_TYPES.has(mediaType)
}

// Elements that can execute, navigate or embed. Note that `foreignObject` is
// NOT here: drawio renders HTML labels through it, so dropping it would print
// diagrams with blank labels. Its subtree is sanitised like any other instead —
// the dangerous part was never the element, it was what can live inside it.
// `animate`/`set` are here because SMIL can retarget an attribute at run time
// (`<set attributeName="href" to="javascript:…">`), which would walk straight
// past an attribute-value check made once at sanitise time. drawio exports do
// not animate, so nothing is lost.
const FORBIDDEN_SVG_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'handler',
  'animate',
  'animatetransform',
  'animatemotion',
  'set'
])

export function isForbiddenSvgElement(localName: string): boolean {
  return FORBIDDEN_SVG_ELEMENTS.has(localName.toLowerCase())
}

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction', 'data', 'poster'])
const UNSAFE_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i

export function isForbiddenSvgAttribute(name: string, value: string): boolean {
  const attr = name.toLowerCase()
  // Every `on*` handler, including the ones a sanitiser that only knows
  // `onclick`/`onload` would miss (`onerror` on an `<img>` inside a label was
  // the payload shape the report named).
  if (attr.startsWith('on')) return true
  if (URL_ATTRIBUTES.has(attr) && UNSAFE_URL.test(value)) return true
  return false
}

// A per-print random nonce. It is what lets the print document keep its own
// small script while forbidding every other one — see buildPrintDocument.
export function printNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// raw-colour-ok: the two documents below are separate PRINT documents, not app
// DOM. They must not inherit the app theme — a diagram printed on a dark ground
// wastes ink and loses stroke contrast on paper.
export function buildPrintPlaceholderDocument(): string {
  return '<!doctype html><meta charset="utf-8"><title>Print</title><body style="margin:0;font:14px/1.4 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;color:#666">Preparing print preview…</body>'
}

// The print document.
//
// The meta CSP is the load-bearing line. The popup is `about:blank`, so it
// inherits our origin AND our header CSP, which allows inline script. A second
// policy delivered in the document intersects with the first, and a policy that
// names a nonce allows only scripts carrying it — so the print harness below
// runs and any script that rode in on the SVG does not, whatever the SVG
// sanitiser missed. `object-src 'none'` closes the plugin route the same way.
// Nothing else is constrained: images, styles and fonts are left alone so the
// printed page still looks like the diagram.
export function buildPrintDocument(title: string, svg: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'; object-src 'none'">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
  svg { max-width: 100%; max-height: 100vh; height: auto; width: auto; }
  @media print {
    body { min-height: auto; }
    svg { max-height: none; }
  }
</style></head><body>${svg}<script nonce="${nonce}">
  window.addEventListener('load', function () {
    requestAnimationFrame(function () { requestAnimationFrame(function () { window.focus(); window.print(); }); });
  });
  window.addEventListener('afterprint', function () { window.close(); });
</script></body></html>`
}
