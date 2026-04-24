# Custom-UI impact investigation — where to look

When investigating upstream changes for frontend impact, these are the high-yield places to grep.

## Map: where custom-v2 lives and what it reuses

```
frontend/src/app/applications/
├── custom-v2/                     ← all our v2/v3 screens + helpers
│   ├── screens/
│   │   ├── admin/                 ← admin-users, admin-groups, admin-spaces, admin-tools
│   │   ├── personal/              ← personal-files component
│   │   ├── spaces/                ← user's spaces list + create modal
│   │   ├── space/                 ← single space browser
│   │   ├── shared/                ← shared-with-me / -with-others / -via-links
│   │   ├── file-detail/           ← file viewer + comments panel
│   │   ├── recents/, trash/, search/, settings/, people/
│   ├── components/                ← shared v2 primitives
│   │   ├── share-dialog.component.ts
│   │   ├── link-dialog.component.ts
│   │   ├── user-group-picker.component.ts
│   │   ├── two-fa-dialog.{service,component}.ts
│   │   ├── confirm-dialog.{service,component}.ts
│   │   ├── tree-picker.component.ts
│   │   ├── comments-panel.component.ts
│   │   └── ...
│   ├── layout/                    ← v2 layout shell, breadcrumb service
│   ├── icons/
│   └── v2.routes.ts, v2.constants.ts
└── (classic components)           ← pre-fork upstream code, mostly untouched
    ├── admin/admin.service.ts     ← reused by custom-v2 admin screens
    ├── files/services/files.service.ts
    ├── spaces/services/spaces.service.ts
    ├── spaces/components/dialogs/space-dialog.component.ts
    ├── users/user.service.ts
    ├── links/services/links.service.ts
    ├── shares/services/shares.service.ts
    └── ...
```

**The critical insight:** our custom-v2 rarely talks to the backend directly. Instead, it injects the **classic Angular services** (`AdminService`, `SpacesService`, `FilesService`, `UserService`, `LinksService`, `SharesService`) and calls their methods. Those services in turn hit `/api/...` endpoints.

So when upstream changes a backend contract, the *first* place impact shows up is in those classic services — and via them, in custom-v2.

## Shared classic services custom-v2 relies on

Primary (almost all custom-v2 screens touch these):
- `frontend/src/app/applications/admin/admin.service.ts`
- `frontend/src/app/applications/spaces/services/spaces.service.ts`
- `frontend/src/app/applications/files/services/files.service.ts`
- `frontend/src/app/applications/users/user.service.ts`
- `frontend/src/app/applications/shares/services/shares.service.ts`
- `frontend/src/app/applications/links/services/links.service.ts`
- `frontend/src/app/applications/notifications/notifications.service.ts`
- `frontend/src/app/applications/comments/comments.service.ts`

Secondary (specific features):
- `frontend/src/app/applications/sync/sync.service.ts`
- `frontend/src/app/applications/search/search.service.ts`
- `frontend/src/app/auth/auth.service.ts`
- `frontend/src/app/layout/layout.service.ts`

Shared models / DTOs imported from backend (any change here propagates to the frontend via TS types):
- `@sync-in-server/backend/src/applications/*/dto/*` — all DTO classes
- `@sync-in-server/backend/src/applications/*/interfaces/*` — response shapes
- `@sync-in-server/backend/src/applications/*/constants/*` — routes, enum values

## Grep patterns by change type

### Backend renamed an HTTP endpoint

Find the exported route constant — e.g. `API_FOO_BAR` in `backend/src/applications/foo/constants/routes.ts`. Then:

```bash
rtk proxy grep -rn "API_FOO_BAR\|'/api/foo/bar'\|\"/api/foo/bar\"" frontend/src
```

### Backend renamed a service method

The classic frontend service usually wraps it 1:1. Find the wrapper:

```bash
rtk proxy grep -rn "oldMethodName" frontend/src/app/applications/
```

If the wrapper renames on our side (`renameUser` → `updateUser`), also grep for the wrapper's name in custom-v2:

```bash
rtk proxy grep -rn "renameUser\|updateUser" frontend/src/app/applications/custom-v2/
```

### Backend changed a DTO shape

Find TS references to the DTO class:

```bash
rtk proxy grep -rn "FooDto\b" frontend/src
```

Both classic and custom-v2 can import DTOs via the `@sync-in-server/backend/...` path alias. If a field was added with a default, safe. If renamed or required, frontend needs patching.

### Backend added a new error response

New 4xx/5xx response codes / error messages don't break compilation but may surface as untranslated error toasts. Check for:
- i18n keys matching the new error message — add NL/EN if missing.
- Error handlers that `switch` on status code — may need a new branch.

### Backend behaviour change inside an existing endpoint

Hardest to detect. Read the commit diff carefully. Watch for:
- New `throw new HttpException(...)` — new failure path.
- New pre-check guards (quota, auth, validation) — responses may now 403/507 where they previously succeeded.
- Changed side effects (emits a new event, caches something differently) — subtle, may not break but worth noting in the PR body so the user knows to watch.

## Impact report template

When writing the final report (task 3 phase 5), use this structure. Keep it scannable.

```markdown
## Upstream changes — custom-UI impact

### Commits reviewed (N)
- `<sha>` <first line of commit message>
- ...

### Wire-contract changes (N)
- **`<commit-sha>` — <short>**
  - Change: <what happened in the DTO / route / response>
  - Callers: `<file>:<line>` — `<calling code snippet>`
  - Recommended patch: <concrete before/after edit>

### Internal refactors — no frontend impact (N)
- `<sha>` <short> — method signature change in `<file>`; HTTP surface unchanged.

### Behaviour changes — verify error handling (N)
- **`<sha>` — <short>**
  - Behaviour: <new validation / error path>
  - Where it surfaces in v2: <toast? task-queue? silent fail?>
  - Recommended: <add i18n key "<msg>" / add handler / none, mention in PR body>

### Recommended follow-ups
- [ ] Apply patch to `<file>:<line>` — <one-liner>
- [ ] Add i18n key `"<backend error string>"` to en.json + nl.json (low priority)
- [ ] None — <reason why no action needed>
```

If the report would be empty, just write `No impact — <commit-list> are internal backend refactors or dep bumps; custom-v2 untouched.`
