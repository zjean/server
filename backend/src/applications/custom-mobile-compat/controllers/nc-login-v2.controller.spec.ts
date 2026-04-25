import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply } from 'fastify'
import { UsersManager } from '../../users/services/users-manager.service'
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
    const res: Partial<FastifyReply> & { _status?: number; _redirected?: string; _headers: Record<string, string> } = {
      _headers: {},
      header: jest.fn(function (this: FastifyReply, name: string, value: string) {
        ;(this as never as { _headers: Record<string, string> })._headers[name] = value
        return this
      }) as never,
      status: jest.fn(function (this: FastifyReply, n: number) {
        ;(this as never as { _status: number })._status = n
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
    return res as FastifyReply & { _status?: number; _redirected?: string; _headers: Record<string, string> }
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcLoginV2Controller],
      providers: [
        NcLoginFlowService,
        NcResponseService,
        { provide: UsersManager, useValue: { findUser: jest.fn(), logUser: jest.fn(), generateAppPassword: jest.fn() } }
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

  describe('poll handlers accept the token from query string', () => {
    // The Nextcloud iOS client (>= 33.x) sends the poll request as
    //   POST /index.php/login/v2/poll?token=...
    // with an empty body. The original implementation only parsed the body,
    // so iOS clients always saw a 400 "missing token". Both `pollCanonical`
    // and `pollAlt` (the path some clients hit) must accept the token from
    // either source.
    const creds = { server: 'https://x.test', loginName: 'alice', appPassword: 'APPPWD' }

    it('pollCanonical resolves credentials when token comes only from query', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      const out = await controller.pollCanonical(undefined, flow.pollToken, res)
      expect(out).toEqual(creds)
      expect(res._status).toBe(HttpStatus.OK)
    })

    it('pollAlt resolves credentials when token comes only from query', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      const out = await controller.pollAlt(undefined, flow.pollToken, res)
      expect(out).toEqual(creds)
    })

    it('pollCanonical still works with token in form-urlencoded body (existing clients)', async () => {
      const flow = flows.initiate()
      flows.completeWithCredentials(flow.loginToken, creds)
      const res = fakeRes()
      const out = await controller.pollCanonical(`token=${flow.pollToken}` as never, undefined, res)
      expect(out).toEqual(creds)
    })

    it('returns 400 when token is missing from both body and query', async () => {
      const res = fakeRes()
      await expect(controller.pollCanonical(undefined, undefined, res)).rejects.toMatchObject({
        message: 'missing token',
        status: HttpStatus.BAD_REQUEST
      })
    })
  })
})
