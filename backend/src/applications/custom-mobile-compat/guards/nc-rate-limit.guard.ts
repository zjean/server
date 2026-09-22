import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ThrottlerException } from '@nestjs/throttler'
import { FastifyRequest } from 'fastify'
import { AUTH_RATE_LIMIT_ERROR_MESSAGE } from '../../../authentication/constants/auth'
import { genHash } from '../../files/utils/files'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NC_RATE_LIMIT_SCOPE, type NcRateLimitOptions } from '../constants/rate-limit'

export const NC_RATE_LIMIT_METADATA = 'nc-rate-limit'

// Meter this route per client IP. Without the decorator the guard is inert, so
// putting it on a controller class costs nothing until a handler opts in.
export const NcRateLimit = (options: NcRateLimitOptions) => SetMetadata(NC_RATE_LIMIT_METADATA, options)

// Per-IP limiter for the Nextcloud-compatible routes (#477).
//
// Why not `AuthRateLimitGuard` (the `@nestjs/throttler` subclass upstream uses
// on /auth/login)? Its module registration carries
// `skipIf: () => IS_TEST_ENV` — a deliberate mod, because the e2e suite runs
// spec files in parallel against one database and every one of them logs in,
// which exhausts a shared 6/60s counter. A limiter that is off in the only
// environment we can assert in cannot be regression-tested, and these routes
// are exactly the ones where "is it actually wired up?" is the question.
//
// This guard goes straight to `Cache.consumeRateLimit`, which is the same
// atomic sliding-window primitive `AuthRateLimitStorage` hands the throttler
// and the same one `AuthBasicStrategy` calls directly for its per-IP WebDAV
// limiter. Being cache-backed, it is shared across replicas.
@Injectable()
export class NcRateLimitGuard implements CanActivate {
  private static readonly KEY_PREFIX = 'nc-rate-limit'

  constructor(
    private readonly cache: Cache,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<NcRateLimitOptions | undefined>(NC_RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass()
    ])
    if (!options) return true

    const req = context.switchToHttp().getRequest<FastifyRequest>()
    // Bucketed on `req.ip` — NOT on the raw X-Forwarded-For this module reads
    // for LOGGING. Read carefully, because the two are not the same claim:
    //
    //   - The HEADER is never read here, so a caller cannot name its own
    //     bucket by adding one when the deployment does not expect it.
    //   - The VALUE still depends on `server.trustProxy` (app.bootstrap.ts,
    //     default `1`). With `trustProxy` truthy and NO reverse proxy in
    //     front, Fastify derives `req.ip` from the caller's own
    //     X-Forwarded-For, so an attacker rotating that header gets a fresh
    //     bucket per value and walks past this limiter.
    //
    // That is not specific to this guard: upstream's AuthBasicStrategy and
    // AuthRateLimitGuard key on the same `req.ip`, and `auth.md` already
    // states the client address follows `server.trustProxy`. The deployment
    // contract is therefore: either front the app with a reverse proxy that
    // overwrites X-Forwarded-For, or set `server.trustProxy: false`. A
    // `trustProxy` that does not describe the deployment silently weakens
    // every per-IP limit in the app, this one included.
    const key = `${NcRateLimitGuard.KEY_PREFIX}${NC_RATE_LIMIT_SCOPE}-${bucketOf(context)}-${genHash(req.ip ?? 'unknown', 'sha256')}`
    const result = await this.cache.consumeRateLimit(key, options.ttl, options.limit, options.blockDuration)
    if (result.isBlocked) {
      throw new ThrottlerException(AUTH_RATE_LIMIT_ERROR_MESSAGE)
    }
    return true
  }
}

// One counter per handler, like ThrottlerGuard's own key derivation — so the
// grant route's budget is not spent by the poll route's traffic.
function bucketOf(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`
}
