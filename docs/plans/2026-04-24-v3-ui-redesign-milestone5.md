# Sync-In v2 UI redesign — milestone 5 plan

**Status**: drafted, not approved
**Date**: 2026-04-24
**Predecessor**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md)

## 0 · Where we are

Milestone 4 closed the file-operations gap: upload, new folder / text file / download-from-URL, rename, copy/move (with tree picker), delete/restore, share (users + groups), public links (create/edit/revoke), viewers for text/PDF/office/media, inline account settings. A non-admin user can now complete the core file-management workflow in v2 without routing back to classic.

**But** — three cohorts still force a switch to classic:

1. **Admins** — admin-users / admin-groups / admin-spaces / admin-tools have no v2 home. Routes fall through to classic.
2. **Collaborators** — no comments UI on v2 file-detail. Discussions on a file force a classic detour.
3. **Power users** — no bulk-select, no command palette, no notifications panel. These don't block daily work but they're the "v2 feels thinner than classic" tax.

## 1 · Goal

> **A v2-only user can complete 95%+ of their work — including administration, collaboration, and bulk operations — without routing to classic.**

Every scoped phase uses only existing backend surfaces. Anything that would require new backend work is deferred to a later milestone or dropped entirely. See §4.

## 2 · Scope

Eleven phases, grouped into four themes. Each phase lands as one PR (or a tight sequence) off `main`, squash-merged. A few phases are parallelizable — noted inline.

### Theme 1 — Collaboration (the big missing surface)

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 5.1 | `feat/v3-comments-sidebar` | Comments on `/v2/file/:path` — compose, reply, edit, delete. Right-side drawer matching the share-dialog pattern. Consumes existing `applications/comments` backend module. Surface a `Comments` row context-menu item that toggles the drawer. | ~700 |
| 5.2 | `feat/v3-notifications-panel` | Bell-icon popover off the v2 title bar. Lists unread + all notifications, mark-read, delete, delete-all. Consumes existing `applications/notifications` REST + websocket gateway. Wire the existing socket events through the v2 layout. | ~500 |

Both are Theme 2/3-independent and can run in parallel.

### Theme 2 — Admin surfaces

Four admin screens currently route to classic. Porting them is mostly CRUD table + edit dialog — the backend `applications/admin` module already exposes everything needed.

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 5.3 | `feat/v3-admin-users` | `/v2/admin/users` — list, filter, create, edit, disable, delete. Reuses form primitives + member-search from milestone 4. | ~800 |
| 5.4 | `feat/v3-admin-groups` | `/v2/admin/groups` — CRUD + membership editing. | ~600 |
| 5.5 | `feat/v3-admin-spaces` | `/v2/admin/spaces` — list all spaces (beyond the user's own), edit quota/enabled/owner. Distinct from the existing non-admin Spaces screen. | ~600 |
| 5.6 | `feat/v3-admin-tools` | `/v2/admin/tools` — server stats, re-index, config toggles exposed by the admin module. Shape depends on what the admin endpoints return; prototype first. | ~500 |

5.3 → 5.4 → 5.5 → 5.6 keeps dependency churn down (form primitives from 5.3 reused by 5.4/5.5; admin shell nav lands in 5.3).

### Theme 3 — Power-user polish

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 5.7 | `feat/v3-multi-select` | Bulk-select on `/v2/personal` and `/v2/spaces/:alias` (checkbox mode + shift/cmd-click). Wire the existing `Share`, `Copy`, `Move`, `Delete`, `Download` toolbar buttons to operate on the selection (loop the single-file API client-side, like classic). Re-enables the currently-disabled toolbar buttons. | ~900 |
| 5.8 | `feat/v3-command-palette` | ⌘K / Ctrl-K command palette — fuzzy navigate to any route, run any toolbar action on the current screen. Pure frontend. | ~600 |
| 5.9 | `feat/v3-shortcuts-sheet-and-theme` | Keyboard shortcut reference sheet (? key) + theme toggle (light/dark/system) in the dock rail. Both pure frontend. | ~400 |

5.7 is the highest-value of the three. 5.8 and 5.9 are polish — ship last.

### Theme 4 — Remaining classic-only surfaces

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 5.10 | `feat/v3-sync-clients` | `/v2/sync` — list registered desktop sync clients, revoke, add-new wizard (path pickers + scope). Backend routes exist in `applications/sync`. | ~700 |
| 5.11 | `feat/v3-public-link-view` | Unauthenticated recipient view for `/link/:uuid`. Needs password prompt, expiry/revoked messaging, file preview or download. Consumes existing public-link routes. Distinct from the authenticated public-link *management* shipped in milestone 4. | ~600 |

Both can run in parallel with everything else. 5.11 is a different product surface (logged-out) and needs a distinct route shell.

### Cross-cutting infrastructure

- **Checkbox primitive** + **selection store** — extract in 5.7; reused by 5.3/5.4/5.5 for row selection.
- **`mobileHome` toggle** in `/v2/settings` — small addition to the milestone-4 Account screen; fold into whichever phase ships first that touches settings (probably 5.2 via the notifications panel's subscription preferences, otherwise a standalone `chore/` PR).

## 3 · Dependencies and ordering

```
5.1  (comments)       ──┐
5.2  (notifications)  ──┼── parallel, independent
5.7  (multi-select)   ──┘

5.3 ── 5.4 ── 5.5 ── 5.6   (admin stack — serialize on shared admin shell)

5.8 ── 5.9              (polish — sequence to reduce layout churn)

5.10, 5.11              (parallel with anything)
```

Recommended ship order (highest-impact first):

1. **5.7 multi-select** — removes the biggest "classic is still ahead" gap.
2. **5.1 comments** — unblocks the collaboration workflow.
3. **5.2 notifications** — completes the chrome; closes the bell-icon gap.
4. **5.3 → 5.4 → 5.5 → 5.6 admin** — migrates the admin cohort off classic.
5. **5.10 sync**, **5.11 public-link-view** — last-mile; can slip to milestone 6 if scope tightens.
6. **5.8 palette**, **5.9 shortcuts/theme** — polish, defer if schedule slips.

## 4 · Explicitly dropped / deferred

Not shipping, with reasoning. Listed so reviewers don't expect them.

### Dropped entirely

- **Collabora Online** — OnlyOffice is the shipped office-editor; Collabora is only relevant for deployments without OnlyOffice, which we don't target. Classic fallback remains for anyone who needs it.
- **NC login-flow Redis backing** — single-replica deployments are the only target; the in-process LRU is sufficient.

### Deferred (needs new backend — out of scope under the "no new backend" rule for this milestone)

- **Activity timeline** — no activity / audit-log module in backend. `applications/files/events` is an in-process `EventEmitter`, not an HTTP surface. Would need a new persistence layer + query API. Defer to a later milestone when backend work is in scope, or drop if stakeholders don't prioritize.
- **Search result filters** (type / date / size / owner facets) — `SearchFilesDto` only accepts `content`, `fullText`, `limit`. Faceting needs a new DTO + query shape.
- **Archive previewer** (inline `.zip` contents listing) — no backend zip-listing endpoint; download-based archive creation exists but not read-inline. Rare enough to stay deferred.

### Deferred (frontend-only but low priority)

- **Cron to prune stale `<dataDir>/nc-uploads/`** — operational nit, not a user-facing feature. Ship as a `chore/` whenever convenient; no need to scope it here.
- **Guest-invitation flow polish** — milestone 4's share-dialog handles inviting existing users + groups. A "send an invite to a new email address" flow needs design discussion before implementation.

## 5 · Risks and mitigations

- **Admin surface scope creep.** `admin-tools` is the scariest — "config toggles" can balloon into "full site config UI". *Mitigation*: spike 5.6 first by listing every admin endpoint that exists and mapping to the smallest UI that covers it. If the result would exceed ~600 LOC, trim feature surface rather than adding backend work.
- **Multi-select semantic drift.** Bulk operations looping single-file APIs is fine for ≤100 items but slow for 1000s; classic has the same limitation. *Mitigation*: cap the selection at 500 items with a clear "use classic for larger" message; monitor real usage before adding bulk backend endpoints.
- **Notifications websocket wiring.** The existing socket gateway emits events but v2 doesn't listen yet. *Mitigation*: reuse the classic socket connection path — don't open a second socket.
- **Comments authorship UI.** Reply-threading vs flat list is a design call that the plan doesn't make. *Mitigation*: check classic's comments tab shape before writing 5.1; follow it unless there's a reason to diverge.
- **Public-link recipient view route conflicts.** The existing `/link/:uuid` surface is served by classic. *Mitigation*: scope 5.11 to add a `/v2/link/:uuid` route and let deployment decide which is the canonical link shape in a follow-up chore.
- **Upstream sync pressure.** Milestone 5 is bigger than milestone 4 on phase count. *Mitigation*: same rule — keep PRs small, merge promptly, never let a branch sit long enough for an upstream sync to collide.

## 6 · Exit criteria

Milestone 5 is done when:

1. An admin can manage users, groups, and spaces entirely from `/v2` (5.3 + 5.4 + 5.5). Server stats and config toggles visible without leaving v2 (5.6).
2. A collaborator can read and write comments on any file from the file-detail screen (5.1).
3. A power user can select 10 files in Personal, delete them in one click, and see the bell-icon flash with a deletion notification (5.7 + 5.2).
4. A recipient of a public link sees the v2 recipient UI, not the classic recipient UI (5.11).
5. A desktop-client user can add a new sync client without routing to classic (5.10).
6. A v2-only non-admin user has zero reason to type `/files/` or `/admin/` in the URL bar.

## 7 · Verifying existing functionality before each phase

Per `CLAUDE.md` — each phase starts by **reading the classic implementation** that does the same thing. Every time v2 has diverged from classic on a DTO sentinel, id convention, or call sequence, we've shipped a user-facing bug (see the link-share `id: 0` → `-1` regression in milestone 4). Open the classic component + service side-by-side with the v2 one; diff the network requests; match the call shape exactly.

This is not negotiable for any phase that talks to the backend.
