import { renderMarkdownEditorPage } from './markdown-editor-page'
import { renderEditorErrorPageHtml } from './nc-editor-error-page'
import { NC_MOBILE_BRIDGE_JS } from './nc-mobile-bridge'
import { renderTextEditorPage } from './text-editor-page'

// Evaluate the bridge source in a scratch global and hand back the fake host
// channels it talked to. The snippet is plain ES2020 and touches only `window`,
// `history` and `webkit`, so a tiny stub object is enough — no jsdom.
function evalBridge(host: { android?: boolean; ios?: boolean }): {
  bridge: { loaded: () => boolean; close: () => boolean | void }
  androidCalls: string[]
  iosMessages: unknown[]
  navigated: string[]
} {
  const androidCalls: string[] = []
  const iosMessages: unknown[] = []
  const navigated: string[] = []

  const win: Record<string, unknown> = {
    history: { length: 2, back: () => navigated.push('back') },
    close: () => navigated.push('window.close')
  }
  if (host.android) {
    win.DirectEditingMobileInterface = {
      close: () => androidCalls.push('close'),
      loaded: () => androidCalls.push('loaded'),
      share: () => androidCalls.push('share'),
      reload: () => androidCalls.push('reload')
    }
  }
  if (host.ios) {
    win.webkit = { messageHandlers: { DirectEditingMobileInterface: { postMessage: (m: unknown) => iosMessages.push(m) } } }
  }
  // `window` must resolve to the same object the snippet assigns onto.
  win.window = win

  const run = new Function('window', 'history', `${NC_MOBILE_BRIDGE_JS}\nreturn window.__ncBridge`)
  const bridge = run(win, win.history)
  return { bridge, androidCalls, iosMessages, navigated }
}

describe('NC_MOBILE_BRIDGE_JS', () => {
  it('calls the Android @JavascriptInterface method by name', () => {
    // EditorWebView.java::MobileInterface exposes close/share/loaded/reload as
    // methods on an injected object — not a postMessage channel.
    const { bridge, androidCalls } = evalBridge({ android: true })
    bridge.loaded()
    bridge.close()
    expect(androidCalls).toEqual(['loaded', 'close'])
  })

  it('posts the bare message string for iOS', () => {
    // NCViewerDirectEditing.swift compares `message.body as? String == "close"`,
    // so the payload must be the plain string and not an object.
    const { bridge, iosMessages } = evalBridge({ ios: true })
    bridge.loaded()
    bridge.close()
    expect(iosMessages).toEqual(['loaded', 'close'])
  })

  it('delivers to BOTH channels when both are present, like upstream does', () => {
    // ONLYOFFICE/onlyoffice-nextcloud src/directeditor.js::callMobileMessage
    // sends to the object form and the webkit form unconditionally rather than
    // sniffing the platform. Sending to an absent channel is a no-op.
    const { bridge, androidCalls, iosMessages } = evalBridge({ android: true, ios: true })
    bridge.loaded()
    expect(androidCalls).toEqual(['loaded'])
    expect(iosMessages).toEqual(['loaded'])
  })

  it('falls back to browser navigation on close when no host channel exists', () => {
    // A developer opening the URL in a desktop browser must still be able to
    // leave the page.
    const { bridge, navigated } = evalBridge({})
    bridge.close()
    expect(navigated).toEqual(['back'])
  })

  it('does not navigate away when a host handled the close', () => {
    const { bridge, navigated } = evalBridge({ android: true })
    bridge.close()
    expect(navigated).toEqual([])
  })
})

describe('editor pages speak the bridge', () => {
  const pages: [string, string][] = [
    ['text', renderTextEditorPage({ token: 't', fileName: 'a.txt', language: 'text' })],
    ['markdown', renderMarkdownEditorPage({ token: 't', fileName: 'a.md' })],
    ['error', renderEditorErrorPageHtml('nope')]
  ]

  for (const [name, html] of pages) {
    // The regression: every page shipped only the iOS webkit form, so on stock
    // NC Android the WebView stayed invisible (hideLoading is reachable from the
    // loaded() bridge and nowhere else) and Close did nothing.
    it(`${name} page embeds the bridge and announces itself loaded`, () => {
      expect(html).toContain('window.__ncBridge')
      expect(html).toContain('__ncBridge.loaded()')
    })

    it(`${name} page routes close through the bridge, not a hand-rolled webkit call`, () => {
      expect(html).toContain('__ncBridge.close()')
      expect(html).not.toContain('messageHandlers.DirectEditingMobileInterface.postMessage')
    })
  }
})
