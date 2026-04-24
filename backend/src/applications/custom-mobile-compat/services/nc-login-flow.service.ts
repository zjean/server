import { Injectable } from '@nestjs/common'
import * as crypto from 'node:crypto'

// In-memory LRU-ish store for in-flight NC login-v2 flows.
//
// A flow lives for up to 20 minutes (Nextcloud's published token lifetime).
// Each flow goes through these states:
//   PENDING → the browser tab hasn't completed yet; poll returns 404.
//   READY   → browser completed auth, app-password minted; next poll returns
//             credentials once and the flow is consumed.
//   DONE    → consumed; further polls return 404 forever. Eventually evicted.
//
// Single-process only in this MVP; multi-instance deployments need a shared
// backend (Redis). Flagged as follow-up in the design doc.

export type LoginFlowStatus = 'pending' | 'ready' | 'done'

export interface LoginFlow {
  pollToken: string
  loginToken: string
  status: LoginFlowStatus
  createdAt: number
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
  initiate(): LoginFlow {
    this.evictExpired()
    const pollToken = this.genToken()
    const loginToken = this.genToken()
    const flow: LoginFlow = {
      pollToken,
      loginToken,
      status: 'pending',
      createdAt: Date.now(),
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

  // Called by the browser POST /login/v2/flow/{loginToken} after a successful
  // login; stores the minted credentials on the flow so the next poll returns
  // them.
  completeWithCredentials(loginToken: string, creds: { server: string; loginName: string; appPassword: string }): boolean {
    const flow = this.findByLoginToken(loginToken)
    if (!flow || flow.status !== 'pending') return false
    flow.credentials = creds
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
