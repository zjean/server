import { loadVersion } from './app.functions'

export const VERSION = loadVersion()
export const USER_AGENT = `sync-in-server/${VERSION}`
const DRAWIO_ORIGIN = (() => {
  const url = process.env['DRAWIO_URL'] ?? 'https://embed.diagrams.net'
  try {
    return new URL(url).origin
  } catch {
    return url
  }
})()

export const CONTENT_SECURITY_POLICY = (xOfficeServer: string, collaboraServer: string) => ({
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
    frameSrc: ["'self'", DRAWIO_ORIGIN, xOfficeServer, collaboraServer].filter(Boolean)
  }
})

export const CONNECT_ERROR_CODE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])
