import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { ThrottlerException } from '@nestjs/throttler'
import { PinoLogger } from 'nestjs-pino'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NC_RATE_LIMIT_OPTIONS } from '../constants/rate-limit'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'
import { NcBasicAuthGuard, parseBasicAuth } from './nc-basic-auth.guard'
import { Mock } from 'vitest'

// Build an ExecutionContext stub that surfaces whatever headers/ip we pass and
// collects the WWW-Authenticate header + the req.user mutation.
function makeContext(authHeader?: string | string[]): {
  ctx: ExecutionContext
  req: { headers: Record<string, string | string[] | undefined>; ip: string; user?: unknown }
  res: { headers: Record<string, string>; header: Mock }
} {
  const req: { headers: Record<string, string | string[] | undefined>; ip: string; user?: unknown } = {
    headers: { authorization: authHeader },
    ip: '10.0.0.1'
  }
  const res = {
    headers: {} as Record<string, string>,
    header: vi.fn<void, [string, string]>()
  }
  res.header.mockImplementation((k: string, v: string) => {
    res.headers[k] = v
  })
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res
    })
  } as unknown as ExecutionContext
  return { ctx, req, res }
}

// Encode "login:password" → Basic header
function basic(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`
}

describe(NcBasicAuthGuard.name, () => {
  let guard: NcBasicAuthGuard
  let usersQueries: { from: Mock }
  let usersManager: { validateAppPassword: Mock; validateUserAccess: Mock }
  let cache: { get: Mock; set: Mock; consumeRateLimit: Mock }
  let logger: { warn: Mock; error: Mock; info: Mock }
  let module: TestingModule

  beforeEach(async () => {
    usersQueries = { from: vi.fn() }
    // validateUserAccess resolves by default = 'account is allowed'. It throws
    // for locked/deactivated/guest-link accounts, which the guard must honour.
    usersManager = { validateAppPassword: vi.fn(), validateUserAccess: vi.fn().mockResolvedValue(undefined) }
    cache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(true),
      consumeRateLimit: vi.fn().mockResolvedValue({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 })
    }
    logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }

    module = await Test.createTestingModule({
      providers: [
        NcBasicAuthGuard,
        { provide: UsersQueries, useValue: usersQueries },
        { provide: UsersManager, useValue: usersManager },
        { provide: Cache, useValue: cache },
        { provide: PinoLogger, useValue: logger }
      ]
    }).compile()
    guard = module.get(NcBasicAuthGuard)
  })

  afterEach(async () => {
    await module.close()
  })

  it('returns 401 with WWW-Authenticate realm when Authorization header is missing', async () => {
    const { ctx, res } = makeContext(undefined)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
    expect(res.headers['WWW-Authenticate']).toMatch(/^Basic realm="/)
  })

  it('returns 401 when Authorization header is malformed', async () => {
    const { ctx, res } = makeContext('Bearer abc.def')
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      getStatus: expect.any(Function)
    })
    expect(res.headers['WWW-Authenticate']).toMatch(/^Basic realm="/)
  })

  it('returns 401 when the user is not found', async () => {
    usersQueries.from.mockResolvedValue(null)
    const { ctx } = makeContext(basic('ghost', 'irrelevant'))
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({})
    expect(usersQueries.from).toHaveBeenCalledWith(undefined, 'ghost')
    // should cache the failure
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), null, expect.any(Number))
  })

  it('returns 401 when the app password is invalid', async () => {
    usersQueries.from.mockResolvedValue({ id: 7, login: 'alice' })
    usersManager.validateAppPassword.mockResolvedValue(false)
    const { ctx } = makeContext(basic('alice', 'wrong-pw'))
    let err: unknown
    try {
      await guard.canActivate(ctx)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED)
    expect(usersManager.validateAppPassword).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), null, expect.any(Number))
  })

  it('success path: returns true, caches user, sets req.user', async () => {
    usersQueries.from.mockResolvedValue({ id: 42, login: 'bob' })
    usersManager.validateAppPassword.mockResolvedValue(true)
    const { ctx, req } = makeContext(basic('bob', 'app-pw'))
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.user).toBeDefined()
    expect((req.user as { login: string }).login).toBe('bob')
    // positive cache write
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.any(Number))
  })

  it('positive cache hit short-circuits the lookup', async () => {
    const cachedUser = { id: 99, login: 'cached' }
    cache.get.mockResolvedValue(cachedUser)
    const { ctx, req } = makeContext(basic('cached', 'any'))
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    // Cached entry is rehydrated into a UserModel instance (new reference, same fields).
    expect(req.user).toMatchObject({ id: 99, login: 'cached' })
    expect(usersQueries.from).not.toHaveBeenCalled()
    expect(usersManager.validateAppPassword).not.toHaveBeenCalled()
  })

  it('negative cache hit (null) short-circuits to 401', async () => {
    cache.get.mockResolvedValue(null)
    const { ctx } = makeContext(basic('burned', 'pw'))
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
    expect(usersQueries.from).not.toHaveBeenCalled()
  })

  it('forwards the x-forwarded-for first hop to validateAppPassword', async () => {
    usersQueries.from.mockResolvedValue({ id: 1, login: 'alice' })
    usersManager.validateAppPassword.mockResolvedValue(true)
    const { ctx, req } = makeContext(basic('alice', 'p'))
    req.headers['x-forwarded-for'] = '203.0.113.9, 10.0.0.1'
    await guard.canActivate(ctx)
    expect(usersManager.validateAppPassword).toHaveBeenCalledWith(expect.anything(), 'p', '203.0.113.9', expect.any(String))
  })

  // The defect: this guard reaches validateAppPassword directly, and that
  // method only checks haveRole(USER) — it knows nothing about isActive, the
  // guest-link role, or the password-attempt lockout. Every other credential
  // path in the app gets those via logUser → validateUserAccess. Without this
  // gate, deactivating an account left its paired phones syncing indefinitely.
  describe('account-level gate (validateUserAccess)', () => {
    beforeEach(() => {
      usersQueries.from.mockResolvedValue({ id: 7, login: 'alice', password: 'hash' })
      usersManager.validateAppPassword.mockResolvedValue(true)
    })

    it('refuses a deactivated account even when the app password is valid', async () => {
      usersManager.validateUserAccess.mockRejectedValue(new HttpException('Account locked', HttpStatus.FORBIDDEN))
      const { ctx, res } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED })
      // 401 + challenge, not 403, so NC clients re-prompt rather than treating
      // it as a permanent per-resource denial.
      expect(res.headers['WWW-Authenticate']).toMatch(/^Basic realm=/)
    })

    it('does not spend bcrypt work on an account it is going to refuse', async () => {
      usersManager.validateUserAccess.mockRejectedValue(new HttpException('Account locked', HttpStatus.FORBIDDEN))
      const { ctx } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
      expect(usersManager.validateAppPassword).not.toHaveBeenCalled()
    })

    it('does not negative-cache the refusal, so re-activating takes effect at once', async () => {
      usersManager.validateUserAccess.mockRejectedValue(new HttpException('Account locked', HttpStatus.FORBIDDEN))
      const { ctx } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
      // A cached negative would keep a re-enabled account locked out for the
      // remaining 900s TTL — the same class of bug as the revocation lag.
      expect(cache.set).not.toHaveBeenCalled()
    })

    it('lets an allowed account through to the password check', async () => {
      const { ctx, req } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
      expect(usersManager.validateUserAccess).toHaveBeenCalled()
      expect((req.user as { login: string }).login).toBe('alice')
    })
  })

  // #477.1 — unauthenticated bcrypt CPU exhaustion.
  //
  // `validateAppPassword` bcrypt(10)s the presented password against up to
  // MAX_MOBILE_PASSWORDS stored hashes, and the guard's failure cache is keyed
  // on the credential PAIR — so an attacker who never repeats a password never
  // hits it and never pays for the previous attempt. This guard was a copy of
  // AuthBasicStrategy minus exactly its per-IP limiter.
  describe('per-IP rate limit on cache misses', () => {
    beforeEach(() => {
      usersQueries.from.mockResolvedValue({ id: 7, login: 'alice', isActive: true })
      usersManager.validateAppPassword.mockResolvedValue(true)
    })

    it('consumes one unit of the per-IP budget before doing any password work', async () => {
      const { ctx } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
      expect(cache.consumeRateLimit).toHaveBeenCalledWith(
        expect.any(String),
        NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.ttl,
        NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.limit,
        NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.blockDuration
      )
    })

    it('refuses a blocked caller WITHOUT reaching bcrypt or the DB, and says when to come back', async () => {
      cache.consumeRateLimit.mockResolvedValue({ totalHits: 61, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 60 })
      const { ctx, res } = makeContext(basic('alice', 'anything'))
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
      expect(usersQueries.from).not.toHaveBeenCalled()
      expect(usersManager.validateAppPassword).not.toHaveBeenCalled()
      // ThrottlerGuard sets Retry-After before throwing this exception; a
      // guard that throws it directly has to do so itself. On the DAV surface
      // it is the one part of a 429 a stock NC client can act on.
      expect(res.headers['Retry-After']).toBe('60')
    })

    it('falls back to the configured block when the remaining time rounds to zero', async () => {
      cache.consumeRateLimit.mockResolvedValue({ totalHits: 61, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 0 })
      const { ctx, res } = makeContext(basic('alice', 'anything'))
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
      // `Retry-After: 0` reads as "retry immediately", which is the opposite
      // of what a block means.
      expect(res.headers['Retry-After']).toBe(String(NC_RATE_LIMIT_OPTIONS.BASIC_AUTH.blockDuration / 1000))
    })

    it('never reads X-Forwarded-For itself — the bucket is whatever Fastify resolved', async () => {
      // The guard reads X-Forwarded-For to LOG a useful address. Reading it
      // HERE would hand every attacker an unlimited supply of fresh budgets,
      // one per header value, whatever the deployment looks like.
      //
      // What this does NOT prove: `req.ip` is itself derived from the
      // forwarded chain when `server.trustProxy` is truthy (its default), so
      // a deployment with no reverse proxy in front remains re-bucketable —
      // the same deployment contract upstream's own per-IP limiters carry.
      const { ctx } = makeContext(basic('alice', 'good-app-password'))
      const spoofed = makeContext(basic('bob', 'good-app-password'))
      spoofed.req.headers['x-forwarded-for'] = '203.0.113.9'
      await guard.canActivate(ctx)
      await guard.canActivate(spoofed.ctx)
      const [[keyA], [keyB]] = cache.consumeRateLimit.mock.calls
      expect(keyA).toBe(keyB)
    })

    it('spends nothing when the credentials hit the positive cache', async () => {
      // Every NC request is authenticated and the client floods PROPFINDs
      // during sync; metering the cached path would throttle honest clients
      // long before it inconvenienced an attacker.
      cache.get.mockResolvedValue({ id: 7, login: 'alice' })
      const { ctx } = makeContext(basic('alice', 'good-app-password'))
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
      expect(cache.consumeRateLimit).not.toHaveBeenCalled()
    })

    it('spends nothing when the credentials hit the negative cache', async () => {
      cache.get.mockResolvedValue(null)
      const { ctx } = makeContext(basic('alice', 'wrong'))
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException)
      expect(cache.consumeRateLimit).not.toHaveBeenCalled()
    })
  })
})

describe('parseBasicAuth', () => {
  it('returns null when header is missing', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
  })

  it('returns null for a non-Basic scheme', () => {
    expect(parseBasicAuth('Bearer abc')).toBeNull()
    expect(parseBasicAuth('Digest realm="x"')).toBeNull()
  })

  it('returns null when the payload is not valid base64 with a colon', () => {
    // base64 of "nouser-no-separator"
    const noColon = Buffer.from('nouser-no-separator').toString('base64')
    expect(parseBasicAuth(`Basic ${noColon}`)).toBeNull()
  })

  it('returns null when the login part is empty (":pw")', () => {
    const emptyLogin = Buffer.from(':pw').toString('base64')
    expect(parseBasicAuth(`Basic ${emptyLogin}`)).toBeNull()
  })

  it('parses the canonical example "Basic dXNlcjpzZWNyZXQ="', () => {
    // "user:secret" → dXNlcjpzZWNyZXQ=
    expect(parseBasicAuth('Basic dXNlcjpzZWNyZXQ=')).toEqual({ login: 'user', password: 'secret' })
  })

  it('keeps colons that appear in the password', () => {
    const encoded = Buffer.from('alice:pa:ss:word').toString('base64')
    expect(parseBasicAuth(`Basic ${encoded}`)).toEqual({ login: 'alice', password: 'pa:ss:word' })
  })

  it('is case-insensitive on the scheme keyword', () => {
    expect(parseBasicAuth('basic dXNlcjpzZWNyZXQ=')).toEqual({ login: 'user', password: 'secret' })
  })

  it('handles array-valued headers by taking the first entry', () => {
    expect(parseBasicAuth(['Basic dXNlcjpzZWNyZXQ=', 'junk'])).toEqual({ login: 'user', password: 'secret' })
  })
})
