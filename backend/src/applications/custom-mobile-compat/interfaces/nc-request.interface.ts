// Module augmentation: attach an `nc` field onto FastifyDAVRequest for state
// the NC-compat layer needs to thread from controller to downstream services
// (e.g. propfind needs to know whether the incoming request landed at the
// user's NC home root so it can decide whether to inject share-mount entries).
//
// Kept in a separate file under custom-mobile-compat so the upstream
// webdav.interface.ts file stays untouched — important for clean upstream
// merges.

import '../../webdav/interfaces/webdav.interface'

export interface NcMobileContext {
  // True when the request resolved to the user's NC home root with an empty
  // subpath, i.e. /remote.php/dav/files/{user}[/] in files mode. Propfind
  // uses this to decide whether to append virtual share-mount entries.
  isHomeRoot: boolean
}

declare module '../../webdav/interfaces/webdav.interface' {
  interface FastifyDAVRequest {
    nc?: NcMobileContext
  }
}
