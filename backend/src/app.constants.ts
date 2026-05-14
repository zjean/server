import { loadVersion } from './app.functions'
import { configuration } from './configuration/config.environment'

export const VERSION = loadVersion()
export const USER_AGENT = `sync-in-server/${VERSION}`

const DRAWIO_ORIGIN = (() => {
  try {
    return new URL(configuration.applications.files.drawio.url).origin
  } catch {
    return configuration.applications.files.drawio.url
  }
})()

export const CONTENT_SECURITY_POLICY = (onlyOfficeServer: string, collaboraServer: string) => ({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'", onlyOfficeServer || '', collaboraServer || ''],
    scriptSrc: ["'self'", "'unsafe-inline'", onlyOfficeServer || ''],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    frameSrc: ["'self'", DRAWIO_ORIGIN, onlyOfficeServer, collaboraServer].filter(Boolean)
  }
})

export const CONNECT_ERROR_CODE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])
