import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import fs from 'node:fs'
import path from 'node:path'
import { CONTENT_SECURITY_POLICY } from '../../app.constants'
import { DEFAULT_DIAGRAMS_EDITOR_URL, diagramsEditorOrigin, FilesDiagramsConfig } from './custom-diagrams.config'

function validate(plain: Record<string, unknown>) {
  return validateSync(plainToInstance(FilesDiagramsConfig, plain), { whitelist: false })
}

describe('FilesDiagramsConfig', () => {
  it('defaults to the public diagrams.net embed service', () => {
    expect(new FilesDiagramsConfig().editorUrl).toBe(DEFAULT_DIAGRAMS_EDITOR_URL)
    expect(DEFAULT_DIAGRAMS_EDITOR_URL).toBe('https://embed.diagrams.net')
  })

  it('accepts a self-hosted http(s) URL', () => {
    expect(validate({ editorUrl: 'https://drawio.internal/webapp' })).toHaveLength(0)
    expect(validate({ editorUrl: 'http://localhost:8081' })).toHaveLength(0)
  })

  it.each(['', '   ', 'embed.diagrams.net', 'javascript:alert(1)', 'ftp://host/x'])('refuses %s at boot rather than at render time', (value) => {
    // A bad value here would otherwise reach the CSP `frame-src`, block the
    // iframe, and surface only as a console CSP error (#499).
    expect(validate({ editorUrl: value }).length).toBeGreaterThan(0)
  })
})

describe('diagramsEditorOrigin', () => {
  it('reduces a URL to the origin the CSP needs', () => {
    expect(diagramsEditorOrigin('https://embed.diagrams.net')).toBe('https://embed.diagrams.net')
    expect(diagramsEditorOrigin('https://drawio.internal:8443/webapp/index.html')).toBe('https://drawio.internal:8443')
  })

  it('returns the raw value rather than throwing on junk', () => {
    expect(diagramsEditorOrigin('not a url')).toBe('not a url')
  })
})

describe('CSP frame-src', () => {
  it('frames the CONFIGURED editor, which is the whole point of having one constant', () => {
    // These two used to be computed independently from process.env in two
    // files; if they ever disagreed the iframe was blocked and the feature died
    // silently.
    const csp = CONTENT_SECURITY_POLICY('', '', 'https://drawio.internal/webapp')
    expect(csp.directives.frameSrc).toContain('https://drawio.internal')
    expect(csp.directives.frameSrc).not.toContain('https://embed.diagrams.net')
  })

  it('keeps self and drops the editors that are switched off', () => {
    const csp = CONTENT_SECURITY_POLICY('', '', DEFAULT_DIAGRAMS_EDITOR_URL)
    expect(csp.directives.frameSrc).toEqual(["'self'", 'https://embed.diagrams.net'])
  })
})

describe('environment.dist.yaml', () => {
  // config.loader validates every SYNCIN_* variable NAME against the dist file,
  // so a config path missing from it is discarded with a warning rather than an
  // error — the #384 failure class. A unit test is the cheapest place to notice.
  const dist = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'environment', 'environment.dist.yaml'), 'utf8')

  it('documents applications.files.diagrams.editorUrl', () => {
    expect(dist).toMatch(/^\s{4}diagrams:$/m)
    expect(dist).toMatch(/^\s{6}editorUrl: https:\/\/embed\.diagrams\.net$/m)
  })

  it('warns that the default hands diagram content to a third party', () => {
    const block = dist.slice(Math.max(0, dist.indexOf('    diagrams:') - 1400), dist.indexOf('    diagrams:'))
    expect(block).toMatch(/THIRD-PARTY/)
  })
})
