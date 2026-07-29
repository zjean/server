---
name: tackle-issues
description: Pick up GitHub issues from the zjean/server backlog and ship them as PRs that follow this fork's conventions (branch prefixes, conventional-commit style, --repo zjean/server flag, SSH alias, classic-UI-as-ground-truth, NC-source-as-ground-truth, Drizzle tooling, squash-vs-merge per PR type). Use this skill whenever the user says any of: "work on issues", "tackle the backlog", "pick up issue #N", "what should I work on next", "open a PR for issues N and M", "ship the folder-size bug", "let's knock out a few of the NC compat issues", "go through the issues", or any time the user wants to make progress against the open issue list. Also use proactively when the user just opened a batch of issues and the next obvious move is to start working them — propose a grouping into PR(s) and confirm before coding. The skill handles the safe parts (branch naming, target repo flag, ground-truth lookups, PR body link conventions) so the user can focus on the substance.
---

# Working open issues into PRs against zjean/server

This fork has a small but specific PR workflow. `main` is protected — direct pushes are blocked, every change goes through a PR, and `gh pr create` will silently target the upstream `Sync-in/server` repo if you forget the `--repo` flag. On top of that, several conventions (branch prefix, commit prefix, merge strategy, ground-truth source for the file area you're touching) are repo-specific and not derivable from looking at one issue in isolation.

This skill is the recipe for turning "I want to work on some issues" into a clean PR (or a small set of clean PRs), with the conventions baked in so they don't get fluffed.

## Step 1 — Survey the open issues

Always confirm before coding. Start by pulling the list and reading what's actually open — counts and labels alone are not enough to make a grouping decision.

```bash
gh issue list --repo zjean/server --state open --limit 50
gh issue view <N> --repo zjean/server   # for the ones that look workable
```

When the user names specific issues (`"work on #205 and #206"`), skip to Step 2. When they don't, present a short list of 3-5 candidates ordered by what looks like the highest-leverage / lowest-risk combination — anything tagged `bug` that's narrow and self-contained is a good starter. Ask which they want to go after.

If the user has explicitly opened the issues just now and named them in conversation (common pattern: they ran a review, you created issues, they say "let's start"), trust the conversation context — you don't need to re-fetch every one. But still confirm the grouping before coding.

## Step 2 — Decide what goes in one PR vs separate PRs

The default is **one issue per PR.** That's what makes review fast and rollback safe. Combine into a single PR *only* when:

- The issues touch the same file or the same tightly-coupled module **and** the changes are individually small (each <50 lines).
- The issues are different facets of one underlying fix (e.g. "X is wrong in code path A" + "X is wrong in code path B" where both paths share a helper that needs updating once).
- A backend change and its sibling frontend change are mechanically tied (rare here — usually they're separate review surfaces and want separate PRs).

Do **not** combine when:

- The issues are in different applications/modules (e.g. one in `custom-mobile-compat`, one in `custom-v2`). Independent review surfaces, independent rollback risk.
- One is a bug fix and the other is a refactor or "while we're here" cleanup. CLAUDE.md is explicit: *don't* add surrounding cleanup to a bugfix.
- One requires a migration (Drizzle `db:generate`) and the other doesn't. Migrations have their own review weight.
- The branch prefix would have to differ (e.g. one is `fix/...` and one is `mod/...`). The prefix encodes intent for the changelog.

When in doubt, split. Two clean PRs review faster than one ambiguous one.

Sketch the plan back to the user before coding:

> Proposing two PRs:
> - `fix/oc-size-folder-recursive` — closes #205 (backend prop builder + spec).
> - `fix/sync-token-strict` — closes #207 (one-line behavior fix in `parseSyncToken` + two spec cases).
> #206 is bigger and lands separately. OK to proceed?

## Step 3 — Branch name and prefix

The branch prefix tells the reader (and the eventual commit log grep) what kind of change this is. Pick from the table — they're enforced by convention, not by hook, so getting them right matters.

| Issue kind | Branch prefix | Commit prefix |
|---|---|---|
| New custom feature / module under `custom-*` | `feat/<topic>` | `feat(<area>): ...` or `custom(<area>): ...` |
| Bug fix in our own code (anywhere) | `fix/<topic>` | `fix(<area>): ...` |
| Edit to an upstream file (theming, behavior tweak) | `mod/<topic>` | `mod(<area>): ...` |
| Docs, plans, or CI-only | `docs/<topic>` or `chore/<topic>` | `docs(...)` / `chore(...)` |
| Intended for upstream contribution | `upstream-contrib/<topic>` rooted at `upstream/main` | conventional, no `custom-*` paths |

`<area>` examples we've used: `custom-v2`, `custom-mobile-compat`, `nc-compat`, `webdav`, `auth`, `mobile`, `skills`. Pick one that already exists in `git log --oneline -50` if at all possible — drifting area names splits the changelog.

`<topic>` should be short and grep-friendly. `fix/oc-size-folder` beats `fix/issue-205-folder-size-rendering-fix`.

```bash
git checkout develop && git pull
git checkout -b fix/oc-size-folder
```

## Step 4 — Do the homework before touching code

Two ground-truth rules in CLAUDE.md decide where to look first. Get this wrong and the change will pass build + lint and still ship broken.

**If the issue touches `frontend/src/app/applications/custom-v2/`:**
- Find the matching feature in the **classic** UI (`frontend/src/app/applications/<feature>/` ignoring `custom-v2/`). The classic component + service is the authoritative reference for endpoint, DTO shape, sentinel values, and side-effect sequence.
- Open the classic file side-by-side with the v2 file you're about to edit. Note the exact API call, request body, and any non-obvious value conventions (e.g. `id: -1` means "new", `id: 0` means something else).
- If the v2 issue is "this doesn't work right," diff the network call against classic's before assuming the bug is in render code.

**If the issue touches `backend/src/applications/custom-mobile-compat/`:**
- Find the upstream NC source for the contract you're emitting. The wire format is not guessable from REST conventions.
  - `nextcloud/server` for OCS controllers + Capabilities.php.
  - `nextcloud/NextcloudKit` (Swift) for the iOS wire-format authority — `Sources/NextcloudKit/NextcloudKit+<Feature>.swift` + `Models/NK<Feature>.swift`.
  - `nextcloud/ios` for client-side gating logic.
- Use `gh api repos/<org>/<repo>/contents/<path>` (fastest) — for JSON-returning gh-api calls inside `rtk`'s wrapped shell, prefix with `rtk proxy` to bypass the schema-stub reshape.

**Anything else:**
- Read the file the issue points at and the spec next to it (`*.spec.ts`). Sync-in's tests are co-located.
- Run `git log -10 --oneline -- <file>` to see recent intent before editing.

## Step 5 — Implement, minimal and atomic

CLAUDE.md is explicit: *don't add features, refactor, or introduce abstractions beyond what the task requires.* When you're closing an issue, only touch what the issue actually demands. Pre-existing weirdness in nearby code is for a separate PR.

A few specific things to do *correctly* the first time:

- **Migrations**: never write SQL files by hand. `npm run -w backend db:generate` to author, `npm run -w backend db:migrate` to apply. Hand-written SQL files leave `meta/_journal.json` out of sync and the migration runs silently empty.
- **i18n keys**: fork-specific keys live in `frontend/src/i18n/custom/{en,nl}.json`, never in upstream's `frontend/src/i18n/{en,nl}.json`. Convention: `v2_*` prefix for parameterized keys, plain English literals for static strings.
- **v2 toasts**: route through `ToastService` — `this.toast.success('Group updated')` auto-translates; `this.toast.success('v2_renamed_to', { name })` interpolates.
- **Tests**: add or update the co-located `*.spec.ts`. Don't run the whole suite locally if it's slow — run the affected file: `npx vitest run <path-to-spec>` (or `npm test -- <pattern>` depending on the package).

## Step 6 — Commit, push, open the PR

Commits use the conventional prefix from Step 3's table. Push to `origin` (NOT upstream); the SSH alias is `github-prive`, baked into the remote URL.

```bash
git add -p                   # don't `git add -A`; CLAUDE.md flags this
git commit -m "fix(nc-compat): emit recursive folder size for oc:size

Closes #205."
git push -u origin fix/oc-size-folder
```

If pre-commit hooks fail, fix the underlying issue and make a new commit. Don't `--amend` (the failed commit didn't happen so amend would touch the wrong one) and don't use `--no-verify` unless the user explicitly asks.

For the PR — **always pass `--repo zjean/server` explicitly**, even when the default is set. The flag is the authoritative override against the silent-upstream-targeting bug:

```bash
gh pr create --repo zjean/server --base develop --head fix/oc-size-folder \
  --title "fix(nc-compat): emit recursive folder size for oc:size" \
  --body "$(cat <<'EOF'
## Summary
- NC mobile PROPFIND emitted `oc:size: '0'` for every directory. NC clients render this verbatim as the folder size in list views; all folders showed 0 bytes.
- Thread the recursive folder-size value already available in `<source>` onto `WebDAVFile` and emit it from `buildNcPropResponse`.

## Test plan
- [ ] `npx vitest run backend/src/applications/custom-mobile-compat/utils/nc-prop-builder.spec.ts`
- [ ] Smoke against NC iOS: a folder with known content shows the right byte total.

Closes #205.
EOF
)"
```

PR title mirrors the commit subject. PR body conventions:

- Lead with **Summary** (1-3 bullets — *why*, not *what*; the diff already shows what).
- Add **Test plan** as a checkbox list.
- End with `Closes #N` for each issue this PR fully resolves. Use `Refs #N` (no auto-close) when partial.
- For NC-compat or v2 changes that ride on ground-truth research, link the upstream source you used (commit/permalink, not a moving branch URL).
- UI-facing change? The PR body must embed agent-browser screenshots per `.github/PULL_REQUEST_TEMPLATE.md` — capture via the v2-dev-loop-verify skill, commit PNGs under `docs/screenshots/`, link by head-SHA raw URL.

## Step 7 — Combine-into-one-PR specifics

When Step 2 said "yes, combine" — the structure is:

- **One branch**, prefix chosen by the *dominant* change kind (fix > mod > chore for ordering).
- **One commit per issue**, each with its own conventional subject and `Closes #N` line in the body. Easier to bisect and to extract one back out if review pushes back.
- **PR body** has a Summary bullet per issue and **multiple `Closes` lines**:

  ```
  Closes #205.
  Closes #210.
  ```

  GitHub closes each on merge. Do not write `Closes #205, #210` — only the first is parsed.

If during review one of the combined fixes is contested, the per-issue commit structure makes it cheap to split: `git rebase -i` the offending commit out, push, and the PR shrinks to the rest.

## Step 8 — Merge strategy

Per CLAUDE.md, the repo allows both squash and merge-commit but rebase is disabled. Pick by PR type:

- **Feature / fix / mod / docs / chore PRs (base `develop`) → Squash and merge.** One commit per logical change.
- **Upstream sync PRs (`upstream-main` → `develop`) → Create a merge commit.** Preserves the merge point.
- **Release promotion PRs (`develop` → `main`) → Create a merge commit.** Same reason, stronger: a squash here permanently forks `main` from `develop`.

(Sync and promotion PRs aren't what this skill produces, but worth knowing — GitHub remembers the last-used strategy, double-check the dropdown on your next non-sync PR.)

Branch is auto-deleted on merge (`delete_branch_on_merge: true`); no cleanup needed.

## Gotchas

- **`gh pr create` and the wrong repo**: the `upstream` remote being present makes `gh` resolve the default repo to `Sync-in/server` in some cases. Always pass `--repo zjean/server`. If you opened a PR there by mistake, close it on Sync-in with a "wrong repo" comment, reopen on zjean — don't leave it polluting their queue.
- **`git push origin main`**: blocked — and so is `git push origin develop`. Everything goes through a PR with base `develop`.
- **rtk wrapper gotchas**: `git commit --allow-empty` is rejected by rtk's git wrapper; use `rtk proxy git commit --allow-empty`. `gh api` calls returning JSON may be reshaped into a schema stub; use `rtk proxy gh api …` when you need the raw response. Normal `git`, `gh pr create`, `gh run list`, etc. pass through unmodified.
- **Cherry-pick a fix to upstream-contrib later?**: if a fix is upstream-mergeable (no `custom-*` paths, no fork-flavored language), it can go on a separate `upstream-contrib/<topic>` branch *rooted at `upstream/main`* (not `main`) and contributed back. Don't try to mix that with this skill's flow — open a follow-up.
- **CI**: the `test` status check must pass before merge, and any PR conversations must be resolved. Watch `gh run watch` or just keep an eye on the PR; don't merge until green.

## When to deviate

- **A single trivial issue** (one-line typo, comment fix): you don't need branch-and-PR drama — but the policy says you still need a PR because `main` is protected. Use `fix/<short-topic>` and ship it; PR will pass review in seconds.
- **Issue requires significant design work, not a code change**: this skill isn't the right fit. Discuss the design with the user first; the resulting PR may not close the issue (just refs it).
- **Multiple issues that all need the same upstream NC research**: do the research once and link the same source from each PR. Don't duplicate the research narrative in three PR descriptions.

## When this skill doesn't apply

- The user wants to *triage* the backlog (close stale, re-label, write up new findings) but not code. This skill is for shipping PRs.
- The user has uncommitted in-progress work on `main` already. Don't blindly `git checkout -b` from a dirty state — surface what's there first and ask.
- The work is an upstream sync (`chore: sync upstream`). That has its own flow — use `sync-in-fork-maintenance` instead.
