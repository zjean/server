import { Body, Controller, Get, HttpException, HttpStatus, Logger, Param, Post, Query, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { AUTH_PROVIDER } from '../../../authentication/providers/auth-providers.constants'
import { configuration } from '../../../configuration/config.environment'
import { UsersManager } from '../../users/services/users-manager.service'
import { NC_ROUTE } from '../constants/routes'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcResponseService } from '../services/nc-response.service'
import { escapeHtml, renderHtml, renderNcSuccessBody } from '../utils/nc-html'

// NC Login Flow v2 — the 3-step authentication dance used by Nextcloud's
// mobile apps.
//
//   1. POST /index.php/login/v2        (the app calls this)
//      → { poll: {token, endpoint}, login: <browser URL> }
//   2. User opens <browser URL> → our login page → posts back → we mint an
//      AUTH_SCOPE.MOBILE_NC app password and stash it on the flow.
//   3. POST /index.php/login/v2/poll   (the app polls until ready)
//      → 404 while pending, once 200 with { server, loginName, appPassword }
//
// See https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html

@Controller()
@AuthTokenSkip()
export class NcLoginV2Controller {
  private readonly logger = new Logger(NcLoginV2Controller.name)

  constructor(
    private readonly flows: NcLoginFlowService,
    private readonly usersManager: UsersManager,
    private readonly appPasswords: NcAppPasswordService,
    private readonly response: NcResponseService
  ) {}

  // Step 1 — app initiates
  @Post(NC_ROUTE.LOGIN_V2.slice(1))
  initiate(@Req() req: FastifyRequest): { poll: { token: string; endpoint: string }; login: string } {
    const base = this.response.baseUrl(req)
    const flow = this.flows.initiate()
    return {
      poll: {
        token: flow.pollToken,
        // Advertise the canonical (no `/index.php/` prefix) form so our JSON
        // byte-matches upstream. Both routes are mounted; this is purely
        // about which one we hand the client.
        endpoint: `${base}${NC_ROUTE.LOGIN_V2_POLL_ALT}`
      },
      login: `${base}/login/v2/flow/${flow.loginToken}`
    }
  }

  // Step 3 — app polls (404 while pending, 200 once ready — returned only once)
  //
  // Mounted at both /index.php/login/v2/poll (what docs advertise) and
  // /login/v2/poll (what some iOS/Android versions hit instead).
  //
  // The token can arrive in any of three forms — Nextcloud's own clients
  // disagree across platforms and versions:
  //   - form-urlencoded body  (`token=…`)              — Android, NC desktop
  //   - JSON body              (`{"token":"…"}`)        — some iOS builds
  //   - query string           (`?token=…`)             — NC iOS ≥ 33.x
  // We accept whichever the client sends.
  @Post(NC_ROUTE.LOGIN_V2_POLL.slice(1))
  async pollCanonical(@Body() body: PollBody, @Query('token') queryToken: string | undefined, @Res() res: FastifyReply): Promise<void> {
    return this.doPoll(body, queryToken, res)
  }

  @Post(NC_ROUTE.LOGIN_V2_POLL_ALT.slice(1))
  async pollAlt(@Body() body: PollBody, @Query('token') queryToken: string | undefined, @Res() res: FastifyReply): Promise<void> {
    return this.doPoll(body, queryToken, res)
  }

  // Step 2a — browser GETs the login page.
  //
  // Dispatches by `auth.provider`:
  //   - non-oidc                          → render the local username/password form
  //   - oidc + autoRedirect               → 302 to /custom-mobile/oidc/login/<token>
  //   - oidc + button mode (autoRedirect=false) → render an "OIDC button" page;
  //     local form is included beneath when oidc.options.enablePasswordAuth is true
  //     (admins / guests / app-passwords still go through the local form)
  @Get(NC_ROUTE.LOGIN_V2_FLOW.slice(1))
  renderLoginPage(@Param('token') loginToken: string, @Res({ passthrough: true }) res: FastifyReply): string {
    const flow = this.flows.findByLoginToken(loginToken)
    if (!flow) {
      res.status(HttpStatus.NOT_FOUND).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Login expired',
        body: '<h1>Login session expired</h1><p>Please return to the app and start again.</p>'
      })
    }
    if (flow.status !== 'pending') {
      res.header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Already authorized',
        body: '<h1>All set!</h1><p>You can return to the app — it will finish signing in automatically.</p>'
      })
    }

    const provider = configuration.auth?.provider
    if (provider === AUTH_PROVIDER.OIDC) {
      const opts = configuration.auth.oidc?.options ?? ({} as Record<string, unknown>)
      if (opts.autoRedirect) {
        res.redirect(`/custom-mobile/oidc/login/${loginToken}`, HttpStatus.FOUND)
        // Empty body: the 302 + Location header is what the browser follows.
        return ''
      }
      res.header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Sign in to Sync-in',
        body: renderOidcButtonPage(loginToken, (opts.buttonText as string) || 'Continue with OpenID Connect', !!opts.enablePasswordAuth)
      })
    }

    res.header('Content-Type', 'text/html; charset=utf-8')
    return renderHtml({
      title: 'Sign in to Sync-in',
      body: renderLoginForm(loginToken)
    })
  }

  // Step 2b — browser POSTs credentials
  @Post(NC_ROUTE.LOGIN_V2_FLOW.slice(1))
  async submitLoginPage(
    @Param('token') loginToken: string,
    @Body() body: LoginFormBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<string> {
    const flow = this.flows.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') {
      res.status(HttpStatus.NOT_FOUND).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Login expired',
        body: '<h1>Login session expired</h1><p>Please return to the app and start again.</p>'
      })
    }

    const login = (body?.login ?? '').trim()
    const password = body?.password ?? ''
    if (!login || !password) {
      res.status(HttpStatus.BAD_REQUEST).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Sign in to Sync-in',
        body: renderLoginForm(loginToken, 'Login and password are required.')
      })
    }

    const user = await this.usersManager.findUser(login, false)
    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Sign in to Sync-in',
        body: renderLoginForm(loginToken, 'Invalid credentials.')
      })
    }

    const ip = clientIp(req)
    const authed = await this.usersManager.logUser(user, password, ip)
    if (!authed) {
      res.status(HttpStatus.UNAUTHORIZED).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Sign in to Sync-in',
        body: renderLoginForm(loginToken, 'Invalid credentials.')
      })
    }

    // Bound MOBILE_NC row growth, then mint. Same protective wrapper as the
    // OIDC callback path: a DB error or name-collision race here used to
    // bubble out as a Nest JSON 500 envelope, which iOS surfaces as a
    // generic "Fout" alert because the flow stays pending and polling
    // eventually times out.
    let creds: { server: string; loginName: string; appPassword: string }
    try {
      await this.appPasswords.pruneMobileAppPasswords(authed)
      const tokenShort = loginToken.slice(0, 8)
      const appPwd = await this.usersManager.generateAppPassword(authed, {
        name: `mobile ${tokenShort}`,
        app: AUTH_SCOPE.MOBILE_NC,
        expiration: null
      } as never)
      creds = {
        server: this.response.baseUrl(req),
        loginName: authed.login,
        appPassword: appPwd.password
      }
      this.flows.completeWithCredentials(loginToken, creds)
    } catch (e) {
      const err = e as Error
      this.logger.warn({
        tag: this.submitLoginPage.name,
        msg: `app-password mint or flow completion failed — ${err.message}`,
        stack: err.stack
      })
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).header('Content-Type', 'text/html; charset=utf-8')
      return renderHtml({
        title: 'Sign-in failed',
        body: `<h1>Sign-in failed</h1><p>${escapeHtml(err.message)}.</p><p class="brand">See server logs for full diagnostic.</p>`
      })
    }

    res.header('Content-Type', 'text/html; charset=utf-8')
    const success = renderNcSuccessBody(creds)
    return renderHtml({ title: 'Signed in', body: success.body, headExtras: success.headExtras })
  }

  private async doPoll(body: PollBody, queryToken: string | undefined, res: FastifyReply): Promise<void> {
    const token = readPollToken(body) ?? (queryToken && queryToken.length > 0 ? queryToken : null)
    if (!token) {
      throw new HttpException('missing token', HttpStatus.BAD_REQUEST)
    }
    const creds = this.flows.consumeByPollToken(token)
    if (!creds) {
      // NC protocol: 404 while pending + after consumption — match real NC server's
      // shape (empty `[]` JSON body). NC iOS rejects 404 + the default Nest
      // `{statusCode,message,error}` envelope as "invalid response".
      res.status(HttpStatus.NOT_FOUND).header('Content-Type', 'application/json; charset=utf-8').send('[]')
      return
    }
    res.status(HttpStatus.OK).header('Content-Type', 'application/json; charset=utf-8').send(creds)
  }
}

interface PollBody {
  token?: string
}

interface LoginFormBody {
  login?: string
  password?: string
}

// NC clients send the poll token as form-urlencoded (token=...) but some send
// JSON. Accept both.
function readPollToken(body: unknown): string | null {
  if (typeof body === 'string') {
    const m = /(?:^|&)token=([^&]+)/.exec(body)
    return m ? decodeURIComponent(m[1]) : null
  }
  if (body && typeof body === 'object' && 'token' in body) {
    const v = (body as Record<string, unknown>).token
    return typeof v === 'string' ? v : null
  }
  return null
}

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'] as string | undefined
  if (fwd) return fwd.split(',')[0].trim()
  return (req.ip as string | undefined) ?? 'unknown'
}

function renderLoginForm(loginToken: string, errorMsg?: string): string {
  const safeToken = escapeHtml(loginToken)
  const err = errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ''
  return `<h1>Sign in to Sync-in</h1>
<p>Authorize the mobile app to access your account.</p>
<form method="post" action="/login/v2/flow/${safeToken}" autocomplete="on">
  <label for="login">Username or email</label>
  <input id="login" name="login" type="text" required autofocus autocomplete="username" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password" />
  ${err}
  <button type="submit">Grant access</button>
</form>
<div class="brand">Sync-in · Nextcloud-compatible login</div>`
}

function renderOidcButtonPage(loginToken: string, buttonText: string, includePasswordForm: boolean): string {
  const safeToken = escapeHtml(loginToken)
  const safeText = escapeHtml(buttonText)
  const oidcLink = `<a class="btn" href="/custom-mobile/oidc/login/${safeToken}">${safeText}</a>`
  const passwordSection = includePasswordForm
    ? `<div class="divider">or sign in with a password</div>
<form method="post" action="/login/v2/flow/${safeToken}" autocomplete="on">
  <label for="login">Username or email</label>
  <input id="login" name="login" type="text" required autocomplete="username" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password" />
  <button type="submit">Grant access</button>
</form>`
    : ''
  return `<h1>Sign in to Sync-in</h1>
<p>Authorize the mobile app to access your account.</p>
${oidcLink}
${passwordSection}
<div class="brand">Sync-in · Nextcloud-compatible login</div>`
}
