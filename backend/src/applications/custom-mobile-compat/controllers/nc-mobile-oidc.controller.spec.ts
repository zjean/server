import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { ThrottlerException } from '@nestjs/throttler'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NC_RATE_LIMIT_OPTIONS } from '../constants/rate-limit'
import { NcRateLimitGuard } from '../guards/nc-rate-limit.guard'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcMobileOidcService } from '../services/nc-mobile-oidc.service'
import { NcResponseService } from '../services/nc-response.service'
import { clearLoginFlows, createInMemoryCache } from '../utils/nc-cache.fixture'
import { NcMobileOidcController } from './nc-mobile-oidc.controller'
import { Mock } from 'vitest'

// Prevent the real `openid-client` ES module from being evaluated when the
// service file is imported as a DI token below — we never call into it (the
// service is mocked via `useValue`).
vi.mock('openid-client', () => ({}))

// Pin the OIDC config so the controller's oidcCallbackOrigin helper returns
// a known origin regardless of which environment.yaml the test runner picked
// up (the dist file ships sync-in.domain.com; local devs sometimes have
// nothing set — both should give the same redirect_uri assertion).
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    auth: { oidc: { redirectUri: 'https://sync-in.oidc.test/api/auth/oidc/callback' } }
  }
}))

describe(NcMobileOidcController.name, () => {
  let moduleRef: TestingModule
  let controller: NcMobileOidcController
  let flows: NcLoginFlowService
  let mobileOidc: { buildAuthorizationUrl: Mock; exchangeAndResolveUser: Mock }
  let usersManager: { generateAppPassword: Mock }
  let appPasswords: { pruneMobileAppPasswords: Mock; mintMobileAppPassword: Mock }

  function fakeReq(query?: Record<string, string>, cookie?: string): FastifyRequest {
    const headers: Record<string, string> = { host: 'sync-in.example.test', 'x-forwarded-proto': 'https' }
    if (cookie) headers.cookie = `nc_login_flow=${encodeURIComponent(cookie)}`
    return { headers, query: query ?? {} } as unknown as FastifyRequest
  }

  // A flow whose browser-binding cookie has been established, as it would be
  // after the browser GET /login/v2/flow/<token> that precedes every OIDC hop.
  async function boundFlow() {
    const flow = await flows.initiate('Nextcloud-iOS/33.1')
    const cookie = (await flows.bindBrowser(flow.loginToken, undefined)) as string
    return { flow, cookie }
  }
  function fakeRes() {
    const res: Partial<FastifyReply> & { _status?: number; _body?: string; _redirected?: string } = {
      header: vi.fn().mockReturnThis() as never,
      status: vi.fn(function (this: FastifyReply, n: number) {
        ;(this as never as { _status: number })._status = n
        return this
      }) as never,
      send: vi.fn(function (this: FastifyReply, body: string) {
        ;(this as never as { _body: string })._body = body
        return this
      }) as never,
      redirect: vi.fn(function (this: FastifyReply, url: string) {
        ;(this as never as { _redirected: string })._redirected = url
        return this
      }) as never
    }
    return res as FastifyReply & { _status?: number; _body?: string; _redirected?: string }
  }

  beforeAll(async () => {
    mobileOidc = { buildAuthorizationUrl: vi.fn(), exchangeAndResolveUser: vi.fn() }
    usersManager = { generateAppPassword: vi.fn() }
    appPasswords = { pruneMobileAppPasswords: vi.fn().mockResolvedValue(0), mintMobileAppPassword: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcMobileOidcController],
      providers: [
        NcLoginFlowService,
        // A working in-memory Cache: the flow store lives there now (#482).
        { provide: Cache, useValue: createInMemoryCache() },
        // Stub baseUrl() so tests are independent of local OIDC config presence.
        {
          provide: NcResponseService,
          useValue: { baseUrl: vi.fn().mockReturnValue('https://sync-in.example.test'), json: vi.fn(), requireJson: vi.fn() }
        },
        { provide: NcMobileOidcService, useValue: mobileOidc },
        { provide: UsersManager, useValue: usersManager },
        { provide: NcAppPasswordService, useValue: appPasswords }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcMobileOidcController)
    flows = moduleRef.get(NcLoginFlowService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(async () => {
    await clearLoginFlows(moduleRef.get(Cache))
    vi.clearAllMocks()
  })

  describe('start (initiate OIDC redirect)', () => {
    it('returns 404 HTML for an unknown loginToken', async () => {
      const res = fakeRes()
      await controller.start('does-not-exist', fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(res._body).toContain('Login expired')
    })

    it('returns 404 HTML when the flow is not in pending state', async () => {
      const flow = await flows.initiate()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
      const res = fakeRes()
      await controller.start(flow.loginToken, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
    })

    it('refuses to start an IdP round-trip for an unbound browser', async () => {
      // The flow page sets the binding cookie; reaching this route without it
      // means someone else is driving a flow they did not open.
      const { flow } = await boundFlow()
      const res = fakeRes()
      await controller.start(flow.loginToken, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.CONFLICT)
      expect(mobileOidc.buildAuthorizationUrl).not.toHaveBeenCalled()
    })

    it('marks flow oidc-pending and redirects to the IdP', async () => {
      const { flow, cookie } = await boundFlow()
      mobileOidc.buildAuthorizationUrl.mockResolvedValueOnce({
        url: 'https://authelia.test/api/oidc/authorization?code_challenge=CC',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      const res = fakeRes()
      await controller.start(flow.loginToken, fakeReq(undefined, cookie), res)
      // The redirect_uri sent to the IdP is built from `auth.oidc.redirectUri`'s
      // origin (where the IdP can reach the server / what the maintainer
      // pre-registered), not the mobile-facing baseUrl. The configuration
      // mock at the top of this file pins the OIDC origin so this assertion
      // doesn't depend on which environment.yaml the runner picked up.
      expect(mobileOidc.buildAuthorizationUrl).toHaveBeenCalledWith(flow.loginToken, 'https://sync-in.oidc.test/custom-mobile/oidc/callback')
      const seen = await flows.findByLoginToken(flow.loginToken)
      expect(seen?.status).toBe('oidc-pending')
      expect(seen?.oidc).toEqual({ codeVerifier: 'CV', nonce: 'NONCE' })
      expect(res._redirected).toBe('https://authelia.test/api/oidc/authorization?code_challenge=CC')
    })
  })

  describe('callback (IdP returns)', () => {
    it('renders cancellation page when query.error is set; flow stays oidc-pending', async () => {
      const flow = await flows.initiate()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
      const res = fakeRes()
      const html = await controller.callback('', flow.loginToken, 'access_denied', 'User cancelled', fakeReq(), res)
      expect(html).toContain('Sign-in cancelled')
      expect(html).toContain('User cancelled')
      const seen = await flows.findByLoginToken(flow.loginToken)
      expect(seen?.status).toBe('oidc-pending')
      expect(usersManager.generateAppPassword).not.toHaveBeenCalled()
    })

    it('returns 400 HTML when state is missing', async () => {
      const res = fakeRes()
      await controller.callback('CODE', '', undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.BAD_REQUEST)
    })

    it('returns 404 HTML for unknown state', async () => {
      const res = fakeRes()
      const html = await controller.callback('CODE', 'unknown-state', undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(html).toContain('Login expired')
    })

    it('returns 404 HTML when flow is not in oidc-pending state', async () => {
      const flow = await flows.initiate() // status = 'pending', not 'oidc-pending'
      const res = fakeRes()
      await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
    })

    it('happy path: authenticates and renders the GRANT page — it mints nothing', async () => {
      // This is the fix for the silent-authorisation hole. With autoRedirect
      // and a live IdP session, everything up to here can happen with zero
      // user interaction, so the IdP's say-so must not by itself produce a
      // credential for whoever started the flow.
      const { flow, cookie } = await boundFlow()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(undefined, cookie), res)
      expect(html).toContain('Authorize this app?')
      expect(html).toContain('alice')
      expect(html).toContain('Nextcloud-iOS/33.1')
      expect(html).toContain('name="grantToken"')
      expect(appPasswords.mintMobileAppPassword).not.toHaveBeenCalled()
      // And the initiator's poll still comes away empty.
      expect(await flows.consumeByPollToken(flow.pollToken)).toBeNull()

      expect(mobileOidc.exchangeAndResolveUser).toHaveBeenCalledWith(
        expect.objectContaining({ expectedState: flow.loginToken, codeVerifier: 'CV', nonce: 'NONCE' })
      )
    })

    it('refuses to authenticate a callback replayed from a different browser', async () => {
      const { flow } = await boundFlow()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })
      const res = fakeRes()
      await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(undefined, 'other-browser'), res)
      expect(res._status).toBe(HttpStatus.CONFLICT)
      expect(await flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('renders "no Sync-in account" page when user lookup returns null; no app-password minted', async () => {
      const flow = await flows.initiate()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce(null)

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.UNAUTHORIZED)
      expect(html).toContain('No Sync-in account')
      expect(appPasswords.mintMobileAppPassword).not.toHaveBeenCalled()
      // Flow not marked ready
      expect(await flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('renders sign-in-failed page when OIDC service throws', async () => {
      const flow = await flows.initiate()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockRejectedValueOnce(new HttpException('PKCE failed', HttpStatus.BAD_REQUEST))

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.UNAUTHORIZED)
      expect(html).toContain('Sign-in failed')
      expect(appPasswords.mintMobileAppPassword).not.toHaveBeenCalled()
    })

    // Regression guard for the "Fout" alert on the in-app browser. If
    // mintMobileAppPassword throws (DB error, name-collision race), the
    // failure used to bubble out as a Nest JSON 500 envelope which iOS
    // surfaced as a generic alert because the flow stayed oidc-pending
    // and polling timed out. We now wrap the mint+complete block and
    // render an HTML diagnostic instead.
    it('preserves all IdP query params (esp. iss per RFC 9207) on the callback URL passed to openid-client', async () => {
      // Real-world failure: Authelia returns `iss` per RFC 9207 and openid-client
      // validates it. If we drop `iss` when reconstructing the callback URL,
      // openid-client throws OAuth INVALID_RESPONSE during code exchange. This
      // test pins the contract that all IdP-provided query params are forwarded
      // on the URL we hand to `exchangeAndResolveUser`.
      const flow = await flows.initiate()
      await flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })
      appPasswords.mintMobileAppPassword.mockResolvedValueOnce({ name: 'mobile abc12345', password: 'APPPWD' })

      const req = fakeReq({
        code: 'CODE',
        state: flow.loginToken,
        iss: 'https://authelia.example.test',
        scope: 'openid email profile groups'
      })
      const res = fakeRes()
      await controller.callback('CODE', flow.loginToken, undefined, undefined, req, res)

      const arg = mobileOidc.exchangeAndResolveUser.mock.calls[0][0]
      expect(arg.callbackUrl.searchParams.get('code')).toBe('CODE')
      expect(arg.callbackUrl.searchParams.get('state')).toBe(flow.loginToken)
      expect(arg.callbackUrl.searchParams.get('iss')).toBe('https://authelia.example.test')
      expect(arg.callbackUrl.searchParams.get('scope')).toBe('openid email profile groups')
    })
  })

  // #477 follow-up: this controller was the one unauthenticated route family
  // in the module left unmetered, and its callback spends an OUTBOUND IdP
  // token exchange per request. Asserting the decorators alone would only
  // prove two constants agree; these drive the real guard over the real
  // handler references, which is what the request path does.
  describe('rate limiting', () => {
    function contextFor(handler: 'start' | 'callback', ip: string): ExecutionContext {
      return {
        getHandler: () => NcMobileOidcController.prototype[handler],
        getClass: () => NcMobileOidcController,
        switchToHttp: () => ({ getRequest: () => ({ ip }), getResponse: () => ({}) })
      } as unknown as ExecutionContext
    }

    it('mounts NcRateLimitGuard at class level', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, NcMobileOidcController) ?? []).toContain(NcRateLimitGuard)
    })

    it.each(['start', 'callback'] as const)('meters %s per IP and blocks over budget', async (handler) => {
      const guard = new NcRateLimitGuard(createInMemoryCache(), new Reflector())
      const ctx = contextFor(handler, '10.0.0.7')
      const limit = NC_RATE_LIMIT_OPTIONS[handler === 'start' ? 'MOBILE_OIDC_START' : 'MOBILE_OIDC_CALLBACK'].limit
      for (let i = 0; i < limit; i++) await expect(guard.canActivate(ctx)).resolves.toBe(true)
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
      // A different caller is unaffected — the bucket is per IP, not global.
      await expect(guard.canActivate(contextFor(handler, '10.0.0.8'))).resolves.toBe(true)
    })

    it('gives the two handlers separate budgets', async () => {
      const guard = new NcRateLimitGuard(createInMemoryCache(), new Reflector())
      const start = contextFor('start', '10.0.0.9')
      for (let i = 0; i <= NC_RATE_LIMIT_OPTIONS.MOBILE_OIDC_START.limit; i++) await guard.canActivate(start).catch(() => undefined)
      await expect(guard.canActivate(start)).rejects.toBeInstanceOf(ThrottlerException)
      await expect(guard.canActivate(contextFor('callback', '10.0.0.9'))).resolves.toBe(true)
    })
  })
})
