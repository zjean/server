# v3 public link dialog (milestone 4, phase 4.8)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.8
**Depends on**: 4.1 context menu, 4.6 toast + confirm dialog

## Goal

From any file row or `/v2/shared/via-links`, the user can create a public share link, set a password and expiry, toggle download vs preview-only, revoke it, and copy the generated URL to the clipboard.

## Non-goals for 4.8

- **Authenticated share dialog** (users/groups) — that's phase 4.7.
- **Public-link recipient view** — what a link visitor sees. Out of scope; classic handles it per the main plan's §4.
- **Email-to-recipient sending** — classic has it, v2 can add later.
- **Download count limits** — the backend supports it; UI can add in a follow-up.

## Architecture

### New components

- `components/link-dialog.component.ts` + `link-dialog.service.ts` — modal with a permission toggle (Preview-only / Download), password field (optional, generated button), expiry date (optional), plus on save a URL + copy button. `open({ file, existingLinkId? }): Promise<LinkResult | null>`. ~280 LOC.
- `components/links-list-dialog.component.ts` — list of existing links for a file, with Copy / Edit / Revoke actions. ~100 LOC.

Could be a branch of share-dialog's UX, but links are different enough (no recipients, URL is the deliverable) that a separate dialog is clearer.

### Classic reuse

- `LinksService.createLink / updateLink / revokeLink` — `/api/app/links` endpoints.
- Existing link row template on `/v2/shared/via-links` already renders data; this phase adds the CRUD operations.

### Row-menu wiring

Add a new menu item **"Get link"** below Share (or conditionally replace Share depending on permission). Opens link-dialog.

### /v2/shared/via-links enhancements

- Each row gets Copy / Edit / Revoke buttons — reuse the context-menu primitive with link-specific actions.
- Empty state: "No public links yet — create one from any file's ⋯ menu".

## Tasks

1. `link-dialog.{component,service}.ts` + mount + password generator helper. ~320 LOC.
2. `links-list-dialog.component.ts` + mount. ~100 LOC.
3. Wire "Get link" into personal + space-files row menus. ~40 LOC.
4. Wire Copy / Edit / Revoke context menu on `/v2/shared/via-links`. ~80 LOC.
5. Clipboard helper (`navigator.clipboard.writeText` with toast feedback). ~20 LOC.
6. i18n (Dutch). ~30 LOC.

## Manual test checklist

1. Row menu → Get link on a file → dialog opens, toggles visible (preview-only default), password empty, expiry empty.
2. Tick "Set password" → password field shows + "Generate" button.
3. Click Generate → fills a 12-char strong password.
4. Set expiry date.
5. Click **Create** → URL appears with Copy button, toast "Link created", dialog stays open.
6. Click Copy → clipboard has the URL, toast "Copied to clipboard".
7. Close, reopen via row menu → links-list-dialog shows the link.
8. Edit → password field and expiry pre-populate (password masked), change expiry, save → toast "Link updated".
9. Revoke → confirm → link gone from list + from `/v2/shared/via-links`.
10. Dutch locale → labels translate.

## Follow-ups (NOT in 4.8)

- Download count limit field.
- Send-as-email.
- QR code for the link.

## Open questions

1. **"Get link" label** — "Get link", "Create link", or inline with Share? Lean **"Get link"** — most apps use this.
2. **Password strength meter** — nice polish; skip for MVP.
3. **Default preview-only** vs download — lean preview-only for safer default; user can opt in to download.
