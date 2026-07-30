# Version Thinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-file FIFO version cap with Nextcloud-style age-tiered thinning, and stop coalescing OnlyOffice saves that are proven human-triggered.

**Architecture:** A pure function owns the thinning curve (`versions, now → ids to expire`) and is called from the two places the deleted FIFO cap was enforced: eagerly after a snapshot commits, and as a nightly retention rule. Separately, `saveKindOf` gains a third classification, `human`, for `forcesavetype` ∈ {1,3}, which resolves the coalescing window to 0. Thinning must land in the same change as the coalescing relaxation — the relaxation alone multiplies row count with nothing to shape it.

**Tech Stack:** NestJS, Drizzle ORM (MySQL/MariaDB), vitest (unit + e2e), class-validator/class-transformer for config.

**Spec:** `docs/superpowers/specs/2026-07-29-version-thinning-design.md`

## Global Constraints

- **Thinning bands are Nextcloud's verbatim** (`nextcloud/server`, `apps/files_versions/lib/Storage.php:69-81`): (10 s, 2 s), (60 s, 10 s), (3600 s, 60 s), (86400 s, 3600 s), (2592000 s, 86400 s), (∞, 604800 s).
- **Thinning keys on `mtime`** (the content state's own time, milliseconds in our rows), never `createdAt`.
- **Labeled versions are never expired by thinning.** ADR §6.
- **Every deletion routes through `VersioningService.dropVersion` / `dropVersionForRetention`** — the only refcount-aware blob seam — and emits a per-victim audit line at `log` level. ADR §7.
- **Never throw into a caller's save path.** Thinning at the eager site sits outside the commit try-block with its own `.catch()`, exactly as `trimToMaxVersionsPerFile` does today.
- **The mint-time discriminator is the raw `forcesavetype` value, never the derived `saveKind === 'interactive'`** — `saveKindOf` defaults everything unclassifiable to interactive, which would wrongly exempt document-server timer saves.
- **e2e assertions are scoped to a root the case owns** — never an instance-wide aggregate (#366).
- Run `npm -w backend run build` before considering any task done: vitest's type check does not catch service↔real-class mismatches.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/applications/custom-versioning/utils/versions-thinning.ts` | **New.** The bands and the pure `versionsToExpire`. No DB, no NestJS. |
| `backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts` | **New.** Table-driven coverage of every band and boundary. |
| `backend/src/applications/custom-versioning/services/versioning-queries.service.ts` | Add `byFileIdNewestFirst`; delete `unlabeledByFileIdOldestFirst` and `countByFileId` once their last consumers go. |
| `backend/src/applications/custom-versioning/services/versioning.service.ts` | Replace `trimToMaxVersionsPerFile` with `thinFile`; `coalescingWindow` returns 0 for `human`. |
| `backend/src/applications/custom-versioning/services/versions-retention.service.ts` | Replace `enforceMaxVersionsPerFile` with `enforceThinning`; rename the `runRule` label. |
| `backend/src/applications/custom-versioning/interfaces/version.interface.ts` | `SnapshotOptions['saveKind']` gains `'human'`. |
| `backend/src/applications/files/editors/only-office/only-office-manager.service.ts` | `saveKindOf` returns `'human'` for `forcesavetype` 1 and 3. |
| `backend/src/applications/files/files.config.ts` | Delete `maxVersionsPerFile`; update the §96 worked example. |
| `backend/src/configuration/config.environment.ts` | Add `removedMaxVersionsPerFileConfig`. |
| `backend/environment.dist.yaml` | Remove the `maxVersionsPerFile` line. |
| `backend/src/applications/custom-versioning/versions-policy.e2e-spec.ts` | Rewrite the three cap-pinned cases as thinning cases. |

---

## Task 1: The pure thinning function

**Files:**
- Create: `backend/src/applications/custom-versioning/utils/versions-thinning.ts`
- Test: `backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ThinnableVersion { id: number; mtime: number; label: string | null }`, `const THINNING_BANDS: readonly { endsAfterSeconds: number; stepSeconds: number }[]`, `function versionsToExpire(versions: ThinnableVersion[], nowMs: number): number[]`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts`:

```ts
import { THINNING_BANDS, ThinnableVersion, versionsToExpire } from './versions-thinning'

// Nextcloud's curve, verbatim (apps/files_versions/lib/Storage.php:69-81). These
// numbers are a THIRD PARTY's contract, so they are pinned rather than derived.
describe('THINNING_BANDS', () => {
  it('is Nextcloud\'s six bands in ascending order', () => {
    expect(THINNING_BANDS.map((b) => [b.endsAfterSeconds, b.stepSeconds])).toEqual([
      [10, 2],
      [60, 10],
      [3600, 60],
      [86400, 3600],
      [2592000, 86400],
      [Number.POSITIVE_INFINITY, 604800]
    ])
  })
})

const NOW = 10_000_000_000

// `secondsAgo` is how old the version's CONTENT is, which is what mtime means.
const at = (id: number, secondsAgo: number, label: string | null = null): ThinnableVersion => ({
  id,
  mtime: NOW - secondsAgo * 1000,
  label
})

describe('versionsToExpire', () => {
  it('expires nothing when there is nothing to expire', () => {
    expect(versionsToExpire([], NOW)).toEqual([])
    expect(versionsToExpire([at(1, 5)], NOW)).toEqual([])
  })

  // The newest version is always kept: it is the most recent recoverable state,
  // and NC anchors its own walk on it the same way.
  it('always keeps the newest unlabeled version, however old', () => {
    expect(versionsToExpire([at(1, 5_000_000)], NOW)).toEqual([])
  })

  // THE REGRESSION FROM THE REPORT. Two deliberate Ctrl+S saves 34 s apart, both
  // now older than a minute, so both sit in the 60 s-step band.
  it('collapses two versions 34s apart once they are in the 60s band', () => {
    expect(versionsToExpire([at(1, 120), at(2, 154)], NOW)).toEqual([2])
  })

  // The same pair while they are still fresh: the 2 s band keeps both, which is
  // the "every Ctrl+S is recoverable while you work" property.
  it('keeps versions 5s apart while both are inside the 10s band', () => {
    expect(versionsToExpire([at(1, 1), at(2, 6)], NOW)).toEqual([])
  })

  it('keeps a pair spaced wider than the band step', () => {
    expect(versionsToExpire([at(1, 120), at(2, 240)], NOW)).toEqual([])
  })

  // A labeled version is invisible to the walk: it is neither expired nor used
  // as a spacing anchor, so an unlabeled neighbour survives. Erring toward
  // keeping is the right direction for a rule that deletes user history.
  it('never expires a labeled version and does not anchor spacing on one', () => {
    const rows = [at(1, 120), at(2, 121, 'pinned'), at(3, 122)]
    const expired = versionsToExpire(rows, NOW)
    expect(expired).not.toContain(2)
    expect(expired).toEqual([3])
  })

  it('expires nothing when every version but one is labeled', () => {
    expect(versionsToExpire([at(1, 10), at(2, 20, 'a'), at(3, 30, 'b')], NOW)).toEqual([])
  })

  // Bands are selected per version by ITS OWN age, so one list can span several.
  it('applies the band belonging to each version, across a span of bands', () => {
    const rows = [
      at(1, 5), // 2s band, newest -> anchor
      at(2, 8), // 2s band, 3s after anchor -> kept
      at(3, 9), // 2s band, 1s after id 2 -> expired
      at(4, 4000), // 3600s band, far from id 2 -> kept
      at(5, 4100) // 3600s band, 100s after id 4, needs 3600 -> expired
    ]
    expect(versionsToExpire(rows, NOW)).toEqual([3, 5])
  })

  // Input order must not matter: callers pass whatever the query returned.
  it('is independent of input ordering', () => {
    const rows = [at(2, 154), at(1, 120)]
    expect(versionsToExpire(rows, NOW)).toEqual([2])
  })

  // Idempotence is what makes the nightly rule cheap after eager thinning has
  // already shaped a file (spec §5).
  it('is idempotent — re-running over the survivors expires nothing', () => {
    const rows = [at(1, 120), at(2, 154), at(3, 200)]
    const firstPass = versionsToExpire(rows, NOW)
    const survivors = rows.filter((r) => !firstPass.includes(r.id))
    expect(versionsToExpire(survivors, NOW)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/applications/custom-versioning/utils/versions-thinning.spec.ts`
Expected: FAIL — cannot resolve `./versions-thinning`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/applications/custom-versioning/utils/versions-thinning.ts`:

```ts
// Age-tiered thinning of a file's version history.
//
// A PURE function on purpose: the curve is the part with real risk, and keeping
// it free of the DB and of NestJS is what lets every band and boundary be
// covered exhaustively for the cost of an array literal. The two call sites
// (VersioningService's eager pass, VersionsRetention's nightly rule) supply rows
// and delete what comes back.
//
// The bands are NEXTCLOUD'S, verbatim — `apps/files_versions/lib/Storage.php`
// lines 69-81 of `nextcloud/server`. Adopted rather than tuned: it is a proven
// curve, this fork already mirrors NC for the mobile surface, and inventing our
// own numbers would be bikeshedding with no evidence behind it.
export const THINNING_BANDS: readonly { endsAfterSeconds: number; stepSeconds: number }[] = [
  // first 10s, one version every 2s
  { endsAfterSeconds: 10, stepSeconds: 2 },
  // next minute, one version every 10s
  { endsAfterSeconds: 60, stepSeconds: 10 },
  // next hour, one version every minute
  { endsAfterSeconds: 3600, stepSeconds: 60 },
  // next 24h, one version every hour
  { endsAfterSeconds: 86400, stepSeconds: 3600 },
  // next 30 days, one version every day
  { endsAfterSeconds: 2592000, stepSeconds: 86400 },
  // beyond that, one version per week
  { endsAfterSeconds: Number.POSITIVE_INFINITY, stepSeconds: 604800 }
]

// What the thinner needs from a version row. `mtime` is in MILLISECONDS, as the
// column stores it.
export interface ThinnableVersion {
  id: number
  mtime: number
  label: string | null
}

// The ids to expire, given a file's versions and the current time.
//
// Keys on `mtime`, not `createdAt`: mtime is the timeline of distinct content
// states and is what the version panel displays, so the survivors read as evenly
// spaced to the user. `createdAt` would bunch a burst of captures whose contents
// actually span days.
//
// Labeled versions are filtered out ENTIRELY rather than merely skipped — they
// are neither expired nor used as a spacing anchor. An unlabeled version sitting
// next to a labeled one therefore survives, which errs toward keeping history;
// the right direction for a rule whose failure mode is deleting a user's data.
export function versionsToExpire(versions: ThinnableVersion[], nowMs: number): number[] {
  const candidates = versions.filter((v) => v.label === null).sort((a, b) => b.mtime - a.mtime)
  const expire: number[] = []
  let lastKeptMtime: number | null = null
  for (const version of candidates) {
    if (lastKeptMtime === null) {
      // The newest is always kept: it is the most recent recoverable state, and
      // it is the anchor the rest of the walk measures from.
      lastKeptMtime = version.mtime
      continue
    }
    const step = stepForAge((nowMs - version.mtime) / 1000)
    if ((lastKeptMtime - version.mtime) / 1000 >= step) {
      lastKeptMtime = version.mtime
    } else {
      expire.push(version.id)
    }
  }
  return expire
}

// The band a version's own age falls in. Bands are ascending, so the first
// match wins; the last is unbounded, so the loop always returns.
function stepForAge(ageSeconds: number): number {
  for (const band of THINNING_BANDS) {
    if (ageSeconds <= band.endsAfterSeconds) return band.stepSeconds
  }
  return THINNING_BANDS[THINNING_BANDS.length - 1].stepSeconds
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/applications/custom-versioning/utils/versions-thinning.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/applications/custom-versioning/utils/versions-thinning.ts backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts
git commit -m "feat(custom-versioning): pure age-tiered version thinning function"
```

---

## Task 2: The query the thinner needs

**Files:**
- Modify: `backend/src/applications/custom-versioning/services/versioning-queries.service.ts` (add after `countByFileId`, around line 283)

**Interfaces:**
- Consumes: nothing.
- Produces: `async byFileIdNewestFirst(versionsRoot: string, fileId: number): Promise<VersionRow[]>`.

- [ ] **Step 1: Write the implementation**

The existing query specs in this repo cover services, not the Drizzle builder; this method is exercised through Tasks 3–4 and the e2e suite. Add:

```ts
  // EVERY version of one file within one root, newest first, labels included.
  //
  // Unlike unlabeledByFileIdOldestFirst (which this replaces) the thinner needs
  // labeled rows in the list: it filters them itself, and handing it a
  // pre-filtered list would make a labeled version invisible in a way that
  // changes nothing today but would silently diverge if the thinner ever
  // anchored spacing on labels.
  //
  // Unpaged, deliberately. The row count for ONE file is bounded by the thinner
  // itself on every write, so the pathological case this would page for cannot
  // persist past the next save. The root filter belongs in the query for the
  // reason fileIdsExceeding documents: a file whose versions span two roots must
  // be thinned per root, or one root over-deletes while the other under-enforces.
  async byFileIdNewestFirst(versionsRoot: string, fileId: number): Promise<VersionRow[]> {
    return this.db
      .select()
      .from(customFilesVersions)
      .where(and(eq(customFilesVersions.versionsRoot, versionsRoot), eq(customFilesVersions.fileId, fileId)))
      .orderBy(desc(customFilesVersions.mtime), desc(customFilesVersions.id))
  }
```

- [ ] **Step 2: Ensure `desc` is imported**

Check the drizzle import at the top of the file. If `desc` is absent from the `drizzle-orm` import list, add it.

Run: `cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/applications/custom-versioning/services/versioning-queries.service.ts
git commit -m "feat(custom-versioning): add byFileIdNewestFirst for the thinner"
```

---

## Task 3: Eager thinning replaces the eager FIFO trim

**Files:**
- Modify: `backend/src/applications/custom-versioning/services/versioning.service.ts` — the call site around line 194 and the `trimToMaxVersionsPerFile` method at 414
- Test: `backend/src/applications/custom-versioning/services/versioning.service.spec.ts`

**Interfaces:**
- Consumes: `versionsToExpire`, `ThinnableVersion` (Task 1); `queries.byFileIdNewestFirst` (Task 2).
- Produces: `private async thinFile(versionsRoot: string, fileId: number): Promise<void>` on `VersioningService`.

- [ ] **Step 1: Write the failing test**

Add to `versioning.service.spec.ts`. Match the file's existing mocking style for `queries`.

`VersionRow` has more columns than the thinner reads, so the fixtures below are cast — `versionsToExpire` takes a
structural `ThinnableVersion` (`id`, `mtime`, `label`), and spelling out `createdAt`/`origin`/scope columns on every
fixture would obscure what each case is actually about. If this spec file already has a row factory, use it instead.

```ts
const row = (id: number, secondsAgo: number, label: string | null = null) =>
  ({ id, fileId: 7, versionsRoot: '/root', mtime: Date.now() - secondsAgo * 1000, label, checksum: `c${id}`, size: 1 }) as unknown as VersionRow

describe('VersioningService — eager thinning', () => {
  it('expires the versions the thinner selects, through dropVersion', async () => {
    // Two rows 34s apart, both older than a minute: the 60s band collapses them.
    const rows = [row(11, 120), row(12, 154)]
    queries.byFileIdNewestFirst.mockResolvedValue(rows)

    await service['thinFile']('/root', 7)

    expect(queries.deleteById).toHaveBeenCalledWith(12)
    expect(queries.deleteById).not.toHaveBeenCalledWith(11)
  })

  it('does not throw when thinning fails, so a committed save is never reported as unversioned', async () => {
    queries.byFileIdNewestFirst.mockRejectedValue(new Error('db gone'))
    await expect(service['thinFile']('/root', 7)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/applications/custom-versioning/services/versioning.service.spec.ts -t "eager thinning"`
Expected: FAIL — `service['thinFile']` is not a function.

- [ ] **Step 3: Replace the trim method**

Delete `trimToMaxVersionsPerFile` (lines 414-428) and add in its place:

```ts
  // Shapes ONE file's history in ONE root to the thinning curve.
  //
  // Replaces the FIFO cap this method used to enforce. FIFO bounded the row count
  // but destroyed long reach: 20 saves in an afternoon evicted last week. The
  // curve bounds density instead, so recent saves stay dense and old ones thin
  // out — see docs/superpowers/specs/2026-07-29-version-thinning-design.md §2.
  //
  // Runs on every write, and again nightly for files nobody is writing to
  // (VersionsRetention.enforceThinning). Idempotent, so the nightly pass over an
  // already-shaped file costs one read.
  // SWALLOWS ITS OWN ERRORS, unlike the trimToMaxVersionsPerFile it replaces
  // (which threw and relied on a `.catch()` at the call site). Deliberate: the
  // "never throw into a caller's save path" constraint then holds as a property
  // of this method rather than of its one call site, which makes it testable
  // without exercising the private `snapshot`, and keeps it true if a second
  // caller is ever added.
  private async thinFile(versionsRoot: string, fileId: number): Promise<void> {
    try {
      const rows = await this.queries.byFileIdNewestFirst(versionsRoot, fileId)
      for (const id of versionsToExpire(rows, Date.now())) {
        const victim = rows.find((r) => r.id === id)
        if (!victim) continue
        await this.dropVersion(victim)
        // Per victim at `log`, not an aggregate at `verbose`: ADR §7 — silently
        // deleting a user's history deserves an audit trail that names what went.
        // Thinning removes MORE than the FIFO cap did, so this matters more.
        this.logger.log({
          tag: this.thinFile.name,
          msg: `thinned version ${victim.id} of file ${victim.fileId} (${victim.size} bytes) from ${versionsRoot}`
        })
      }
    } catch (e) {
      // The version is already committed by the time this runs, so rethrowing
      // would make snapshotBeforeOverwrite log "the save proceeds unversioned" —
      // a lie once the row exists. The nightly rule is the backstop, so the worst
      // case is a delay in shape, never a lost version.
      this.logger.warn({ tag: this.thinFile.name, msg: `unable to thin versions of file ${fileId} in ${versionsRoot}: ${e}` })
    }
  }
```

- [ ] **Step 4: Update the call site**

At line ~194, replace the `trimToMaxVersionsPerFile` block with:

```ts
    // Thinning, with its OWN error boundary and OUTSIDE the try above: the
    // version is already committed here, so a failure must not be rethrown into
    // snapshotBeforeOverwrite — that logs "the save proceeds unversioned", which
    // would be a lie once the row exists. The nightly rule is the backstop, so
    // the worst case is a delay in shape, not a permanent breach.
    //
    // NOT for a restore's own safety snapshot: the candidate set for an
    // oldest-revision restore includes the version being restored.
    if (options.origin !== 'restore') {
      await this.thinFile(versionsRoot, fileId)
    }
```

`thinFile` owns its own error boundary (see its body), so no `.catch()` here. Add the import at the top of the file:

```ts
import { versionsToExpire } from '../utils/versions-thinning'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/applications/custom-versioning/services/versioning.service.spec.ts`
Expected: PASS. Any pre-existing case asserting FIFO trim behaviour will fail — those move to Task 7's rewrite; delete them here only if they assert `maxVersionsPerFile` specifically, and note which you removed in the commit body.

- [ ] **Step 6: Commit**

```bash
git add backend/src/applications/custom-versioning/services/versioning.service.ts backend/src/applications/custom-versioning/services/versioning.service.spec.ts
git commit -m "feat(custom-versioning): thin on write instead of FIFO-capping"
```

---

## Task 4: Nightly thinning replaces the nightly cap rule

**Files:**
- Modify: `backend/src/applications/custom-versioning/services/versions-retention.service.ts` — the `runRule` line at 79 and `enforceMaxVersionsPerFile` at 149
- Test: `backend/src/applications/custom-versioning/services/versions-retention.service.spec.ts`

**Interfaces:**
- Consumes: `versionsToExpire` (Task 1); `queries.byFileIdNewestFirst` (Task 2); `queries.distinctFileIdsByRoot` (already exists, line 337); `this.dropAll(rows, rule)` (already exists, line 301).
- Produces: `private async enforceThinning(versionsRoot: string): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Same casting note as Task 3 — `VersionRow` has more columns than the thinner reads.

```ts
const row = (id: number, secondsAgo: number, label: string | null = null) =>
  ({ id, fileId: 7, versionsRoot: '/root', mtime: Date.now() - secondsAgo * 1000, label, checksum: `c${id}`, size: 1 }) as unknown as VersionRow

describe('VersionsRetention — thinning rule', () => {
  it('thins every file in the root and returns the number removed', async () => {
    queries.distinctFileIdsByRoot.mockResolvedValue([7])
    queries.byFileIdNewestFirst.mockResolvedValue([row(11, 120), row(12, 154)])

    const removed = await service['enforceThinning']('/root')

    expect(removed).toBe(1)
    expect(versioning.dropVersionForRetention).toHaveBeenCalledTimes(1)
    expect(versioning.dropVersionForRetention.mock.calls[0][0].id).toBe(12)
  })

  it('removes nothing from an already-thinned root', async () => {
    queries.distinctFileIdsByRoot.mockResolvedValue([7])
    queries.byFileIdNewestFirst.mockResolvedValue([row(11, 120)])

    expect(await service['enforceThinning']('/root')).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/applications/custom-versioning/services/versions-retention.service.spec.ts -t "thinning rule"`
Expected: FAIL — `enforceThinning` is not a function.

- [ ] **Step 3: Replace the rule method**

Delete `enforceMaxVersionsPerFile` (lines 136-160, comment block included) and add:

```ts
  // Thin every file in this root to the curve.
  //
  // BACKSTOP, not the only enforcement point. VersioningService thins the file it
  // just versioned on every write; this sweep is the only thing that reaches a
  // root nobody writes to. Thinning is idempotent, so re-examining an
  // already-shaped file costs a read and nothing else.
  //
  // Per root, like every other row rule here: a file whose versions span two
  // roots (it was moved between spaces) must be thinned per root, or one root
  // over-deletes while the other under-enforces.
  private async enforceThinning(versionsRoot: string): Promise<number> {
    let removed = 0
    for (const fileId of await this.queries.distinctFileIdsByRoot(versionsRoot)) {
      const rows = await this.queries.byFileIdNewestFirst(versionsRoot, fileId)
      const expiring = versionsToExpire(rows, Date.now())
      if (expiring.length === 0) continue
      removed += await this.dropAll(
        rows.filter((r) => expiring.includes(r.id)),
        'thinning'
      )
    }
    return removed
  }
```

Add the import:

```ts
import { versionsToExpire } from '../utils/versions-thinning'
```

- [ ] **Step 4: Update the sweep**

At line 79, replace the `maxVersionsPerFile` rule with:

```ts
        await this.runRule('thinning', versionsRoot, () => this.enforceThinning(versionsRoot))
```

The rule name is operator-visible in the retention log and in `dropAll`'s per-victim audit line. Changing it from `maxVersionsPerFile` to `thinning` is intended; it goes in the release note.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/applications/custom-versioning/services/versions-retention.service.spec.ts`
Expected: PASS. Delete any pre-existing case asserting `enforceMaxVersionsPerFile`, naming it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add backend/src/applications/custom-versioning/services/versions-retention.service.ts backend/src/applications/custom-versioning/services/versions-retention.service.spec.ts
git commit -m "feat(custom-versioning): nightly thinning rule replaces the per-file cap"
```

---

## Task 5: Remove the config key, with a deprecation warning

**Files:**
- Modify: `backend/src/applications/files/files.config.ts` (delete lines ~145-150; update the comment at ~96)
- Modify: `backend/src/configuration/config.environment.ts` (new function + call)
- Modify: `backend/environment.dist.yaml` (remove the `maxVersionsPerFile` line)
- Modify: `backend/src/applications/custom-versioning/services/versioning-queries.service.ts` (delete two now-unused queries)
- Modify: `backend/src/applications/custom-versioning/schemas/files-versions.schema.ts:117` (comment)
- Test: `backend/src/configuration/config.loader.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function removedMaxVersionsPerFileConfig(config: GlobalConfig): void` (module-private).

- [ ] **Step 1: Delete the config property**

In `files.config.ts`, remove from `FilesVersionsConfig`:

```ts
  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesVersionsConfig) => o.maxVersionsPerFile !== false)
  @IsInt()
  @Min(1)
  maxVersionsPerFile: number | false = 20
```

Then update the worked example in the comment at ~line 96, whose whole point was the interaction with the cap:

```
//     editing mints ~10 versions — which under the FIFO cap this config used to
//     carry would have evicted about half of the file's genuinely distinct older
//     revisions. Age-tiered thinning is what removed that trade-off; the window
//     now bounds only the write rate, not the reach of history.
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/configuration/config.removed-keys.spec.ts`.

The function is unit-tested directly rather than through `configLoader()`, and it has to be, for a reason worth stating: an env var for a key absent from `environment.dist.yaml` is rejected by `getEnvOverrides` before any config object exists, so the env path can never reach this code, and the yaml path would need a fixture file on disk. Calling it with a fabricated config is the only route that exercises the branch that matters. This is why Step 3 exports it — the sibling `deprecatedFiles*` helpers are module-private and correspondingly untested.

```ts
import type { GlobalConfig } from './config.validation'
import { removedMaxVersionsPerFileConfig } from './config.environment'

// A config object shaped only as far as this function reaches into it.
const configWith = (versions: Record<string, unknown>): GlobalConfig =>
  ({ applications: { files: { versions } } }) as unknown as GlobalConfig

describe('removedMaxVersionsPerFileConfig', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  // The whole point: an unknown YAML key is otherwise dropped in SILENCE, because
  // validation runs with no whitelist/forbidNonWhitelisted. That is the #384
  // failure class — the operator's retention behaviour changes with no signal.
  it('warns when the removed key is present', () => {
    removedMaxVersionsPerFileConfig(configWith({ enabled: true, maxVersionsPerFile: 20 }))

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('maxVersionsPerFile')
  })

  // Deleted as well as warned about: plainToInstance copies unknown properties
  // onto the instance, so leaving it would carry a dead untyped field forward.
  it('deletes the key so it cannot survive onto the validated instance', () => {
    const config = configWith({ enabled: true, maxVersionsPerFile: 20 })

    removedMaxVersionsPerFileConfig(config)

    expect('maxVersionsPerFile' in (config.applications.files.versions as object)).toBe(false)
  })

  it('says nothing and changes nothing when the key is absent', () => {
    const config = configWith({ enabled: true })

    removedMaxVersionsPerFileConfig(config)

    expect(warn).not.toHaveBeenCalled()
    expect(config.applications.files.versions).toEqual({ enabled: true })
  })

  // A yaml with no versions block at all, or a partially-built config: must not
  // throw during boot.
  it('tolerates a missing versions block', () => {
    expect(() => removedMaxVersionsPerFileConfig({} as GlobalConfig)).not.toThrow()
  })
})
```

Run: `cd backend && npx vitest run src/configuration/config.removed-keys.spec.ts`
Expected: FAIL — `removedMaxVersionsPerFileConfig` is not exported.

- [ ] **Step 3: Add the warning**

In `config.environment.ts`, add after `deprecatedFilesContentIndexingConfig`:

```ts
// applications.files.versions.maxVersionsPerFile was REMOVED: age-tiered thinning
// replaced the per-file FIFO cap
// (docs/superpowers/specs/2026-07-29-version-thinning-design.md).
//
// Warned about rather than ignored, because ignoring it is SILENT here. Config
// validation runs with no `whitelist`/`forbidNonWhitelisted`, so an unknown yaml
// key is simply dropped and the operator's retention behaviour changes with no
// signal — the #384 failure class. (The env-var form is already loud: its path is
// validated against environment.dist.yaml, which logs "Ignoring unknown
// environment variable".) Deleted from the object as well as warned about, since
// plainToInstance would otherwise copy it onto the instance as an untyped field.
//
// EXPORTED only so it can be unit-tested: the env path is rejected before a
// config object exists and the yaml path would need a fixture on disk, so a
// direct call is the only way to exercise it. The sibling deprecatedFiles*
// helpers stay private because nothing about them is testable either way.
export function removedMaxVersionsPerFileConfig(config: GlobalConfig): void {
  const versions = config.applications?.files?.versions as unknown as Record<string, unknown> | undefined
  if (!versions || !('maxVersionsPerFile' in versions)) {
    return
  }
  delete versions.maxVersionsPerFile
  console.warn(
    '[REMOVED][CONFIGURATION] applications.files.versions.maxVersionsPerFile no longer applies and has been ignored. ' +
      'Version history is now shaped by age-tiered thinning and bounded by applications.files.versions.quotaShare ' +
      'and applications.files.versions.retentionDays.'
  )
}
```

Call it in `loadConfiguration`, next to the other deprecation calls (after line 58):

```ts
  removedMaxVersionsPerFileConfig(config)
```

Run: `cd backend && npx vitest run src/configuration/config.removed-keys.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3b: Remove the now-invalid env-override case**

`config.loader.spec.ts:105` asserts that `SYNCIN_APPLICATIONS_FILES_VERSIONS_MAXVERSIONSPERFILE` is applied **and** that it is not rejected as unknown. Once the key leaves `environment.dist.yaml` (Step 4), `getEnvOverrides` will reject it and this case fails — correctly. Delete the row:

```ts
    ['MAXVERSIONSPERFILE', '7', (c: any) => c.applications.files.versions.maxVersionsPerFile, 7],
```

Leave the other five rows and the comment above them untouched: what they guard (every versioning env var reaching the config) is still exactly right, and the comment explains a bug worth remembering.

Run: `cd backend && npx vitest run src/configuration/config.loader.spec.ts`
Expected: PASS.

- [ ] **Step 4: Remove from the dist yaml**

Delete the `maxVersionsPerFile:` line from the `versions:` block in `backend/environment.dist.yaml`. Leave `enabled`, `retentionDays`, `quotaShare`, `minIntervalSeconds` and `minIntervalSecondsByOrigin`. This file is the env-var whitelist (#384), so leaving the key would keep the env var silently accepted.

- [ ] **Step 5: Delete the orphaned queries**

In `versioning-queries.service.ts`, delete `countByFileId` (line 277) and `unlabeledByFileIdOldestFirst` (line 289). Confirm no consumers remain:

Run: `grep -rn "countByFileId\|unlabeledByFileIdOldestFirst" backend/src --include="*.ts"`
Expected: no matches.

Also update the comment at `files-versions.schema.ts:117` — it lists the label column's exemptions as "retentionDays/maxVersionsPerFile"; change to "retentionDays/thinning".

- [ ] **Step 6: Verify the whole backend**

Run: `cd .. && npm -w backend run build && npm -w backend run test`
Expected: build clean, all unit tests pass. Any remaining `maxVersionsPerFile` compile error points at a consumer this task missed.

- [ ] **Step 7: Commit**

```bash
git add backend/src/applications/files/files.config.ts backend/src/configuration/config.environment.ts backend/src/configuration/config.loader.spec.ts backend/environment.dist.yaml backend/src/applications/custom-versioning/services/versioning-queries.service.ts backend/src/applications/custom-versioning/schemas/files-versions.schema.ts
git commit -m "feat(custom-versioning)!: remove maxVersionsPerFile in favour of thinning"
```

---

## Task 6: A proven human save never coalesces

**Files:**
- Modify: `backend/src/applications/custom-versioning/interfaces/version.interface.ts` (the `saveKind` union)
- Modify: `backend/src/applications/files/editors/only-office/only-office-manager.service.ts` (`saveKindOf`, line 219)
- Modify: `backend/src/applications/custom-versioning/services/versioning.service.ts` (`coalescingWindow`)
- Test: `only-office-manager.service.spec.ts`, `versioning.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SnapshotOptions['saveKind']` becomes `'interactive' | 'automatic' | 'human'`.

- [ ] **Step 1: Write the failing tests**

In `only-office-manager.service.spec.ts`, extend the existing classification table:

```ts
it('classifies forcesavetype 1 and 3 as PROVEN human', () => {
  expect(manager['saveKindOf']({ forcesavetype: 1 } as any)).toBe('human')
  expect(manager['saveKindOf']({ forcesavetype: 3 } as any)).toBe('human')
})

it('still classifies 0 and 2 as automatic, and an absent discriminator as interactive', () => {
  expect(manager['saveKindOf']({ forcesavetype: 0 } as any)).toBe('automatic')
  expect(manager['saveKindOf']({ forcesavetype: 2 } as any)).toBe('automatic')
  expect(manager['saveKindOf']({} as any)).toBe('interactive')
})
```

In `versioning.service.spec.ts`:

```ts
it('never coalesces a PROVEN human save, whatever the origin override says', () => {
  configuration.applications.files.versions.minIntervalSeconds = 60
  configuration.applications.files.versions.minIntervalSecondsByOrigin.onlyoffice = 300
  expect(service['coalescingWindow']('onlyoffice', 'human')).toBe(0)
})

// The regression that motivated this: two deliberate Ctrl+S presses 34s apart
// both arrive as forcesavetype 1, and the second used to be swallowed.
it('keeps the scalar for an UNPROVABLE interactive save and the override for an automatic one', () => {
  configuration.applications.files.versions.minIntervalSeconds = 60
  configuration.applications.files.versions.minIntervalSecondsByOrigin.onlyoffice = 300
  expect(service['coalescingWindow']('onlyoffice', 'interactive')).toBe(60)
  expect(service['coalescingWindow']('onlyoffice', 'automatic')).toBe(300)
  expect(service['coalescingWindow']('onlyoffice', undefined)).toBe(300)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/applications/files/editors/only-office/only-office-manager.service.spec.ts src/applications/custom-versioning/services/versioning.service.spec.ts -t "human"`
Expected: FAIL — `'human'` is not assignable, and `coalescingWindow` returns 300.

- [ ] **Step 3: Widen the union**

In `version.interface.ts`, change the field and extend its comment:

```ts
  // `human` is a PROVEN human trigger and never coalesces at all — the window is
  // 0. `interactive` is the weaker claim "no discriminator was available, and the
  // shape of the callback says a person is at the other end"; it takes the scalar.
  // `automatic` is a proven timer and keeps the per-origin override.
  saveKind?: 'interactive' | 'automatic' | 'human'
```

- [ ] **Step 4: Classify 1 and 3 as human**

In `saveKindOf`, change the interactive arm and its comment:

```ts
      // 1 = the saving is done, e.g. the Save button was clicked.
      // 3 = the form was submitted (Complete & Submit).
      //
      // PROVEN human, and the strongest claim available on this wire. It resolves
      // to a zero window: every one of these is a person asking for a restore
      // point, and a rate limit that discards one is discarding the user's
      // explicit request. Measured 2026-07-29 — two Ctrl+S presses 34s apart
      // produced one version under the old 60s scalar.
      case 1:
      case 3:
        return 'human'
```

Leave the `default: return 'interactive'` arm and its comment exactly as they are: statuses 2 and 3 carry no `forcesavetype`, and treating them as *provably* human would also exempt a document server's own timer saves when `autoAssembly` is enabled.

- [ ] **Step 5: Resolve the window**

In `coalescingWindow`, add the new arm as the FIRST check:

```ts
    // A proven human trigger is never rate-limited. This is §5.1's own
    // justification carried to its conclusion: the override exists BECAUSE the
    // document server sets the cadence, and positive proof that a person set it
    // falsifies that premise outright rather than merely downgrading it to the
    // scalar (which is what #395 did, and what still swallowed saves).
    if (saveKind === 'human') return 0
    if (saveKind === 'interactive') return this.config.minIntervalSeconds ?? 0
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/applications/files src/applications/custom-versioning`
Expected: PASS. `npm -w backend run build` must also be clean — the union widened, so any exhaustive `switch` on `saveKind` elsewhere will surface here.

- [ ] **Step 7: Commit**

```bash
git add backend/src/applications/custom-versioning/interfaces/version.interface.ts backend/src/applications/files/editors/only-office/only-office-manager.service.ts backend/src/applications/files/editors/only-office/only-office-manager.service.spec.ts backend/src/applications/custom-versioning/services/versioning.service.ts backend/src/applications/custom-versioning/services/versioning.service.spec.ts
git commit -m "fix(custom-versioning): never coalesce a proven human OnlyOffice save"
```

---

## Task 7: Rewrite the three cap-pinned e2e cases

**Files:**
- Modify: `backend/src/applications/custom-versioning/versions-policy.e2e-spec.ts` (E2E-8, lines 109-170)

**Interfaces:**
- Consumes: everything from Tasks 3-6.
- Produces: nothing.

The three cases must be **rewritten, not deleted**. What they pin is still wanted — labeled versions survive automatic pruning, and pruning happens on the write path without the nightly sweep. Deleting them silently drops the label-exemption coverage that Task 1's invariant depends on at the integration level.

They currently write 5 generations in rapid succession, which under thinning all land inside the 10 s band (2 s step) — so nearly all collapse. That is roughly the assertion to make: **rapid successive writes collapse, and a labeled one never does.**

**But the collapse half is timing-dependent and must be guarded.** It only holds if the writes actually land less than 2 s apart; a slow runner spreads them past the band step and the assertion fails as a false negative. So each collapse assertion is preceded by a precondition check on the real `mtime` spacing, and is skipped rather than failed if the run was too slow. The deterministic halves — a labeled version always survives, the newest always survives — are asserted unconditionally. The precise curve is Task 1's job; do not try to test bands through e2e.

- [ ] **Step 1: Rewrite the sweep case**

```ts
    it('thins rapid successive versions and keeps NAMED versions regardless', async () => {
      const rel = 'e2e8-thin.txt'
      await e2e.seed(rel, 'retention gen 0')
      for (let i = 1; i <= 5; i++) {
        await e2e.overwrite(rel, `retention gen ${i}`, 'web')
      }
      const all = await e2e.versionsOf(rel)

      // Name the OLDEST, which is what any pruning rule reaches for first.
      const oldest = all[all.length - 1]
      expect((await e2e.api.label(oldest.id, rel, 'pinned')).status).toBe(200)

      await e2e.retention.cleanVersions()

      const kept = await e2e.versionsOf(rel)
      // DETERMINISTIC: the label is exempt from every automatic rule.
      expect(kept.some((v) => v.id === oldest.id)).toBe(true)
      // TIMING-DEPENDENT, so guarded. The collapse only holds if the writes
      // landed inside the 2s band; on a slow runner they spread past it and
      // nothing is expected to collapse. Asserting unconditionally would make
      // this a false negative under load. The curve itself is unit-tested in
      // versions-thinning.spec.ts.
      const spans = all.map((v) => v.mtime).sort((a, b) => b - a)
      const allWithin2s = spans.every((m, i) => i === 0 || spans[i - 1] - m < 2000)
      if (allWithin2s) {
        expect(kept.filter((v) => !v.label).length).toBeLessThan(all.filter((v) => !v.label).length)
      }
    })
```

- [ ] **Step 2: Rewrite the eager case**

```ts
    // #340's point, restated for thinning: shaping happens on the WRITE path, so
    // one file's history is bounded between nightly runs. The sweep is
    // deliberately NOT invoked here — that absence is the whole assertion.
    it('thins as the versions are written, without the nightly sweep', async () => {
      const rel = 'e2e8-thin-eager.txt'
      await e2e.seed(rel, 'eager gen 0')
      for (let i = 1; i <= 5; i++) {
        await e2e.overwrite(rel, `eager gen ${i}`, 'web')
      }

      const kept = await e2e.versionsOf(rel)
      // DETERMINISTIC: the newest version is always kept, and each version holds
      // the content its write destroyed — so the newest survivor is the last
      // generation overwritten. True whatever the runner's speed.
      expect((await e2e.api.content(kept[0].id, rel)).body).toBe('eager gen 4')
      // TIMING-DEPENDENT, guarded for the same reason as the case above.
      const spans = kept.map((v) => v.mtime).sort((a, b) => b - a)
      if (spans.length > 1 && spans[0] - spans[spans.length - 1] < 2000) {
        expect(kept.length).toBeLessThan(5)
      }
    })
```

- [ ] **Step 3: Rewrite the named-on-write case**

Keep the case at line 156 (`never trims a NAMED version on the write path, however old`) intact except for deleting its `e2e.config.maxVersionsPerFile = 3` line — the property no longer exists, and the assertion (a labeled version survives the write path) holds unchanged under thinning.

- [ ] **Step 4: Run the e2e suite**

Run: `cd .. && npm run dev:db && npm run dev:migrate && npm -w backend run test:e2e`
Expected: PASS, all files. Scope any new assertion to this case's own file; never an instance-wide aggregate (#366).

- [ ] **Step 5: Commit**

```bash
git add backend/src/applications/custom-versioning/versions-policy.e2e-spec.ts
git commit -m "test(custom-versioning): rewrite E2E-8 retention cases for thinning"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/plans/2026-07-25-file-versioning-design.md` (new §5.3)
- Modify: `CLAUDE.md` (the file-versioning section)
- Modify: `CHANGELOG.md`

- [ ] **Step 0: Correct the spec's "verbatim" claim**

In `docs/superpowers/specs/2026-07-29-version-thinning-design.md` §3.2, the phrase "Adopted verbatim rather than tuned" overclaims and must be narrowed. Task 1's review established, by reading `nextcloud/server` `apps/files_versions/lib/Storage.php:764-813`, that **NC advances bands from the last-kept version's age crossing absolute thresholds, while our walk selects the band from each candidate's own age.** The band *values* are NC's; the *walk* is ours.

Rewrite the paragraph to say exactly that: the six band values are taken verbatim, the walk is a reimplementation that differs structurally near band edges, and neither produces materially different shape (both are dense-recent, sparse-old). A spec that implies we inherited NC's proven behaviour when we inherited only its numbers is the kind of claim this repo treats as a defect.

- [ ] **Step 1: Amend the ADR**

Add §5.3 after §5.2, in the same voice as the existing amendments: state that §5.2's choice of the scalar for proven-human saves was measured insufficient (the three-save table from the spec's §1), that the window for a proven human trigger is now 0, and that the per-file FIFO cap is replaced by age-tiered thinning because relaxing the window without reshaping eviction trades one data loss for another. Cross-reference the spec.

- [ ] **Step 2: Update CLAUDE.md**

In the file-versioning section, replace any mention of `maxVersionsPerFile` bounding history with the thinning rule, and add the three traps a future reader needs:

- thinning keys on `mtime`, not `createdAt`
- the mint-time discriminator is the raw `forcesavetype`, never `saveKind === 'interactive'`, because unclassifiable defaults to interactive
- **the per-row author off-by-one (#409) must be fixed at WRITE time if it is ever fixed.** A row's `created` describes the content it holds while its `authorId` names whoever replaced it, so row *n*'s true author is row *n-1*'s `authorId`. The tempting fix is to shift by one on read — thinning makes that wrong, because once rows are removed row *n-1* is no longer the row that actually preceded *n*. Record the previous content's author on the row instead. This is spec §8, and it is the one way this change constrains future work.

- [ ] **Step 3: Changelog**

Add entries under the next version, including the two operator-visible changes:

```markdown
### Changed
- Version history is now shaped by age-tiered thinning (Nextcloud's curve) instead of a per-file FIFO cap. Recent
  versions stay dense; older ones thin to daily and then weekly, so history reaches back much further.
- OnlyOffice saves that are proven human-triggered (`forcesavetype` 1/3) are never coalesced — every explicit Save
  mints a restore point.
- The nightly retention log's rule name changed from `maxVersionsPerFile` to `thinning`.

### Removed
- `applications.files.versions.maxVersionsPerFile`. It is warned about and ignored if still present. Size is bounded by
  `quotaShare` and `retentionDays`.

### Upgrade note
- The first thinning pass on an existing install can remove more versions than the old cap ever did — a file holding 20
  versions minted minutes apart inside the last hour thins toward one per minute. Every removal is audited in the
  retention log. This is not reversible.
```

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/plans/2026-07-25-file-versioning-design.md CLAUDE.md CHANGELOG.md
git commit -m "docs(custom-versioning): record thinning in the ADR, CLAUDE.md and changelog"
git push -u origin feat/version-thinning
gh pr create --repo zjean/server --base develop --head feat/version-thinning --title "feat(custom-versioning)!: age-tiered thinning replaces the per-file cap" --body "..."
```

The PR body must carry the spec's §1 measurement table (it is the evidence the whole change rests on), the breaking-change note for the removed config key, and the §9 migration risk. Backend-only, so no screenshots — but a real-docserver run proving two Ctrl+S presses 34 s apart now yield two versions belongs in the test plan.

---

## Task 9: The `createdAt` floor (added mid-execution; run BEFORE Task 4)

**Why this exists.** Task 3's review established that `mtime` is **client-controlled** — sync clients set it through
`touchFile` (`files/utils/files.ts:182`, reached from `files-manager.service.ts:403` and `sync-manager`). Two
consequences the spec's §3.3 did not account for: a capture whose content carries a backdated mtime lands in an old,
coarse band and can be **expired inside the same `snapshot()` call that created it** (unrecoverably, while the log says
`versioned …`); and a backdated row can sort as "older" than a genuinely older row, so "always keep the newest" may not
keep the most recently captured state. FIFO was immune because it ordered by `createdAt`. A client writing odd mtimes
could keep history from ever accumulating.

**The decision** (maintainer, mid-execution): keep `mtime` for banding and spacing — it preserves distinct content
states, which is the point of §3.3 — and add a floor keyed on `createdAt`, which is server-set and monotonic.

**The rule:** a version is exempt from expiry while it has been *held* for less than the band step it is being judged
by. No new magic number — the floor is the same curve, read against a trustworthy clock. An exempt row still acts as a
spacing anchor, because it is being kept, and anchoring on it keeps *more* neighbours: the safe direction.

**Files:**
- Modify: `backend/src/applications/custom-versioning/utils/versions-thinning.ts`
- Modify: `backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts`
- Modify: `backend/src/applications/custom-versioning/services/versioning.service.spec.ts` (row fixtures need `createdAt`)

**Interfaces:**
- Consumes: Task 1's `versionsToExpire`, `ThinnableVersion`, `THINNING_BANDS`.
- Produces: `ThinnableVersion` gains a required `createdAt: Date`. `versionsToExpire`'s signature is unchanged.
  `VersionRow` already carries `createdAt: Date`, so both call sites keep compiling with no change.

- [ ] **Step 1: Extend the test helper, defaulting createdAt so existing cases keep their meaning**

In `versions-thinning.spec.ts`, the `at()` helper gains a third parameter. It must default to a LONG-HELD row, so every
existing case continues to assert exactly what it asserted before the floor existed:

```ts
// `heldSeconds` defaults to a year: the floor is not what these cases are about,
// and a row held that long is past every band's step, so the pre-floor
// expectations are unchanged.
const at = (id: number, secondsAgo: number, label: string | null = null, heldSeconds = 31_536_000): ThinnableVersion => ({
  id,
  mtime: NOW - secondsAgo * 1000,
  label,
  createdAt: new Date(NOW - heldSeconds * 1000)
})
```

- [ ] **Step 2: Write the failing tests**

Add a new describe block:

```ts
// mtime is CLIENT-CONTROLLED (touchFile), so it cannot be the only clock. The
// floor is keyed on createdAt, which the server sets and never rewinds.
describe('versionsToExpire — the createdAt floor', () => {
  // THE VECTOR. Content stamped 2 days ago, captured just now: without the floor
  // it lands in the 24h band (3600s step), sits 30s from its neighbour, and is
  // expired inside the same snapshot() call that created it.
  it('never expires a row it has only just captured, however old the content claims to be', () => {
    const twoDays = 172_800
    const rows = [at(1, twoDays, null, 31_536_000), at(2, twoDays + 30, null, 0)]
    expect(versionsToExpire(rows, NOW)).toEqual([])
  })

  // The floor must not become a blanket exemption: once the row has been held
  // longer than the step it is judged by, it thins normally.
  it('expires the same row once it has been held past its band step', () => {
    const twoDays = 172_800
    const rows = [at(1, twoDays, null, 31_536_000), at(2, twoDays + 30, null, 7200)]
    expect(versionsToExpire(rows, NOW)).toEqual([2])
  })

  // An exempt row is KEPT, so it anchors — which keeps its neighbour too. The
  // conservative direction, and the one that cannot cause surprise deletions.
  it('lets an exempt row anchor spacing, keeping its neighbour as well', () => {
    const rows = [at(1, 3000, null, 31_536_000), at(2, 3030, null, 0), at(3, 3060, null, 31_536_000)]
    // id 2 is exempt (held 0s < 60s step) and anchors at mtime NOW-3030s.
    // id 3 is then 30s from that anchor, under the 60s step, so it goes.
    expect(versionsToExpire(rows, NOW)).toEqual([3])
  })

  // The reported regression must still hold: two deliberate saves 34s apart, both
  // long since captured, still collapse in the 60s band.
  it('still collapses the 34s-apart pair once both are long held', () => {
    expect(versionsToExpire([at(1, 120), at(2, 154)], NOW)).toEqual([2])
  })
})
```

Run: `cd /Users/janwiebe/prive/sync-in-server/backend && npx vitest run src/applications/custom-versioning/utils/versions-thinning.spec.ts`
Expected: FAIL — `createdAt` is not a property of `ThinnableVersion`.

- [ ] **Step 3: Add `createdAt` to the interface**

```ts
export interface ThinnableVersion {
  id: number
  mtime: number
  label: string | null
  // When WE captured this version. Server-set and monotonic, unlike `mtime`,
  // which arrives from the client via touchFile — see the floor in
  // versionsToExpire for what that difference is load-bearing for.
  createdAt: Date
}
```

- [ ] **Step 4: Apply the floor**

Inside `versionsToExpire`'s loop, after `step` is computed and before the spacing comparison:

```ts
    const step = stepForAge((nowMs - version.mtime) / 1000)
    // THE FLOOR. Never expire a capture we have not held for at least as long as
    // the spacing we are judging it by. `mtime` is client-controlled, so without
    // this a row whose content carries a backdated mtime lands in a coarse band
    // and is expired inside the same snapshot() call that created it — silently
    // and unrecoverably, while the caller logs `versioned …`. `createdAt` is set
    // by us and never rewinds. No new constant: the floor IS the curve, read
    // against a clock we trust.
    //
    // An exempt row still anchors, because it is being kept — and anchoring on it
    // keeps MORE neighbours, which is the safe direction for a rule that deletes
    // a user's history.
    if ((nowMs - version.createdAt.getTime()) / 1000 < step) {
      lastKeptMtime = version.mtime
      continue
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/janwiebe/prive/sync-in-server/backend && npx vitest run src/applications/custom-versioning/utils/versions-thinning.spec.ts`
Expected: PASS, 15 tests.

Then the callers. `VersionRow` already has `createdAt: Date`, so `versioning.service.ts` and the query need no change —
but the **row fixtures in `versioning.service.spec.ts`** (the `row(...)` helper from Task 3, and any inline literals it
passes to `byFileIdNewestFirst`) now need a `createdAt`. Give them an old one (`new Date(0)`) so Task 3's expectations
are unchanged, and confirm:

Run: `cd /Users/janwiebe/prive/sync-in-server/backend && npx vitest run src/applications/custom-versioning 2>&1 | tail -20`
Expected: PASS. Then `cd /Users/janwiebe/prive/sync-in-server && npm -w backend run build` — TSC 0 issues.

- [ ] **Step 6: Commit**

```bash
git add backend/src/applications/custom-versioning/utils/versions-thinning.ts backend/src/applications/custom-versioning/utils/versions-thinning.spec.ts backend/src/applications/custom-versioning/services/versioning.service.spec.ts
git commit -m "fix(custom-versioning): floor thinning on createdAt, which the client cannot set"
```

---

## Verification before the PR is considered ready

- [ ] `npm -w backend run test` — all pass
- [ ] `npm -w backend run build` — TSC 0 issues
- [ ] `npm -w backend run test:e2e` — all pass, after `npm run dev:db && npm run dev:migrate`
- [ ] `grep -rn "maxVersionsPerFile" backend/src` — only the deprecation warning and comments referring to its removal
- [ ] Real-docserver run: two Ctrl+S presses 34 s apart yield **two** versions (the §1 regression). Rig recipe in `docs/plans/2026-07-29-adr-19-editor-soak.md` §2, but re-derive the LAN IP — it moves between sessions.
