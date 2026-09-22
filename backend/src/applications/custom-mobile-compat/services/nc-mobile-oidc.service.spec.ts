import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { authorizationCodeGrant, calculatePKCECodeChallenge, fetchUserInfo, randomNonce, randomPKCECodeVerifier } from 'openid-client'
import { AuthProviderOIDC } from '../../../authentication/providers/oidc/auth-provider-oidc.service'
import { UsersManager } from '../../users/services/users-manager.service'
import { configuration as mockConfig } from '../../../configuration/config.environment'
import { NcMobileOidcService } from './nc-mobile-oidc.service'
import { Mock } from 'vitest'

vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    auth: {
      oidc: {
        clientId: 'sync-in',
        security: {
          scope: 'openid profile email',
          supportPKCE: true,
          skipSubjectCheck: false,
          requireVerifiedEmail: false
        }
      }
    }
  }
}))

vi.mock('openid-client', () => ({
  authorizationCodeGrant: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  fetchUserInfo: vi.fn(),
  randomNonce: vi.fn(),
  randomPKCECodeVerifier: vi.fn(),
  skipSubjectCheck: Symbol('skipSubjectCheck')
}))

const mockedAuthorizationCodeGrant = authorizationCodeGrant as Mock
const mockedCalculatePKCECodeChallenge = calculatePKCECodeChallenge as Mock
const mockedFetchUserInfo = fetchUserInfo as Mock
const mockedRandomNonce = randomNonce as Mock
const mockedRandomPKCECodeVerifier = randomPKCECodeVerifier as Mock

describe(NcMobileOidcService.name, () => {
  let service: NcMobileOidcService
  let authProviderOIDC: { getConfig: Mock }
  let usersManager: { findUserByExternalIdOrEmail: Mock; usersQueries: { bindExternalId: Mock } }

  const makeConfig = (supportsPKCE = true) => ({
    serverMetadata: () => ({
      supportsPKCE: () => supportsPKCE,
      authorization_endpoint: 'https://authelia.example.test/api/oidc/authorization'
    })
  })

  beforeAll(async () => {
    authProviderOIDC = { getConfig: vi.fn() }
    usersManager = { findUserByExternalIdOrEmail: vi.fn(), usersQueries: { bindExternalId: vi.fn().mockResolvedValue(true) } }

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [{ provide: AuthProviderOIDC, useValue: authProviderOIDC }, { provide: UsersManager, useValue: usersManager }, NcMobileOidcService]
    }).compile()

    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcMobileOidcService)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockedRandomNonce.mockReturnValue('NONCE')
    mockedRandomPKCECodeVerifier.mockReturnValue('CV')
    mockedCalculatePKCECodeChallenge.mockResolvedValue('CC')
  })

  describe('buildAuthorizationUrl', () => {
    it('uses loginToken as state and includes PKCE when supported', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      const out = await service.buildAuthorizationUrl('FLOWTOKEN', 'https://api.example.test/custom-mobile/oidc/callback')
      const u = new URL(out.url)
      expect(u.origin + u.pathname).toBe('https://authelia.example.test/api/oidc/authorization')
      expect(u.searchParams.get('client_id')).toBe('sync-in')
      expect(u.searchParams.get('redirect_uri')).toBe('https://api.example.test/custom-mobile/oidc/callback')
      expect(u.searchParams.get('response_type')).toBe('code')
      expect(u.searchParams.get('scope')).toBe('openid profile email')
      expect(u.searchParams.get('state')).toBe('FLOWTOKEN')
      expect(u.searchParams.get('nonce')).toBe('NONCE')
      expect(u.searchParams.get('code_challenge')).toBe('CC')
      expect(u.searchParams.get('code_challenge_method')).toBe('S256')
      expect(out.codeVerifier).toBe('CV')
      expect(out.nonce).toBe('NONCE')
    })

    it('omits PKCE when issuer reports no support', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(false))
      const out = await service.buildAuthorizationUrl('FLOWTOKEN', 'https://x/cb')
      const u = new URL(out.url)
      expect(u.searchParams.has('code_challenge')).toBe(false)
      expect(u.searchParams.has('code_challenge_method')).toBe(false)
      // codeVerifier still returned (unused) to keep the API uniform
      expect(out.codeVerifier).toBe('CV')
    })
  })

  // These pin the identity contract this resolver used to lack entirely. It
  // previously did a bare findUser(email) with a findUser(preferred_username)
  // fallback: no externalId binding, no isActive check, and — because findUser
  // matches the `login` column as well as `email` — an IdP principal whose
  // preferred_username equalled someone's Sync-in LOGIN resolved onto that
  // account. It now mirrors upstream's own processUserInfo.
  describe('exchangeAndResolveUser — identity binding', () => {
    function grantWith(userInfo: Record<string, unknown>, sub = 'idp-sub-123') {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({ access_token: 'AT', claims: () => ({ sub }) })
      mockedFetchUserInfo.mockResolvedValueOnce({ sub, ...userInfo })
    }
    const resolve = () =>
      service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
        expectedState: 'S',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })

    it('resolves through findUserByExternalIdOrEmail, keyed on the ID-token sub', async () => {
      grantWith({ email: 'alice@example.test', preferred_username: 'alice' })
      const userObj = { id: 1, login: 'alice', isActive: true, externalId: 'idp-sub-123' }
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce(userObj)
      await expect(resolve()).resolves.toBe(userObj)
      expect(usersManager.findUserByExternalIdOrEmail).toHaveBeenCalledWith('idp-sub-123', 'alice@example.test', false)
    })

    it('refuses an account already bound to a DIFFERENT IdP subject', async () => {
      grantWith({ email: 'alice@example.test' }, 'attacker-sub')
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'alice', isActive: true, externalId: 'the-real-sub' })
      // Without this, anyone whose IdP profile carries a victim's email address
      // resolves onto the victim's account.
      await expect(resolve()).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED })
    })

    it('refuses a deactivated account', async () => {
      grantWith({ email: 'alice@example.test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'alice', isActive: false, externalId: 'idp-sub-123' })
      await expect(resolve()).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    })

    it('binds the subject on the first match, so later logins go by externalId', async () => {
      grantWith({ email: 'alice@example.test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'alice', isActive: true, externalId: null })
      const out = await resolve()
      expect(usersManager.usersQueries.bindExternalId).toHaveBeenCalledWith(1, 'idp-sub-123')
      expect((out as unknown as { externalId: string }).externalId).toBe('idp-sub-123')
    })

    it('fails closed when the binding write is rejected', async () => {
      grantWith({ email: 'alice@example.test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'alice', isActive: true, externalId: null })
      usersManager.usersQueries.bindExternalId.mockResolvedValueOnce(false)
      await expect(resolve()).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED })
    })

    it('does NOT fall back to a preferred_username lookup', async () => {
      // The removed fallback went through findUser(), which matches the login
      // column — so a self-registered IdP principal could name someone else's
      // Sync-in login and be handed their account.
      grantWith({ email: 'nobody@elsewhere.test', preferred_username: 'alice' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce(null)
      await expect(resolve()).resolves.toBeNull()
      expect(usersManager.findUserByExternalIdOrEmail).toHaveBeenCalledTimes(1)
      expect(usersManager.findUserByExternalIdOrEmail).toHaveBeenCalledWith('idp-sub-123', 'nobody@elsewhere.test', false)
    })

    it('still resolves an already-bound account when the IdP omits email', async () => {
      grantWith({ preferred_username: 'janwiebe' })
      const userObj = { id: 7, login: 'janwiebe', isActive: true, externalId: 'idp-sub-123' }
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce(userObj)
      await expect(resolve()).resolves.toBe(userObj)
      // Empty string, never undefined — it is a prepared-statement placeholder.
      expect(usersManager.findUserByExternalIdOrEmail).toHaveBeenCalledWith('idp-sub-123', '', false)
    })

    it('lowercases email before lookup', async () => {
      grantWith({ email: 'Alice@Example.Test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'alice', isActive: true, externalId: 'idp-sub-123' })
      await resolve()
      expect(usersManager.findUserByExternalIdOrEmail).toHaveBeenCalledWith('idp-sub-123', 'alice@example.test', false)
    })

    it('honours requireVerifiedEmail when the IdP says the address is unverified', async () => {
      ;(mockConfig.auth.oidc.security as { requireVerifiedEmail: boolean }).requireVerifiedEmail = true
      grantWith({ email: 'alice@example.test', email_verified: false })
      await expect(resolve()).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      ;(mockConfig.auth.oidc.security as { requireVerifiedEmail: boolean }).requireVerifiedEmail = false
    })

    it('returns null when nothing matches', async () => {
      grantWith({ email: 'ghost@example.test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce(null)
      await expect(resolve()).resolves.toBeNull()
    })

    it('rejects an ID token with no sub', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({ access_token: 'AT', claims: () => ({}) })
      await expect(resolve()).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    })

    it('drops the PKCE verifier when the issuer reports no support', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(false))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({ access_token: 'AT', claims: () => ({ sub: 'idp-sub-123' }) })
      mockedFetchUserInfo.mockResolvedValueOnce({ sub: 'idp-sub-123', email: 'a@b.test' })
      usersManager.findUserByExternalIdOrEmail.mockResolvedValueOnce({ id: 1, login: 'a', isActive: true, externalId: 'idp-sub-123' })
      await resolve()
      expect(mockedAuthorizationCodeGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(URL),
        expect.objectContaining({ pkceCodeVerifier: undefined })
      )
    })
  })
})
