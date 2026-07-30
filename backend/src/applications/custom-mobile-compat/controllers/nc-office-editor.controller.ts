import { Controller, Get, Logger, Query, Req, Res, UseInterceptors } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { ContextInterceptor } from '../../../infrastructure/context/interceptors/context.interceptor'
import { OnlyOfficeManager } from '../../files/editors/only-office/only-office-manager.service'
import { getMimeType } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService } from '../services/nc-direct-editing.service'
import { NcOnlyOfficeFileResolver } from '../services/nc-onlyoffice-file-resolver.service'
import { renderEditorErrorPageHtml } from '../utils/nc-editor-error-page'
import { officeEditorCsp, renderOfficeEditorPage } from '../utils/office-editor-page'

// The 700 ms the text editor page also pays. NCViewerDirectEditing starts
// NCActivityIndicator in viewDidAppear — after the push animation, ~350-700 ms —
// and stops it in webView:didFinishNavigation:. A page that finishes first makes
// stop() a no-op and the spinner hangs forever. Delaying the response is what
// makes didFinish land after viewDidAppear without any JS tricks; the page's own
// pushState fallback covers the rest.
const IOS_SPINNER_DELAY_MS = 700

// Serves the office editor page NcDirectEditingController's /open points at when
// the client asked for the `onlyoffice` / `eurooffice` editor.
//
// Mounted only when an office document server is enabled (see
// CustomMobileCompatModule) — the same condition that puts the office entry in
// the directEditing catalog. Advertising an editor whose page 404s would put a
// dead-end Edit button in the client, which is worse than no button at all.
//
// Auth model is the text editor's: a `?token=<jwt>` query param minted by /open,
// carrying the full identity. NcBasicAuthGuard is deliberately absent — the host
// webview shares neither the OCS Basic Auth header nor cookies (iOS uses a
// non-persistent website data store).
//
// ContextInterceptor is REQUIRED, not decoration. OnlyOfficeManager builds the
// document url, the callback url and (without an externalServer) the document
// server url itself from `ContextManager.headerOriginUrl()`, which is populated
// per-route by this interceptor and by nothing else. Without it the config comes
// out pointing at `undefined/...` and the editor silently loads nothing.
@Controller()
@AuthTokenSkip()
export class NcOfficeEditorController {
  private readonly logger = new Logger(NcOfficeEditorController.name)

  constructor(
    private readonly directEditing: NcDirectEditingService,
    private readonly resolver: NcOnlyOfficeFileResolver,
    private readonly onlyOfficeManager: OnlyOfficeManager
  ) {}

  // GET /custom-mobile-compat/office-editor?token=…
  //
  // Every failure renders an HTML error page with HTTP 200 rather than a JSON
  // 4xx: the host webview turns a non-200 into its own blank page, so a readable
  // reason has to arrive as a successful body.
  @Get('custom-mobile-compat/office-editor')
  @UseInterceptors(ContextInterceptor)
  async page(@Req() req: FastifyRequest, @Query('token') token: string | undefined, @Res() res: FastifyReply): Promise<FastifyReply> {
    const resolved = await this.resolve(token)
    if ('error' in resolved) return renderError(res, resolved.error)
    const { user, space } = resolved

    // Second layer over the catalog. `getSettings` gates on the wider
    // ONLY_OFFICE_EXTENSIONS set, so without this a client could open a pdf or a
    // diagram through a hand-built url even though we never advertised either.
    const mime = getMimeType(space.realPath, false)
    if (!this.directEditing.isOfficeMime(mime)) {
      return renderError(res, `This file type (${mime.replace('-', '/')}) cannot be opened in the office editor.`)
    }

    // getSettings signs the config, mints the document key, and takes the app
    // lock. It must run HERE and not at /open time — the payload token it embeds
    // expires in 60 seconds, so a config built when the user tapped Edit would
    // already be stale by the time the page loaded.
    let settings: Awaited<ReturnType<OnlyOfficeManager['getSettings']>>
    try {
      settings = await this.onlyOfficeManager.getSettings(user, space, req as never)
    } catch (e) {
      // HttpException from getSettings ('Document not found', 'Document must be
      // a file', 'Document not supported') plus anything unexpected. The reason
      // is logged, not shown — it names server-side paths.
      this.logger.warn({ tag: 'officeEditor.getSettings', msg: `${space.url}: ${e instanceof Error ? e.message : e}` })
      return renderError(res, 'This document could not be opened for editing.')
    }

    await new Promise<void>((resolve) => setTimeout(resolve, IOS_SPINNER_DELAY_MS))

    const html = renderOfficeEditorPage({
      documentServerUrl: settings.documentServerUrl,
      config: settings.config,
      // Read back off the config rather than recomputed, so the browser tab title
      // and the name the editor itself shows can never disagree.
      fileName: settings.config.document?.title ?? ''
    })

    return (
      res
        .header('Content-Type', 'text/html; charset=utf-8')
        // The document server's origin has to be allowed for the api.js script
        // and for the iframe it creates — the two directives upstream's
        // DirectEditor::open widens, and no others.
        .header('Content-Security-Policy', officeEditorCsp(settings.documentServerUrl))
        .header('X-Frame-Options', 'DENY')
        .send(html)
    )
  }

  private async resolve(token: string | undefined): Promise<{ user: UserModel; space: SpaceEnv } | { error: string }> {
    const expired = 'This editor link is invalid or has expired. Open the file again from the app.'
    if (!token) return { error: expired }
    try {
      const claims = await this.directEditing.verifyEditToken(token)
      // Same reconstruction as the text editor and OnlyOfficeStrategy: the token
      // carries the identity so the page costs no user lookup.
      const user = new UserModel(claims.identity)
      const space = await this.resolver.resolve(user, claims.fileId)
      if (!space) return { error: 'This file is no longer available.' }
      return { user, space }
    } catch {
      return { error: expired }
    }
  }
}

function renderError(res: FastifyReply, message: string): FastifyReply {
  return res.header('Content-Type', 'text/html; charset=utf-8').send(renderEditorErrorPageHtml(message))
}
