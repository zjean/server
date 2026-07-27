# File Versioning — Phase E notes

- **Date:** 2026-07-27
- **Status:** 15 of the 20 planned cases are implemented and green. Five are owed; §3 says which and why.
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

Two traps the suite hit while being written, both now called out in comments:

- **Blob assertions must be identity-based, not counts.** The store is root-scoped: it holds every file's history for
  the user, so `expect(blobs()).toHaveLength(1)` only passes while its case happens to run first.
- **Test content must be unique per case.** The store is content-addressed and refcounted per (checksum, root), so two
  cases seeding `'v1'` share a blob — and a delete that "should" remove it correctly does not. E2E-9 asserts that
  behaviour on purpose; everywhere else it is a confusing failure.

## 2. What is covered

`versions-lifecycle.e2e-spec.ts` (14), `versions-write-paths.e2e-spec.ts` (15), `versions-policy.e2e-spec.ts` (15).

| Case | Covers | Notable assertion |
|---|---|---|
| **E2E-1** | upload lifecycle | no version for a create; one per overwrite; each revision's **exact bytes** over HTTP; `attachment` disposition named after the live file; usage rises |
| **E2E-2** | restore | bytes return, **inode preserved**, pre-restore content becomes its own version, restore twice, CSRF required, cross-file version id 404s |
| **E2E-3** | WebDAV | first PUT no version; later PUT one, `webdav`; **a resumed content-range sequence yields exactly ONE version holding the full pre-upload content**; the store never appears in a PROPFIND |
| **E2E-4** | sync `tmpPath` | one version at the final move, `sync` |
| **E2E-6** | trash | rows and blobs survive a move to trash, keyed on the stable `files.id` |
| **E2E-8** | retention | `maxVersionsPerFile` prunes oldest-first; `retentionDays` expires; **a named version survives both, and the orphan-blob GC collects debris** |
| **E2E-9** | dedup / refcount | identical content → one blob, two rows; the blob outlives the first delete and goes on the last |
| **E2E-12** | quota (ADR §7 rewrite) | usage stays under `quota * quotaShare`; a labeled version is never evicted; no quota → no cap; a dedup hit evicts nothing |
| **E2E-13** | flag off | no versions, no blob-store writes, all seven endpoints 404, history intact when it returns |
| **E2E-14** | concurrency | **re-hashes every stored blob and requires its own name back** — no strict version count, per ADR §4 |
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

### One fix this phase forced

`webdav.e2e-spec.ts` authenticated as `Basic am86cGFzc3dvcmQ=` — `jo:password`, **a user nothing creates.** The seed
makes `sync-in` plus faker-random logins, and CI runs migrations without seeding at all. Six of its seven tests were
401ing in every reproducible environment, and the other two passed only because they need no authorization. It now
creates its own user. That was not optional: with those failures the new CI workflow would have been red from its
first run and worth nothing.

## 3. The five cases still owed

None is blocked; each needs setup the others did not.

| Case | What it needs |
|---|---|
| **E2E-5** NC chunked upload | the `nc-uploads` assemble-and-MOVE flow driven over HTTP, which needs an NC app password (`NcBasicAuthGuard`) rather than the user's own credentials |
| **E2E-7** permissions matrix | a **second user** plus a shared space at read-only, to assert the ADR matrix (list/download yes; restore/label/delete no) and that a public link cannot reach the endpoints at all |
| **E2E-10** NC compat | same app-password setup as E2E-5, and it should assert the three wire facts from the findings' D2.0 — the mandatory self entry, revision id == `mtime` seconds agreeing with `d:getlastmodified`, and the empty `d:resourcetype`. **Those three are what silently break a client, and none is visible from a passing unit test of the XML builder alone** |
| **E2E-11** editor callbacks | a WOPI-shaped Collabora request and an OnlyOffice callback token; the hooks' ordering is unit-tested, so what e2e adds is the live-file inode surviving a real save |
| **E2E-14** DAV concurrency half | the non-DAV half is done; the DAV case wants parallel unlocked PUTs, which needs care to stay non-flaky |

Also still open from Phase D, unchanged: the **ADR §19 soak** against real Collabora, OnlyOffice and NC clients, and
the two unwritten release blockers (the quota-reduction release note, and adding per-home `versions/` to the documented
backup set).

## 4. CI

`.github/workflows/test-e2e.yml` runs the suite against a MariaDB service container. It is a **separate, advisory
check** — deliberately not part of the `test` check branch protection requires.

The reason to keep it advisory at first is not timidity about the tests: it is that a DB-backed suite has failure modes
a unit suite does not (service startup, migration drift, a stale `environment.yaml`), and meeting those for the first
time as a hard merge block is a bad trade. Promote it into the required set once it has been green for a while.

The suite sets `files.versions.enabled` itself in each spec rather than reading it from the environment file. That is
deliberate: a suite whose result depends on a gitignored local file is a suite that passes on one machine.
