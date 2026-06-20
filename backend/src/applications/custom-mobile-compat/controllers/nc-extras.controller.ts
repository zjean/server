import { Controller, Get, Header, HttpException, HttpStatus, Logger, Param, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { createReadStream } from 'node:fs'
import { open as fsOpen } from 'node:fs/promises'
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
import { NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'
import { resolveSharedFileSegments } from '../utils/nc-shared-file-resolver'

// NcExtrasController — odds and ends the stock Nextcloud iOS/Android clients
// hit outside of OCS/WebDAV: avatar display + file-preview thumbnails. Kept
// out of NcOcsController because these aren't OCS-enveloped responses.
@Controller()
@AuthTokenSkip()
export class NcExtrasController {
  private readonly logger = new Logger(NcExtrasController.name)

  constructor(
    private readonly usersManager: UsersManager,
    private readonly filesManager: FilesManager,
    private readonly spacesManager: SpacesManager,
    private readonly resolver: NcPathResolverService,
    private readonly filesQueries: FilesQueries,
    private readonly shareMounts: NcShareMountResolverService
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
  // Mirror real Nextcloud's preview cache header — `public, max-age=86400`.
  // The previous `private,max-age=3600` value passed semantically (the
  // preview is per-user, but never going through a shared CDN here) but
  // some iOS URLSession code paths in NC iOS treat `private` as a signal
  // not to write the response into the app's preview cache, leaving list
  // cells icon-only even after a 200 response. Public + 24-hour TTL is
  // what real NC sends; iOS rendering paths are tested against that shape.
  @Header('cache-control', 'public,max-age=86400')
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
    // Diagnostic context — captured for one structured log line per request
    // so we can correlate iOS preview failures (broken thumbnails) with the
    // server-side mapping (fileId → DB row → space.realPath). Set in the
    // resolveFile{Id,Path} branches below.
    const diag: PreviewDiagContext = { fileId, filePath, dbRow: null, urlSegments: null }
    let space: SpaceEnv | null = null
    if (filePath) {
      space = await this.resolveFilePath(req.user, filePath, diag)
    } else if (fileId) {
      space = await this.resolveFileId(req.user, fileId, diag)
    }
    if (!space) {
      this.logger.warn({ tag: this.preview.name, msg: `not found: ${formatDiag(diag)}` })
      throw new HttpException('preview target not found', HttpStatus.NOT_FOUND)
    }
    diag.realPath = space.realPath

    try {
      // Content-type comes from the service: webp on the sharp-resized happy
      // path, the original mime when sharp can't decode the file and we fall
      // back to streaming the raw bytes (e.g. JPEG XL, HEIC). NC iOS 17+
      // decodes the long-tail formats natively, so the fallback still
      // renders — just without server-side downscaling.
      //
      // Content-Length is mandatory for NC iOS' preview cache: without it
      // (chunked transfer + unknown length), iOS receives the body but
      // refuses to write it into the on-disk thumb cache, so list cells
      // never render even after a 200 response. The service buffers sharp
      // output to a Buffer and stat()s the file in the fallback path
      // specifically so we can advertise it here.
      const { stream, contentType, contentLength } = await this.filesManager.generateThumbnail(space, size)
      res.header('content-type', contentType)
      res.header('content-length', contentLength)
      return new StreamableFile(stream, { type: contentType, length: contentLength })
    } catch (e) {
      // FilesManager.generateThumbnail throws FileError, which exposes its
      // HTTP code as `httpCode` (see file-error.ts). The fallback path
      // means BAD_REQUEST now only fires for genuinely non-image files
      // (PDFs, archives, etc.) — sharp decode failures are absorbed
      // upstream.
      const err = e as { httpCode?: number; message?: string }
      // First 16 bytes as hex — useful when a non-image slips through and
      // we want to know what format it really was without re-reading the
      // file. Read failure is non-fatal: we still emit the rest of the log.
      const magic = await readMagic(space.realPath)
      this.logger.warn({
        tag: this.preview.name,
        msg: `thumbnail failed: ${formatDiag(diag)} code=${err.httpCode ?? '?'} magic=${magic ?? '?'} err=${err.message ?? '?'}`
      })
      if (err.httpCode === HttpStatus.BAD_REQUEST) {
        // Non-image file — NC client interprets 404 as "skip preview".
        throw new HttpException('no preview available for this mime type', HttpStatus.NOT_FOUND)
      }
      if (err.httpCode === HttpStatus.NOT_FOUND) {
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
  private async resolveFileId(user: UserModel, fileId: string, diag: PreviewDiagContext): Promise<SpaceEnv | null> {
    const id = Number.parseInt(fileId, 10)
    if (!Number.isFinite(id) || id <= 0) {
      this.logger.debug({ tag: this.resolveFileId.name, msg: `non-positive id: raw=${fileId}` })
      return null
    }
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, id)
    } catch (e) {
      this.logger.warn({ tag: this.resolveFileId.name, msg: `db lookup threw for id=${id}: ${(e as Error).message}` })
      return null
    }
    diag.dbRow = row
    if (!row?.path) {
      // Not owned by the requester — it may still be a file shared WITH them.
      // getUserFile is owner-scoped, so fall through to share-mount resolution.
      return this.resolveSharedFileId(user, id, diag)
    }
    // filesQueries.getUserFile returns path as "<dir>/<name>" already joined.
    // Build the URL segments that SpacesManager.spaceEnv expects for personal
    // space: ['files', 'personal', ...pathSegments].
    const pathSegments = row.path.split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...pathSegments]
    diag.urlSegments = urlSegments
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch (e) {
      this.logger.warn({
        tag: this.resolveFileId.name,
        msg: `spaceEnv failed for id=${id} dbPath=${row.path} segments=${JSON.stringify(urlSegments)}: ${(e as Error).message}`
      })
      return null
    }
  }

  // Resolve a fileId that the requester doesn't own into a SpaceEnv via one of
  // their incoming share-mounts. NC clients keep requesting `?fileId=` thumbs
  // for files inside shared folders (the id is the donor-side child's real DB
  // id), so without this they render icon-only. resolveSharedFileSegments is
  // the access boundary: it only yields segments when the target is the share
  // root or a descendant in the same physical tree, and spaceEnv then
  // re-validates the user actually holds that share.
  private async resolveSharedFileId(user: UserModel, id: number, diag: PreviewDiagContext): Promise<SpaceEnv | null> {
    let mounts: Awaited<ReturnType<NcShareMountResolverService['listMounts']>>
    let rows: Awaited<ReturnType<FilesQueries['getFilesByIds']>>
    try {
      mounts = await this.shareMounts.listMounts(user)
      if (!mounts.length) {
        this.logger.debug({ tag: this.resolveSharedFileId.name, msg: `no row and no share-mounts for id=${id}` })
        return null
      }
      rows = await this.filesQueries.getFilesByIds([id, ...mounts.map((m) => m.fileId)])
    } catch (e) {
      this.logger.warn({ tag: this.resolveSharedFileId.name, msg: `lookup threw for id=${id}: ${(e as Error).message}` })
      return null
    }
    const target = rows.find((r) => r.id === id)
    if (!target) {
      this.logger.debug({ tag: this.resolveSharedFileId.name, msg: `no file row for id=${id}` })
      return null
    }
    const rootById = new Map(rows.map((r) => [r.id, r]))
    const segments = resolveSharedFileSegments(target, mounts, rootById)
    if (!segments) {
      this.logger.debug({ tag: this.resolveSharedFileId.name, msg: `id=${id} not inside any share-mount` })
      return null
    }
    diag.urlSegments = segments
    try {
      return await this.spacesManager.spaceEnv(user, segments)
    } catch (e) {
      this.logger.warn({
        tag: this.resolveSharedFileId.name,
        msg: `spaceEnv failed for shared id=${id} segments=${JSON.stringify(segments)}: ${(e as Error).message}`
      })
      return null
    }
  }

  // Resolve an NC-style path (with or without the /remote.php/dav/files/{user}/
  // prefix) into a Sync-in SpaceEnv.
  private async resolveFilePath(user: UserModel, filePath: string, diag: PreviewDiagContext) {
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
    diag.urlSegments = urlSegments
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch (e) {
      this.logger.warn({
        tag: this.resolveFilePath.name,
        msg: `spaceEnv failed for filePath=${filePath} segments=${JSON.stringify(urlSegments)}: ${(e as Error).message}`
      })
      return null
    }
  }
}

// Diagnostic context shared between resolveFile{Id,Path} and the preview
// handler so we can emit one structured log line per request showing the
// full mapping iOS → server-side resolution → realPath. Used for tracing
// preview failures in production; consumed by formatDiag().
interface PreviewDiagContext {
  fileId?: string
  filePath?: string
  dbRow: { id: number; path: string } | null
  urlSegments: string[] | null
  realPath?: string
}

// Read the first 16 bytes of a file as lowercase hex, returning null if the
// read fails. Used purely as a diagnostic hint in the preview-failure log
// line — the goal is to identify the real format of files sharp rejected
// (e.g. HEIC saved with .jpg extension shows magic `00000018 66747970 6865...`,
// AVIF starts with `00000018 66747970 6176...`, JPEG XL is `ff0a` or
// `0000000c 4a584c20`, classic JPEG is `ffd8ffe0/e1`, PNG is `89504e47`,
// WebP/RIFF is `52494646`).
async function readMagic(filePath: string | undefined): Promise<string | null> {
  if (!filePath) return null
  let fh: Awaited<ReturnType<typeof fsOpen>> | null = null
  try {
    fh = await fsOpen(filePath, 'r')
    const buf = Buffer.alloc(16)
    const { bytesRead } = await fh.read(buf, 0, 16, 0)
    return buf.subarray(0, bytesRead).toString('hex')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

function formatDiag(d: PreviewDiagContext): string {
  const parts: string[] = []
  if (d.fileId !== undefined) parts.push(`fileId=${d.fileId}`)
  if (d.filePath !== undefined) parts.push(`filePath=${d.filePath}`)
  if (d.dbRow) parts.push(`dbRow={id:${d.dbRow.id},path:${JSON.stringify(d.dbRow.path)}}`)
  if (d.urlSegments) parts.push(`segments=${JSON.stringify(d.urlSegments)}`)
  if (d.realPath !== undefined) parts.push(`realPath=${d.realPath}`)
  return parts.join(' ')
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
