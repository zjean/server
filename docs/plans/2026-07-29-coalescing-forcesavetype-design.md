# Coalescing: discriminate human saves from timer saves via `forcesavetype`

Closes the design half of #389. Supersedes the premise of ADR §5.1 for the `onlyoffice` origin only; every other
origin's window is unchanged.

- **ADR:** `docs/plans/2026-07-25-file-versioning-design.md` §5 / §5.1 — the coalescing rules and the per-origin window
- **Measurement:** `docs/plans/2026-07-29-adr-19-editor-soak.md` §3, §6 — the cadences, and the four-saves-zero-versions result
- **Deferred from:** #348. Maintainer direction recorded in #389, 2026-07-29.

---

## 1. The defect, in one paragraph

ADR §5.1 justifies giving the editors a 300 s coalescing window with a single sentence: *"an editor's cadence is set by
the document server, not by a human."* The §19 soak measured that sentence. It is **true for Collabora** (which saves
~15 s after the last keystroke, unprompted, forever) and **false for OnlyOffice**, which has no automatic save of any
kind — so every version OnlyOffice mints is a human pressing Save. The 300 s window is therefore applied *exclusively to
human saves* for that editor, which is the category ADR §5.1 itself assigns 60 s. The user-visible consequence the soak
measured: **four explicit Ctrl+S saves inside two minutes produced zero new versions.** With #388 shipping an in-editor
version panel, that is now the first place a user would notice.

## 2. Three corrections to #389's premise

The issue and soak §6 both make claims that don't survive reading the code. Recorded here because the implementation
depends on all three.

### 2.1 `forcesavetype` is NOT "available at the snapshot site with no new plumbing"

`saveDocument(user, space, url)` (`only-office-manager.service.ts:355`) never receives `callBackData`. It is called from
four `case` arms — 2, 3, 6, 7 — and the snapshot hook sits inside it at `:414`. The discriminator has to be classified
at the `switch` and passed down. That is one added parameter, so the correction is *small*, but "no new plumbing" set the
wrong expectation about where the decision is made: **classification belongs at the callback switch**, because that is
the only place that knows the status, and the status is half the answer.

### 2.2 `forcesavetype` exists only on status 6 and 7

`only-office.interface.ts:212`, quoting OnlyOffice's own documentation: *"The type is present when the status value is
equal to 6 or 7 only."* #389 asks to verify it "arrives as documented on both status 6 and status 2 callbacks" — per the
contract it will not be on status 2. So there are **three** classes of save, not two:

| Callback | Discriminator | Class |
|---|---|---|
| 6 / 7, `forcesavetype: 1` | Save button clicked | human |
| 6 / 7, `forcesavetype: 3` | form submitted (Complete & Submit) | human |
| 6 / 7, `forcesavetype: 2` | by timer, from the document server's config | automatic |
| 6 / 7, `forcesavetype: 0` | to the command service (an API-triggered forcesave) | automatic |
| 6 / 7, field absent | contract says it cannot be, but the wire is not the contract | **unclassifiable** |
| 2 (modified) | none — session-close flush | **unclassifiable** |
| 3 | none — retry of a save whose origin is already lost | **unclassifiable** |

**Decision: unclassifiable is treated as human.** A status-2 flush is the tail of a human editing session and fires at
most once per session, so there is no storm there to suppress; a status-3 retry is a failed human save being
re-attempted. Both err toward keeping a revision, which is the direction this feature should fail in. It also means the
absent-field case degrades to today's *intended* behaviour rather than to a surprise.

### 2.3 OnlyOffice has no autosave because **this fork configures it that way**

`only-office-manager.service.ts:246-247` sends `customization: { autosave: false, forcesave: true }`. The soak's
"OnlyOffice has no automatic save of any kind" is a consequence of our own config, not a property of OnlyOffice. Two
ways it stops being true:

- someone flips `autosave` on, for a reason unrelated to versioning;
- an operator enables the document server's own forcesave-by-timer, which is exactly what emits `forcesavetype: 2`.

This is the argument against the cheaper fix of hardcoding "`onlyoffice` ⇒ human". **Read the discriminator.** A
hardcode is correct today and silently wrong after either change, with no test that would notice.

## 3. The rule

Two pieces, and the second one is the point.

**Classify at the callback switch.** `OnlyOfficeManager.callBack` maps `(status, forcesavetype)` to
`saveKind: 'interactive' | 'automatic'` per the table in §2.2 and threads it through `saveDocument` into
`SnapshotOptions`.

**An interactive editor save uses the scalar `minIntervalSeconds`, bypassing the per-origin override.**

That is not a new knob — it is ADR §5.1's own justification, applied correctly. The override exists *because* the
document server sets the cadence. When we have positive evidence a human set it, the premise for the override does not
hold, so the override does not apply and the interactive number governs. Reading §5.1 that way means:

- **no config shape change**, so nothing new is operator-visible and #384's trap (a key absent from
  `environment.dist.yaml` has its env var silently discarded) cannot be stepped in;
- **no schema change** — see §4;
- the numbers an operator already tuned keep meaning what they meant. Someone who set `minIntervalSeconds: 120` gets
  120 s on human saves in the editor too, which is what they asked for.

`SnapshotOptions.saveKind` is optional. **Omitted means "no discriminator available", which resolves exactly as today** —
so every one of the other nine origins, and Collabora, is untouched by construction rather than by a matching `if`.

### 3.1 Collabora degrades by having nothing to say

Collabora's `PutFile` carries no equivalent field. What the WOPI path actually reads is enumerated in
`collabora-online.constants.ts`: `x-cool-wopi-timestamp`, used at `collabora-online-manager.service.ts:274` for
**conflict detection** (does the host's mtime still match what the editor last saw), plus the lock headers. Nothing
distinguishes a human-triggered save from the autosave timer, and a code search of the current `CollaboraOnline/online`
tree finds no candidate header either — `IsAutosave` and `IsModifiedByUser` both return zero hits, against 9 for `wopi`,
so the search itself is working. Treat that as "no discriminator found", not as proof one cannot exist; if Collabora ever
wants one, this is the paragraph to revisit.

Collabora therefore never sets `saveKind` and keeps its 300 s window — which the soak confirmed is doing exactly its job
there, and which #389 asks to preserve.

This is the degradation #389 requires ("Collabora has no equivalent field, so the rule has to degrade sensibly there
rather than assume the discriminator exists"), and it costs nothing: absence of the field *is* the degradation.

## 4. What this deliberately does not do

**The kind is not persisted on the version row.** `isCoalesced` still finds the newest version by
`(fileId, authorId, origin)` — the tuple `custom_files_versions_coalesce_idx` is built on. Only the *window* keys on the
incoming save's kind.

The consequence, stated plainly: a human Save 10 s after a timer save still coalesces against it. That is defensible —
the window is a rate limit, and *"was anything captured in the last 60 s?"* is the question a rate limit should ask,
regardless of what captured it. Making a human Save compare only against other human saves is semantically cleaner but
costs a Drizzle migration, a widened index, and a new field on every surface that reads a version row (the NC versions
DAV tree, the v2 panel, the admin controller). Not worth it for a case that, with `autosave: false`, does not arise.

**`maxVersionsPerFile` still bounds the downside.** D4.3's RESOLVED note applies unchanged: coalescing less aggressively
mints more rows, and the per-file cap (default 20, enforced eagerly since #340) is what keeps that from being unbounded.
Nothing here needs to re-argue it.

**The window values are not changed.** `collabora: 300` and `onlyoffice: 300` both stay. #389 is explicit that the fix is
the discriminator, not a smaller number, and an `onlyoffice` save that we cannot prove was human keeps 300.

## 5. Verification

`forcesavetype` is being trusted from documentation, not from measurement. That is the one soft spot, and it is the
thing to check first:

1. **Soak against a real document server** — the rig in soak §2 / §8, re-derived per the "docserver LAN IP moves" note.
   Log the raw callback body and confirm: Ctrl+S yields status 6 with `forcesavetype: 1`; four saves inside two minutes
   now yield four versions; closing with unsaved changes yields status 2 with no `forcesavetype`.
2. **If `forcesavetype` does not arrive as documented**, the `actions: [{ type: 2, userid }]` entry on the same body
   ("the user clicks the forcesave button") is an independent discriminator for the human case and the fallback.
   Unremarked in #389 and worth knowing before designing around a missing field.
3. **Unit** — `only-office-manager.service.spec.ts` for the classification table (every row of §2.2), and
   `versioning.service.spec.ts` for the window resolution, including a regression case pinning that an omitted
   `saveKind` behaves exactly as before.
4. `npm run build -w backend` — vitest's type check does not catch service↔real-class mismatches.
