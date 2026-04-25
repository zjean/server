# Nextcloud mobile login via OIDC (Authelia) — design

Date: 2026-04-25
Branch: `feat/mobile-nc-oidc-login`

## Goal

Let users sign in to the Nextcloud iOS / Android mobile clients against this
fork using the same OIDC identity provider that the web side uses (Authelia in
the maintainer's deployment). After this lands, the mobile NC app's "Add
account" flow goes through Authelia, the user's existing Sync-in account is
resolved by email, and the app receives a per-device app-password the same way
it would against a real Nextcloud server.

## Constraints (decided up front)

1. **Pure isolation.** All new code lives under
   `backend/src/applications/custom-mobile-compat/`. Zero `mod(...)` commits to
   upstream files. The existing OIDC service is consumed via DI but not edited.
2. **Honor existing OIDC config.** Mobile inherits `auth.oidc.options.autoRedirect`,
   `auth.oidc.options.enablePasswordAuth`, and `auth.oidc.security.supportPKCE`
   from `environment.yaml`. No new config keys.
3. **No auto-create on mobile.** If Authelia authenticates a user that has no
   Sync-in account, the mobile flow fails with a friendly "log into the web app
   once first" HTML page. Auto-provisioning stays a web-only concern (where the
   private `processUserInfo` pipeline lives). If this turns out to be a real
   problem, the smallest-possible upgrade is a one-line `mod(auth)` flipping
   `processUserInfo` from `private` to `public`.
4. **Ship behind the existing OIDC provider switch.** When
   `auth.provider !== 'oidc'`, `/login/v2/flow/<token>` keeps rendering today's
   local username/password form unchanged.

## Approach

The Nextcloud mobile clients drive a 3-step "Login Flow v2" handshake:

1. App `POST /index.php/login/v2` → server returns `{poll, login}` URLs.
2. User opens `login` in a system browser → server authenticates, mints an
   app-password, stashes it on the flow.
3. App polls `POST /index.php/login/v2/poll` → gets
   `{server, loginName, appPassword}` once.

The fork already implements all three steps with a local username/password form
at the browser hop (`nc-login-v2.controller.ts:60-149`). The only thing missing
is delegating that browser hop to Authelia when OIDC is configured. Because
the mobile client has no protocol awareness of OIDC at all, the entire dance
happens server-side and is invisible to the app — it still just polls until
the app-password lands.

The browser hop becomes:

```
GET /login/v2/flow/<loginToken>
  ├── auth.provider !== 'oidc'                → render local form (unchanged)
  ├── auth.provider === 'oidc' + autoRedirect → 302 to /custom-mobile/oidc/login/<loginToken>
  └── auth.provider === 'oidc' + button mode  → render "Continue with Authelia" button
                                                 (+ local form below if enablePasswordAuth)

GET /custom-mobile/oidc/login/<loginToken>    → 302 to Authelia authorization endpoint
GET /custom-mobile/oidc/callback?code&state   → exchange code, look up user,
                                                 mint MOBILE_NC app-password,
                                                 complete the NC flow,
                                                 render "All set!"
```

## State model

The `state` parameter sent to Authelia is the NC `loginToken` itself. It is
already a server-generated random value (created at step 1) that uniquely
identifies the in-flight mobile login, and it is authoritative on lookup —
the server will only accept a callback for a flow it knows about.

PKCE `codeVerifier` and OIDC `nonce` are stored **on the flow record**, not
in cookies. The browser tab that hits `/login/v2/flow/...` is not always the
same tab that returns from Authelia (in-app webviews especially), so
cookie-bound state is fragile here. Server-side state keyed by the
round-tripped `loginToken` survives all the weird cases.

`NcLoginFlowService.LoginFlow` gains:

```ts
status: 'pending' | 'oidc-pending' | 'ready' | 'consumed'   // 'oidc-pending' is new
oidc?: { codeVerifier: string; nonce: string }              // populated at oidc-login start
```

The web OIDC flow continues to use its own `OAuthCookie.{State, Nonce, CodeVerifier}`
cookies and the `/api/auth/oidc/callback` endpoint. The two flows share no state
and no callback URL — a user can have both in flight simultaneously without
collision.

## Files

**New** (all under `backend/src/applications/custom-mobile-compat/`):

| Path | Purpose |
|---|---|
| `controllers/nc-mobile-oidc.controller.ts` | `GET /custom-mobile/oidc/login/:loginToken`, `GET /custom-mobile/oidc/callback` |
| `services/nc-mobile-oidc.service.ts` | Auth-URL builder, code-exchange, userinfo→user lookup |
| `constants/oidc.constants.ts` | Route paths |

**Modified** (custom paths only — no upstream contact):

| Path | Change |
|---|---|
| `controllers/nc-login-v2.controller.ts` | `renderLoginPage` branches on `auth.provider` and `oidc.options` |
| `services/nc-login-flow.service.ts` | Add `'oidc-pending'` status, `oidc` field, `markOidcPending()` method |
| `custom-mobile-compat.module.ts` | Register new controller + service |
| `constants/routes.ts` | Add `MOBILE_OIDC_LOGIN` and `MOBILE_OIDC_CALLBACK` |

The custom service injects upstream's `AuthProviderOIDC` and calls only public
methods (`getConfig()` returns the openid-client `Configuration`); plus
`UsersManager` for `findUser()` and `generateAppPassword()`. No private-method
access, no visibility changes, no upstream edits.

## Controller logic

### `GET /login/v2/flow/<loginToken>` (modified)

```text
flow = flows.findByLoginToken(loginToken)
flow missing            → 404 "Login expired"
flow.status !== pending → "Already authorized"

provider !== oidc       → render local form (unchanged behavior)

oidc.autoRedirect       → 302 /custom-mobile/oidc/login/<loginToken>
otherwise               → render button page; include local form iff enablePasswordAuth
```

### `GET /custom-mobile/oidc/login/:loginToken` (new)

```text
flow = flows.findByLoginToken(loginToken)
flow missing or status !== pending → 404 "Login expired"

config       = authProviderOIDC.getConfig()
codeVerifier = randomPKCECodeVerifier()
nonce        = randomNonce()
flows.markOidcPending(loginToken, { codeVerifier, nonce })

authUrl with:
  state         = loginToken
  redirect_uri  = <baseUrl>/custom-mobile/oidc/callback
  response_type = code
  scope         = oidc.security.scope
  PKCE S256     iff oidc.security.supportPKCE
302 → authUrl
```

### `GET /custom-mobile/oidc/callback?code&state[&error&error_description]` (new)

```text
query.error              → render "Sign-in cancelled" HTML, leave flow oidc-pending
state missing            → 400 "missing state"
flow = flows.findByLoginToken(state)
flow missing or status !== oidc-pending → 404 "Login expired"

tokens   = authorizationCodeGrant(config, callbackUrl, {
              expectedState: state,
              pkceCodeVerifier: flow.oidc.codeVerifier,
              expectedNonce:    flow.oidc.nonce
           })
claims   = tokens.claims()
subject  = oidc.security.skipSubjectCheck ? skipSubjectCheck : claims.sub
userInfo = fetchUserInfo(config, tokens.access_token, subject)

email    = userInfo.email (required; reject if absent — mirrors upstream)
login    = userInfo.preferred_username ?? email.split('@')[0] ?? userInfo.sub
user     = usersManager.findUser(email || login, false)
user missing → render "No Sync-in account for <email>" HTML

appPwd   = usersManager.generateAppPassword(user, {
              name: `mobile ${loginToken.slice(0,8)}`,
              app:  AUTH_SCOPE.MOBILE_NC,
              expiration: null
           })
flows.completeWithCredentials(loginToken, {
  server: response.baseUrl(req),
  loginName: user.login,
  appPassword: appPwd.password
})

render "All set!" HTML
```

## Edge cases

| Case | Behavior |
|---|---|
| Flow TTL (>20 min) expires during Authelia round-trip | Callback returns 404 "Login expired"; user re-initiates from app |
| Authelia callback fired twice (replay) | Second call sees `status === 'ready'` not `'oidc-pending'` → "Already authorized" |
| State tampering / wrong loginToken | Lookup fails → 404. `authorizationCodeGrant` also re-checks `expectedState` server-side. |
| Authelia surfaces `error=access_denied` (user clicked Cancel) | "Sign-in cancelled" HTML; flow stays `oidc-pending`; user can hit Back and retry until TTL |
| Authelia user has no Sync-in account | Friendly "log into the web app once first" HTML; flow stays `oidc-pending`; no app-password minted |
| `auth.provider !== 'oidc'` | Local form path is byte-for-byte unchanged |
| Local-password fallback (admin / guest / `enablePasswordAuth`) | Existing form still calls `usersManager.logUser()`; 2FA enforcement is unchanged (matches current mobile-flow behavior) |

## Authelia configuration

One client config addition — add a second `redirect_uri`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: sync-in
        # ...existing settings unchanged...
        redirect_uris:
          - https://sync-in.example.com/api/auth/oidc/callback         # web (existing)
          - https://sync-in.example.com/custom-mobile/oidc/callback    # NEW
```

PKCE / scopes / auth method / client secret all stay as-is — the mobile flow
inherits the same client. No new secrets.

## Sync-in configuration

Nothing new. Mobile reads:

- `auth.provider` (must be `oidc` for the OIDC path to engage)
- `auth.oidc.options.autoRedirect` (skip button page → straight to Authelia)
- `auth.oidc.options.enablePasswordAuth` (show local form alongside button)
- `auth.oidc.security.supportPKCE` (S256 challenge)
- `auth.oidc.security.scope` (passed to authorization endpoint)
- `auth.oidc.security.skipSubjectCheck` (passed to `fetchUserInfo`)

## Tests

All under `backend/src/applications/custom-mobile-compat/`:

- `services/nc-mobile-oidc.service.spec.ts` — auth-URL build, codeVerifier/nonce
  stamping on flow, `findUser` lookup branches (found / not-found / no email).
  Mock `AuthProviderOIDC.getConfig()` and `openid-client`'s `fetchUserInfo` and
  `authorizationCodeGrant`.
- `controllers/nc-mobile-oidc.controller.spec.ts` — happy path, expired flow,
  Authelia error param, no Sync-in account.
- `controllers/nc-login-v2.controller.spec.ts` (extended) — provider=oidc with
  `autoRedirect=true` returns 302; with `autoRedirect=false` +
  `enablePasswordAuth=true` renders both button and form.

No CI e2e against Authelia. Manual round-trip is the maintainer's pre-tag check.

## Manual smoke

1. Add the second `redirect_uri` to Authelia client; reload Authelia.
2. Pull `:main`, restart Sync-in.
3. iOS NC app → Add account → enter Sync-in URL.
4. Browser opens at `/login/v2/flow/<token>` → either redirects (autoRedirect on)
   or shows button (autoRedirect off).
5. Sign in at Authelia → "All set!" → return to app → app receives credentials,
   browses files.
6. Sync-in admin: a new app-password named `mobile <prefix>` exists for the
   user, scoped `MOBILE_NC`.
7. Try the local-password fallback path (admin user with `enablePasswordAuth`):
   the form still works.
8. Try with no Sync-in account: friendly error HTML, no app-password minted.

## Implementation order (4 commits)

All commits are `feat(custom-mobile-compat): ...` because pure isolation means
nothing in this work touches an upstream file.

1. State extension to `NcLoginFlowService` (`'oidc-pending'` status, `oidc`
   field, `markOidcPending`) + service unit tests.
2. `nc-mobile-oidc.service.ts` (auth-URL build, code exchange, user lookup) +
   spec.
3. `nc-mobile-oidc.controller.ts` (login + callback handlers) + spec, plus the
   `nc-login-v2.controller.ts` dispatch branch + extended spec, plus module
   wiring.
4. Authelia config note in `docs/` for future maintainers.

## Out of scope

- 2FA on the local-password fallback — left unchanged, matches today's behavior.
  Worth a follow-up, but a separate concern.
- Multi-process / Redis-backed flow store. Today's in-memory store is single-
  process and the existing design doc already flags Redis as a follow-up.
- Auto-provisioning users on mobile-first login. If wanted later, add a
  one-line `mod(auth)` to expose `processUserInfo` and call it.

## Risk

- **Authelia config drift.** Adding the second `redirect_uri` is a one-time
  change. Documented above + in the manual-smoke checklist.
- **In-memory flow store survives a process restart.** It does not. A user mid-
  login during a deploy will see "Login expired" and have to retry. Acceptable
  for this fork's deployment cadence.
- **iOS in-app webview cookie behavior.** Sidestepped — state is server-side.
