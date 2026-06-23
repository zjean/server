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
- **`rtk proxy` for any `gh` call where you depend on specific JSON fields.** The `rtk` proxy reshapes / pretty-prints `gh` output for token savings — great in the common case, lossy when a precise field value matters. This applies to *all* JSON-returning `gh` calls, not just `gh api`: in this session `gh pr view 199 --json mergeable,mergeStateStatus,...` hid the `CONFLICTING` state until I re-ran it through `rtk proxy`. Rule of thumb: if you pass `--json` and you're going to branch on a field, use `rtk proxy gh ...`. Side-effect commands (`gh pr create`, `gh workflow run`, `gh run rerun`) and human-readable listings (`gh run list`, `gh pr list` without `--json`) work fine unmodified.
- **`git commit --allow-empty` / `--no-edit`** — rtk's git wrapper rejects these flags (and similar uncommon `git` options). The merge-commit step in task 2 specifically needs `rtk proxy git commit --no-edit` so the default merge message is preserved without rtk dropping the flag.

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

If the run **fails** (non-zero exit), jump to [Failure mode](#failure-mode-the-run-fails-at-push-upstream-main-upstream-changed-a-workflow-file) below — it's almost always upstream changing a workflow file.

Once the workflow finishes, check whether it opened a PR:

```bash
gh pr list --repo zjean/server --base main --head upstream-main --state open
```

- **No PR** → upstream had nothing new. Report that and stop.
- **PR open, MERGEABLE** → report PR number, URL, diff stat. Merge when ready via "Create a merge commit". Task 3 investigation still applies if backend files changed.
- **PR open, CONFLICTING** → proceed to task 2.

Use `gh pr view <n> --repo zjean/server --json mergeable,mergeStateStatus,additions,deletions,changedFiles,body` for the merge state. `MERGEABLE` + `BLOCKED` usually means CI is still running, not a conflict.

### Failure mode: the run fails at *Push upstream-main* (upstream changed a workflow file)

If `gh run watch ... --exit-status` reports the run **failed**, the most likely cause is that **upstream changed a file under `.github/workflows/`**. The sync workflow pushes `upstream-main` with the default `GITHUB_TOKEN`, and GitHub forbids that token from creating or updating workflow files — there is **no `workflows` permission scope** available for the auto-generated token (only a PAT or SSH deploy key with `workflow` scope can push workflow-file changes). This is a **deliberate, accepted** design choice for this fork: the run fails loudly as the signal to sync manually, so the maintainer reviews upstream's workflow changes by hand rather than auto-merging them (the fork's `release.yml` is customized and `upstream-sync.yml`/`build-image.yml` are fork-only).

Confirm the cause:

```bash
gh run list --repo zjean/server --workflow "Upstream Sync" --status failure --limit 1
gh run view <RUN_ID> --repo zjean/server --log-failed | grep -i "refusing to allow a GitHub App"
# → "refusing to allow a GitHub App to create or update workflow '.github/workflows/<file>' without 'workflows' permission"
```

**Consequences — read carefully, they change the recovery from Task 2:**

- `origin/upstream-main` is **stale**: the force-push never landed, so it still points at the *previous* sync's commit. Merging `origin/upstream-main` (what Task 2 does) would **not** bring in the new upstream work.
- Any open `chore: sync upstream (...)` PR with head `upstream-main` is from an **earlier** sync; once you finish the manual sync, close it as superseded (`git merge-base --is-ancestor origin/upstream-main upstream/main` confirms it's fully contained).

**Recovery — sync manually from `upstream/main` (not `origin/upstream-main`):**

```bash
git fetch upstream main origin main
git checkout -b sync/upstream-$(date +%Y-%m-%d) origin/main
git merge upstream/main --no-ff --no-edit      # resolve conflicts per Task 2's guidance
```

From here it is exactly Task 2's resolve → verify → commit → PR flow, with two differences:

1. **Source is `upstream/main`, not `origin/upstream-main`.** The read-only `upstream` remote has the real new commits; the mirror branch is stale.
2. **The maintainer's SSH key carries `workflow` scope**, so `git push -u origin sync/upstream-...` pushes the workflow-file changes fine (the restriction is only on the Actions `GITHUB_TOKEN`, not on SSH). Resolve `.github/workflows/*` conflicts deliberately — usually keep the fork's customized version and adopt only the upstream CI changes you actually want (see PR #270 for a worked example: kept our no-publish `release.yml`, took upstream's `checkout@v6` + tag-in-main guard).

Then open the replacement PR and **merge it with a merge commit** (see Task 2's "Open the replacement PR" and "Aftermath" sections — they apply verbatim). The automation is intentionally left unfixed; this manual path via the skill is the supported recovery.

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
rtk proxy npm --prefix backend run build    # NestJS compile (type errors against @sync-in-server/backend)
rtk proxy npm --prefix backend test         # vitest — the only check that catches stale runtime test mocks
```

**The backend build is necessary but NOT sufficient — run the backend test suite too.** When an Adapt changes the *shape* of something the fork's tests construct by hand — config singletons (`vi.mock('config.environment', …)`), DTO fixtures, mock payloads — `nest build`'s type-check passes (the mock is an untyped object literal) but the test throws at runtime. The 2.4.0 sync hit this exactly: the `files.onlyoffice` → `files.editors.onlyoffice` regrouping was fixed in the source, the build went green, but two `custom-mobile-compat` specs still built `configuration` with the old shape, so `files.editors` was `undefined` and 4 tests threw `Cannot read properties of undefined (reading 'onlyoffice')`. CI caught it *after* the PR was already open — a wasted round-trip. Grep the specs for the old shape whenever you adapt a config/DTO path:

```bash
git grep -l "<old.path.fragment>" -- 'backend/src/**/*.spec.ts'   # e.g. "files.onlyoffice"
```

This is the mirror image of the standing "run nest build before push" rule (build catches type errors vitest's `--no-typecheck` path misses); here vitest catches a runtime-shape error the build misses. You need **both** green locally before pushing — Test Workflow gates the merge on the test suite, not the build.

Fix anything new that surfaces, then commit the merge and push.

**Don't `git add -A`.** The user's working tree often has untracked or modified `.claude/` files (e.g. `.claude/scheduled_tasks.lock`, `.claude/settings.local.json`) — tooling state that doesn't belong in the sync commit. After conflict resolution, every fix you applied is already staged from your per-file `git add` during resolution, and cleanly-auto-merged files are staged by `git merge` itself. So the index already contains exactly the merge content — just commit it.

Stage anything extra (e.g. a regenerated `package-lock.json` after `npm install`) by name, verify what's staged, then commit:

```bash
git status --short              # confirm only merge-related files are staged
git add <regenerated-files>     # e.g. package-lock.json if npm install touched it
rtk proxy git commit --no-edit  # default merge message; rtk needs --no-edit proxied
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

### Aftermath — once the sync PR is merged

When the user reports the PR is merged, do the local cleanup so the next branch doesn't start from stale state:

```bash
git checkout main
git pull --ff-only                            # advance to the merged commit on origin
git branch -D sync/upstream-$(date +%Y-%m-%d) # delete the local sync branch
```

A small wrinkle worth knowing (not a bug): GitHub's "Create a merge commit" produces a *new* merge commit on the server side, distinct from the one you made locally. So after the pull, `git log -1 main` shows a commit SHA you didn't author (e.g. local `ad0979a7` ≠ origin's `07a8bce1`). The tree contents match; only the SHA differs. Don't try to align them — just let `git pull --ff-only` advance.

## Task 3 — Investigate custom-UI impact (deep)

Triggered when upstream's diff touches backend files that our `custom-v2/` (v2/v3) frontend might call into, or when the user asks what needs adapting after a sync.

### Governing principle: Adapt vs Port — two separate jobs

Every upstream sync produces two distinct kinds of custom-UI work, and they must never be conflated:

- **Adapt (in the sync PR).** Changes needed so custom-v2 *keeps compiling and its existing features keep working* against the new backend contracts — renamed config paths, changed DTO shapes, new required fields. These are **breakages**; fix them inside the sync branch so the merge lands green. The `npm run build` for backend + frontend is what surfaces them (a clean Test/Build is not enough — type errors against `@sync-in-server/backend` only show in a real build; see the "run nest build before pushing" rule).
- **Port (separate backlog issues).** New *user-facing features* upstream shipped to the classic UI that v2 simply doesn't have yet — a new editor option, a new dialog exposing new choices, a new screen. These have **no compile impact** (v2 keeps building without them), so they are NOT the sync's job. **File one GitHub issue per missing feature and leave them out of the sync PR.**

**Why the split is load-bearing:** the sync PR merges with a *merge commit* to keep upstream lineage legible (per CLAUDE.md). Bundling feature ports into it bloats that commit with unrelated work and muddies the "what did upstream change vs what did we build" boundary. Feature ports are normal fork work — they belong on `feat/` branches that squash-merge, picked up via the `tackle-issues` flow, after the sync is in.

When you finish the Adapt work, **explicitly enumerate the Port gaps** (don't let "it builds" imply "we have everything"). If the user confirms, open the issues; default to filing rather than porting inline. Distinguish from features that need *no* v2 work at all: backend-only changes (e.g. multilingual full-text search — v2 search benefits automatically) and session/config-level changes (auth hardening, token renewal) have no v2 UI surface — say so and don't file noise.

Worked example — the 2026-06-23 sync (2.4.0, PR #283): two contract changes were **adapted** in the sync PR (`files.onlyoffice` → `files.editors.onlyoffice` regrouping broke 4 fork sites; `CompressFileDto` dropped `tgz` for `'tar'|'zip'` + `compression:boolean`, broke 2 v2 call sites). Two new user-facing features were **filed as issues, not ported**: the Euro-Office editor option (#284) and the v2 archive compression dialog (#285).

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

Classify each change into one of these buckets:

| Bucket | Meaning | Custom-UI impact |
|---|---|---|
| **Wire contract changed** | HTTP method, URL, DTO shape (fields added/renamed/removed with semantic meaning), response shape | **Almost certainly breaks us.** Grep our callers; patch. |
| **Internal refactor, signature change** | Service method signature changed (e.g. `foo(user, url: string)` → `foo(user, dto: FooDto)`) but HTTP surface unchanged | **Doesn't affect frontend.** Note in report, skip. |
| **Behaviour change** | Same contract, new validation / error codes / side effects (e.g. "Content-Length now required", "quota now checked pre-download") | **Probably compatible; verify error handling.** Check we surface the new error paths. |
| **New component / styles in classic UI** | New `.component.ts`, `.html`, `.scss` or inline styles for a feature classic ships and we may want to mirror in v2 (e.g. upstream's TipTap markdown viewer) | **No automatic impact** — `custom-v2/` has its own preview pipeline. But if the user wants v2 to gain visual parity, see [Style token translation](#style-token-translation-when-porting-classic-ui-into-custom-v2) — upstream's CSS uses a different token set than `.v2-root` and a literal copy-paste introduces invisible bugs. |
| **New user-facing feature in classic UI** | A new capability classic now exposes that v2 lacks — a new editor option, a new dialog with new choices, a new action/screen (e.g. 2.4.0's Euro-Office editor and the tar/zip compression dialog) | **No compile impact — this is a Port, not an Adapt.** Do NOT build it into the sync PR. File a backlog issue per the Adapt-vs-Port principle above. The *contract* side may still need an Adapt (e.g. the `CompressFileDto` change broke v2's hardcoded call even though the *dialog* is a separate port). |

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

For a sync you're actively resolving (not a standalone investigation), the Adapt patches go *into the sync branch* — the build won't go green otherwise — so apply them there and list them in the PR body. The accept/reject framing above is for the read-only investigation mode.

### Phase 4b — File Port gaps as issues (don't bundle into the sync)

For each **New user-facing feature** bucket entry (a Port, not an Adapt), open one GitHub issue rather than building it into the sync PR. Confirm with the user first, then:

```bash
gh issue create --repo zjean/server \
  --title "v2: <feature> (parity with classic, upstream <version>)" \
  --body "$(cat <<'EOF'
## Background
<which upstream commit shipped it (sha + subject); what classic gained>
<note that the sync only adapted the contract, not the feature>

## Current v2 state
<file:line showing what v2 hardcodes / lacks>

## Ground truth to mirror (classic UI)
<the classic component/service to read first — classic-UI-as-ground-truth>

## Acceptance
<what "done" looks like + verify via v2-dev-loop-verify>
EOF
)"
```

Keep the issue body anchored to concrete `file:line` and the classic component to mirror — these become the punch list when the feature is later picked up via `tackle-issues`. Always `--repo zjean/server`.

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

### New upstream features — v2 parity gaps (Port, filed as issues)
(per-feature bullet: what classic gained + the issue number filed; or "none")

### No v2 work needed (backend/transparent)
(terse list — backend-only or session/config-level changes with no v2 UI surface)

### Recommended follow-ups
- [ ] Apply patch to <file>:<line> — <one-liner>  (Adapt — into the sync branch)
- [ ] Add i18n key "<backend error string>" to en/nl (low priority)
- [ ] Issue #<n> filed for <feature> (Port — separate feat/ branch later)
- ...
```

Keep it scannable. If nothing needs adapting, say "No impact" explicitly and stop. Always close the loop on Port gaps explicitly — "no new user-facing features" is a valid and useful finding; silently omitting the section reads as "checked, nothing there" only if you say so.

## Style token translation (when porting classic UI into `custom-v2`)

Triggered specifically when the user wants v2 to gain visual parity with a classic-UI feature upstream just shipped (the markdown viewer in PR #201 is the canonical example). The upstream component's CSS is a tempting copy-paste target, but **upstream uses a different design-token namespace than `.v2-root`**, and the var() fallbacks paper over the mismatch silently.

### The hazard, concretely

`.v2-root` (the Stack/navy palette from `feat(custom-v2): adopt Stack design tokens`) defines these and only these surface/text/status tokens:

- Surfaces — `--si-bg0` (canvas) … `--si-bg6` (deepest hover/active)
- Text — `--si-fg`, `--si-fg-muted`, `--si-fg-faint`, `--si-fg-tertiary`, `--si-fg-ghost`
- Borders — `--si-border`, `--si-line`, `--si-line-strong`, `--si-line-bold`
- Accents — `--si-accent`, `--si-accent-hover`, `--si-accent-soft`, `--si-accent-deep`, `--si-accent-fg`, `--si-accent-line`, `--si-nav`, `--si-nav-soft`, `--si-nav-line`
- Status — `--si-rose` (red), `--si-amber`, `--si-green`, `--si-cyan`, `--si-violet` (plus `*-soft` variants)
- Radii — `--si-r1` … `--si-r4`
- Shadows — `--si-shadow1`, `--si-shadow2`, `--si-shadow3`
- Fonts — `--si-sans`, `--si-serif`, `--si-mono`, `--si-display`

Upstream's classic components reach for tokens that **don't exist in v2** — most commonly `--si-bg`, `--si-bg2` (yes, v2 has `--si-bg2`, but classic's meaning differs), `--si-danger`, `--si-fg` with a *light-mode* fallback (`#111`), and so on. Where v2 has no matching token, the `var(--missing, #fallback)` form silently activates the fallback — and the fallbacks are usually light-mode literals (`#fff`, `#111`, `#c0392b`), so a navy v2 surface ends up with a white sheet painted across it.

This is exactly how PR #201 shipped a markdown viewer with white text on a white background; PR #202 fixed it.

### Translation recipe

When porting a classic component into `custom-v2/preview/` (or anywhere else under `.v2-root`):

1. **List every `var(--si-*)` reference** in the source component's CSS/SCSS — both the file itself and any classic stylesheet it imports.
   ```bash
   rtk proxy grep -oE 'var\(--si-[a-z0-9-]+' <classic-source-path> | sort -u
   ```
2. **For each token, check whether it exists in v2.** The authoritative inventory is the section above, or live in the running app — `getComputedStyle(document.querySelector('.v2-root'))` iterated for `--si-*` properties.
3. **Translate missing tokens to the closest v2 equivalent.** Common rewrites (drawn from PR #202):

   | Classic / fallback pattern | v2 replacement | Why |
   |---|---|---|
   | `var(--si-bg, #fff)` (canvas) | `var(--si-bg0)` | `--si-bg` does not exist; `#fff` paints a white sheet on the navy canvas. |
   | `var(--si-bg, ...)` (raised surface) | `var(--si-bg1)` or `--si-bg2` | Pick by elevation — `bg1` for the same-canvas feel, `bg2` for "this is a toolbar / chrome panel". |
   | `var(--si-fg, #111)` | `var(--si-fg)` (drop fallback) | The token always exists under `.v2-root`; `#111` is a light-mode literal that defeats the dark palette. |
   | `var(--si-danger, #c0392b)` | `var(--si-rose)` | v2 has no `--si-danger`; `--si-rose` is the warm-red status token. |
   | Hover bg as `rgba(0,0,0,0.05)` | `var(--si-bg3)` | v2 has dedicated hover/active levels — use them instead of inline alpha tricks. |
   | Active bg as `rgba(0,0,0,0.08)` | `var(--si-bg4)` | Same reason. |

4. **Drop the `var()` fallback values entirely** for v2 components. The tokens are guaranteed under `.v2-root`, so a fallback only fires when someone typos the variable name. Leaving the fallback in lets that typo render visibly wrong instead of failing fast.
5. **Drop any explicit `light`/`dark` class plumbing.** v2's palette is intentionally always-dark — there's no light/dark switch at `.v2-root`. Selectors like `.foo--dark .ProseMirror { color: ... }` are dead code and should go.
6. **Verify visually after the port.** Either:
   - browser-test through `chrome-devtools` (see PR #202's session for the recipe — log in, navigate to the screen, screenshot), or
   - inspect the computed styles at the host element and walk down to the leaf (look for `color: oklch(0.97 ...)` on `oklch(0.22 ...)` — the navy-on-near-white pair indicates the canvas is wired correctly).

If the user asked you to port the visual side of a classic feature into v2, deliver the translation as part of the same change — the bug surfaces *only* under v2 dark mode and is invisible during unit tests / Storybook with a light background, so it's easy to ship.

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
