import { randomBytes } from 'node:crypto'
import { IS_TEST_ENV } from '../../../configuration/config.constants'

// Per-IP rate limits for the Nextcloud-compatible surface (#477).
//
// Every route in this module is `@AuthTokenSkip()`, so none of them is behind
// the global `AuthTokenAccessGuard`, and `AuthRateLimitGuard` is opt-in per
// route and was on none of them. That left three unauthenticated, unmetered
// entry points; the numbers below are chosen against what each one actually
// costs an attacker, not as a uniform default.
//
// Shapes and units match `AUTH_RATE_LIMIT_OPTIONS` (ttl and blockDuration in
// MILLISECONDS) so they read against upstream's own limits side by side.

// Per-run bucket scope, EMPTY outside tests.
//
// The limiters deliberately carry no `skipIf: () => IS_TEST_ENV` (that is the
// whole reason this module does not use `AuthRateLimitGuard`): a limiter that
// is off where we assert is a limiter nobody has tested. But leaving the key
// unqualified makes the counter global to the shared dev cache, and the e2e
// suite runs its spec files in PARALLEL worker threads against one database
// and one cache. Every NC-touching file mints credentials that miss the
// basic-auth cache, so they all draw on one 60/60s budget — and two agents
// running `test:e2e` at the same time would push it over and surface as an
// unrelated-looking 401/429 in whichever file lost the race.
//
// A random scope per PROCESS gives each worker thread (and each concurrent
// run) its own counter. The limiter still runs, still counts, still blocks,
// and a spec can still assert it blocks — the budget is simply not shared
// with a test nobody wrote together with it. In production the scope is the
// empty string, so the key is exactly what it would otherwise have been.
export const NC_RATE_LIMIT_SCOPE: string = IS_TEST_ENV ? `-run${randomBytes(6).toString('hex')}` : ''

export interface NcRateLimitOptions {
  limit: number
  ttl: number
  blockDuration: number
}

export const NC_RATE_LIMIT_OPTIONS = {
  // POST /index.php/login/v2 — unauthenticated flow creation.
  //
  // Cheap per request, but it used to evict a legitimate in-flight sign-in per
  // call once the store was full. The store is the cache now, so that
  // particular DoS is gone; this bounds the remaining cost (three cache
  // writes) and keeps a flood out of Redis. A real client calls this once per
  // sign-in, so 20/min per IP is far above any honest use while still allowing
  // a shared NAT egress to sign several people in at once.
  LOGIN_FLOW_INITIATE: { limit: 20, ttl: 60_000, blockDuration: 60_000 },

  // POST /login/v2/flow/:token — the browser posting a username and password.
  //
  // This validates exactly the credentials `/auth/login` protects with
  // `AuthRateLimitGuard`, and was the one unthrottled password oracle left in
  // the app: per-account lockout still applied, cross-account spraying did
  // not. Deliberately the SAME 6/60s as `AUTH_RATE_LIMIT_OPTIONS` — a second
  // door onto one credential store should not be cheaper than the first.
  LOGIN_FLOW_SUBMIT: { limit: 6, ttl: 60_000, blockDuration: 60_000 },

  // POST /login/v2/grant/:token — mints the app password.
  //
  // Reaching it needs an authenticated flow, the browser-binding cookie and
  // the single-use grant token, so this is a backstop on the mint (which
  // writes rows and hashes a password), not an authentication gate.
  LOGIN_FLOW_GRANT: { limit: 20, ttl: 60_000, blockDuration: 60_000 },

  // GET /custom-mobile/oidc/login/:token — the browser hop that starts the
  // IdP round-trip. Only mounted when `auth.provider === 'oidc'`.
  //
  // An unknown token 404s and an unbound browser 409s before anything is
  // spent, so the metered cost is the authorization-URL build (PKCE + a
  // discovery lookup) plus a flow write. Same 20/60s as the initiate route it
  // follows: one honest sign-in uses one call, and a shared NAT egress can
  // still start several at once.
  MOBILE_OIDC_START: { limit: 20, ttl: 60_000, blockDuration: 60_000 },

  // GET /custom-mobile/oidc/callback — where the IdP returns.
  //
  // The only route in this module that makes an OUTBOUND request per call: a
  // code exchange against the IdP's token endpoint, plus a userinfo fetch.
  // It is unauthenticated (the IdP's redirect is the only thing that reaches
  // it) and a bad `state` 404s cheaply, but without a limit anyone who can
  // guess or observe an in-flight loginToken can point our token endpoint at
  // the IdP as fast as they like. One honest sign-in makes exactly one call.
  MOBILE_OIDC_CALLBACK: { limit: 20, ttl: 60_000, blockDuration: 60_000 },

  // NcBasicAuthGuard, for credentials that MISS the guard's positive/negative
  // cache and therefore reach `validateAppPassword`.
  //
  // That call bcrypt(10)s the presented password against up to
  // MAX_MOBILE_PASSWORDS (5) stored hashes — roughly half a second of CPU per
  // unauthenticated request. The guard's failure cache is keyed on the
  // credential PAIR, so an attacker sending a unique password every time never
  // hits it and pays nothing to burn a core.
  //
  // Same 60/60s as `AUTH_WEBDAV_RATE_LIMIT_OPTIONS`, and for the same reason:
  // every NC request is authenticated and the client floods PROPFINDs during
  // sync, so the budget has to be generous — but only cache MISSES consume it,
  // and a syncing client misses once per credential.
  BASIC_AUTH: { limit: 60, ttl: 60_000, blockDuration: 60_000 }
} as const satisfies Record<string, NcRateLimitOptions>
