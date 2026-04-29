import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { OnlyOfficeManager } from '../../files/modules/only-office/only-office-manager.service'
import { OnlyOfficeGuard } from '../../files/modules/only-office/only-office.guard'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcOnlyOfficeFileResolver } from '../services/nc-onlyoffice-file-resolver.service'
import type { NcOnlyOfficeEnvelope } from '../services/nc-onlyoffice-translator.service'
import { NcOnlyOfficeTranslatorService } from '../services/nc-onlyoffice-translator.service'

// NcOnlyOfficeController — exposes the Nextcloud OnlyOffice connector
// protocol so the OnlyOffice Documents mobile app can edit Sync-in files via
// its Nextcloud connection type. Mounted only when
// applications.files.onlyoffice.enabled === true (see
// custom-mobile-compat.module.ts).
//
// /config and /empty and /save run under NcBasicAuthGuard (mobile app
// authenticates with an AUTH_SCOPE.MOBILE_NC app-password). /track is
// authed by OnlyOfficeGuard (token-from-query) because the OnlyOffice
// document server posts back server-to-server with no Basic-Auth — see
// the separate NcOnlyOfficeCallbackController below.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOnlyOfficeController {
  constructor(
    private readonly onlyOfficeManager: OnlyOfficeManager,
    private readonly translator: NcOnlyOfficeTranslatorService,
    private readonly resolver: NcOnlyOfficeFileResolver
  ) {}

  // GET /index.php/apps/onlyoffice/config?fileId=<id>
  //
  // Resolves fileId → personal-space SpaceEnv, asks Sync-in's existing
  // OnlyOfficeManager for the editor config, reshapes into NC's envelope,
  // and rewrites editorConfig.callbackUrl to point at our /track endpoint
  // so the OnlyOffice document server posts back to the NC route (matches
  // the protocol the mobile app expects from a NC plugin deployment). The
  // user-identity JWT under the original `?token=` query param is preserved
  // so OnlyOfficeGuard on /track can re-authenticate the doc-server's
  // server-to-server callback.
  @Get('index.php/apps/onlyoffice/config')
  async config(@Req() req: FastifyRequest & { user: UserModel }, @Query('fileId') fileId?: string): Promise<NcOnlyOfficeEnvelope> {
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

  @Post('index.php/apps/onlyoffice/empty')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  empty(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }

  @Post('index.php/apps/onlyoffice/save')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  save(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }
}

// Separate controller for /track. The OnlyOffice document server posts the
// editor callback server-to-server (no Basic-Auth), so this route is authed
// via OnlyOfficeGuard which extracts a user-identity JWT from `?token=` —
// the same scheme the existing v2 callback at /api/spaces/onlyoffice/callback
// uses. Splitting from NcOnlyOfficeController keeps the auth surface obvious.
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
