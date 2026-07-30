import { HttpStatus } from '@nestjs/common'
import { USER_ROLE } from '../users/constants/user'
import { API_VERSIONS_ADMIN_PURGE, API_VERSIONS_ADMIN_STORAGE } from './constants/routes'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import type { VersionsPurgeResult, VersionsStorageSummary } from './interfaces/version.interface'
import { setupVersionsE2E, type VersionsActor, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// The operator surface (#342), driven over real HTTP.
//
// WHY THIS FILE EXISTS SEPARATELY FROM versions-admin.controller.spec.ts. That
// spec proves the guard's DECISION — it constructs a UserRolesGuard and asks it
// about a fabricated principal. What it cannot prove is that the decision is
// wired into the request path: that the guard is actually in the chain, that
// nothing upstream short-circuits it, and that a real logged-in non-admin
// session is refused. PR #364 shipped with only the former, on an endpoint whose
// one write action deletes version history instance-wide. This closes that gap.
//
// SCOPING, per the parallel-worker lesson (#366). These endpoints are the only
// ones in the suite that report INSTANCE-WIDE figures, and its sibling spec files
// are writing versions to the same database at the same time. So no case here
// compares a total against a snapshot: the totals are bracketed one-sided
// (a neighbour can only add), and everything exact is asserted against this
// fixture's OWN root, which no other worker touches.
describe('versions admin surface (e2e)', () => {
  let e2e: VersionsE2EContext
  let operator: VersionsActor

  beforeAll(async () => {
    e2e = await setupVersionsE2E()
    // The fixture's own user is a plain USER and is therefore the non-admin
    // principal for every refusal below; this is the allowed side.
    operator = await e2e.addUser({ role: USER_ROLE.ADMINISTRATOR })
  })

  afterAll(async () => await e2e?.teardown())

  beforeEach(() => {
    e2e.restoreConfig()
    e2e.config.enabled = true
    e2e.config.minIntervalSeconds = 0
  })

  const root = () => `user:${e2e.user.login}`

  const get = (session: { cookie: string }) =>
    e2e.app.inject({ method: 'GET', url: API_VERSIONS_ADMIN_STORAGE, headers: { cookie: session.cookie } } as never)

  const purge = (session: { cookie: string; csrf: string }, versionsRoot: string, opts?: { csrf?: boolean }) =>
    e2e.app.inject({
      method: 'POST',
      url: API_VERSIONS_ADMIN_PURGE,
      headers: { cookie: session.cookie, ...(opts?.csrf === false ? {} : { 'sync-in-csrf': session.csrf }) },
      body: { versionsRoot }
    } as never)

  // Two unlabeled versions of one file, in the fixture user's own root.
  const seedHistory = async (rel: string, generations = 2) => {
    await e2e.seed(rel, `${rel} generation 0`)
    for (let i = 1; i <= generations; i++) await e2e.overwrite(rel, `${rel} generation ${i}`, 'web')
    return e2e.versionsOf(rel)
  }

  /* ------------------------------------------------------------ authorization */

  describe('a real non-admin session', () => {
    it('is refused the storage summary', async () => {
      const res = await get(e2e.session)
      expect(res.statusCode).toBe(HttpStatus.FORBIDDEN)
    })

    // The one that matters. A guard-level test can pass while the purge is
    // reachable, and this action cannot be undone.
    it('is refused the purge AND leaves the history it aimed at intact', async () => {
      const rel = 'admin-nonadmin-purge.txt'
      const before = await seedHistory(rel)
      expect(before.length).toBeGreaterThan(0)

      const res = await purge(e2e.session, root())
      expect(res.statusCode).toBe(HttpStatus.FORBIDDEN)

      // Asserting the status alone would not distinguish "refused" from
      // "refused after deleting" — the guard runs before the handler, but that
      // ordering is the claim under test, not an assumption to build on.
      expect((await e2e.versionsOf(rel)).map((v) => v.id)).toEqual(before.map((v) => v.id))
    })

    // Not its own root either: the endpoint takes a free-text root, so "may I
    // purge MY history" is a distinct question from "may I purge anyone's", and
    // the answer to both is no — there is no self-service purge.
    it('cannot purge its own root by naming it', async () => {
      const rel = 'admin-nonadmin-own-root.txt'
      const before = await seedHistory(rel)

      expect((await purge(e2e.session, `user:${e2e.user.login}`)).statusCode).toBe(HttpStatus.FORBIDDEN)
      expect(await e2e.versionsOf(rel)).toHaveLength(before.length)
    })

    it('is refused an unauthenticated request outright', async () => {
      expect((await e2e.app.inject({ method: 'GET', url: API_VERSIONS_ADMIN_STORAGE } as never)).statusCode).toBe(HttpStatus.UNAUTHORIZED)
    })
  })

  /* ----------------------------------------------------------------- the admin */

  describe('an administrator session', () => {
    it('reads the storage summary, and it accounts for at least this root', async () => {
      const rel = 'admin-summary.txt'
      await seedHistory(rel)
      const mine = await e2e.versioningQueries.usageByRoot(root())

      const res = await get(operator)
      expect(res.statusCode).toBe(HttpStatus.OK)
      const summary = res.json() as VersionsStorageSummary

      // One-sided, because neighbouring workers are writing to other roots
      // throughout: the instance total can only be at least our own root's, and
      // an equality here is exactly the assertion that failed as
      // "expected 829 to be 808" in #366.
      expect(summary.used).toBeGreaterThanOrEqual(mine.used)
      expect(summary.count).toBeGreaterThanOrEqual(mine.count)
      expect(summary.roots).toBeGreaterThanOrEqual(1)

      // The shape the panel renders, asserted over whatever made the top-N
      // rather than over our own row: with several workers writing, this root is
      // not guaranteed to rank.
      for (const entry of summary.topRoots) {
        expect(['user', 'space']).toContain(entry.kind)
        expect(typeof entry.name).toBe('string')
        expect(entry.ceiling === null || typeof entry.ceiling === 'number').toBe(true)
      }
    })

    it('purges the unnamed history of one root and keeps the named versions', async () => {
      const doomed = await seedHistory('admin-purge-doomed.txt')
      const kept = await seedHistory('admin-purge-kept.txt')
      const label = kept[0]
      expect((await e2e.api.label(label.id, 'admin-purge-kept.txt', 'keep me')).status).toBe(HttpStatus.OK)

      const res = await purge(operator, root())
      expect(res.statusCode).toBe(HttpStatus.CREATED)
      const result = res.json() as VersionsPurgeResult

      expect(result.versionsRoot).toBe(root())
      expect(result.removed).toBeGreaterThanOrEqual(doomed.length)
      expect(result.keptLabeled).toBeGreaterThanOrEqual(1)

      // Exact, because it is scoped to our own root: after a purge everything
      // still standing there is labeled, which is the property the endpoint's
      // whole "unlabeled-only" contract rests on.
      const after = await e2e.versioningQueries.usageByRoot(root())
      expect(after.count).toBe(result.keptLabeled)
      expect(await e2e.versionsOf('admin-purge-doomed.txt')).toHaveLength(0)
      expect((await e2e.versionsOf('admin-purge-kept.txt')).map((v) => v.id)).toContain(label.id)
    })

    // A purge with no history is a zero, not a 404 — the action is idempotent by
    // nature and a second click must not read as a failure.
    it('answers zero for a root with nothing left to purge', async () => {
      const res = await purge(operator, `user:${operator.user.login}`)
      expect(res.statusCode).toBe(HttpStatus.CREATED)
      expect((res.json() as VersionsPurgeResult).removed).toBe(0)
    })

    // FileError does not extend HttpException. Without the controller's filter
    // this arrives as a 500, which is why it is worth asserting over HTTP and
    // not just at the service.
    it('answers 400, not 500, for a string that is not a versions root', async () => {
      const res = await purge(operator, 'not-a-root')
      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST)
    })

    it('rejects a body the DTO refuses', async () => {
      const res = await e2e.app.inject({
        method: 'POST',
        url: API_VERSIONS_ADMIN_PURGE,
        headers: { cookie: operator.cookie, 'sync-in-csrf': operator.csrf },
        body: {}
      } as never)
      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST)
    })

    // The admin role does not exempt anyone from CSRF, and the destructive route
    // is the one where that matters: without this, an admin's browser session is
    // enough for a cross-site POST to purge a root.
    it('still requires the CSRF header on the purge', async () => {
      const rel = 'admin-purge-csrf.txt'
      const before = await seedHistory(rel)

      const res = await purge(operator, root(), { csrf: false })
      expect(res.statusCode).toBe(HttpStatus.FORBIDDEN)
      expect(await e2e.versionsOf(rel)).toHaveLength(before.length)
    })

    /* ------------------------------------------------------------ feature flag */

    // ADR §13: the same 404 and the same message as every other versions route
    // while the feature is off, so the panel can say "versioning is disabled
    // here" instead of rendering an empty table over a working instance.
    it('404s with the shared message while versioning is off, and purges nothing', async () => {
      const rel = 'admin-flag-off.txt'
      await seedHistory(rel)
      // Read back through the QUERIES, not through versionsOf: listVersions is
      // itself gated on the flag and answers [] while it is off, so the obvious
      // read-back would measure the flag instead of the purge and pass for the
      // wrong reason.
      const before = await e2e.versioningQueries.usageByRoot(root())
      expect(before.count).toBeGreaterThan(0)
      e2e.config.enabled = false

      const storage = await get(operator)
      expect(storage.statusCode).toBe(HttpStatus.NOT_FOUND)
      expect(storage.json().message).toBe(VERSIONS_DISABLED_MESSAGE)

      const purged = await purge(operator, root())
      expect(purged.statusCode).toBe(HttpStatus.NOT_FOUND)
      expect((await e2e.versioningQueries.usageByRoot(root())).count).toBe(before.count)
    })
  })
})
