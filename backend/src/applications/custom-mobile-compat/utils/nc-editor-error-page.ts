import { escapeHtml } from './nc-html'
import { NC_MOBILE_BRIDGE_JS } from './nc-mobile-bridge'

// The failure page for every direct-editing surface (text, markdown, office).
//
// Served with HTTP 200 deliberately: WKWebView renders its own useless blank
// error page on a non-200, so the only way to show the user a readable reason is
// to succeed at the HTTP level and put the reason in the body.
//
// It calls the `loaded` bridge on load for the same reason the editors do — on
// stock NC Android the WebView stays INVISIBLE until that message arrives, so an
// error page that skips it is indistinguishable from a hang. The Close button is
// the only way out of a page that has no editor to close itself.
//
// The message is deliberately vague about *why* a token failed (expired vs
// malformed vs file-not-found are all conflated by the callers).
export function renderEditorErrorPageHtml(message: string): string {
  const safe = escapeHtml(message)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Editor</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .card { max-width: 360px; text-align: center; }
  .card h1 { font-size: 17px; margin: 0 0 8px; }
  .card p { margin: 0 0 20px; opacity: 0.8; }
  .card button { padding: 9px 18px; font: inherit; font-size: 14px; border-radius: 6px;
    border: 1px solid currentColor; background: transparent; color: inherit; }
</style></head>
<body><div class="card"><h1>Cannot open editor</h1><p>${safe}</p>
<button id="close-btn" type="button">Close</button></div>
<script>
${NC_MOBILE_BRIDGE_JS}
document.getElementById('close-btn').addEventListener('click', () => __ncBridge.close())
__ncBridge.loaded()
</script>
</body></html>`
}
