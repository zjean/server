import { All, Controller, HttpCode, HttpException, HttpStatus, Logger, Param, Req, Res, UseGuards } from '@nestjs/common'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { HTTP_METHOD } from '../../applications.constants'
import { isPathExists, makeDir, moveFiles } from '../../files/utils/files'
import { SPACE_OPERATION } from '../../spaces/constants/spaces'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { haveSpaceEnvPermissions } from '../../spaces/utils/permissions'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcChunkedUploadsService } from '../services/nc-chunked-uploads.service'
import { NcPathResolverService } from '../services/nc-path-resolver.service'

// NC chunked-upload controller.
//
// Protocol (single upload_id per multi-chunk transfer):
//
//   MKCOL  /remote.php/dav/uploads/{user}/{upload_id}              → 201
//   PUT    /remote.php/dav/uploads/{user}/{upload_id}/<chunkName>  → 201
//   ...
//   MOVE   /remote.php/dav/uploads/{user}/{upload_id}/.file
//     Destination: /remote.php/dav/files/{user}/<target>
//     OC-Total-Length: <sum of chunks>
//     → 201 Created, Location: /remote.php/dav/files/{user}/<target>
//
// chunkName is typically a numeric offset ("0", "1", "2", …) or a range
// string. We preserve client ordering via numeric sort in the staging service.

@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcUploadsController {
  private readonly logger = new Logger(NcUploadsController.name)

  constructor(
    private readonly staging: NcChunkedUploadsService,
    private readonly resolver: NcPathResolverService,
    private readonly spacesManager: SpacesManager
  ) {}

  @All('remote.php/dav/uploads/:user/:uploadId')
  async rootHandler(
    @Param('user') urlUser: string,
    @Param('uploadId') uploadId: string,
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<void> {
    this.verifyUrlUser(urlUser, req.user)
    const method = req.method
    switch (method) {
      case HTTP_METHOD.MKCOL:
        await this.staging.ensureDir(req.user.id, uploadId)
        res.status(HttpStatus.CREATED)
        return
      case HTTP_METHOD.DELETE:
        await this.staging.remove(req.user.id, uploadId)
        res.status(HttpStatus.NO_CONTENT)
        return
      case HTTP_METHOD.MOVE: {
        // Some NC clients MOVE the staging dir itself (no '.file' suffix).
        await this.assembleAndMove(req, res, uploadId)
        return
      }
      case HTTP_METHOD.PROPFIND: {
        // Android's ChunkedFileUploadRemoteOperation PROPFIND depth 1 to
        // enumerate already-uploaded chunks so it can resume from `nextByte`
        // (sum of getcontentlength values across the listing). Depth 0 just
        // confirms the collection exists — keep the old shape for that.
        const depthHeader = req.headers['depth']
        const depthRaw = (Array.isArray(depthHeader) ? depthHeader[0] : depthHeader)?.toLowerCase().trim()
        const enumerateChildren = depthRaw === '1' || depthRaw === 'infinity'
        const chunks = enumerateChildren ? await this.staging.listChunksWithStats(req.user.id, uploadId) : []
        const baseHref = (req.url ?? '').split('?')[0]
        res.status(HttpStatus.MULTI_STATUS).header('content-type', 'application/xml; charset=utf-8')
        res.send(buildUploadDirPropfindBody(baseHref, chunks))
        return
      }
      case HTTP_METHOD.HEAD:
      case HTTP_METHOD.GET:
        if (!this.staging.exists(req.user.id, uploadId)) throw new HttpException('upload not found', HttpStatus.NOT_FOUND)
        res.status(HttpStatus.OK)
        return
      default:
        throw new HttpException('Method not allowed on upload root', HttpStatus.METHOD_NOT_ALLOWED)
    }
  }

  @All('remote.php/dav/uploads/:user/:uploadId/*')
  async chunkHandler(
    @Param('user') urlUser: string,
    @Param('uploadId') uploadId: string,
    @Req() req: FastifyRequest & { user: UserModel; raw: NodeJS.ReadableStream },
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<void> {
    this.verifyUrlUser(urlUser, req.user)

    const chunkName = extractTrailing(req.url ?? '', `/remote.php/dav/uploads/${urlUser}/${uploadId}/`)
    if (!chunkName) throw new HttpException('missing chunk name', HttpStatus.BAD_REQUEST)

    const method = req.method
    switch (method) {
      case HTTP_METHOD.PUT: {
        if (!this.staging.exists(req.user.id, uploadId)) {
          await this.staging.ensureDir(req.user.id, uploadId)
        }
        const written = await this.staging.writeChunk(req.user.id, uploadId, chunkName, req.raw)
        // If the client advertised a Content-Length, verify the bytes we
        // persisted match. Mismatch → drop the chunk + 400 so the client
        // retries instead of silently uploading a short tail.
        const cl = req.headers['content-length']
        const declared = Number.parseInt(String(Array.isArray(cl) ? cl[0] : (cl ?? '')), 10)
        if (Number.isFinite(declared) && declared >= 0 && declared !== written) {
          await fs.unlink(this.staging.chunkPath(req.user.id, uploadId, chunkName)).catch(() => undefined)
          throw new HttpException(`chunk ${chunkName}: wrote ${written}B but Content-Length=${declared}B`, HttpStatus.BAD_REQUEST)
        }
        res.status(HttpStatus.CREATED)
        return
      }
      case HTTP_METHOD.MOVE: {
        // MOVE of the sentinel '.file' (or 'file') is the "assemble" trigger.
        if (chunkName === '.file' || chunkName === 'file') {
          await this.assembleAndMove(req, res, uploadId)
          return
        }
        throw new HttpException('only .file may be MOVEd inside an upload', HttpStatus.METHOD_NOT_ALLOWED)
      }
      case HTTP_METHOD.DELETE:
        // Deleting individual chunks — rare but cheap to support.
        try {
          await fs.unlink(this.staging.chunkPath(req.user.id, uploadId, chunkName))
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException
          if (err.code !== 'ENOENT') throw new HttpException(err.message, HttpStatus.INTERNAL_SERVER_ERROR)
        }
        res.status(HttpStatus.NO_CONTENT)
        return
      case HTTP_METHOD.HEAD:
      case HTTP_METHOD.GET: {
        const p = this.staging.chunkPath(req.user.id, uploadId, chunkName)
        if (!fsSync.existsSync(p)) throw new HttpException('chunk not found', HttpStatus.NOT_FOUND)
        res.status(HttpStatus.OK)
        return
      }
      default:
        throw new HttpException(`Method ${method} not supported on chunks`, HttpStatus.METHOD_NOT_ALLOWED)
    }
  }

  @All('remote.php/dav/uploads/:user')
  @HttpCode(HttpStatus.METHOD_NOT_ALLOWED)
  rejectBareUser(): void {
    throw new HttpException('supply an upload id', HttpStatus.METHOD_NOT_ALLOWED)
  }

  private verifyUrlUser(urlUser: string, user: UserModel): void {
    if (!user || urlUser !== user.login) {
      throw new HttpException('forbidden: url user does not match authenticated user', HttpStatus.FORBIDDEN)
    }
  }

  private async assembleAndMove(req: FastifyRequest & { user: UserModel }, res: FastifyReply, uploadId: string): Promise<void> {
    const destHeader = req.headers['destination']
    const destination = Array.isArray(destHeader) ? destHeader[0] : destHeader
    if (!destination) throw new HttpException('Destination header required for MOVE', HttpStatus.BAD_REQUEST)

    const destPath = parseDestination(destination, req.user.login)
    if (!destPath) throw new HttpException('Destination must point at /remote.php/dav/files/{user}/...', HttpStatus.BAD_REQUEST)

    // Resolve destination space + check ADD permission (or MODIFY if overwriting).
    const resolved = this.resolver.resolve(req.user, { mode: 'files', subpath: destPath })
    const urlSegments: string[] = [resolved.repository, resolved.spaceAlias]
    if (resolved.rootAlias) urlSegments.push(resolved.rootAlias)
    if (resolved.relativePath) urlSegments.push(...resolved.relativePath.split('/').filter(Boolean))

    const space = await this.spacesManager.spaceEnv(req.user, urlSegments).catch((e: Error) => {
      throw new HttpException(`destination space is not valid: ${e.message}`, HttpStatus.BAD_REQUEST)
    })
    if (!space) throw new HttpException('destination space not found', HttpStatus.NOT_FOUND)
    const existed = await isPathExists(space.realPath)
    const permission = existed ? SPACE_OPERATION.MODIFY : SPACE_OPERATION.ADD
    if (!haveSpaceEnvPermissions(space, permission)) {
      throw new HttpException('Not allowed to write at destination', HttpStatus.FORBIDDEN)
    }

    // OC-Total-Length is part of the NC chunked-upload protocol; iOS always
    // sends it on the assembly MOVE. The audit hypothesized that Android's
    // chunked MoveMethod path may omit it (audit U1). Treat the header as
    // optional but verify equality when present — each chunk is already
    // Content-Length-verified at PUT time (see chunkHandler above), so the
    // per-byte integrity check still runs on every transfer; OC-Total-Length
    // is a redundant end-to-end re-verify, not a primary safety net.
    const expectedTotal = parseOcTotalLength(req.headers['oc-total-length'])
    if (expectedTotal === null) {
      this.logger.warn({
        tag: 'assembleAndMove',
        msg: `OC-Total-Length absent for upload ${uploadId} (user ${req.user.id}) — accepting; per-chunk Content-Length verification still applied`
      })
    }

    // Assemble to a sibling tmp file then atomic-move to avoid partial writes.
    const tmpPath = `${space.realPath}.uploading.${uploadId}`
    await makeDir(path.dirname(space.realPath), true)
    try {
      const total = await this.staging.concatenate(req.user.id, uploadId, tmpPath)
      if (expectedTotal !== null && expectedTotal !== total) {
        await fs.unlink(tmpPath).catch(() => undefined)
        throw new HttpException(`assembled size ${total} != OC-Total-Length ${expectedTotal}`, HttpStatus.BAD_REQUEST)
      }
      await moveFiles(tmpPath, space.realPath, true)
    } finally {
      // Always remove the staging dir once assembly attempted (success or fail).
      await this.staging.remove(req.user.id, uploadId).catch(() => undefined)
    }

    res.status(HttpStatus.CREATED).header('location', destination)
  }
}

// Normalize a Destination header into a Sync-in-relative subpath.
//   https://host/remote.php/dav/files/<user>/photos/a.jpg → photos/a.jpg
//   /remote.php/dav/files/<user>/photos/a.jpg             → photos/a.jpg
// Returns null if the destination isn't a /remote.php/dav/files/<user>/... URL.
function parseDestination(dest: string, login: string): string | null {
  let urlPath = dest
  try {
    const u = new URL(dest)
    urlPath = u.pathname
  } catch {
    // relative path — use as-is
  }
  const prefix = `/remote.php/dav/files/${login}/`
  if (!urlPath.startsWith(prefix)) return null
  return decodeURIComponent(urlPath.slice(prefix.length))
}

// Pull the segment of `url` after `prefix`. Drops any query string.
function extractTrailing(url: string, prefix: string): string {
  const [bare] = url.split('?')
  if (bare.startsWith(prefix)) return bare.slice(prefix.length)
  return ''
}

// Parse an OC-Total-Length header into a positive integer, or null when
// absent / malformed / non-positive. Exported for unit tests; the rest of
// the controller treats the result as "client told us the expected size"
// (number) vs "client didn't" (null).
export function parseOcTotalLength(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// One chunk's identity for the upload-dir PROPFIND. Built from `listChunks`
// names + `fs.stat` results — the controller does the I/O, this module owns
// the wire format.
export interface UploadChunkInfo {
  name: string
  size: number
  mtimeMs: number
}

// Build the PROPFIND response body for the upload staging dir.
//
// Empty chunks list → just the collection response (back-compat with the
// previous minimalPropfindBody; used for depth=0 or when the dir doesn't
// exist yet). Non-empty → collection + one <d:response> per chunk carrying
// <d:getcontentlength> + <d:getlastmodified> + empty <d:resourcetype/>.
//
// Audit #6: Android's `ChunkedFileUploadRemoteOperation` sums the chunk
// sizes to compute `nextByte` for resume. Without per-chunk responses
// every retry restarts at byte 0 — wasting an entire upload's worth of
// bytes on every reconnect, on the slowest mobile networks.
export function buildUploadDirPropfindBody(parentHref: string, chunks: UploadChunkInfo[]): string {
  const safeParent = xmlEscape(parentHref)
  const collectionResponse = `  <d:response>
    <d:href>${safeParent}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`
  const chunkResponses = chunks
    .map((c) => {
      const childHref = `${safeParent}/${encodeURIComponent(c.name)}`
      const lastModified = new Date(c.mtimeMs).toUTCString()
      return `  <d:response>
    <d:href>${childHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>${c.size}</d:getcontentlength>
        <d:getlastmodified>${lastModified}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`
    })
    .join('\n')
  const body = chunks.length > 0 ? `${collectionResponse}\n${chunkResponses}` : collectionResponse
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
${body}
</d:multistatus>`
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}
