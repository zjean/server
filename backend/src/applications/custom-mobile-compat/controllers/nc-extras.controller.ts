import { Controller, Get, Header, HttpException, HttpStatus, Param, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { createReadStream } from 'node:fs'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesManager } from '../../files/services/files-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'

// NcExtrasController — odds and ends the stock Nextcloud iOS/Android clients
// hit outside of OCS/WebDAV: avatar display + file-preview thumbnails. Kept
// out of NcOcsController because these aren't OCS-enveloped responses.
@Controller()
@AuthTokenSkip()
export class NcExtrasController {
  constructor(
    private readonly usersManager: UsersManager,
    private readonly filesManager: FilesManager,
    private readonly spacesManager: SpacesManager,
    private readonly resolver: NcPathResolverService,
    private readonly filesQueries: FilesQueries
  ) {}

  // Avatar binary. NC clients call this for every user they render (chat,
  // shares, activity). We only expose the authenticated user's own avatar —
  // cross-user avatar lookup would be information disclosure, and NC mobile
  // only needs its own anyway (it caches it post-login).
  //
  // :size is intentionally ignored — NC clients downscale client-side and
  // Sync-in only stores one avatar size. Accepted and discarded.
  @Get('index.php/avatar/:user/:size')
  @UseGuards(NcBasicAuthGuard)
  @Header('cache-control', 'private,max-age=86400')
  async avatar(@Param('user') user: string, @Param('size') _size: string, @Req() req: FastifyRequest & { user: UserModel }): Promise<StreamableFile> {
    if (user !== req.user.login) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN)
    }
    let avatarPath: string
    let mime: string
    try {
      const result = await this.usersManager.getAvatar(req.user.login)
      if (!result || !result[0]) {
        throw new HttpException('avatar not found', HttpStatus.NOT_FOUND)
      }
      ;[avatarPath, mime] = result
    } catch (e) {
      if (e instanceof HttpException) throw e
      throw new HttpException('avatar not found', HttpStatus.NOT_FOUND)
    }
    return new StreamableFile(createReadStream(avatarPath), { type: mime })
  }

  // Preview thumbnails. Delegates to FilesManager.generateThumbnail for image
  // mime types only; everything else returns 404, which NC clients gracefully
  // interpret as "no preview — show the file icon".
  //
  // NC iOS/Android clients prefer ?fileId=<oc:fileid> because they already
  // keep it from PROPFIND. We honor that by looking up the file in the DB
  // (scoped to files owned by the authenticated user, which matches the
  // mobile-compat personal-space default). A ?file=<path> fallback is kept
  // for clients or manual tools that compute a path instead.
  //
  // Query params: `fileId` OR `file` (NC-style path with or without the
  // /remote.php/dav/files/{user}/ prefix), `x` + `y` (pixel dimensions —
  // we use the max of the two for the thumbnail square; NC clients request
  // square thumbs and letterbox client-side).
  // Both the bare path and the `.png` extension form are honored. Real NC
  // serves both, and different NC iOS code paths / Android client versions
  // pick one or the other; declaring both as routes on the same handler keeps
  // us compatible with all of them.
  @Get(['index.php/core/preview', 'index.php/core/preview.png'])
  @UseGuards(NcBasicAuthGuard)
  @Header('cache-control', 'private,max-age=3600')
  async preview(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('file') filePath?: string,
    @Query('fileId') fileId?: string,
    @Query('x') x?: string,
    @Query('y') y?: string
  ): Promise<StreamableFile> {
    if (!filePath && !fileId) {
      throw new HttpException('file or fileId is required', HttpStatus.BAD_REQUEST)
    }

    const size = clampSize(x, y)
    let space: SpaceEnv | null = null
    if (filePath) {
      space = await this.resolveFilePath(req.user, filePath)
    } else if (fileId) {
      space = await this.resolveFileId(req.user, fileId)
    }
    if (!space) throw new HttpException('preview target not found', HttpStatus.NOT_FOUND)

    try {
      const stream = await this.filesManager.generateThumbnail(space, size)
      // generateThumbnail emits WebP bytes (sharp `.webp(...)` in
      // backend/src/common/image.ts). Labeling them as JPEG would break NC
      // clients that dispatch decoders by Content-Type — the JPEG decoder
      // hits a WebP RIFF header and the cell renders blank. NC iOS supports
      // WebP since iOS 14 (current min target ≥ iOS 15) and the Android
      // client decodes WebP natively; this matches real NC ≥ 25.
      res.header('content-type', 'image/webp')
      return new StreamableFile(stream, { type: 'image/webp' })
    } catch (e) {
      // FileError.status is HTTP_STATUS. Everything else: treat as no preview.
      const err = e as { status?: number; message?: string }
      if (err.status === HttpStatus.BAD_REQUEST) {
        // Non-image file — NC client interprets 404 as "skip preview".
        throw new HttpException('no preview available for this mime type', HttpStatus.NOT_FOUND)
      }
      if (err.status === HttpStatus.NOT_FOUND) {
        throw new HttpException('preview target not found', HttpStatus.NOT_FOUND)
      }
      throw new HttpException(err.message ?? 'preview failed', HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }

  // Resolve an `?fileId=<oc:fileid>` query param into a personal-space SpaceEnv
  // for the authenticated user. Sync-in's `files` rows are scoped by ownerId,
  // so the lookup is intrinsically safe — a user cannot request a preview for
  // a file they don't own. Non-owned or non-existent ids return null and the
  // caller turns that into a 404 (which NC clients treat as "skip preview").
  //
  // Files living inside a non-personal space — shared spaces, shares, etc. —
  // are not currently supported via fileId because the mobile-compat mapping
  // targets personal-space-only (see NcPathResolverService). That's in line
  // with the module's design scope; a follow-up can extend this when mobile
  // users flip user.settings.mobileHome to a different space.
  private async resolveFileId(user: UserModel, fileId: string): Promise<SpaceEnv | null> {
    const id = Number.parseInt(fileId, 10)
    if (!Number.isFinite(id) || id <= 0) return null
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, id)
    } catch {
      return null
    }
    if (!row?.path) return null
    // filesQueries.getUserFile returns path as "<dir>/<name>" already joined.
    // Build the URL segments that SpacesManager.spaceEnv expects for personal
    // space: ['files', 'personal', ...pathSegments].
    const pathSegments = row.path.split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...pathSegments]
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
  }

  // Resolve an NC-style path (with or without the /remote.php/dav/files/{user}/
  // prefix) into a Sync-in SpaceEnv.
  private async resolveFilePath(user: UserModel, filePath: string) {
    let subpath = filePath.trim()
    // Strip common prefixes NC clients send in the ?file= query.
    for (const prefix of [`/remote.php/dav/files/${user.login}/`, `/files/${user.login}/`, '/']) {
      if (subpath.startsWith(prefix)) {
        subpath = subpath.slice(prefix.length)
        break
      }
    }
    // Safely decode — NcPathResolver also does its own normalization.
    const resolved = this.resolver.resolve(user, { mode: 'files', subpath })
    const urlSegments: string[] = [resolved.repository, resolved.spaceAlias]
    if (resolved.rootAlias) urlSegments.push(resolved.rootAlias)
    if (resolved.relativePath) urlSegments.push(...resolved.relativePath.split('/').filter(Boolean))
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
  }
}

// Clamp requested preview dimensions to a safe range. NC clients ask for
// [40, 1024] typically; we cap at 1024 and floor at 32 to bound CPU cost.
function clampSize(x?: string, y?: string): number {
  const nx = Number.parseInt(String(x ?? ''), 10)
  const ny = Number.parseInt(String(y ?? ''), 10)
  const raw = Math.max(Number.isFinite(nx) ? nx : 0, Number.isFinite(ny) ? ny : 0)
  if (!Number.isFinite(raw) || raw <= 0) return 128
  return Math.max(32, Math.min(1024, raw))
}
