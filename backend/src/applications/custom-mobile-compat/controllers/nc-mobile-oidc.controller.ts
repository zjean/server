import { Controller, Get, HttpStatus, Logger, Param, Query, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { configuration } from '../../../configuration/config.environment'
import { NC_ROUTE } from '../constants/routes'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcMobileOidcService } from '../services/nc-mobile-oidc.service'
import { NcResponseService } from '../services/nc-response.service'
import { readFlowCookie } from '../utils/nc-flow-cookie'
import { renderGrantPage } from '../utils/nc-grant-page'
import { escapeHtml, renderHtml } from '../utils/nc-html'

// Mobile OIDC delegation for the Nextcloud Login Flow v2 browser hop.
//
//   GET /custom-mobile/oidc/login/<loginToken>
//     Looks up the in-flight NC mobile flow, builds an authorization URL via
//     NcMobileOidcService, marks the flow oidc-pending (stamping codeVerifier
//     + nonce on the record), and 302s the browser to the IdP.
//
//   GET /custom-mobile/oidc/callback?code&state
//     Authelia returns here. State is the loginToken; we look up the flow,
//     exchange the code, fetch userinfo, and *look up* the matching Sync-in
//     user (no auto-create on mobile — see design doc). On success the user is
//     AUTHENTICATED but not yet authorised: we render the grant page, and only
//     POST /login/v2/grant/<token> mints the AUTH_SCOPE.MOBILE_NC app-password
//     the poll endpoint hands back.
//
// See docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
@Controller()
@AuthTokenSkip()
export class NcMobileOidcController {
  private readonly logger = new Logger(NcMobileOidcController.name)

  constructor(
    private readonly flows: NcLoginFlowService,
    private readonly mobileOidc: NcMobileOidcService,
    private readonly response: NcResponseService
  ) {}

  @Get(NC_ROUTE.MOBILE_OIDC_LOGIN.slice(1))
  async start(@Param('token') loginToken: string, @Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const flow = await this.flows.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') {
      res
        .status(HttpStatus.NOT_FOUND)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(renderHtml({ title: 'Login expired', body: '<h1>Login session expired</h1><p>Please return to the app and start again.</p>' }))
      return
    }

    // This route is reachable directly (it is the href behind the OIDC button,
    // and the target of the autoRedirect 302), so it must re-check the binding
    // rather than assume the flow page set it. A flow whose browser cookie is
    // absent or belongs to another browser must not start an IdP round-trip.
    if (!this.flows.isBoundTo(flow, readFlowCookie(req))) {
      res
        .status(HttpStatus.CONFLICT)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(
          renderHtml({
            title: 'Login already in progress',
            body: '<h1>Login already in progress</h1><p>Open the sign-in link from the app again in this browser.</p>'
          })
        )
      return
    }

    // The OIDC callback URL must match the host the IdP can reach (and the
    // host the maintainer pre-registered with the IdP), which is encoded in
    // `auth.oidc.redirectUri`. That is independent of the mobile-facing host
    // — see NcResponseService.baseUrl. Fall back to the mobile-facing host
    // only when no OIDC redirect URI is configured (which would itself be a
    // misconfiguration, since this controller only mounts when OIDC is on).
    const redirectUri = `${oidcCallbackOrigin(req, this.response)}${NC_ROUTE.MOBILE_OIDC_CALLBACK}`
    const auth = await this.mobileOidc.buildAuthorizationUrl(loginToken, redirectUri)
    await this.flows.markOidcPending(loginToken, { codeVerifier: auth.codeVerifier, nonce: auth.nonce })
    res.redirect(auth.url, HttpStatus.FOUND)
  }

  @Get(NC_ROUTE.MOBILE_OIDC_CALLBACK.slice(1))
  async callback(
    @Query('code') _code: string,
    @Query('state') state: string,
    @Query('error') errorCode: string | undefined,
    @Query('error_description') errorDesc: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string> {
    res.header('Content-Type', 'text/html; charset=utf-8')

    if (errorCode) {
      const detail = errorDesc || errorCode
      return renderHtml({
        title: 'Sign-in cancelled',
        body: `<h1>Sign-in cancelled</h1><p>${escapeHtml(detail)}.</p><p>Return to the app and try again.</p>`
      })
    }

    if (!state) {
      res.status(HttpStatus.BAD_REQUEST)
      return renderHtml({
        title: 'Bad request',
        body: '<h1>Missing state</h1><p>This callback URL is meant to be opened by the identity provider.</p>'
      })
    }

    const flow = await this.flows.findByLoginToken(state)
    if (!flow || flow.status !== 'oidc-pending' || !flow.oidc) {
      res.status(HttpStatus.NOT_FOUND)
      return renderHtml({ title: 'Login expired', body: '<h1>Login session expired</h1><p>Please return to the app and start again.</p>' })
    }

    let user
    try {
      // Forward EVERY query param the IdP sent — not just code+state. Authelia
      // (and any RFC 9207 issuer) returns `iss` on the redirect; openid-client
      // validates it against the discovery's issuer URL during the code
      // exchange. Dropping `iss` causes openid-client to throw OAuth
      // INVALID_RESPONSE. Mirrors the upstream web flow at
      // auth-provider-oidc.service.ts:`callbackParams = new URLSearchParams(query)`.
      const callbackUrl = new URL(`${oidcCallbackOrigin(req, this.response)}${NC_ROUTE.MOBILE_OIDC_CALLBACK}`)
      const reqQuery = (req.query ?? {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(reqQuery)) {
        if (typeof v === 'string') callbackUrl.searchParams.set(k, v)
      }
      user = await this.mobileOidc.exchangeAndResolveUser({
        callbackUrl,
        expectedState: state,
        codeVerifier: flow.oidc.codeVerifier,
        nonce: flow.oidc.nonce
      })
    } catch (e) {
      // openid-client wraps the underlying issue (token endpoint shape, JWT
      // verification, JWKS fetch, etc.) in `e.cause`. Log enough context to
      // diagnose without paging into a debugger.
      const err = e as Error & { code?: string; cause?: unknown }
      const causeMsg = err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : String(err.cause ?? '')
      this.logger.warn({
        tag: this.callback.name,
        msg: `OIDC code exchange failed — ${err.message} [code=${err.code ?? '?'}] cause=${causeMsg}`,
        stack: err.stack
      })
      res.status(HttpStatus.UNAUTHORIZED)
      return renderHtml({
        title: 'Sign-in failed',
        body: '<h1>Sign-in failed</h1><p>Authentication could not be completed. Please return to the app and try again.</p><p class="brand">See server logs for details.</p>'
      })
    }

    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED)
      return renderHtml({
        title: 'No Sync-in account',
        body: '<h1>No Sync-in account</h1><p>The identity provider authenticated you, but you don’t have a Sync-in account yet. Please sign in to the Sync-in web app once first, then return to the mobile app and try again.</p>'
      })
    }

    // Authenticated by the IdP — NOT yet authorised for this client.
    //
    // This is the exact point the silent-authorisation hole lived: with
    // `autoRedirect` on and a live IdP session, everything from the victim
    // opening a planted link to a minted app password happened with zero user
    // interaction, and whoever started the flow collected the credential from
    // the poll endpoint. The IdP proving who the user is says nothing about
    // whether they meant to pair THIS app, so the mint moves behind an explicit
    // grant. `markAuthenticated` also re-checks the browser binding, so a
    // callback replayed from another browser stops here.
    const grantToken = await this.flows.markAuthenticated(state, user, readFlowCookie(req))
    if (!grantToken) {
      res.status(HttpStatus.CONFLICT)
      return renderHtml({
        title: 'Login already in progress',
        body: '<h1>Login already in progress</h1><p>Open the sign-in link from the app again in this browser.</p>'
      })
    }

    return renderHtml({
      title: 'Authorize the app',
      body: renderGrantPage(state, grantToken, user.login, flow.clientName)
    })
  }
}

// Pick the origin to mount the OIDC callback path under. Reads
// `auth.oidc.redirectUri` directly — that origin is the one registered with
// the IdP and the one the IdP can reach (which the mobile-facing host may
// or may not be). Falls back to the mobile-facing host only when no OIDC
// redirect is configured — defensive, since this controller only mounts on
// OIDC-enabled deployments.
function oidcCallbackOrigin(req: FastifyRequest, response: NcResponseService): string {
  const redirectUri = configuration.auth?.oidc?.redirectUri
  if (redirectUri) return new URL(redirectUri).origin
  return response.baseUrl(req)
}
