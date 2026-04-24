---
name: sync-in-fork-maintenance
description: Maintain the zjean/server fork of Sync-in/server — trigger the upstream-sync workflow, resolve the upstream-main→main merge conflicts it produces, and investigate what custom UI code under `frontend/src/app/applications/custom-v2/` needs to adapt when upstream changes backend contracts. Use this skill whenever the user asks to "sync upstream", "pull upstream changes", "merge upstream", "run the upstream workflow", "fix the upstream-sync PR", "resolve upstream conflicts", or "check what upstream changed / what we need to update in v2/v3". Also use when looking at an open chore:sync upstream PR that's CONFLICTING, or when a user says something broke after an upstream sync. Prefer this skill over improvising — the workflow has repo-specific gotchas (SSH host alias, `--repo zjean/server` flag, `upstream-main` is workflow-writable only, merge commits not squashes) that are easy to get wrong.
---

# Sync-in fork maintenance

This skill covers three related tasks on the **zjean/server** fork of **Sync-in/server**:

1. **Run the upstream sync** — trigger the `Upstream Sync` GitHub Actions workflow and monitor what it produces.
2. **Resolve conflicts** when the auto-opened `chore: sync upstream (YYYY-MM-DD)` PR is CONFLICTING — `upstream-main` is a pure mirror, so conflicts must be resolved on a third branch.
3. **Investigate custom-UI impact** — determine whether the upstream commits break anything in `frontend/src/app/applications/custom-v2/` and propose concrete patches for wire-contract / method-signature mismatches.

Only one of these is usually live at a time. Figure out which the user wants from context, then jump in. If the user just says "sync upstream", start with task 1 and progress through 2 and 3 as the workflow produces a conflict or the diff reveals backend changes.

## Core repo conventions

These override default instincts — read once, apply throughout.

### SSH host alias

Both `origin` and `upstream` remotes use `git@github-prive:...` **not** `git@github.com:...`. The alias is defined in the user's `~/.ssh/config` and maps to `github.com` with the maintainer's fork-specific SSH key.

- `git push` uses SSH → requires the alias.
- `gh` CLI uses HTTPS → works regardless.
- Never write `git@github.com:` anywhere — wrong identity, pushes to wrong account.
- Verify with `git remote -v`; fix drift with `git remote set-url`.

### gh CLI gotchas

- **Every `gh pr create` must pass `--repo zjean/server`.** `gh` inherits its default repo from the `upstream` remote otherwise, which means PRs accidentally target `Sync-in/server`. The flag is authoritative — use it even when default is set. If a PR opens against upstream by mistake, close it with `gh pr close <n> --repo Sync-in/server --comment "wrong repo"` and reopen with `--repo zjean/server`.
- **`rtk proxy` for JSON-returning `gh` calls.** The user runs every shell command through the `rtk` proxy for token savings, but rtk reshapes JSON output of some `gh api` calls. When the real response matters, use `rtk proxy gh api ...` to bypass reshaping. Normal `gh pr create`, `gh run list`, `gh workflow run` work fine unmodified.
- **`git commit --allow-empty`** — rtk's git wrapper rejects the flag. Use `rtk proxy git commit --allow-empty` if ever needed.

### Branch protection

- **`main`** — direct pushes are blocked. Everything goes through a PR. The `test` status check must pass before merge.
- **`upstream-main`** — a pure mirror of `upstream/main`, writable only by the `upstream-sync.yml` workflow. Human pushes are blocked by PR-equivalent rules. **You cannot resolve conflicts by pushing to `upstream-main`** — see task 2.
- Feature branches auto-delete on merge.

### Merge strategy (per PR type)

- **feat / fix / mod / docs / chore** → **Squash and merge.**
- **Upstream sync PRs (branch → main with upstream lineage)** → **Create a merge commit.** Preserves the merge point so upstream history stays legible on `main`.

GitHub remembers the last-used strategy per user. Double-check the dropdown on upstream-sync PRs — easy to leave on "squash" from the previous PR and lose the merge point.

## Task 1 — Run the upstream sync

The `Upstream Sync` workflow (`.github/workflows/upstream-sync.yml`) runs weekly on cron plus on-demand. What it does:
1. Checks out `upstream-main` on a runner.
2. Fetches `upstream/main` from `Sync-in/server`.
3. Fast-forwards `upstream-main` to match `upstream/main`.
4. Force-pushes `upstream-main` to the fork.
5. If `main` already contains everything in `upstream-main`, exits.
6. Otherwise, opens (or updates) a PR `upstream-main` → `main` titled `chore: sync upstream (YYYY-MM-DD)`.

### Procedure

```bash
# Trigger the workflow
gh workflow run "Upstream Sync" --repo zjean/server

# Find the run ID, then watch it (typically <30s)
gh run list --repo zjean/server --workflow "Upstream Sync" --limit 1
rtk proxy gh run watch <RUN_ID> --repo zjean/server --exit-status
```

Once the workflow finishes, check whether it opened a PR:

```bash
gh pr list --repo zjean/server --base main --head upstream-main --state open
```

- **No PR** → upstream had nothing new. Report that and stop.
- **PR open, MERGEABLE** → report PR number, URL, diff stat. Merge when ready via "Create a merge commit". Task 3 investigation still applies if backend files changed.
- **PR open, CONFLICTING** → proceed to task 2.

Use `gh pr view <n> --repo zjean/server --json mergeable,mergeStateStatus,additions,deletions,changedFiles,body` for the merge state. `MERGEABLE` + `BLOCKED` usually means CI is still running, not a conflict.

## Task 2 — Resolve upstream-main → main conflicts

**Why this is annoying:** the workflow-opened PR has `upstream-main` as its head. If you try to resolve conflicts on `upstream-main` itself, the push is rejected (protected branch, workflow-only). Conflicts must be resolved on a third branch.

### Procedure

```bash
# 1) Make sure you have the latest refs.
git fetch origin main upstream-main

# 2) Close the workflow-opened PR — it will be superseded.
gh pr close <N> --repo zjean/server \
  --comment "Superseded by a new PR with conflict resolution (upstream-main → main required a merge-base branch since upstream-main is workflow-only)."

# 3) Branch off main and merge upstream-main into it with --no-ff.
git checkout -b sync/upstream-$(date +%Y-%m-%d) origin/main
git merge origin/upstream-main --no-ff --no-edit
# Expect: "Automatic merge failed; fix conflicts and then commit the result."
```

### Resolve the conflicts

List conflicted files: `git diff --name-only --diff-filter=U`.

Typical conflicts live in:
- `frontend/src/i18n/*.json` — upstream adds a key we already added (often with a different translation).
- `package-lock.json` — usually auto-resolved by `git merge`; if not, re-run `npm install` after resolving other files.
- Core backend files — rare but serious; review carefully.

For i18n conflicts, prefer **upstream's translation** for overlapping keys (matches classic UI terminology), keep our additions (v3/admin/etc keys) intact.

When resolving, keep both sets of additions wherever possible — a sync should never silently drop a custom key. If you must drop one, log it in the PR body.

### Verify before committing

Always run:

```bash
rtk proxy npm --prefix frontend run build   # Angular TS / template check
rtk proxy npm --prefix frontend run lint    # catches duplicate JSON keys as warnings; prettier errors
rtk proxy npm --prefix backend run build    # NestJS compile
```

Fix anything new that surfaces, then commit the merge and push:

```bash
git add -A
git commit --no-edit   # uses default merge commit message
git push -u origin sync/upstream-$(date +%Y-%m-%d)
```

### Open the replacement PR

```bash
gh pr create --repo zjean/server \
  --base main --head sync/upstream-$(date +%Y-%m-%d) \
  --title "chore: sync upstream ($(date +%Y-%m-%d)) — conflict resolution" \
  --body "$(cat <<EOF
## Summary

Supersedes #<N> (closed — the workflow-opened upstream-main → main PR was CONFLICTING, and upstream-main is workflow-writable only).

This branch merges origin/upstream-main into a short-lived sync/upstream-YYYY-MM-DD off main, with conflicts resolved in:
- <list conflicted files>

### Upstream commits pulled in
<paste git log --oneline origin/main..origin/upstream-main output>

### Conflicts resolved
<per-file explanation of what got picked and why>

### Impact on our custom UI
<output from task 3, or "None" after investigation>

### Merge strategy
Per CLAUDE.md — **Create a merge commit**. Preserves upstream-main lineage; full upstream history stays available on upstream-main regardless.
EOF
)"
```

Tell the user: "PR #<new> is up. Remember — **merge commit**, not squash, when you merge it."

## Task 3 — Investigate custom-UI impact (deep)

Triggered when upstream's diff touches backend files that our `custom-v2/` (v2/v3) frontend might call into, or when the user asks what needs adapting after a sync.

### Phase 1 — Inventory upstream commits

```bash
git log --oneline origin/main..origin/upstream-main
```

For each commit, list touched files:

```bash
for sha in $(git log --format=%H origin/main..origin/upstream-main); do
  echo "=== $sha ==="
  git show --stat $sha | head -30
done
```

Filter to "interesting" commits: anything touching `backend/src/applications/*`, `backend/src/*/dto/`, `backend/src/*/constants/`, `backend/src/*/interfaces/`, or the shared `@sync-in-server/backend` surface the frontend imports from.

Skip purely-upstream-frontend diffs (non-`custom-v2`) and pure dep bumps unless they cross major versions.

### Phase 2 — For each interesting commit, diff and classify

```bash
git show <sha> -- <backend-file>
```

Classify each change into one of three buckets:

| Bucket | Meaning | Custom-UI impact |
|---|---|---|
| **Wire contract changed** | HTTP method, URL, DTO shape (fields added/renamed/removed with semantic meaning), response shape | **Almost certainly breaks us.** Grep our callers; patch. |
| **Internal refactor, signature change** | Service method signature changed (e.g. `foo(user, url: string)` → `foo(user, dto: FooDto)`) but HTTP surface unchanged | **Doesn't affect frontend.** Note in report, skip. |
| **Behaviour change** | Same contract, new validation / error codes / side effects (e.g. "Content-Length now required", "quota now checked pre-download") | **Probably compatible; verify error handling.** Check we surface the new error paths. |

Behaviour changes often have subtle consequences — read the diff carefully. New `throw new HttpException(...)` paths mean new 4xx/5xx responses callers might not handle.

### Phase 3 — Grep custom-v2/ for every changed symbol

For each DTO, class, method, constant, or HTTP endpoint path the upstream commit touched:

```bash
rtk proxy grep -rnE "<SymbolOrPath>" \
  /Users/janwiebe/prive/sync-in-server/frontend/src/app/applications/custom-v2/ \
  /Users/janwiebe/prive/sync-in-server/frontend/src/app/applications/admin/ \
  /Users/janwiebe/prive/sync-in-server/frontend/src/app/applications/files/services/
```

Also check:
- `frontend/src/app/applications/custom-v2/` — our v2/v3 screens and services
- Classic shared services under `frontend/src/app/applications/*/services/` that custom-v2 reuses (e.g. `spaces.service.ts`, `admin.service.ts`, `files.service.ts`) — these are the glue where a backend rename lands

If no custom-v2 code calls the changed symbol, report "No impact" and move on.

### Phase 4 — Propose concrete patches (deep mode)

When a wire contract actually changed, **write out the exact edit** the user needs to apply. Include:

- File path + line number (use `grep -n` output you already captured).
- Before/after snippet showing the change.
- Whether it's a DTO field added (usually safe, defaults propagate), renamed (breaks — update frontend), or removed (breaks — delete frontend references).
- If it's a behaviour change (new error path), suggest adding a handler or an i18n key for the new error message.

Present the patches as a list the user can accept or reject — don't silently apply them during an upstream-sync investigation. The goal is to give the user a punch list.

### Phase 5 — Report

Structure the final report like this:

```markdown
## Upstream changes — custom-UI impact

### Commits reviewed
- <sha> <short>
- ...

### Wire-contract changes
(none, or per-change bullets with proposed patches)

### Internal refactors (no frontend impact)
(terse list)

### Behaviour changes (verify error handling)
(per-change bullets with what to watch for)

### Recommended follow-ups
- [ ] Apply patch to <file>:<line> — <one-liner>
- [ ] Add i18n key "<backend error string>" to en/nl (low priority)
- ...
```

Keep it scannable. If nothing needs adapting, say "No impact" explicitly and stop.

## Quick-reference snippets

### Get the sync-in-progress status

```bash
gh workflow list --repo zjean/server
gh run list --repo zjean/server --workflow "Upstream Sync" --limit 5
gh pr list --repo zjean/server --base main --head upstream-main --state all --limit 3
```

### See what would come in from an upstream sync without triggering it

```bash
git fetch upstream main
git log --oneline origin/main..upstream/main | head -30
git diff --stat origin/main...upstream/main
```

(This uses the `upstream` remote, which is read-only, not `upstream-main` which is the mirror branch on `origin`.)

### Emergency: re-run failed sync workflow

```bash
# Find the failed run
gh run list --repo zjean/server --workflow "Upstream Sync" --status failure --limit 3
# Re-run
gh run rerun <RUN_ID> --repo zjean/server
```

## References

See `references/` for extended material:
- `upstream-sync-workflow.md` — annotated walkthrough of the `upstream-sync.yml` workflow file
- `conflict-resolution.md` — real examples from past syncs showing common conflict patterns
- `custom-ui-impact-investigation.md` — a checklist of "classic" shared services custom-v2 reuses, for faster impact grepping
