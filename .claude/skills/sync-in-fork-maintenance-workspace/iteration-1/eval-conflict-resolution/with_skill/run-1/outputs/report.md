# Unsticking the CONFLICTING upstream-sync PR #99

Procedure for resolving a CONFLICTING `chore: sync upstream (YYYY-MM-DD)` PR (head `upstream-main`, base `main`) on `zjean/server`. Commands are copy-pasteable — substitute the real PR number for `99` and the real date for `YYYY-MM-DD`.

## 1. Why GitHub's "Resolve conflicts" button / merge cannot be used

The workflow-opened PR uses `upstream-main` as its head branch. Two pieces of repo state make in-place resolution impossible:

- **`upstream-main` is a pure mirror of `upstream/main`.** The only writer allowed is the `upstream-sync.yml` workflow (`/Users/janwiebe/prive/sync-in-server/.github/workflows/upstream-sync.yml`), which force-pushes the branch on every run (`git push --force-with-lease origin upstream-main`, line 48). Human pushes to it are blocked by branch protection.
- **`main` rejects direct pushes.** Everything lands via PR with the `test` check green. So you can't resolve conflicts by pushing directly to either side of the PR.

GitHub's web conflict editor works by committing to the head branch — which for #99 is `upstream-main`. That commit would be rejected by branch protection, and even if it weren't, the next upstream-sync run would force-push it away. Conflicts therefore have to be resolved on a **third, short-lived branch** cut from `main`, with `upstream-main` merged into it via `--no-ff`. #99 gets closed as superseded; the new branch becomes the replacement PR.

## 2. Local command sequence

Run from `/Users/janwiebe/prive/sync-in-server` on a clean working tree. Verify remotes first — both should point at `git@github-prive:...` (SSH host alias for the maintainer's fork-specific key); `git@github.com:...` is wrong and causes `Permission denied (publickey)`:

```bash
git remote -v
# origin   git@github-prive:zjean/server.git (fetch)
# origin   git@github-prive:zjean/server.git (push)
# upstream git@github-prive:Sync-in/server.git (fetch)
# upstream DISABLE (push)
```

Then:

```bash
# 0) Fresh refs.
git fetch origin main upstream-main

# 1) Close #99 as superseded. Replacement PR link goes in a follow-up comment
#    once it exists.
gh pr close 99 --repo zjean/server \
  --comment "Superseded — upstream-main is workflow-writable only, so conflicts have to be resolved on a sync/upstream-YYYY-MM-DD branch cut from main. Replacement PR incoming."

# 2) Cut the resolution branch off main and merge upstream-main with --no-ff
#    (we want an explicit merge commit preserved as lineage to upstream).
DATE=$(date +%Y-%m-%d)           # or the date from the PR title, for consistency
BRANCH="sync/upstream-${DATE}"
git checkout -b "${BRANCH}" origin/main
git merge origin/upstream-main --no-ff --no-edit
# Expect: "Automatic merge failed; fix conflicts and then commit the result."

# 3) See what conflicted.
git diff --name-only --diff-filter=U
```

Resolve the files (see section 3), then verify and push:

```bash
# 4) Verify no stray markers and that everything builds.
rtk proxy grep -rnE '<<<<<<< |>>>>>>> |^======= $' backend/src frontend/src | head
rtk proxy npm --prefix frontend run build
rtk proxy npm --prefix frontend run lint
rtk proxy npm --prefix backend  run build

# 5) Check esbuild for duplicate i18n keys (warnings, not errors — easy to miss).
rtk proxy npm --prefix frontend run build 2>&1 | grep -i "Duplicate key" || echo "no dupes"

# 6) Commit the merge (default merge message is correct) and push.
git add -A
git commit --no-edit
git push -u origin "${BRANCH}"
```

## 3. Handling common conflict patterns

### `frontend/src/i18n/*.json` (the usual culprit)

Two common shapes:

**Overlapping key, different translation.** Upstream added a key we also added, with a different wording:

```
<<<<<<< HEAD
  "View in PDF.js": "Bekijken in PDF.js",
=======
  "View in PDF.js": "Weergeven in PDF.js",
>>>>>>> origin/upstream-main
```

Rule: **take upstream's translation**. Our translations tend to drift from classic-UI Dutch terminology; aligning with upstream reduces future re-conflicts and keeps terminology consistent with the classic app (which is the ground truth).

**Disjoint additions near each other.** We added a block of `v3_*` keys; upstream added one key in the same vicinity. Keep both:

- Preserve every `v3_*`, `admin.*`, and `custom.*` key verbatim — a sync must never silently drop a custom key.
- Insert upstream's new key near the key it logically belongs with in upstream's ordering.
- If upstream added a key we also added with different wording, **delete ours** (take upstream) to avoid a duplicate. esbuild only warns on duplicates, so the first occurrence wins silently if you miss it.

If a custom key genuinely has to be dropped for any reason, list it explicitly in the replacement PR body.

### `package-lock.json`

Don't hand-merge a 100k-line JSON file. Take upstream's and regenerate:

```bash
git checkout --theirs package-lock.json
npm install
git add package-lock.json
```

### Backend controllers / services (rare but serious)

Usually means upstream refactored a file we've got a `mod(...)` commit on. Before resolving:

```bash
git log --grep '^mod(' -- <conflicted-file>
```

Understand what our `mod` was doing, then reapply that intent on top of upstream's refactored version. Never blindly `--theirs` (wipes our modification) or `--ours` (reverts an upstream fix). If the intent isn't obvious from the commit message, pause and ask the user — cheaper than debugging a silent regression later.

### Conflicts under `custom-*/` paths

Our convention is additive-only: upstream never touches `custom-*` paths. A conflict there means either upstream coincidentally added a file at the same path, or our convention drifted and a `mod(...)` touched something we thought was custom. Investigate — don't routinely resolve.

## 4. Open the replacement PR

Always pass `--repo zjean/server` explicitly. Without it, `gh` may resolve the default target from the `upstream` remote and open the PR against `Sync-in/server`, polluting their queue. If that happens: close with `gh pr close <n> --repo Sync-in/server --comment "wrong repo"` and reopen correctly.

```bash
DATE=$(date +%Y-%m-%d)   # same DATE as the branch
gh pr create --repo zjean/server \
  --base main --head "sync/upstream-${DATE}" \
  --title "chore: sync upstream (${DATE}) — conflict resolution" \
  --body "$(cat <<'EOF'
## Summary

Supersedes #99 (closed). The workflow-opened upstream-main -> main PR was CONFLICTING, and upstream-main is workflow-writable only, so conflicts were resolved on this short-lived sync/upstream-YYYY-MM-DD branch cut off main.

### Upstream commits pulled in
<paste git log --oneline origin/main..origin/upstream-main>

### Conflicts resolved
- frontend/src/i18n/en.json — <per-key explanation, who won and why>
- frontend/src/i18n/nl.json — <ditto>
- package-lock.json — took upstream, re-ran npm install
- <any others>

### Impact on our custom UI
<from the task-3 investigation, or "None — upstream diff touched only X/Y which custom-v2 does not call into">

### Verification
- [x] npm --prefix frontend run build green
- [x] npm --prefix frontend run lint clean
- [x] npm --prefix backend run build green
- [x] No stray conflict markers
- [x] No duplicate i18n keys (esbuild warning grep clean)

### Merge strategy
Per CLAUDE.md — **Create a merge commit**, NOT squash. Preserves the upstream-main lineage on main.
EOF
)"
```

## 5. Critical reminder when merging

**Use "Create a merge commit" — not "Squash and merge".**

GitHub remembers the last-used merge strategy per user, and the previous PR on this repo was almost certainly a feat/fix/mod/chore that got squashed. The dropdown will default to "Squash and merge" and silently squash away the merge point, destroying the lineage this whole procedure exists to preserve. Double-check the dropdown before clicking.

Rule of thumb for this repo:

- feat / fix / mod / docs / chore → Squash and merge.
- Upstream-sync PRs (branches with `upstream-main` ancestry landing on `main`) → **Create a merge commit.**
