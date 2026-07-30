// The JS bridge every direct-editing page must speak to the host app.
//
// Both stock NC clients inject a channel named `DirectEditingMobileInterface`,
// but they inject DIFFERENT SHAPES, and a page that only knows one of them is
// broken on the other platform:
//
//   - Android (EditorWebView.java::MobileInterface) adds a @JavascriptInterface
//     OBJECT with methods close(), share(), loaded(), reload(). Call them
//     directly: `window.DirectEditingMobileInterface.loaded()`.
//   - iOS (NCViewerDirectEditing.swift) registers a WKScriptMessageHandler and
//     compares `message.body as? String`. Call
//     `window.webkit.messageHandlers.DirectEditingMobileInterface.postMessage('loaded')`.
//
// `loaded` is NOT cosmetic on Android. EditorWebView keeps the WebView at
// View.INVISIBLE behind a thumbnail + progress bar and only reveals it from
// hideLoading(), which is reachable from the loaded() bridge call and nowhere
// else (EditorWebView.java:60-69). Ten seconds later it raises an indefinite
// "timed out" snackbar. So a page that never calls `loaded` is a permanently
// blank screen on stock NC Android, no matter how well it rendered.
//
// Upstream calls BOTH shapes unconditionally rather than branching — see
// ONLYOFFICE/onlyoffice-nextcloud src/directeditor.js::callMobileMessage, which
// is the model for this file. Sending to a channel the host did not inject is a
// no-op, so trying both is strictly safer than guessing the platform from the
// user agent.

// Emitted inside the page's inline <script>. Defines `window.__ncBridge` with
// the two messages our editors need. Kept as a source string (not a module) so
// the pages stay single-request, CDN-free documents.
export const NC_MOBILE_BRIDGE_JS = `
window.__ncBridge = (() => {
  const send = (name) => {
    let delivered = false
    // Android: injected object with one method per message name.
    const iface = window.DirectEditingMobileInterface
    if (iface && typeof iface[name] === 'function') {
      try { iface[name](); delivered = true } catch {}
    }
    // iOS: script message handler comparing the body against the bare string.
    const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.DirectEditingMobileInterface
    if (wk) {
      try { wk.postMessage(name); delivered = true } catch {}
    }
    return delivered
  }
  return {
    // Reveals the WebView on Android; stops the spinner on iOS. Safe to call
    // more than once — both hosts treat it as idempotent.
    loaded: () => send('loaded'),
    // Dismisses the editor. Falls back to normal browser navigation when the
    // page is open outside a host app (developer hitting the URL directly).
    close: () => {
      if (send('close')) return
      if (history.length > 1) { history.back() } else { window.close() }
    }
  }
})()
`
