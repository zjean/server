# Version thinning: age-tiered expiry replaces the FIFO cap, and a proven human save never coalesces

- **Date:** 2026-07-29
- **Status:** Design approved, not implemented.
- **Supersedes:** ADR §5.1's per-file FIFO cap as the shaper of history, and ADR §5.2's choice of the 60 s scalar for
  proven-human editor saves. Both are amended, not discarded — see §2.
- **Origin:** a user report ("the versions panel is not updated every time a new version is created, need to reopen the
  doc first") that was reproduced and root-caused against a real document server. See §1.

---

## 1. The defect, measured

Reproduced on 2026-07-29 against `onlyoffice/documentserver` 9.4.0 with the shipped default
`minIntervalSeconds: 60`. Three explicit Ctrl+S presses on one file:

| Save | Time | Δ since previous | Callback | Version row |
|---|---|---|---|---|
| A | 20:53:11 | — | `status=6 forcesavetype=1 saveKind=interactive` | created |
| B | 20:53:45 | +34 s | `status=6 forcesavetype=1 saveKind=interactive` | **none** |
| C | 20:55:51 | +126 s | `status=6 forcesavetype=1 saveKind=interactive` | created |

Same action, same classification; only elapsed time differs. The 60 s window is provably the gate.

**Two things this rules out**, both measured rather than reasoned:

- **It is not a UI refresh bug.** The panel re-fetches on every open and showed correct data every time. Save B's
  content became live; no version was minted for the content it replaced.
- **It is not a callback race.** Cmd+S, the callback, and the row insert all land in the same clock second. An earlier
  "6.9 s" reading was tool-call lag ahead of the keypress, disproved by checking the row's `createdAt`.

"Need to reopen the doc first" is explained by the same mechanism: reopening burns more than 60 s, so the next save
falls outside the window.

## 2. Why the existing design produced this

ADR §5.1 sets the editor window to 300 s because *"an editor's cadence is set by the document server, not by a
human."* ADR §5.2 (#395) found that premise false for OnlyOffice — it has no autosave at all — and made a
proven-human save fall back to the **scalar, 60**. That fixed the egregious case (four saves in two minutes → zero
versions) but landed on a number that a human still trips, which is the defect above.

§5.1 also states the harm that coalescing exists to prevent, and it is *not* row count: with `maxVersionsPerFile: 20`
and FIFO eviction, minting faster **evicts genuinely distinct older revisions**. So simply setting the human window to
0 trades one loss for another — every Ctrl+S becomes recoverable, and last week's history is pushed out by a
save-happy afternoon.

**The resolution is to stop making the decision at mint time.** Mint-time coalescing is irreversible and decided with
no knowledge of what comes next. Expiry-time thinning is revisable and decided with full hindsight. Move the
collapsing, and both properties hold at once: every save exists while you are working — when you would actually want
to restore an intermediate state — and history still reaches back weeks.

## 3. The rule

### 3.1 Mint — a proven human save never coalesces

`coalescingWindow` returns **0** when the write is proven human-triggered. The discriminator is OnlyOffice's
`forcesavetype` ∈ {1, 3} (1 = Save clicked, 3 = form submitted), keyed on **the raw wire value**.

**Not** on `saveKind === 'interactive'`. `saveKindOf` deliberately defaults everything unclassifiable to interactive —
statuses 2 and 3 carry no `forcesavetype` at all — so testing the derived kind would also exempt **timer** saves on a
document server with `services.CoAuthoring.autoAssembly` enabled. That configuration is unusual (it ships disabled)
but it is exactly the storm the window exists for, and the soak confirmed `forcesavetype: 2` does arrive once it is on.

Everything else is untouched: Collabora keeps 300, `web`/`webdav`/`sync`/`nc-chunked` keep the 60 s scalar, and an
OnlyOffice save that cannot be proven human keeps 300. Sync clients and WebDAV writers stay rate-limited, so no origin
gains unbounded write amplification — each minted row costs a full blob copy before any thinner sees it.

### 3.2 Expire — age-tiered thinning

Nextcloud's constants, verbatim (`nextcloud/server`, `apps/files_versions/lib/Storage.php:69-81`):

| Age up to | Keep one every |
|---|---|
| 10 s | 2 s |
| 60 s | 10 s |
| 3600 s (1 h) | 60 s |
| 86400 s (24 h) | 3600 s |
| 2592000 s (30 d) | 86400 s (1 d) |
| beyond | 604800 s (1 w) |

Walk a file's versions newest → oldest; keep one only if it is at least `step` older than the last kept version,
where `step` comes from the band the version's age falls in.

Adopted verbatim rather than tuned: it is a proven curve, this fork already mirrors NC for the mobile surface, and
picking our own numbers invites bikeshedding with no evidence behind it.

### 3.3 Thin on `mtime`, not `createdAt`

Our rows carry both, and NC has no equivalent choice to make. Use **`mtime`** — the content state's own time.

It is the timeline of distinct content states, and it is what the panel already displays (`created: mtime / 1000`), so
the surviving rows read as evenly spaced to the user. `createdAt` would bunch a burst of captures whose contents
actually span days — e.g. a file untouched for a week, then overwritten twice in a minute, has two rows whose
*contents* are a week apart.

## 4. What this replaces

Thinning shapes history; **`quotaShare` (0.5) and `retentionDays` remain the size bounds** — the same division of
labour NC uses.

The cap has **two** enforcement sites and both are replaced, which maps exactly onto the two thinning call sites of §5:

| Deleted | Replaced by |
|---|---|
| `VersioningService.trimToMaxVersionsPerFile` (eager, after snapshot) | eager thinning, same placement |
| `VersionsRetention.enforceMaxVersionsPerFile` + its `runRule('maxVersionsPerFile', …)` entry (nightly) | nightly thinning rule |

`VersioningQueries.unlabeledByFileIdOldestFirst` and `countByFileId` lose their only consumers and go with them. The
quota cap's own eviction uses a different, root-scoped query and is untouched.

The nightly rule's audit reason string changes from `maxVersionsPerFile` to `thinning`, which is operator-visible in
the retention log. Intended, and worth a release-note line.

Two comments referencing the cap need updating rather than deleting: `files-versions.schema.ts:117` (on the label
column's exemptions) and `files.config.ts:96` (the ~10-versions-an-hour worked example, whose whole point was the
interaction with the cap).

Keeping a FIFO count cap alongside thinning was rejected: it bites first for any active file, so long reach would not
actually be delivered and the change would largely cancel itself.

### 4.1 Removing the config key, and the silent half

`maxVersionsPerFile` is removed from `FilesVersionsConfig` **and** from `environment.dist.yaml`.

Config validation runs `transformAndValidate(GlobalConfig, config, { exposeDefaultValues: true }, { skipMissingProperties: false })`
(`config.environment.ts:60-66`) — with **no `whitelist` / `forbidNonWhitelisted`**. Measured consequence:

- an **env var** `SYNCIN_APPLICATIONS_FILES_VERSIONS_MAXVERSIONSPERFILE` fails **loudly**, logging
  `Ignoring unknown environment variable`, because that path is validated against the dist file
- the same key in **`environment.yaml`** is **silently discarded**

The silent half is the #384 failure class. So removal ships with a **deprecation warning at boot**, following the
repo's own established pattern — `deprecatedFilesEditorsConfig` and `deprecatedFilesContentIndexingConfig` are
one-off functions called from `loadConfiguration`. A third one warns that the key no longer applies and that thinning
plus `quotaShare` now govern retention.

## 5. Where thinning runs

**Both**, sharing one function:

- **Eagerly, after a snapshot commits** — the placement `trimToMaxVersionsPerFile` occupies today: outside the commit
  try-block, with its own error boundary, so a thinning failure never turns a committed version into a logged
  "the save proceeds unversioned" lie. Keeps an actively-edited file's history shaped in real time.
- **Nightly, in `cleanVersions`** — as a `runRule` entry replacing `maxVersionsPerFile`, catching files that stopped
  being edited. Eager-only would leave a quiet file frozen in whatever shape its last save produced.

Because the two sites bracket a file's whole life, thinning is idempotent by construction: running it on
already-thinned history is a no-op, so the nightly rule re-examining what eager thinning already shaped costs a read
and nothing else.

Nightly-only was rejected: rows accumulate unbounded between runs, and each one is a blob copy.

## 6. Invariants the thinner must not break

1. **Labeled versions are never thinned.** Today's guarantee is structural (`unlabeledByFileIdOldestFirst`); the
   thinner needs the same filter explicitly, or a named revision silently disappears. ADR §6.
2. **Deletion routes through the existing drop path** (`dropVersion` / `dropVersionForRetention`), so the
   per-`(checksum, versionsRoot)` blob refcount and the ADR §7 audit line both apply. A bespoke delete drops all
   three — the trap `CLAUDE.md` records for the admin purge.
3. **Per-victim audit at `log` level, not an aggregate at `verbose`.** ADR §7. Thinning deletes more than FIFO did, so
   this matters more, not less.
4. **A restore's own safety snapshot is exempt at the moment of restore** — the exemption
   `trimToMaxVersionsPerFile` takes today, and for a sharper reason: the candidate set for an oldest-revision restore
   includes the version being restored.

## 7. Testing

- **The interval walk is a pure function** — `(versions, now) → ids to expire`, no DB. Table-driven against all six NC
  bands plus each boundary between them. This is where the risk concentrates and it is cheap to cover exhaustively.
- Labeled and restore exemptions.
- `forcesavetype` 1/3 window resolution, as new cases in `versioning.service.spec.ts` beside the existing regression
  pinning that an omitted `saveKind` behaves exactly as before.
- `npm -w backend run build` — vitest's type check does not catch service↔real-class mismatches.
- **e2e scoped to a root the case owns.** Never an instance-wide aggregate: e2e files run in parallel worker threads
  against one database (#366).
- **Three existing e2e cases must be rewritten, not deleted** — `versions-policy.e2e-spec.ts:110`, `:140` and `:158`
  set `e2e.config.maxVersionsPerFile` and assert oldest-first pruning both eagerly and via the nightly sweep. What they
  actually pin is still wanted (labeled versions survive pruning; the cap applies as versions are written, without the
  sweep), so each becomes the thinning equivalent. Deleting them would silently drop the label-exemption coverage that
  §6(1) depends on.
- **Real-docserver run** reproducing §1: two Ctrl+S presses 34 s apart now yield two versions.

## 8. Out of scope

- **Save kind is still not persisted on the version row.** #395's reasoning stands: `isCoalesced` finds the newest row
  by `(fileId, authorId, origin)`, the tuple the index is built on, and storing the kind costs a migration, a widened
  index, and a new field on every surface that reads a version row.
- **Collabora's 300 s window is unchanged.** Its saves really are the document server's decision.
- **No admin UI.** Versions config stays env-only, per the `trashRetention` precedent.
- **The per-row author off-by-one (noted in #409) is not fixed here** — but this design constrains how it may be
  fixed later. A row's `created` describes the content it holds while its `authorId` names whoever replaced that
  content, so row *n*'s true author is row *n-1*'s `authorId`. The tempting fix is to shift by one at read time.
  **Thinning makes that wrong**: once rows are removed, row *n-1* is no longer the row that actually preceded *n*. If
  the off-by-one is fixed, it must be fixed at **write** time — recording the previous content's author on the row —
  not by shifting on read.

## 9. Migration risk

There is no data migration, and none is needed. But the first thinning pass on an existing install **can delete more
than FIFO ever would**: a file holding 20 versions all minted minutes apart inside the last hour thins to roughly one
per minute in a single pass. That is the intended shape, it is fully audited per §6(3), and it is not reversible.

It belongs in the release note. It is also the strongest argument for the eager+nightly split of §5 over one large
nightly sweep — eager thinning keeps each file's shape current, so no install accumulates a large one-time correction.
