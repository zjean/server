# Authelia config for the Nextcloud mobile login flow

When `auth.provider: oidc`, the Nextcloud iOS / Android client login flow
delegates the browser hop to your IdP. The custom-mobile-compat module exposes
its callback at:

```
https://<your-sync-in>/custom-mobile/oidc/callback
```

This is **a separate URL from the web callback** (`/api/auth/oidc/callback`).
Add it as a second `redirect_uri` on the same Authelia client you use for the
web side — no new client, no new client secret:

```yaml
# /config/configuration.yml (Authelia)
identity_providers:
  oidc:
    clients:
      - client_id: sync-in
        # ...your existing settings unchanged...
        redirect_uris:
          - https://sync-in.example.com/api/auth/oidc/callback         # web (existing)
          - https://sync-in.example.com/custom-mobile/oidc/callback    # mobile (NEW)
```

After editing, reload Authelia (`docker compose restart authelia` or your
equivalent). No Sync-in restart is needed — the route is already mounted
whenever `auth.provider === 'oidc'`.

## How to verify it works

1. iOS / Android Nextcloud app → Add account → enter your Sync-in URL.
2. Browser opens at `/login/v2/flow/<token>`. Either:
   - if `auth.oidc.options.autoRedirect: true` — you go straight to Authelia, or
   - otherwise — you see a "Continue with OpenID Connect" button (and, if
     `auth.oidc.options.enablePasswordAuth: true`, the username/password form
     beneath as a fallback).
3. Sign in at Authelia.
4. Back on Sync-in: an "All set!" page renders.
5. Return to the mobile app — it polls and receives an app-password.
6. The Sync-in admin UI now shows a new app-password named
   `mobile <token-prefix>` for your user, scoped `MOBILE_NC`. Files browse and
   sync over `/remote.php/dav/...` using HTTP Basic auth with that app-password.

## When it doesn't work

| Symptom | Likely cause |
|---|---|
| Authelia shows "Invalid redirect_uri" | The new `redirect_uri` is missing or has a typo (must match exactly, including scheme + path). |
| Browser ends on "Login session expired" before reaching Authelia | The 20-minute NC flow TTL elapsed; just retry from the app. |
| Browser ends on "No Sync-in account for &lt;email&gt;" | The IdP authenticated a user that has no Sync-in account. Mobile is lookup-only — sign in to the Sync-in web app once first to provision the account, then retry on mobile. |
| Browser ends on "Sign-in cancelled" | You clicked Cancel at Authelia. The flow stays alive for the rest of the 20-minute TTL; hit Back and try again. |
| Mobile app polls forever | The browser tab never reached the success page. Check the reverse proxy in front of Sync-in is forwarding `/custom-mobile/...` paths correctly. |

## Design / decisions

For the why, see [`docs/plans/2026-04-25-mobile-nc-oidc-login-design.md`](plans/2026-04-25-mobile-nc-oidc-login-design.md).
