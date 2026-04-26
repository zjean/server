import { All, Controller, HttpException, HttpStatus, Logger, Param, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { HTTP_METHOD } from '../../applications.constants'
import { getProps } from '../../files/utils/files'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'
import { DEPTH } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVMethods } from '../../webdav/services/webdav-methods.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcPropfindService } from '../services/nc-propfind.service'
import { NcSyncReportService } from '../services/nc-sync-report.service'
import type { FastifyRequest } from 'fastify'

// NcDavController — WebDAV, trashbin, legacy redirect.
//
// We delegate into Sync-in's WebDAVMethods service after building the SpaceEnv
// ourselves from the NC-style URL (which differs from Sync-in's native
// /webdav/<repo>/<alias>/... layout). Chunked uploads live in
// nc-uploads.controller.ts — they don't reuse WebDAVMethods because Sync-in
// doesn't model chunked-in-flight state.

@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcDavController {
  private readonly logger = new Logger(NcDavController.name)

  constructor(
    private readonly resolver: NcPathResolverService,
    private readonly spacesManager: SpacesManager,
    private readonly spacesQueries: SpacesQueries,
    private readonly webdav: WebDAVMethods,
    private readonly propfind: NcPropfindService,
    private readonly syncReport: NcSyncReportService
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
    return this.invokeWebDAV(req, res, 'files')
  }

  private async dispatchTrashbin(urlUser: string, subpath: string, req: FastifyDAVRequest, res: FastifyReply) {
    this.verifyUrlUser(urlUser, req.user as UserModel)
    await this.attachSpace(req, { mode: 'trashbin', subpath })
    return this.invokeWebDAV(req, res, 'trashbin')
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

    // Build the minimal req.dav WebDAVMethods consumes. We intentionally do NOT
    // use WebDAVProtocolGuard — it reads req.originalUrl which Fastify doesn't
    // populate for our route tree, and it also requires USER_PERMISSION.WEBDAV
    // which we validate in the NC-minted-app-password path instead (see
    // NcBasicAuthGuard).
    req.dav = {
      url: (req.url ?? '').split('?')[0],
      depth: normalizeDepth(req.headers['depth'])
    }
    // PROPFIND / PROPPATCH / LOCK want body parsed into JSON-from-XML. We
    // accept empty bodies (NC clients sometimes send PROPFIND with no body
    // and expect default "allprop" semantics). A real XML parse isn't
    // necessary for the handlers we invoke — they only use body fields
    // opportunistically, falling back to sensible defaults.
    req.dav.body = null

    // COPY / MOVE: populate req.dav.copyMove from the Destination + Overwrite
    // headers so WebDAVMethods.copyMove() can resolve + dispatch.
    if (req.method === HTTP_METHOD.COPY || req.method === HTTP_METHOD.MOVE) {
      const destHeader = req.headers['destination']
      const destRaw = Array.isArray(destHeader) ? destHeader[0] : destHeader
      if (!destRaw) {
        throw new HttpException('Destination header is required for COPY/MOVE', HttpStatus.BAD_REQUEST)
      }
      // Destination may be absolute (https://host/remote.php/dav/files/{user}/X)
      // or path-relative. Normalize to the path only, then map NC → Sync-in.
      let destPath = destRaw
      try {
        destPath = new URL(destRaw).pathname
      } catch {
        // path-relative — use as-is
      }
      const destInternal = this.mapNcPathToInternal(user, destPath)
      if (destInternal === null) {
        throw new HttpException(`Destination must point at /remote.php/dav/{files,trashbin}/{user}/...: ${destRaw}`, HttpStatus.BAD_REQUEST)
      }
      const overwrite = (req.headers['overwrite'] as string | undefined)?.toUpperCase() !== 'F'
      req.dav.copyMove = {
        destination: destInternal,
        overwrite,
        isMove: req.method === HTTP_METHOD.MOVE
      }
    }
  }

  // Translate a URL path like /remote.php/dav/files/{user}/a/b into the
  // WebDAV-style path WebDAVSpaces.spaceEnv() / WEBDAV_PATH_TO_SPACE_SEGMENTS
  // expects — i.e. rooted at a WEBDAV_SPACES key (personal/spaces/trash).
  // Returns null if the URL path isn't rooted at /remote.php/dav/{files,trashbin}/{user}/.
  private mapNcPathToInternal(user: UserModel, urlPath: string): string | null {
    const stripped = urlPath.split('?')[0]
    const filesPrefix = `/remote.php/dav/files/${user.login}/`
    const filesPrefixNoSlash = `/remote.php/dav/files/${user.login}`
    const trashPrefix = `/remote.php/dav/trashbin/${user.login}/`
    const trashPrefixNoSlash = `/remote.php/dav/trashbin/${user.login}`
    let mode: 'files' | 'trashbin'
    let subpath: string
    if (stripped === filesPrefixNoSlash || stripped.startsWith(filesPrefix)) {
      mode = 'files'
      subpath = stripped === filesPrefixNoSlash ? '' : stripped.slice(filesPrefix.length)
    } else if (stripped === trashPrefixNoSlash || stripped.startsWith(trashPrefix)) {
      mode = 'trashbin'
      subpath = stripped === trashPrefixNoSlash ? '' : stripped.slice(trashPrefix.length)
    } else {
      return null
    }
    const resolved = this.resolver.resolve(user, { mode, subpath })
    // Build the WebDAV-style head that WEBDAV_PATH_TO_SPACE_SEGMENTS understands:
    //   personal       → 'personal'
    //   files/<alias>  → 'spaces/<alias>'
    //   trash/<alias>  → 'trash/<alias>'
    const head: string[] = []
    if (resolved.repository === 'trash') {
      head.push('trash', resolved.spaceAlias)
    } else if (resolved.spaceAlias === 'personal') {
      head.push('personal')
    } else {
      head.push('spaces', resolved.spaceAlias)
    }
    if (resolved.rootAlias) head.push(resolved.rootAlias)
    const tail = resolved.relativePath ? resolved.relativePath.split('/').filter(Boolean) : []
    return [...head, ...tail].join('/')
  }

  private async invokeWebDAV(req: FastifyDAVRequest, res: FastifyReply, mode: 'files' | 'trashbin'): Promise<string | StreamableFile | FastifyReply> {
    const method = req.method
    const repository = req.space.repository

    switch (method) {
      case HTTP_METHOD.PROPFIND:
        // Delegate to the NC-flavored builder so the response carries the
        // oc:/nc: namespace properties stock Nextcloud iOS & Android clients
        // require. The upstream WebDAVMethods.propfind only emits DAV: props
        // and iOS silently drops entries missing <oc:id> / <oc:fileid>.
        return this.propfind.respond(req, res, mode)
      case HTTP_METHOD.HEAD:
      case HTTP_METHOD.GET:
        return this.webdav.headOrGet(req, res, repository)
      case HTTP_METHOD.PUT: {
        const result = await this.webdav.put(req, res)
        // Synchronously create the DB row before returning. NC iOS issues a
        // PROPFIND on the parent directory milliseconds after PUT to refresh
        // its listing — if the row isn't there yet, our PROPFIND emits the
        // inode-derived placeholder fileid (PR #83), iOS caches *that* as
        // the file's primary key, and subsequent calls keyed on real DB id
        // (notably /index.php/core/preview?fileId=…) 404 forever.
        //
        // Awaiting adds a few ms to the PUT response but eliminates the
        // race. Failures are still best-effort — file is on disk, future
        // browse-time reconcile may pick it up via other code paths.
        try {
          await this.ensureDbRowForUpload(req)
        } catch (e) {
          this.logger.warn({
            tag: 'invokeWebDAV.PUT',
            msg: `DB row insert failed for ${req.space?.realPath ?? '?'}: ${(e as Error).message}`
          })
        }
        return result
      }
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
      case HTTP_METHOD.REPORT:
        // RFC 6578 sync-collection. Only meaningful for the files
        // repository — NC iOS doesn't issue REPORT against the trashbin
        // URL, and our sync log only carries files/trash events keyed to
        // the user's spaces.
        if (mode !== 'files') {
          throw new HttpException(`REPORT not supported on ${mode}`, HttpStatus.METHOD_NOT_ALLOWED)
        }
        return this.syncReport.respond(req, res)
      default:
        throw new HttpException(`Method ${method} not supported`, HttpStatus.METHOD_NOT_ALLOWED)
    }
  }

  // Inserts (or no-ops on existing) the `files` DB row for a just-uploaded
  // file so subsequent PROPFINDs return a stable positive `oc:fileid` instead
  // of the inode-derived placeholder Sync-in stamps onto FS-only files.
  // Public for direct unit testing.
  //
  // Two paths matching Sync-in's two `files`-row insert helpers:
  //   - personal space   → spacesQueries.getOrCreateUserFile(userId, props)
  //   - any other space  → spacesQueries.getOrCreateSpaceFile(0, props, dbFileFromSpace(userId, space))
  //
  // Trash repository is skipped — uploads don't go there.
  async ensureDbRowForUpload(req: FastifyDAVRequest): Promise<void> {
    const space = req.space
    const user = req.user as UserModel | undefined
    if (!user || !space?.realPath || !space.relativeUrl) return
    if (space.inTrashRepository) return
    const fileProps = await getProps(space.realPath, space.relativeUrl, false)
    if (fileProps.isDir) return

    if (space.inPersonalSpace) {
      await this.spacesQueries.getOrCreateUserFile(user.id, fileProps)
      return
    }
    // Shared / external / standalone-space file → use the space-aware insert.
    // `dbFileFromSpace` populates ownerId / spaceId / shareExternalId from the
    // SpaceEnv; `fileProps` (path/name/size/...) overrides on merge inside
    // `getOrCreateSpaceFile`.
    const dbFile = dbFileFromSpace(user.id, space)
    await this.spacesQueries.getOrCreateSpaceFile(0, fileProps, dbFile)
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

// Normalize the WebDAV Depth header (case-insensitive; accepts 0 / 1 / infinity).
// Falls back to RESOURCE (0) when missing or invalid so handlers behave
// conservatively on malformed clients.
function normalizeDepth(raw: string | string[] | undefined): DEPTH {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) return DEPTH.RESOURCE
  const lower = v.toLowerCase().trim()
  if (lower === DEPTH.MEMBERS || lower === '1') return DEPTH.MEMBERS
  if (lower === DEPTH.INFINITY) return DEPTH.INFINITY
  return DEPTH.RESOURCE
}
