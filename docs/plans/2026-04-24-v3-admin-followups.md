# v3 admin stack — follow-ups deferred from phases 5.3 + 5.4

**Status**: open
**Date filed**: 2026-04-24
**Parent**: phases 5.3 + 5.4 shipped in PR #55

This doc catalogues admin-surface items that were explicitly deferred from the first admin-stack PR. Each entry calls out whether the **backend already supports it** (so there's no "wait for backend work" dependency) and sketches the frontend work needed.

**TL;DR**: every item in this doc is **backend-ready**. No new NestJS controllers, DTOs, or database migrations required — just frontend glue.

## 1 · 2FA re-auth on admin mutations

### Backend
Fully supported. The `AuthTwoFaGuard` (password + TOTP code) and `AuthTwoFaGuardWithoutPassword` (TOTP code only) guards are already applied to every admin mutation in `admin-users.controller.ts`:

| Route | Guard | Purpose |
|---|---|---|
| `POST /api/admin/users` | `AuthTwoFaGuardWithoutPassword` | Create user — TOTP code if admin has 2FA enabled |
| `PUT /api/admin/users/:id` | `AuthTwoFaGuardWithoutPassword` | Update user — same |
| `DELETE /api/admin/users/:id` | `AuthTwoFaGuard` | Delete user — TOTP code + password |
| `POST /api/admin/guests` | `AuthTwoFaGuardWithoutPassword` | Create guest — same as user |
| `PUT /api/admin/guests/:id` | `AuthTwoFaGuardWithoutPassword` | |
| `DELETE /api/admin/guests/:id` | `AuthTwoFaGuard` | |
| `POST /api/admin/impersonate/:id` | `AuthTwoFaGuard` | Impersonate — TOTP code + password |

Guard behaviour: if the admin's own `twoFaEnabled` flag is off **and** server config disables TOTP MFA globally, the guard no-ops. That's why the shipped PR #55 works for admins without 2FA — the empty-headers request falls through cleanly.

Headers: `sync-in-two-fa-code` (TOTP code), `sync-in-two-fa-password` (current password, when required). Named constants: `TWO_FA_HEADER_CODE`, `TWO_FA_HEADER_PASSWORD` in `backend/src/authentication/constants/auth.ts`.

### Frontend (needed)
Port or reuse classic's `user-auth-2fa-verify-dialog.component.ts`. Two options:

1. **Port to v2** (~150 LOC): a new `<app-v2-2fa-dialog>` with two input fields — password (when `withPassword`) and 6-digit TOTP. Returns `HttpHeaders` on submit. Wrap admin mutations in v2 with a check: if response is 403 "Missing TWO-FA password" or "Missing TWO-FA code", open the dialog, retry with the returned headers.
2. **Reuse classic's dialog** via the ngx-bootstrap modal system that still runs in the shared app root. Cheaper to ship but visually jarring; classic uses Bootstrap styling.

Recommend option 1 — consistent with how we treat every other classic dialog (confirm, tree picker, link-dialog, share-dialog all got v2 rewrites).

### Impact if not shipped
Admins with 2FA enabled cannot create / edit / delete users from `/v2/admin/users` today — the backend returns 403 and the current dialog shows the server's message as an error. Workaround: fall back to classic.

## 2 · Guest users

### Backend
Fully supported. Parallel endpoints to admin-users live under `/api/admin/guests` (controller lines 61–88). Same DTO shape (`CreateUserDto` / `UpdateUserDto`) — the only difference is which table/role the record goes into.

`AdminService` already carries the typed overloads: `listUsers(true)`, `getUser(id, true)`, `createUser(dto, headers, true)`, `updateUser(id, dto, headers, true)`, `deleteUser(id, { isGuest: true, deleteSpace }, headers)`.

### Frontend (needed)
Small. Add a segmented toggle at the top of `/v2/admin/users`:

```
[ Users | Guests ]
```

Passing `true` to the existing service calls. Guest-specific fields to add to the edit dialog: `managers` (array of manager user ids), which the `GuestUser` interface exposes.

Estimated ~80 LOC in `admin-users.component.ts` + a `member-picker` for the managers field (reuse the one from share-dialog).

### Impact if not shipped
Admins who rely on guest accounts (common pattern: external reviewers) have to use classic for that workflow.

## 3 · Impersonate identity

### Backend
Fully supported: `POST /api/admin/impersonate/:id` and `POST /api/admin/impersonate/logout`. Requires `AuthTwoFaGuard` (password + TOTP).

`AdminService.impersonateUser` already exists and returns `LoginResponseDto`. Classic swaps the auth token via `AuthService.initUserFromResponse(r, true)` and navigates to `/user/account`.

### Frontend (needed)
~40 LOC. A row-action in `/v2/admin/users` (after the edit + delete buttons) that calls `adminService.impersonateUser(u.id, twoFaHeaders)` → on success, calls `adminService.initImpersonateUser(r)` which handles the auth swap. Wired only once 2FA dialog (follow-up §1) exists, because the guard demands it.

A "Stop impersonating" affordance belongs in the title bar when the session is in an impersonated state (classic shows a banner). Could land as a later follow-up.

### Impact if not shipped
Admins debugging user-reported issues have to use classic (rare but high-friction when it happens).

## 4 · Per-group membership editor

### Backend
Fully supported:

| Route | Purpose |
|---|---|
| `PATCH /api/admin/groups/:groupId/users` | Body: `number[]` of user ids. Adds them to the group as MEMBER role. |
| `DELETE /api/admin/groups/:groupId/users/:userId` | Remove a user from the group. |
| `PATCH /api/admin/groups/:groupId/users/:userId` | Body: `{ role: USER_GROUP_ROLE }`. Update role (MEMBER ↔ MANAGER). |
| `GET /api/admin/groups/browse/:name?` | Lists `Member[]` of the group when `:name` is set; lists top-level groups otherwise. The shipped `/v2/admin/groups` uses it for the "Load" button. |

`AdminService` methods `addUsersToGroup`, `removeUserFromGroup`, `updateUserFromGroup` already wrap these.

### Frontend (needed)
A membership drawer — click a group row → open a slide-out panel showing the current members, each with a role dropdown (member / manager) and a ×. Bottom: a member-picker (reuse the one from share-dialog) to add new members.

~300 LOC as a new `<app-v2-admin-group-members>` component + a "Members" click handler on the group row. Can be phased:

- v1: read-only list + × to remove (~120 LOC)
- v2: role dropdown + member-picker (~180 LOC)

### Impact if not shipped
Admins editing group membership today use the user-edit dialog's `groups: number[]` field (user-centric view). That works but is indirect — you can't open a group and see who's in it, and role changes need the separate endpoint.

## 5 · Personal-groups admin browse

### Backend
Fully supported via `GET /api/admin/personal_groups/browse/:name?` (controller line 99). Same `GroupBrowse` response shape as regular groups. `AdminService.browseGroup(name, true)` already passes the `personalGroups` flag.

### Frontend (needed)
Minor. Add a tab or segmented toggle to `/v2/admin/groups`:

```
[ Groups | Personal groups ]
```

Toggle re-calls `browseGroup` with the flag. Personal groups are owned by individual users and are rarely edited by admins, so this is low priority; but the backend is free so flipping the switch is trivial (~40 LOC).

### Impact if not shipped
Admins can't list or modify personal groups via v2. Low-impact; classic still has it.

## 6 · Member search (enabling faster picker UX)

### Backend
Fully supported: `SEARCH /api/admin/members` with `SearchMembersDto` → returns `Member[]`. `AdminService.searchMembers` wraps it.

### Frontend (needed)
No standalone screen — this powers the member-picker used by §2 (guest managers) and §4 (group membership). The share-dialog already uses a similar picker against `/api/users/me/search/members`; refactoring that picker to optionally target the admin endpoint would unlock both follow-ups with a small change (~30 LOC).

## Priority ordering (suggested)

If picked up, this order minimises blocker chains:

1. **§1 — 2FA dialog** — unblocks admins with 2FA from using `/v2/admin/*` at all, and is a prerequisite for §3.
2. **§4 — Group membership drawer** — biggest daily-driver gain; scope v1 (read-only + remove) first.
3. **§2 — Guests toggle** — nice-to-have for deployments with external reviewers.
4. **§3 — Impersonate** — low-frequency; gated on §1.
5. **§5 — Personal groups** — low-frequency; trivial to bolt on.
6. **§6 — Shared member picker** — tactical; fold into §2 / §4 whichever lands first.

## Estimated total LOC

~700 LOC frontend across all six items. No backend work.
