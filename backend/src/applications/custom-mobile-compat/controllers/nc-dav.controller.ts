import { All, Controller, HttpException, HttpStatus, Logger, Param, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { decodeUrl } from '../../../common/shared'
import { HTTP_METHOD } from '../../applications.constants'
import { getProps } from '../../files/utils/files'
import { SpaceGuard } from '../../spaces/guards/space.guard'
import { FastifySpaceRequest } from '../../spaces/interfaces/space-request.interface'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { canAccessToSpaceUrl } from '../../spaces/utils/permissions'
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
import { NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'
import { NcSyncReportService } from '../services/nc-sync-report.service'
import { destinationHasDotSegments } from '../utils/nc-destination'
import { buildNcUrlSegments, makeMountsMemo, type NcMountsMemo } from '../utils/nc-url-segments'
import { parseFavoriteProppatch } from '../utils/nc-favorites-xml'
import { detectReportBodyType } from '../utils/nc-sync-xml'
import type { FastifyRequest } from 'fastify'
import '../interfaces/nc-request.interface'
import { NO_CLIENT_FILE_ID } from '../../custom-shared/constants/file-ids'

// NcDavController — WebDAV, trashbin, legacy redirect.
//
// We delegate into Sync-in's WebDAVMethods service after building the SpaceEnv
// ourselves from the NC-style URL (which differs from Sync-in's native
// /webdav/<repo>/<alias>/... layout). Chunked uploads live in
// nc-uploads.controller.ts — they don't reuse WebDAVMethods because Sync-in
// doesn't model chunked-in-flight state.

// Why a COPY/MOVE Destination was refused. mapNcPathToInternal used to answer
// a bare `null` for all of these and the caller reported one message —
// "Destination must point at /remote.php/dav/{files,trashbin}/{user}/..." —
// which is actively misleading for the three cases where it DOES point there.
interface NcDestinationRefusal {
  reason: 'not-nc-path' | 'dot-segment' | 'space-root' | 'unaddressable'
}

const DESTINATION_REFUSALS: Record<NcDestinationRefusal['reason'], string> = {
  'not-nc-path': 'Destination must point at /remote.php/dav/{files,trashbin}/{user}/...',
  'dot-segment': 'Destination must not contain "." or ".." segments',
  'space-root': 'Destination must name a file or folder, not the space root',
  unaddressable: 'Destination is not addressable'
}

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
    // null = the path is not addressable (a `.`/`..` segment). It used to
    // normalize to '' and therefore to the space ROOT, which made
    // `PROPFIND /files/bob/a/./b` list the whole home and gave DELETE and
    // COPY/MOVE the home as their target (#483). Refuse it instead.
    if (urlSegments === null) {
      throw new HttpException(`Path is not valid: ${input.subpath}`, HttpStatus.BAD_REQUEST)
    }
    // Authorization, half one: the user-level repository gate. Exactly what
    // SpaceGuard.checkAccessToSpace does on the native WebDAV surface — a
    // user without USER_PERMISSION.SHARES must not reach shares/<alias>,
    // without PERSONAL_SPACE must not reach files/personal, and so on.
    // Nothing in the NC chain checked this before #515: NcBasicAuthGuard
    // authenticates the app password and stops there.
    this.assertRepositoryAccess(user, urlSegments, input.subpath)
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
    // Authorization, half two: the space/root permission overlay, the
    // trash-read-only rule and the quota rule — i.e. everything
    // @UseGuards(SpaceGuard) applies to webdav.controller.ts. We cannot use
    // the guard itself (it derives its SpaceEnv from a Sync-in-shaped URL),
    // so we call the same static it calls.
    await this.assertSpacePermissions(req)
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
      // Dot segments are refused, never resolved (#483) — and the check has to
      // happen HERE, on the raw header, because `new URL()` below silently
      // applies RFC 3986 remove_dot_segments (and treats `%2e` as a dot). Until
      // this ran, the byte-identical request 400'd in path-relative form (where
      // `new URL()` throws and the raw string survived to normalizeNcSubpath)
      // and resolved sabre-style in absolute form. See utils/nc-destination.ts.
      if (destinationHasDotSegments(destRaw)) {
        throw new HttpException(`Destination must not contain "." or ".." segments: ${destRaw}`, HttpStatus.BAD_REQUEST)
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
      if (typeof destInternal !== 'string') {
        // Four distinct refusals used to share one message that was wrong for
        // three of them ("must point at /remote.php/dav/{files,trashbin}/{user}/"
        // for a Destination that does exactly that).
        throw new HttpException(`${DESTINATION_REFUSALS[destInternal.reason]}: ${destRaw}`, HttpStatus.BAD_REQUEST)
      }
      const overwrite = (req.headers['overwrite'] as string | undefined)?.toUpperCase() !== 'F'
      req.dav.copyMove = {
        destination: destInternal,
        overwrite,
        isMove: req.method === HTTP_METHOD.MOVE
      }
    }
  }

  // ───────── authorization ─────────
  //
  // The NC DAV surface reuses Sync-in's own space authorization rather than
  // growing a second permission model. Before #515 it had NEITHER half, and
  // the handlers it dispatches into do not compensate: WebDAVMethods.delete /
  // .put / .mkcol rely entirely on the `@UseGuards(SpaceGuard)` declared on
  // webdav.controller.ts, and FilesManager.delete runs no check of its own.
  // Two things followed. `DELETE /remote.php/dav/files/{user}` moved the
  // user's whole home to trash, and every write verb succeeded against a
  // READ-ONLY share mount — the PROPFIND response said the user could not
  // (nc-prop-builder strips DELETE at a share root) but that was presentation
  // only.

  private assertRepositoryAccess(user: UserModel, urlSegments: string[], subpath: string): void {
    if (!canAccessToSpaceUrl(user, urlSegments)) {
      this.logger.warn({ tag: this.assertRepositoryAccess.name, msg: `${user.login} may not access this repository: ${subpath}` })
      throw new HttpException('You are not allowed to access to this repository', HttpStatus.FORBIDDEN)
    }
  }

  private async assertSpacePermissions(req: FastifyDAVRequest): Promise<void> {
    // oc:favorite is per-user metadata, not file content: stock NC clients
    // star a file with a PROPPATCH against the file's own DAV URL, and real
    // Nextcloud lets you favorite something you can only read. Mapping it
    // through SPACE_HTTP_PERMISSION would demand MODIFY and break starring on
    // every read-only share. Everything else — including the mtime PROPPATCH
    // that falls through to WebDAVMethods — takes the normal path.
    //
    // Scoped to the files tree. The exemption's justification is "you may star
    // what you may read", and the trashbin is read-only by rule rather than by
    // permission — SpaceGuard.checkPermissions refuses every ADD/MODIFY there
    // outright. Without this clause the exemption reached it too, so a trashed
    // file could be starred: harmless in itself, but wider than the reasoning
    // that grants it, and it would silently widen further if the favorites
    // bridge ever wrote anything beyond the star row.
    if (
      req.method === HTTP_METHOD.PROPPATCH &&
      !req.space.inTrashRepository &&
      parseFavoriteProppatch(req.body as string | Buffer | null | undefined) !== null
    ) {
      return
    }
    // PROPFIND / GET / HEAD / REPORT map to no operation at all
    // (SPACE_HTTP_PERMISSION has no entry, or a null one), so read verbs stay
    // exactly as permissive as they were.
    await SpaceGuard.checkPermissions(req as FastifyDAVRequest & FastifySpaceRequest, this.logger)
  }

  // Translate a URL path like /remote.php/dav/files/{user}/a/b into the
  // WebDAV-style path WebDAVSpaces.spaceEnv() / WEBDAV_PATH_TO_SPACE_SEGMENTS
  // expects — i.e. rooted at a WEBDAV_SPACES key (personal/spaces/shares/trash).
  // Returns a refusal reason rather than a bare null: the four ways this can
  // fail need four different 400 bodies (#512 review).
  //
  // Share-aware via buildUrlSegments: a destination whose first subpath
  // segment matches one of the user's incoming share aliases lands in
  // shares/<alias>/..., not personal/.... `getMounts` should be the same
  // memo the caller used for its own buildUrlSegments call so the COPY/MOVE
  // path doesn't double-fetch the share list.
  private async mapNcPathToInternal(user: UserModel, urlPath: string, getMounts?: NcMountsMemo): Promise<string | NcDestinationRefusal> {
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
      return { reason: 'not-nc-path' }
    }
    // A Destination that normalizes to nothing addresses the space ROOT. With
    // `Overwrite: T` — the RFC 4918 default this controller applies — copyMove
    // then calls deleteDestination() on it, moving the user's entire home into
    // trash before putting the source on top. No stock NC client emits a
    // request shaped like this, and there is no path through it that the user
    // could have meant, so refuse it (#483). normalizeNcSubpath also returns
    // null for a `.`/`..` segment; both cases become the caller's 400. (The
    // caller now rejects dot segments before we see them — this stays as the
    // defence in depth it was written to be.)
    const normalized = normalizeNcSubpath(subpath)
    if (normalized === null) return { reason: 'dot-segment' }
    if (normalized === '') return { reason: 'space-root' }
    const segs = await this.buildUrlSegments(user, { mode, subpath }, getMounts)
    if (segs === null) return { reason: 'unaddressable' }
    return segmentsToWebdavNsPath(segs)
  }

  // Resolve an NC subpath into Sync-in spaceEnv segments. The logic lives in
  // utils/nc-url-segments.ts because NcUploadsController needs the exact same
  // answer for its assembly Destination (#516) — it used to call
  // NcPathResolverService directly and so never saw a share mount.
  private buildUrlSegments(user: UserModel, input: { mode: 'files' | 'trashbin'; subpath: string }, getMounts?: NcMountsMemo) {
    return buildNcUrlSegments({ resolver: this.resolver, shareMounts: this.shareMounts }, user, input, getMounts)
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
  //   - any other space  → spacesQueries.getOrCreateSpaceFile(NO_CLIENT_FILE_ID, props, dbFileFromSpace(userId, space))
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
    await this.spacesQueries.getOrCreateSpaceFile(NO_CLIENT_FILE_ID, fileProps, dbFile)
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
