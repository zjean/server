# PR merge chain — session handoff (2026-04-24)

## TL;DR

Executing **Option 3** (hybrid PR chain) to land all pending v2 redesign work +
the NC mobile compat onto `main`. 3 PRs merged, ~5 still to go. Each remaining
PR uses the **cherry-pick approach** (not rebase) because the stacked branches
share ancestors that are already upstream via squash-merge — linear rebase
produces noisy "patch already upstream" conflicts.

## What's merged to `main` (squash commits, in chronological order of merge)

```
ef1b...  (#39) feat(v3): v2 spaces browser at /v2/spaces/:alias (phase 4.14)
5e816da  (#38) feat(v3): new folder + rename + prompt-dialog (phases 4.3/4.4)
42460d2  (#37) feat(v3): copy/move + tree picker on /v2/personal (phase 4.5)
```

Verify current state:

```bash
git fetch origin main
git log --oneline origin/main -5
```

If `#39` is not yet merged, **wait** — auto-merge was set but `test` may still
be running. Check with `gh pr view 39 --repo zjean/server --json state`.

## Remaining PRs to open (in order)

Each one is cherry-picked onto the then-current `main`. Execute sequentially
(each depends on the previous one landing so conflicts don't stack).

### PR 4 — viewers bundle (phases 4.9 + 4.10 + 4.11 + remaining plans)

```bash
git checkout main && git pull
git checkout feat/v3-pdf-office-viewers
git reset --hard main
# cherry-pick unique commits (check SHAs match on your local; use
# `git log feat/v3-pdf-office-viewers@{u}` if reset has already happened)
git cherry-pick 5c33f81 5807f4c 1296d07 cfeccb9
#                ^4.10    ^4.11-m  ^plans  ^4.9+4.11-office
npx ng lint          # from frontend/ — verify
git push --force-with-lease origin feat/v3-pdf-office-viewers
gh pr create --repo zjean/server --base main --head feat/v3-pdf-office-viewers \
  --title "feat(v3): viewers — text (4.10), media (4.11), PDF+OnlyOffice (4.9+4.11-office)" \
  --body "$(cat <<'EOF'
## Summary
- Text preview via CodeMirror (@acrodata/code-editor) in /v2/file for text mimes
- HTML5 video + audio preview for media mimes
- OnlyOffice embed for office docs; floating pen icon on PDF view flips to OnlyOffice editor for writeable users
- Graceful degradation: 404 from OnlyOffice settings → "not available" fallback with Download CTA
- Plan document: `2026-04-23-v3-remaining-plans.md` (4.7, 4.8, 4.9+4.11-office, 4.12, 4.13)

## Test plan
- [ ] /v2/file text file renders in CodeMirror, read-only
- [ ] Video/audio file plays inline
- [ ] .docx opens in OnlyOffice (if available) else shows fallback
- [ ] PDF shows floating switcher to OnlyOffice for writeable users
EOF
)"
gh pr merge <n> --auto --squash --delete-branch --repo zjean/server
```

### PR 5 — settings + FileModel (phases 4.12 + FileModel stub)

```bash
git checkout main && git pull
git checkout feat/v3-file-model-ops
git reset --hard main
git cherry-pick 297b5aa 0b9c30d 305e96a cff8650 d422bc6
#                ^4.12   ^fix(i18n) ^FileModel ^fix(import)  ^handoff-doc
```

Verify those SHAs with `git log feat/v3-file-model-ops` — they should be the
last 5 commits beyond `feat/v3-account-settings`. If unsure, use:

```bash
git log --oneline feat/v3-account-settings..feat/v3-file-model-ops
```

…and pick the commits that aren't in main yet. The `d422bc6` handoff doc
commit can optionally be dropped (it's pure markdown). Title:

```
feat(v3): inline account settings + FileModel stub utility (phase 4.12)
```

**Tricky:** `feat/v3-account-settings` has 17 unique commits and
`feat/v3-file-model-ops` has 20 — only 3 are genuinely new on top of
account-settings. The 17 from account-settings need to be included here too
(they're part of phase 4.12's body of work).

The pragmatic approach: use `git log main..feat/v3-file-model-ops --oneline
--reverse` — that's your cherry-pick list in order. Skip any commits that
`git cherry` reports as already upstream.

### PR 6 — sharing (phases 4.7 + 4.8)

```bash
git checkout main && git pull
git checkout feat/v3-share-dialog
git reset --hard main
# 4.8 link dialog — 3 commits
# 4.7 share dialog — 2 commits
# Get list via: git log --oneline feat/v3-file-model-ops..feat/v3-share-dialog
git cherry-pick <link-dialog-1> <link-dialog-2> <link-dialog-3> <share-dialog-1> <share-dialog-2>
```

Title: `feat(v3): link-dialog (4.8) + share-dialog (4.7) on /v2`.

### PR 7 — NC mobile compat (independent from the v2 stack)

```bash
git checkout main && git pull
git checkout docs/mobile-api-plan
git rebase main          # should be clean — no v2 overlap
npx tsc --noEmit -p backend/tsconfig.build.json
NODE_ENV=test npx jest --verbose custom-mobile-compat
git push --force-with-lease origin docs/mobile-api-plan
gh pr create ... --title "feat(custom-mobile-compat): Nextcloud mobile client compatibility module"
```

### PR 8 — orphan fixes bundle

```bash
# two small fix branches
git log --oneline main..fix/v3-create-space-payload-and-file-nav
git log --oneline main..fix/v3-create-space-payload-roots-enabled
```

Decide: merge them separately as small PRs, or cherry-pick both onto a single
bundle branch `fix/v3-create-space-bundle`. Bundle is faster.

## Why cherry-pick, not rebase

Linear rebase (`git rebase main`) on these stacked branches hits the
"patch already upstream" case dozens of times — each needs `git rebase
--skip` or conflict resolution on files that are already correctly on main.
The cherry-pick approach:

1. `git reset --hard main` — throw away the branch's history
2. `git cherry-pick <sha1> <sha2> …` — replay only the commits this PR should
   add

…is mechanically cleaner and produces conflict-free rebases when the unique
commits don't overlap with newly-merged work. Conflicts still happen when,
e.g., two different phases both add keys to the same `nl.json` chunk — those
are normal and resolve via union (keep both sides).

## Known conflict patterns (from PRs 37–39)

| File | What conflicts | Resolution |
|---|---|---|
| `layout-v2.component.html` | `<app-v2-X />` mount lines near the bottom | Union — keep every component's line |
| `layout-v2.component.ts` | `imports: […]` array | Union — keep every component in the list |
| `personal.component.ts` | `menuItems` array + private injects | Union + sensible menu order |
| `nl.json` / `en.json` | New i18n keys | Union — keep both blocks of keys |

## Pre-flight checks before every push

```bash
cd frontend
npx ng lint                                     # Angular-aware (what CI uses)
npx tsc --noEmit -p tsconfig.app.json
cd ../backend
npx tsc --noEmit -p tsconfig.build.json
NODE_ENV=test npx jest <relevant-module>        # if touched
```

**Don't** run plain `prettier --write` on the full HTML tree — it reformats
HTML via a different parser than `ng lint` uses and creates a spurious diff
across ~15 unrelated files. If prettier flags a specific file you touched,
fix that file alone.

## Backend CI job name

Required check: **`test`** (runs `npm run lint` → `ng lint` + backend eslint +
jest). Job ID examples on GitHub:
`https://github.com/zjean/server/actions/runs/<id>/job/<id>`.

## Auto-merge status

Repo has auto-merge enabled. Use:

```bash
gh pr merge <n> --repo zjean/server --auto --squash --delete-branch
```

…right after opening each PR. GitHub merges when `test` is green AND there
are no unresolved review comments.

## SSH + gh

Remote: `git@github-prive:zjean/server.git`. The `github-prive` alias in
`~/.ssh/config` resolves to the correct key. Never hardcode `github.com`.

For PR creation, always pass `--repo zjean/server` explicitly — even though
`gh repo set-default` is set — to guard against the upstream-remote
reassignment gotcha documented in `CLAUDE.md`.

## Branches on origin (17 as of this handoff)

Already merged / to-be-deleted after their PR lands:
- `feat/v3-spaces-browser` → PR #39 pending
- `feat/v3-text-editor`, `feat/v3-media-viewer`, `feat/v3-pdf-office-viewers` → PR 4
- `feat/v3-account-settings`, `feat/v3-file-model-ops` → PR 5
- `feat/v3-link-dialog`, `feat/v3-share-dialog` → PR 6
- `docs/mobile-api-plan` → PR 7
- `fix/v3-create-space-payload-and-file-nav`, `fix/v3-create-space-payload-roots-enabled` → PR 8

Keep (ref docs only, no active work): `docs/pr-target-rule`, `docs/v3-copy-move-plan`, `docs/v3-remaining-plans` (pure docs — decide whether to merge or leave as working notes).

## Open session state (local)

- **Current branch**: `docs/mobile-api-plan` (just checked out for this handoff write)
- **Uncommitted**: none on mobile-api-plan
- **`feat/v3-new-folder`**, **`feat/v3-spaces-browser`** have been force-pushed after rebase — their local SHAs match origin after the last push
- **No stash**, no rebase-in-progress

## Fresh-session bootstrap

```bash
cd /Users/janwiebe/prive/sync-in-server
git fetch origin --prune
git checkout main && git pull
git log --oneline -10           # confirm #37 #38 #39 all merged
gh pr list --repo zjean/server --state open   # confirm no blockers
```

Then continue with PR 4 per the recipe above.

## Backstop — if cherry-pick conflicts get unwieldy

Give up on granularity and squash everything into **one** monster PR:

```bash
git checkout main && git pull
git checkout -b feat/v3-milestone4-bundle
# bring in every remaining feat/* branch's work via merge -X theirs or
# selective cherry-pick of just the feature deltas
# push + open one PR that squashes milestone 4 into a single commit on main
```

Loses per-phase commits on main but ships the work.

## 3 known residuals I should NOT forget after merging

From `docs/plans/2026-04-23-mobile-nextcloud-compat-design.md`:

1. Move NC login-flow LRU to Redis for multi-instance deployments (currently in-process only — single-replica deploys only).
2. UI in `/v2/settings` for the `user.settings.mobileHome` config (back-end supports it; no toggle shipped).
3. Cron to prune stale chunked-upload staging dirs under `<dataDir>/nc-uploads/`.

Not blocking anything — file as backlog items after the PR chain is done.
