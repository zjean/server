# Local development setup

Runs MariaDB in Docker on host port **3307** (to avoid colliding with any
system MariaDB/MySQL), while the backend and frontend run directly on the host
for fast hot reload.

## One-time setup

```bash
npm ci                                                           # install all workspaces
cp environment/environment.dev.dist.yaml environment/environment.yaml
npm run dev:db                                                   # start mariadb, waits for healthcheck
npm run dev:migrate                                              # create schema
npm run dev:seed                                                 # seed admin + sample users/groups
```

> The backend config loader always reads `environment/environment.yaml` (which is
> gitignored). The committed `environment.dev.dist.yaml` is a template: copy once,
> edit if your ports/creds differ.

After seeding, log in with `sync-in` / `password`. The seed also inserts 10 faker
users (all `password`) and 5 random groups. Re-running the seed fails on the
duplicate `sync-in` login — use `npm run dev:db:reset && npm run dev:migrate && npm run dev:seed` for a clean slate.

## Daily workflow

Open two terminals from the repo root:

```bash
# terminal 1 — backend with --watch (rebuild + restart on save)
npm run dev:backend

# terminal 2 — frontend with ng serve (HMR + proxy to backend)
npm run dev:frontend
```

- Backend: `http://localhost:8080`
- Frontend dev server: `http://localhost:4200`
- `ng serve` proxies `/api/*` and `/socket.io` to the backend; open the UI at
  `http://localhost:4200`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:db` | Start MariaDB container, wait for healthcheck |
| `npm run dev:db:down` | Stop and remove the MariaDB container (keeps the volume) |
| `npm run dev:db:reset` | Drop the DB volume and re-create it — wipes all dev data |
| `npm run dev:migrate` | Run drizzle migrations against the dev DB |
| `npm run dev:seed` | Seed admin (`sync-in` / `password`) + 10 faker users + 5 groups |
| `npm run dev:backend` | NestJS in `--watch` mode |
| `npm run dev:frontend` | `ng serve` with `proxy.conf.json` |

## Dev DB access

| | |
|---|---|
| Host | `localhost` |
| Port | `3307` |
| DB | `sync_in` |
| User | `sync_in` / `dev` |
| Root | `root` / `dev_root` |

```bash
docker exec -it sync-in-dev-mariadb mariadb -usync_in -pdev sync_in
```

## Editors (OnlyOffice / Collabora)

`environment.dev.dist.yaml` ships with **OnlyOffice enabled and Collabora
disabled**, under the current `applications.files.editors.*` keys (the flat
`applications.files.onlyoffice` form still works but logs a deprecation warning
on every boot).

**OnlyOffice is on even though no document server runs locally**, and the reason
is structural rather than convenience: `FilesModule` imports `OnlyOfficeModule`
*conditionally at module-definition time*, so with the flag off
`app.get(OnlyOfficeManager)` throws — and the versioning e2e case for the editor
write path (E2E-11) cannot resolve the service at all. That case signs its own
callback JWT with `secret` and serves the "saved" document from a throwaway local
HTTP server, which is allowed because host validation only applies when
`externalServer` is set.

So: leave it enabled unless you have a reason not to. Turning it off does not
break the app, but it silently skips E2E-11's suite. Actually editing documents
needs a reachable document server in `externalServer` (or the Docker Compose
Nginx service).

## Troubleshooting

- **Backend can't reach DB** — confirm `npm run dev:db` reported `Healthy`, and
  that `environment/environment.yaml` points at `mysql://…@localhost:3307/…`.
- **Frontend calls 404** — check `frontend/proxy.conf.json` maps `/api` and
  `/socket.io` at your backend port (default 8080).
- **Port 3307 in use** — edit `docker/docker-compose.dev.yaml` and
  `environment/environment.yaml` in lockstep.
- **Schema drift after upstream sync** — `npm run dev:migrate` picks up any
  new migrations; `npm run dev:db:reset` for a clean slate.
- **`Nest can't resolve OnlyOfficeManager` in a test** — `applications.files
  .editors.onlyoffice.enabled` is false. See the Editors section above; the module
  is imported conditionally, so the flag is a hard prerequisite, not a preference.
- **e2e specs 403 with "You are not allowed to access to this repository"** — a
  test user was created with the derived `applications` array instead of the
  `permissions` column. See
  `backend/src/applications/custom-versioning/utils/versions-e2e.fixture.ts`,
  which documents this and three other e2e environment facts.
