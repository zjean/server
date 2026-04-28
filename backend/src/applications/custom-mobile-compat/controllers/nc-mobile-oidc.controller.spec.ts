import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcMobileOidcService } from '../services/nc-mobile-oidc.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcMobileOidcController } from './nc-mobile-oidc.controller'

// Prevent the real `openid-client` ES module from being evaluated when the
// service file is imported as a DI token below — we never call into it (the
// service is mocked via `useValue`).
jest.mock('openid-client', () => ({}))

describe(NcMobileOidcController.name, () => {
  let moduleRef: TestingModule
  let controller: NcMobileOidcController
  let flows: NcLoginFlowService
  let mobileOidc: { buildAuthorizationUrl: jest.Mock; exchangeAndResolveUser: jest.Mock }
  let usersManager: { generateAppPassword: jest.Mock }
  let appPasswords: { pruneMobileAppPasswords: jest.Mock }

  function fakeReq(query?: Record<string, string>): FastifyRequest {
    return { headers: { host: 'sync-in.example.test', 'x-forwarded-proto': 'https' }, query: query ?? {} } as unknown as FastifyRequest
  }
  function fakeRes() {
    const res: Partial<FastifyReply> & { _status?: number; _body?: string; _redirected?: string } = {
      header: jest.fn().mockReturnThis() as never,
      status: jest.fn(function (this: FastifyReply, n: number) {
        ;(this as never as { _status: number })._status = n
        return this
      }) as never,
      send: jest.fn(function (this: FastifyReply, body: string) {
        ;(this as never as { _body: string })._body = body
        return this
      }) as never,
      redirect: jest.fn(function (this: FastifyReply, url: string) {
        ;(this as never as { _redirected: string })._redirected = url
        return this
      }) as never
    }
    return res as FastifyReply & { _status?: number; _body?: string; _redirected?: string }
  }

  beforeAll(async () => {
    mobileOidc = { buildAuthorizationUrl: jest.fn(), exchangeAndResolveUser: jest.fn() }
    usersManager = { generateAppPassword: jest.fn() }
    appPasswords = { pruneMobileAppPasswords: jest.fn().mockResolvedValue(0) }
    moduleRef = await Test.createTestingModule({
      controllers: [NcMobileOidcController],
      providers: [
        NcLoginFlowService,
        NcResponseService,
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

  beforeEach(() => {
    flows.clearForTests()
    jest.clearAllMocks()
  })

  describe('start (initiate OIDC redirect)', () => {
    it('returns 404 HTML for an unknown loginToken', async () => {
      const res = fakeRes()
      await controller.start('does-not-exist', fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(res._body).toContain('Login expired')
    })

    it('returns 404 HTML when the flow is not in pending state', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
      const res = fakeRes()
      await controller.start(flow.loginToken, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
    })

    it('marks flow oidc-pending and redirects to the IdP', async () => {
      const flow = flows.initiate()
      mobileOidc.buildAuthorizationUrl.mockResolvedValueOnce({
        url: 'https://authelia.test/api/oidc/authorization?code_challenge=CC',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      const res = fakeRes()
      await controller.start(flow.loginToken, fakeReq(), res)
      expect(mobileOidc.buildAuthorizationUrl).toHaveBeenCalledWith(flow.loginToken, 'https://sync-in.example.test/custom-mobile/oidc/callback')
      const seen = flows.findByLoginToken(flow.loginToken)
      expect(seen?.status).toBe('oidc-pending')
      expect(seen?.oidc).toEqual({ codeVerifier: 'CV', nonce: 'NONCE' })
      expect(res._redirected).toBe('https://authelia.test/api/oidc/authorization?code_challenge=CC')
    })
  })

  describe('callback (IdP returns)', () => {
    it('renders cancellation page when query.error is set; flow stays oidc-pending', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
      const res = fakeRes()
      const html = await controller.callback('', flow.loginToken, 'access_denied', 'User cancelled', fakeReq(), res)
      expect(html).toContain('Sign-in cancelled')
      expect(html).toContain('User cancelled')
      const seen = flows.findByLoginToken(flow.loginToken)
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
      const flow = flows.initiate() // status = 'pending', not 'oidc-pending'
      const res = fakeRes()
      await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
    })

    it('happy path: mints AUTH_SCOPE.MOBILE_NC app-password and completes the flow', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })
      usersManager.generateAppPassword.mockResolvedValueOnce({ password: 'APPPWD' })

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(html).toContain('All set!')
      // Success page must emit the NC client deep link so iOS / Android can
      // hand off without waiting for the next poll. URL is HTML-escaped (`&`
      // becomes `&amp;`) — browser un-escapes when following the meta refresh.
      expect(html).toContain('nc://login/server:https%3A%2F%2Fsync-in.example.test')
      expect(html).toContain('user:alice')
      expect(html).toContain('password:APPPWD')
      expect(html).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*nc:\/\/login/)

      expect(mobileOidc.exchangeAndResolveUser).toHaveBeenCalledWith(
        expect.objectContaining({ expectedState: flow.loginToken, codeVerifier: 'CV', nonce: 'NONCE' })
      )
      expect(usersManager.generateAppPassword).toHaveBeenCalledWith(
        expect.objectContaining({ login: 'alice' }),
        expect.objectContaining({ name: expect.stringMatching(/^mobile /), app: expect.anything(), expiration: null })
      )
      // Prune runs before mint so the row count stays bounded — without
      // this, repeated OAuth attempts pile up MOBILE_NC rows and slow down
      // post-login auth (validateAppPassword bcrypt-loops every row).
      expect(appPasswords.pruneMobileAppPasswords).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }))
      const pruneOrder = appPasswords.pruneMobileAppPasswords.mock.invocationCallOrder[0]
      const mintOrder = usersManager.generateAppPassword.mock.invocationCallOrder[0]
      expect(pruneOrder).toBeLessThan(mintOrder)

      // Flow should now hand off credentials on next poll
      const creds = flows.consumeByPollToken(flow.pollToken)
      expect(creds).toEqual({
        server: 'https://sync-in.example.test',
        loginName: 'alice',
        appPassword: 'APPPWD'
      })
    })

    it('renders "no Sync-in account" page when user lookup returns null; no app-password minted', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce(null)

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.UNAUTHORIZED)
      expect(html).toContain('No Sync-in account')
      expect(usersManager.generateAppPassword).not.toHaveBeenCalled()
      // Flow not marked ready
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('renders sign-in-failed page when OIDC service throws', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockRejectedValueOnce(new HttpException('PKCE failed', HttpStatus.BAD_REQUEST))

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.UNAUTHORIZED)
      expect(html).toContain('Sign-in failed')
      expect(usersManager.generateAppPassword).not.toHaveBeenCalled()
    })

    // Regression guard for the "Fout" alert on the in-app browser. If
    // generateAppPassword throws (DB error, name-collision race), the
    // failure used to bubble out as a Nest JSON 500 envelope which iOS
    // surfaced as a generic alert because the flow stayed oidc-pending
    // and polling timed out. We now wrap the mint+complete block and
    // render an HTML diagnostic instead.
    it('renders sign-in-failed HTML when generateAppPassword throws; flow stays not-ready so retry is possible', async () => {
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })
      usersManager.generateAppPassword.mockRejectedValueOnce(new HttpException('Name already used', HttpStatus.BAD_REQUEST))

      const res = fakeRes()
      const html = await controller.callback('CODE', flow.loginToken, undefined, undefined, fakeReq(), res)
      expect(res._status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
      expect(html).toContain('Sign-in failed')
      expect(html).toContain('Name already used')
      // Flow must remain not-ready so the next /poll returns 404, the
      // browser session expires cleanly, and the user can retry.
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('preserves all IdP query params (esp. iss per RFC 9207) on the callback URL passed to openid-client', async () => {
      // Real-world failure: Authelia returns `iss` per RFC 9207 and openid-client
      // validates it. If we drop `iss` when reconstructing the callback URL,
      // openid-client throws OAuth INVALID_RESPONSE during code exchange. This
      // test pins the contract that all IdP-provided query params are forwarded
      // on the URL we hand to `exchangeAndResolveUser`.
      const flow = flows.initiate()
      flows.markOidcPending(flow.loginToken, { codeVerifier: 'CV', nonce: 'NONCE' })
      mobileOidc.exchangeAndResolveUser.mockResolvedValueOnce({ id: 1, login: 'alice' })
      usersManager.generateAppPassword.mockResolvedValueOnce({ password: 'APPPWD' })

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
})
