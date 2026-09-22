import { NcLoginFlowService } from './nc-login-flow.service'

describe(NcLoginFlowService.name, () => {
  let svc: NcLoginFlowService

  beforeEach(() => {
    svc = new NcLoginFlowService()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initiate returns unique poll + login tokens', () => {
    const a = svc.initiate()
    const b = svc.initiate()
    expect(a.pollToken).toEqual(expect.any(String))
    expect(a.loginToken).toEqual(expect.any(String))
    expect(a.pollToken).not.toEqual(a.loginToken)
    expect(a.pollToken).not.toEqual(b.pollToken)
    expect(a.loginToken).not.toEqual(b.loginToken)
    expect(a.status).toBe('pending')
    expect(a.credentials).toBeNull()
  })

  it('findByLoginToken returns null for an unknown token', () => {
    expect(svc.findByLoginToken('does-not-exist')).toBeNull()
  })

  it('findByLoginToken returns the flow for a known token', () => {
    const flow = svc.initiate()
    expect(svc.findByLoginToken(flow.loginToken)).toBe(flow)
  })

  // Drive a flow to 'authenticated' the way the controllers do.
  function authenticated(svcRef: NcLoginFlowService) {
    const flow = svcRef.initiate('Nextcloud-iOS/33.1')
    const browserToken = svcRef.bindBrowser(flow.loginToken, undefined) as string
    const grantToken = svcRef.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, browserToken) as string
    return { flow, browserToken, grantToken }
  }

  it('completeWithCredentials requires an AUTHENTICATED state, not merely a live flow', () => {
    const flow = svc.initiate()
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    // A freshly-initiated flow must not be completable: that was the hole —
    // credentials could be attached before anyone had authorised anything.
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(false)

    const a = authenticated(svc)
    expect(svc.completeWithCredentials(a.flow.loginToken, creds)).toBe(true)
    // second call should fail — flow is now 'ready', not 'authenticated'
    expect(svc.completeWithCredentials(a.flow.loginToken, creds)).toBe(false)
  })

  it('completeWithCredentials returns false for unknown loginToken', () => {
    expect(svc.completeWithCredentials('nope', { server: 's', loginName: 'l', appPassword: 'p' })).toBe(false)
  })

  it('consumeByPollToken returns credentials exactly once then null', () => {
    const { flow } = authenticated(svc)
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull() // authenticated, not granted
    svc.completeWithCredentials(flow.loginToken, creds)
    const first = svc.consumeByPollToken(flow.pollToken)
    expect(first).toEqual(creds)
    // subsequent polls return null
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull()
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull()
  })

  it('consumeByPollToken returns null for an unknown poll token', () => {
    expect(svc.consumeByPollToken('missing')).toBeNull()
  })

  it('evicts expired flows automatically (findByLoginToken)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
    const flow = svc.initiate()
    // advance past the 20-minute TTL (21 minutes).
    vi.setSystemTime(new Date('2026-04-23T12:21:00Z'))
    expect(svc.findByLoginToken(flow.loginToken)).toBeNull()
  })

  it('evicts expired flows automatically (consumeByPollToken)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
    const flow = svc.initiate()
    svc.completeWithCredentials(flow.loginToken, { server: 's', loginName: 'l', appPassword: 'p' })
    vi.setSystemTime(new Date('2026-04-23T12:21:00Z'))
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull()
  })

  it('keeps the store bounded when many flows are created', () => {
    // Create a generous number without hard-coding the MAX. We just assert
    // that after the internal cap is hit, the store doesn't grow unboundedly
    // and older entries are dropped in favor of newer ones.
    const createdLoginTokens: string[] = []
    for (let i = 0; i < 6000; i++) {
      createdLoginTokens.push(svc.initiate().loginToken)
    }
    // Earliest tokens should have been evicted.
    expect(svc.findByLoginToken(createdLoginTokens[0])).toBeNull()
    // Most recent token should still be present.
    expect(svc.findByLoginToken(createdLoginTokens[createdLoginTokens.length - 1])).not.toBeNull()
  })

  it('clearForTests purges all state', () => {
    const flow = svc.initiate()
    svc.clearForTests()
    expect(svc.findByLoginToken(flow.loginToken)).toBeNull()
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull()
  })

  it('initiate sets oidc to null', () => {
    const flow = svc.initiate()
    expect(flow.oidc).toBeNull()
  })

  it('markOidcPending stores codeVerifier+nonce and flips status', () => {
    const flow = svc.initiate()
    expect(svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })).toBe(true)
    const seen = svc.findByLoginToken(flow.loginToken)
    expect(seen?.status).toBe('oidc-pending')
    expect(seen?.oidc).toEqual({ codeVerifier: 'cv', nonce: 'n' })
  })

  it('markOidcPending refuses non-pending flows', () => {
    const flow = svc.initiate()
    svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
    // already 'oidc-pending' — second call must fail
    expect(svc.markOidcPending(flow.loginToken, { codeVerifier: 'x', nonce: 'y' })).toBe(false)
  })

  it('markOidcPending returns false for unknown loginToken', () => {
    expect(svc.markOidcPending('nope', { codeVerifier: 'cv', nonce: 'n' })).toBe(false)
  })

  it('completeWithCredentials REFUSES an oidc-pending flow — the IdP proving identity is not a grant', () => {
    const flow = svc.initiate()
    const browserToken = svc.bindBrowser(flow.loginToken, undefined) as string
    svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(false)
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull()

    // It becomes completable only after the user is marked authenticated and
    // the grant is consumed.
    const grantToken = svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, browserToken) as string
    expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).toEqual({ id: 1, login: 'u' })
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(true)
    expect(svc.consumeByPollToken(flow.pollToken)).toEqual(creds)
  })

  describe('browser binding', () => {
    it('binds on first sight and accepts the same browser afterwards', () => {
      const flow = svc.initiate()
      const token = svc.bindBrowser(flow.loginToken, undefined) as string
      expect(token).toEqual(expect.any(String))
      expect(svc.bindBrowser(flow.loginToken, token)).toBe(token)
    })

    it('refuses a second browser', () => {
      const flow = svc.initiate()
      svc.bindBrowser(flow.loginToken, undefined)
      expect(svc.bindBrowser(flow.loginToken, undefined)).toBeNull()
      expect(svc.bindBrowser(flow.loginToken, 'someone-elses-cookie')).toBeNull()
    })

    it('markAuthenticated and consumeGrant both require the bound browser', () => {
      const flow = svc.initiate()
      const token = svc.bindBrowser(flow.loginToken, undefined) as string
      expect(svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, 'wrong')).toBeNull()
      const grantToken = svc.markAuthenticated(flow.loginToken, { id: 1, login: 'u' }, token) as string
      expect(svc.consumeGrant(flow.loginToken, grantToken, 'wrong')).toBeNull()
      expect(svc.consumeGrant(flow.loginToken, grantToken, token)).toEqual({ id: 1, login: 'u' })
    })

    it('a grant is single-use', () => {
      const { flow, browserToken, grantToken } = authenticated(svc)
      expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).not.toBeNull()
      expect(svc.consumeGrant(flow.loginToken, grantToken, browserToken)).toBeNull()
    })

    it('records the initiating client name for the grant page', () => {
      expect(svc.initiate('Nextcloud-Android/3.29').clientName).toBe('Nextcloud-Android/3.29')
      expect(svc.initiate(undefined).clientName).toBe('an unidentified application')
      expect(svc.initiate('x'.repeat(500)).clientName.length).toBeLessThanOrEqual(120)
    })
  })
})
