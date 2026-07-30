import { documentServerCspSource, officeEditorCsp, renderOfficeEditorPage } from './office-editor-page'

const config = { documentType: 'word', token: 'signed.payload.token', document: { title: 'Report.docx', key: 'k', url: 'https://sync-in.test/doc' } }

describe('renderOfficeEditorPage', () => {
  const html = renderOfficeEditorPage({ documentServerUrl: 'https://ds.example.test', config, fileName: 'Report.docx' })

  it('loads api.js from the document server, at the path the web components use', () => {
    expect(html).toContain('<script src="https://ds.example.test/web-apps/apps/api/documents/api.js"></script>')
  })

  it('tolerates a document server url that already ends in a slash', () => {
    const withSlash = renderOfficeEditorPage({ documentServerUrl: 'https://ds.example.test/', config, fileName: 'a.docx' })
    expect(withSlash).toContain('https://ds.example.test/web-apps/apps/api/documents/api.js')
    expect(withSlash).not.toContain('//web-apps')
  })

  it('hands the config through untouched, so the payload signature stays valid', () => {
    const embedded = html.match(/<script type="application\/json" id="oo-config">(.*?)<\/script>/s)
    expect(embedded).not.toBeNull()
    expect(JSON.parse(embedded![1])).toEqual(config)
  })

  it('cannot be broken out of by a filename containing a closing script tag', () => {
    // The document title reaches both the JSON block and the <title> element, and
    // both are attacker-influenced: a filename is user input.
    const nasty = '</script><script>alert(1)</script>.docx'
    const page = renderOfficeEditorPage({
      documentServerUrl: 'https://ds.example.test',
      config: { document: { title: nasty } },
      fileName: nasty
    })
    // Exactly the tags we emit ourselves — no injected extras.
    expect(page.match(/<script/g)).toHaveLength(3)
    // The payload survives only as inert escaped text, never as markup.
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    const embedded = page.match(/<script type="application\/json" id="oo-config">(.*?)<\/script>/s)!
    // …and the value still parses back to the original string.
    expect(JSON.parse(embedded[1]).document.title).toBe(nasty)
  })

  it('does not mangle ordinary spaces in the config', () => {
    // Regression: the U+2028/U+2029 guards were once written with literal spaces
    // in the pattern, which rewrote every space in the config — corrupting user
    // names and document titles.
    const page = renderOfficeEditorPage({
      documentServerUrl: 'https://ds.example.test',
      config: { editorConfig: { user: { name: 'Alice Example (alice@example.test)' } } },
      fileName: 'a.docx'
    })
    const embedded = page.match(/<script type="application\/json" id="oo-config">(.*?)<\/script>/s)!
    expect(JSON.parse(embedded[1]).editorConfig.user.name).toBe('Alice Example (alice@example.test)')
  })

  it('wires the bridge and the close event the document server gates its button on', () => {
    // Setting onRequestClose is what makes the document server render a close
    // control at all; without it the editor has no in-document way back to the
    // app. The bridge's loaded() is what reveals the WebView on Android.
    expect(html).toContain('onRequestClose')
    expect(html).toContain('__ncBridge.close()')
    expect(html).toContain('__ncBridge.loaded()')
  })

  it('reveals the page even when the document server never answers', () => {
    // On Android the WebView is invisible until loaded() lands, so the
    // DocsAPI-missing branch has to announce itself too or the failure is
    // indistinguishable from a hang.
    expect(html).toContain("typeof DocsAPI === 'undefined'")
    expect(html).toMatch(/function fail\(message\)[\s\S]*__ncBridge\.loaded\(\)/)
  })

  it('never relies on the host scrolling the page', () => {
    // NCViewerDirectEditing sets scrollView.isScrollEnabled = false.
    expect(html).toContain('overflow: hidden')
  })
})

describe('officeEditorCsp', () => {
  it('allows the document server as a script and frame source', () => {
    // Upstream's DirectEditor::open widens exactly these two directives:
    // addAllowedScriptDomain + addAllowedFrameDomain.
    const csp = officeEditorCsp('https://ds.example.test')
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://ds.example.test")
    expect(csp).toContain("frame-src 'self' https://ds.example.test")
  })

  it('carries only the origin, not the path', () => {
    expect(officeEditorCsp('https://ds.example.test/some/prefix/')).toContain('https://ds.example.test;')
    expect(officeEditorCsp('https://ds.example.test/some/prefix/')).not.toContain('/some/prefix')
  })

  it("adds nothing for a same-origin proxy path, which 'self' already covers", () => {
    // The no-externalServer deployment: OnlyOfficeManager returns
    // `${origin}/onlyoffice`, and an origin-relative value has no URL to parse.
    expect(documentServerCspSource('/onlyoffice')).toBe('')
    const csp = officeEditorCsp('/onlyoffice')
    expect(csp).toContain("script-src 'self' 'unsafe-inline';")
    expect(csp).toContain("frame-src 'self'")
  })

  it('keeps default-src locked to self', () => {
    expect(officeEditorCsp('https://ds.example.test')).toMatch(/^default-src 'self';/)
  })
})
