# Conflict resolution — common patterns from real syncs

## Pattern 1: i18n locale file conflicts (very common)

Upstream frequently adds new translation keys. If we've added the same key ourselves (typical when we port a feature that upstream also ships), both sides conflict on the same line.

### Example

```
<<<<<<< HEAD
  "View in PDF.js": "Bekijken in PDF.js",
=======
  "View in PDF.js": "Weergeven in PDF.js",
>>>>>>> origin/upstream-main
```

**Rule:** prefer upstream's translation for overlapping keys. Our translations often diverge from the Dutch terminology conventions established in classic — keeping upstream in sync reduces long-term friction and means less re-conflict on future syncs.

### Example — upstream adds where we added a block

We might have a 200-line block of `v3_*` keys for a new feature. Upstream adds a single new key in the same vicinity. The three-way merge fails even though the changes are disjoint.

Resolution:
- Keep all our `v3_*` / admin / custom additions verbatim.
- Insert upstream's new key in a sensible location (usually next to the key it logically belongs with in upstream's ordering).
- Watch for **duplicate keys** — if upstream adds a key we also added (different wording), delete ours. esbuild will warn about duplicates on next build.

### Checking for duplicates after resolution

```bash
rtk proxy npm --prefix frontend run build 2>&1 | grep "Duplicate key"
```

esbuild emits warnings (not errors), so builds pass — but the duplicate means the *first* occurrence wins silently. Easy to miss.

## Pattern 2: `package-lock.json`

Usually auto-resolved by `git merge`. When it's not:

1. Don't try to hand-merge a 100k-line JSON file. Madness.
2. Take upstream's version with `git checkout --theirs package-lock.json`.
3. Re-run `npm install` to reconcile with our `package.json` additions.
4. Commit the regenerated lockfile.

```bash
git checkout --theirs package-lock.json
npm install
git add package-lock.json
```

## Pattern 3: Backend controller / service file

Rare but serious. Usually happens when:
- Upstream refactors a controller we've added a `mod(...)` commit to (tweaked behaviour).
- Upstream renames a method we extended.

Resolution rule: **preserve the intent of both sides**.

- Understand what our `mod` commit accomplishes (check `git log --grep '^mod(' -- <file>`).
- Apply that intent on top of upstream's refactored version.
- Do not blindly accept upstream if it wipes our modification.
- Do not blindly keep ours if it undoes a legitimate upstream bug fix.

If it's not obvious, pause and ask the user — it's almost certainly worth a 2-minute conversation to avoid a silent regression.

## Pattern 4: Files under `custom-*/` paths

Should never conflict. Our convention is that `custom-*` paths are additive-only and upstream never touches them. If a conflict appears there, something is wrong — either:
- Upstream coincidentally added a file at the same `custom-` path (unlikely but possible).
- Our convention drifted and we touched an upstream file thinking it was custom.

Investigate rather than routinely resolve.

## After resolution — always verify

```bash
# No stray conflict markers anywhere
rtk proxy grep -rnE '<<<<<<< |>>>>>>> |^======= $' \
  backend/src frontend/src 2>&1 | head

# Builds green
rtk proxy npm --prefix frontend run build
rtk proxy npm --prefix backend run build

# Lint clean
rtk proxy npm --prefix frontend run lint
rtk proxy npm --prefix backend run lint
```

If any of these fail, fix before pushing. The sync PR runs CI on push, but catching issues locally is faster than the remote round-trip.

## Committing the merge

The default merge commit message from git is fine:

```
Merge remote-tracking branch 'origin/upstream-main' into sync/upstream-<date>
```

Don't squash — we explicitly want the merge commit as lineage to upstream.

## Aftermath: once `main` has the merge

The merge commit on `main` has two parents: the previous main tip and `upstream-main`'s tip. This means:
- `git log main` sees every upstream commit interleaved with our work — good for history.
- `git log main --first-parent` sees only our PR merges — good for "what did we ship" reviews.

Both views are useful; neither is wrong.
