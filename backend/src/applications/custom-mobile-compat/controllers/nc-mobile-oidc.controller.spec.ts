import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UsersManager } from '../../users/services/users-manager.service'
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

  function fakeReq(): FastifyRequest {
    return { headers: { host: 'sync-in.example.test', 'x-forwarded-proto': 'https' } } as unknown as FastifyRequest
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
    moduleRef = await Test.createTestingModule({
      controllers: [NcMobileOidcController],
      providers: [
        NcLoginFlowService,
        NcResponseService,
        { provide: NcMobileOidcService, useValue: mobileOidc },
        { provide: UsersManager, useValue: usersManager }
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

      expect(mobileOidc.exchangeAndResolveUser).toHaveBeenCalledWith(
        expect.objectContaining({ expectedState: flow.loginToken, codeVerifier: 'CV', nonce: 'NONCE' })
      )
      expect(usersManager.generateAppPassword).toHaveBeenCalledWith(
        expect.objectContaining({ login: 'alice' }),
        expect.objectContaining({ name: expect.stringMatching(/^mobile /), app: expect.anything(), expiration: null })
      )

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
  })
})
