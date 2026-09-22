import { Injectable } from '@nestjs/common'
import * as crypto from 'node:crypto'

// In-memory LRU-ish store for in-flight NC login-v2 flows.
//
// A flow lives for up to 20 minutes (Nextcloud's published token lifetime).
// Each flow goes through these states:
//   PENDING       → the browser tab hasn't completed yet; poll returns 404.
//   OIDC-PENDING  → browser was redirected to the IdP; awaiting callback.
//   READY         → browser completed auth, app-password minted; next poll
//                   returns credentials once and the flow is consumed.
//   DONE          → consumed; further polls return 404 forever. Eventually
//                   evicted.
//
// Single-process only in this MVP; multi-instance deployments need a shared
// backend (Redis). Flagged as follow-up in the design doc.

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
const MAX_FLOWS = 5000

@Injectable()
export class NcLoginFlowService {
  private readonly flows = new Map<string, LoginFlow>() // keyed by pollToken
  private readonly loginToPollIndex = new Map<string, string>() // loginToken → pollToken

  // Start a new flow. Returns the tokens the client needs.
  initiate(clientName?: string): LoginFlow {
    this.evictExpired()
    const pollToken = this.genToken()
    const loginToken = this.genToken()
    const flow: LoginFlow = {
      pollToken,
      loginToken,
      status: 'pending',
      createdAt: Date.now(),
      clientName: normaliseClientName(clientName),
      browserTokenHash: null,
      grantToken: null,
      pendingUser: null,
      oidc: null,
      credentials: null
    }
    // Enforce upper bound.
    if (this.flows.size >= MAX_FLOWS) this.evictOldest()
    this.flows.set(pollToken, flow)
    this.loginToPollIndex.set(loginToken, pollToken)
    return flow
  }

  // Look up a flow by its loginToken (as used by the browser form).
  findByLoginToken(loginToken: string): LoginFlow | null {
    const pollToken = this.loginToPollIndex.get(loginToken)
    if (!pollToken) return null
    const flow = this.flows.get(pollToken)
    if (!flow) return null
    if (this.isExpired(flow)) {
      this.drop(flow)
      return null
    }
    return flow
  }

  // Called when the browser tab is about to be redirected to the IdP. Stores
  // PKCE + nonce so the callback can validate the IdP's response. Returns
  // false if the flow is missing or already past the pending stage.
  markOidcPending(loginToken: string, params: { codeVerifier: string; nonce: string }): boolean {
    const flow = this.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') return false
    flow.oidc = { codeVerifier: params.codeVerifier, nonce: params.nonce }
    flow.status = 'oidc-pending'
    return true
  }

  // Bind the flow to the browser that is driving it.
  //
  // Called on the first GET of the flow page. Returns the token to put in the
  // cookie, or null if the flow is already bound to a DIFFERENT browser — in
  // which case the caller must refuse, because two browsers racing one flow is
  // either a mistake or an attack.
  bindBrowser(loginToken: string, presentedToken: string | undefined): string | null {
    const flow = this.findByLoginToken(loginToken)
    if (!flow) return null
    if (!flow.browserTokenHash) {
      const token = this.genToken()
      flow.browserTokenHash = hashToken(token)
      return token
    }
    return presentedToken && this.isBoundTo(flow, presentedToken) ? presentedToken : null
  }

  // Does this cookie value match the browser this flow was bound to?
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
  markAuthenticated(loginToken: string, user: { id: number; login: string }, presentedToken: string | undefined): string | null {
    const flow = this.findByLoginToken(loginToken)
    if (!flow) return null
    if (flow.status !== 'pending' && flow.status !== 'oidc-pending') return null
    if (!this.isBoundTo(flow, presentedToken)) return null
    flow.pendingUser = { id: user.id, login: user.login }
    flow.grantToken = this.genToken()
    flow.status = 'authenticated'
    return flow.grantToken
  }

  // Consume the grant. Returns the user the grant is for, or null if anything
  // about the request fails to line up. Single-use: the grant token is cleared
  // whether or not the caller goes on to mint successfully, so a replayed POST
  // cannot mint a second credential.
  consumeGrant(loginToken: string, grantToken: string | undefined, presentedToken: string | undefined): { id: number; login: string } | null {
    const flow = this.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'authenticated' || !flow.grantToken || !flow.pendingUser) return null
    if (!this.isBoundTo(flow, presentedToken)) return null
    if (!grantToken || !timingSafeEqualHex(hashToken(flow.grantToken), hashToken(grantToken))) return null
    const user = flow.pendingUser
    flow.grantToken = null
    return user
  }

  // Called after a granted mint; stores the credentials so the next poll
  // returns them. Only reachable from the 'authenticated' state — the two
  // pre-grant states are deliberately no longer accepted.
  completeWithCredentials(loginToken: string, creds: { server: string; loginName: string; appPassword: string }): boolean {
    const flow = this.findByLoginToken(loginToken)
    if (!flow) return false
    if (flow.status !== 'authenticated') return false
    flow.credentials = creds
    flow.pendingUser = null
    flow.status = 'ready'
    return true
  }

  // Called by POST /login/v2/poll. Returns the credentials exactly once.
  // Returns null on all subsequent calls and while still pending.
  consumeByPollToken(pollToken: string): LoginFlow['credentials'] | null {
    const flow = this.flows.get(pollToken)
    if (!flow) return null
    if (this.isExpired(flow)) {
      this.drop(flow)
      return null
    }
    if (flow.status !== 'ready' || !flow.credentials) return null
    const creds = flow.credentials
    flow.status = 'done'
    flow.credentials = null
    // Keep the entry around briefly so repeated polls get a deterministic 404
    // rather than a fresh "pending" interpretation.
    return creds
  }

  // Test hook: purge state. Called between tests to avoid bleed.
  clearForTests(): void {
    this.flows.clear()
    this.loginToPollIndex.clear()
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const flow of this.flows.values()) {
      if (now - flow.createdAt > TTL_MS) this.drop(flow)
    }
  }

  private evictOldest(): void {
    // Map preserves insertion order; oldest is first.
    const first = this.flows.values().next().value
    if (first) this.drop(first)
  }

  private drop(flow: LoginFlow): void {
    this.flows.delete(flow.pollToken)
    this.loginToPollIndex.delete(flow.loginToken)
  }

  private isExpired(flow: LoginFlow): boolean {
    return Date.now() - flow.createdAt > TTL_MS
  }

  private genToken(): string {
    // 32 random bytes, base64url — 43 chars, URL-safe, no padding.
    return crypto.randomBytes(32).toString('base64url')
  }
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
