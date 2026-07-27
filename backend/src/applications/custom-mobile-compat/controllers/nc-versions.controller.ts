import { All, Controller, HttpException, HttpStatus, Param, Req, Res, StreamableFile, UseFilters, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { VersioningExceptionsFilter } from '../../custom-versioning/filters/versioning-exception.filter'
import { VersioningService } from '../../custom-versioning/services/versioning.service'
import { HTTP_METHOD } from '../../applications.constants'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcVersionsService, ncContentType } from '../services/nc-versions.service'
import {
  buildSingleVersionMultistatus,
  buildVersionLabelAck,
  buildVersionsMultistatus,
  isRestoreDestination,
  parseVersionLabelProppatch,
  versionHref
} from '../utils/nc-version-xml'

// The Nextcloud file-versions DAV tree:
//
//   PROPFIND  /remote.php/dav/versions/{user}/versions/{fileId}             → list
//   PROPFIND  /remote.php/dav/versions/{user}/versions/{fileId}/{revision}  → one
//   GET/HEAD  /remote.php/dav/versions/{user}/versions/{fileId}/{revision}  → bytes
//   MOVE      …/{revision}  with Destination …/versions/{user}/restore/…    → restore
//   DELETE    …/{revision}                                                  → delete
//   PROPPATCH …/{revision}  with nc:version-label                           → label
//
// Shape verified against nextcloud/server apps/files_versions/lib/Sabre/* and
// the two Android operations that actually drive it
// (ReadFileVersionsRemoteOperation, RestoreFileVersionRemoteOperation). The wire
// details that cannot be inferred — the mandatory self entry, the
// timestamp-as-node-name, the unquoted ETag — are documented in
// utils/nc-version-xml.ts and services/nc-versions.service.ts, next to the code
// that depends on them.
//
// WHY RESTORE ARRIVES HERE AND NOT ON A `restore` ROUTE. Upstream models restore
// as moving a version node INTO the sibling `restore` collection
// (RestoreFolder::moveInto → rollBack). A WebDAV MOVE is issued against the
// SOURCE url with the target in the Destination header, so the request lands on
// the version's own route. The `restore` collection therefore needs no route of
// its own: nothing ever addresses it directly.
//
// FLAG GATING. Every handler 404s while `files.versions.enabled` is false, and
// the OCS capability is absent in the same state (constants/capabilities.ts), so
// a client never learns the tree exists. The route stays mounted rather than
// being conditionally registered so that the disabled behaviour is the same code
// path as every other 404 here — and is testable.
//
// SCOPE. Personal-space files only, the same constraint nc-comments and the
// OnlyOffice resolver carry, for the same reason: fileId → file resolution goes
// through the owner-scoped FilesQueries.getUserFile. See NcVersionsService.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
// FileError and LockConflict extend Error, not HttpException, so without this
// every domain error — 403 permission denied, 404 unknown revision, 409 size
// mismatch, a 423 lock conflict — would arrive as a 500. This is the same trap
// that shipped in the versions REST API (PR #322); a new controller does not
// inherit the filter, it has to ask for it.
@UseFilters(VersioningExceptionsFilter)
export class NcVersionsController {
  constructor(
    private readonly versions: NcVersionsService,
    private readonly versioning: VersioningService
  ) {}

  // The version collection for one file.
  @All('remote.php/dav/versions/:urlUser/versions/:fileId')
  async collection(
    @Param('urlUser') urlUser: string,
    @Param('fileId') fileIdParam: string,
    @Req() req: NcRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<FastifyReply> {
    const { user, space, fileId } = await this.resolve(urlUser, fileIdParam, req)

    if (req.method !== HTTP_METHOD.PROPFIND) {
      // Upstream's VersionCollection throws Forbidden for createFile /
      // createDirectory / delete / setName — every mutation of the collection
      // itself. 405 is the closer HTTP answer and is what NK's error pipeline
      // reports without retrying.
      throw new HttpException(`Method ${req.method} not supported on a version collection`, HttpStatus.METHOD_NOT_ALLOWED)
    }
    const entries = await this.versions.listEntries(user, space)
    return this.sendXml(res, buildVersionsMultistatus(user.login, fileId, entries))
  }

  // One version.
  @All('remote.php/dav/versions/:urlUser/versions/:fileId/:revision')
  async version(
    @Param('urlUser') urlUser: string,
    @Param('fileId') fileIdParam: string,
    @Param('revision') revisionParam: string,
    @Req() req: NcRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<FastifyReply | StreamableFile> {
    const { user, space, fileId } = await this.resolve(urlUser, fileIdParam, req)
    const revision = parsePositiveInt(revisionParam)
    if (revision === null) {
      throw new HttpException('revision must be a unix timestamp in seconds', HttpStatus.NOT_FOUND)
    }

    switch (req.method) {
      case HTTP_METHOD.PROPFIND: {
        const entry = await this.versions.findEntry(user, space, revision)
        if (!entry) throw new HttpException('Version not found', HttpStatus.NOT_FOUND)
        return this.sendXml(res, buildSingleVersionMultistatus(user.login, fileId, entry))
      }
      case HTTP_METHOD.GET:
      case HTTP_METHOD.HEAD:
        return this.download(user, space, revision, req, res)
      case HTTP_METHOD.MOVE:
        return this.restore(user, space, revision, req, res)
      case HTTP_METHOD.DELETE:
        return this.remove(user, space, revision, res)
      case HTTP_METHOD.PROPPATCH:
        return this.label(user, space, fileId, revision, req, res)
      default:
        throw new HttpException(`Method ${req.method} not supported on a version`, HttpStatus.METHOD_NOT_ALLOWED)
    }
  }

  // ──────── handlers ────────

  private async download(
    user: UserModel,
    space: SpaceEnv,
    revision: number,
    req: NcRequest,
    res: FastifyReply
  ): Promise<FastifyReply | StreamableFile> {
    const versionId = await this.versions.requireVersionId(user, space, revision)
    const { stream, version } = await this.versioning.getVersionStream(user, space, versionId)
    const name = space.dbFile.path.split('/').filter(Boolean).pop() ?? 'download'

    res.header('content-length', version.size)
    // Upstream's Plugin::afterGet adds this for every GET under versions/, using
    // the SOURCE file's name — so a downloaded revision lands as `report.txt`,
    // not as `1753574400`. Both parameter forms, older clients first, per
    // RFC 6266 and upstream's own comment.
    res.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    res.header('etag', String(revision))

    if (req.method === HTTP_METHOD.HEAD) {
      // Headers describe the resource; no body. Destroy the stream we opened so
      // the descriptor is not left dangling.
      stream.destroy()
      return res.status(HttpStatus.OK).send()
    }
    return new StreamableFile(stream, { type: ncContentType(space.realPath) })
  }

  private async restore(user: UserModel, space: SpaceEnv, revision: number, req: NcRequest, res: FastifyReply): Promise<FastifyReply> {
    const destination = headerValue(req.headers['destination'])
    if (!destination) {
      throw new HttpException('Destination header is required for MOVE', HttpStatus.BAD_REQUEST)
    }
    // A MOVE anywhere else is not a restore. Upstream expresses this by having
    // only RestoreFolder implement IMoveTarget — every other destination fails
    // the move. Rejecting explicitly beats silently restoring, which would turn
    // a client bug into a content overwrite.
    if (!isRestoreDestination(destination, user.login)) {
      throw new HttpException(`MOVE destination must be /remote.php/dav/versions/${user.login}/restore/...: ${destination}`, HttpStatus.BAD_REQUEST)
    }
    const versionId = await this.versions.requireVersionId(user, space, revision)
    await this.versioning.restoreVersion(user, space, versionId)
    // RestoreFileVersionRemoteOperation accepts 201 or 204. A restore always
    // replaces existing content, which is 204 in MOVE semantics.
    return res.status(HttpStatus.NO_CONTENT).send()
  }

  private async remove(user: UserModel, space: SpaceEnv, revision: number, res: FastifyReply): Promise<FastifyReply> {
    const versionId = await this.versions.requireVersionId(user, space, revision)
    // confirmLabeled = true. Our REST API requires an explicit flag before
    // deleting a NAMED version, because a name exempts it from every automatic
    // pruning rule and removing one must be deliberate. NC's protocol has no
    // such flag and no way to send one, so the DELETE itself is the deliberate
    // act — it addresses one specific revision, from a UI that confirmed. The
    // alternative is a 409 the client cannot resolve, which reads as "deleting
    // versions is broken".
    await this.versioning.deleteVersion(user, space, versionId, true)
    return res.status(HttpStatus.NO_CONTENT).send()
  }

  private async label(user: UserModel, space: SpaceEnv, fileId: number, revision: number, req: NcRequest, res: FastifyReply): Promise<FastifyReply> {
    const label = parseVersionLabelProppatch(req.body)
    if (label === undefined) {
      throw new HttpException('PROPPATCH body must set or remove nc:version-label', HttpStatus.BAD_REQUEST)
    }
    const versionId = await this.versions.requireVersionId(user, space, revision)
    await this.versioning.setLabel(user, space, versionId, label)
    return this.sendXml(res, buildVersionLabelAck(versionHref(user.login, fileId, revision)))
  }

  // ──────── shared ────────

  // Flag check, url-user check, id parse and file resolution — in that order,
  // because each one narrows what the next may reveal. The flag check comes
  // first so a disabled deployment leaks nothing about which ids exist.
  private async resolve(urlUser: string, fileIdParam: string, req: NcRequest): Promise<{ user: UserModel; space: SpaceEnv; fileId: number }> {
    if (!this.versions.enabled) {
      throw new HttpException('Versioning is not enabled', HttpStatus.NOT_FOUND)
    }
    const user = req.user
    if (!user || urlUser !== user.login) {
      // Upstream's RootCollection::getChildForPrincipal throws Forbidden when
      // the principal in the URL is not the session user.
      throw new HttpException('forbidden: url user does not match authenticated user', HttpStatus.FORBIDDEN)
    }
    const fileId = parsePositiveInt(fileIdParam)
    if (fileId === null) {
      throw new HttpException('fileId must be a positive integer', HttpStatus.NOT_FOUND)
    }
    const space = await this.versions.resolveSpace(user, fileId)
    if (!space) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    }
    // fileId comes back out because hrefs are built from it: SpaceEnv.dbFile
    // carries no id (it is a Partial<File> without one — see
    // files/interfaces/file-db-props.interface.ts), which is the same sparse-
    // index fact that made the FileRowEnsurer necessary in the first place.
    return { user, space, fileId }
  }

  private sendXml(res: FastifyReply, body: string): FastifyReply {
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(body)
  }
}

type NcRequest = FastifyRequest & { user?: UserModel }

// NC clients only ever send digits here. Reject anything else at the door with a
// 404 rather than letting a junk segment reach a DB lookup.
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}
