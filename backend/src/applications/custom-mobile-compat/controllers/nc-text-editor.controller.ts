import { existsSync, statSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Controller, Get, HttpException, HttpStatus, Put, Query, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesManager } from '../../files/services/files-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { genEtag, getProps } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService, type NcDirectEditClaims } from '../services/nc-direct-editing.service'
import { renderMarkdownEditorPage } from '../utils/markdown-editor-page'
import { renderEditorErrorPageHtml } from '../utils/nc-editor-error-page'
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

    // NCViewerNextcloudText starts NCActivityIndicator in viewDidAppear (after
    // the push animation, ~350–700 ms) and stops it in webView:didFinishNavigation:.
    // Our page loads in <50 ms on LAN, so didFinish fires before viewDidAppear —
    // stop() is a no-op and the spinner hangs forever. Delaying the response
    // guarantees didFinish fires after viewDidAppear without any JS tricks.
    await new Promise<void>((resolve) => setTimeout(resolve, 700))

    const language = inferLanguage(fileName, mime)
    const readOnlyReason = oversized
      ? `This file is larger than ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB and is read-only here.`
      : undefined
    // Markdown gets the TipTap WYSIWYG page; everything else stays on
    // CodeMirror. Both pages share the /content GET+PUT auth/data path so
    // the dispatch only changes the editor UI.
    const html =
      language === 'markdown'
        ? renderMarkdownEditorPage({ token: token ?? '', fileName, readOnly: oversized, readOnlyReason })
        : renderTextEditorPage({ token: token ?? '', fileName, language, readOnly: oversized, readOnlyReason })

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
        .send(html)
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

    // Fastify's built-in text/plain content-type parser runs before any route
    // handler and reads the body into req.body as a string, draining req.raw.
    // saveStream reads from req.raw, so it would pipe an empty stream and
    // truncate the file to 0 bytes. Reconstruct req.raw from req.body so
    // saveStream gets the actual content.
    //
    // The `typeof` test is a REFUSAL, not a default. Falling back to '' meant
    // that any request whose content type this route does not assume — JSON
    // (parsed to an object), or anything at all under app.bootstrap's
    // catch-all `*` parser, which sets req.body to undefined and leaves
    // req.raw intact (text/markdown, application/octet-stream, multipart) —
    // silently truncated the file to 0 bytes and answered 204 with a fresh
    // ETag. The #518 short-write assertion could not catch it either, because
    // the content-length re-derivation below recomputed the declaration from
    // the same empty buffer: 0 >= 0 passes. Both shipped editor clients send
    // `text/plain; charset=utf-8` (text-editor-page.ts, markdown-editor-page.ts),
    // so 415 is the honest answer for anything else.
    if (typeof req.body !== 'string') {
      throw new HttpException('body must be sent as text/plain', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }
    const bodyBytes = Buffer.from(req.body, 'utf-8')
    // Fastify's req.headers and req.method are getters that read from req.raw.
    // Preserve them on the replacement stream so saveStream can still access
    // req.headers['content-range'] and req.method without a TypeError.
    //
    // content-length is RE-DERIVED from the replacement buffer rather than
    // forwarded: the incoming value describes the bytes on the wire, and what
    // saveStream will now see is our re-encoded copy of Fastify's parse of
    // them. The two agree for plain UTF-8 and disagree for anything else (a
    // BOM, a charset parameter). Since #518 saveStream asserts the body
    // delivers what content-length declared, so a stale header here would
    // turn a save that works today into a 400.
    const { headers: rawHeaders, method: rawMethod } = req.raw
    const newRaw = Object.assign(Readable.from([bodyBytes]), {
      headers: { ...rawHeaders, 'content-length': String(bodyBytes.length) },
      method: rawMethod
    })
    ;(req as unknown as { raw: Readable }).raw = newRaw

    try {
      // versionOrigin: this call is indistinguishable from a plain web save by
      // saveStream's own options (no dav, no tmpPath), so it labels itself.
      await this.filesManager.saveStream(user, space, req as Parameters<FilesManager['saveStream']>[2], { versionOrigin: 'nc-text' })
    } catch (e) {
      // FileError extends Error, not HttpException, so letting one escape a
      // controller is a 500. The other two saveStream callers translate it
      // (WebDAVMethods.handleError, FilesMethods.handleError); this one has to
      // do the same or every deliberate refusal saveStream makes — the #518
      // short-write 400, a quota or max-size 4xx, "parent must exists" — comes
      // back as a server error the client cannot act on. LockConflict has the
      // same shape and is mapped to 423 for the same reason.
      if (e instanceof FileError) {
        throw new HttpException(e.message, e.httpCode)
      }
      if (e instanceof LockConflict) {
        throw new HttpException(e.message, HttpStatus.LOCKED)
      }
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
    return this.serveBundle('codemirror.bundle.js', res)
  }

  // GET /custom-mobile-compat/text-editor/tiptap.bundle.js
  // Same fallback contract as the CodeMirror bundle — 404 if not built and
  // the markdown editor page degrades to its <textarea> fallback.
  @Get('custom-mobile-compat/text-editor/tiptap.bundle.js')
  async tiptapBundle(@Res() res: FastifyReply): Promise<FastifyReply> {
    return this.serveBundle('tiptap.bundle.js', res)
  }

  private serveBundle(filename: string, res: FastifyReply): FastifyReply {
    const bundlePath = join(__dirname, '..', 'assets', filename)
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

// HTML error page rendered when token verification fails. The page itself lives
// in utils/nc-editor-error-page.ts — shared with the office editor, and the one
// place that knows it must call the `loaded` bridge to become visible on stock
// NC Android.
function renderError(res: FastifyReply, message: string): FastifyReply {
  return res.header('Content-Type', 'text/html; charset=utf-8').send(renderEditorErrorPageHtml(message))
}
