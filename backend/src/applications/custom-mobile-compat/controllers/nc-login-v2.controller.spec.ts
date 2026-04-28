import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcLoginV2Controller } from './nc-login-v2.controller'

// Mock the config singleton; tests mutate `configuration.auth.*` per-case in
// beforeEach (jest.mock returns a stable reference, so mutations propagate
// to whatever the controller reads at request time).
jest.mock('../../../configuration/config.environment', () => ({
  configuration: {
    auth: {
      provider: 'mysql',
      oidc: {
        options: {
          autoRedirect: false,
          enablePasswordAuth: true,
          buttonText: 'Continue with OpenID Connect'
        }
      }
    }
  }
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configuration: mockConfig } = require('../../../configuration/config.environment')

describe(`${NcLoginV2Controller.name} — login page dispatch`, () => {
  let moduleRef: TestingModule
  let controller: NcLoginV2Controller
  let flows: NcLoginFlowService

  function fakeRes() {
    const res: Partial<FastifyReply> & { _status?: number; _redirected?: string; _body?: unknown; _headers: Record<string, string> } = {
      _headers: {},
      header: jest.fn(function (this: FastifyReply, name: string, value: string) {
        ;(this as never as { _headers: Record<string, string> })._headers[name] = value
        return this
      }) as never,
      status: jest.fn(function (this: FastifyReply, n: number) {
        ;(this as never as { _status: number })._status = n
        return this
      }) as never,
      send: jest.fn(function (this: FastifyReply, body?: unknown) {
        ;(this as never as { _body: unknown })._body = body
        return this
      }) as never,
      redirect: jest.fn(function (this: FastifyReply, url: string, code?: number) {
        ;(this as never as { _redirected: string })._redirected = url
        if (typeof code === 'number') {
          ;(this as never as { _status: number })._status = code
        }
        return this
      }) as never
    }
    return res as FastifyReply & { _status?: number; _redirected?: string; _body?: unknown; _headers: Record<string, string> }
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcLoginV2Controller],
      providers: [
        NcLoginFlowService,
        NcResponseService,
        { provide: UsersManager, useValue: { findUser: jest.fn(), logUser: jest.fn() } },
        {
          provide: NcAppPasswordService,
          useValue: { pruneMobileAppPasswords: jest.fn().mockResolvedValue(0), mintMobileAppPassword: jest.fn() }
        }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcLoginV2Controller)
    flows = moduleRef.get(NcLoginFlowService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    flows.clearForTests()
    mockConfig.auth.provider = 'mysql'
    mockConfig.auth.oidc.options.autoRedirect = false
    mockConfig.auth.oidc.options.enablePasswordAuth = true
  })

  it('renders the local username/password form when provider is not oidc', () => {
    const flow = flows.initiate()
    const res = fakeRes()
    const html = controller.renderLoginPage(flow.loginToken, res)
    expect(typeof html).toBe('string')
    expect(html).toContain('Username or email')
    expect(html).toContain('name="login"')
    expect(html).toContain('name="password"')
    // Button-mode markers must NOT be present.
    expect(html).not.toContain('Continue with OpenID Connect')
    expect(res._redirected).toBeUndefined()
  })

  it('redirects to /custom-mobile/oidc/login/<token> when oidc + autoRedirect', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = true
    const flow = flows.initiate()
    const res = fakeRes()
    controller.renderLoginPage(flow.loginToken, res)
    expect(res._status).toBe(HttpStatus.FOUND)
    expect(res._redirected).toBe(`/custom-mobile/oidc/login/${flow.loginToken}`)
  })

  it('renders button + local form when oidc + button mode + enablePasswordAuth', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = false
    mockConfig.auth.oidc.options.enablePasswordAuth = true
    const flow = flows.initiate()
    const res = fakeRes()
    const html = controller.renderLoginPage(flow.loginToken, res)
    expect(html).toContain('Continue with OpenID Connect')
    expect(html).toContain(`/custom-mobile/oidc/login/${flow.loginToken}`)
    // Local form still rendered alongside the button.
    expect(html).toContain('name="login"')
    expect(html).toContain('name="password"')
  })

  it('renders button only (no local form) when oidc + button mode + !enablePasswordAuth', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = false
    mockConfig.auth.oidc.options.enablePasswordAuth = false
    const flow = flows.initiate()
    const res = fakeRes()
    const html = controller.renderLoginPage(flow.loginToken, res)
    expect(html).toContain('Continue with OpenID Connect')
    expect(html).not.toContain('name="login"')
    expect(html).not.toContain('name="password"')
  })

  it('returns 404 HTML for unknown loginToken regardless of provider', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = true
    const res = fakeRes()
    const html = controller.renderLoginPage('does-not-exist', res)
    expect(res._status).toBe(HttpStatus.NOT_FOUND)
    expect(html).toContain('Login expired')
    // Importantly: do NOT redirect to the OIDC login URL for unknown tokens.
    expect(res._redirected).toBeUndefined()
  })

  describe('poll handlers — token sources + response shape', () => {
    // The Nextcloud iOS client (>= 33.x) sends the poll request as
    //   POST /index.php/login/v2/poll?token=...
    // with an empty body. The original implementation only parsed the body,
    // so iOS clients always saw a 400 "missing token". Both `pollCanonical`
    // and `pollAlt` (the path some clients hit) must accept the token from
    // either source.
    //
    // Additionally: real Nextcloud server returns 404 with an empty/`[]`
    // JSON body while pending. NC iOS rejects 404 + Nest's default error
    // envelope (`{statusCode,message,error}`) as "invalid response". We
    // mirror real-NC's shape: `[]` body on 404, the credentials object on
    // 200.
    const creds = { server: 'https://x.test', loginName: 'alice', appPassword: 'APPPWD' }

    it('pollCanonical → 200 + creds JSON when token comes only from query', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      await controller.pollCanonical(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.OK)
      expect(res._body).toEqual(creds)
    })

    it('pollAlt → 200 + creds JSON when token comes only from query', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      await controller.pollAlt(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.OK)
      expect(res._body).toEqual(creds)
    })

    it('pollCanonical still accepts token in form-urlencoded body (existing clients)', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      await controller.pollCanonical(`token=${flow.pollToken}` as never, undefined, res)
      expect(res._status).toBe(HttpStatus.OK)
      expect(res._body).toEqual(creds)
    })

    it('pollCanonical → 404 + `[]` body when flow is still pending', async () => {
      const flow = flows.initiate()
      // Flow not completed — still 'pending'.
      const res = fakeRes()
      await controller.pollCanonical(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(res._body).toBe('[]')
      // Critically: NOT the Nest exception envelope
      expect(res._body).not.toEqual(expect.objectContaining({ statusCode: HttpStatus.NOT_FOUND }))
    })

    it('pollCanonical → 404 + `[]` body on second poll after consumption', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      // First poll consumes
      await controller.pollCanonical(undefined, flow.pollToken, fakeRes())
      // Second poll: still 404, still `[]`
      const res = fakeRes()
      await controller.pollCanonical(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(res._body).toBe('[]')
    })

    it('400 when token is missing from both body and query', async () => {
      const res = fakeRes()
      await expect(controller.pollCanonical(undefined, undefined, res)).rejects.toMatchObject({
        message: 'missing token',
        status: HttpStatus.BAD_REQUEST
      })
    })
  })

  describe('initiate response shape (real-NC byte-parity)', () => {
    function fakeReq(): FastifyRequest {
      return { headers: { host: 'sync-in.example.test', 'x-forwarded-proto': 'https' } } as unknown as FastifyRequest
    }

    it('advertises the canonical /login/v2/poll endpoint (no /index.php prefix)', () => {
      const out = controller.initiate(fakeReq())
      // Real Nextcloud advertises /login/v2/poll (without /index.php). We
      // mount both but should advertise the canonical form so the JSON
      // byte-matches upstream and any client that string-matches works.
      expect(out.poll.endpoint).toBe('https://sync-in.example.test/login/v2/poll')
      expect(out.poll.endpoint).not.toContain('/index.php/')
      expect(out.login).toMatch(/^https:\/\/sync-in\.example\.test\/login\/v2\/flow\/.+$/)
      expect(out.poll.token).toEqual(expect.any(String))
      expect(out.poll.token.length).toBeGreaterThan(0)
    })
  })
})
