import { LOCK_DEPTH } from '../../webdav/constants/webdav'
import type { VersionOrigin } from '../../custom-versioning/interfaces/version.interface'

export interface SaveStreamTmpFileValidationContext {
  tmpPath: string
  realPath: string
  checksum?: string
}

export interface SaveStreamOptions {
  dav?: { depth: LOCK_DEPTH; lockTokens: string[] }
  checksumAlg?: string
  tmpPath?: string
  validateTmpFile?: (ctx: SaveStreamTmpFileValidationContext) => Promise<void>
  // Fork: labels the version a snapshot creates. Optional — saveStream derives
  // `webdav` / `sync` / `web` from the other options, so upstream callers need
  // no change; only callers that cannot be told apart that way set it (the NC
  // text editor).
  versionOrigin?: VersionOrigin
}
