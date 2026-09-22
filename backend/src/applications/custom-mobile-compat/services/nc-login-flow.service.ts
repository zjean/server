import { Injectable } from '@nestjs/common'
import * as crypto from 'node:crypto'
import { Cache } from '../../../infrastructure/cache/cache.service'

// Store for in-flight NC login-v2 flows.
//
// A flow lives for up to 20 minutes (Nextcloud's published token lifetime).
// Each flow goes through these states:
//   PENDING       → the browser tab hasn't completed yet; poll returns 404.
//   OIDC-PENDING  → browser was redirected to the IdP; awaiting callback.
//   READY         → browser completed auth, app-password minted; next poll
//                   returns credentials once and the flow is consumed.
//   DONE          → consumed; further polls return 404 forever.
//
// STATE LIVES IN `Cache`, NOT IN THIS PROCESS (#482).
//
// It used to be a process-local `Map`, which made the whole feature
// single-replica-only: a login flow is driven by two different HTTP clients —
// the mobile app (POST /login/v2, then the poll loop) and the user's browser
// (the flow page, then the grant POST) — over four or more separate requests.
// Behind any load balancer those land on different replicas, so the browser
// completed a flow that the replica serving the poll had never heard of,
// `consumeByPollToken` returned null forever, and sign-in hung with nothing
// logged anywhere. `Cache` is Redis-backed whenever Redis is configured, so
// every replica now reads and writes the same flow.
//
// Consequences of the move, all deliberate:
//   - Every method that touches a flow is async. The flow object a caller
//     holds is a SNAPSHOT deserialized from the cache, not a live reference,
//     so mutating it does nothing until it is written back — every mutator
//     here ends in `save()`.
//   - Expiry is the cache's TTL as well as `createdAt`; `MAX_FLOWS` and the
//     hand-rolled `evictOldest()` are gone. That also closes the eviction DoS
//     in #477: 5000 unauthenticated POSTs used to drop the oldest in-flight
//     flow each, so anyone could evict every legitimate sign-in in progress.
//   - "Exactly once" is enforced with `Cache.del`, which reports whether it
//     was the caller that removed the key. A read-modify-write cannot do that
//     across replicas: two concurrent grant POSTs would both see a live grant
//     token and both mint a credential.

export type LoginFlowStatus = 'pending' | 'oidc-pending' | 'authenticated' | 'ready' | 'done'

export interface LoginFlow {
  pollToken: string
  loginToken: string
  status: LoginFlowStatus
  createdAt: number
  // Free-text description of the client that called POST /index.php/login/v2,
  // taken from its User-Agent. Shown on the grant page so the person clicking
  // "Grant access" can see WHAT they are authorising — which is the difference
  // between an informed decision and a silent one.
  clientName: string
  // sha256 of the browser-binding cookie value, set the first time a browser
  // opens the flow page. Every later browser step must present the matching
  // cookie, so a flow cannot be driven half by one browser and half by another.
  browserTokenHash: string | null
  // Minted alongside 'authenticated'. The grant POST must echo it. Unguessable,
  // single-use, and never leaves the authenticated browser's page.
  grantToken: string | null
  // Who proved their identity, pending explicit grant. NOT credentials — no app
  // password exists until the grant POST.
  pendingUser: { id: number; login: string } | null
  // Populated when the OIDC dance is initiated; carries PKCE + nonce across the
  // browser round-trip so the callback can validate the IdP response.
  oidc: { codeVerifier: string; nonce: string } | null
  // Populated when status flips to 'ready'. Cleared on first successful poll.
  credentials: { server: string; loginName: string; appPassword: string } | null
}

const TTL_MS = 20 * 60 * 1000 // 20 min
// Cache keys. No `_` or `%` anywhere in the prefix: MysqlCacheAdapter.keys()
// turns the pattern into a SQL LIKE, where both are wildcards.
const KEY_PREFIX = 'nc-login-flow'

@Injectable()
export class NcLoginFlowService {
  constructor(private readonly cache: Cache) {}

  // Start a new flow. Returns the tokens the client needs.
  async initiate(clientName?: string): Promise<LoginFlow> {
    const flow: LoginFlow = {
      pollToken: this.genToken(),
      loginToken: this.genToken(),
      status: 'pending',
      createdAt: Date.now(),
      clientName: normaliseClientName(clientName),
      browserTokenHash: null,
      grantToken: null,
      pendingUser: null,
      oidc: null,
      credentials: null
    }
    await this.cache.set(indexKey(flow.loginToken), flow.pollToken, ttlSecondsFor(flow))
    await this.save(flow)
    return flow
  }

  // Look up a flow by its loginToken (as used by the browser form).
  async findByLoginToken(loginToken: string): Promise<LoginFlow | null> {
    const pollToken: unknown = await this.cache.get(indexKey(loginToken))
    if (typeof pollToken !== 'string' || !pollToken) return null
    return this.findByPollToken(pollToken)
  }

  // Called when the browser tab is about to be redirected to the IdP. Stores
  // PKCE + nonce so the callback can validate the IdP's response. Returns
  // false if the flow is missing or already past the pending stage.
  async markOidcPending(loginToken: string, params: { codeVerifier: string; nonce: string }): Promise<boolean> {
    const flow = await this.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') return false
    flow.oidc = { codeVerifier: params.codeVerifier, nonce: params.nonce }
    flow.status = 'oidc-pending'
    await this.save(flow)
    return true
  }

  // Bind the flow to the browser that is driving it.
  //
  // Called on the first GET of the flow page. Returns the token to put in the
  // cookie, or null if the flow is already bound to a DIFFERENT browser — in
  // which case the caller must refuse, because two browsers racing one flow is
  // either a mistake or an attack.
  async bindBrowser(loginToken: string, presentedToken: string | undefined): Promise<string | null> {
    const flow = await this.findByLoginToken(loginToken)
    if (!flow) return null
    if (!flow.browserTokenHash) {
      const token = this.genToken()
      flow.browserTokenHash = hashToken(token)
      await this.save(flow)
      return token
    }
    return presentedToken && this.isBoundTo(flow, presentedToken) ? presentedToken : null
  }

  // Does this cookie value match the browser this flow was bound to?
  // Pure: operates on a snapshot the caller already holds.
  isBoundTo(flow: LoginFlow, presentedToken: string | undefined): boolean {
    if (!flow.browserTokenHash || !presentedToken) return false
    return timingSafeEqualHex(flow.browserTokenHash, hashToken(presentedToken))
  }

  // The identity is proven; the authorisation is NOT yet given.
  //
  // This is the step that used to mint an app password directly. Splitting it
  // in two is the point: authentication happens when the user proves who they
  // are, authorisation happens when they say yes to THIS client. An
  // attacker-initiated flow can now reach 'authenticated' on the victim's
  // browser — because the victim really did authenticate — and still yield
  // nothing, because the victim never presses Grant.
  //
  // Returns the single-use grant token to embed in the page, or null if the
  // flow is missing, in the wrong state, or driven by a different browser.
  async markAuthenticated(loginToken: string, user: { id: number; login: string }, presentedToken: string | undefined): Promise<string | null> {
    const flow = await this.findByLoginToken(loginToken)
    if (!flow) return null
    if (flow.status !== 'pending' && flow.status !== 'oidc-pending') return null
    if (!this.isBoundTo(flow, presentedToken)) return null
    flow.pendingUser = { id: user.id, login: user.login }
    flow.grantToken = this.genToken()
    flow.status = 'authenticated'
    await this.save(flow)
    // The single-use marker for the grant, kept in its own key so consuming it
    // is one atomic `del` rather than a read-modify-write two replicas can both
    // win. Its value is irrelevant; its existence is the permission.
    await this.cache.set(grantKey(flow.pollToken), 1, ttlSecondsFor(flow))
    return flow.grantToken
  }

  // Consume the grant. Returns the user the grant is for, or null if anything
  // about the request fails to line up. Single-use: the marker key is deleted
  // whether or not the caller goes on to mint successfully, so a replayed POST
  // cannot mint a second credential.
  async consumeGrant(
    loginToken: string,
    grantToken: string | undefined,
    presentedToken: string | undefined
  ): Promise<{ id: number; login: string } | null> {
    const flow = await this.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'authenticated' || !flow.grantToken || !flow.pendingUser) return null
    if (!this.isBoundTo(flow, presentedToken)) return null
    if (!grantToken || !timingSafeEqualHex(hashToken(flow.grantToken), hashToken(grantToken))) return null
    // Whoever deletes the marker owns the grant. A loser of the race gets
    // `false` and is refused, so concurrent POSTs mint at most one credential.
    if (!(await this.cache.del(grantKey(flow.pollToken)))) return null
    const user = flow.pendingUser
    flow.grantToken = null
    await this.save(flow)
    return user
  }

  // Called after a granted mint; stores the credentials so the next poll
  // returns them. Only reachable from the 'authenticated' state — the two
  // pre-grant states are deliberately no longer accepted.
  async completeWithCredentials(loginToken: string, creds: { server: string; loginName: string; appPassword: string }): Promise<boolean> {
    const flow = await this.findByLoginToken(loginToken)
    if (!flow) return false
    if (flow.status !== 'authenticated') return false
    flow.credentials = creds
    flow.pendingUser = null
    flow.status = 'ready'
    await this.save(flow)
    return true
  }

  // Called by POST /login/v2/poll. Returns the credentials exactly once.
  // Returns null on all subsequent calls and while still pending.
  async consumeByPollToken(pollToken: string): Promise<LoginFlow['credentials'] | null> {
    const flow = await this.findByPollToken(pollToken)
    if (!flow) return null
    if (flow.status !== 'ready' || !flow.credentials) return null
    // Same atomic-delete gate as the grant: the replica that removes the flow
    // is the one that gets to hand over the credentials. Dropping the entry
    // outright (rather than parking it in 'done') is what the caller already
    // observes — every later poll rendered 404 either way.
    if (!(await this.cache.del(flowKey(pollToken)))) return null
    await this.cache.del(indexKey(flow.loginToken))
    return flow.credentials
  }

  // Test hook: purge state. Called between tests to avoid bleed.
  async clearForTests(): Promise<void> {
    const keys = await this.cache.keys(`${KEY_PREFIX}-*`)
    if (keys.length) await this.cache.mdel(keys)
  }

  private async findByPollToken(pollToken: string): Promise<LoginFlow | null> {
    const flow: LoginFlow | undefined = await this.cache.get(flowKey(pollToken))
    if (!flow) return null
    // Belt and braces: the cache TTL already expires the entry, but an adapter
    // that rounds a TTL up must not resurrect a flow past its published
    // 20-minute lifetime.
    if (Date.now() - flow.createdAt > TTL_MS) {
      await this.drop(flow)
      return null
    }
    return flow
  }

  private async save(flow: LoginFlow): Promise<void> {
    await this.cache.set(flowKey(flow.pollToken), flow, ttlSecondsFor(flow))
  }

  private async drop(flow: LoginFlow): Promise<void> {
    await this.cache.mdel([flowKey(flow.pollToken), indexKey(flow.loginToken), grantKey(flow.pollToken)])
  }

  private genToken(): string {
    // 32 random bytes, base64url — 43 chars, URL-safe, no padding.
    return crypto.randomBytes(32).toString('base64url')
  }
}

function flowKey(pollToken: string): string {
  return `${KEY_PREFIX}-poll-${pollToken}`
}

function indexKey(loginToken: string): string {
  return `${KEY_PREFIX}-login-${loginToken}`
}

function grantKey(pollToken: string): string {
  return `${KEY_PREFIX}-grant-${pollToken}`
}

// Seconds left of the flow's 20-minute life, so a re-`set` never extends it.
// Never 0 — `Cache.set(key, value, 0)` means "never expire".
function ttlSecondsFor(flow: LoginFlow): number {
  const remainingMs = TTL_MS - (Date.now() - flow.createdAt)
  return Math.max(1, Math.ceil(remainingMs / 1000))
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// Both operands are sha256 hex of the same fixed length, so length never
// differs in practice — but timingSafeEqual throws on a mismatch, so guard it.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// The User-Agent is attacker-controlled and gets rendered on the grant page.
// It is escaped at render time, but bound the length here too so a pathological
// header cannot dominate the page the user is meant to read.
function normaliseClientName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'an unidentified application'
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
}
