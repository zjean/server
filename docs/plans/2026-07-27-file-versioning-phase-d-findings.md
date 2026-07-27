# File Versioning — Phase D findings

- **Date:** 2026-07-27
- **Status:** the record of what Phase D verified, and what it found that changes the design's claims.
- **Companion to** [`2026-07-27-file-versioning-phase-d-handoff.md`](2026-07-27-file-versioning-phase-d-handoff.md) (what to do) and
  [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) (the ADR — still the authority).

Phase D is integration work. Three of its four tasks are verification rather than new code, so this file is the
deliverable for those three: it says what was asserted, where the assertion lives, and what turned out to be untrue.

---

## D1 — WebDAV correctness

Branch `mod/versioning-webdav`. No production code changed; all four claims already held. What was missing was
executable evidence, which is now in place.

### D1.1 A resumed content-range PUT sequence produces exactly ONE version

**Holds.** `files-manager.service.spec.ts` →
*"produces exactly ONE version across a resumed content-range PUT sequence, taken before the first byte lands"*.

The shape of a resumed DAV overwrite is worth writing down, because it is not the shape the task description
suggests. `saveStream` validates `startRange === <current file size>` (`files-manager.service.ts:175-178`), so a
client **cannot** open a sequence with `Content-Range: bytes 0-…` against an existing non-empty file — that request
is a 400 before any versioning code runs. The reachable sequence is:

| # | Request | `startRange` | Snapshot? |
|---|---|---|---|
| 1 | plain `PUT`, no `Content-Range` | 0 | **yes** — `origin: webdav` |
| 2..n | `PUT` with `Content-Range: bytes <size>-…` | `> 0` | no |

So the "snapshot at `startRange === 0` only" rule and "exactly one version per resumed sequence" are the *same* rule
seen from two sides, and the rule is load-bearing in only one direction: request 1 is the only one that still has the
pre-upload bytes in front of it.

The test asserts both halves — one snapshot, and its `invocationCallOrder` before the **first** `writeFromStream` of
the sequence. The ordering assertion is what covers *"the full pre-upload content, never a partial"*: there is no
chunk the snapshot could have been interleaved with.

### D1.2 ETag and `getlastmodified` derive from the live file only

**Holds.** `versioning.service.spec.ts` →
*"leaves the live file's ETag and getlastmodified untouched, so a PROPFIND cannot tell versions exist"*.

`WebDAVFile.getetag` is `genEtag(size, mtime)` and `getlastmodified` is `new Date(mtime).toUTCString()`
(`webdav/models/webdav-file.model.ts:43,65`) — both pure functions of the live stat. Snapshotting cannot perturb them
because `stageBlob` copies **out of** `space.realPath` with `fs.copyFile` and hashes the staged copy, so the live file
is only ever opened for reading.

That is a property of the current implementation, not of the interface, which is why it is now pinned: a version of
this feature that `touch`ed the live file to mark it versioned, or hashed it in place through a handle opened for
update, would change the ETag and make every DAV and NC client re-download an unmodified file. The test was verified
non-vacuous by injecting `fs.utimes(realPath, …)` into `stageBlob` — it fails.

### D1.3 Strong ETags stay strong

**Holds, already guarded.** `nc-propfind.service.spec.ts:137` →
*"emits d:getetag as a strong ETag (no W/ prefix), even when the source file carries a weak one"*.

Sync-in's `genEtag` defaults to `weakPrefix = true` and emits `W/"…"`; `nc-prop-builder.ts` strips it. Nothing in
versioning touches either. Recorded here so the next reader does not go looking: **the guard already exists and needs
no versioning-specific duplicate**, because versions never reach the ETag path at all.

### D1.4 The versions directory never appears in a PROPFIND of the space root

**Holds, and it is placement-dependent — this is the fragile one.**

Two assertions, deliberately at different levels:

- `utils/paths.spec.ts` → *"is not inside the files repository, so the indexer, PROPFIND and sync never see it"* —
  structural, over the path helpers.
- `versioning.service.spec.ts` → *"adds nothing inside the served files tree, so the versions store cannot surface in
  a PROPFIND"* (new) — behavioural, over a real snapshot on a real filesystem, including the `.staging` directory.

The second exists because the first would survive a refactor that moved the store while keeping the helpers' shape.
Neither is a filter: **there is no exclusion anywhere.** The content indexer walks with a plain readdir and has no
dotfolder or name-based skip (`files-content-indexer.service.ts:321`), and PROPFIND and the sync diff enumerate from
the same files-repository roots. The store is unseen **only** because it is a sibling of `files/` and `trash/`
(ADR §1). Anyone "simplifying" it to `<files>/.versions` breaks WebDAV, the indexer and desktop sync in one move, and
these two tests are the alarm.

### D1.5 DAV writes hold no server lock — documented, not fixed

`saveStream` creates a lock only in the **non-DAV** branch (`files-manager.service.ts:154`). A WebDAV request gets
`checkConflicts` (`:147-152`) and then writes **unlocked**. Two consequences, both accepted by ADR §4:

1. The `webdav` origin's snapshot is **best-effort under concurrency**. Do not document or claim "under lock"
   semantics for it. E2E-14's DAV case asserts *no corruption*, not a strict version count.
2. It is precisely why the snapshot must **copy first and hash the copy**, never hash the live file in a separate pass
   (ADR §1.2). The unlocked window between two reads of the live file is reachable *by design here*, and a blob stored
   under a digest that does not describe it is the one corruption in this design that escapes its own row — every
   later snapshot of the genuinely-matching content would dedup against it and serve the wrong bytes.

Fixing (1) would mean taking a server lock on DAV writes, which is an upstream behaviour change well outside this
feature's blast radius. Not attempted.

### D1.6 DeltaV `version-history` REPORT — out of scope

Confirmed still out of scope for v1, per the plan. Nothing consumes it: Sync-in's own clients use the REST API, and
the NC mobile clients use the NC versions DAV tree (see D2), not DeltaV. Implementing RFC 3253 would add a protocol
surface with no reader.
