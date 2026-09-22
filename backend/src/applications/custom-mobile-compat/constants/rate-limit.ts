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
