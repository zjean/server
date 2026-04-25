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

    // Lowercase email defensively — DB collation is `_ci` so this is mostly
    // belt-and-suspenders, but it also keeps the warn log readable.
    const email = userInfo.email?.trim().toLowerCase()
    const preferred = userInfo.preferred_username?.trim().toLowerCase()
    if (!email && !preferred) {
      throw new HttpException('OIDC profile has neither email nor preferred_username', HttpStatus.BAD_REQUEST)
    }

    // Two-step lookup: by email first (typical case — Sync-in user was
    // created with their real email), then by login (covers IdPs that return
    // a different email than what's in Sync-in's user table, or no email at
    // all). Mobile is lookup-only — no auto-create.
    let user: UserModel | null = email ? ((await this.usersManager.findUser(email, false)) ?? null) : null
    if (!user && preferred && preferred !== email) {
      user = (await this.usersManager.findUser(preferred, false)) ?? null
    }
    if (!user) {
      this.logger.warn({
        tag: this.exchangeAndResolveUser.name,
        msg: `no Sync-in account matched OIDC profile — email=${email ?? '<absent>'} preferred_username=${preferred ?? '<absent>'} sub=${userInfo.sub}`
      })
    }
    return user
  }

  private isPKCEEnabled(config: Configuration): boolean {
    return (configuration.auth.oidc.security.supportPKCE ?? true) && config.serverMetadata().supportsPKCE()
  }
}
