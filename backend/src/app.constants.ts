import { diagramsEditorOrigin } from './applications/custom-diagrams/custom-diagrams.config'
import { loadVersion } from './app.functions'

export const VERSION = loadVersion()
export const USER_AGENT = `sync-in-server/${VERSION}`

// `diagramsEditorUrl` is the CONFIGURED value (applications.files.diagrams.editorUrl),
// passed in by the caller rather than re-read here. Both of this value's readers
// used to compute it independently from `process.env['DRAWIO_URL']`, and if the
// two copies had ever drifted `frame-src` would have blocked the iframe and the
// diagram editor would have died with a console-only CSP error (#499).
export const CONTENT_SECURITY_POLICY = (xOfficeServer: string, collaboraServer: string, diagramsEditorUrl: string) => ({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'", xOfficeServer || '', collaboraServer || ''],
    // 'wasm-unsafe-eval' lets PDF.js v6 instantiate its QuickJS scripting sandbox and
    // WASM image decoders. This backend CSP is sent as an HTTP header on every response
    // (incl. the static pdfjs viewer.html), where it intersects the viewer's own meta CSP
    // — without this token the intersection blocks the WASM and setDocument() aborts.
    // It is WASM-only (does not permit eval()); narrower than the 'unsafe-inline' already present.
    scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", xOfficeServer || ''],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    frameSrc: ["'self'", diagramsEditorOrigin(diagramsEditorUrl), xOfficeServer, collaboraServer].filter(Boolean)
  }
})

export const CONNECT_ERROR_CODE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])
