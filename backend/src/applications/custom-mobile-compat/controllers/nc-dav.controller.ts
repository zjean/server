import { All, Controller, HttpException, HttpStatus, Logger, Param, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { decodeUrl } from '../../../common/shared'
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
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcFavoritesReportService } from '../services/nc-favorites-report.service'
import { NcPathResolverService, normalizeNcSubpath } from '../services/nc-path-resolver.service'
import { NcPropfindService } from '../services/nc-propfind.service'
import { NcShareMountResolverService, type NcShareMount } from '../services/nc-share-mount-resolver.service'
import { NcSyncReportService } from '../services/nc-sync-report.service'
import { parseFavoriteProppatch } from '../utils/nc-favorites-xml'
import { detectReportBodyType } from '../utils/nc-sync-xml'
import type { FastifyRequest } from 'fastify'
import '../interfaces/nc-request.interface'

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
    private readonly shareMounts: NcShareMountResolverService,
    private readonly spacesManager: SpacesManager,
    private readonly spacesQueries: SpacesQueries,
    private readonly webdav: WebDAVMethods,
    private readonly propfind: NcPropfindService,
    private readonly syncReport: NcSyncReportService,
    private readonly favoritesReport: NcFavoritesReportService
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
    // Memoize the share-mount lookup for this request scope. buildUrlSegments
    // and (on COPY/MOVE) mapNcPathToInternal both call into share resolution;
    // without the memo, a single MOVE between two share-mounts hits the DB
    // twice. shareRootFiles is a 3-way UNION query — not free.
    const getMounts = makeMountsMemo(this.shareMounts, user)
    const urlSegments = await this.buildUrlSegments(user, input, getMounts)
    // Flag the home-root case so NcPropfindService can decide whether to
    // append virtual share-mount entries. We compute this against the raw
    // (normalized) subpath rather than the resolved segments: a user whose
    // mobileHome maps to a non-personal space is still "at home" when
    // subpath is empty, and they should see their share-mounts there too.
    req.nc = { isHomeRoot: input.mode === 'files' && normalizeNcSubpath(input.subpath) === '' }

    let space: SpaceEnv
    try {
      space = await this.spacesManager.spaceEnv(user, urlSegments)
    } catch (e) {
      // spaceEnv maps a FileError (file-not-found, permission-denied, etc.)
      // to an HttpException carrying the right httpCode (404, 403, …) —
      // preserve it so iOS treats missing paths as normal 404s rather than
      // the generic "broken account" 4xx that any other code triggers. Only
      // the raw Error("Space path is not valid …") case (malformed URL
      // shape) becomes a true 400.
      if (e instanceof HttpException) throw e
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
    //
    // url is stored *decoded* — same convention as WebDAVProtocolGuard
    // (decodeUrl(req.originalUrl)) — so downstream WebDAVFile.encodeUrl
    // encodes once, not twice. Storing the raw req.url instead would
    // double-encode hrefs containing reserved chars (e.g. "My folder" →
    // "My%2520folder"), which stock NC iOS/Android then displays as the
    // literal "%20" and follows as a non-existent path.
    req.dav = {
      url: decodeUrl((req.url ?? '').split('?')[0]),
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
      const destInternal = await this.mapNcPathToInternal(user, destPath, getMounts)
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
  // expects — i.e. rooted at a WEBDAV_SPACES key (personal/spaces/shares/trash).
  // Returns null if the URL path isn't rooted at /remote.php/dav/{files,trashbin}/{user}/.
  //
  // Share-aware via buildUrlSegments: a destination whose first subpath
  // segment matches one of the user's incoming share aliases lands in
  // shares/<alias>/..., not personal/.... `getMounts` should be the same
  // memo the caller used for its own buildUrlSegments call so the COPY/MOVE
  // path doesn't double-fetch the share list.
  private async mapNcPathToInternal(user: UserModel, urlPath: string, getMounts?: MountsMemo): Promise<string | null> {
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
    const segs = await this.buildUrlSegments(user, { mode, subpath }, getMounts)
    return segmentsToWebdavNsPath(segs)
  }

  // Resolve an NC subpath into Sync-in spaceEnv segments — i.e.
  // [repository, spaceAlias, ...path], consumable by SpacesManager.spaceEnv.
  //
  // Tries the share-mount alias first: if subpath's first segment matches one
  // of the user's incoming shares, route into the shares repository. Otherwise
  // fall through to NcPathResolverService for the user's home setting
  // (personal or mobileHome-configured space).
  //
  // Edge case: a share alias that collides with a real folder in the user's
  // personal/home space — the share wins (matches real NC behaviour for
  // recipient-side mountpoints). The personal-space folder remains reachable
  // via Sync-in's native /webdav route, just not via NC mobile.
  //
  // `getMounts` is an optional request-scope memo. When provided, the share
  // listing is fetched at most once per request even when both buildUrlSegments
  // and mapNcPathToInternal need it (COPY/MOVE flow).
  private async buildUrlSegments(user: UserModel, input: { mode: 'files' | 'trashbin'; subpath: string }, getMounts?: MountsMemo): Promise<string[]> {
    const normalized = normalizeNcSubpath(input.subpath)

    if (input.mode === 'files' && normalized) {
      const parts = normalized.split('/').filter(Boolean)
      const firstSeg = parts[0]
      if (firstSeg) {
        const mounts = getMounts ? await getMounts() : await this.shareMounts.listMounts(user)
        const mount = mounts.find((m) => m.alias === firstSeg) ?? null
        if (mount) {
          return [SPACE_REPOSITORY.SHARES, mount.alias, ...parts.slice(1)]
        }
      }
    }

    const resolved = this.resolver.resolve(user, input)
    const segs: string[] = [resolved.repository, resolved.spaceAlias]
    if (resolved.rootAlias) segs.push(resolved.rootAlias)
    if (resolved.relativePath) segs.push(...resolved.relativePath.split('/').filter(Boolean))
    return segs
  }

  private async invokeWebDAV(req: FastifyDAVRequest, res: FastifyReply, mode: 'files' | 'trashbin'): Promise<string | StreamableFile | FastifyReply> {
    const method = req.method

    switch (method) {
      case HTTP_METHOD.PROPFIND:
        // Delegate to the NC-flavored builder so the response carries the
        // oc:/nc: namespace properties stock Nextcloud iOS & Android clients
        // require. The upstream WebDAVMethods.propfind only emits DAV: props
        // and iOS silently drops entries missing <oc:id> / <oc:fileid>.
        return this.propfind.respond(req, res, mode)
      case HTTP_METHOD.HEAD:
      case HTTP_METHOD.GET:
        // Always pass FILES, exactly like the native WebDAV controller
        // (webdav.controller.ts). headOrGet only streams when its `repository`
        // arg is FILES; passing req.space.repository (= SHARES for a
        // recipient-side share-mount) made every download/open/preview of a
        // shared-with-me file 403 on the NC mobile clients. headOrGet's own
        // `inSharesList` guard still rejects the virtual shares-list root.
        return this.webdav.headOrGet(req, res, SPACE_REPOSITORY.FILES)
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
      case HTTP_METHOD.PROPPATCH: {
        // NC clients toggle a favorite with a PROPPATCH carrying <oc:favorite>
        // against the file's own DAV URL (iOS: <d:set>1|0; Android unfavorite:
        // <d:remove>). Intercept that here and route to the favorites service —
        // upstream WebDAVMethods.proppatch only knows mtime/Win32 props and
        // would 423 oc:favorite. A body without oc:favorite (the mtime case)
        // returns null and falls through to the upstream handler untouched.
        const favorite = parseFavoriteProppatch(req.body as string | Buffer | null | undefined)
        if (favorite !== null) return this.favoritesReport.respondProppatchFavorite(req, res, favorite)
        return this.webdav.proppatch(req, res)
      }
      case HTTP_METHOD.MKCOL:
        return this.webdav.mkcol(req, res)
      case HTTP_METHOD.COPY:
      case HTTP_METHOD.MOVE:
        return this.webdav.copyMove(req, res)
      case HTTP_METHOD.LOCK:
        return this.webdav.lock(req, res)
      case HTTP_METHOD.UNLOCK:
        return this.webdav.unlock(req, res)
      case HTTP_METHOD.REPORT: {
        // NC iOS sends two REPORT body shapes against the same URL:
        //   - <d:sync-collection> (RFC 6578 incremental sync) — default refresh
        //   - <oc:filter-files>   — Favorites tab
        // Both are routed here. Sniff the body root element first so the
        // wrong parser doesn't 400 a perfectly valid filter-files request
        // (which is what made the iOS Favorites tab spin previously).
        // Trashbin doesn't support either shape — sync log carries no
        // trash events and there's no favorites concept inside trash.
        if (mode !== 'files') {
          throw new HttpException(`REPORT not supported on ${mode}`, HttpStatus.METHOD_NOT_ALLOWED)
        }
        const reportType = detectReportBodyType(req.body as string | Buffer | null | undefined)
        if (reportType === 'filter-files') return this.favoritesReport.respond(req, res)
        // 'sync-collection' OR 'unknown' (empty body): defer to the
        // sync-collection handler. It already treats empty bodies as
        // "first sync" and surfaces 400 on truly malformed XML.
        return this.syncReport.respond(req, res)
      }
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

  // 308, not 301. `/remote.php/webdav/` is the URL ONLYOFFICE's own help pages
  // tell users to enter when connecting the Documents mobile app to a Nextcloud
  // account, and real Nextcloud serves that path directly rather than
  // redirecting — so the clients arriving here are the ones that never had to
  // survive a redirect. RFC 7231 §6.4.2 permits a user agent to rewrite a
  // redirected 301 as GET, which for PROPFIND/PUT/MOVE turns the whole
  // connection into a read of the collection. 308 (§6.4.7) forbids that
  // rewrite, so the method and body survive.
  private redirectLegacy(req: FastifyDAVRequest, res: FastifyReply, rest: string): void {
    const user = req.user as UserModel
    if (!user) throw new HttpException('forbidden', HttpStatus.FORBIDDEN)
    const target = rest ? `/${rest}` : '/'
    const location = `/remote.php/dav/files/${encodeURIComponent(user.login)}${target}`
    res.status(HttpStatus.PERMANENT_REDIRECT).header('location', location)
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

// Request-scope memo for the user's incoming share-mounts. First call hits
// the DB via NcShareMountResolverService.listMounts; subsequent calls return
// the cached promise. Resolvers themselves stay stateless — caching lives at
// the request boundary (the controller method that created the memo).
type MountsMemo = () => Promise<NcShareMount[]>

function makeMountsMemo(resolver: NcShareMountResolverService, user: UserModel): MountsMemo {
  let p: Promise<NcShareMount[]> | undefined
  return () => (p ??= resolver.listMounts(user))
}

// Convert spaceEnv-style segments ([repository, spaceAlias, ...]) to a
// WEBDAV_NS-style path (the format Sync-in's WebDAVMethods.copyMove consumes
// from req.dav.copyMove.destination). Mirrors the WEBDAV_SPACES route table:
//   files/personal   → 'personal'
//   files/<alias>    → 'spaces/<alias>'
//   shares/<alias>   → 'shares/<alias>'
//   trash/<alias>    → 'trash/<alias>'
function segmentsToWebdavNsPath(segs: string[]): string {
  const [repo, alias, ...rest] = segs
  const head: string[] = []
  if (repo === 'trash') head.push('trash', alias)
  else if (repo === 'shares') head.push('shares', alias)
  else if (alias === 'personal') head.push('personal')
  else head.push('spaces', alias)
  return [...head, ...rest].join('/')
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
