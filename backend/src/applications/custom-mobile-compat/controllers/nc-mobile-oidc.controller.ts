import { Controller, Get, HttpStatus, Logger, Param, Query, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { NC_ROUTE } from '../constants/routes'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcMobileOidcService } from '../services/nc-mobile-oidc.service'
import { NcResponseService } from '../services/nc-response.service'
import { escapeHtml, renderHtml, renderNcSuccessBody } from '../utils/nc-html'

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
//     user (no auto-create on mobile — see design doc). On success, mints an
//     AUTH_SCOPE.MOBILE_NC app-password and stashes it on the flow so the
//     mobile app's poll endpoint can collect it.
//
// See docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
@Controller()
@AuthTokenSkip()
export class NcMobileOidcController {
  private readonly logger = new Logger(NcMobileOidcController.name)

  constructor(
    private readonly flows: NcLoginFlowService,
    private readonly mobileOidc: NcMobileOidcService,
    private readonly appPasswords: NcAppPasswordService,
    private readonly response: NcResponseService
  ) {}

  @Get(NC_ROUTE.MOBILE_OIDC_LOGIN.slice(1))
  async start(@Param('token') loginToken: string, @Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const flow = this.flows.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') {
      res
        .status(HttpStatus.NOT_FOUND)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(renderHtml({ title: 'Login expired', body: '<h1>Login session expired</h1><p>Please return to the app and start again.</p>' }))
      return
    }

    const redirectUri = `${this.response.baseUrl(req)}${NC_ROUTE.MOBILE_OIDC_CALLBACK}`
    const auth = await this.mobileOidc.buildAuthorizationUrl(loginToken, redirectUri)
    this.flows.markOidcPending(loginToken, { codeVerifier: auth.codeVerifier, nonce: auth.nonce })
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

    const flow = this.flows.findByLoginToken(state)
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
      const callbackUrl = new URL(`${this.response.baseUrl(req)}${NC_ROUTE.MOBILE_OIDC_CALLBACK}`)
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
      const detail = err.message
      const causeLine = causeMsg ? `<p>Cause: ${escapeHtml(causeMsg)}</p>` : ''
      return renderHtml({
        title: 'Sign-in failed',
        body: `<h1>Sign-in failed</h1><p>${escapeHtml(detail)}.</p>${causeLine}<p class="brand">See server logs for full diagnostic.</p>`
      })
    }

    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED)
      return renderHtml({
        title: 'No Sync-in account',
        body: '<h1>No Sync-in account</h1><p>The identity provider authenticated you, but you don’t have a Sync-in account yet. Please sign in to the Sync-in web app once first, then return to the mobile app and try again.</p>'
      })
    }

    // Bound MOBILE_NC row growth, then mint. Both calls inside the same
    // catch — if either fails (DB error, name-collision race, write
    // rejection), we render a useful HTML error instead of letting the
    // exception escape to Nest's default JSON envelope (which the in-app
    // browser surfaces as a generic "Fout" alert because the flow stays
    // oidc-pending and iOS keeps polling until it times out).
    let creds: { server: string; loginName: string; appPassword: string }
    try {
      await this.appPasswords.pruneMobileAppPasswords(user)
      const tokenShort = state.slice(0, 8)
      const appPwd = await this.appPasswords.mintMobileAppPassword(user, `mobile ${tokenShort}`)
      creds = {
        server: this.response.baseUrl(req),
        loginName: user.login,
        appPassword: appPwd.password
      }
      this.flows.completeWithCredentials(state, creds)
    } catch (e) {
      const err = e as Error
      this.logger.warn({
        tag: this.callback.name,
        msg: `app-password mint or flow completion failed — ${err.message}`,
        stack: err.stack
      })
      res.status(HttpStatus.INTERNAL_SERVER_ERROR)
      return renderHtml({
        title: 'Sign-in failed',
        body: `<h1>Sign-in failed</h1><p>${escapeHtml(err.message)}.</p><p class="brand">See server logs for full diagnostic.</p>`
      })
    }

    const success = renderNcSuccessBody(creds)
    return renderHtml({ title: 'Signed in', body: success.body, headExtras: success.headExtras })
  }
}
