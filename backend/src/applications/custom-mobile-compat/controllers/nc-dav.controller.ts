import { All, Controller, HttpException, HttpStatus, Param, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { HTTP_METHOD } from '../../applications.constants'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { WebDAVProtocolGuard } from '../../webdav/guards/webdav-protocol.guard'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVMethods } from '../../webdav/services/webdav-methods.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import type { FastifyRequest } from 'fastify'

// NcDavController — WebDAV, trashbin, legacy redirect.
//
// We delegate into Sync-in's WebDAVMethods service after building the SpaceEnv
// ourselves from the NC-style URL (which differs from Sync-in's native
// /webdav/<repo>/<alias>/... layout). Chunked uploads live in
// nc-uploads.controller.ts — they don't reuse WebDAVMethods because Sync-in
// doesn't model chunked-in-flight state.

@Controller()
@UseGuards(NcBasicAuthGuard, WebDAVProtocolGuard)
export class NcDavController {
  constructor(
    private readonly resolver: NcPathResolverService,
    private readonly spacesManager: SpacesManager,
    private readonly webdav: WebDAVMethods
  ) {}

  // /remote.php/webdav/* — legacy clients. 301 to the modern dav-files route.
  // Bare path variants handled by separate handlers (Nest doesn't glob across
  // route levels).
  @All('remote.php/webdav')
  async legacyWebdavRoot(@Req() req: FastifyDAVRequest, @Res({ passthrough: true }) res: FastifyReply): Promise<void> {
    this.redirectLegacy(req, res, '')
  }

  @All('remote.php/webdav/*')
  async legacyWebdavRest(@Req() req: FastifyDAVRequest, @Res({ passthrough: true }) res: FastifyReply): Promise<void> {
    const rest = extractStar(req, '/remote.php/webdav/')
    this.redirectLegacy(req, res, rest)
  }

  // /remote.php/dav/files/{user} + /.../files/{user}/*
  @All('remote.php/dav/files/:user')
  async filesRootBare(
    @Param('user') urlUser: string,
    @Req() req: FastifyDAVRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string | StreamableFile | FastifyReply> {
    return this.dispatchFiles(urlUser, '', req, res)
  }

  @All('remote.php/dav/files/:user/*')
  async filesSubpath(
    @Param('user') urlUser: string,
    @Req() req: FastifyDAVRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string | StreamableFile | FastifyReply> {
    const subpath = extractStar(req, `/remote.php/dav/files/${urlUser}/`)
    return this.dispatchFiles(urlUser, subpath, req, res)
  }

  // /remote.php/dav/trashbin/{user} + subpaths — deleted files live here.
  @All('remote.php/dav/trashbin/:user')
  async trashbinRootBare(
    @Param('user') urlUser: string,
    @Req() req: FastifyDAVRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string | StreamableFile | FastifyReply> {
    return this.dispatchTrashbin(urlUser, '', req, res)
  }

  @All('remote.php/dav/trashbin/:user/*')
  async trashbinSubpath(
    @Param('user') urlUser: string,
    @Req() req: FastifyDAVRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string | StreamableFile | FastifyReply> {
    const subpath = extractStar(req, `/remote.php/dav/trashbin/${urlUser}/`)
    return this.dispatchTrashbin(urlUser, subpath, req, res)
  }

  // ───────── internals ─────────

  private async dispatchFiles(urlUser: string, subpath: string, req: FastifyDAVRequest, res: FastifyReply) {
    this.verifyUrlUser(urlUser, req.user as UserModel)
    await this.attachSpace(req, { mode: 'files', subpath })
    return this.invokeWebDAV(req, res)
  }

  private async dispatchTrashbin(urlUser: string, subpath: string, req: FastifyDAVRequest, res: FastifyReply) {
    this.verifyUrlUser(urlUser, req.user as UserModel)
    await this.attachSpace(req, { mode: 'trashbin', subpath })
    return this.invokeWebDAV(req, res)
  }

  private verifyUrlUser(urlUser: string, user: UserModel): void {
    if (!user || urlUser !== user.login) {
      throw new HttpException('forbidden: url user does not match authenticated user', HttpStatus.FORBIDDEN)
    }
  }

  // Build and attach a SpaceEnv + set req.params['*'] to the Sync-in-internal
  // path. Throws on unresolvable paths; downstream WebDAVMethods also throws
  // on missing resources — both yield clean WebDAV error responses via the
  // WebDAVExceptionsFilter (not used here; Nest's default filter serializes
  // HttpException which is close enough for the NC clients we support).
  private async attachSpace(req: FastifyDAVRequest, input: { mode: 'files' | 'trashbin'; subpath: string }) {
    const user = req.user as UserModel
    const resolved = this.resolver.resolve(user, input)
    const urlSegments: string[] = [resolved.repository, resolved.spaceAlias]
    if (resolved.rootAlias) urlSegments.push(resolved.rootAlias)
    if (resolved.relativePath) urlSegments.push(...resolved.relativePath.split('/').filter(Boolean))

    let space: SpaceEnv
    try {
      space = await this.spacesManager.spaceEnv(user, urlSegments)
    } catch (e) {
      throw new HttpException(`Space path is not valid: ${(e as Error).message}`, HttpStatus.BAD_REQUEST)
    }
    if (!space) throw new HttpException('Space not found', HttpStatus.NOT_FOUND)
    if (!space.enabled) throw new HttpException('Space is disabled', HttpStatus.FORBIDDEN)

    req.space = space
    // WebDAV body handlers read req.params['*'] for Destination-relative logic
    // inside COPY/MOVE. We repopulate it so they see the Sync-in-style path.
    ;(req as FastifyRequest & { params: Record<string, string> }).params['*'] = urlSegments.join('/')
  }

  private async invokeWebDAV(req: FastifyDAVRequest, res: FastifyReply): Promise<string | StreamableFile | FastifyReply> {
    const method = req.method
    const repository = req.space.repository

    switch (method) {
      case HTTP_METHOD.PROPFIND:
        return this.webdav.propfind(req, res, repository)
      case HTTP_METHOD.HEAD:
      case HTTP_METHOD.GET:
        return this.webdav.headOrGet(req, res, repository)
      case HTTP_METHOD.PUT:
        return this.webdav.put(req, res)
      case HTTP_METHOD.DELETE:
        return this.webdav.delete(req, res)
      case HTTP_METHOD.PROPPATCH:
        return this.webdav.proppatch(req, res)
      case HTTP_METHOD.MKCOL:
        return this.webdav.mkcol(req, res)
      case HTTP_METHOD.COPY:
      case HTTP_METHOD.MOVE:
        return this.webdav.copyMove(req, res)
      case HTTP_METHOD.LOCK:
        return this.webdav.lock(req, res)
      case HTTP_METHOD.UNLOCK:
        return this.webdav.unlock(req, res)
      default:
        throw new HttpException(`Method ${method} not supported`, HttpStatus.METHOD_NOT_ALLOWED)
    }
  }

  private redirectLegacy(req: FastifyDAVRequest, res: FastifyReply, rest: string): void {
    const user = req.user as UserModel
    if (!user) throw new HttpException('forbidden', HttpStatus.FORBIDDEN)
    const target = rest ? `/${rest}` : '/'
    const location = `/remote.php/dav/files/${encodeURIComponent(user.login)}${target}`
    res.status(HttpStatus.MOVED_PERMANENTLY).header('location', location)
  }
}

// Extract the portion of the URL after the known prefix. Nest's route params
// include '*' but the raw FastifyRequest.url is more reliable across versions.
function extractStar(req: FastifyDAVRequest, prefix: string): string {
  const url = (req.url ?? '').split('?')[0]
  if (url.startsWith(prefix)) return url.slice(prefix.length)
  // Fallback to the '*' param Nest assembled.
  const starParam = (req as FastifyRequest & { params: Record<string, string> }).params?.['*']
  return starParam ?? ''
}
