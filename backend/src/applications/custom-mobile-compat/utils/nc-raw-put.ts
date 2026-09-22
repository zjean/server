import { FastifyInstance } from 'fastify'
import { HTTP_METHOD } from '../../applications.constants'

// Every NC-compat route this module mounts hangs off this prefix — files,
// uploads, trashbin, versions, comments and the legacy /remote.php/webdav tree.
export const NC_REMOTE_PREFIX = '/remote.php/'

/**
 * Is this request a Nextcloud DAV write whose body must stay a raw stream?
 *
 * PUT is the only method under /remote.php/ that carries file CONTENT:
 * nc-dav.controller routes it to WebDAVMethods.put (which pipes req.raw) and
 * nc-uploads.controller writes the chunk from req.raw. Every other method in
 * the tree is either bodiless or carries DAV XML that must stay parsed
 * (PROPFIND / PROPPATCH / REPORT), so the test is deliberately method-scoped
 * rather than prefix-only.
 */
export function isNcRawBodyRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== HTTP_METHOD.PUT) return false
  return (url ?? '').split('?')[0].startsWith(NC_REMOTE_PREFIX)
}

/**
 * Force `application/octet-stream` on NC DAV PUTs, before body parsing runs.
 *
 * Fastify picks a body parser from Content-Type, and a BUFFERED parser drains
 * req.raw before the handler ever sees it — so a PUT whose Content-Type is
 * application/json, text/plain (both fastify defaults) or application/xml,
 * text/xml (registered by webdav/utils/bootstrap.ts for PROPFIND et al.) used
 * to land as a 0-byte file with a 201. That is reachable from a stock client:
 * NC Android's UploadFileRemoteOperation sends the file's own mime verbatim,
 * so any small .txt / .json / .xml silently uploaded as empty.
 *
 * Upstream already defends its own /webdav tree with the same trick
 * (webdav/utils/bootstrap.ts), but that hook is scoped to WEBDAV_SPACES'
 * route and cannot see /remote.php/*. Rather than widen upstream code — which
 * would put this on the merge-conflict surface every sync — this is a
 * fork-local twin covering the NC prefix.
 *
 * Rewriting the header rather than allow-listing content types is deliberate:
 * it is not knowable from here which mimes a given client version sends, and
 * an allow-list built from a guess leaves the next one broken. After this hook
 * NO content type can select a buffering parser for an NC DAV write —
 * application/octet-stream has no registered parser, so it falls through to
 * the '*' passthrough in app.bootstrap.ts and req.raw stays readable.
 */
export function bootstrapNcRawUploads(fastifyInstance: FastifyInstance): void {
  fastifyInstance.addHook('onRequest', (req, _reply, done) => {
    if (isNcRawBodyRequest(req.method, req.url)) {
      req.headers['content-type'] = 'application/octet-stream'
    }
    return done()
  })
}
