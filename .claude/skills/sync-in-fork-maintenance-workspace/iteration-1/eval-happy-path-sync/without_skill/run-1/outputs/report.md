# Upstream sync — status report

**Short version: nothing to do. No open sync PR, and `main` already contains the latest upstream commit (`a2f86e1`).**

## 1. How I figured out what to do

I had no cheat sheet, so I reconstructed the workflow from the repo:

1. Read `/Users/janwiebe/prive/sync-in-server/CLAUDE.md` — told me an `upstream-sync.yml` workflow runs weekly + on `workflow_dispatch`, force-pushes `upstream/main` → `origin/upstream-main`, and opens a PR into `main`. PRs must target `zjean/server`.
2. Listed `.github/workflows/` and read `/Users/janwiebe/prive/sync-in-server/.github/workflows/upstream-sync.yml` — confirmed mechanics: checkout `upstream-main`, fetch upstream, `git reset --hard upstream/main`, force-push, then `gh pr create --base main --head upstream-main` only if the diff is non-empty.
3. Verified tooling: `gh repo set-default --view` → `zjean/server`. Remotes: `origin=zjean/server`, `upstream=Sync-in/server` (push disabled), both via the `github-prive` SSH alias — matches CLAUDE.md.
4. Checked recent workflow runs, open PRs, and raw git refs in parallel.

## 2. Commands I would actually run

I did NOT trigger the workflow because the investigation shows there's nothing to sync. If a manual trigger were warranted:

```bash
gh workflow run upstream-sync.yml --repo zjean/server --ref main
gh run list --repo zjean/server --workflow=upstream-sync.yml --limit 1
gh run watch <run-id> --repo zjean/server
```

If a resulting PR needed merging (per CLAUDE.md, upstream-sync PRs use **merge commit**, not squash; the `upstream-main` branch must survive):

```bash
gh pr merge <n> --repo zjean/server --merge --delete-branch=false
```

## 3. Current state of the sync queue

| Check | Result |
|---|---|
| Latest `upstream-sync.yml` run | Run `24904940070`, **success** at `2026-04-24T18:15:58Z` (today, earlier) |
| Open PRs on `zjean/server` | **None** |
| `git rev-parse upstream/main` | `a2f86e17654b0097a5eb7b2ef35c6da334342145` |
| `git rev-parse origin/upstream-main` | `a2f86e17654b0097a5eb7b2ef35c6da334342145` (mirror is current) |
| `git rev-list --count origin/main..origin/upstream-main` | **0** — main already contains every upstream commit |
| `git merge-base --is-ancestor a2f86e1 origin/main` | **YES** |

### What happened earlier today

Today's auto-sync *did* pick up new upstream work (tip `a2f86e1 refactor(backend:files): extract downloadFile and centralize SSRF...` plus `325df7b chore(deps): update` and merge `c70b7b9`). It opened PR **#66 `chore: sync upstream (2026-04-24)`** at 18:16Z, but that PR was **CLOSED** (not merged) at 18:23Z with `mergeable: CONFLICTING`.

The maintainer handled the conflict manually. `origin/main` history shows:
- `fe0f520 Merge remote-tracking branch 'origin/upstream-main' into sync/upstream-2026-04-24`
- `cc2ab27 Merge pull request #67 from zjean/sync/upstream-2026-04-24`
- `1a059df fix(i18n): remove nl.json duplicates introduced in phase 5.6`
- `d05beb3 Merge pull request #68 from zjean/fix/v3-i18n-dup-keys`

So: one auto-PR opened, conflicted, superseded by a manual merge PR (#67), with a follow-up fix (#68). All merged.

## 4. Is anything ready to merge?

**No.** There is no open upstream-sync PR. `origin/main` is equal to or ahead of `origin/upstream-main`. The sync queue is empty.

Re-running `gh workflow run upstream-sync.yml --repo zjean/server --ref main` now would hit the "No upstream changes" branch and not open a PR, given current ref equality.

## Relevant files

- `/Users/janwiebe/prive/sync-in-server/.github/workflows/upstream-sync.yml`
- `/Users/janwiebe/prive/sync-in-server/CLAUDE.md` (workflow + merge-strategy rules)
- `/Users/janwiebe/prive/sync-in-server/docs/plans/2026-04-22-fork-maintenance-design.md` (referenced; not read this pass)
