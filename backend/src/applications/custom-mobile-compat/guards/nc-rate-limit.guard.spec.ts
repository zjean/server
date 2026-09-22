import { Controller, ExecutionContext, Post } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test, TestingModule } from '@nestjs/testing'
import { ThrottlerException } from '@nestjs/throttler'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NC_RATE_LIMIT_OPTIONS, NC_RATE_LIMIT_SCOPE } from '../constants/rate-limit'
import { createInMemoryCache, type InMemoryCache } from '../utils/nc-cache.fixture'
import { NcRateLimit, NcRateLimitGuard } from './nc-rate-limit.guard'

// Two real controllers, so the guard reads metadata the way Nest puts it there
// (a hand-built `getHandler()` stub would prove the decorator and the guard
// agree about a shape neither of them actually sees at runtime).
@Controller()
class MeteredController {
  @Post()
  @NcRateLimit({ limit: 3, ttl: 60_000, blockDuration: 60_000 })
  metered(): string {
    return 'ok'
  }

  @Post()
  @NcRateLimit({ limit: 3, ttl: 60_000, blockDuration: 60_000 })
  otherMetered(): string {
    return 'ok'
  }

  @Post()
  unmetered(): string {
    return 'ok'
  }
}

describe(NcRateLimitGuard.name, () => {
  let moduleRef: TestingModule
  let guard: NcRateLimitGuard
  let cache: InMemoryCache

  function contextFor(handler: keyof MeteredController, req: Record<string, unknown>): ExecutionContext {
    return {
      getHandler: () => MeteredController.prototype[handler],
      getClass: () => MeteredController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) })
    } as unknown as ExecutionContext
  }

  beforeEach(async () => {
    cache = createInMemoryCache()
    moduleRef = await Test.createTestingModule({
      providers: [NcRateLimitGuard, Reflector, { provide: Cache, useValue: cache }]
    }).compile()
    guard = moduleRef.get(NcRateLimitGuard)
  })

  afterEach(async () => {
    await moduleRef.close()
  })

  it('lets a handler with no @NcRateLimit through without touching the cache', async () => {
    const spy = vi.spyOn(cache, 'consumeRateLimit')
    await expect(guard.canActivate(contextFor('unmetered', { ip: '10.0.0.1' }))).resolves.toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('allows requests up to the limit and blocks the ones past it', async () => {
    const ctx = contextFor('metered', { ip: '10.0.0.1' })
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(ctx)).resolves.toBe(true)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
  })

  it('counts per IP, so one abuser cannot lock everybody else out', async () => {
    const attacker = contextFor('metered', { ip: '10.0.0.1' })
    for (let i = 0; i < 4; i++) await guard.canActivate(attacker).catch(() => undefined)
    await expect(guard.canActivate(attacker)).rejects.toBeInstanceOf(ThrottlerException)
    await expect(guard.canActivate(contextFor('metered', { ip: '10.0.0.2' }))).resolves.toBe(true)
  })

  it('counts per handler, so one route cannot spend another route’s budget', async () => {
    const metered = contextFor('metered', { ip: '10.0.0.1' })
    for (let i = 0; i < 4; i++) await guard.canActivate(metered).catch(() => undefined)
    await expect(guard.canActivate(metered)).rejects.toBeInstanceOf(ThrottlerException)
    await expect(guard.canActivate(contextFor('otherMetered', { ip: '10.0.0.1' }))).resolves.toBe(true)
  })

  it('never reads X-Forwarded-For itself — the bucket is whatever Fastify resolved', async () => {
    // The module reads this header elsewhere to LOG a useful client address.
    // Reading it HERE would mean an attacker rotating the value gets an
    // unlimited number of fresh budgets regardless of how the server is
    // deployed.
    //
    // Note what this does NOT prove: `req.ip` is itself derived from the
    // forwarded chain when `server.trustProxy` is truthy (its default), so a
    // deployment with no reverse proxy in front is still re-bucketable. That
    // is a deployment contract, identical to upstream's own per-IP limiters —
    // see the comment in the guard.
    const spoofed = (n: number) => contextFor('metered', { ip: '10.0.0.1', headers: { 'x-forwarded-for': `203.0.113.${n}` } })
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(spoofed(i))).resolves.toBe(true)
    await expect(guard.canActivate(spoofed(99))).rejects.toBeInstanceOf(ThrottlerException)
  })

  it('shares its counter across replicas', async () => {
    // Two guards, one cache, as two pods behind a load balancer would be.
    const replicaB = new NcRateLimitGuard(cache, new Reflector())
    const ctx = contextFor('metered', { ip: '10.0.0.1' })
    await guard.canActivate(ctx)
    await replicaB.canActivate(ctx)
    await guard.canActivate(ctx)
    await expect(replicaB.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
  })

  it('lets the caller back in once the block expires', async () => {
    const ctx = contextFor('metered', { ip: '10.0.0.1' })
    for (let i = 0; i < 4; i++) await guard.canActivate(ctx).catch(() => undefined)
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException)
    cache.advance(61_000)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('scopes the bucket per run under test, so parallel e2e workers do not share a counter', async () => {
    // Deliberately NOT a skip: the limiter must run where we assert. What the
    // scope removes is the SHARING — the e2e suite runs spec files in
    // parallel worker threads against one cache, and two agents can run the
    // suite at once.
    expect(NC_RATE_LIMIT_SCOPE).toMatch(/^-run[0-9a-f]{12}$/)
    const spy = vi.spyOn(cache, 'consumeRateLimit')
    await guard.canActivate(contextFor('metered', { ip: '10.0.0.1' }))
    expect(spy.mock.calls[0][0]).toContain(NC_RATE_LIMIT_SCOPE)
  })

  it('meters the credential-posting route as tightly as upstream meters /auth/login', async () => {
    // Not a style preference: nc-login-v2's submitLoginPage validates exactly
    // the credentials AuthRateLimitGuard protects on /auth/login. A looser
    // budget here would just be the cheaper door onto the same password store.
    expect(NC_RATE_LIMIT_OPTIONS.LOGIN_FLOW_SUBMIT.limit).toBe(6)
    expect(NC_RATE_LIMIT_OPTIONS.LOGIN_FLOW_SUBMIT.ttl).toBe(60_000)
  })
})
