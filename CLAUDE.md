# Claude operating notes for this repo

This is a fork of [`Sync-in/server`](https://github.com/Sync-in/server), maintained under `zjean/server`. Full workflow details live in [`docs/plans/2026-04-22-fork-maintenance-design.md`](docs/plans/2026-04-22-fork-maintenance-design.md). This file is the short, load-bearing version.

## Branch protection

`main` and `upstream-main` are both protected:

- **`main`** — direct pushes are blocked. All changes (including docs, CI config, trivial fixes) must go through a pull request. The `test` status check must pass and any PR conversations must be resolved before merge.
- **`upstream-main`** — a pure mirror of `upstream/main`. Only the `upstream-sync.yml` workflow should write to it (force-push allowed; human pushes blocked by PR-equivalent requirement).

### Practical implications

- Never attempt `git push origin main` directly. It will be rejected.
- Every change, even a one-line doc fix, flows: feature branch → push → open PR → wait for `test` green → merge.
- Feature branches are auto-deleted on merge (`delete_branch_on_merge: true`).

## Branch naming and commit conventions

| Purpose | Branch prefix | Commit prefix |
|---|---|---|
| New customization (feature, module, config) | `feat/<topic>` | `feat(<area>): ...` or `custom(<area>): ...` |
| Bug fix in our code | `fix/<topic>` | `fix(<area>): ...` |
| Edit to an upstream file (theming, behavior tweak) | `mod/<topic>` | `mod(<area>): ...` |
| Docs / plans / CI-only changes | `docs/<topic>` or `chore/<topic>` | `docs(...)` / `chore(...)` |
| Work intended to be PR'd upstream | `upstream-contrib/<topic>` | conventional commits, **no `custom-` paths, no fork-flavored language** — must cherry-pick cleanly onto upstream |

**Upstream-contrib branches must be rooted at `upstream/main`, not `main`.** Example:

```bash
git fetch upstream
git checkout -b upstream-contrib/fix-foo upstream/main
```

### Customization isolation

- **Additions** live under `custom-*` paths (e.g. `backend/src/applications/custom-auth`, `frontend/src/app/applications/custom-dashboard`, `_custom-overrides.scss`). Upstream never touches these — zero merge conflicts.
- **i18n** keys added by this fork live in `frontend/src/i18n/custom/{en,nl}.json` — a separate angular-l10n provider registered alongside the upstream `app` provider. Keys are merged at lookup time, so callers don't need to know which bundle a key lives in. Naming convention: `v2_*` prefix for parameterised keys (with `{{ placeholders }}`); plain English literals as keys for short static strings (matches upstream's identity-mapping pattern). Upstream's `frontend/src/i18n/{en,nl,...}.json` files should never be edited to add fork-specific keys — that puts them on the merge-conflict surface during upstream syncs. Currently only `en` + `nl` ship custom translations; other languages fall through to the missing-translation handler (which returns the key literal) for fork-specific strings, preserving the pre-existing behaviour. Note: v2 toasts route through `ToastService`, which auto-translates the message and (optionally) interpolates placeholder args — call as `this.toast.success('Group updated')` or `this.toast.success('v2_renamed_to', { name })`.
- **In-place modifications** to upstream files stay small and atomic, with a `mod(<area>): ...` commit message so they're greppable (`git log --grep '^mod('`).

## Merge strategy per PR type

The repo has Squash and Merge-commit both enabled; Rebase is disabled. Pick per PR:

- **Feature / fix / mod / docs / chore PRs → Squash and merge.** Keeps `main`'s history clean; one commit per logical change.
- **Upstream sync PRs (`upstream-main` → `main`) → Create a merge commit.** Preserves the merge point so upstream history stays legible; full upstream history remains available on the `upstream-main` branch regardless.

GitHub remembers the user's last-used strategy; double-check the dropdown on upstream-sync PRs.

## Versioning and releases

- Version scheme: `<upstream-base>-custom.<n>` — e.g. `2.2.1-custom.1`, `2.2.1-custom.2`, then reset on upstream bump to `2.2.2-custom.1`.
- `package.json` `version` field holds the current value (root + backend + frontend all align).
- Releases are cut by tagging `v<version>` on `main`. The tag fires `release.yml` (archives + draft GitHub Release) and `build-image.yml` (versioned image).
- Image: `ghcr.io/zjean/sync-in-server`. Tags published automatically:
  - Every push to `main` → `:main`, `:sha-<short>`
  - Every `v*.*.*` tag → `:<version>`, `:<major>.<minor>`, `:latest`
  - No DockerHub, no npm publish.

## SSH host alias

Both remotes use the `github-prive` SSH host alias, **not** `github.com`. The alias is defined in `~/.ssh/config` and maps to `github.com` with the maintainer's fork-specific key. Always use `git@github-prive:<org>/<repo>.git` in any remote URL you write — never `git@github.com:...`. Symptoms when you get this wrong:

- `gh pr create` works fine (it's HTTPS-based), but `git push` fails with "Permission denied (publickey)".
- Cloning a fresh copy with `git@github.com:...` authenticates with the wrong identity and may push to the wrong account.

Quick self-check: `git remote -v` should show `git@github-prive:...` for both `origin` and `upstream`. If not, fix with `git remote set-url`.

## Upstream remote and license

- Remote `upstream` → `git@github-prive:Sync-in/server.git` (push intentionally disabled via `DISABLE` push URL).
- Upstream sync is automated: `upstream-sync.yml` runs weekly + on `workflow_dispatch`, force-pushes `upstream/main` → `origin/upstream-main`, and opens a PR into `main` when there's new upstream work.
- License is **AGPL-3.0-or-later**. Preserve the `LICENSE` file, keep `"license": "AGPL-3.0-or-later"` in every `package.json`, and never strip upstream copyright headers. If this server is deployed for anyone but the maintainer, a user-visible "Source: github.com/zjean/server" link must appear in the UI (§13 network clause).

## Opening pull requests

**PRs must always target `zjean/server` (the fork), never `Sync-in/server` (upstream).** The `upstream` remote is fetched for sync only — it must never receive PRs from this fork.

`gh pr create` picks the target repo from its "default repo" setting, which — in a clone with an `upstream` remote — can silently resolve to `Sync-in/server`. The belt-and-suspenders fix:

1. **Per clone, set the default once:**
   ```bash
   gh repo set-default zjean/server
   ```
   Verify with `gh repo set-default --view` → should print `zjean/server`.

2. **Every `gh pr create` invocation passes `--repo zjean/server` explicitly**, even when the default is set — the flag costs nothing and is the authoritative override if the default ever drifts:
   ```bash
   gh pr create --repo zjean/server --base main --head <branch> --title "..." --body "..."
   ```

**If a PR accidentally opens against upstream:** close it immediately with `gh pr close <n> --repo Sync-in/server --comment "wrong repo"`, then reopen against the fork with `--repo zjean/server`. Do not leave an open PR against `Sync-in/server` — it looks like a contribution attempt and pollutes their queue.

The only PRs that ever belong on `Sync-in/server` are branches with the `upstream-contrib/` prefix, and those are handled as a separate, deliberate workflow (root the branch at `upstream/main`, no `custom-*` paths, no fork-flavored language).

## Verifying existing functionality: always use the classic UI as ground truth

The `/v2` app is a reimplementation of features that already ship in the **classic UI** (the Angular screens under `frontend/src/app/applications/<feature>/` — shares, links, files, users, spaces, etc.). The classic code is the authoritative reference for how backend APIs want to be called.

**Before writing any v2 code that talks to the backend, read the classic implementation first.** Specifically:

- Which endpoint does classic hit? (URL + method)
- What DTO shape does it send?
- What sentinel values mean "new" vs "existing" (e.g. `id: -1` for new link, not `0`)? How does classic distinguish?
- What side effects or sequences does classic perform (optimistic UI, refresh, toast, etc.)?

These details aren't guessable from the DTO types — the backend has runtime contracts baked into value conventions (e.g. `shares-manager.service.ts:581` treats `link.id < 0` as "new link" and anything else as update-by-id, which 404s for unknown ids). Every time v2 has diverged from classic on one of these details, it's been a user-facing bug.

**When debugging a v2 feature that doesn't work:**

1. Find the classic screen that does the same thing (grep under `frontend/src/app/applications/` ignoring `custom-v2/`).
2. Compare the classic service call to the v2 one — URL, DTO, sentinel ids, field presence.
3. Diff the classic's network request against the failing v2 one if you have DevTools open.

**When implementing a new v2 feature that mirrors an existing classic one:** open the classic component and service side-by-side while writing the v2 version. Do not trust the DTO types alone.

### Frontend tests exist now — a little

`frontend/vitest.config.mts` + `frontend/src/test-setup.ts` were stood up by #346, and CI runs them as part of the
`test` workflow. Coverage is **two components** (the file browsers); roughly sixty others are still bare (#347).

The setup is deliberately cheap and worth copying: `environment: node` (v2 components are SSR-guarded), no TestBed and
no platform — a plain `Injector` + `runInInjectionContext`, with the two internal tokens `effect()` needs stubbed
(`frontend/src/testing/browser-lib-stub.ts`). No new dependencies; vitest is hoisted from the backend.

**The two file-browser screens are one component now.** `personal.component.ts` and `space-files.component.ts` were
~2,800 duplicated lines that had to be edited in lockstep; since #346 they are ~120 lines each, and everything real
lives in `custom-v2/screens/files/` — `file-browser.base.ts` (an abstract `@Directive()`), one template, one
stylesheet, and `file-browser-repository.ts`. The two screens differ in exactly 16 things — where files come from and
how a file is addressed on the wire — and those 16 are the repository interface. **Add screen-specific behaviour to
the repository, not to the base with an `if`.** `viewModeStorageKey()` is the one exception and stays a component
method: the base's `mode` signal initialises before the subclass field holding the repository exists.

## NC mobile compat: always read upstream NC source first

The `custom-mobile-compat` module emulates a Nextcloud server for NC's stock iOS/Android clients. Its endpoints are pinned to upstream contracts that **cannot be guessed from server-side conventions** — especially the wire format, field types, and capability gates. Real precedents: an early recommendations PR shipped JSON instead of XML and used a wrong endpoint path; the carousel rendered empty until the next PR fixed both. Both mistakes would have been avoided by reading the upstream source first.

**Before designing any new NC compat endpoint or "this isn't lighting up in iOS" debug, fetch the relevant upstream source — don't infer from REST conventions.** Authoritative repos:

- [`nextcloud/server`](https://github.com/nextcloud/server) — core OCS endpoints, capabilities, DAV. Look in `apps/<app>/lib/Controller/`, `apps/<app>/lib/Capabilities.php`, `apps/<app>/appinfo/routes.php`.
- [`nextcloud/recommendations`](https://github.com/nextcloud/recommendations) — separate app, not in core. Recommendations carousel + capability live here.
- [`nextcloud/notifications`](https://github.com/nextcloud/notifications) — separate app.
- [`nextcloud/activity`](https://github.com/nextcloud/activity) — separate app.
- [`nextcloud/NextcloudKit`](https://github.com/nextcloud/NextcloudKit) — the Swift networking library both iOS and macOS clients use. **The wire format authority for iOS.** `Sources/NextcloudKit/NextcloudKit+<Feature>.swift` shows the exact endpoint path, `Accept` header, and HTTP method; `Sources/NextcloudKit/Models/NK<Feature>.swift` shows the parser (XML vs JSON, field names, type coercions like `text == "1"`).
- [`nextcloud/ios`](https://github.com/nextcloud/ios) — the iOS app. `iOSClient/Networking/NCNetworking+<Feature>.swift` shows when/how the call is made (gating, refresh cadence, home-server checks). `iOSClient/Main/.../<Feature>Cell.swift` for UI gating.
- [Nextcloud Developer Manual — OCS APIs](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/index.html) — high-level overview; useful for endpoint discovery, but always cross-check the source for response shape.

**Investigation recipe** (use `gh api repos/<org>/<repo>/contents/<path>` — `gh` is fastest, no rate limit on small files):

1. Find the OCS route — `appinfo/routes.php` in the relevant `nextcloud/<app>` repo.
2. Find the controller body — what JSON keys does the PHP emit? Look at `lib/Controller/*.php` and any `ResponseDefinitions.php`.
3. Find the iOS network call — `gh api search/code -f q='repo:nextcloud/NextcloudKit <Feature>'` to locate `NextcloudKit+<Feature>.swift`. Confirm the `Accept` header (XML vs JSON), endpoint string, and method.
4. Find the iOS parser — `Models/NK<Feature>.swift`. Note exact field names, types, and any text-vs-int quirks (`hasPreview` is `text == "1"`, not a JSON boolean; `id` is often `String` even when the server sends an int).
5. Find the iOS gating — `iOSClient/Networking/NCNetworking+<Feature>.swift`. Note any capability-flag checks, server-version checks, or scope gates (e.g., "only at home server").
6. Find the capability advertisement — `lib/Capabilities.php` in the upstream app. If iOS gates on it, our `custom-mobile-compat/constants/capabilities.ts` must mirror the shape.

**Sync-in storage quirks to translate** when emitting to NC clients:

- Mime: stored as `image-jpeg` (first `/` replaced by `-`); NC clients want `image/jpeg`.
- Mtime: stored in **milliseconds**; most NC fields want **seconds** — divide by 1000.
- File ids: emit real DB ids (PR #126); negative ids confuse NC clients.
- ETag: use **strong** ETags; `W/` prefix breaks iOS thumbnail paths (PR #140 / commit `00c3fa7`).

**All XML this module emits goes through `custom-mobile-compat/utils/nc-xml.ts`** (#343/#345). It owns the one
`XMLBuilder` config, the namespace map, `renderMultistatus()`, and the one escape function — replacing seven
copy-pasted builder configs, five disagreeing namespace constants, eight hand-rolled multistatus renderers and three
divergent escape helpers. Do not add an eighth builder; extend that file. Upstream's `webdav/utils/xml.ts` is
**deliberately excluded** — it serves Sync-in's own WebDAV surface with an uppercase `D:` prefix that NC clients don't
parse, and folding the two would put this module's wire format on the merge-conflict surface.

Two facts settled while consolidating, both the opposite of what the code previously claimed:

- **Namespace arity is per-body, not fixed.** A real NC 207 does carry four declarations, but the fourth is
  `xmlns:s="http://sabredav.org/ns"` — declared on every response and used on none, because sabre's writer dumps its
  whole `namespaceMap` on the first element. The rule is "declare every prefix the body uses, nothing more." An old
  comment claiming NC clients expect four namespaces on *every* `<d:multistatus>` was wrong.
- **Prefix SPELLINGS are the wire contract.** iOS parses namespace-*blind* (literal prefixed strings; SWXMLHash with
  `shouldProcessNamespaces = false` — it cannot see declarations at all), Android namespace-*aware*. So
  `xmlns:D="DAV:"` with `D:multistatus` is valid XML, fine for Android, and silently breaks iOS completely. Never
  rename a prefix; `nc-xml.spec.ts` pins the spellings.

The classic-UI-as-ground-truth rule above governs Sync-in's internal v2 work. **NC-source-as-ground-truth governs `custom-mobile-compat`.** They're independent — both apply when their domains intersect.

## Database migrations

Migrations are managed by Drizzle Kit. **Never create migration files manually.** Always generate them with the tooling:

```bash
npm run -w backend db:generate   # generates a new SQL migration + updates meta/_journal.json
npm run -w backend db:migrate    # applies pending migrations to the database
```

Creating the SQL file without running `db:generate` leaves `meta/_journal.json` out of sync. `drizzle-kit migrate` reads the journal to decide what to apply — a file not listed there is silently skipped, the table never gets created, and runtime inserts fail with an opaque "Failed query" error.

## File versioning (`custom-versioning`)

Shipped behind `files.versions.enabled`, **default off**. Phases A–D are complete: backend, the `custom-v2` UI
(browser-verified), and the Nextcloud file-versions DAV tree. **Phase E is 19 of its 20 e2e cases in.** The ADR §19 soak
(#348) is done for **both editors** against real containers and for **NC Android**; only **NC iOS** is unrun. Two things
that soak settled and you should not re-derive: OnlyOffice has no automatic save of any kind (so every version it mints
is a human pressing Save), while Collabora saves unprompted ~15 s after the last keystroke. And **versioning cannot be
configured by `SYNCIN_*` environment variable at all** — `applications.files.versions` is absent from
`environment.dist.yaml`, which is the schema those names are validated against, so every such var is silently discarded.

**There is an operator surface as of #342** — `VersionsAdminController` (`custom-versioning/versions-admin.controller.ts`)
plus a panel on the v2 admin Tools screen: instance-wide usage, heaviest roots, and a per-root purge. Two things about
it are load-bearing. It is a **separate controller** from `VersioningController` because its routes address the whole
store rather than a file, so `SpaceGuard` has nothing to resolve and must not be in the chain; authorization is
class-level `@UserHaveRole(ADMINISTRATOR)` + `UserRolesGuard` instead, at class level deliberately so a route added
later inherits it rather than shipping unauthenticated. And the purge **must** keep routing through
`VersionsRetention.purgeRoot` → `dropAll` → `dropVersionForRetention`, the same path the nightly rules use — that is
what makes the labeled-version exemption, the per-`(checksum, versionsRoot)` refcount and the ADR §7 audit line apply
without restating any of them. A bespoke delete here would silently drop all three.

**e2e:** `npm -w backend run test:e2e`, after `npm run dev:db` + `npm run dev:migrate`. Read
`custom-versioning/utils/versions-e2e.fixture.ts` before adding a case — a test user needs the `permissions` column
(not the derived `applications` array) or every request 403s, and writes need the `sync-in-csrf` header as well as the
cookie.

**e2e files run in PARALLEL worker threads against ONE database.** `vitest-e2e.config.mts` sets no
`fileParallelism: false`, and seven `custom-versioning` spec files create versions through the API at once. So any
assertion about an **instance-wide** figure is racing its neighbours: comparing `usageTotals()` against a single
`SELECT *` snapshot failed as `expected 829 to be 808`, the 21 bytes being another file's row landing between the two
reads (#366). Scope new assertions to a root the case owns, or bracket the aggregate between a snapshot taken before
and after it — a bracket collapses to exact equality when the file runs alone, so nothing is weakened.

**Read the handoff for whatever phase you're touching before touching it.** Six documents describe this feature and
they do not all agree:

| Document | Status |
|---|---|
| `2026-07-28-onlyoffice-version-history-handoff.md` | **Not started, and phase 1 is not approved.** The task list for putting a version panel inside the office editor, the document-server dev recipe, and the nine traps. Read with the design doc, which it corrects in one place. |
| `2026-07-28-onlyoffice-version-history-design.md` | Why the OnlyOffice / Euro-Office editor shows neither versions nor diffs today, and what it would take, in two phases, against upstream ONLYOFFICE's own connector. §5 holds decisions the maintainer has not taken. |
| `2026-07-29-adr-19-editor-soak.md` | The editor half of the ADR §19 soak, against real OnlyOffice and Collabora containers: the measured cadences, #378 verified live, and two defects it found (versioning is unconfigurable by env var; the old soak recipe no longer opens the coalescing window). |
| `2026-07-27-nc-android-versioning-soak.md` | The real-device soak: versioning confirmed working in stock NC Android 34.1.0, the capability bug it found, and how to reproduce (incl. the 16 KB page-size emulator crash). |
| `2026-07-27-file-versioning-phase-e-notes.md` | The e2e suite: what the 19 cases cover, the four environment facts the harness encodes, the one case still owed. |
| `2026-07-27-file-versioning-phase-d-findings.md` | **Entry point.** What Phase D verified, what it found that was untrue, and §5's short list of what is left — including two decisions that need the maintainer. |
| `2026-07-27-file-versioning-phase-d-handoff.md` | Still authoritative on the **dev-stack recipe** and the four lessons. Its per-task §3 is superseded, and two of its D2 instructions are wrong (the findings say where). |
| `2026-07-27-file-versioning-handoff.md` | The Phase A/B record: five design corrections and why. Still current on those. |
| `2026-07-25-file-versioning-design.md` | **The authority** on design. Corrected three times during implementation. |
| `2026-07-25-file-versioning-implementation-plan.md` | Task list. Accurate for Phase E; its Phase-A/B bodies contain **superseded designs that destroy data if implemented as written** — marked inline. |

Where the plan and the ADR disagree, the ADR is right.

**Emitting an NC capability block? Emit EVERY key its consumers dereference.** NC Android reads
`user_status.supports_emoji` with `getBoolean()` and no `has()` guard, and the resulting `JSONException` is caught at the
top of `parseResponse` — so one missing key makes the client discard the WHOLE capability object and persist nothing.
Every capability-gated feature then reads back `UNKNOWN`, and the symptom surfaces in an unrelated feature (it was the
file-detail version list). A partially-specified block is worse than an absent one. See the soak doc.

**Two error-shape traps in this area, both of which produced 500s in shipped code:** `FileError` and `LockConflict`
extend `Error`, not `HttpException` — a controller that lets one escape returns 500, so it needs a translation layer
(`custom-versioning/filters/versioning-exception.filter.ts`, or `files-methods.service.ts::handleError` in the files
feature). And `filesLockManager.create` treats the **caller's own** lock as a conflict; use `createOrRefresh` for any
path that writes a file the user may have open.

Seven invariants worth knowing before you edit anything in this area, each learned from a bug that reached a green test
suite (the fifth and seventh from reading upstream source rather than from a bug — see below):

1. **Never hardlink a version blob.** It shares the live file's inode, and three of the seven write paths truncate that
   inode in place — the "saved" version would hold the new content. Blobs are cloned or copied (ADR §1.1).
2. **Never replace a live file's inode.** Restores and any live-content replacement go through `copyFileContent`;
   trash retention keys on inodes (ADR §9). This is the same fact as (1), read from the other end.
3. **Anything that reads a blob must pin it open before running code that can evict.** Eviction and reads share no
   lock; a restore that resolved a path first destroyed both the file and the version being restored (ADR §9). It has
   two violation sites, not one: the download path had the same shape (#355), where an eviction between the existence
   check and the deferred open faulted a stream already committed to a response — a truncated body instead of the 404
   the check existed to produce. `fs.open` REPLACES such a check; it never supplements it.
4. **Version rows key on `files.id`, never on path**, and `files` rows are lazily materialized — use
   `custom-shared`'s `FileRowEnsurer` (ADR §3).
5. **On the NC versions DAV tree, a version's node name is its `mtime` in unix SECONDS — never the row id — and it must
   agree with `d:getlastmodified`.** NC Android never reads the href: it derives the restore MOVE source from the parsed
   `getlastmodified`, so a disagreement makes every restore target a revision that does not exist, silently. Two other
   NC facts in the same family: the collection's own entry must be `response[0]` (Android discards it and would
   otherwise lose the oldest version), and `d:resourcetype` must be an EMPTY element (any value makes Android treat the
   version as a directory). All three are in `utils/nc-version-xml.ts` with their upstream citations.
6. **A pinned descriptor has an owner, and handing one to a caller makes the caller responsible for it.** The corollary
   of (3): `getVersionStream` returns an OPEN fd, so anything that takes a stream must consume it or `destroy()` it.
   Acquiring one and then throwing leaks a descriptor — the diff endpoint's 415 did exactly that until the mime check
   moved above the acquisition (#355). When adding a call site, check the throw paths, not just the happy path.
   Two Node specifics here were measured, and both invert the intuitive answer, so don't re-reason them from scratch:
   `autoClose` (default `true`) closes the handle *through* `FileHandle.close()` rather than closing the raw fd behind
   the wrapper's back, so ownership can simply travel with the stream — `restoreVersion` uses `autoClose: false` only
   because it keeps the handle for its own `try/finally`. And with `autoClose: false` a fully-consumed stream emits
   `end` but never `close`, so a `close`-only cleanup handler leaks on the *successful* path.
   Watch for `DEP0137` ('Closing a FileHandle object on garbage collection') in test output: it is GC-timing dependent,
   so it surfaces only in the full suite and names no source line. It means someone dropped a stream.
7. **A restore must drop the cached OnlyOffice document key.** That key names ONE content state, and
   `OnlyOfficeManager.getDocumentKey` returns the cached value whenever there is one — its only invalidation runs on
   callback statuses 2 and 4. So replacing the live bytes without deleting the entry lets the editor re-open under a key
   the document server already knows: it serves ITS copy, the user sees pre-restore content, and the next save writes it
   back over the restore. `restoreVersion` calls `invalidateOfficeDocumentKey`; the key format has one home in
   `custom-shared/utils/only-office-doc-key.ts`. Upstream ONLYOFFICE does the same from the same event
   (`lib/Listeners/FileVersionsListener.php::versionRestored` → `deleteKeyForFile`). Collabora needs no equivalent: it
   recomputes `Version:` on every CheckFileInfo instead of caching. Do NOT move this into the shared snapshot hook to
   cover all seven write paths — that hook also runs on the editors' own saves, and dropping the key mid-session splits
   the co-editing session and leaves `NcOnlyOfficeForceSaveService` with no key to force-save.

Any new code path that overwrites live file content needs a snapshot hook and a test before merge. The seven existing
entry points are tabulated in the plan's §7.9; grep for new `writeFromStream` / `copyFileContent` /
`moveFiles(..., true)` / `createEmptyFile` call sites on every upstream sync.

## Tooling note: `rtk` wrapper

The user runs git/gh via the `rtk` proxy (token savings). A few commands don't pass through cleanly and need `rtk proxy` to bypass:

- `git commit --allow-empty` — rtk's git wrapper rejects `--allow-empty`.
- `gh api` calls that return JSON — rtk may reshape the output to a schema stub; use `rtk proxy gh api ...` when you need the real response.

Normal `git status`, `git diff`, `gh pr create`, `gh run list`, etc. work unmodified.
