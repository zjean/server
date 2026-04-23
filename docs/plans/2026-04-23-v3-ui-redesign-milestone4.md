# Sync-In v2 UI redesign — milestone 4 plan

**Status**: drafted, not approved
**Date**: 2026-04-23
**Predecessor**: [milestone 3](./2026-04-23-v3-ui-redesign-milestone3.md)

## 0 · Where we are

Milestone 3 shipped the last of §1's screens (People) and closed the Create Space modal deferral (PR #26). Every left-nav route now has a real v2 implementation: Recents, Personal (list/grid/gallery), Spaces index + Create modal, Shared × 3, Trash, File detail, Viewer, Search, Settings, People. Chrome primitives (title bar, app rail, dock rail, breadcrumbs, transfers popover) are stable. i18n wrapping + Dutch translations landed in PR #27. A cluster of post-ship bugs was fixed in PRs #28 and #30.

**But** — those screens mostly show data. A v2-only user can browse but cannot yet upload, rename, copy, move, delete, share, comment, or edit any file without routing back to classic. That's the milestone-4 gap.

## 1 · Goal

> **A non-admin user can complete 90% of their daily work in v2 without routing to classic.**

"Daily work" = browse files, upload, organize (rename / move / copy / delete), share (to users or via link), view + edit common file types (text, PDF, office docs, media), comment, and manage their own profile.

Admin surfaces (admin-users / admin-groups / admin-spaces / admin-tools), the full sync-desktop-client story, guest-invitation flow, the unauthenticated public-link view, and Collabora (OnlyOffice alternative) are all explicitly **out of scope** for milestone 4 and will fall through to classic until a later milestone.

## 2 · Scope

Eleven phases, grouped into four themes. Each phase lands as one PR (or a tight sequence) off `main`, squash-merged. Rough ordering follows dependency chains; a few phases are parallelizable (noted inline).

### Theme 1 — File operations (the big missing primitives)

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 4.1 | `feat/v3-row-context-menu` | Reusable context-menu primitive + wire into Personal/Spaces/Shared/Trash rows (Open / Download / Share / Delete / Rename / Copy / Move). Spec already drafted at [`2026-04-23-v3-row-context-menu.md`](./2026-04-23-v3-row-context-menu.md). | ~500 |
| 4.2 | `feat/v3-upload` | Drag-and-drop + file-picker + folder upload (webkitRelativePath). Progress piped through the existing transfers popover. Classic `FilesService.upload` reused. | ~600 |
| 4.3 | `feat/v3-new-folder-and-file` | "New" dropdown in Personal/Spaces toolbar → new folder / new text file / download-from-URL. Small dialogs. | ~350 |
| 4.4 | `feat/v3-rename` | Inline rename on file rows. Collision handling mirrors classic (confirm-overwrite prompt). | ~300 |
| 4.5 | `feat/v3-copy-move-tree` | Reusable tree-picker primitive + Copy/Move flow. Largest phase in this theme — the tree picker is reusable for anchor-to-space and share-root-picker later. | ~900 |
| 4.6 | `feat/v3-delete-restore` | Delete to trash + permanent delete from list views; wire Restore/Empty-trash buttons in `/v2/trash` (today those are disabled placeholders). | ~300 |

Phases 4.1–4.4 are mostly independent and can land in any order once 4.1 ships the primitive other phases consume. 4.5 depends on 4.1 (Copy/Move as context-menu items) and blocks the tree-picker-dependent work in Theme 2. 4.6 depends on 4.1.

### Theme 2 — Sharing + links

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 4.7 | `feat/v3-share-dialog` | Create/edit/revoke a share (users + groups) from file rows and file-detail. Uses the tree picker from 4.5 for member selection and the manager-search pattern from PR #26. | ~700 |
| 4.8 | `feat/v3-link-dialog` | Public link CRUD — create, edit, regenerate password, toggle expiry/download-limit/preview-only, revoke. Wires `/v2/shared/via-links` actions. | ~600 |

Both can run in parallel with Theme 1 phases that don't modify the same row templates. Depends on the share/link services in classic (no backend changes needed).

### Theme 3 — Viewers / editing

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 4.9 | `feat/v3-pdf-viewer` | Integrate PDF.js per [`2026-03-31-pdf-viewer-default.md`](./2026-03-31-pdf-viewer-default.md) (a plan for that already exists; this phase ports it into the v2 file-detail preview stage). Toggle to OnlyOffice via pen icon when writeable. | ~400 |
| 4.10 | `feat/v3-text-editor` | CodeMirror integration for `.txt/.md/.js/.py/...` in file-detail. Auto-save every N seconds. Uses existing classic save handlers. | ~500 |
| 4.11 | `feat/v3-office-and-media` | OnlyOffice iframe embed for office docs in file-detail preview stage. HTML5 `<video>`/`<audio>` for media. Both replace the "Preview not available" placeholder for their mime classes. | ~600 |

Order 4.9 → 4.10 → 4.11 reduces merge friction in file-detail but they're otherwise independent.

### Theme 4 — Self-serve profile

| # | Phase | Summary | Est. LOC |
|---|---|---|---|
| 4.12 | `feat/v3-account-settings` | Rebuild the classic Account tab in v2: name/email/language/timezone, avatar upload, password change, online-status selector. Today the Settings screen routes to classic for all of these. | ~700 |
| 4.13 | `feat/v3-2fa-and-app-passwords` | 2FA enroll/disable + recovery codes + app-passwords create/list/revoke, still inside the v2 Settings shell. | ~500 |

Both depend on the Settings screen's sub-nav gaining real targets (currently each card just routes out). Otherwise independent.

### Cross-cutting infrastructure (lands as part of whichever phase first needs it)

- **In-app toast component** (used by every phase for success/error feedback) — extract in 4.1 or 4.2, whichever lands first.
- **Confirm-dialog primitive** (Destroy / Delete / Revoke confirmations) — extract in 4.6.
- **Form primitives** (text input, textarea, select, checkbox with the v2 styling already used in Create Space modal) — extract the first time a second consumer needs them, likely 4.3.
- **Comments sidebar** for file-detail (compose / reply / edit / delete) — scoped separately as a stretch phase (see §4).

## 3 · Dependencies and ordering

```
4.1 ──┬── 4.2, 4.3, 4.4 ── parallel
      └── 4.5 ──┬── 4.6
                ├── 4.7
                └── 4.8

4.9 ── 4.10 ── 4.11  (file-detail surface, sequence to reduce churn)

4.12 ── 4.13          (Settings surface)

Themes 1/2 and 3 and 4 can all run in parallel once 4.1 is in.
```

Nothing cross-cuts across themes except the toast primitive, which is trivial and can live wherever.

## 4 · Explicitly deferred to a future milestone

Not-a-gap, not-shipping-here. Listed so reviewers don't expect them.

- **Comments sidebar** (compose/reply/edit/delete on file-detail) — sits awkwardly between file-ops and editing; probably its own phase 4.14 if the user finds it high-priority, otherwise milestone 5.
- **Activity timeline** — depends on a backend endpoint that may not exist yet.
- **Notifications panel** — the classic navbar's bell-icon flow has no v2 home yet.
- **Admin surfaces** — `admin-users` / `admin-groups` / `admin-spaces` / `admin-tools`. Daily-driver for admins, rare for everyone else. Keep routing to classic.
- **Sync / desktop-client** — sync wizard, sync paths, sync clients list, sync-specific transfers view. The v2 transfers popover covers the quick-glance case. Full surface stays in classic.
- **Public link unauthenticated view** (what a recipient sees when they open a share link) — user-critical for recipients but a different product surface from the authenticated v2 app. Classic handles it.
- **Collabora Online** — OnlyOffice alternative; only relevant for deployments without OnlyOffice. Classic fallback is fine.
- **Command palette (Cmd-K)** + keyboard shortcut sheet + theme toggle — nice polish, not blocking daily-driver use.
- **Archive previewer** (list `.zip` contents inline) — rare.
- **Search result filters** — the v2 search screen ships; adding type/date/size/owner facets is a follow-up.
- **Multi-select + bulk operations** — the classic UI has them; v2 can start single-select in milestone 4 and add bulk in 5. Noted for clarity; if a reviewer thinks this is daily-driver critical, pull it into 4.1/4.5.

## 5 · Risks and mitigations

- **Scope creep into classic services.** Each phase reuses the existing classic services (no backend changes planned). If a phase hits a service-shape gap, trim the phase's feature surface rather than adding backend work. *Mitigation*: spike the service call at the start of each phase.
- **File-detail congestion.** Phases 4.9–4.11 all land in the file-detail preview stage; merge conflicts are likely if they run fully in parallel. *Mitigation*: serialize them on a single contributor.
- **Upload progress UX.** The existing transfers popover was built for classic's sync flows; piping browser-initiated uploads into it needs care so we don't misrepresent progress. *Mitigation*: add a distinct `UPLOAD` `FILE_OPERATION` label if needed (already enumerated in backend constants).
- **i18n drift.** Every phase adds strings. Follow the i18n pattern from PR #27 (English-as-key + `nl.json` add). *Mitigation*: include i18n in every phase's test plan; reject PRs with raw English in templates.
- **Upstream conflicts.** Milestone 4 is the biggest to date. Keep PRs small and merge promptly. Never let a branch sit long enough for an upstream sync PR to collide.
- **Context menu + tree picker are primitives under heavy reuse** (Theme 1 + 2 both consume). If their shape is wrong, many phases churn. *Mitigation*: treat 4.1 and the tree-picker part of 4.5 as "design twice, code once" — sketch the API in the PR description before building.

## 6 · Exit criteria

Milestone 4 is done when, for a non-admin user:

1. I can upload a file from my desktop into `/v2/personal` (drag, picker, or folder).
2. I can rename it, move it into a subfolder, copy it to a different space, and delete it — all from the row context menu, without leaving v2.
3. I can share it with another user or generate a public link with password + expiry, all from v2.
4. I can open a PDF and read it inline. I can open a `.docx` and edit it. I can play a `.mp4`.
5. I can change my own password and enroll in 2FA from `/v2/settings`, without classic redirecting me.
6. No toolbar or row action on any v2 screen still shows "Coming soon".

Admin, sync, Collabora, and the public-link view each remaining on classic is a conscious choice, not a gap.

## 7 · What's next

Pick the first phase and kick off `gsd-discuss-phase` (or the project's equivalent planning entry point) to flesh out a per-phase PLAN.md. Recommended order: **4.1 → 4.2 → 4.6 → 4.5 → 4.7 → 4.8 → 4.9 → 4.3 → 4.4 → 4.10 → 4.11 → 4.12 → 4.13**. That front-loads the context menu (everything consumes it), uploads (highest user value), then clears the trash deadweight, then the tree picker primitive, then sharing, then viewers, then finishing the small dialogs + profile.

## 8 · Changelog

- **2026-04-23** — initial draft after milestone-3 gap analysis.
