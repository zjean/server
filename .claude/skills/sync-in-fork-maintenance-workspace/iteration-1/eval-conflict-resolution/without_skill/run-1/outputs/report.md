# Resolving a conflicting upstream-sync PR (zjean/server #99)

## Why it's stuck

`upstream-sync.yml` force-pushes `upstream/main` onto `origin/upstream-main` and opens a PR `upstream-main` → `main`. It does **not** merge `main` into that branch, so whenever upstream touches a file our fork has also changed, the PR goes red with "conflicts that must be resolved". GitHub blocks the merge because `main` is protected: the `test` status check must pass *and* all conversations must be resolved, and a dirty merge fails both.

Two other constraints shape the fix:

- The branch `upstream-main` is a pure mirror — direct pushes are blocked; only the sync workflow writes to it. We therefore cannot resolve the conflicts by pushing commits onto `upstream-main`.
- Repo convention (see `cc2ab27` / PR #67, branch `sync/upstream-2026-04-24`): resolve via an intermediate branch `sync/upstream-<date>`, merge `upstream-main` into it with `--no-ff`, resolve there, then merge *that* branch into `main` as a merge commit.

PR #99 itself cannot be fixed in place — it gets **closed, replaced by a `sync/upstream-<yyyy-mm-dd>` PR** that carries the conflict resolution.

## Prep (once)

```bash
cd /Users/janwiebe/prive/sync-in-server
git config rerere.enabled true      # survival kit: remembers conflict resolutions
git remote -v                        # sanity: both remotes must be git@github-prive:...
gh repo set-default zjean/server     # PRs target the fork, never upstream
gh repo set-default --view           # verify → zjean/server
```

## Step-by-step resolution

### 1. Inspect PR #99 and grab current refs

```bash
gh pr view 99 --repo zjean/server
gh pr diff 99 --repo zjean/server | head -200
git fetch origin main upstream-main
git fetch upstream main

git log --oneline origin/main..origin/upstream-main       # upstream commits to absorb
git diff --name-only origin/main...origin/upstream-main   # files touched
```

### 2. Create the resolution branch off `main`

```bash
DATE=$(date +%Y-%m-%d)
git checkout main
git pull --ff-only
git checkout -b "sync/upstream-$DATE"
```

### 3. Merge `upstream-main` in with `--no-ff`

```bash
git merge --no-ff origin/upstream-main -m "Merge remote-tracking branch 'origin/upstream-main' into sync/upstream-$DATE"
```

Git will stop on the conflicts that blocked PR #99. `git status` lists them; inspect with `git diff --cc <path>` (combined diff, shows both parents).

### 4. Resolve by conflict shape

**a. `LICENSE`, `NOTICE`, upstream copyright headers** — AGPL compliance: **always take upstream.**
```bash
git checkout --theirs LICENSE && git add LICENSE
# For copyright header drift inside source files, keep upstream's header and re-apply our edits below it.
```

**b. `package.json` version fields (root, backend, frontend)** — Upstream bumped (e.g. `2.2.1` → `2.2.2`). Plan rule: **accept upstream's version**, then follow-up commit appends `-custom.0`; next release is `2.2.2-custom.1`.
```bash
git checkout --theirs package.json backend/package.json frontend/package.json
git add package.json backend/package.json frontend/package.json
```

Lockfiles — regenerate, don't hand-edit:
```bash
git checkout --theirs package-lock.json backend/package-lock.json frontend/package-lock.json 2>/dev/null || true
npm install --package-lock-only
(cd backend && npm install --package-lock-only)
(cd frontend && npm install --package-lock-only)
git add package-lock.json backend/package-lock.json frontend/package-lock.json
```

**c. `custom-*` paths and `_custom-overrides.scss`** — Ours; upstream never writes here. A conflict means a rename/case-fold oddity. **Take ours.**
```bash
git checkout --ours backend/src/applications/custom-auth \
                    frontend/src/app/applications/custom-v2 \
                    frontend/src/styles/_custom-overrides.scss
git add backend/src/applications/custom-auth \
        frontend/src/app/applications/custom-v2 \
        frontend/src/styles/_custom-overrides.scss
```

**d. Files we `mod(...)`'d in place.** List them first:
```bash
git log --grep '^mod(' --name-only --pretty=format:'--- %h %s' main
```
Open each conflicted file and **re-apply our modification on top of upstream's new version** — not `--ours` (loses upstream's fix), not `--theirs` (loses our mod). If the mod is a token/CSS override, consider moving it into `_custom-overrides.scss` while you're here (plan prefers additions over modifications).

**e. i18n files (`en.json`, `nl.json`)** — Merge by union: keep every upstream key, re-add every `custom.*` key from our side. Parse check (repo has had duplicate-key bugs, see commit `1a059df`):
```bash
node -e "JSON.parse(require('fs').readFileSync('frontend/src/assets/i18n/en.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('frontend/src/assets/i18n/nl.json','utf8'))"
```

**f. `.github/workflows/*.yml`** — Ours differ by design. **Take ours** unless upstream added a workflow we want.
```bash
git checkout --ours .github/workflows/upstream-sync.yml .github/workflows/build-image.yml .github/workflows/release.yml
git add .github/workflows/upstream-sync.yml .github/workflows/build-image.yml .github/workflows/release.yml
```

**g. Delete/modify conflicts (`DU` / `UD` in `git status`)** — Decide per file: if upstream removed a file we still need, `git add <path>` (keep ours); if we removed a file upstream resurrected, `git rm <path>` unless there's a reason to accept it back.

### 5. Build and test locally before committing

```bash
(cd backend  && npm install && npm run lint && npm test)
(cd frontend && npm install && npm run lint && npm run build)
```

Fix anything failing in-tree, `git add`, then finalize:
```bash
git commit
```

### 6. Push and open the replacement PR

```bash
git push -u origin "sync/upstream-$DATE"

gh pr create --repo zjean/server \
  --base main --head "sync/upstream-$DATE" \
  --title "chore: sync upstream ($DATE)" \
  --body "$(cat <<'EOF'
Replaces #99 (couldn't resolve in place — `upstream-main` is a protected mirror branch).

Merges `origin/upstream-main` into `main` via this intermediate branch with conflicts resolved.

## Conflict summary
- <bullets per shape you hit: LICENSE, package.json versions, custom-* paths, mod(...) files, i18n, workflows>

## Local verification
- [x] backend lint + tests
- [x] frontend lint + build
- [x] i18n JSON parses (en + nl), no duplicate keys
EOF
)"
```

### 7. Close PR #99 with a pointer

```bash
NEW=<new-pr-number>
gh pr close 99 --repo zjean/server \
  --comment "Superseded by #$NEW — resolved via sync/upstream-$DATE (upstream-main is a protected mirror, so conflicts can't be fixed on that branch)."
```

Make sure `--repo zjean/server` is present. **Never** close against `Sync-in/server`.

## Merging the replacement PR

Three preconditions:

1. `test` status check green.
2. All PR conversations resolved.
3. Merge-method dropdown set to **"Create a merge commit"** — not squash. Upstream sync PRs are the one exception to the repo's default squash policy; the merge commit preserves the merge point and keeps upstream history legible. GitHub remembers your last choice, so if you just squash-merged a feature PR, the dropdown defaults to squash — flip it.

```bash
gh pr merge <new-pr-number> --repo zjean/server --merge   # NB: --merge, not --squash
```

## Post-merge housekeeping

```bash
git checkout main
git pull --ff-only

# Tag the merge (fork-maintenance plan §2):
UPSTREAM_VER=$(node -p "require('./package.json').version")
git tag "merge/upstream-$UPSTREAM_VER" HEAD
git push origin "merge/upstream-$UPSTREAM_VER"
```

If upstream bumped the version, open a follow-up PR (feature branch, squash merge) that:

- Sets `package.json` version to `<new-upstream>-custom.0` in root + backend + frontend.
- Resets `CHANGELOG.md`'s Unreleased section; first release on that base is `-custom.1`.

Feature branches auto-delete on merge, so `sync/upstream-$DATE` disappears on its own. `upstream-main` stays as the mirror; the next workflow run force-pushes it again.

## Common gotchas

- **Don't push to `upstream-main`.** Branch protection blocks it; even `--force-with-lease` will be rejected.
- **SSH host alias.** Every git remote must be `git@github-prive:...`. `gh` uses HTTPS and is fine; `git push` via `git@github.com:...` fails with "Permission denied (publickey)".
- **Don't `--amend` the merge.** If CI fails post-push, fix forward with a new commit on the sync branch. Amending rewrites the merge commit and forces a push.
- **rtk wrapper quirks.** `git commit --allow-empty` is rejected — use `rtk proxy git commit --allow-empty`. `gh api` JSON may be reshaped — use `rtk proxy gh api ...` when the raw response matters.
- **PR targeting.** `gh pr create` without `--repo zjean/server` can silently resolve to `Sync-in/server` (we have an `upstream` remote). Always pass `--repo zjean/server`.
- **rerere pays off on round two.** If the sync workflow fires again next week with overlapping files, it replays your resolutions. Don't disable it.
