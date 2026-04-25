import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { authorizationCodeGrant, calculatePKCECodeChallenge, fetchUserInfo, randomNonce, randomPKCECodeVerifier } from 'openid-client'
import { AuthProviderOIDC } from '../../../authentication/providers/oidc/auth-provider-oidc.service'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcMobileOidcService } from './nc-mobile-oidc.service'

jest.mock('../../../configuration/config.environment', () => ({
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

jest.mock('openid-client', () => ({
  authorizationCodeGrant: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  fetchUserInfo: jest.fn(),
  randomNonce: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  skipSubjectCheck: Symbol('skipSubjectCheck')
}))

const mockedAuthorizationCodeGrant = authorizationCodeGrant as jest.Mock
const mockedCalculatePKCECodeChallenge = calculatePKCECodeChallenge as jest.Mock
const mockedFetchUserInfo = fetchUserInfo as jest.Mock
const mockedRandomNonce = randomNonce as jest.Mock
const mockedRandomPKCECodeVerifier = randomPKCECodeVerifier as jest.Mock

describe(NcMobileOidcService.name, () => {
  let service: NcMobileOidcService
  let authProviderOIDC: { getConfig: jest.Mock }
  let usersManager: { findUser: jest.Mock }

  const makeConfig = (supportsPKCE = true) => ({
    serverMetadata: () => ({
      supportsPKCE: () => supportsPKCE,
      authorization_endpoint: 'https://authelia.example.test/api/oidc/authorization'
    })
  })

  beforeAll(async () => {
    authProviderOIDC = { getConfig: jest.fn() }
    usersManager = { findUser: jest.fn() }

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [{ provide: AuthProviderOIDC, useValue: authProviderOIDC }, { provide: UsersManager, useValue: usersManager }, NcMobileOidcService]
    }).compile()

    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcMobileOidcService)
  })

  beforeEach(() => {
    jest.clearAllMocks()
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

    it('returns null when no Sync-in user matches the OIDC email', async () => {
      authProviderOIDC.getConfig.mockResolvedValueOnce(makeConfig(true))
      mockedAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: 'AT',
        claims: () => ({ sub: 'idp-sub-999' })
      })
      mockedFetchUserInfo.mockResolvedValueOnce({
        sub: 'idp-sub-999',
        email: 'ghost@example.test'
      })
      usersManager.findUser.mockResolvedValueOnce(null)

      const out = await service.exchangeAndResolveUser({
        callbackUrl: new URL('https://api.example.test/custom-mobile/oidc/callback?code=CODE&state=FLOWTOKEN'),
        expectedState: 'FLOWTOKEN',
        codeVerifier: 'CV',
        nonce: 'NONCE'
      })
      expect(out).toBeNull()
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
