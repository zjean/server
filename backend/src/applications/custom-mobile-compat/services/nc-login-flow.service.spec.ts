import { NcLoginFlowService } from './nc-login-flow.service'

describe(NcLoginFlowService.name, () => {
  let svc: NcLoginFlowService

  beforeEach(() => {
    svc = new NcLoginFlowService()
  })

  afterEach(() => {
    jest.useRealTimers()
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

  it('completeWithCredentials requires a pending state', () => {
    const flow = svc.initiate()
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(true)
    // second call should fail — flow is now 'ready', not 'pending'
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(false)
  })

  it('completeWithCredentials returns false for unknown loginToken', () => {
    expect(svc.completeWithCredentials('nope', { server: 's', loginName: 'l', appPassword: 'p' })).toBe(false)
  })

  it('consumeByPollToken returns credentials exactly once then null', () => {
    const flow = svc.initiate()
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    expect(svc.consumeByPollToken(flow.pollToken)).toBeNull() // still pending
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
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-04-23T12:00:00Z'))
    const flow = svc.initiate()
    // advance past the 20-minute TTL (21 minutes).
    jest.setSystemTime(new Date('2026-04-23T12:21:00Z'))
    expect(svc.findByLoginToken(flow.loginToken)).toBeNull()
  })

  it('evicts expired flows automatically (consumeByPollToken)', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-04-23T12:00:00Z'))
    const flow = svc.initiate()
    svc.completeWithCredentials(flow.loginToken, { server: 's', loginName: 'l', appPassword: 'p' })
    jest.setSystemTime(new Date('2026-04-23T12:21:00Z'))
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

  it('completeWithCredentials accepts oidc-pending flows', () => {
    const flow = svc.initiate()
    svc.markOidcPending(flow.loginToken, { codeVerifier: 'cv', nonce: 'n' })
    const creds = { server: 'https://x', loginName: 'u', appPassword: 'p' }
    expect(svc.completeWithCredentials(flow.loginToken, creds)).toBe(true)
    expect(svc.consumeByPollToken(flow.pollToken)).toEqual(creds)
  })
})
