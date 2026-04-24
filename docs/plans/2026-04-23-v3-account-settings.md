# v3 account settings (milestone 4, phase 4.12)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.12

## Goal

Rebuild the classic Account tab in v2 at `/v2/settings`. Today each card on that screen routes to classic; 4.12 makes the common fields editable in place.

## In scope

- **Profile**: first/last name, email, language dropdown, timezone dropdown
- **Password change**: current password, new, confirm
- **Avatar**: current avatar + upload button (reuse `<input type="file" accept="image/*">`)
- **Online status selector**: Available / Busy / Absent / Offline

## Non-goals for 4.12

- **2FA + app passwords** — phase 4.13.
- **Notification preferences** (per-app toggles) — separate settings section.
- **Admin-only fields** (role changes, quota tweaks) — stays in classic.
- **Guest session management** — classic-only.

## Architecture

### Reuse classic services

- `UserService.updateProfile / changePassword / updateAvatar / setOnlineStatus` — all exist.
- `UserProps` interface from backend.

### Component structure

- `settings.component.ts` (already exists, punts to classic) is refactored to host four sub-components:
  - `components/settings-profile-card.component.ts` — name/email/language/timezone form.
  - `components/settings-password-card.component.ts` — password change form with strength indicator.
  - `components/settings-avatar-card.component.ts` — avatar preview + upload.
  - `components/settings-status-card.component.ts` — online status selector.
- All cards reuse the `form-primitives` bundle (see §2 of milestone plan) — extract here if they don't exist yet.
- Each card has its own Save button; no global save.

### Form primitives to extract

- `form-field.component.ts` — label + input + helper-text + error wrapper. ~80 LOC.
- `form-select.component.ts` — native `<select>` styled to v2 tokens. ~60 LOC.
- `form-password.component.ts` — password input with show/hide toggle + optional strength meter. ~80 LOC.

(These are reusable for future phases.)

## Tasks

1. Form primitives (field, select, password). ~220 LOC.
2. Profile card. ~150 LOC.
3. Password card with strength check. ~120 LOC.
4. Avatar card (reuse upload infra from 4.2, restricted to image types, 1MB cap). ~90 LOC.
5. Online status card. ~60 LOC.
6. Settings screen composition update. ~40 LOC.
7. i18n. ~40 LOC.

Commit-per-task.

## Manual test checklist

Walk each card end-to-end:
1. Change name + save → toast success → classic shows updated.
2. Wrong current password on password change → inline error, no server call.
3. Valid password change → toast, forces session check (new JWT).
4. Upload avatar → preview updates, sidebar avatar updates.
5. Change status to Busy → dot color in sidebar changes.
6. Language dropdown → active language recalculates on save (calls `l10n.setLocale`).
7. Dutch locale → all fields labelled in Dutch.

## Follow-ups (NOT in 4.12)

- Notification preferences surface.
- Per-space preferences.
- Session / device management (log out other devices).

## Open questions

1. **Save per card vs global save bar** — lean per-card.
2. **Avatar crop** — classic has a cropper. Skip for v1, server serves original.
3. **Password strength meter** — use `zxcvbn` (adds 400KB gzipped) or a hand-rolled 3-class check? Lean hand-rolled.
