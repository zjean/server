import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { instanceToPlain, plainToInstance } from 'class-transformer'
import { FastifyReply, FastifyRequest } from 'fastify'
import { PinoLogger } from 'nestjs-pino'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { genHash } from '../../files/utils/files'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NC_AUTH_REALM } from '../constants/routes'

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
  private static readonly CACHE_PREFIX = 'auth-nc-mobile'

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

    // Look up user by login or email.
    const userRow = await this.usersQueries.from(undefined, login)
    if (!userRow) {
      await this.cache.set(cacheKey, null, NcBasicAuthGuard.CACHE_TTL_SECONDS)
      this.unauthorized(res, 'user not found')
    }

    const user = new UserModel(userRow)
    const ip = this.clientIp(req)

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
