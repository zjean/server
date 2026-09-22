import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import { instanceToPlain, plainToInstance } from 'class-transformer'
import { FastifyReply, FastifyRequest } from 'fastify'
import { PinoLogger } from 'nestjs-pino'
import { AUTH_RATE_LIMIT_ERROR_MESSAGE } from '../../../authentication/constants/auth'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { genHash } from '../../files/utils/files'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { CACHE_AUTH_NC_MOBILE_PREFIX } from '../../custom-shared/constants/auth-cache'
import { NC_RATE_LIMIT_OPTIONS, NC_RATE_LIMIT_SCOPE } from '../constants/rate-limit'
import { NC_AUTH_REALM } from '../constants/routes'
import { setRetryAfter } from './nc-rate-limit.guard'

// NcBasicAuthGuard
//
// Basic-Auth that only accepts credentials minted by the NC login-v2 flow
// (app-passwords scoped to AUTH_SCOPE.MOBILE_NC). The user's main login
// password is deliberately rejected on NC routes — matches Nextcloud's own
// posture and OxiCloud's implementation.
//
// Caches successful auth for 15 minutes keyed by sha256(login + password) to
// keep per-request latency acceptable on WebDAV floods (the NC client spams
// PROPFINDs during sync).
@Injectable()
export class NcBasicAuthGuard implements CanActivate {
  private static readonly CACHE_TTL_SECONDS = 900
  // Shared with UsersManager.deleteAppPassword, which scans this prefix to
  // evict a revoked credential it has no cleartext for (#476). Changing the
  // literal in one place only would silently un-revoke every NC device.
  private static readonly CACHE_PREFIX = CACHE_AUTH_NC_MOBILE_PREFIX
  private static readonly RATE_LIMIT_PREFIX = 'nc-rate-limit-basic'

  constructor(
    private readonly usersQueries: UsersQueries,
    private readonly usersManager: UsersManager,
    private readonly cache: Cache,
    private readonly logger: PinoLogger
  ) {}

  // Build the cache key for a (login, password) pair. Exposed so callers that
  // invalidate the underlying credential (e.g. DELETE apppassword) can
  // explicitly evict the positive cache entry — otherwise a revoked credential
  // would still pass for the remaining TTL.
  static cacheKeyFor(login: string, password: string): string {
    return `${NcBasicAuthGuard.CACHE_PREFIX}-${genHash(`${login} ${password}`, 'sha256')}`
  }

  // Evict the cached entry for a credential pair. Safe to call when no entry
  // exists. Cache impls differ on whether `del` on a missing key throws;
  // catch to tolerate both.
  async evictCache(login: string, password: string): Promise<void> {
    try {
      await this.cache.del(NcBasicAuthGuard.cacheKeyFor(login, password))
    } catch {
      /* no-op: cache missing the key is fine */
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const req = http.getRequest<FastifyRequest & { user?: UserModel }>()
    const res = http.getResponse<FastifyReply>()

    const parsed = parseBasicAuth(req.headers['authorization'])
    if (!parsed) {
      this.unauthorized(res, 'missing or malformed Authorization header')
    }

    const { login, password } = parsed
    const cacheKey = NcBasicAuthGuard.cacheKeyFor(login, password)

    // Short-circuit: positive cache hit.
    const cached = await this.cache.get(cacheKey)
    if (cached === null) {
      // Negative cache — recent failure.
      this.unauthorized(res, 'invalid credentials')
    }
    if (cached) {
      // Cached entries are plain objects (JSON-serialized by the cache layer);
      // rehydrate into UserModel so prototype methods like havePermission() work.
      req.user = plainToInstance(UserModel, cached)
      return true
    }

    // Per-IP limit on credentials that MISS the cache, i.e. the ones that go
    // on to cost a DB lookup and up to MAX_MOBILE_PASSWORDS bcrypt(10) rounds
    // (#477). The equivalent of AuthBasicStrategy's WebDAV limiter, which this
    // guard is otherwise a copy of and which had no counterpart here.
    //
    // It has to be per IP rather than per credential, because the guard's
    // failure cache is already keyed on the credential PAIR: an attacker
    // sending a unique password every request never hits that cache and so
    // never pays for the previous attempt. Tracking the IP also catches
    // password-spraying, which by construction never repeats a pair.
    //
    // Placed after the cache check so an established client syncing at full
    // tilt — every request of which is authenticated — spends nothing, and
    // before the DB lookup so the cheap half of the work is covered too.
    //
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
    const rateLimit = await this.cache.consumeRateLimit(
      `${NcBasicAuthGuard.RATE_LIMIT_PREFIX}${NC_RATE_LIMIT_SCOPE}-${genHash((req.ip as string | undefined) ?? 'unknown', 'sha256')}`,
      NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.ttl,
      NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.limit,
      NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.blockDuration
    )
    // 429 on the DAV surface, checked against stock-client source rather than
    // assumed. A blocked caller here gets `ThrottlerException` — 429, JSON
    // body, no `WWW-Authenticate` — which both clients treat as a transient,
    // per-operation error, and neither can turn into a re-auth prompt:
    //
    //   - iOS. The ONLY writer of the account-error lists,
    //     NextcloudKit `Sources/NextcloudKit/NKCommon.swift`
    //     `appendServerErrorAccount`, branches on 503 / 401 / 403-with-ToS
    //     and has no `else`, so 429 persists nothing. The logout path
    //     (`NCAccount.checkRemoteUser` → `deleteAccount`) is additionally
    //     gated on `statusCode == 401`. 429 is a display string only
    //     (`NKError.swift`, "Too many requests"). Throttled uploads are
    //     re-queued on the 5-minute timer in `NCNetworkingProcess.swift`,
    //     whose exclusion is `NSURLErrorUserAuthenticationRequired`, not 429.
    //   - Android. `RemoteOperationResult` has no 429 case, so it becomes
    //     `UNHANDLED_HTTP_CODE`; the credential wipe in `RemoteOperation.java`
    //     is `ResultCode.UNAUTHORIZED == result.getCode()`, exact equality, as
    //     is every re-auth trigger in the app.
    //
    // Read at nextcloud/NextcloudKit 1f07840c, nextcloud/ios d8eee779,
    // nextcloud/android-library 20bcd79a (the exact commits those projects
    // pin each other to). The same check rules out the obvious alternatives:
    // 503 is the WORST code here — iOS parks the account in
    // `groupDefaultsUnavailable` and `NKInterceptor.adapt` then fails every
    // later request for it client-side until a foreground-only `status.php`
    // poll clears it — and 401 is the logout trigger itself.
    //
    // Two constraints this leaves on the response, both satisfied above:
    // keep the body JSON without an `ocs.meta.statuscode` (NKError reads that
    // path first and coerces a 2xx value to "success"), and keep the budget
    // generous, because neither client backs off on 429.
    if (rateLimit.isBlocked) {
      setRetryAfter(res, rateLimit.timeToBlockExpire, NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.blockDuration)
      throw new ThrottlerException(AUTH_RATE_LIMIT_ERROR_MESSAGE)
    }

    // Look up user by login or email.
    const userRow = await this.usersQueries.from(undefined, login)
    if (!userRow) {
      await this.cache.set(cacheKey, null, NcBasicAuthGuard.CACHE_TTL_SECONDS)
      this.unauthorized(res, 'user not found')
    }

    const user = new UserModel(userRow)
    const ip = this.clientIp(req)

    // Account-level gate, BEFORE any password work.
    //
    // `validateAppPassword` only checks `haveRole(USER_ROLE.USER)` — it knows
    // nothing about `isActive`, the guest-link role, or the password-attempt
    // lockout. Every other credential path in the app reaches those checks via
    // `logUser`, whose first line is `validateUserAccess`. This guard calls
    // `validateAppPassword` directly, so without this it never ran: a
    // deactivated account kept full NC access (DAV read/write, chunked upload,
    // versions) for as long as the app password existed.
    //
    // Deliberately NOT negative-cached: the cache is keyed on the credential
    // pair with a 900s TTL, so caching a lockout would keep a re-activated
    // account locked out for the remainder of it. The lookup above is the only
    // cost, and it has already happened.
    //
    // Translated to 401 rather than passed through as 403 so NC clients
    // re-prompt for credentials instead of treating it as a permanent
    // per-resource denial.
    try {
      await this.usersManager.validateUserAccess(user)
    } catch (e) {
      this.logger.warn({ tag: 'nc-auth', msg: `access refused: ${login} ${ip} (${(e as Error).message})` })
      this.unauthorized(res, 'account not allowed')
    }

    // Only AUTH_SCOPE.MOBILE_NC app-passwords work — main password rejected.
    const ok = await this.usersManager.validateAppPassword(user, password, ip, AUTH_SCOPE.MOBILE_NC)
    if (!ok) {
      await this.cache.set(cacheKey, null, NcBasicAuthGuard.CACHE_TTL_SECONDS)
      this.logger.warn({ tag: 'nc-auth', msg: `rejected: ${login} ${ip}` })
      this.unauthorized(res, 'invalid app password')
    }

    await this.cache.set(cacheKey, instanceToPlain(user), NcBasicAuthGuard.CACHE_TTL_SECONDS)
    req.user = user
    return true
  }

  private clientIp(req: FastifyRequest): string {
    const fwd = req.headers['x-forwarded-for'] as string | undefined
    if (fwd) return fwd.split(',')[0].trim()
    return (req.ip as string | undefined) ?? 'unknown'
  }

  private unauthorized(res: FastifyReply, reason: string): never {
    res.header('WWW-Authenticate', `Basic realm="${NC_AUTH_REALM}"`)
    throw new HttpException(reason, HttpStatus.UNAUTHORIZED)
  }
}

// Returns { login, password } or null if the header is absent / malformed.
export function parseBasicAuth(authHeader: string | string[] | undefined): { login: string; password: string } | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!header) return null
  const match = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return null
  }
  const sep = decoded.indexOf(':')
  if (sep < 1) return null
  return { login: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}
