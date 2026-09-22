import { createInMemoryCache, type InMemoryCache } from '../utils/nc-cache.fixture'
import { NcLoginFlowService } from './nc-login-flow.service'

// The store is the cache (#482), so every case here drives the service through
// a real in-memory Cache double rather than a mock. The point of the double is
// that it actually stores: a service that kept its state in a process-local
// Map would still pass a `vi.fn()` mock, which is how the single-replica bug
// survived the original suite.
describe(NcLoginFlowService.name, () => {
  let svc: NcLoginFlowService
  let cache: InMemoryCache

  beforeEach(() => {
    cache = createInMemoryCache()
    svc = new NcLoginFlowService(cache)
  })

  it('initiate returns unique poll + login tokens', async () => {
    const a = await svc.initiate()
    const b = await svc.initiate()
    expect(a.pollToken).toEqual(expect.any(String))
    expect(a.loginToken).toEqual(expect.any(String))
    expect(a.pollToken).not.toEqual(a.loginToken)
    expect(a.pollToken).not.toEqual(b.pollToken)
    expect(a.loginToken).not.toEqual(b.loginToken)
    expect(a.status).toBe('pending')
    expect(a.credentials).toBeNull()
  })

  it('findByLoginToken returns null for an unknown token', async () => {
    await expect(svc.findByLoginToken('does-not-exist')).resolves.toBeNull()
  })

  it('findByLoginToken returns the flow for a known token', async () => {
    const flow = await svc.initiate()
    await expect(svc.findByLoginToken(flow.loginToken)).resolves.toEqual(flow)
  })

  // Drive a flow to 'authenticated' the way the controllers do.
  async function authenticated(svcRef: NcLoginFlowService) {
    const flow = await svcRef.initiate('Nextcloud-iOS/33.1')
    const browserToken = (await svcRef.bindBrowser(flow.loginToken, undefined)) as string
    const grantToken = (await svcRef.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, browserToken)) as string
    return { flow, browserToken, grantToken }
  }

  // #482 — the whole reason this store moved off a process-local Map.
  //
  // A login flow is driven by two HTTP clients over four+ requests: the mobile
  // app initiates and polls, the browser authenticates and grants. Behind a
  // load balancer those land on different replicas. Two services sharing one
  // cache IS that deployment, so a regression to per-process state fails here
  // and nowhere else.
  describe('replica safety', () => {
    it('a flow completed on one replica is polled successfully from another', async () => {
      const replicaA = new NcLoginFlowService(cache)
      const replicaB = new NcLoginFlowService(cache)
      const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }

      // The app calls POST /login/v2 — replica A answers.
      const flow = await replicaA.initiate('Nextcloud-Android/3.29')
      // The browser opens the flow page and authenticates — replica B answers.
      const browserToken = (await replicaB.bindBrowser(flow.loginToken, undefined)) as string
      const grantToken = (await replicaB.markAuthenticated(flow.loginToken, { id: 7, login: 'u' }, browserToken)) as string
      await expect(replicaB.consumeGrant(flow.loginToken, grantToken, browserToken)).resolves.toEqual({ id: 7, login: 'u' })
      await expect(replicaB.completeWithCredentials(flow.loginToken, creds)).resolves.toBe(true)

      // The app's poll lands back on replica A, which never saw any of that.
      await expect(replicaA.consumeByPollToken(flow.pollToken)).resolves.toEqual(creds)
    })

    it('the browser binding survives the hop to another replica', async () => {
      const replicaA = new NcLoginFlowService(cache)
      const replicaB = new NcLoginFlowService(cache)
      const flow = await replicaA.initiate()
      const browserToken = (await replicaA.bindBrowser(flow.loginToken, undefined)) as string
      // Same browser, different replica: accepted.
      await expect(replicaB.bindBrowser(flow.loginToken, browserToken)).resolves.toBe(browserToken)
      // Different browser, different replica: still refused.
      await expect(replicaB.bindBrowser(flow.loginToken, 'someone-elses-cookie')).resolves.toBeNull()
    })

    it('two replicas racing the same grant mint at most one credential', async () => {
      const replicaA = new NcLoginFlowService(cache)
      const replicaB = new NcLoginFlowService(cache)
      const { flow, browserToken, grantToken } = await authenticated(svc)
      const [first, second] = await Promise.all([
        replicaA.consumeGrant(flow.loginToken, grantToken, browserToken),
        replicaB.consumeGrant(flow.loginToken, grantToken, browserToken)
      ])
      expect([first, second].filter(Boolean)).toHaveLength(1)
    })

    it('two replicas racing the same poll hand over the credentials once', async () => {
      const replicaA = new NcLoginFlowService(cache)
      const replicaB = new NcLoginFlowService(cache)
      const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
      const { flow, browserToken, grantToken } = await authenticated(svc)
      await svc.consumeGrant(flow.loginToken, grantToken, browserToken)
      await svc.completeWithCredentials(flow.loginToken, creds)
      const [first, second] = await Promise.all([replicaA.consumeByPollToken(flow.pollToken), replicaB.consumeByPollToken(flow.pollToken)])
      expect([first, second].filter(Boolean)).toEqual([creds])
    })
  })

  it('completeWithCredentials requires an AUTHENTICATED state, not merely a live flow', async () => {
    const flow = await svc.initiate()
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    // A freshly-initiated flow must not be completable: that was the hole —
    // credentials could be attached before anyone had authorised anything.
    await expect(svc.completeWithCredentials(flow.loginToken, creds)).resolves.toBe(false)

    const a = await authenticated(svc)
    await expect(svc.completeWithCredentials(a.flow.loginToken, creds)).resolves.toBe(true)
    // second call should fail — flow is now 'ready', not 'authenticated'
    await expect(svc.completeWithCredentials(a.flow.loginToken, creds)).resolves.toBe(false)
  })

  it('completeWithCredentials returns false for unknown loginToken', async () => {
    await expect(svc.completeWithCredentials('nope', { server: 's', loginName: 'l', appPassword: 'p' })).resolves.toBe(false)
  })

  it('consumeByPollToken returns credentials exactly once then null', async () => {
    const { flow } = await authenticated(svc)
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull() // authenticated, not granted
    await svc.completeWithCredentials(flow.loginToken, creds)
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toEqual(creds)
    // subsequent polls return null
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull()
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull()
  })

  it('consumeByPollToken returns null for an unknown poll token', async () => {
    await expect(svc.consumeByPollToken('missing')).resolves.toBeNull()
  })

  it('evicts expired flows automatically (findByLoginToken)', async () => {
    const flow = await svc.initiate()
    cache.advance(21 * 60 * 1000) // past the 20-minute TTL
    await expect(svc.findByLoginToken(flow.loginToken)).resolves.toBeNull()
  })

  it('evicts expired flows automatically (consumeByPollToken)', async () => {
    const { flow, browserToken, grantToken } = await authenticated(svc)
    await svc.consumeGrant(flow.loginToken, grantToken, browserToken)
    await svc.completeWithCredentials(flow.loginToken, { server: 's', loginName: 'l', appPassword: 'p' })
    cache.advance(21 * 60 * 1000)
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull()
  })

  it('a re-saved flow does not have its 20-minute life extended', async () => {
    // Every mutator writes the flow back, so a TTL computed as "20 minutes from
    // now" would let a flow that keeps being touched live forever.
    const flow = await svc.initiate()
    cache.advance(19 * 60 * 1000)
    await svc.bindBrowser(flow.loginToken, undefined)
    cache.advance(2 * 60 * 1000) // 21 minutes since initiate()
    await expect(svc.findByLoginToken(flow.loginToken)).resolves.toBeNull()
  })

  it('expired flows leave nothing behind in the cache', async () => {
    // The old Map had a hand-rolled MAX_FLOWS + evictOldest, which #477 called
    // out as a DoS: 5000 unauthenticated POSTs dropped every in-flight flow.
    // Bounding is the cache's TTL now, so the store must actually drain.
    for (let i = 0; i < 50; i++) await svc.initiate()
    expect(cache.size()).toBeGreaterThan(0)
    cache.advance(21 * 60 * 1000)
    expect(cache.size()).toBe(0)
  })

  it('clearForTests purges all state', async () => {
    const flow = await svc.initiate()
    await svc.clearForTests()
    await expect(svc.findByLoginToken(flow.loginToken)).resolves.toBeNull()
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull()
  })

  it('initiate sets oidc to null', async () => {
    const flow = await svc.initiate()
    expect(flow.oidc).toBeNull()
  })

  it('markOidcPending stores codeVerifier+nonce and flips status', async () => {
    const flow = await svc.initiate()
    await expect(svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })).resolves.toBe(true)
    const seen = await svc.findByLoginToken(flow.loginToken)
    expect(seen?.status).toBe('oidc-pending')
    expect(seen?.oidc).toEqual({ codeVerifier: 'cv', nonce: 'n' })
  })

  it('markOidcPending refuses non-pending flows', async () => {
    const flow = await svc.initiate()
    await svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
    // already 'oidc-pending' — second call must fail
    await expect(svc.markOidcPending(flow.loginToken, { codeVerifier: 'x', nonce: 'y' })).resolves.toBe(false)
  })

  it('markOidcPending returns false for unknown loginToken', async () => {
    await expect(svc.markOidcPending('nope', { codeVerifier: 'cv', nonce: 'n' })).resolves.toBe(false)
  })

  it('completeWithCredentials REFUSES an oidc-pending flow — the IdP proving identity is not a grant', async () => {
    const flow = await svc.initiate()
    const browserToken = (await svc.bindBrowser(flow.loginToken, undefined)) as string
    await svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    await expect(svc.completeWithCredentials(flow.loginToken, creds)).resolves.toBe(false)
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toBeNull()

    // It becomes completable only after the user is marked authenticated and
    // the grant is consumed.
    const grantToken = (await svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, browserToken)) as string
    await expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).resolves.toEqual({ id: 1, login: 'u' })
    await expect(svc.completeWithCredentials(flow.loginToken, creds)).resolves.toBe(true)
    await expect(svc.consumeByPollToken(flow.pollToken)).resolves.toEqual(creds)
  })

  describe('browser binding', () => {
    it('binds on first sight and accepts the same browser afterwards', async () => {
      const flow = await svc.initiate()
      const token = (await svc.bindBrowser(flow.loginToken, undefined)) as string
      expect(token).toEqual(expect.any(String))
      await expect(svc.bindBrowser(flow.loginToken, token)).resolves.toBe(token)
    })

    it('refuses a second browser', async () => {
      const flow = await svc.initiate()
      await svc.bindBrowser(flow.loginToken, undefined)
      await expect(svc.bindBrowser(flow.loginToken, undefined)).resolves.toBeNull()
      await expect(svc.bindBrowser(flow.loginToken, 'someone-elses-cookie')).resolves.toBeNull()
    })

    it('markAuthenticated and consumeGrant both require the bound browser', async () => {
      const flow = await svc.initiate()
      const token = (await svc.bindBrowser(flow.loginToken, undefined)) as string
      await expect(svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, 'wrong')).resolves.toBeNull()
      const grantToken = (await svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, token)) as string
      await expect(svc.consumeGrant(flow.loginToken, grantToken, 'wrong')).resolves.toBeNull()
      await expect(svc.consumeGrant(flow.loginToken, grantToken, token)).resolves.toEqual({ id: 1, login: 'u' })
    })

    it('a grant is single-use', async () => {
      const { flow, browserToken, grantToken } = await authenticated(svc)
      await expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).resolves.not.toBeNull()
      await expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).resolves.toBeNull()
    })

    it('records the initiating client name for the grant page', async () => {
      expect((await svc.initiate('Nextcloud-Android/3.29')).clientName).toBe('Nextcloud-Android/3.29')
      expect((await svc.initiate(undefined)).clientName).toBe('an unidentified application')
      expect((await svc.initiate('x'.repeat(500))).clientName.length).toBeLessThanOrEqual(120)
    })
  })
})
