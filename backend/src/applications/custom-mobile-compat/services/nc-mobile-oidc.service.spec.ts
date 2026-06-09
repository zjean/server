import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { authorizationCodeGrant, calculatePKCECodeChallenge, fetchUserInfo, randomNonce, randomPKCECodeVerifier } from 'openid-client'
import { AuthProviderOIDC } from '../../../authentication/providers/oidc/auth-provider-oidc.service'
import { UsersManager } from '../../users/services/users-manager.service'
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
          skipSubjectCheck: false
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
  let usersManager: { findUser: Mock }

  const makeConfig = (supportsPKCE = true) => ({
    serverMetadata: () => ({
      supportsPKCE: () => supportsPKCE,
      authorization_endpoint: 'https://authelia.example.test/api/oidc/authorization'
    })
  })

  beforeAll(async () => {
    authProviderOIDC = { getConfig: vi.fn() }
    usersManager = { findUser: vi.fn() }

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

  describe('exchangeAndResolveUser', () => {
    it('returns the user when findUser resolves a match by email', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub-123' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub-123',
        email: 'alice@example.test',
        preferred_username: 'alice'
      })
      const userObj = { id: 1, login: 'alice', email: 'alice@example.test' }
      usersManager.findUser.mockResolvedValueOnce(userObj)

      const out = await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/custom-mobile/oidc/callback?code=CODE&state=FLOWTOKEN'),
        expectedState: 'FLOWTOKEN',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(out).toBe(userObj)
      expect(usersManager.findUser).toHaveBeenCalledWith('alice@example.test', false)
      expect(mockedAuthorizationCodeGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(URL),
        expect.objectContaining({ expectedState: 'FLOWTOKEN', pkceCodeVerifier: 'CV', expectedNonce: 'NONCE' })
      )
    })

    it('returns null when no Sync-in user matches the OIDC email or login', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub-999' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub-999',
        email: 'ghost@example.test'
      })
      // Both email lookup and login lookup miss → null
      usersManager.findUser.mockResolvedValue(null)

      const out = await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/custom-mobile/oidc/callback?code=CODE&state=FLOWTOKEN'),
        expectedState: 'FLOWTOKEN',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(out).toBeNull()
    })

    it('falls back to preferred_username lookup when email lookup misses', async () => {
      // Real-world case: user has Sync-in `email = janwiebe@janwie.be` and
      // `login = janwiebe`, but Authelia returns a different email (`other@x`)
      // because the Authelia profile carries a different address. The login
      // (preferred_username) still matches.
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub',
        email: 'other@elsewhere.test',
        preferred_username: 'janwiebe'
      })
      const userObj = { id: 7, login: 'janwiebe', email: 'janwiebe@janwie.be' }
      usersManager.findUser.mockResolvedValueOnce(null) // email lookup → miss
      usersManager.findUser.mockResolvedValueOnce(userObj) // login lookup → hit

      const out = await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
        expectedState: 'S',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(out).toBe(userObj)
      expect(usersManager.findUser).toHaveBeenNthCalledWith(1, 'other@elsewhere.test', false)
      expect(usersManager.findUser).toHaveBeenNthCalledWith(2, 'janwiebe', false)
    })

    it('lowercases email before lookup (defensive against case-mismatched IdP claims)', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub',
        email: 'Alice@Example.Test',
        preferred_username: 'alice'
      })
      usersManager.findUser.mockResolvedValueOnce({ id: 1, login: 'alice' })

      await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
        expectedState: 'S',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(usersManager.findUser).toHaveBeenCalledWith('alice@example.test', false)
    })

    it('still works when IdP omits the email claim entirely (login fallback)', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub',
        preferred_username: 'janwiebe'
        // no email claim — Authelia profile has no email set
      })
      const userObj = { id: 7, login: 'janwiebe' }
      usersManager.findUser.mockResolvedValueOnce(userObj)

      const out = await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
        expectedState: 'S',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(out).toBe(userObj)
      expect(usersManager.findUser).toHaveBeenCalledWith('janwiebe', false)
    })

    it('rejects ID token with no sub', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({})
      })
      await expect(
        service.exchangeAndResolveUser({
          callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
          expectedState: 'S',
          codeVerifier: 'CV',
          nonce: 'N'
        })
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    })

    it('rejects userinfo with no email', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({ sub: 'idp-sub' })
      await expect(
        service.exchangeAndResolveUser({
          callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
          expectedState: 'S',
          codeVerifier: 'CV',
          nonce: 'N'
        })
      ).rejects.toBeInstanceOf(HttpException)
    })

    it('drops PKCE verifier when issuer reports no support', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(false))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({ sub: 'idp-sub', email: 'a@b.test' })
      usersManager.findUser.mockResolvedValueOnce({ login: 'a' })

      await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/cb?code=C&state=S'),
        expectedState: 'S',
        codeVerifier: 'CV',
        nonce: 'N'
      })
      expect(mockedAuthorizationCodeGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(URL),
        expect.objectContaining({ pkceCodeVerifier: undefined })
      )
    })
  })
})
