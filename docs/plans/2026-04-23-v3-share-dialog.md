# v3 share dialog (milestone 4, phase 4.7)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.7
**Depends on**: 4.1 context menu, 4.5 tree picker, 4.6 toast + confirm dialog, 4.14 spaces browser

## Goal

From the `more` menu on any file row and the Sharing tab of `/v2/file`, the user can create, edit, and revoke shares with users and groups, set permissions, and optionally set an expiration. All without leaving v2.

## Non-goals for 4.7

- **Public-link shares** — covered by 4.8.
- **Share receipt / in-share browsing view** — v2 already has `/v2/shared/with-me` surfacing as a list; navigating *into* a share still punts to classic. Out of 4.7.
- **Guest invitations** — explicitly deferred to a later milestone per the main plan.
- **Send-as-email notifications** — server-side feature orthogonal to the dialog.

## Scope trim decisions

1. **One share target per operation.** Classic allows sharing with multiple users+groups at once; v2 does one at a time for MVP. "Add more recipients" comes later.
2. **Permissions as three presets** (`Viewer`, `Editor`, `Manager`) mapped onto the `a/m/d/si/so` flags, instead of the raw 5-checkbox matrix classic exposes. Power users can still adjust in classic.
3. **Expiration date picker** reuses native `<input type="date">`. No custom calendar.
4. **Manage existing shares** lives in the row-menu's Share action: opens a list-of-shares view with Revoke buttons; Edit re-opens the create dialog prefilled.

## Architecture

### New components

- `components/user-group-picker.component.ts` + `user-group-picker.service.ts` — a searchable autocomplete that calls the classic `/api/app/users/search?query=…` and group equivalent. Returns a single selected entity `{ id, type: 'user'|'group', name, email? }`. ~200 LOC.
- `components/share-dialog.component.ts` + `share-dialog.service.ts` — modal that wraps the user-group-picker, permission preset radios, and expiry picker. `open({ file, existingShareId? }): Promise<ShareResult | null>`. ~250 LOC.
- `components/shares-list-dialog.component.ts` — list of existing shares for a file, with Edit / Revoke actions. Opens share-dialog for edit. ~120 LOC.

### Classic reuse

- `SharesService.createShare / updateShare / revokeShare` — hit `/api/app/shares` endpoints, return share props.
- `UsersService.searchUsers` and groups equivalent.
- `FileShareProps` interface from backend.

### Row-menu wiring

Flip the Share item from `disabled: true` to enabled in **personal/**, **space-files/**, and any share-capable surface. Action opens `shares-list-dialog` (if file already has shares) or `share-dialog` directly (first share).

## Tasks

1. `components/user-group-picker.{component,service}.ts` + mount. ~200 LOC.
2. `components/share-dialog.{component,service}.ts` + mount. ~250 LOC.
3. `components/shares-list-dialog.component.ts` + mount. ~120 LOC.
4. Wire Share row-menu item on personal + space-files. ~40 LOC.
5. Wire Sharing tab of `/v2/file` to the same list + dialog. ~60 LOC.
6. i18n (Dutch). ~30 LOC.

Commit-per-task.

## Manual test checklist

1. Row menu → Share on a fresh file → share-dialog opens, user picker focused.
2. Type a username → autocomplete shows matches → pick one.
3. Choose permissions preset → save → toast "Shared with <name>" → dialog closes.
4. Row menu → Share again → shares-list-dialog shows the new share with Revoke + Edit.
5. Edit → pre-filled, change permission preset, save → toast "Share updated".
6. Revoke → confirm dialog → share gone, toast "Share removed".
7. Set expiry date → save → verify in classic that expiresAt is set.
8. Dutch locale → all labels translate.
9. Error path (server 403) → error toast, dialog stays open.

## Follow-ups (NOT in 4.7)

- Multi-recipient in a single share operation.
- Raw permission matrix for power users.
- Share-receive flow (what the sharee sees).
- Guest invite.

## Open questions

1. **Permission preset mapping** — `Viewer = 'a' off, 'm' off, 'd' off`? `Editor = a+m`? `Manager = a+m+d+si`? Lean on classic's defaults.
2. **Picker search endpoint** — users and groups are separate endpoints in classic. Merge client-side (slower) or add a combined endpoint? Lean merge client-side, it's small data.
3. **Where does the Share action live when file already has shares?** Jump straight to list view (recommendation) or always open create dialog?
