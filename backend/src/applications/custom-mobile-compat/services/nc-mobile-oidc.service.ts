import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  authorizationCodeGrant,
  calculatePKCECodeChallenge,
  Configuration,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  skipSubjectCheck
} from 'openid-client'
import { AuthProviderOIDC } from '../../../authentication/providers/oidc/auth-provider-oidc.service'
import { configuration } from '../../../configuration/config.environment'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'

// Mobile-side OIDC plumbing for the Nextcloud Login Flow v2 browser hop.
//
// Wraps openid-client to (a) build an authorization URL whose `state`
// parameter is the NC `loginToken` (so the callback can route to the right
// in-flight flow without cookies) and (b) exchange the auth code for a user
// lookup. Mobile flow is lookup-only — if the IdP authenticates a user that
// has no Sync-in account, this resolver returns `null` and the controller
// renders a friendly "log into the web app once first" page.
//
// See docs/plans/2026-04-25-mobile-nc-oidc-login-design.md.
@Injectable()
export class NcMobileOidcService {
  private readonly logger = new Logger(NcMobileOidcService.name)

  constructor(
    private readonly authProviderOIDC: AuthProviderOIDC,
    private readonly usersManager: UsersManager
  ) {}

  async buildAuthorizationUrl(loginToken: string, redirectUri: string): Promise<{ url: string; codeVerifier: string; nonce: string }> {
    const config = await this.authProviderOIDC.getConfig()
    const oidcConfig = configuration.auth.oidc
    const codeVerifier = randomPKCECodeVerifier()
    const nonce = randomNonce()
    const isPKCEEnabled = this.isPKCEEnabled(config)

    const authUrl = new URL(config.serverMetadata().authorization_endpoint!)
    authUrl.searchParams.set('client_id', oidcConfig.clientId!)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', oidcConfig.security.scope)
    authUrl.searchParams.set('state', loginToken)
    authUrl.searchParams.set('nonce', nonce)
    if (isPKCEEnabled) {
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
    }
    return { url: authUrl.toString(), codeVerifier, nonce }
  }

  async exchangeAndResolveUser(opts: { callbackUrl: URL; expectedState: string; codeVerifier: string; nonce: string }): Promise<UserModel | null> {
    const config = await this.authProviderOIDC.getConfig()
    const oidcConfig = configuration.auth.oidc
    const isPKCEEnabled = this.isPKCEEnabled(config)

    const tokens = await authorizationCodeGrant(config, opts.callbackUrl, {
      expectedState: opts.expectedState,
      pkceCodeVerifier: isPKCEEnabled ? opts.codeVerifier : undefined,
      expectedNonce: opts.nonce
    })

    const claims = tokens.claims()
    if (!claims?.sub) {
      throw new HttpException('Missing sub in ID token', HttpStatus.BAD_REQUEST)
    }
    const subject = oidcConfig.security.skipSubjectCheck ? skipSubjectCheck : claims.sub
    const userInfo = await fetchUserInfo(config, tokens.access_token, subject)

    // Resolve the Sync-in account the way upstream's own OIDC provider does
    // (auth-provider-oidc.service.ts::processUserInfo). Mobile is lookup-only
    // — no auto-create — but every identity check upstream performs applies
    // here too, and previously none of them did.
    //
    // What this replaced, and why each part had to go:
    //
    //   * A bare `findUser(email)` with no `externalId` binding. `externalId`
    //     pins a Sync-in account to one IdP subject; without it, anyone whose
    //     IdP profile carries a victim's email address resolves onto the
    //     victim's account. That is the whole reason upstream binds.
    //   * A `preferred_username` fallback upstream never performs. `findUser`
    //     matches the `login` column as well as `email`, so an IdP principal
    //     whose `preferred_username` equalled a Sync-in *login* landed on that
    //     account.
    //   * No `isActive` check, so a deactivated account could still be paired.
    //
    // `skipSubjectCheck` above only relaxes the userinfo-endpoint subject
    // assertion; `claims.sub` is still the verified ID-token subject, so it is
    // the right value to bind on.
    const externalId = claims.sub
    const email = userInfo.email?.trim().toLowerCase()

    // Matching an account by an UNVERIFIED email is the takeover vector this
    // whole block exists to close, so honour the same config gate upstream
    // uses on its create path.
    if (email && configuration.auth.oidc?.security?.requireVerifiedEmail && (userInfo as { email_verified?: boolean }).email_verified !== true) {
      throw new HttpException('OIDC email must be verified', HttpStatus.BAD_REQUEST)
    }

    // `''` rather than undefined: the lookup is a prepared statement with an
    // email placeholder, and an absent email must simply never match a row —
    // not bind as NULL and not blow up. An account already bound to this
    // subject still resolves, because the query ORs on externalId and orders
    // the externalId match first.
    const user: UserModel | null = (await this.usersManager.findUserByExternalIdOrEmail(externalId, email ?? '', false)) ?? null

    if (user?.externalId && user.externalId !== externalId) {
      this.logger.warn({
        tag: this.exchangeAndResolveUser.name,
        msg: `OIDC identity mismatch for *${user.login}* — bound to a different subject`
      })
      throw new HttpException('OIDC identity mismatch', HttpStatus.UNAUTHORIZED)
    }

    if (user && !user.isActive) {
      this.logger.warn({ tag: this.exchangeAndResolveUser.name, msg: `user account *${user.login}* is locked` })
      throw new HttpException('Account locked', HttpStatus.FORBIDDEN)
    }

    // First OIDC login for an account matched by email: pin it, so every later
    // login (web or mobile) goes down the externalId branch instead of the
    // email one. Mirrors upstream.
    if (user && !user.externalId) {
      if (!(await this.usersManager.usersQueries.bindExternalId(user.id, externalId))) {
        throw new HttpException('Unable to link OIDC identity', HttpStatus.UNAUTHORIZED)
      }
      user.externalId = externalId
    }

    if (!user) {
      this.logger.warn({
        tag: this.exchangeAndResolveUser.name,
        msg: `no Sync-in account matched OIDC profile — email=${email ?? '<absent>'} sub=${externalId}`
      })
    }
    return user
  }

  private isPKCEEnabled(config: Configuration): boolean {
    return (configuration.auth.oidc.security.supportPKCE ?? true) && config.serverMetadata().supportsPKCE()
  }
}
