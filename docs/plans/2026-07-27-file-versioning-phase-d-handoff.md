# File Versioning — Phase D handoff

- **Date:** 2026-07-27
- **Audience:** a fresh session with no memory of Phases A–C
- **Status:** **Phase D is now complete and merged** (#324, #325, #326). Phase E is not started. Feature flag still **off** by default.

> **Read [`2026-07-27-file-versioning-phase-d-findings.md`](2026-07-27-file-versioning-phase-d-findings.md) instead of §3 of this file.** That document is Phase D's deliverable: what was asserted, where each assertion lives, what turned out to be untrue, and what is left. This file remains accurate and useful for the **dev-stack recipe (§2)**, the **four lessons (§4)** and the **repo mechanics (§6)**. Its §3 per-task requirements are superseded, and **two of them were wrong** — see the findings' D2.0 (the capability key) and D2.3 (`FileRowEnsurer`).

Phase D is integration work: proving the feature behaves under WebDAV, the Nextcloud mobile clients, and desktop sync, and measuring the editor coalescing window. Three of the four tasks are verification rather than new code.

## 0. Read these, in this order

| # | Document | Why |
|---|---|---|
| 1 | This file | Where things stand, the dev stack, what each D task actually requires |
| 2 | [`2026-07-27-file-versioning-handoff.md`](2026-07-27-file-versioning-handoff.md) | Phase A/B state and the five design corrections made during implementation |
| 3 | [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) | **The ADR — the authority on design.** Where it and the plan disagree, the ADR wins |
| 4 | [`2026-07-25-file-versioning-implementation-plan.md`](2026-07-25-file-versioning-implementation-plan.md) | Task list. Accurate for D and E; its Phase-A/B bodies contain superseded designs, marked inline |

Also read the **File versioning** section of `CLAUDE.md` for the five invariants. They are short, and each one exists because a bug reached a green test suite — except the fifth, which exists because reading upstream Nextcloud stopped one.

## 1. What is merged

| PR | What |
|---|---|
| #310–#317 | Phase A + B: schema, `VersioningService`, the seven write-path hooks, REST API, retention scheduler, blob GC |
| #320 | Phase C1: the `custom-v2` service and typed models |
| #321 | Phase C2: the version-history UI — a Versions tab in the file-detail inspector |
| #322 | Fixes found by browser-verifying C2 — see §4, they matter to you |
| #324 | **D1** — the WebDAV/versioning contract, pinned with tests. No production code |
| #325 | **D2** — the Nextcloud file-versions DAV tree + capability. The only Phase D code |
| #326 | **D3/D4** — sync interplay and editor cadence. No production code |

`main` after #326: **147 test files, 2124 backend tests passing**, `nest build` clean, backend lint clean.

The feature is **verified working end to end in a browser** as of #322: list, name, compare, restore and delete all round-trip; restore preserves the inode and creates its own `restore`-origin version of the bytes it replaced.

**Nothing is user-visible until `files.versions.enabled` is turned on.** It defaults to false, is checked inside `VersioningService`, and every REST endpoint 404s while it is off — which is also how the UI decides whether to show its tab.

### The seven snapshot hook sites, as they exist on `main`

Grep these on every upstream sync; a new destructive write path without a hook silently loses history.

| Site | Origin |
|---|---|
| `files/services/files-manager.service.ts:189` | `web` / `webdav` / `sync` (saveStream, first branch) |
| `files/services/files-manager.service.ts:208` | same (saveStream, second branch) |
| `files/services/files-manager.service.ts:346` | `web` / `web-patch` (saveMultipart, PUT **and** PATCH) |
| `files/services/files-manager.service.ts:422` | `sync-make` (`mkFile(overwrite=true)`) |
| `files/editors/collabora-online/collabora-online-manager.service.ts:142` | `collabora` |
| `files/editors/only-office/only-office-manager.service.ts:414` | `onlyoffice` |
| `custom-mobile-compat/controllers/nc-uploads.controller.ts:219` | `nc-chunked` |

## 2. The dev stack — verified working on 2026-07-27

Earlier notes claimed browser verification was blocked (no Chrome, `ng serve` binding trouble). **Both are stale.** This recipe works:

```bash
npm run dev:db                 # OrbStack + MariaDB on :3307
npm run dev:migrate            # includes custom_files_versions
npm run -w frontend build      # → dist/static
npm run dev:backend            # :8080 serves the API *and* dist/static
```

**Single origin, no proxy.** The backend's `useStaticAssets` serves the built frontend (`STATIC_PATH` resolves to `dist/static`), and the app uses hash routing, so every route works from `http://localhost:8080`. `frontend/proxy.conf.json` exists for the `ng serve` path — you do not need it. The trade is no HMR: rebuild (~8s) after a frontend change.

Login `sync-in` / `password`. v2 lives at `/#/v2/<route>`, e.g. `/#/v2/file?path=files%2Fpersonal%2F<name>`; `localStorage.setItem('ui.version','v2')` makes the toggle stick.

**Turn the feature on** in `environment/environment.yaml` (gitignored, local only) — the shape is documented in `environment/environment.dev.dist.yaml`:

```yaml
applications:
  files:
    versions:
      enabled: true
      minIntervalSeconds: 0   # the 60s default coalesces successive test saves into one version
```

**Generating history.** A version is created only when a file is **overwritten**, so a fresh file shows an empty history. The cheapest generator is WebDAV — the first PUT creates the file (no version), every later PUT makes one:

```bash
curl -u sync-in:password -T v1.txt http://localhost:8080/webdav/personal/demo.txt   # 201, no version
curl -u sync-in:password -T v2.txt http://localhost:8080/webdav/personal/demo.txt   # 204, version #1
```

**Driving the browser.** `agent-browser` is installed and ships its own Chromium — no Google Chrome needed, and the `chrome-devtools` MCP is not usable here. Start with `agent-browser skills get core`. Two things that cost time:

- **Refs from `snapshot` go stale the moment the page changes.** Reading a ref from one snapshot and clicking it after another snapshot opened the *delete* dialog when restore was intended. For anything destructive, click through a scoped `eval` instead: `document.querySelectorAll('.vp-row')[2].querySelector('button[title="Restore this version"]').click()`.
- **Screenshots intermittently fail** with `Resource temporarily unavailable (os error 35)` while `eval` and `get` keep working. Retry after a few seconds. When you only need a measurement, `eval` is more precise than a screenshot anyway — line heights and gaps caught a double-spacing bug that eyeballing a screenshot did not.

**Checking the API directly.** `POST /api/auth/login` with a cookie jar works for reads. **Writes need a CSRF header** (`sync-in-csrf`, from the same-named cookie) which the browser supplies and `curl` does not — so verify write paths through the UI or add the header.

**The quota cache will confuse you.** Version quota ceilings read through a one-day cache (`quota-user-<id>` in the `cache` table). Changing `users.storageQuota` by SQL leaves the ceiling stale — `DELETE FROM cache WHERE \`key\` LIKE 'quota%'` to force a recompute. This is pre-existing behaviour, not a versioning bug, but it makes the usage display look wrong.

## 3. The four Phase D tasks — DONE; superseded by the findings doc

Kept as the record of what was asked. What was actually found, and the two places this section was wrong, are in [`2026-07-27-file-versioning-phase-d-findings.md`](2026-07-27-file-versioning-phase-d-findings.md).

### D1 — WebDAV correctness. Branch `mod/versioning-webdav`. Mostly assertions; no new code expected.

Prove, with tests:

- A **resumed content-range PUT sequence produces exactly ONE version**, containing the full pre-upload content and never a partial. The rule is snapshot at `startRange === 0` only; the hooks are `files-manager.service.ts:189` and `:208`.
- ETag and `getlastmodified` in `webdav/services/webdav-methods.service.ts` derive from the **live file only** — a PROPFIND is unchanged by whether versions exist.
- **Keep ETags strong.** A `W/` prefix breaks NC iOS thumbnail paths; `custom-mobile-compat/utils/nc-prop-builder.ts` strips it, and that must stay.
- The versions directory never appears in a PROPFIND of the space root. This holds only because the blob store is a **sibling** of `files/` and `trash/` — the content indexer has no dotfolder exclusion (ADR §1), so anyone "simplifying" the store back inside the files root breaks it.

Document, do not "fix", the fact that DAV writes hold **no server lock** (ADR §4) — it is why the snapshot has to copy-then-hash rather than hash the live file.

Skip the DeltaV `version-history` REPORT; explicitly out of scope for v1.

### D2 — Nextcloud client compatibility. Branch `feat/versioning-nc-compat`. **The highest-risk task.**

**Mandatory first step, per CLAUDE.md: fetch and read the upstream Nextcloud source before writing any endpoint.** Wire format, property names and capability shape cannot be inferred from server-side conventions. A previous compat feature in this fork shipped JSON where XML was required, against a wrong path, and rendered an empty carousel until the next PR fixed both. Read:

- `nextcloud/server` → `apps/files_versions/` (routes, DAV plugin, `lib/Capabilities.php`)
- `nextcloud/NextcloudKit` → `Sources/NextcloudKit/NextcloudKit+*.swift` for the endpoint, `Accept` header and method; `Models/NK*.swift` for the parser (XML vs JSON, field types)
- `nextcloud/ios` → `iOSClient/Networking/NCNetworking+*.swift` for when the call fires and what gates it

Use `gh api repos/<org>/<repo>/contents/<path>`. The six-step recipe is in CLAUDE.md.

Then implement in `custom-mobile-compat`:

- Advertise `files_versions` in `constants/capabilities.ts` and the OCS capabilities response, **gated on the feature flag** (absent when off). **← WRONG.** `files_versions` is the app id; the capability key is `files.versioning`, plus `files.version_labeling` and `files.version_deletion` (findings D2.0).
- The NC versions DAV surface: `PROPFIND /remote.php/dav/versions/{user}/versions/{fileId}`, `GET` of a version, and `MOVE` to `.../versions/{user}/restore/target` for NC's restore semantics.
- Reuse `VersioningService`. **NC `fileId` maps directly to our `files.id`** under the id-keyed anchor, so reuse `custom-shared`'s `FileRowEnsurer` exactly as `nc-dav` already does — otherwise a version query for a file with no `files` row 404s. **← the ensurer is NOT needed here.** A client can only arrive with a fileId our own PROPFIND minted, and that PROPFIND is where the ensurer already runs; a second call would be dead code (findings D2.3).
- Apply the storage quirks: mime `image-jpeg` → `image/jpeg`, mtime **ms → seconds**, real DB ids (never negative), **strong** ETags.

**Two specific traps for this task:**

1. `FileError` and `LockConflict` extend `Error`, **not** `HttpException`, so any controller that lets one escape returns a 500 (see §4). `nc-dav.controller.ts:147-157` already translates them — follow that, and do not assume a new controller inherits it.
2. `custom-mobile-compat` must **not** depend on `custom-versioning` for anything unconditional. Versioning is flag-off by default while mobile-compat needs `FileRowEnsurer` *always* for correct `oc:fileid` emission — which is why the ensurer lives in `custom-shared` (ADR §12/§13).

Tests: extend the NC controller specs (`nc-propfind.service.spec.ts` shows the fixture style) with capability presence, a list/download/restore round-trip, and permission denial.

### D3 — Desktop sync interplay. Verification only, no code expected.

Prove:

- A restore changes mtime, size and checksum **without changing the inode**, and the sync diff (`sync/services/sync-manager.service.ts`, the `SYNC_DIFF_DONE` flow at `:162`) propagates it as a normal remote update. *The inode half is already empirically confirmed — a restore through the UI left inode `17634938` unchanged — so this is about the sync propagation.*
- A sync upload of an existing file creates exactly **one** version, snapshotted at the final `moveFiles` from tmp, not per ranged request.
- A sync `make` on an existing file (`mkFile(overwrite=true)`, hook at `files-manager.service.ts:422`) creates exactly one version **before** truncation.
- The sync client never sees or syncs the versions directory.

Deliverable: the Phase E cases covering these.

### D4 — Editor coalescing cadence.

Open a document in Collabora, autosave N times in five minutes, expect **one** version (the pre-session content) with the right author, then tune `minIntervalSeconds` from the observed cadence. **OnlyOffice's cadence is already established from source** (statuses 2/3/6/7 only, no autosave — ADR §5): confirm empirically, don't re-derive. Expect coalescing to rarely fire there.

Note both editors are disabled in the dev config (`applications.files.onlyoffice/collabora`), so this task needs them turned on and reachable.

## 4. Four lessons from Phases A–C that will bite you in D

Each cost real debugging time, and #322 is the proof that a green suite is not evidence.

**1. Read the collaborator's real methods; do not infer from a plausible name.** `restoreVersion` locked with `filesLockManager.create`, which treats *any* existing lock as a conflict — **including the caller's own**. The v2 editor locks every file it opens, and that is the same screen offering Restore, so restore failed **100% of the time**. `createOrRefresh` is the method that exists for this case. 1996 tests passed over it.

**2. `FileError` and `LockConflict` are not `HttpException`s.** `FileError` merely *carries* an `httpCode` nobody read. Every domain error from the versions API arrived as a **500** — including 403 permission-denied, 404 version-not-found, and the 409 that drives the named-delete prompt. Fixed with `custom-versioning/filters/versioning-exception.filter.ts`. **Any new controller you add needs the same translation**; the files feature gets it from `files-methods.service.ts::handleError`, which is why nothing there was affected.

**3. A stub that cannot express the interesting case hides it.** The lock stub provided `create` only — a signature that cannot represent "the lock is already yours". Same family as the retention spec whose `db` stub always answered "no quota", so 19 green tests never entered the destructive branch where a data-loss bug lived. **When you stub a gate, make at least one case open it.**

**4. `snapshotBeforeOverwrite` swallows every error by design.** Correct — a failed snapshot must not 500 a working save — but it means a bug *after* the row insert is invisible. A missing method once threw a `TypeError` that 43 green tests never noticed. `versioning.service.spec.ts` spies on `Logger.prototype.error` and asserts happy paths log nothing. **Keep that, and extend it to any new swallowing path.**

## 5. Phase E, after D — now the only phase left

The E2E suite, cases E2E-1..20 in the plan's §5, run with `npm -w backend run test:e2e`. Now unblocked: the dev stack works (§2) and the environment blockers recorded in earlier notes were stale. E2E-1..20 would have caught the restore bug, which makes it a better investment than it looked before #322.

Two corrections to the plan's E list: note E2E-6's trash expectations and the trash-age discussion in the Phase A/B handoff §3.4 — **there is no trash-age rule and there cannot be one**, and the plan's E list predates that.

Phase D added two more, both in the findings' §5: **E2E-3** should assert the resumed-PUT shape D1.1 documents, and **E2E-10** should assert the three NC wire facts from D2.0. Those three NC facts are the ones that silently break a client, and none is visible from a passing unit test of the XML builder alone.

## 6. Repo mechanics that cost time

All in CLAUDE.md; these are the ones actually hit.

- **`main` is protected.** Every change goes feature branch → push → PR → green `test` → squash merge. `gh pr create --repo zjean/server` **always** — without it the PR can silently open against upstream.
- **Remotes use the `github-prive` SSH alias**, and the key must be `ssh-add`ed before any push. `gh` works over HTTPS regardless, which makes the failure look confusing.
- **`npm run build -w backend` before every push.** vitest's type check does not catch service↔real-class type errors; `nest build` does.
- **Lint is a CI gate** and fails on prettier formatting alone: `npm run -w backend lint:fix`, `npm run -w frontend lint:fix`.
- **Migrations only via `npm run -w backend db:generate`.** A hand-written SQL file is silently skipped because `drizzle-kit migrate` reads `meta/_journal.json`.
- **`git add <explicit paths>`.** A `git add docs/` once swept eight untracked screenshots into a docs PR.
- **i18n for new UI strings** goes in `frontend/src/i18n/custom/{en,nl}.json` only — never upstream bundles. `v2_*` prefix for parameterised keys. Keep the two bundles at key parity with identical `{{ placeholder }}` sets; a mismatch there is a known failure mode.
