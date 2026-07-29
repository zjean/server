# Handoff — implementing in-editor version history for OnlyOffice / Euro-Office

- **Date:** 2026-07-28
- **Implements:** [`2026-07-28-onlyoffice-version-history-design.md`](2026-07-28-onlyoffice-version-history-design.md) — the
  design. This file is the task list, the environment recipe, and the list of things that will bite you.
- **Status:** **phase 1 is approved and built** — backend in #386, frontend in #387, browser-verified against a real
  document server on 2026-07-29 (§9 records what that settled, including two things this document guessed at).
  Phase 2 remains ungated and unstarted; design §5's second and third decisions still belong to the maintainer.
- **Audience:** a fresh agent with no memory of the audit that produced the design.

> **One correction to the design, which is otherwise accurate.** Its §3 mapping table says the editor's `user.id` comes
> from `String(row.authorId)`. `authorId` is **not exposed** by `VersioningService.listVersions` — `VersionProps`
> carries `author?: { login, fullName }` and nothing else (`interfaces/version.interface.ts:28-40`). Use
> `author.login` as the id and `author.fullName` as the name, and omit `user` entirely when `author` is absent (a
> system-originated snapshot, or an author account that has been deleted — `authorId` is `ON DELETE SET NULL`).

---

## 0. Read these, in this order

Budget an hour. Skipping any of the first three costs more than reading them.

1. [`2026-07-28-onlyoffice-version-history-design.md`](2026-07-28-onlyoffice-version-history-design.md) — **§0 first.**
   Its four terms (document key, revision id, changes archive, history entry) are the whole vocabulary, and three of
   them are routinely conflated. If you cannot state the difference between a document key and a revision id from
   memory, re-read §0 before writing code.
2. `CLAUDE.md` → **File versioning**, especially the seven invariants. **Invariant 7 is new** (#378, merged
   2026-07-28) and is what makes in-editor restore work at all.
3. `CLAUDE.md` → **NC mobile compat: always read upstream NC source first.** It governs this work too: the editor
   protocol is upstream ONLYOFFICE's, not ours, and it is not guessable. Every wire-format claim in the design carries
   an upstream citation; add citations for anything you discover.
4. [`2026-07-27-file-versioning-phase-d-handoff.md`](2026-07-27-file-versioning-phase-d-handoff.md) **§2** — the
   dev-stack recipe. Still authoritative. §1 below only adds the document-server half.
5. [`2026-07-27-file-versioning-phase-e-notes.md`](2026-07-27-file-versioning-phase-e-notes.md) **§1** — the four
   environment facts the e2e harness encodes. You will need all four if you add e2e cases.
6. [`2026-07-25-file-versioning-design.md`](2026-07-25-file-versioning-design.md) — the ADR. Skim; consult §5 (the
   coalescing window) and §9 (restore safety) when they come up.

---

## 1. State, and what is gated on whom

**Merged, and this work sits on top of all three:**

| PR | What it did | Why it matters here |
|---|---|---|
| #378 | `restoreVersion` drops the cached OnlyOffice document key | Without it, an in-editor restore appears to do nothing — the document server re-serves its own copy under the unchanged key. **Phase 1's restore is only correct because this landed.** |
| #379 | 308 on the legacy WebDAV redirect; corrected the `/track` comments | Unrelated to the panel, but it is where the route table in `custom-mobile-compat/constants/routes.ts` records that upstream's connector also serves `/ajax/history`, `/ajax/version`, `/ajax/restore` — the API this work reimplements. |
| #380 | the design doc | Your spec. |

**Three decisions belong to the maintainer** (design §5), and two of them gate work:

1. **Is phase 1 alone worth shipping?** If the answer is no, stop — everything below is moot.
2. **Does phase 2 justify a schema change and a second blob kind?** Phase 2 must not start before phase 1 has
   shipped anyway (design §4), so this can be answered later.
3. **The 300 s `onlyoffice` coalescing window**, deferred to the ADR §19 soak (#348). Phase 1's panel is where a user
   would first *see* it, so expect the question to resurface during browser verification — it is **not** yours to
   settle. See §6.9 for a fact that will help whoever does.

If you were dispatched without an explicit "phase 1 is approved", ask before writing code. Confirming costs one
message; building an unwanted panel costs a day.

---

## 2. The dev stack, including a real document server

Phase-D §2 gets you a server with versioning on. Everything there still holds — `npm run dev:db`,
`npm run dev:migrate`, `npm run -w frontend build`, `npm run dev:backend`, single origin on `:8080`, login
`sync-in` / `password`, v2 at `/#/v2/<route>`.

**This work additionally needs a document server**, because the panel is a document-server UI. You cannot verify any of
it against a stub.

- `docker/config/onlyoffice/docker-compose.onlyoffice.yaml` already pins one:
  `onlyoffice/documentserver:9.3.1.2`, `JWT_SECRET=onlyOfficeSecret`, `JWT_IN_BODY=true`, on `sync_in_network`.
- `docker/config/nginx/onlyoffice.conf` proxies `/onlyoffice/` → `http://onlyoffice:80/`. That path is
  `ONLY_OFFICE_INTERNAL_URI`, and it is what the manager falls back to when `externalServer` is unset
  (`only-office-manager.service.ts:207`): `documentServerUrl` becomes `<origin>/onlyoffice`. Without nginx in front,
  set `externalServer` instead and make the container reachable from the backend **and** from your browser — the
  browser loads `api.js` from it directly.
- The dev config **already enables OnlyOffice**: `environment.dev.dist.yaml` ships
  `editors.onlyoffice.enabled: true`, `secret: dev-onlyoffice-secret`. **The secret must match the container's
  `JWT_SECRET`** or every editor session fails with a token error. Change one, change both.
- Also set, for the duration:
  ```yaml
  applications:
    files:
      versions:
        enabled: true
        minIntervalSecondsByOrigin:
          onlyoffice: 0   # otherwise successive test saves coalesce into ONE version and the panel looks broken
  ```
  Put it back before you draw conclusions about real behaviour — `0` is a measurement setting, not a product one.

**Generating a .docx with history**, which is fiddly enough to be worth the recipe: create the file in the UI ("new
document"), open it in the editor, type, close (status 2 → save → version), reopen, type, press **Save** (forcesave →
status 6 → save → version). Two versions plus the live file is the smallest history that exercises ordinals,
`previous` and the "live file is last" rule. The WebDAV `curl` trick from phase-D §2 is faster but produces `webdav`
versions, which have no changes archive in phase 2 — fine for phase 1, useless for phase 2.

**Browser driving:** `agent-browser`, not the `chrome-devtools` MCP (not usable here). Phase-D §2 has the two
time-costing gotchas — stale snapshot refs, and screenshots intermittently failing with `os error 35` while `eval`
keeps working.

---

## 3. The one piece of plumbing the design leaves open: who may fetch a version's bytes

Read this before writing task T1.2; it is the only genuinely tricky part of phase 1.

The version response hands the editor a `url`, and **the document server fetches it, server-to-server**. There is no
browser session on that request: no cookie, no CSRF header. `VersioningController` is `@UseGuards(SpaceGuard)` behind
the global auth guard, so the existing `versions/content/:versionId/*` route answers 401 to the document server.

Upstream Sync-in already solved this for the live document, and the solution is a decorator you can reuse verbatim:

```ts
@Get(`${ONLY_OFFICE_ROUTE.DOCUMENT}/*`)
@OnlyOfficeEnvironment()          // = OnlyOfficeContext + ContextInterceptor + UseGuards(OnlyOfficeGuard, SpaceGuard)
onlyOfficeDocument(...)           // only-office.controller.ts:33-36
```

`OnlyOfficeGuard` runs `OnlyOfficeStrategy`, which pulls a JWT from the **`token` query parameter**, requires
`tokenType === TOKEN_TYPE.ONLY_OFFICE`, and validates it against `auth.token.access.secret`
(`only-office.strategy.ts:14-26`). `OnlyOfficeManager.genAuthToken` mints exactly that token with the refresh-token
expiry, and `buildUrl` appends it (`only-office-manager.service.ts:258-262`).

So:

- **The two browser-facing endpoints** (`editor-history`, `editor-version`) are called by the editor's event handlers
  running *in the page*. They keep ordinary `SpaceGuard` auth, like every other versioning route. Nothing new.
- **The `url` inside the version response** must point at a route carrying `@OnlyOfficeEnvironment()` and must have a
  `?token=<ONLY_OFFICE jwt>` appended.
- **You do not need a new signing site.** The frontend already holds such a token: it arrives inside
  `cfg.config.document.url`'s query string when `office-view.component.ts` fetches the settings. The history service
  can lift it and pass it to the version endpoint, which echoes it into the `url` it returns. If you would rather the
  server mint its own, `genAuthToken` is private — exposing it is a `mod(only-office)`, so prefer lifting the existing
  one and document that choice where you make it.

Two further notes on that route: it must be a **new** route rather than a second guard stack on the existing
`versions/content` one (Nest applies controller-level guards to every handler; two auth models on one controller is how
you get an accidentally-public endpoint), and `ContextInterceptor` is part of the composite for a reason —
`contextManager.headerOriginUrl()` is what makes generated URLs absolute and correct behind the proxy.

---

## 4. Phase 1 — history and in-editor restore. Two PRs.

TDD throughout: the repo's rule, and this area's bugs have all been ones a stub hid (phase-E notes §1).

### PR 1 — backend: the editor protocol adapter

Branch `feat/onlyoffice-editor-history`. Commit prefix `feat(custom-versioning)`, plus one `mod(only-office)` if you
end up touching an upstream file (you should not need to).

**T1.1 — a new service, not more methods on `VersioningService`.**
`custom-versioning/services/editor-history.service.ts`. `VersioningService` is the versioning domain; this is an
adapter to a third party's editor protocol, and the JWT signing in T1.3 has no business inside the domain service.
It depends on `VersioningService` (list, resolve) and `JwtService`.

**T1.2 — `GET versions/editor-history/*`.** Returns the array the editor's `refreshHistory` wants.

Add route constants to `custom-versioning/constants/routes.ts` following the convention its header documents — the
static verb comes **before** any id, so `editor-history`, `editor-version`, `editor-restore`. Export
`API_VERSIONS_EDITOR_*` alongside the existing ones; the frontend imports these constants rather than retyping paths.

Assert, in `editor-history.service.spec.ts`:

- **Ascending order.** `listByFileId` orders `desc(createdAt), desc(id)` (`versioning-queries.service.ts:55`) — the
  opposite of what the panel wants. Reverse it.
- **`created` in unix SECONDS.** Rows hold milliseconds (`VersionProps.mtime`, and the insert does
  `Math.floor(stats.mtimeMs)`). `editor.js:735` multiplies by 1000. Getting this wrong dates every entry to 1970.
- **`version` is a 1-based ordinal**, contiguous, in that ascending order. It is not a row id and the editor uses it as
  the panel's identity.
- **`key` is `` `${fileId}_${versionId}` ``.** Design §3 has the reasoning; the short version is that the content
  checksum is 64 chars (upstream crc32s anything over 20 — `DocumentService::generateRevisionId`) **and** the blob store
  dedups, so two versions with identical content would collide on one revision id.
- **The live file is the LAST entry**, `version = count + 1`, `created` = the live file's mtime in seconds
  (`EditorController.php:930-940`). Omitting it is the single most likely way to ship a panel that looks right and
  behaves wrongly.
- **`user` omitted when `author` is absent** (see the correction at the top of this file).
- **`requireEnabled()`** on every new route, like the seven existing ones — a 404 carrying
  `VERSIONS_DISABLED_MESSAGE`, which is the exact signal `VersionsService.availability` latches on in the frontend.

**T1.3 — `GET versions/editor-version/:version/*`.** `{fileType, url, version, key}` for one ordinal.

- Map the ordinal back to a row id **server-side**. Never accept a row id from the editor; the ordinal is what it has.
- `version > count` means the live file — return the live document URL and the live key
  (`EditorController.php:1023-1027`).
- `url` per §3 above: the `@OnlyOfficeEnvironment()` route plus `?token=`.
- **Sign the whole response** with the active editor's secret when one is configured, mirroring
  `genPayloadToken` (`only-office-manager.service.ts:264-266`) — `{...result, iat, exp}` then `token`, HS256
  (`EditorController.php:1065-1072`). The document server validates it through `fillVersionHistoryFromJwt`
  (`DocsCoServer.js:2874`) and **rejects** an unsigned response rather than ignoring the signature. Pick the secret the
  same way the manager does (`:82-85`) so Euro-Office deployments work — or better, reuse that selection rather than
  writing a third copy of it.
- Phase 1 emits **no** `changesUrl` and **no** `previous`. They are only valid as a pair (design §2), and there is
  nothing to pair yet.

**T1.4 — `POST versions/editor-restore/:version/*`.** Maps the ordinal to a row id, calls the existing
`VersioningService.restoreVersion`, and returns the **refreshed history** so `onRequestRestore` can hand it straight to
`refreshHistory` (`editor.js:254-259`).

Do not reimplement restore. `restoreVersion` is where the pinned-descriptor rule (invariant 3), the
`createOrRefresh` lock rule and the document-key invalidation (invariant 7, #378) all live. A bespoke restore silently
drops all three.

### PR 2 — frontend: one upstream hook plus a fork-owned service

Branch `feat/v2-onlyoffice-history-panel`. Two commits: `mod(only-office)` for the component, `feat(custom-v2)` for
the rest.

**T1.5 — the `mod`.** `frontend/src/app/applications/files/components/utils/only-office.component.ts:71` assigns
`config.events` wholesale, and line 70 deep-clones the config through `JSON.parse(JSON.stringify(...))` — **which is
exactly why the handlers cannot arrive inside `config`**: functions do not survive that clone. So the component needs
one optional input, spread into the events object:

```ts
@Input() historyHooks?: OnlyOfficeHistoryHooks   // absent → today's behaviour, byte for byte
// …
config.events = { onDocumentStateChange: …, ...(this.historyHooks ?? {}) }
```

Keep it to that. The four handlers themselves live in `custom-v2`; the upstream file gains a hook and nothing else,
because it is on the merge-conflict surface every upstream sync.

Type the two `docEditor` methods you call (`refreshHistory`, `setHistoryData`) in a **fork-owned** type — upstream's
`only-office.interface.ts` declares the four events as `(event: object) => void` and declares neither method, and
extending that file is a second mod for no gain.

**T1.6 — the service and the wiring.** A `custom-v2` service mirroring `VersionsService`'s shape (it is the model to
copy: backend route constants imported, path encoded once, `availability` latched one-way). The instance to call
methods on is reachable as `window.DocEditor.instances[<id>]`, the same map the component uses — no extra plumbing.

Wire it from `custom-v2/preview/office-view.component.ts` only. The classic viewer
(`files/components/viewers/files-viewer-only-office.component.ts`) uses the same component, so leaving its
`historyHooks` unset keeps classic behaviour unchanged — a deliberate scope line, not an oversight. Say so in the PR.

Gate on **both** the feature flag (`versions.availability() === 'available'`) and `mode !== VIEW`. A read-only session
that offers Restore is worse than no panel.

**T1.7 — verify in the browser, and settle one thing by observation rather than by reading.** Our config sets
`document.permissions.changeHistory: false` (`only-office-manager.service.ts:220`), which upstream's own interface
marks *deprecated since 5.5, use `onRequestRestore` instead*. Upstream's `editor.js` sets only the events and never
touches `changeHistory`, so events alone **should** suffice. Check the panel and its Restore button against a real
document server; if Restore is missing, flip `changeHistory` to `true` when the mode is EDIT and record what you
observed. Do not flip it pre-emptively "to be safe" — an unnecessary `mod` on an upstream file is a real cost here.

Also confirm: `onRequestHistoryClose` does `location.reload()` upstream (`editor.js:268`). Decide whether a v2 hash
route wants that or a lighter re-mount, and write down why.

**T1.8 — e2e (optional for the first PR, not optional before the flag defaults on).** Add cases to
`custom-versioning/versions-editors.e2e-spec.ts`. Read `utils/versions-e2e.fixture.ts` first — the `permissions`
column, the `sync-in-csrf` header, the already-prefixed route constants, and the shared `configuration` singleton are
each a 403/404 that reads as a feature bug. And **e2e files run in parallel worker threads against one database**: keep
every assertion scoped to a root the case owns.

---

## 5. Phase 2 — diffs. Gated on phase 1 having shipped.

**T2.1 — extend the callback type.** `OnlyOfficeCallBack` (`only-office.interface.ts`) declares `key`, `status`, `url`,
`notmodified`, `actions`, `forcesavetype`, `users` — and **neither `changesurl` nor `history`**. Adding the two is a
`mod(only-office)`. Verify the field names against the document server's actual callback body rather than trusting this
list; upstream reads them as lowercase `changesurl` and an array `history` (`CallbackController.php:355-361`).

**T2.2 — capture the archive in `saveDocument`.** Download it from `changesurl` and hand it to versioning **in the same
call as the snapshot** (`only-office-manager.service.ts:414`), because the snapshot is what creates the row the archive
belongs to. A failed download must not fail the save — the same durability-vs-availability trade the class comment on
`VersioningService` states.

**T2.3 — store it as a content-addressed sibling.** Same `versionsRoot`, plus a `changesChecksum` column on
`files_versions` so the existing per-`(checksum, versionsRoot)` refcount in `removeBlobIfUnreferenced` governs
deletion. **Generate the migration** — `npm run -w backend db:generate`, never a hand-written SQL file, or
`meta/_journal.json` desynchronises and the migration is silently skipped. Do **not** add a bespoke delete path: the
labeled-version exemption, the refcount and the ADR §7 audit line all live on
`VersionsRetention.purgeRoot` → `dropAll` → `dropVersionForRetention`.

**T2.4 — emit `changesUrl` + `previous` from `editor-version`, as a pair, only when an archive exists** for that
revision (`EditorController.php:1045-1062`). Build `previous` from **the previous ordinal in your own history array**,
never from an mtime comparison. Upstream's self-healing `prev` check (`FileVersions.php:181-192`) exists because their
chain is keyed on mtimes that drift; ours is keyed on row ids that do not.

**T2.5 — the two rules that invert upstream.** Both are in design §4.3 and both are easy to get backwards by copying:

- Upstream skips storing an archive when the save is a forcesave. **Do not copy that.** Here a forcesave mints a
  version, and with `autosave: false, forcesave: true` (`only-office-manager.service.ts:246-247`) forcesave is the
  *normal* save.
- A **coalesced** save creates no row, so its archive has no row to attach to and must be **dropped**. Attaching it to
  the previous row paints a diff against content the archive was never recorded against.

**T2.6 — leave non-editor versions alone.** `webdav`, `sync`, `web`, `web-patch`, `nc-chunked` and `restore` versions
have no archive and never will. `changesUrl`/`previous` are optional; an entry without them renders as the plain
document at that revision. That is also how upstream behaves for versions created outside the editor, so it needs no
special handling — only a test that proves the mixed case renders.

---

## 6. Nine things that will bite you

1. **Document key ≠ revision id.** The first names the live content state and lives in a cache; the second names a past
   revision and lives in a history entry. Design §0.
2. **Milliseconds vs seconds.** Rows are ms; the editor wants seconds. The same trap the NC surface documents for
   `d:getlastmodified`.
3. **Ordinal vs row id.** The editor only ever speaks ordinals. Every endpoint maps them server-side; accepting a row
   id from the editor is an authorization hole waiting to happen.
4. **The live file is a history entry**, and it is the last one.
5. **The version response must be JWT-signed.** Unsigned is rejected, not ignored — so the failure looks like "the
   panel opens and then nothing renders."
6. **Descending list order.** `listVersions` is newest-first.
7. **Dedup breaks checksum-as-key.** Two versions with identical bytes share a blob.
8. **Coalescing makes the panel look lossy.** At the default 300 s window several real saves are one version. That is
   intended (ADR §5.1) and not yours to change — but expect to be asked, and answer with §6.9 rather than an opinion.
9. **`forcesavetype` is already on the wire**, and it is the discriminator nobody has used yet:
   `forcesavetype: 1` means *"each time the saving is done (e.g. the Save button is clicked)"*, `2` means *by timer*
   (`only-office.interface.ts`, `OnlyOfficeCallBack`). So the data needed to tell a human Save from an automatic one —
   which is precisely what the deferred window decision (design §5.3, findings D4.3) turns on — is available at the
   snapshot site today, without new plumbing. If that decision comes back to life, this is where to start; do not
   change the window as a side effect of this feature.

---

## 7. Definition of done

**Phase 1:**

- `npm -w backend run test` green, `npm run build -w backend` clean (vitest's type check misses service↔real-class
  errors that `nest build` catches), `npm run lint -w backend` clean, `npm -w frontend run test` green.
- Browser-verified against a **real** document server: panel lists versions oldest-first with the live file last,
  selecting an entry renders that revision, Restore replaces the live file and the reopened editor shows the restored
  content — that last one is the assertion #378 makes possible, and it is the one that would have failed before it.
- The classic viewer is provably unchanged (no `historyHooks` supplied).
- Panel absent when `files.versions.enabled` is false, and in a VIEW-mode session.

**Phase 2:** all of the above, plus a diff rendering for a version pair that has an archive, a plain render for one
that does not, and an e2e case proving a coalesced save's archive is dropped rather than misattached.

## 8. What not to do

- Do not put the document-key invalidation into the shared snapshot hook to "cover all write paths". It also runs on
  the editors' own saves; dropping the key mid-session splits the co-editing session and leaves
  `NcOnlyOfficeForceSaveService` with no key to force-save. `CLAUDE.md` invariant 7 states this.
- Do not change the coalescing window. Deferred to the soak (#348).
- Do not add a second auth model to `VersioningController`. New route, `@OnlyOfficeEnvironment()`, per §3.
- Do not expect any of this to reach the ONLYOFFICE **mobile** apps. They connect as WebDAV storages and never load an
  editor config, so no panel of ours can appear there; mobile history is the NC versions DAV tree, which already works.
- Do not start phase 2 before phase 1 ships.

---

## 9. What the browser verification settled (2026-07-29)

Phase 1 built and verified against `onlyoffice/documentserver` on an isolated rig (own port, own database, own
`dataPath`, own `agent-browser --session`). Four things came out of it that this document had left open or got wrong.

**1. `changeHistory` must NOT be flipped, and §T1.7's fallback is dead code.** The question was "if Restore is missing,
flip `document.permissions.changeHistory` to `true`". It is missing nothing, and the flag is vestigial: the shipped
document server derives the affordance from the EVENTS alone —

```
_config.editorConfig.canUseHistory  = _config.events && !!_config.events.onRequestHistory
_config.editorConfig.canHistoryClose = _config.events && !!_config.events.onRequestHistoryClose
```

(`/var/www/onlyoffice/documentserver/web-apps/apps/api/documents/api.js`, 9.3) — and the string `changeHistory` appears
**nowhere in the whole `web-apps` tree**. So there is nothing to gate on it, which matches upstream marking it
`@deprecated since 5.5, use onRequestRestore` and never setting it in their own connector. **No `mod` was needed.**

**2. `onRequestHistoryClose` is inert here, and the re-mount moved to the restore.** Upstream does
`location.reload(true)`, which in v2 would discard the whole SPA. The reason upstream needs it is a stale document key
after a restore — so that is handled at the moment of the restore instead (`onRestored` → re-fetch `/settings` →
re-mount). This is NOT optional: verified live, a restore leaves the page holding the OLD document key
(`1b98-19facad5c8e`), and the re-mount is what re-opens the editor under the new one (`1b96-19facae44d5`). Without it the
editor keeps editing pre-restore content and the next save writes it back over the restore — invariant 7 from the other
end.

**3. The document server really can fetch a version's bytes.** `docker exec … curl <the url from editor-version>` →
`200, 6994 bytes, application/vnd.openxmlformats-officedocument.wordprocessingml.document`; the same url with the
`token` stripped → `401`. That pair is the auth model of §3 confirmed rather than reasoned about.

**4. A rig note that cost time twice.** The soak's LAN-IP rule (`2026-07-29-adr-19-editor-soak.md` §2.2) is right and the
IP is **not stable across sessions** — this run's machine had moved networks since the soak, so the documented
`192.168.1.177` silently produced a document server the browser could reach and the backend could not. Re-derive it
(`ipconfig getifaddr en0`) and verify all three legs before touching the UI. Also: `agent-browser` shares one session by
default, and this run spent a while driving a **sibling agent's** dev server on `:8081` believing it was its own. Pass
`--session <name>`.

Verified, each against the real document server: history oldest-first with the live file last and `currentVersion` = the
live ordinal; `created` rendered as a locale string; revision ids `2_3` / `2_4` with the live entry keyed by the document
key and carrying no `user`; the version response JWT-signed and its claims equal to its body; restore by ordinal
replacing the live bytes, snapshotting the replaced state as origin `restore`, and refreshing the panel; and the panel
ABSENT on a fresh load while `files.versions.enabled` is false (the `usage` probe 404s, `availability` latches
`unavailable`, and the editor mounts with `onDocumentStateChange` alone).
