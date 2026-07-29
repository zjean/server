# Dev Workflow: `develop` Branch + Beta Builds Implementation Plan (issue #387)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move day-to-day PRs off `main` onto a new protected `develop` branch that builds a `:beta` Docker image on every merge, require agent-browser screenshots on UI-facing PRs, and reserve `main` for stable releases promoted from `develop`.

**Architecture:** `develop` becomes the default branch and the base for all feature/fix/mod/docs PRs and for automated upstream-sync PRs. Every push to `develop` builds `ghcr.io/zjean/sync-in-server:beta` (plus `:develop` and `:sha-*`). `main` only advances via `develop → main` promotion PRs (merge commits, never squash) when a stable release is cut; the existing `v*.*.*` tag flow on `main` (release.yml + build-image.yml) is unchanged. The screenshot requirement is a convention (PR template + CLAUDE.md + skills), not a CI gate.

**Tech Stack:** GitHub Actions, GitHub branch protection (classic, via `gh api`), docker/metadata-action, agent-browser (local), rtk-wrapped `gh`.

## Global Constraints

- Repo is `zjean/server`; every `gh` command passes `--repo zjean/server` explicitly (or the full API path `repos/zjean/server/...`).
- Remote URLs use the `github-prive` SSH alias, never `github.com`.
- `gh api` calls that return JSON must be run as `rtk proxy gh api ...` (rtk reshapes JSON otherwise).
- `main` is protected: no direct pushes; everything below that changes files lands via one PR.
- Current version: `2.4.4-custom.1` (root + backend + frontend `package.json` aligned).
- Image name: `ghcr.io/zjean/sync-in-server`.
- License headers, AGPL notices: untouched by this plan.

## Design decisions (settled here, do not re-derive)

1. **`develop` is created from `main`, gets `main`'s exact protection rules (PR required, `test` strict + up-to-date, conversation resolution, no deletions), and becomes the repo's default branch.** Default-branch status is what makes `gh pr create` and the GitHub UI target it, and what makes the *scheduled* upstream-sync cron execute `develop`'s copy of `upstream-sync.yml`.
2. **`main`'s required status check drops `strict` (up-to-date) but keeps `test` required.** With merge-commit promotions, `main`'s tip (the merge commit) is never an ancestor of `develop`, so a strict up-to-date check would block every promotion PR after the first unless we back-merged `main → develop` through a PR after each release. Dropping `strict` on `main` only is the cheap fix: `main` receives nothing but promotion PRs, so the staleness the flag protects against cannot occur. `develop` keeps `strict: true` — feature PRs still rebase before merge (existing behaviour).
3. **Promotion PRs (`develop → main`) use "Create a merge commit", never squash.** A squash would mint a new commit on `main` with no shared history with `develop`, and every subsequent promotion would conflict. This mirrors the existing rule for upstream-sync PRs. GitHub's auto-delete-on-merge skips protected branches, so a merged promotion PR does **not** delete `develop` — but only because `develop` is protected. **Protect `develop` before the first promotion PR is ever merged** (Task 6 does this at creation time).
4. **"Beta tag" = moving Docker tags, not git prerelease tags.** Every push to `develop` publishes `:beta`, `:develop`, and `:sha-<short>`. Deployments that want a pinned beta use the sha tag. Git `v*-beta.*` tags / prerelease GitHub Releases are out of scope (YAGNI — nothing consumes them; revisit if a beta ever needs release notes).
5. **Upstream-sync PRs retarget `develop`.** Upstream changes are fork-integration work like any other and must soak on `develop`/beta before reaching a stable release.
6. **Screenshots are a convention, not a CI check.** agent-browser runs against the local dev server on the maintainer's machine; CI cannot reproduce it. Enforcement is the PR template + CLAUDE.md + the tackle-issues and v2-dev-loop-verify skills. Mechanism: capture with agent-browser, commit PNG(s) under `docs/screenshots/` on the PR branch (this repo already commits verification PNGs — see `docs/plans/*.png`), embed in the PR body with a raw URL pinned to the head commit SHA (survives branch auto-deletion; PR head commits stay reachable).
7. **Hotfix policy:** even an emergency fix goes `develop → promotion`. If something ever *must* land on `main` directly (PR to `main` is still possible), immediately open a back-merge PR `main → develop` so the histories reconverge; until that merges, promotion PRs will show the hotfix as an incoming conflict risk.
8. **Rollout order matters:** (a) merge the file-changes PR into `main` under the old flow, (b) create `develop` from that `main` so it carries the new workflow files, (c) protect `develop`, (d) flip the default branch, (e) relax `strict` on `main`. Doing (d) before (b)+(c) leaves the cron running a stale workflow file or an unprotected default branch.

---

### Task 1: Retarget CI workflows to `develop`

**Files:**
- Modify: `.github/workflows/test.yml:2-6`
- Modify: `.github/workflows/test-e2e.yml:2-6`
- Modify: `.github/workflows/build-image.yml:3-7,38-43`
- Modify: `.github/workflows/upstream-sync.yml:67-89`

**Interfaces:**
- Produces: `test` check context (job id `test`, unchanged name — branch protection on both branches references it), `:beta`/`:develop` image tags, upstream-sync PRs based on `develop`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create the working branch (off `main`, old flow — this is the last PR that targets `main` directly)**

```bash
cd /Users/janwiebe/prive/sync-in-server
git checkout main && git pull
git checkout -b chore/dev-workflow-develop-branch
```

- [ ] **Step 2: Edit `test.yml` — run on `develop` pushes and on PRs into either branch**

Replace lines 2–6:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
```

(`pull_request.branches` filters on the **base** branch: feature PRs → `develop` and promotion PRs → `main` both keep the required `test` check alive. `push: main` stays so the promotion merge commit itself gets a run.)

- [ ] **Step 3: Edit `test-e2e.yml` — same trigger change**

Replace lines 2–6 with the identical block:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
```

Leave the explanatory comment block (lines 8–21) untouched — the check stays advisory.

- [ ] **Step 4: Edit `build-image.yml` — build on `develop` pushes, add the `:beta` moving tag**

Replace lines 3–7:

```yaml
on:
  push:
    branches: [main, develop]
    tags: ['v*.*.*']
  workflow_dispatch:
```

Replace the `tags:` block of the `Compute image metadata` step (lines 38–43):

```yaml
          tags: |
            type=ref,event=branch
            type=sha,prefix=sha-,format=short
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=beta,enable=${{ github.ref == 'refs/heads/develop' }}
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}
```

(`type=ref,event=branch` already yields `:develop` on develop pushes and `:main` on main pushes — no change needed there. Only `beta` is new.)

- [ ] **Step 5: Edit `upstream-sync.yml` — sync PRs target `develop`**

Replace the final step (lines 67–89) with:

```yaml
      - name: Open or update PR into develop
        if: steps.sync.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git fetch origin develop
          if git diff --quiet origin/develop HEAD; then
            echo "develop already contains upstream-main; skipping PR."
            exit 0
          fi

          EXISTING=$(gh pr list --repo "${{ github.repository }}" \
            --state open --base develop --head upstream-main \
            --json number --jq '.[0].number // empty')

          if [ -z "$EXISTING" ]; then
            gh pr create --repo "${{ github.repository }}" \
              --base develop --head upstream-main \
              --title "chore: sync upstream ($(date +%Y-%m-%d))" \
              --body "Automated upstream sync from \`Sync-in/server\`. Review the diff and merge to pull upstream changes into \`develop\`."
          else
            echo "PR #$EXISTING already open; the push updates it automatically."
          fi
```

(Everything above that step — checkout of `upstream-main`, fast-forward, workflow-file guard, force-push — is branch-agnostic and stays as-is.)

- [ ] **Step 6: Verify workflow syntax**

```bash
npx --yes @action-validator/cli .github/workflows/test.yml .github/workflows/test-e2e.yml .github/workflows/build-image.yml .github/workflows/upstream-sync.yml 2>/dev/null \
  || for f in test test-e2e build-image upstream-sync; do node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/$f.yml','utf8')); console.log('$f.yml OK')"; done
```

Expected: each file parses without error (js-yaml is already in the dependency tree via the backend).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/test-e2e.yml .github/workflows/build-image.yml .github/workflows/upstream-sync.yml
git commit -m "chore(ci): run PR checks and image builds on develop, publish :beta

Part of the develop-branch workflow (issue #387): feature PRs move to
develop, every develop push publishes :beta/:develop/:sha-* images, and
automated upstream-sync PRs land on develop instead of main.

Refs #387."
```

---

### Task 2: PR template with a Screenshots section

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `docs/screenshots/README.md`

**Interfaces:**
- Produces: the `docs/screenshots/` convention that Task 3 (CLAUDE.md) and Task 4 (skills) reference by path.

- [ ] **Step 1: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
## Summary

<!-- 1-3 bullets: WHY, not what — the diff shows what. -->

-

## Test plan

- [ ]

## Screenshots

<!-- REQUIRED for UI-facing changes (anything user-visible under frontend/).
     Capture with agent-browser against the local dev server (see the
     v2-dev-loop-verify skill), commit the PNG(s) under docs/screenshots/,
     push, then embed each with a raw URL pinned to the head commit SHA:

       ![before](https://github.com/zjean/server/raw/<head-sha>/docs/screenshots/YYYY-MM-DD-<topic>-before.png)
       ![after](https://github.com/zjean/server/raw/<head-sha>/docs/screenshots/YYYY-MM-DD-<topic>-after.png)

     Delete this section for backend-only / docs-only PRs. -->

Closes #
```

- [ ] **Step 2: Create `docs/screenshots/README.md`**

```markdown
# PR screenshots

Verification screenshots for UI-facing PRs (issue #387). Capture with
agent-browser against the local dev server, name them
`YYYY-MM-DD-<topic>-<label>.png` (e.g. `2026-07-30-share-dialog-after.png`),
commit them on the PR branch, and embed them in the PR body with a raw URL
pinned to the head commit SHA so the image survives branch auto-deletion:

    https://github.com/zjean/server/raw/<head-sha>/docs/screenshots/<file>.png

Screenshots land on `develop` (and eventually `main`) with the squash merge —
that is intentional; they are the visual record of what was verified, same as
the PNGs under `docs/plans/`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/PULL_REQUEST_TEMPLATE.md docs/screenshots/README.md
git commit -m "chore(repo): PR template with mandatory screenshots for UI-facing work

Refs #387."
```

---

### Task 3: Update CLAUDE.md to describe the new flow

**Files:**
- Modify: `CLAUDE.md` — sections "Branch protection", "Practical implications", "Merge strategy per PR type", "Versioning and releases", "Opening pull requests".

**Interfaces:**
- Consumes: the `docs/screenshots/` convention from Task 2, the `:beta` tag from Task 1.
- Produces: the canonical workflow description the skills in Task 4 point back to.

- [ ] **Step 1: Replace the "Branch protection" section body**

Replace the current three-bullet list under `## Branch protection` with:

```markdown
`main`, `develop`, and `upstream-main` are all protected:

- **`develop`** — the default branch and the base for ALL day-to-day PRs (features, fixes, mods, docs, CI config, upstream syncs). Direct pushes blocked; the `test` status check must pass, the branch must be up to date with `develop`, and PR conversations must be resolved before merge. Every merge to `develop` publishes `ghcr.io/zjean/sync-in-server:beta` (plus `:develop` and `:sha-<short>`).
- **`main`** — stable releases only. It advances exclusively via `develop → main` promotion PRs, merged with a **merge commit** (never squash — a squash would break the shared history and make every later promotion conflict). Direct pushes blocked; `test` must pass (up-to-date requirement deliberately OFF — the promotion merge commit on `main` is never an ancestor of `develop`, so a strict check would deadlock every promotion after the first).
- **`upstream-main`** — a pure mirror of `upstream/main`. Only the `upstream-sync.yml` workflow writes to it (force-push allowed; human pushes blocked by PR-equivalent requirement). Sync PRs open against `develop`.
```

- [ ] **Step 2: Replace the "Practical implications" bullets**

```markdown
- Never push to `main` or `develop` directly. Both are rejected.
- Every change flows: feature branch (off `develop`) → push → PR with base `develop` → wait for `test` green → squash-merge.
- UI-facing PRs (anything user-visible under `frontend/`) must include agent-browser screenshots — capture against the local dev server, commit PNGs under `docs/screenshots/`, embed in the PR body via a raw URL pinned to the head commit SHA (see `.github/PULL_REQUEST_TEMPLATE.md`).
- Feature branches are auto-deleted on merge (`delete_branch_on_merge: true`). `develop` survives promotion merges only because it is protected — never unprotect it.
- If an emergency fix ever lands on `main` directly, immediately back-merge `main → develop` via a PR.
```

- [ ] **Step 3: Replace the "Merge strategy per PR type" list**

```markdown
- **Feature / fix / mod / docs / chore PRs (base `develop`) → Squash and merge.** One commit per logical change.
- **Upstream sync PRs (`upstream-main` → `develop`) → Create a merge commit.** Preserves the merge point.
- **Release promotion PRs (`develop` → `main`) → Create a merge commit.** Same reason, stronger: a squash here permanently forks `main` from `develop`.

GitHub remembers the last-used strategy; double-check the dropdown on sync and promotion PRs.
```

- [ ] **Step 4: Extend the "Versioning and releases" section with the promotion recipe**

After the existing version-scheme bullet, replace the "Releases are cut by..." bullet with:

```markdown
- Cutting a stable release:
  1. On `develop`, open a PR bumping `version` in root + backend + frontend `package.json` (all three must align) and updating `CHANGELOG.md`.
  2. Open the promotion PR: `gh pr create --repo zjean/server --base main --head develop --title "release: v<version>"`. Merge it with **Create a merge commit**.
  3. Tag the merge commit on `main`: `git fetch origin main && git tag v<version> origin/main && git push origin v<version>`.
  4. The tag fires `release.yml` (archives + draft GitHub Release; it verifies the tag is in `main`'s history) and `build-image.yml` (`:<version>`, `:<major>.<minor>`, `:latest`).
- Beta builds: every push to `develop` publishes `:beta`, `:develop`, and `:sha-<short>`. Pin deployments to the sha tag when a beta needs to be reproducible. There are no git prerelease tags.
```

- [ ] **Step 5: Update the "Opening pull requests" section**

Change the example command's base and add one sentence. The example becomes:

```bash
gh pr create --repo zjean/server --base develop --head <branch> --title "..." --body "..."
```

And append to the section's intro paragraph:

```markdown
Day-to-day PRs base on `develop`; the only PRs with base `main` are release promotions (`--head develop`) and, exceptionally, emergency hotfixes (which must be back-merged to `develop` immediately).
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): describe the develop-branch workflow, beta tags, screenshot rule

Refs #387."
```

---

### Task 4: Update the three local skills

**Files:**
- Modify: `.claude/skills/tackle-issues/SKILL.md:66,118,170` and Step 8's merge-strategy list
- Modify: `.claude/skills/sync-in-fork-maintenance/SKILL.md:74,103,123,195,227,435` (every `--base main` / `origin/main` comparison that concerns the sync PR target)
- Modify: `.claude/skills/v2-dev-loop-verify/SKILL.md` (new section after "Reporting back to the user")

**Interfaces:**
- Consumes: the CLAUDE.md wording from Task 3 and the `docs/screenshots/` convention from Task 2.

- [ ] **Step 1: tackle-issues — branch off `develop`, PR base `develop`**

- Line 66: `git checkout main && git pull` → `git checkout develop && git pull`
- Line 118: `--base main` → `--base develop`
- Line 170: extend the gotcha: "`git push origin main`: blocked — and so is `git push origin develop`. Everything goes through a PR with base `develop`."
- In Step 6's PR-body conventions, add a bullet: "UI-facing change? The PR body must embed agent-browser screenshots per `.github/PULL_REQUEST_TEMPLATE.md` — capture via the v2-dev-loop-verify skill, commit PNGs under `docs/screenshots/`, link by head-SHA raw URL."
- In Step 8, replace the merge-strategy list with the three-line version from Task 3 Step 3 (squash for feature PRs, merge commit for sync and promotion PRs).

- [ ] **Step 2: sync-in-fork-maintenance — sync PRs target `develop`**

Mechanical, guided by the grep hits: every place the skill lists, opens, or diffs the sync PR against `main` now uses `develop` (`--base develop`, `git fetch origin develop upstream-main`, `git diff origin/develop...`, `git checkout develop`). Leave untouched the places that genuinely mean `upstream/main` or the mirror branch `upstream-main`. After editing, re-run the grep and confirm the only remaining `main` references are `upstream/main`, `upstream-main`, or prose about the release promotion:

```bash
grep -n "base main\|origin main\|origin/main\|checkout main" .claude/skills/sync-in-fork-maintenance/SKILL.md
```

Expected: no hits that refer to the fork's own integration target.

- [ ] **Step 3: v2-dev-loop-verify — add the PR-screenshot step**

Append after the "Reporting back to the user" section:

```markdown
## Producing PR screenshots (required for UI-facing PRs)

Issue #387 makes screenshots mandatory on UI-facing PRs. After verifying the
change, capture the final state(s) with agent-browser, save as
`docs/screenshots/YYYY-MM-DD-<topic>-<label>.png`, commit on the PR branch,
push, then embed in the PR body pinned to the head commit SHA:

    SHA=$(git rev-parse HEAD)
    echo "![after](https://github.com/zjean/server/raw/$SHA/docs/screenshots/<file>.png)"

Before/after pairs beat single shots for visual fixes. The PNGs merge into
`develop` deliberately — they are the verification record.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/tackle-issues/SKILL.md .claude/skills/sync-in-fork-maintenance/SKILL.md .claude/skills/v2-dev-loop-verify/SKILL.md
git commit -m "chore(skills): point tackle-issues and fork-maintenance at develop, add screenshot step

Refs #387."
```

---

### Task 5: Open and merge the PR (last PR into `main` under the old flow)

**Files:** none new — pushes the branch from Tasks 1–4.

- [ ] **Step 1: Push and open the PR against `main`**

```bash
git push -u origin chore/dev-workflow-develop-branch
gh pr create --repo zjean/server --base main --head chore/dev-workflow-develop-branch \
  --title "chore(ci): develop-branch workflow — beta builds, screenshot rule, stable-only main" \
  --body "$(cat <<'EOF'
## Summary
- Implements the dev workflow from #387: all PRs move to a new `develop` branch, every `develop` push publishes `:beta`/`:develop`/`:sha-*` images, UI-facing PRs must carry agent-browser screenshots, and `main` only advances via release-promotion merge commits.
- This PR carries only the file changes; branch creation, protection, and the default-branch flip are follow-up API operations documented in `docs/plans/2026-07-29-dev-workflow-develop-branch-plan.md` (Task 6).

## Test plan
- [ ] `test` check green on this PR
- [ ] After merge + Task 6: canary PR against `develop` runs the required `test` check (Task 7)
- [ ] After canary merge: `:beta`, `:develop`, `:sha-*` visible in ghcr (Task 7)

Refs #387 (closed manually after Task 7's canary verifies end-to-end).
EOF
)"
```

- [ ] **Step 2: Wait for `test` green, then squash-merge**

```bash
gh pr checks --repo zjean/server --watch
gh pr merge --repo zjean/server --squash
```

Expected: PR merges; branch auto-deleted.

---

### Task 6: Create `develop`, protect it, flip the default branch, relax `main`

**Files:** none — repository state via `gh api`. **Order within this task is load-bearing** (see design decision 8).

- [ ] **Step 1: Create `develop` from the post-merge `main`**

```bash
git fetch origin main
git push origin refs/remotes/origin/main:refs/heads/develop
```

Expected: `* [new branch] origin/main -> develop`. (Direct branch creation is allowed — protection doesn't exist yet and `block_creations` is off.)

- [ ] **Step 2: Protect `develop` with `main`'s current rules**

```bash
rtk proxy gh api -X PUT repos/zjean/server/branches/develop/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["test"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_conversation_resolution": true
}
JSON
```

- [ ] **Step 3: Verify the protection took**

```bash
rtk proxy gh api repos/zjean/server/branches/develop/protection --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, conv: .required_conversation_resolution.enabled, del: .allow_deletions.enabled}'
```

Expected: `{"strict":true,"contexts":["test"],"conv":true,"del":false}`. `del:false` is what exempts `develop` from auto-delete after promotion merges — do not proceed if it reads `true`.

- [ ] **Step 4: Make `develop` the default branch**

```bash
rtk proxy gh api -X PATCH repos/zjean/server -f default_branch=develop --jq '.default_branch'
```

Expected: `develop`. (This is what re-homes the upstream-sync cron onto `develop`'s copy of the workflow file, and makes `gh pr create` default there.)

- [ ] **Step 5: Relax the up-to-date requirement on `main` (keep `test` required)**

```bash
rtk proxy gh api -X PATCH repos/zjean/server/branches/main/protection/required_status_checks -F strict=false --jq '{strict, contexts}'
```

Expected: `{"strict":false,"contexts":["test"]}`. Without this, every promotion PR after the first is blocked because `main`'s merge commits are never ancestors of `develop`.

- [ ] **Step 6: Point the local clone at the new default**

```bash
git checkout develop 2>/dev/null || git checkout -b develop origin/develop
git remote set-head origin develop
```

---

### Task 7: Canary — verify the flow end to end

**Files:**
- Modify: `docs/screenshots/README.md` — append one line (a real, trivial change that exercises the whole pipeline).

- [ ] **Step 1: Open a trivial PR against `develop`**

```bash
git checkout develop && git pull
git checkout -b chore/workflow-canary
printf '\nFirst verified on the develop workflow canary PR.\n' >> docs/screenshots/README.md
git add docs/screenshots/README.md
git commit -m "chore(repo): develop-workflow canary

Refs #387."
git push -u origin chore/workflow-canary
gh pr create --repo zjean/server --base develop --head chore/workflow-canary \
  --title "chore(repo): develop-workflow canary" \
  --body "Canary for the #387 workflow: verifies the required test check and the :beta image build on develop. Refs #387."
```

- [ ] **Step 2: Verify the `test` check runs AND is required**

```bash
gh pr checks --repo zjean/server --watch
rtk proxy gh api repos/zjean/server/commits/$(git rev-parse HEAD)/check-runs --jq '.check_runs[].name'
```

Expected: `test` (required, from the PR trigger) and `e2e` (advisory) both present; merge button blocked until `test` is green.

- [ ] **Step 3: Squash-merge and watch the image build**

```bash
gh pr merge --repo zjean/server --squash
gh run list --repo zjean/server --workflow build-image.yml --limit 1
gh run watch --repo zjean/server $(gh run list --repo zjean/server --workflow build-image.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: a `Build Image` run triggered by the push to `develop`, completing green.

- [ ] **Step 4: Verify the published tags**

```bash
rtk proxy gh api "users/zjean/packages/container/sync-in-server/versions?per_page=5" --jq '.[].metadata.container.tags'
```

Expected: the newest version carries `beta`, `develop`, and `sha-<short>`; `latest` still points at the last stable release version, untouched.

- [ ] **Step 5: Close the issue**

```bash
gh issue close 387 --repo zjean/server --comment "Shipped: PRs now base on develop (default branch, protected, test required + up-to-date), every develop push publishes :beta/:develop/:sha-* to ghcr, UI-facing PRs carry agent-browser screenshots per the new PR template, and main only advances via develop→main promotion merge commits followed by a v<version> tag. Verified end-to-end with a canary PR. Plan: docs/plans/2026-07-29-dev-workflow-develop-branch-plan.md"
```

---

## Out of scope (deliberately)

- **Git prerelease tags / beta GitHub Releases** — nothing consumes them today (design decision 4).
- **CI enforcement of the screenshot rule** — agent-browser can't run in CI; a "does the PR body contain an image" check is brittle noise.
- **Promoting `e2e` into the required check set** — separate decision, tracked by the comment in `test-e2e.yml`.
- **Retargeting the two long-lived stale branches** (`docs/favorites-design`, `feat/v2-folder-readme`) — their PRs, if any, can be retargeted to `develop` in the GitHub UI when next touched.
- **`upstream-contrib/*` branches** — unchanged; they root at `upstream/main` and never interact with `develop`.

## Post-merge memory note (for the executing agent)

After Task 7, update the auto-memory `project_pr_must_be_up_to_date.md`: the strict up-to-date rule now lives on `develop` (feature PRs still pay the N−1 rebase cost there); `main` is deliberately non-strict for promotions.
