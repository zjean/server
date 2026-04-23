# v3 2FA + app passwords (milestone 4, phase 4.13)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.13
**Depends on**: 4.12 account settings shell + form primitives

## Goal

Enroll / disable 2FA (TOTP) and manage recovery codes. Create / list / revoke app passwords. All inside `/v2/settings` Security tab.

## Security notes

Phase deals with secrets (TOTP seeds, recovery codes, app-password tokens). Rules of thumb:

- **TOTP seeds are shown once** during enrollment (QR + base32). After that, the server never returns them.
- **Recovery codes are shown once** per generation. Regenerate invalidates prior set.
- **App passwords are shown once** after creation. After that, only metadata (name, last-used, created-at) is visible. No "view password" affordance.
- All three flows need a **"copy and I've saved it"** pattern — primary action disabled until the user clicks "I've copied the code".

## In scope

- **2FA enroll**: show TOTP QR + secret, verify with a code, show recovery codes.
- **2FA disable**: current password prompt → disable.
- **Regenerate recovery codes**: current password → show new set.
- **App passwords**: list with name/last-used, create (name → token shown once), revoke (confirm).

## Non-goals for 4.13

- **WebAuthn / hardware keys** — separate phase, needs a library decision.
- **SMS-based 2FA** — explicitly not supporting SMS.
- **Backup-code download as PDF** — nice polish, skip.

## Architecture

### Reuse classic services

- `UserService.enroll2fa / disable2fa / regenerateRecoveryCodes`
- `AppPasswordsService.listPasswords / createPassword / revokePassword`

### Component structure inside `/v2/settings` Security tab

- `components/twofa-enrollment-dialog.component.ts` — 3-step wizard (QR → verify code → recovery codes). Uses confirm-dialog primitive as base; ~200 LOC.
- `components/twofa-disable-dialog.component.ts` — password re-auth + disable. ~80 LOC.
- `components/recovery-codes-dialog.component.ts` — show codes with copy-all button. ~100 LOC.
- `components/app-passwords-card.component.ts` — list + create button + revoke row action. ~180 LOC.
- `components/app-password-create-dialog.component.ts` — name input → generated token reveal. ~120 LOC.

QR rendering: use a small pure-JS QR library or the server-side endpoint if it returns an SVG. Let's check what classic uses — if it's a client lib, add it as a dep; if server-side, just fetch.

## Tasks

1. 2FA enrollment dialog + classic service glue. ~250 LOC.
2. 2FA disable dialog. ~100 LOC.
3. Recovery codes dialog + regenerate flow. ~130 LOC.
4. App passwords card + list rendering. ~200 LOC.
5. App password create dialog. ~140 LOC.
6. Settings Security tab composition. ~80 LOC.
7. i18n — more strings than 4.12, budget ~60 LOC of nl.json.

## Manual test checklist

1. **Enroll 2FA**: Settings → Security → Enable 2FA → wizard shows QR + secret → scan with authenticator → enter code → wizard shows recovery codes with "I've saved them" gated primary → confirm → toast.
2. **Login with 2FA on**: log out, log in → classic shows 2FA prompt — confirm that flow still works (v2 login change not in scope).
3. **Recover with recovery code**: same — classic's recovery flow unchanged.
4. **Regenerate codes**: click Regenerate → password re-auth → new codes shown → old invalidated (verify by trying an old code in classic).
5. **Disable 2FA**: password re-auth → confirm → 2FA off.
6. **Create app password**: enter name "test-client" → get token once → paste into an MCP test client and connect → works.
7. **Revoke app password**: confirm dialog → gone from list → client can no longer connect.
8. **Dutch locale**: all security labels translate.

## Follow-ups (NOT in 4.13)

- WebAuthn registration.
- 2FA preferred method per device.
- App-password scope restrictions (read-only tokens).

## Open questions

1. **QR library vs server-side SVG** — need to inspect classic.
2. **Recovery code count** — classic uses 10; match unless a reason to change.
3. **App password default expiry** — none (user-managed) or 1 year default? Lean none, user decides.
4. **"I've saved it" gating** — real gate (disable Close/Dismiss) or nudge (checkbox)? Lean real gate — this is the only time they see the secret.
