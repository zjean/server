# The `Upstream Sync` workflow — annotated walkthrough

File: `.github/workflows/upstream-sync.yml`

## Triggers

- **Weekly cron:** `0 6 * * 1` — every Monday at 06:00 UTC.
- **Manual:** `workflow_dispatch` — trigger via `gh workflow run "Upstream Sync" --repo zjean/server`.

No per-push trigger by design — we only want to pull upstream when we explicitly choose to.

## Permissions

```yaml
permissions:
  contents: write      # needs to force-push upstream-main
  pull-requests: write # needs to open/update the sync PR
```

The workflow acts as `github-actions[bot]`, which has branch-protection bypass for `upstream-main` specifically (protected branches can whitelist bot actors).

## Step-by-step

### 1. Checkout fork at `upstream-main`

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0   # full history, needed for HEAD comparison
    ref: upstream-main
```

Starts at whatever `upstream-main` currently points to (last synced upstream commit).

### 2. Configure git identity

```yaml
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
```

Standard GitHub Actions bot identity.

### 3. Add upstream remote and fetch

```yaml
git remote add upstream https://github.com/Sync-in/server.git
git fetch upstream main
```

Uses HTTPS because SSH keys aren't available in the runner. Read-only, so that's fine.

### 4. Fast-forward `upstream-main` to `upstream/main`

```yaml
BEFORE=$(git rev-parse HEAD)
git reset --hard upstream/main
AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "changed=false" >> "$GITHUB_OUTPUT"
else
  echo "changed=true" >> "$GITHUB_OUTPUT"
fi
```

The `reset --hard` is safe because `upstream-main` is supposed to be an exact mirror. Setting `changed=false` short-circuits remaining steps if nothing new. It also exports `before=$BEFORE` for the guard step below.

### 4b. Guard — upstream workflow-file changes need a manual sync

```yaml
- name: Guard — upstream workflow-file changes need a manual sync
  if: steps.sync.outputs.changed == 'true'
  run: |
    if ! git diff --quiet "${{ steps.sync.outputs.before }}" HEAD -- .github/workflows/; then
      echo "::error title=Upstream changed workflow files::... sync manually from upstream/main ..."
      git --no-pager diff --stat "${{ steps.sync.outputs.before }}" HEAD -- .github/workflows/
      exit 1
    fi
```

The default `GITHUB_TOKEN` **cannot create or update files under `.github/workflows/`** — there is no `workflows` permission scope for it (only a PAT or SSH deploy key with `workflow` scope can). When upstream changes a workflow file, the push in step 5 is rejected with a cryptic `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`. This guard turns that into an actionable failure **before** the push, with a clear message pointing at the skill's recovery. This is **intentional**: the fork keeps customized/own workflows, so upstream workflow changes are reviewed by hand rather than auto-merged. See the skill's "Failure mode" section in Task 1.

### 5. Push `upstream-main` (only if changed)

```yaml
if: steps.sync.outputs.changed == 'true'
run: git push --force-with-lease origin upstream-main
```

Force-push is mandatory because upstream occasionally rewrites history. `--force-with-lease` guards against racing with another sync (shouldn't happen in practice, cheap insurance). Reaches this step only when upstream did **not** touch `.github/workflows/` (step 4b otherwise fails the run).

### 6. Open or update the sync PR

```yaml
- if: steps.sync.outputs.changed == 'true'
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    git fetch origin main
    if git diff --quiet origin/main HEAD; then
      echo "main already contains upstream-main; skipping PR."
      exit 0
    fi

    EXISTING=$(gh pr list --repo "${{ github.repository }}" \
      --state open --base main --head upstream-main \
      --json number --jq '.[0].number // empty')

    if [ -z "$EXISTING" ]; then
      gh pr create --repo "${{ github.repository }}" \
        --base main --head upstream-main \
        --title "chore: sync upstream ($(date +%Y-%m-%d))" \
        --body "Automated upstream sync from \`Sync-in/server\`. Review the diff and merge to pull upstream changes into \`main\`."
    else
      echo "PR #$EXISTING already open; the push updates it automatically."
    fi
```

Three cases:
- **`main` already contains upstream-main** (happens if someone manually merged previously) → no PR needed.
- **PR already open** → the force-push to `upstream-main` automatically updates the PR's head; no need to re-create.
- **Fresh sync** → new PR opened with today's date in the title.

## What the workflow does **not** do

- It does **not** resolve conflicts. If `upstream-main → main` conflicts, the PR opens as CONFLICTING and a human has to resolve on a third branch (see task 2 of the skill).
- It does **not** merge the PR. Review and merge are intentional human steps.
- It does **not** notify anyone. If you want Slack/email notifications on the sync PR, add them outside the workflow.

## Common failure modes

- **Run fails at the "Guard" step (or, pre-guard, at "Push upstream-main") with `refusing to allow a GitHub App to create or update workflow`** — upstream changed a file under `.github/workflows/`, which the `GITHUB_TOKEN` can't push (no `workflows` scope). **This is expected and intentional.** Recovery: run the sync-in-fork-maintenance skill and follow its Task 1 "Failure mode" section — sync manually from `upstream/main` (the mirror `upstream-main` is now stale). Worked example: PR #270.
- **`git fetch upstream` fails with 403** — `Sync-in/server` briefly went private or the URL changed. Check upstream repo status.
- **`git push origin upstream-main` fails with "protected branch"** — branch protection on `upstream-main` is misconfigured to block the bot. Fix rule: allow bypass for `github-actions[bot]`.
- **`gh pr create` opens against wrong repo** — workflow uses `${{ github.repository }}` which is always the fork, so this shouldn't happen. If it does, the repo was forked incorrectly.
