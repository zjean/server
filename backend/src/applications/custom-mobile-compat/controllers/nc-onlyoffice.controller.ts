import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Logger, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { OnlyOfficeManager } from '../../files/editors/only-office/only-office-manager.service'
import { OnlyOfficeGuard } from '../../files/editors/only-office/only-office.guard'
import { FilesManager } from '../../files/services/files-manager.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcOnlyOfficeFileResolver } from '../services/nc-onlyoffice-file-resolver.service'
import { NcOnlyOfficeForceSaveService } from '../services/nc-onlyoffice-force-save.service'
import type { NcOnlyOfficeEnvelope } from '../services/nc-onlyoffice-translator.service'
import { NcOnlyOfficeTranslatorService } from '../services/nc-onlyoffice-translator.service'

// Extensions advertised in capabilities.ts files.onlyoffice.templates. Mobile
// app should only call /empty for these; we gate defensively in case of
// drift or a custom client.
const TEMPLATE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx'])

// NcOnlyOfficeController — exposes the Nextcloud OnlyOffice connector
// protocol so the OnlyOffice Documents mobile app can edit Sync-in files via
// its Nextcloud connection type. Mounted when either
// applications.files.editors.onlyoffice.enabled or
// applications.files.editors.eurooffice.enabled is true (see
// custom-mobile-compat.module.ts) — OnlyOfficeManager picks whichever document
// server is configured, so these handlers are editor-agnostic and the route
// prefix stays the upstream NC app id `onlyoffice` (see constants/routes.ts).
//
// /config and /empty and /save run under NcBasicAuthGuard (mobile app
// authenticates with an AUTH_SCOPE.MOBILE_NC app-password). /track is
// authed by OnlyOfficeGuard (token-from-query) because the OnlyOffice
// document server posts back server-to-server with no Basic-Auth — see
// the separate NcOnlyOfficeCallbackController below.
//
// THE STOCK NC CLIENTS DO NOT SPEAK TO THESE ROUTES. U2 of
// docs/plans/2026-05-28-nc-mobile-compat-u1-u2-u3-verification.md is answered
// from source instead of from a device: nextcloud/ios, nextcloud/android and
// nextcloud/NextcloudKit contain no reference to `apps/onlyoffice` anywhere. iOS
// reaches an office editor only through the directEditing catalog
// (NCViewer.swift's DOCUMENTS branch) or richdocuments, and Android likewise. So
// this fork serves office editing to them through NcDirectEditingService's
// catalog entry and NcOfficeEditorController — not through this connector.
//
// Two things that remain true and are why these routes stay:
//   - The ONLYOFFICE Documents mobile apps connect to a Nextcloud account as a
//     WebDAV storage (the URL their help pages give is /remote.php/webdav/) and
//     edit in their own embedded editor, so they never reach a doc-server
//     connector either. Any client that does arrive here is speaking the
//     connector protocol deliberately.
//   - Only /track corresponds to a route the real connector serves. See the
//     route table in constants/routes.ts.
//
// One latent gap, deliberately left alone here: /config calls
// OnlyOfficeManager.getSettings without declaring ContextInterceptor, so
// `headerOriginUrl()` is undefined and the urls in the config come out malformed.
// It has never surfaced because no client calls the route. Fixing it is a
// one-line decorator, out of scope for #369.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOnlyOfficeController {
  // Audit U2: instrumentation so a device session reveals whether iOS's
  // "Edit with OnlyOffice" affordance routes through the connector here or
  // through /ocs/v2.php/apps/files/api/v1/directEditing/open. Correlate the
  // /config log line below with NcDirectEditingController.open by timestamp.
  // Remove once U2 is resolved.
  private readonly logger = new Logger(NcOnlyOfficeController.name)

  constructor(
    private readonly onlyOfficeManager: OnlyOfficeManager,
    private readonly translator: NcOnlyOfficeTranslatorService,
    private readonly resolver: NcOnlyOfficeFileResolver,
    private readonly filesManager: FilesManager,
    private readonly forceSave: NcOnlyOfficeForceSaveService
  ) {}

  // GET /index.php/apps/onlyoffice/config?fileId=<id>
  //
  // Resolves fileId → personal-space SpaceEnv, asks Sync-in's existing
  // OnlyOfficeManager for the editor config, reshapes into NC's envelope, and
  // rewrites editorConfig.callbackUrl to point at our /track endpoint. The
  // user-identity JWT under the original `?token=` query param is preserved so
  // OnlyOfficeGuard on /track can re-authenticate the doc-server's
  // server-to-server callback.
  //
  // The rewrite is a FALLBACK, not the normal path — a document server with a
  // secret configured takes the callback URL from the signed token instead. See
  // rewriteCallbackUrl at the bottom of this file.
  @Get('index.php/apps/onlyoffice/config')
  async config(@Req() req: FastifyRequest & { user: UserModel }, @Query('fileId') fileId?: string): Promise<NcOnlyOfficeEnvelope> {
    this.logger.log({
      tag: 'onlyoffice.config',
      msg: `user ${req.user.id} (${req.user.login}) fileId=${fileId ?? '-'} ua=${req.headers['user-agent'] ?? '-'}`
    })
    const id = Number.parseInt(fileId ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) {
      throw new HttpException('fileId required', HttpStatus.BAD_REQUEST)
    }
    const space = await this.resolver.resolve(req.user, id)
    if (!space) {
      throw new HttpException('file not found', HttpStatus.NOT_FOUND)
    }
    // OnlyOfficeManager.getSettings only reads req.headers['user-agent'] — a
    // FastifyRequest is structurally compatible with the FastifySpaceRequest
    // it expects. The cast is intentional: we don't carry a SpaceEnv on the
    // request like the spaces-controller decorators do.
    const synci = await this.onlyOfficeManager.getSettings(req.user, space, req as any)
    const env = this.translator.toNcEnvelope(synci)
    if (env.editorConfig.callbackUrl) {
      env.editorConfig.callbackUrl = rewriteCallbackUrl(env.editorConfig.callbackUrl, id)
    }
    return env
  }

  // POST /index.php/apps/onlyoffice/empty?fileId=<parentId>&name=<filename>
  //
  // Creates a new document inside the parent folder. Reuses the upstream
  // FilesManager.mkFile sample-template path (third arg `checkDocument=true`
  // copies a pre-shipped .docx/.xlsx/.pptx skeleton when the extension matches
  // DOCUMENT_TYPE) — same path the classic UI's "Create new document" hits.
  //
  // Returns minimal metadata: `{ name }`. The mobile app refreshes its file
  // listing to discover the new file's id, then immediately re-enters /config
  // with that id. Returning the id here would require a second DB lookup
  // because mkFile-emitted FileEvents are buffered/async; the refresh path is
  // simpler and matches how the classic UI handles new-doc creation.
  @Post('index.php/apps/onlyoffice/empty')
  async empty(
    @Req() req: FastifyRequest & { user: UserModel },
    @Query('fileId') parentId?: string,
    @Query('name') name?: string
  ): Promise<{ name: string }> {
    const pid = Number.parseInt(parentId ?? '', 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new HttpException('fileId required', HttpStatus.BAD_REQUEST)
    }
    if (!name) {
      throw new HttpException('name required', HttpStatus.BAD_REQUEST)
    }
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    if (!TEMPLATE_EXTENSIONS.has(ext)) {
      throw new HttpException(`unsupported template extension: ${ext}`, HttpStatus.BAD_REQUEST)
    }
    const space = await this.resolver.resolveChild(req.user, pid, name)
    if (!space) {
      throw new HttpException('parent not found', HttpStatus.NOT_FOUND)
    }
    // checkDocument=true triggers sample-template copy in mkFile when the
    // extension matches DOCUMENT_TYPE (docx/xlsx/pptx are all included).
    await this.filesManager.mkFile(req.user, space, false, true, true)
    return { name }
  }

  // POST /index.php/apps/onlyoffice/save?fileId=<id>
  //
  // NC mobile posts here when the user explicitly hits Save. Issues a
  // `forcesave` command to the OnlyOffice document server, which immediately
  // re-invokes the editor callback with status 6 — that's the path real
  // persistence runs through, and it reaches OnlyOfficeManager.callBack whether
  // the doc server posts to /track here or to the upstream
  // /api/spaces/onlyoffice/callback route (see rewriteCallbackUrl). Either way
  // the save is versioned: callBack's status-6 arm is one of the four that reach
  // saveDocument, and saveDocument snapshots before it copies. Without this,
  // edits sit in the doc server's
  // memory until autosave fires (default 1–2 minutes), which produces a
  // surprising window of lost edits if the mobile session is interrupted
  // right after the user pressed Save.
  //
  // Returns the OnlyOffice protocol envelope shape; the mobile app gates
  // its UI feedback on `status === 'ok'`. Errors are surfaced with a reason
  // string for debugging but the mobile UX is the same either way.
  @Post('index.php/apps/onlyoffice/save')
  @HttpCode(HttpStatus.OK)
  async save(
    @Req() req: FastifyRequest & { user: UserModel },
    @Query('fileId') fileId?: string
  ): Promise<{ status: 'ok' | 'error'; reason?: string }> {
    const id = Number.parseInt(fileId ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) {
      return { status: 'error', reason: 'fileId required' }
    }
    const space = await this.resolver.resolve(req.user, id)
    if (!space) {
      return { status: 'error', reason: 'file not found' }
    }
    const result = await this.forceSave.forceSave(space)
    return result.ok ? { status: 'ok' } : { status: 'error', reason: result.reason }
  }
}

// Separate controller for /track. The OnlyOffice document server posts the
// editor callback server-to-server (no Basic-Auth), so this route is authed
// via OnlyOfficeGuard which extracts a user-identity JWT from `?token=` —
// the same scheme the existing v2 callback at /api/spaces/onlyoffice/callback
// uses. Splitting from NcOnlyOfficeController keeps the auth surface obvious.
//
// Expect this route to be COLD on a normal deployment: the document server
// derives the callback URL from the signed token, which still carries the
// upstream /api/spaces/onlyoffice/callback URL (see rewriteCallbackUrl). It is
// kept as the fallback for a server that honours the request body instead, and
// because both routes converge on the same OnlyOfficeManager.callBack — so the
// save, its lock handling and its version snapshot are identical either way.
// If you are debugging "my mobile edits are not saving", tail the UPSTREAM
// callback route first.
@Controller()
@AuthTokenSkip()
export class NcOnlyOfficeCallbackController {
  constructor(
    private readonly onlyOfficeManager: OnlyOfficeManager,
    private readonly resolver: NcOnlyOfficeFileResolver
  ) {}

  // POST /index.php/apps/onlyoffice/track?fileId=<id>&token=<userJwt>
  //
  // Body shape (set by OnlyOffice doc server): `{ token, status, url?, users?, actions?, notmodified? }`
  // where `body.token` is the OnlyOffice payload JWT (signed with the
  // applications.files.onlyoffice.secret) and the query `token` is the
  // user-identity JWT (signed with auth.token.access.secret) that
  // OnlyOfficeStrategy validates into req.user.
  //
  // Returns the OnlyOffice protocol envelope `{ error: 0 }` on success or
  // `{ error: <reason> }` on failure — always HTTP 200, the doc server
  // gates retry on the body, not the status code.
  @Post('index.php/apps/onlyoffice/track')
  @UseGuards(OnlyOfficeGuard)
  @HttpCode(HttpStatus.OK)
  async track(
    @Req() req: FastifyRequest & { user: UserModel },
    @Query('fileId') fileId: string | undefined,
    @Body() body: { token?: string }
  ): Promise<{ error: number | string }> {
    const id = Number.parseInt(fileId ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) return { error: 'fileId required' }
    const space = await this.resolver.resolve(req.user, id)
    if (!space) return { error: 'file not found' }
    if (!body?.token) return { error: 'callback token required' }
    return this.onlyOfficeManager.callBack(req.user, space, body.token)
  }
}

// Rewrite the `?token=`-bearing callback URL Sync-in's OnlyOfficeManager
// built (path: /api/spaces/onlyoffice/callback/<spaceUrl>) to point at our
// NC-shaped /track endpoint, preserving the same user token. Origin and
// query token are kept identical so the OnlyOfficeGuard validation works
// with no extra plumbing.
//
// KNOWN TO BE INEFFECTIVE ON A NORMAL DEPLOYMENT, and left in place rather than
// removed. `OnlyOfficeManager.getSettings` signs the config BEFORE this runs
// (`config.config.token = await this.genPayloadToken(config.config)`), and the
// document server reads the callback URL out of that signature, not out of the
// body: DocsCoServer.js's `fillDataFromJwt` does
// `data.documentCallbackUrl = edit.callbackUrl` from the DECODED token, and
// `validateAuthToken` rejects the session outright if the body carries a
// callbackUrl the token lacks. `secret` is @IsNotEmpty whenever an editor is
// enabled (only-office.config.ts), so there is no supported configuration in
// which the token is absent.
//
// Two reasons not to "fix" it by re-signing here: it would put a second
// config-signing site in the fork, and the upstream callback route this
// currently falls through to is a real, working, versioning route — so the
// rewrite failing costs nothing. Removing it, by contrast, would be a bet
// against every doc-server build we cannot test here, and losing that bet loses
// a user's edits. Its spec pins the mismatch so nobody re-signs by accident.
function rewriteCallbackUrl(originalCallbackUrl: string, fileId: number): string {
  try {
    const orig = new URL(originalCallbackUrl)
    const userToken = orig.searchParams.get('token')
    if (!userToken) return originalCallbackUrl
    const next = new URL('/index.php/apps/onlyoffice/track', orig.origin)
    next.searchParams.set('fileId', String(fileId))
    next.searchParams.set('token', userToken)
    return next.toString()
  } catch {
    // Malformed URL — leave as-is; the doc server will surface the failure.
    return originalCallbackUrl
  }
}
