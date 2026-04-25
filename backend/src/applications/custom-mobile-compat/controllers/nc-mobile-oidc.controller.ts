import { Controller, Get, HttpStatus, Param, Query, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UsersManager } from '../../users/services/users-manager.service'
import { NC_ROUTE } from '../constants/routes'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcMobileOidcService } from '../services/nc-mobile-oidc.service'
import { NcResponseService } from '../services/nc-response.service'
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
//     user (no auto-create on mobile — see design doc). On success, mints an
//     AUTH_SCOPE.MOBILE_NC app-password and stashes it on the flow so the
//     mobile app's poll endpoint can collect it.
//
// See docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
@Controller()
@AuthTokenSkip()
export class NcMobileOidcController {
  constructor(
    private readonly flows: NcLoginFlowService,
    private readonly mobileOidc: NcMobileOidcService,
    private readonly usersManager: UsersManager,
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
    @Query('code') code: string,
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
      const callbackUrl = new URL(`${this.response.baseUrl(req)}${NC_ROUTE.MOBILE_OIDC_CALLBACK}`)
      callbackUrl.searchParams.set('code', code)
      callbackUrl.searchParams.set('state', state)
      user = await this.mobileOidc.exchangeAndResolveUser({
        callbackUrl,
        expectedState: state,
        codeVerifier: flow.oidc.codeVerifier,
        nonce: flow.oidc.nonce
      })
    } catch (e) {
      res.status(HttpStatus.UNAUTHORIZED)
      const detail = e instanceof Error ? e.message : 'OIDC error'
      return renderHtml({ title: 'Sign-in failed', body: `<h1>Sign-in failed</h1><p>${escapeHtml(detail)}.</p>` })
    }

    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED)
      return renderHtml({
        title: 'No Sync-in account',
        body: '<h1>No Sync-in account</h1><p>The identity provider authenticated you, but you don’t have a Sync-in account yet. Please sign in to the Sync-in web app once first, then return to the mobile app and try again.</p>'
      })
    }

    const tokenShort = state.slice(0, 8)
    const appPwd = await this.usersManager.generateAppPassword(user, {
      name: `mobile ${tokenShort}`,
      app: AUTH_SCOPE.MOBILE_NC,
      expiration: null
    } as never)

    this.flows.completeWithCredentials(state, {
      server: this.response.baseUrl(req),
      loginName: user.login,
      appPassword: appPwd.password
    })

    return renderHtml({
      title: 'Signed in',
      body: '<h1>All set!</h1><p>You can return to the app — it will finish signing in automatically.</p>'
    })
  }
}
