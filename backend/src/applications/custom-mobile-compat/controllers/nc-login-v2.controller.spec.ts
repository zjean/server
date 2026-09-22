import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Mock } from 'vitest'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcLoginFlowService } from '../services/nc-login-flow.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcLoginV2Controller } from './nc-login-v2.controller'

// Mock the config singleton; tests mutate `configuration.auth.*` per-case in
// beforeEach (vi.mock returns a stable reference, so mutations propagate
// to whatever the controller reads at request time).
vi.mock('../../../configuration/config.environment', () => ({
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

import { configuration as mockConfig } from '../../../configuration/config.environment'

describe(`${NcLoginV2Controller.name} — login page dispatch`, () => {
  let moduleRef: TestingModule
  let controller: NcLoginV2Controller
  let flows: NcLoginFlowService

  function fakeRes() {
    const res: Partial<FastifyReply> & { _status?: number; _redirected?: string; _body?: unknown; _headers: Record<string, string> } = {
      _headers: {},
      header: vi.fn(function (this: FastifyReply, name: string, value: string) {
        ;(this as never as { _headers: Record<string, string> })._headers[name] = value
        return this
      }) as never,
      status: vi.fn(function (this: FastifyReply, n: number) {
        ;(this as never as { _status: number })._status = n
        return this
      }) as never,
      send: vi.fn(function (this: FastifyReply, body?: unknown) {
        ;(this as never as { _body: unknown })._body = body
        return this
      }) as never,
      redirect: vi.fn(function (this: FastifyReply, url: string, code?: number) {
        ;(this as never as { _redirected: string })._redirected = url
        if (typeof code === 'number') {
          ;(this as never as { _status: number })._status = code
        }
        return this
      }) as never
    }
    return res as FastifyReply & { _status?: number; _redirected?: string; _body?: unknown; _headers: Record<string, string> }
  }

  // The browser hop is now cookie-bound, so requests carry headers. `cookie`
  // is the raw nc_login_flow value; omit it to simulate a browser that has
  // never been bound (or a different one).
  function fakeReq(cookie?: string): FastifyRequest {
    const headers: Record<string, string> = { 'user-agent': 'Nextcloud-iOS/33.1' }
    if (cookie) headers.cookie = `nc_login_flow=${encodeURIComponent(cookie)}`
    return { headers } as unknown as FastifyRequest
  }

  // Pull the cookie value the controller just set, so a test can act as the
  // same browser on the next call.
  function cookieFrom(res: { _headers: Record<string, string> }): string {
    const raw = res._headers['set-cookie'] ?? ''
    const m = /nc_login_flow=([^;]+)/.exec(raw)
    return m ? decodeURIComponent(m[1]) : ''
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcLoginV2Controller],
      providers: [
        NcLoginFlowService,
        NcResponseService,
        { provide: UsersManager, useValue: { findUser: vi.fn(), logUser: vi.fn() } },
        {
          provide: NcAppPasswordService,
          useValue: { pruneMobileAppPasswords: vi.fn().mockResolvedValue(0), mintMobileAppPassword: vi.fn() }
        }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcLoginV2Controller)
    flows = moduleRef.get(NcLoginFlowService)
    // Stub only baseUrl() so tests are independent of local OIDC config presence.
    vi.spyOn(moduleRef.get(NcResponseService), 'baseUrl').mockReturnValue('https://sync-in.example.test')
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
    const html = controller.renderLoginPage(flow.loginToken, fakeReq(), res)
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
    controller.renderLoginPage(flow.loginToken, fakeReq(), res)
    expect(res._status).toBe(HttpStatus.FOUND)
    expect(res._redirected).toBe(`/custom-mobile/oidc/login/${flow.loginToken}`)
  })

  it('renders button + local form when oidc + button mode + enablePasswordAuth', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = false
    mockConfig.auth.oidc.options.enablePasswordAuth = true
    const flow = flows.initiate()
    const res = fakeRes()
    const html = controller.renderLoginPage(flow.loginToken, fakeReq(), res)
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
    const html = controller.renderLoginPage(flow.loginToken, fakeReq(), res)
    expect(html).toContain('Continue with OpenID Connect')
    expect(html).not.toContain('name="login"')
    expect(html).not.toContain('name="password"')
  })

  it('returns 404 HTML for unknown loginToken regardless of provider', () => {
    mockConfig.auth.provider = 'oidc'
    mockConfig.auth.oidc.options.autoRedirect = true
    const res = fakeRes()
    const html = controller.renderLoginPage('does-not-exist', fakeReq(), res)
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

    // A flow only reaches 'ready' via bind → authenticate → grant, so these
    // poll-shape tests drive it there rather than short-circuiting into a
    // state the controller can no longer produce.
    function readyFlow() {
      const flow = flows.initiate('Nextcloud-iOS/33.1')
      const browserToken = flows.bindBrowser(flow.loginToken, undefined)
      flows.markAuthenticated(flow.loginToken, { id: 7, login: 'alice' }, browserToken)
      flows.completeWithCredentials(flow.loginToken, creds)
      return flow
    }

    it('pollCanonical → 200 + creds JSON when token comes only from query', async () => {
      const flow = readyFlow()
      const res = fakeRes()
      await controller.pollCanonical(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.OK)
      expect(res._body).toEqual(creds)
    })

    it('pollAlt → 200 + creds JSON when token comes only from query', async () => {
      const flow = readyFlow()
      const res = fakeRes()
      await controller.pollAlt(undefined, flow.pollToken, res)
      expect(res._status).toBe(HttpStatus.OK)
      expect(res._body).toEqual(creds)
    })

    it('pollCanonical still accepts token in form-urlencoded body (existing clients)', async () => {
      const flow = readyFlow()
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

  // The defect these cover: authentication used to BE authorisation. Whoever
  // called POST /index.php/login/v2 held the poll token, so the moment any
  // browser finished authenticating, that caller collected a long-lived app
  // password — even though the person at the browser never agreed to pair
  // anything. Splitting grant out of authentication is the fix; these pin that
  // the split is real and cannot be stepped around.
  describe('grant step — authentication is not authorisation', () => {
    const USER = { id: 7, login: 'alice', isActive: true }

    beforeEach(() => {
      vi.clearAllMocks()
      const users = moduleRef.get(UsersManager) as unknown as { findUser: Mock; logUser: Mock }
      users.findUser.mockResolvedValue(USER)
      users.logUser.mockResolvedValue(USER)
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { mintMobileAppPassword: Mock }
      pwds.mintMobileAppPassword.mockResolvedValue({ password: 'minted-app-password' })
    })

    // Drive the browser half up to the grant page and return what we need.
    async function authenticate() {
      const flow = flows.initiate('Nextcloud-iOS/33.1')
      const getRes = fakeRes()
      controller.renderLoginPage(flow.loginToken, fakeReq(), getRes)
      const cookie = cookieFrom(getRes)
      const postRes = fakeRes()
      const html = await controller.submitLoginPage(flow.loginToken, { login: 'alice', password: 'pw' }, fakeReq(cookie), postRes)
      const m = /name="grantToken" value="([^"]+)"/.exec(html)
      return { flow, cookie, html, grantToken: m ? m[1] : '' }
    }

    it('submitting valid credentials renders the grant page and mints NOTHING', async () => {
      const { html } = await authenticate()
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { mintMobileAppPassword: Mock }
      expect(html).toContain('Authorize this app?')
      expect(html).toContain('alice')
      // The client that asked is named, so the user can spot one they did not start.
      expect(html).toContain('Nextcloud-iOS/33.1')
      expect(pwds.mintMobileAppPassword).not.toHaveBeenCalled()
    })

    it('the poll returns nothing while the flow is authenticated but ungranted', async () => {
      const { flow } = await authenticate()
      // This is the whole vulnerability in one assertion: the flow initiator
      // polls at the exact moment the victim's browser has authenticated, and
      // must come away empty-handed.
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('granting mints once and the poll then returns the credentials', async () => {
      const { flow, cookie, grantToken } = await authenticate()
      expect(grantToken).not.toBe('')
      const res = fakeRes()
      const html = await controller.grant(flow.loginToken, { grantToken }, fakeReq(cookie), res)
      expect(html).toContain('minted-app-password')
      const creds = flows.consumeByPollToken(flow.pollToken)
      expect(creds).toMatchObject({ loginName: 'alice', appPassword: 'minted-app-password' })
    })

    // Ported from the OIDC controller spec, where the mint used to live.
    it('prunes before minting, and emits the nc:// deep link on success', async () => {
      const { flow, cookie, grantToken } = await authenticate()
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { pruneMobileAppPasswords: Mock; mintMobileAppPassword: Mock }
      const html = await controller.grant(flow.loginToken, { grantToken }, fakeReq(cookie), fakeRes())

      // Prune before mint keeps the MOBILE_NC row count bounded — without it,
      // repeated attempts pile up rows and every later auth bcrypt-loops them.
      expect(pwds.pruneMobileAppPasswords).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }))
      expect(pwds.mintMobileAppPassword).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }), expect.stringMatching(/^mobile /))
      expect(pwds.pruneMobileAppPasswords.mock.invocationCallOrder[0]).toBeLessThan(pwds.mintMobileAppPassword.mock.invocationCallOrder[0])

      // The success page hands off to the app without waiting for a poll. The
      // URL is HTML-escaped; the browser un-escapes on the meta refresh.
      expect(html).toContain('nc://login/server:https%3A%2F%2Fsync-in.example.test')
      expect(html).toContain('user:alice')
      expect(html).toContain('password:minted-app-password')
      expect(html).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*nc:\/\/login/)
    })

    it('renders sign-in-failed HTML when the mint throws, leaving the flow un-ready for a retry', async () => {
      const { flow, cookie, grantToken } = await authenticate()
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { mintMobileAppPassword: Mock }
      pwds.mintMobileAppPassword.mockRejectedValueOnce(new Error('Name already used'))
      const res = fakeRes()
      const html = await controller.grant(flow.loginToken, { grantToken }, fakeReq(cookie), res)
      expect(res._status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
      expect(html).toContain('Sign-in failed')
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('a grant from a different browser is refused and mints nothing', async () => {
      const { flow, grantToken } = await authenticate()
      const res = fakeRes()
      // Correct grant token, wrong browser — e.g. the token leaked via a
      // referrer or a shared screenshot.
      await controller.grant(flow.loginToken, { grantToken }, fakeReq('some-other-browser'), res)
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { mintMobileAppPassword: Mock }
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(pwds.mintMobileAppPassword).not.toHaveBeenCalled()
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('a grant with a wrong grant token is refused', async () => {
      const { flow, cookie } = await authenticate()
      const res = fakeRes()
      await controller.grant(flow.loginToken, { grantToken: 'not-the-token' }, fakeReq(cookie), res)
      expect(res._status).toBe(HttpStatus.NOT_FOUND)
      expect(flows.consumeByPollToken(flow.pollToken)).toBeNull()
    })

    it('the grant token is single-use', async () => {
      const { flow, cookie, grantToken } = await authenticate()
      await controller.grant(flow.loginToken, { grantToken }, fakeReq(cookie), fakeRes())
      const replay = fakeRes()
      await controller.grant(flow.loginToken, { grantToken }, fakeReq(cookie), replay)
      expect(replay._status).toBe(HttpStatus.NOT_FOUND)
      const pwds = moduleRef.get(NcAppPasswordService) as unknown as { mintMobileAppPassword: Mock }
      expect(pwds.mintMobileAppPassword).toHaveBeenCalledTimes(1)
    })

    it('a second browser cannot take over a flow another browser already bound', () => {
      const flow = flows.initiate('Nextcloud-iOS/33.1')
      controller.renderLoginPage(flow.loginToken, fakeReq(), fakeRes())
      const attacker = fakeRes()
      const html = controller.renderLoginPage(flow.loginToken, fakeReq(), attacker)
      expect(attacker._status).toBe(HttpStatus.CONFLICT)
      expect(html).toContain('already in progress')
    })
  })
})
