import { Global, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { ThrottlerModule } from '@nestjs/throttler'
import { UsersModule } from '../applications/users/users.module'
import { IS_TEST_ENV } from '../configuration/config.constants'
import { configuration } from '../configuration/config.environment'
import { CacheModule } from '../infrastructure/cache/cache.module'
import { Cache } from '../infrastructure/cache/cache.service'
import { AuthRateLimitStorage } from './adapters/auth-rate-limit-storage.adapter'
import { AuthController } from './auth.controller'
import { AuthManager } from './auth.service'
import { AUTH_RATE_LIMIT_OPTIONS } from './constants/auth'
import { AuthAnonymousGuard } from './guards/auth-anonymous.guard'
import { AuthAnonymousStrategy } from './guards/auth-anonymous.strategy'
import { AuthBasicGuard } from './guards/auth-basic.guard'
import { AuthBasicStrategy } from './guards/auth-basic.strategy'
import { AuthLocalGuard } from './guards/auth-local.guard'
import { AuthLocalStrategy } from './guards/auth-local.strategy'
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard'
import { AuthTokenAccessGuard } from './guards/auth-token-access.guard'
import { AuthTokenAccessStrategy } from './guards/auth-token-access.strategy'
import { AuthTokenRefreshGuard } from './guards/auth-token-refresh.guard'
import { AuthTokenRefreshStrategy } from './guards/auth-token-refresh.strategy'
import { AUTH_PROVIDER } from './providers/auth-providers.constants'
import { AuthProvider } from './providers/auth-providers.models'
import { selectAuthProvider } from './providers/auth-providers'
import { AuthProviderOIDCModule } from './providers/oidc/auth-provider-oidc.module'
import { AuthProvider2FA } from './providers/two-fa/auth-provider-two-fa.service'
import { AuthTokenTwoFaGuard } from './providers/two-fa/guards/auth-token-two-fa.guard'
import { AuthTokenTwoFaStrategy } from './providers/two-fa/guards/auth-token-two-fa.strategy'

@Global()
@Module({
  imports: [
    JwtModule.register({ global: true }),
    ThrottlerModule.forRootAsync({
      imports: [CacheModule],
      inject: [Cache],
      useFactory: (cache: Cache) => ({
        throttlers: [AUTH_RATE_LIMIT_OPTIONS],
        storage: new AuthRateLimitStorage(cache),
        /* mod(auth): the limiter is OFF under NODE_ENV=test.
           AUTH_RATE_LIMIT_OPTIONS is a hard-coded 6 logins / 60s keyed on the
           caller, and the e2e suite runs 17 spec files in PARALLEL against one
           database, each of which logs in at least once through app.inject() — so
           the shared counter is exhausted and everything after it gets 429.
           It breaks UPSTREAM's own auth.e2e-spec.ts too, not just fork specs;
           upstream ships no e2e workflow (only release/release_docker_test/test),
           which is why this reached us unnoticed. Rate limiting is not what any of
           these specs exercise, so skipping it in test costs no coverage.
           Re-apply on every upstream sync. Candidate for upstream-contrib. */
        skipIf: () => IS_TEST_ENV
      })
    }),
    UsersModule,
    PassportModule,
    ...(configuration.auth.provider === AUTH_PROVIDER.OIDC ? [AuthProviderOIDCModule] : [])
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthTokenAccessGuard
    },
    AuthRateLimitGuard,
    AuthTokenRefreshGuard,
    AuthTokenTwoFaGuard,
    AuthLocalGuard,
    AuthBasicGuard,
    AuthAnonymousGuard,
    AuthLocalStrategy,
    AuthTokenAccessStrategy,
    AuthTokenRefreshStrategy,
    AuthTokenTwoFaStrategy,
    AuthBasicStrategy,
    AuthAnonymousStrategy,
    AuthManager,
    AuthProvider2FA,
    selectAuthProvider(configuration.auth.provider)
  ],
  exports: [AuthManager, AuthProvider, AuthProvider2FA, AuthRateLimitGuard]
})
export class AuthModule {}
