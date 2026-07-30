# File Versioning — Phase E notes

- **Date:** 2026-07-27
- **Status:** all 20 planned cases are implemented and green (E2E-14's DAV half landed 2026-07-30; §3 records what it
  does and does not assert). The suite has since grown past the plan — the editor history protocol and the admin
  surface both have their own files.
- **Run it:** `npm -w backend run test:e2e` (needs `npm run dev:db` + `npm run dev:migrate` first).

Phase E is the e2e suite from the implementation plan's §5. It matters more than a test count suggests: **every
versioning bug that reached production-shaped code got past a green unit suite**, and each one was invisible for the
same reason — the collaborator that mattered was a stub. A lock stub that offered only `create()` could not express
"the lock is already yours", so 1996 tests passed over a restore that failed 100% of the time. A `db` stub that always
answered "this root has no quota" meant 19 tests passed over a destructive branch that never ran and had data loss in
it. Against a real MariaDB and a real filesystem, those branches run.

---

## 1. The harness, and the four facts it encodes

`backend/src/applications/custom-versioning/utils/versions-e2e.fixture.ts`. Test-only code in `src/`, following
`users/utils/test.ts`. **Read it before adding a case** — it exists mostly to stop the next session rediscovering four
environment facts, each of which presents as a bug in the feature under test:

1. **A test user needs `permissions`, not `applications`.** The column is `users.permissions`, a comma-joined varchar;
   `UserModel` derives its `applications` array from it at construction. `generateUserTest()` sets `applications`,
   which is **not a column** — so a user created straight from it lands with `permissions = ''` and every request 403s.
   `SpaceGuard`'s `canAccessToSpaceUrl` wants `personal_space`; WebDAV wants `webdav_access`. The symptom is
   *"You are not allowed to access to this repository"* on a request that looks perfectly authenticated. (The seed
   script gets this right — `Object.values(USER_PERMISSION).join(',')` — which is where the shape was confirmed.)
2. **Writes need the CSRF header, not just the cookie.** Login sets four cookies; non-safe methods must also echo
   `sync-in-csrf` as a header. A restore without it is a 403, and the suite asserts that so the requirement is
   documented rather than folklore.
3. **The route constants already carry the `/api/app/spaces` prefix.** Adding one yields a 404 that reads as a missing
   route.
4. **`configuration` is a process singleton** shared by every spec in the run. A case that flips `enabled` or
   `minIntervalSeconds` must put it back; the fixture snapshots the versions block and `restoreConfig()` restores it.

**The suite mixes two levels deliberately.** HTTP (`app.inject`) for the versions REST API, because guards, the
`ValidationPipe` and the exception filter are exactly where PR #322's bugs lived and a service-level call would have
missed both. Service-level for *producing* writes, because the seven destructive entry points are reached over five
transports and fabricating each one would test the transport rather than the hook. WebDAV is the exception — it gets
real HTTP requests, because D1's claim is specifically about the DAV request shape.

Three traps the suite hit while being written, all now called out in comments:

- **Blob assertions must be identity-based, not counts.** The store is root-scoped: it holds every file's history for
  the user, so `expect(blobs()).toHaveLength(1)` only passes while its case happens to run first.
- **Test content must be unique per case.** The store is content-addressed and refcounted per (checksum, root), so two
  cases seeding `'v1'` share a blob — and a delete that "should" remove it correctly does not. E2E-9 asserts that
  behaviour on purpose; everywhere else it is a confusing failure.
- **`updateSpace` recomputes the alias from `name` and MOVES the space on disk** when it changes. Passing the alias
  back as the name renames the space out from under every path the test has already built, and the symptom is a 404 on
  a request that worked a moment earlier. Pass the original name verbatim.
- **A spec that imports decorated modules before the fixture needs `import 'reflect-metadata'` first.** Every other
  e2e spec happens to import `@nestjs/platform-fastify` before anything decorated, which loads the shim as a side
  effect; relying on that accident yields `Reflect.getMetadata is not a function` at collection time.

## 2. What is covered

Counts as of 2026-07-30, from a full `--reporter=verbose` run rather than from `it(` greps:
`versions-policy.e2e-spec.ts` (18), `versions-nc-compat.e2e-spec.ts` (17), `versions-write-paths.e2e-spec.ts` (15),
`versions-lifecycle.e2e-spec.ts` (14), `versions-editors.e2e-spec.ts` (14), `versions-editor-history.e2e-spec.ts` (13),
`versions-admin.e2e-spec.ts` (11), `versions-permissions.e2e-spec.ts` (8), `schemas/files-versions.e2e-spec.ts` (6) —
116 of the suite's 157 cases.

| Case | Covers | Notable assertion |
|---|---|---|
| **E2E-1** | upload lifecycle | no version for a create; one per overwrite; each revision's **exact bytes** over HTTP; `attachment` disposition named after the live file; usage rises |
| **E2E-2** | restore | bytes return, **inode preserved**, pre-restore content becomes its own version, restore twice, CSRF required, cross-file version id 404s |
| **E2E-3** | WebDAV | first PUT no version; later PUT one, `webdav`; **a resumed content-range sequence yields exactly ONE version holding the full pre-upload content**; the store never appears in a PROPFIND |
| **E2E-4** | sync `tmpPath` | one version at the final move, `sync` |
| **E2E-5** | NC chunked upload | MKCOL → three chunk PUTs → `MOVE .file`: **one** version tagged `nc-chunked`, not one per chunk; none when the upload lands on a new path |
| **E2E-6** | trash | rows and blobs survive a move to trash, keyed on the stable `files.id` |
| **E2E-7** | permission matrix | a read-only member **can** list/download/diff and **cannot** restore/label/delete (403, not 404 — they can see the file); a non-member cannot reach the endpoints at all; no session is refused before any of it; a member granted MODIFY **can** restore, so the refusal is provably about the permission; a space file's history lives under `space:<alias>` |
| **E2E-8** | retention | `maxVersionsPerFile` prunes oldest-first; `retentionDays` expires; **a named version survives both, and the orphan-blob GC collects debris** |
| **E2E-9** | dedup / refcount | identical content → one blob, two rows; the blob outlives the first delete and goes on the last |
| **E2E-10** | NC versions tree | all three wire facts against a running server; MOVE-restore keeps the inode; a bad MOVE 400s; PROPPATCH labels; DELETE removes a named version; the `files.versioning` capability tracks the flag; the main password is refused |
| **E2E-11** | editor callbacks | a real OnlyOffice callback (self-signed JWT + a throwaway local HTTP document source): the pre-save content versioned as `onlyoffice` with the acting author, **the live file's inode preserved**, the 2/3/6/7-only status set, coalescing inside the editor window holding the PRE-SESSION bytes, and the save still succeeding when the snapshot fails |
| **E2E-12** | quota (ADR §7 rewrite) | usage stays under `quota * quotaShare`; a labeled version is never evicted; no quota → no cap; a dedup hit evicts nothing |
| **E2E-13** | flag off | no versions, no blob-store writes, all seven endpoints 404, history intact when it returns |
| **E2E-14** | concurrency | **re-hashes every stored blob and requires its own name back** — no strict version count, per ADR §4. Both halves: lock-mediated overwrites, and parallel **unlocked** WebDAV PUTs (§3) |
| **E2E-15** | crash safety | an injected row-insert failure still lets the user's save succeed; no row without bytes; no staging debris |
| **E2E-16** | `copyMove` overwrite | no version — trash already holds the destination |
| **E2E-17** | multipart PATCH | `web-patch`, the path a `saveStream`-centric reading misses |
| **E2E-18** | `mkFile` truncate | pre-truncation content versioned as `sync-make` before the file becomes zero bytes |
| **E2E-19** | rename | **the anchor invariant** — same ids, same content, downloadable under the new path |
| **E2E-20** | row ensuring | a row is materialized for a file that has none, and **not duplicated** on the next snapshot |

Plus the label/delete/diff API surface, including the one that shipped broken: **`?confirmLabeled=true` over a real
query string**. Bound to `@Query()` the value arrives as the string `'true'`, and the app pipe does no implicit
conversion, so `@IsBoolean()` rejected it with a 400 and a named version was undeletable. Only a request through the
real pipe catches that.

### Two things the NC cases needed that nothing else did

**An app-password, not the login password.** `NcBasicAuthGuard` accepts only credentials scoped to
`AUTH_SCOPE.MOBILE_NC` and rejects the user's main password on purpose, matching Nextcloud's own posture. The fixture
mints one with `NcAppPasswordService.mintMobileAppPassword` and exposes it as `ncAuth`; a case asserts that the main
password really is refused, so the constraint is pinned rather than tribal.

**Distinct mtimes between generations.** A version is identified on the NC surface by its `mtime` in whole SECONDS —
forced by the client, which derives the restore MOVE source from the parsed `d:getlastmodified` and never from the
href. So two overwrites in the same wall-clock second produce two rows that collapse to **one** NC entry. The helper
spaces each generation's mtime deliberately, and **one case asserts the collapse on purpose** — it is the documented,
accepted cost of that identity, upstream cannot represent two versions in a second either, and the v2 UI (which keys on
the row id) still shows both. Getting this wrong looks like a lost version rather than a protocol limit, which is why it
is written down twice.

### The config change E2E-11 required

`FilesModule` imports `OnlyOfficeModule` **conditionally at module-definition time** (`files.module.ts:28`), so with
`files.editors.onlyoffice.enabled` false, `app.get(OnlyOfficeManager)` throws and the case cannot resolve the service at
all. Enabling it is therefore a prerequisite of the *test*, not a product change — and it is on in
`environment.dev.dist.yaml`, in the e2e workflow, and explained in `docs/dev-setup.md`, each time with that reason next
to the flag. **No document server is needed:** the case signs its own callback JWT with the configured secret and serves
the document from a throwaway `node:http` server, legitimate because host validation only applies when `externalServer`
is set.

Both files also moved from the deprecated flat `applications.files.onlyoffice` key to
`applications.files.editors.onlyoffice`, which silences a deprecation warning that was firing on every boot and in every
e2e run.

Two traps inside that case, both of which produced a silent wrong answer first:

- **`callBack` catches everything and returns `{ error: <message> }`.** A test checking only side effects reports "no
  version was created" for a callback that never ran. The helper asserts the `{ error: 0 }` acknowledgement, which is
  what turned an opaque failure into a one-line diagnosis.
- **The download url's query params are load-bearing.** `saveDocument` reads `filename` to compare the remote extension
  against the local one and to name its temp file, so a url without it dies on `path.extname(null)` — swallowed into
  that same `{ error: … }`.

### One fix this phase forced

`webdav.e2e-spec.ts` authenticated as `Basic am86cGFzc3dvcmQ=` — `jo:password`, **a user nothing creates.** The seed
makes `sync-in` plus faker-random logins, and CI runs migrations without seeding at all. Six of its seven tests were
401ing in every reproducible environment, and the other two passed only because they need no authorization. It now
creates its own user. That was not optional: with those failures the new CI workflow would have been red from its
first run and worth nothing.

## 3. The last case, now in — 20 of 20

**E2E-14's DAV half landed.** The prediction above it was half right and worth keeping as the record: it *is* the same
store invariant as the non-DAV case, and it did have to drop every assertion the design does not make. It was not,
however, hard to stabilise — three parallel `PUT /webdav/personal/<file>` requests reliably produce three versions
(measured, not assumed), and 25 consecutive runs of the file passed.

What the DAV case asserts, and what it deliberately does not:

| | |
|---|---|
| **Asserted** | every blob's name re-hashes from its own bytes; each row's `size` describes those bytes; every row is downloadable; one blob per distinct checksum (dedup survives the race); `.staging` empty afterwards; `origin === 'webdav'`; at least one version, i.e. the hook still fires on the unlocked path |
| **Not asserted** | a version *count* (which writer wins is a race by construction); the **live file's** bytes (three concurrent `flag: 'w'` writes to one inode may interleave, and no lock says otherwise); that each version holds one *complete* prior revision (a snapshot may legitimately capture partial bytes mid-write — that is what best-effort means) |

The one thing it adds over the non-DAV case is where it runs: the unlocked path is exactly where "hash the live file in
a second pass" would break, because the source can change underneath. Hashing the **copy** is what keeps a blob's name
true to its bytes, and a mis-named blob is the one corruption in this design that escapes its own row — every later
snapshot of the genuinely-matching content dedups against it and then serves wrong bytes.

**Collabora is deliberately NOT covered.** OnlyOffice is enabled in dev and CI; Collabora is not. The two share the
snapshot hook and the `copyFileContent` write, so the inode and origin claims are already proven by E2E-11 — what
Collabora would add is its own WOPI request shape, which is transport, not versioning. Its cadence question was settled
from `coolwsd.xml` in D4.2 rather than by measurement — and has since been **measured** against a real container
([`2026-07-29-adr-19-editor-soak.md`](2026-07-29-adr-19-editor-soak.md)), which corrected the number: saves land 15–16 s
after the last keystroke, not the 30 s `coolwsd.xml` implied.

**On E2E-7, one thing worth keeping:** the ADR matrix is asymmetric on purpose — `GET` carries no required
permission, matching the live file, so a read-only member gets the **read** half of history and is refused the write
half. Asserting only the refusals would let a regression that broke *reading* pass unnoticed, so both halves are
there, plus a member granted MODIFY who *can* restore — which is what proves the refusal is about the permission
rather than about something incidental.

**The admin surface has a live case now too** (`versions-admin.e2e-spec.ts`). It is separate from
`versions-admin.controller.spec.ts` on purpose: that spec constructs a `UserRolesGuard` and asks it about a fabricated
principal, which proves the guard's *decision* and not that the decision is in the request path. PR #364 shipped with
only the former, on the one route in this feature that destroys history instance-wide. The e2e drives a real logged-in
non-admin session and asserts both halves — 403, **and** the history it aimed at still standing afterwards, because a
status code alone cannot tell "refused" from "refused after deleting". It also pins that an administrator is still
subject to CSRF on the purge, which is what stops an admin's browser session from being enough for a cross-site POST.

One trap it hit, worth not re-discovering: **`listVersions` is itself gated on `files.versions.enabled`** and answers
`[]` while the flag is off. So the obvious "nothing was purged" read-back in the flag-off case passes for the wrong
reason. That case reads through `VersioningQueries.usageByRoot` instead, which is un-gated.

### What remains open

- The **ADR §19 soak** is done for both editors ([`2026-07-29-adr-19-editor-soak.md`](2026-07-29-adr-19-editor-soak.md))
  and for NC Android ([`2026-07-27-nc-android-versioning-soak.md`](2026-07-27-nc-android-versioning-soak.md)).
  **NC iOS is the one client still unrun** — and the highest-risk item left, since the Android soak's one finding was a
  missing capability key that silently disabled the version list, and iOS parses namespace-*blind*.
- The two release blockers this section used to list as unwritten **are written**: the quota-reduction wording is in
  `CHANGELOG.md` under 2.4.4-custom.1 ("Read before enabling file versioning"), and the per-home `versions/` backup
  requirement is in both that entry and [`docs/backup-and-restore.md`](../backup-and-restore.md).

## 4. CI

`.github/workflows/test-e2e.yml` runs the suite against a MariaDB service container. It is a **separate, advisory
check** — deliberately not part of the `test` check branch protection requires.

The reason to keep it advisory at first is not timidity about the tests: it is that a DB-backed suite has failure modes
a unit suite does not (service startup, migration drift, a stale `environment.yaml`), and meeting those for the first
time as a hard merge block is a bad trade. Promote it into the required set once it has been green for a while.

The suite sets `files.versions.enabled` itself in each spec rather than reading it from the environment file. That is
deliberate: a suite whose result depends on a gitignored local file is a suite that passes on one machine.

**One non-obvious workflow step, found by the first CI run.** `app.e2e-spec.ts` ("AppStaticFiles") asserts that `GET /`
serves the SPA entry point out of `STATIC_PATH`, which in a test env is `dist/static`. It passes locally only because a
previous frontend build left one there — a textbook passes-on-one-machine dependency, and exactly the class of failure
this workflow is meant to surface. The workflow writes a **stub `index.html`** rather than building the frontend,
because the assertion the backend owns is "static middleware is wired and the root route serves the entry point", and
because the frontend's prebuild downloads pdf.js at build time (always-latest and gitignored — PR #272), which would
make a database-backed suite depend on a third-party download. Whether the real bundle builds is the build job's
business.
