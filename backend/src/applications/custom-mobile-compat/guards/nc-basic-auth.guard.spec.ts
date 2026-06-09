import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'
import { Cache } from '../../../infrastructure/cache/cache.service'
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
  let usersManager: { validateAppPassword: Mock }
  let cache: { get: Mock; set: Mock }
  let logger: { warn: Mock; error: Mock; info: Mock }
  let module: TestingModule

  beforeEach(async () => {
    usersQueries = { from: vi.fn() }
    usersManager = { validateAppPassword: vi.fn() }
    cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(true) }
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
