import { existsSync, statSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Controller, Get, HttpException, HttpStatus, Put, Query, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesManager } from '../../files/services/files-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { genEtag, getProps } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService, type NcDirectEditClaims } from '../services/nc-direct-editing.service'
import { renderTextEditorPage } from '../utils/text-editor-page'

// 5 MB cap. Big text files cause WKWebView to lag and CodeMirror to thrash;
// users editing huge logs/CSVs are better served by a desktop app. We refuse
// PUT above this size and switch the page into read-only mode for GET.
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024

// Map a SpaceEnv's stored mime (e.g. `text-markdown`) or its filename
// extension to a CodeMirror language id the bundle understands. Best-effort —
// unknown languages fall back to plain text in the bundle.
function inferLanguage(fileName: string, mime: string | undefined): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  const byExt: Record<string, string> = {
    md: 'markdown',
    markdown: 'markdown',
    mdown: 'markdown',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    json: 'json',
    json5: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'css',
    less: 'css',
    xml: 'xml',
    svg: 'xml',
    plist: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell'
  }
  if (byExt[ext]) return byExt[ext]
  if (mime?.startsWith('text-markdown') || mime?.startsWith('text/markdown')) return 'markdown'
  if (mime?.includes('javascript')) return 'javascript'
  if (mime?.includes('json')) return 'json'
  return 'text'
}

// NcTextEditorController — serves the in-app text editor page and the
// token-protected content GET/PUT endpoints called by the editor.
//
// Auth model: every endpoint expects a `?token=<jwt>` query param minted by
// NcDirectEditingController.open(). The token carries the full user identity
// so we can reconstruct a UserModel without a DB hit. Crucially these
// endpoints do NOT use NcBasicAuthGuard — WKWebView in NC iOS doesn't share
// the OCS Basic Auth header, so cookie/Authorization-based auth would always
// fail at the WebView layer.
@Controller()
@AuthTokenSkip()
export class NcTextEditorController {
  constructor(
    private readonly directEditing: NcDirectEditingService,
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager,
    private readonly filesManager: FilesManager
  ) {}

  // GET /custom-mobile-compat/text-editor?token=…
  // Renders the editor HTML. Token failures and missing files render an HTML
  // error page (HTTP 200) rather than a JSON 4xx — WKWebView drops the user
  // into a useless blank page on a non-200 response.
  @Get('custom-mobile-compat/text-editor')
  async page(@Query('token') token: string | undefined, @Res() res: FastifyReply): Promise<FastifyReply> {
    const ctx = await this.resolveContext(token).catch(() => null)
    if (!ctx) return renderError(res, 'This editor link is invalid or has expired. Open the file again from the app.')

    const { fileProps } = ctx
    const fileName = fileProps.name
    const mime = fileProps.mime
    if (!this.directEditing.isEditableMime(mime)) {
      return renderError(res, `This file type (${mime ?? 'unknown'}) cannot be edited as text.`)
    }

    const oversized = fileProps.size > MAX_EDITABLE_BYTES
    return (
      res
        .header('Content-Type', 'text/html; charset=utf-8')
        // Defense in depth — the page itself renders a token in HTML, but its
        // attack surface is small. CSP keeps inline scripts intentional.
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
        )
        .header('X-Frame-Options', 'DENY')
        .send(
          renderTextEditorPage({
            token: token ?? '',
            fileName,
            language: inferLanguage(fileName, mime),
            readOnly: oversized,
            readOnlyReason: oversized
              ? `This file is larger than ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB and is read-only here.`
              : undefined
          })
        )
    )
  }

  // GET /custom-mobile-compat/text-editor/content?token=…
  // Returns the file's raw bytes as text/plain with a strong ETag the editor
  // sends back as If-Match on save. Refuses if the mime isn't editable or if
  // the file is over the size cap.
  @Get('custom-mobile-compat/text-editor/content')
  async getContent(@Query('token') token: string | undefined, @Res() res: FastifyReply): Promise<FastifyReply> {
    const { space, fileProps } = await this.resolveContextOrThrow(token)
    const mime = fileProps.mime
    if (!this.directEditing.isEditableMime(mime)) {
      throw new HttpException('mimetype not editable', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }
    if (!existsSync(space.realPath)) {
      throw new HttpException('file missing on disk', HttpStatus.NOT_FOUND)
    }
    const stat = statSync(space.realPath)
    if (stat.size > MAX_EDITABLE_BYTES) {
      throw new HttpException('file too large to edit in browser', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    const etag = genEtag(null, space.realPath, /* weakPrefix */ false)
    return res
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('ETag', etag)
      .send(createReadStream(space.realPath))
  }

  // PUT /custom-mobile-compat/text-editor/content?token=…
  // Body is the new file content (text/plain). If-Match enforces last-known
  // ETag, returning 412 on mid-edit conflicts. Delegates to FilesManager so
  // locks, range, and FileEvent emission match the WebDAV PUT path.
  @Put('custom-mobile-compat/text-editor/content')
  async putContent(@Req() req: FastifyRequest, @Query('token') token: string | undefined, @Res() res: FastifyReply): Promise<FastifyReply> {
    const { user, space, fileProps } = await this.resolveContextOrThrow(token)
    const mime = fileProps.mime
    if (!this.directEditing.isEditableMime(mime)) {
      throw new HttpException('mimetype not editable', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }

    // Strong ETag conflict check. NC iOS clients have been bitten by W/-
    // weak ETags in this fork (see PR #140 / commit 00c3fa7) — we always
    // emit strong here too.
    const ifMatch = req.headers['if-match']
    if (ifMatch && existsSync(space.realPath)) {
      const current = genEtag(null, space.realPath, false)
      if (Array.isArray(ifMatch) ? !ifMatch.includes(current) : ifMatch !== current) {
        throw new HttpException('etag mismatch', HttpStatus.PRECONDITION_FAILED)
      }
    }

    // Reject oversized writes upfront. Content-Length is set by Fastify for
    // text/plain uploads; if absent we still let saveStream gate via its
    // own checks but at least cap obvious cases.
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (contentLength > MAX_EDITABLE_BYTES) {
      throw new HttpException('file too large to save', HttpStatus.PAYLOAD_TOO_LARGE)
    }

    // Attach the token-derived user to the request so saveStream's downstream
    // logging/event-emit treats this as the user's own write.
    ;(req as unknown as { user: UserModel }).user = user

    try {
      await this.filesManager.saveStream(user, space, req as Parameters<FilesManager['saveStream']>[2], {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'save failed'
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const etag = genEtag(null, space.realPath, false)
    return res.header('ETag', etag).status(HttpStatus.NO_CONTENT).send()
  }

  // GET /custom-mobile-compat/text-editor/codemirror.bundle.js
  // Serves the pre-built CodeMirror bundle if present. Returns 404 when the
  // bundle hasn't been built — the editor page falls back to <textarea> in
  // that case, so editing still works.
  @Get('custom-mobile-compat/text-editor/codemirror.bundle.js')
  async bundle(@Res() res: FastifyReply): Promise<FastifyReply> {
    const bundlePath = join(__dirname, '..', 'assets', 'codemirror.bundle.js')
    if (!existsSync(bundlePath)) {
      throw new HttpException('bundle not built', HttpStatus.NOT_FOUND)
    }
    return res
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(createReadStream(bundlePath))
  }

  private async resolveContextOrThrow(token: string | undefined): Promise<{ user: UserModel; space: SpaceEnv; fileProps: FileProps }> {
    const ctx = await this.resolveContext(token).catch(() => null)
    if (!ctx) throw new HttpException('invalid or expired token', HttpStatus.UNAUTHORIZED)
    return ctx
  }

  private async resolveContext(token: string | undefined): Promise<{ user: UserModel; space: SpaceEnv; fileProps: FileProps } | null> {
    if (!token) return null
    let claims: NcDirectEditClaims
    try {
      claims = await this.directEditing.verifyEditToken(token)
    } catch {
      return null
    }
    // Reconstruct a UserModel from the embedded identity. This matches
    // OnlyOfficeStrategy's `new UserModel(jwtPayload.identity)` pattern.
    const user = new UserModel(claims.identity)
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, claims.fileId)
    } catch {
      return null
    }
    if (!row?.path) return null

    // Same path-segments construction as NcOnlyOfficeFileResolver — the
    // `files/personal/<sub-path>` URL is what SpacesManager understands.
    const pathSegments = row.path.split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...pathSegments]
    let space: SpaceEnv
    try {
      space = await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
    // Stat the actual file so callers can read mime, name, and size without
    // trying to cast FileDBProps (which carries no such fields) to FileProps.
    let fileProps: FileProps
    try {
      fileProps = await getProps(space.realPath, space.relativeUrl)
    } catch {
      return null
    }
    return { user, space, fileProps }
  }
}

// HTML error page rendered when token verification fails. Avoids leaking
// information about why the token failed (expired vs malformed vs file-not-
// found are all conflated).
function renderError(res: FastifyReply, message: string): FastifyReply {
  const safe = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Editor</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .card { max-width: 360px; text-align: center; }
  .card h1 { font-size: 17px; margin: 0 0 8px; }
  .card p { margin: 0; opacity: 0.8; }
</style></head>
<body><div class="card"><h1>Cannot open editor</h1><p>${safe}</p></div></body></html>`
  return res.header('Content-Type', 'text/html; charset=utf-8').send(body)
}
