# Nextcloud mobile-client compatibility layer — design

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Branch**: `docs/mobile-api-plan` (this doc), implementation to follow on a separate branch
**Scope milestone**: post-milestone-4 add-on; parallel track to the frontend v3 redesign

## Goal

Let unmodified Nextcloud mobile clients (iOS, Android) log in to a Sync-in server and operate against it with the same feature depth they'd have against a real Nextcloud server — minus sharing and activity. The server must remain upstream-mergeable: all additions live under a `custom-*` path, one-line edits to upstream files use the fork's `mod(...):` commit convention.

This plan targets **level B — full mobile sync**, locked with the user (see scope Q&A below). It does *not* cover the NC Android app's chat / Talk integration, sharing, notifications, activity, or the desktop sync client (the latter is mostly WebDAV + chunked uploads, so most of this work carries over should we want it later).

## Non-goals

- **Sharing via mobile** (OCS `/apps/files_sharing/api/v1/shares`, sharees search). Deferred — Sync-in's native sharing UI in v2 stays the shared surface.
- **Notifications push** (`/apps/notifications/*`, Unified Push). No Sync-in notification bus maps to NC's model today.
- **Activity feed** (`/apps/activity/*`). Not modelled on the Sync-in side.
- **Talk / calls**, **Deck**, **Calendar** (CalDAV), **Contacts** (CardDAV). Separate protocol layers with their own infrastructure needs.
- **Synthetic multi-space root**. See root mapping Q&A — we ship personal-only with a config hook.
- **XML OCS responses**. JSON only; clients have supported `?format=json` + `Accept: application/json` for years and requiring it simplifies the module.

## Why OxiCloud as a reference

OxiCloud ([AtalayaLabs/OxiCloud](https://github.com/AtalayaLabs/OxiCloud)) is a Rust-based Nextcloud-API-compatible backend whose `src/interfaces/nextcloud/` directory implements exactly the surface mobile clients use. We mine it for:

1. **The route manifest** — their `routes.rs` is a curated list of every endpoint the stock NC iOS/Android clients actually hit at runtime. We reproduce the subset we need.
2. **Response shapes** — their OCS handler is a good crib for the `{ ocs: { meta, data } }` envelope and capabilities JSON.
3. **Auth separation** — they require app passwords for everything behind the login flow; the main password never authorizes NC routes. We adopt the same posture.

## Decisions locked with user

- **Scope level B**: auth flow, full WebDAV R/W, chunked uploads, trashbin WebDAV, preview, avatar, capabilities, user info, status.php. No sharing, no notifications, no activity.
- **Auth model B**: reuse Sync-in's existing `user.secrets.appPasswords[]` store. NC routes are guarded by a new `AuthMobileAppPasswordStrategy` that *only* accepts Basic-Auth credentials whose `password` matches a stored app-password. The user's main login password is rejected on NC routes.
- **Root mapping C**: `/remote.php/dav/files/{user}/` maps to the user's `personal/` hierarchy today. A per-user `user.settings.mobileHome` lookup is wired into the path resolver from day 1 but no settings UI for it is shipped — defaults to `personal`, can be flipped to `space:<alias>` by direct DB edit. Proper UI in a later phase.
- **Module boundary**: one NestJS module at `backend/src/applications/custom-mobile-compat/`. Registered in `applications.module.ts` via a single-line edit (one `mod(applications): …` commit). No other upstream files modified.

## Architecture

### Module layout

```
backend/src/applications/custom-mobile-compat/
├── custom-mobile-compat.module.ts        # NestJS module, imports WebDAVModule, UsersModule, FilesModule
├── constants/
│   ├── routes.ts                         # URL constants (NC_ROUTE.STATUS, NC_ROUTE.DAV_FILES, ...)
│   └── capabilities.ts                   # Static capabilities.json payload
├── controllers/
│   ├── nc-discovery.controller.ts        # status.php, /index.php/204, /remote.php/dav probe
│   ├── nc-login-v2.controller.ts         # POST /index.php/login/v2 + poll + /login/v2/flow/{token}
│   ├── nc-ocs.controller.ts              # capabilities, cloud/user, avatar, preview, apppassword delete
│   └── nc-dav.controller.ts              # /remote.php/dav/files|uploads|trashbin|/remote.php/webdav
├── guards/
│   └── nc-basic-auth.guard.ts            # Basic-Auth that rejects main password, accepts app-passwords only
├── services/
│   ├── nc-login-flow.service.ts          # Token issuance + polling state (in-memory LRU, 20 min TTL)
│   ├── nc-path-resolver.service.ts       # /remote.php/dav/files/{user}/X → {space, repo, path}
│   ├── nc-response.service.ts            # OCS JSON envelope helper
│   └── nc-preview.service.ts             # Wraps existing thumbnail logic if present, else stubs 404
├── interfaces/
│   ├── nc-login-flow.interface.ts
│   ├── nc-ocs.interface.ts
│   └── nc-capabilities.interface.ts
└── utils/
    ├── ocs-envelope.ts
    └── app-password.ts                   # Thin wrapper around UsersManager appPasswords methods
```

**One upstream file touched** — `applications.module.ts` gains a `CustomMobileCompatModule` import. Commit message: `mod(applications): register custom mobile compat module`. This is the entire upstream blast radius.

### Path resolution (root mapping C)

The resolver is the load-bearing piece. It translates NC paths into the tuple `(space, repository, relativePath)` that Sync-in's `FilesManager` / `WebDAVMethods` consume.

```
/remote.php/dav/files/{user}/{subpath}
  → lookup user.settings?.mobileHome ?? 'personal'
  → if 'personal'        → space=null, repo=files, alias=personal, path={subpath}
  → if 'space:<alias>'   → space={alias}, repo=files, alias=<alias>, path={subpath}
  → if 'space:<alias>/<root>' → same with space root resolved

/remote.php/dav/trashbin/{user}/{subpath}
  → same as above but repo=trash

/remote.php/dav/uploads/{user}/{upload_id}/{part}
  → synthetic namespace under a dedicated on-disk temp dir (not a Sync-in file);
    see "Chunked upload" below.

/remote.php/webdav/*  → 301 to /remote.php/dav/files/{user}/*
```

The resolver is the only place that understands NC path semantics — controllers build a `FastifyDAVRequest`-compatible `req.space` off its output and delegate to the existing `WebDAVMethods` service. No duplication of PROPFIND XML generation, lock handling, or permissions checks.

### WebDAV reuse vs. reimplement

**Reuse** `WebDAVMethods` via an adapter. Approach:

1. `NCDavController` receives the request, authenticates it via `NcBasicAuthGuard`.
2. Calls `NcPathResolver.resolve(req)` to populate `req.space` in the shape `@WebDAVEnvironment()` would have produced — `{ realPath, inSharesList, permissions, space, root, ... }`.
3. Delegates to `WebDAVMethods.propfind / headOrGet / put / move / copy / delete / mkcol / proppatch` exactly as `WebDAVController` does today.

If the resolver turns out not to cover some `req.space` field that `WebDAVMethods` reads (e.g. owner resolution for shared spaces), we fall back to instantiating `WebDAVSpaces` directly and re-building the environment with its public method. No copy-paste of propfind XML generation.

**Chunked uploads** (`/remote.php/dav/uploads/{user}/{upload_id}/{part}`) have no analog in Sync-in's WebDAV — Sync-in does either single-shot PUT or a v2 API upload flow. The NC chunked protocol is:

- `MKCOL /remote.php/dav/uploads/{user}/{upload_id}` — open a staging collection
- `PUT .../0`, `PUT .../1`, ... — upload chunks numbered by byte-range string
- `MOVE .../ -> /remote.php/dav/files/{user}/<target>` with `OC-Total-Length` header — server concatenates and moves to target

We reimplement this one flow in `nc-dav.controller.ts` with on-disk staging under a dedicated temp dir (e.g. `<data>/nc-uploads/<user_id>/<upload_id>/`), then delegate the final MOVE to `FilesManager.move()`. ~300 LOC total. No disturbance to Sync-in's native WebDAV.

### Auth flow — Login v2

```
mobile client                                  server
──────────────                                 ──────
POST /index.php/login/v2
  (no auth)
                                               ◀── { poll: {token, endpoint}, login: <browser URL> }
──────────── user opens browser ────────────
GET  /login/v2/flow/{token}
                                               ◀── NC-styled login page, form posts back here
                                                   (we render a minimal HTML page that posts to /api/auth/login
                                                   then calls our own complete-flow endpoint on success)
POST /login/v2/flow/{token} (login form)
                                               ── generate new app-password row, attach to token ─→
                                               ◀── "success" page

(client meanwhile polls)
POST /index.php/login/v2/poll
  token=<token>
                                               ◀── 404 until authorized
                                               ◀── { server, loginName, appPassword } once authorized
                                                    (returned exactly once)
```

Token+app-password state lives in an in-memory LRU (`nc-login-flow.service.ts`) with 20-minute TTL. Multi-instance deployments: either we put it in Redis (already a Sync-in dependency for cache) or accept single-instance-only for MVP. **Plan: start with in-process LRU, flag as follow-up for Redis**.

The browser flow page needs to look-and-feel like a login page. Two paths:

1. **Render a fresh page from the custom module** (minimal HTML, posts to existing `/api/auth/login`, then a hidden XHR to our token-complete endpoint). Lives in `custom-mobile-compat/` — no theming touched.
2. **Redirect to classic `/login` with a query param**, then trap the post-login navigation. More integration with the existing frontend, which we'd rather avoid per "keep upstream mergeable".

Go with **1**. Small standalone HTML templated server-side, ~80 LOC including styling.

### Auth flow — subsequent requests (guard)

`NcBasicAuthGuard` is a new Passport-less guard (simpler than registering another strategy):

1. Parse `Authorization: Basic <base64(login:app-password)>`.
2. Look up user by login/email (existing `UsersManager.getUserByLoginOrEmail`).
3. Check `app-password` exactly matches a hashed entry in `user.secrets.appPasswords[]` (existing method `UsersManager.verifyAppPassword` — confirm it exists, add if not; should be ~20 LOC delta inside UsersManager, which *would* be an upstream edit — see "Upstream-touching helpers" below).
4. On success, attach `req.user` and continue. On failure, `401` with `WWW-Authenticate: Basic realm="Nextcloud"`.

Cache successful auth like the existing Basic Auth strategy does (15-min TTL keyed by `sha256(login\0password)`) to keep per-request latency down on WebDAV floods.

### Upstream-touching helpers

The guard needs `UsersManager.verifyAppPassword(user, candidate)`. Grep shows `secrets.appPasswords` is already read and written in `users-manager.service.ts`; verifying isn't a huge new method, but adding it to `users-manager.service.ts` is an upstream edit.

Options:
- **a.** Add `verifyAppPassword` directly to `UsersManager` with a `mod(users): expose app-password verification helper` commit. Small, reusable upstream if we ever contribute back. Low maintenance.
- **b.** Read `user.secrets.appPasswords` directly in a helper under `custom-mobile-compat/utils/app-password.ts` using the same hashing Sync-in uses. Zero upstream edits but duplicates the hash check — divergence risk if upstream changes the hashing scheme.

**Go with (a)**. Hash scheme is upstream logic — duplicating it is the worse failure mode. The mod commit is one file, ~15 LOC, cherry-pickable upstream.

### OCS response envelope

JSON-only. All OCS responses come from a single helper:

```ts
ocsJson<T>(data: T, { status = 'ok', statuscode = 100, message = '' } = {}): OcsEnvelope<T>
```

Returns `{ ocs: { meta: {status, statuscode, message}, data } }`. Response header is `application/json; charset=utf-8`. If a request comes in with `Accept: text/xml` or `application/xml`, we respond `406 Not Acceptable` with a short explanation — documented in the plan's README notes.

For `Accept: */*` or `Accept: application/json`, we set JSON.

### Capabilities payload

Minimal but realistic — enough to stop mobile clients from disabling major features:

```json
{
  "version": { "major": 29, "minor": 0, "micro": 0, "string": "29.0.0-sync-in", "edition": "" },
  "capabilities": {
    "core": { "pollinterval": 60, "webdav-root": "remote.php/webdav" },
    "files": {
      "bigfilechunking": true,
      "undelete": true,
      "versioning": false
    },
    "dav": {
      "chunking": "1.0",
      "trashbin": "1.0",
      "bulkupload": "1.0"
    },
    "theming": { "name": "Sync-in", "url": "https://github.com/zjean/server" },
    "files_sharing": { "api_enabled": false }
  }
}
```

`versioning: false` is honest — Sync-in doesn't version-track via this API. `files_sharing.api_enabled: false` is what tells the NC client to hide the "Share" button in the mobile UI, which is exactly what we want for MVP.

### Avatar + preview

- **Avatar** `/index.php/avatar/{user}/{size}` — delegates to existing `UsersManager.getAvatar(user.login)`. If `size` asks for something we don't cache a sized variant for, return the single uploaded avatar; NC clients resize client-side fine. ~40 LOC.
- **Preview** `/index.php/core/preview?fileId=<id>&x=<w>&y=<h>` — Sync-in already has a preview/thumbnail endpoint somewhere (to confirm during exec). If present: delegate. If absent: return `404` with a graceful body; NC clients fall back to download-on-demand thumbnails. Don't introduce a new thumbnail pipeline in this phase.

### Status.php and connectivity probes

Lightweight. `status.php` returns `{ installed: true, maintenance: false, needsDbUpgrade: false, version: "29.0.0.10", versionstring: "29.0.0-sync-in", edition: "", productname: "Sync-in", extendedSupport: false }`. `/index.php/204` returns HTTP 204 no-content. `/remote.php/dav` (any method) returns 401 with `WWW-Authenticate: Basic realm="Nextcloud"` when unauthenticated, else an empty 207.

## Task breakdown

Two execution waves. Each wave is committable + unit-testable on its own.

### Wave 1 — foundations (no mobile app testing yet)

1. **Module skeleton + routes constants** — `custom-mobile-compat.module.ts`, `constants/routes.ts`, `constants/capabilities.ts`. Empty controllers, wired into `applications.module.ts` (the one `mod(applications): …` commit). ~150 LOC.
2. **OCS envelope helper + response service** — `utils/ocs-envelope.ts`, `services/nc-response.service.ts`. With unit tests against the envelope shape. ~80 LOC + ~60 LOC tests.
3. **NcBasicAuthGuard + UsersManager.verifyAppPassword** — the `mod(users): …` helper, the new guard, cached verification path. Unit tests: main password rejected, valid app password accepted, invalid rejected, missing header → 401 with realm header. ~140 LOC + tests.
4. **Login-flow service + controller** — in-memory LRU, 20-min TTL, `/index.php/login/v2` + `poll` + `flow/{token}`. Minimal login page HTML. e2e test: initiate → browser GETs page → simulated submit → poll returns credentials. ~350 LOC + tests.
5. **Discovery controller** — `status.php`, `/index.php/204`, `/remote.php/dav` probe. ~80 LOC + tests.
6. **Capabilities + user-info OCS endpoints** — `/ocs/v{1,2}.php/cloud/capabilities`, `/ocs/v2.php/cloud/user`, `/ocs/v{1,2}.php/cloud/users/{userid}`, `DELETE /ocs/v2.php/core/apppassword`. All behind the guard except capabilities (public). ~250 LOC + tests.

**Wave 1 exit criteria**: curl an NC-shaped login flow end-to-end, get an app password, hit `/ocs/v2.php/cloud/user` with it, see your user info back. No WebDAV yet.

### Wave 2 — WebDAV + real mobile app

7. **NcPathResolver** — `/remote.php/dav/files/{user}/X` → `(space, repo, path)`. Honors `user.settings?.mobileHome` (wired but defaulted; no settings UI). Unit tests cover personal, trashbin, space-override. ~200 LOC + tests.
8. **NcDavController — read ops** — PROPFIND, HEAD/GET against `/remote.php/dav/files/{user}/*` via `WebDAVMethods` delegation. Also `/remote.php/webdav/*` → 301 redirect. Real NC iOS/Android client can now log in and browse. ~200 LOC + e2e tests.
9. **NcDavController — write ops** — PUT, DELETE, MOVE, COPY, MKCOL, PROPPATCH. Delegation plus special-cases for client headers (`X-OC-MTime`, `OC-Checksum`). ~250 LOC + tests.
10. **Trashbin WebDAV** — `/remote.php/dav/trashbin/{user}/*`. Delegation via resolver picking `repo=trash`. Existing Sync-in trash is per-space — confirm the mapping during exec; may need to restrict to personal-trash only for MVP. ~100 LOC + tests.
11. **Chunked uploads** — `/remote.php/dav/uploads/{user}/{upload_id}/*`: MKCOL staging dir, PUT parts to disk, MOVE-to-target concatenates + delegates to `FilesManager.move()`. On-disk staging under `<config.dataDir>/nc-uploads/<user_id>/`. Cleanup job for stale `upload_id`s older than 24h (reuse existing cron infra if present). ~400 LOC + tests.
12. **Avatar + preview endpoints** — delegate to existing helpers, graceful 404 for preview if Sync-in lacks a thumbnail pipeline. ~100 LOC + tests.

**Wave 2 exit criteria**: install the stock NC iOS client, log in against a dev Sync-in, browse `Personal/`, upload a photo via Auto Upload, delete a file, restore from trash, download. All of that working end-to-end. Manual test log in the plan.

### Wave 3 (optional, follow-up) — polish + ops

- Move login-flow LRU to Redis for multi-instance.
- Wire a UI in `/v2/settings` Security tab to edit `user.settings.mobileHome` (depends on phase 4.13 shipping).
- Cron to prune expired chunked-upload staging dirs.
- Add a `docker-compose.mobile-test.yml` that spins up Sync-in + tells you the URL to type into the NC client.

## Risks + unknowns

1. **WebDAV request-object compat**: the resolver has to produce a `req.space` exactly shaped like what `@WebDAVEnvironment()` produces today. If `WebDAVMethods` touches any field the decorator sets that isn't obvious from code reading, Wave-2 integration will surface it as a runtime 500. Mitigation: a dedicated unit test that constructs a mock `req` and feeds `WebDAVMethods` against a tempdir fixture, for each method.
2. **Stock NC client quirks**: iOS and Android have known divergent tolerance for missing OCS endpoints — iOS is stricter. We'll want to test against both on real devices in Wave-2 exit. A simulator + real phone each is the practical minimum.
3. **App-password hashing scheme drift**: Sync-in may change how it hashes `appPasswords[].password` in a future upstream release. Mitigation: our `verifyAppPassword` helper lives in upstream territory (the `mod(users): …` file) so the change forces a merge-time review rather than silent breakage.
4. **Chunked-upload edge cases**: big uploads that fail mid-way need resumable semantics that real NC clients expect (re-MKCOL the same upload_id, PUT missing chunks). Our naive disk-staging implementation handles the happy path; the retry path needs explicit tests.
5. **Character encoding in paths**: NC WebDAV paths are URL-encoded UTF-8; Sync-in's file layer expects its own encoding. Resolver needs a careful test pass on unicode, spaces, and emoji.

## Success metric

"An iPhone user installs the Nextcloud iOS app from the App Store, types in the Sync-in URL, logs in, sees their photos upload automatically, browses their `Personal/` tree, downloads a file, and the maintainer merged the next upstream Sync-in release without touching any file in `custom-mobile-compat/`."

That is the bar.

## Effort estimate

Wave 1: ~1100 LOC + tests — 2–3 sessions.
Wave 2: ~1250 LOC + tests — 2–3 sessions, including one session of live-device testing.
Wave 3: not estimated; deferred.

Total for levels B coverage: ~2400 LOC net-new, all under `backend/src/applications/custom-mobile-compat/`, plus ~15 LOC in `UsersManager` (`mod(users): …`) and one import line in `applications.module.ts` (`mod(applications): …`).

## Open questions for the executor

1. Does Sync-in have a **thumbnail/preview endpoint** today for image files? If yes, where — we delegate. If no, preview route returns 404 in MVP (no blocker; NC clients fall back to full-file downloads for thumbnails, which is ugly but functional).
2. Does `UsersManager` already have a `verifyAppPassword` helper in a form we can adopt as-is, or is it in-lined into the delete/create flow? A quick grep at exec time will decide.
3. Is `configuration.dataDir` (or equivalent) exposed to inject as the chunked-upload staging root, or do we need to add one config knob? If the latter, that's another `mod(configuration): …` edit.
4. Does the existing Basic Auth strategy already accept app-passwords (by trying them after the main password), or only the main password? If already both, consider whether the NC guard should just *scope* the existing strategy rather than duplicate it. Answer affects ~50 LOC.
5. For the browser-side login page at `GET /login/v2/flow/{token}`, do we serve from the fastify adapter directly (a route handler that returns an HTML string) or provision a static file? Fastify is already handling this backend so direct return is simpler, but theming by an operator would then need a config-driven template. MVP: hardcode, log as follow-up.

## Sources

- [AtalayaLabs/OxiCloud — `src/interfaces/nextcloud/routes.rs`](https://github.com/AtalayaLabs/OxiCloud/blob/main/src/interfaces/nextcloud/routes.rs) — reference route list
- [Nextcloud Login Flow v2](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html)
- [Nextcloud OCS API overview](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html)
- [Nextcloud WebDAV basics](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/basic.html)

---

## Q&A log — design decisions

| # | Decision | Options | Picked | Rationale |
|---|---|---|---|---|
| 1 | Scope level | A (browse-only) / B (full sync) / C (B + sharing) / D (everything) | **B** | A is too shallow (no Auto Upload = no reason to install the app); D has poor ROI without Sync-in-side notification/activity models. |
| 2 | Auth model | A (app-pw + main-pw both) / B (app-pw only, scoped guard) / C (parallel NC-token store) | **B** | Matches NC/OxiCloud security posture; reuses Sync-in's existing app-password store + settings UI from phase 4.13; no duplicate schemas. |
| 3 | Root mapping | A (personal-only) / B (synthetic merged root) / C (A now, per-user config hook) | **C** | Ship the 90% case; leave a clean door open for power users without committing to synthetic-root PROPFIND complexity. |
