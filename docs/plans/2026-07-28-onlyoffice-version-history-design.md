# Design — version history inside the OnlyOffice / Euro-Office editor

- **Status:** **Phase 1 approved, built and browser-verified** (#386 backend, #387 frontend, 2026-07-29). Phase 2 is
  still a decision the maintainer has not taken. Where this document and the handoff's §9 disagree, §9 is what was
  measured — in particular §1's claim that `changeHistory` is one of three things that must change is **wrong**: the flag
  is vestigial in document server 9.x and was left alone.
- **Date:** 2026-07-28
- **Task list:** [`2026-07-28-onlyoffice-version-history-handoff.md`](2026-07-28-onlyoffice-version-history-handoff.md)
  — the executable version of this document, plus the auth plumbing §3 here leaves open and one correction to §3's
  mapping table (`authorId` is not exposed by `listVersions`; use `author.login`).
- **Question it answers:** can the OnlyOffice / Euro-Office web editor show a document's versions, and the diffs
  between them?
- **Answer today:** **no, neither** — see §1. It is achievable, and ONLYOFFICE's own Nextcloud connector is a complete
  blueprint for how (§2). The diff half is considerably more expensive than the history half (§4 vs §3).
- **Depends on:** `custom-versioning` (`files.versions.enabled`), and on #378 having landed — a restore must drop the
  cached document key, or the editor shows pre-restore content whatever this doc proposes.
- **Applies equally to Euro-Office.** It is an OnlyOffice-protocol document server, not a second protocol:
  `OnlyOfficeManager` selects between the two configs at construction (`only-office-manager.service.ts:82-85`) and
  everything downstream is identical. Nothing in this design is OnlyOffice-specific.

All `file:line` citations were verified against `main` at `26ace79f` on 2026-07-28. Upstream ONLYOFFICE citations are
against `ONLYOFFICE/onlyoffice-nextcloud@master` and `ONLYOFFICE/server@master`.

---

## 0. The four terms this design turns on

Written plainly first, because three of the four are easy to conflate and every one of them is load-bearing.

- **Document key** — the document server's name for *one particular content state* of a file. Two different contents
  must never share a key: the server caches the document under it, and a client arriving with a key the server already
  knows gets the server's copy rather than the file on disk. Sync-in mints it as `size-mtime` in hex
  (`genEtag(null, realPath, false)`) and caches it (`only-office-manager.service.ts:342-353`).
- **Revision id** — the key of a *historical* version, as it appears in a history entry. Same rules as a document key,
  different subject: it names the content of one past revision so the editor can ask the server to render it.
  ONLYOFFICE passes every key through `DocumentService::generateRevisionId`, which **crc32's anything longer than 20
  characters and then truncates to 20**, over the charset `[0-9a-zA-Z.=_-]`. So a revision id is effectively a short
  token, and our 64-character sha512-256 checksums cannot be used raw.
- **Changes archive** (`changes.zip`) — the document server's own record of *what edits happened* during one editing
  session, as an internal change-log the editor can replay to paint additions and deletions. It is **not** derivable
  from two file versions: nothing on our side can compute it, and if it was not captured at save time it does not
  exist. This is the whole reason §4 is expensive and §3 is not.
- **History entry** — one row of the editor's version panel: `{created, key, version, user, changes?}`. `version` is a
  1-based ordinal, not an id; the panel's ordering *is* that number.

---

## 1. What exists today, and why the panel is dark

Three independent facts, all of which must change for anything to appear:

1. ~~**`document.permissions.changeHistory` is hardcoded `false`**~~ — `only-office-manager.service.ts:220`. **This item
   was wrong, and it is the one thing the build did not have to change.** Upstream's interface marks it
   `@deprecated since 5.5, please add the onRequestRestore field instead` (`only-office.interface.ts:36-38`), and the
   shipped document server does not read it *at all*: `changeHistory` appears nowhere in the 9.x `web-apps` tree, which
   derives the affordance from `!!_config.events.onRequestHistory` instead. It is not "the weaker of the two gates" — it
   is not a gate. See the handoff's §9.1.
2. **No history event is wired.** The only event the editor component sets is
   `config.events = { onDocumentStateChange: … }` — `files/components/utils/only-office.component.ts:71`. The four the
   panel needs (`onRequestHistory`, `onRequestHistoryData`, `onRequestRestore`, `onRequestHistoryClose`) appear nowhere
   in the frontend; `only-office.interface.ts:169-177` declares them and nothing supplies them. Without
   `onRequestHistory` the editor has no way to populate a panel, so it does not offer one.
   Note that **v2 reuses that same upstream component** — `office-view.component.ts:10` imports it — so one change
   covers both surfaces, and it is a `mod(only-office)` either way.
3. **No server endpoint answers the three questions the panel asks.** `VersioningController` exposes list / content /
   restore / diff / usage / label / delete, all keyed on a `versionId` and a space URL. None of them speaks the
   editor's history shape.

Versions themselves *are* visible — the v2 versions panel on the file-detail screen — and diffs exist but are
**text-only**: `versioning.controller.ts:189` returns 415 for anything whose mime is not text, which is every office
format. So there is no office-document diff on any surface today, editor or otherwise.

---

## 2. Ground truth — how upstream ONLYOFFICE does it

Read this section before designing anything; the protocol is not guessable, and the fork's rule is that upstream source
is the authority for this surface.

**Three OCS/ajax endpoints**, from `appinfo/routes.php`:

| Route | Controller | Returns |
|---|---|---|
| `GET /ajax/history` | `EditorController::history` | the whole history array, oldest first, live file LAST |
| `GET /ajax/version?version=<n>` | `EditorController::version` | one entry's render inputs: `{fileType, url, version, key}` plus `changesUrl` + `previous` when a changes archive exists |
| `PUT /ajax/restore?version=<n>` | `EditorController::restore` | the refreshed history after restoring |

**Four editor events**, from `src/editor.js:191-194` and `:234-268` — `onRequestHistory` → fetch history →
`docEditor.refreshHistory({currentVersion, history})`; `onRequestHistoryData` → fetch that version →
`docEditor.setHistoryData(response)`; `onRequestRestore` → restore → refresh; `onRequestHistoryClose` →
`location.reload()`.

**Four contracts that are easy to get wrong**, all confirmed in source:

1. **The live file is the last history entry**, with `version = versions.length + 1` and `created = file.getMTime()`
   (`EditorController.php:930-940`). A panel of only past revisions is wrong: the editor uses the last entry as "current".
2. **`created` is unix SECONDS.** `editor.js:735` does `new Date(fileVersion.created * 1000)`. Our `files_versions.mtime`
   is stored in **milliseconds** — the same divide-by-1000 trap the NC mobile surface already documents.
3. **The `version` response must be JWT-signed** with the document-server secret when one is configured
   (`EditorController.php:1065-1072`), and the server validates it through `fillVersionHistoryFromJwt`
   (`DocsCoServer.js:2874`). An unsigned response is rejected, not ignored.
4. **`changesUrl` is only emitted alongside a `previous` `{fileType, key, url}`**, and only when
   `FileVersions::hasChanges` finds an archive for that revision (`EditorController.php:1045-1062`). The pair is the
   diff: the editor renders `previous`, then replays the archive over it.

**How the archive is captured.** On a save callback, the document server posts `changesurl` and `history` alongside
`url`. `CallbackController.php:554-562` downloads the archive and calls `FileVersions::saveHistory($fileInfo, $history,
$changes, $prevVersion)` where **`$prevVersion` is the file's mtime read BEFORE the write**
(`CallbackController.php:493`) — i.e. the archive is filed under the identity of the revision the write created. It
stores `<versionId>.zip` + `<versionId>.json` in a per-file folder, and `getHistoryData` **deletes both** if the stored
`prev` no longer matches the caller's expectation (`FileVersions.php:181-192`) — a self-healing chain, because a
mismatched chain would paint the wrong diff.

**One deliberate omission**: they skip `saveHistory` when the save is a forcesave, or when the previous save was
(`CallbackController.php:551`), because a forcesave overwrites the same NC version instead of creating a new one. **That
reasoning does not carry to us** — see §4.3.

---

## 3. Phase 1 — history and restore, no diffs

The cheap half. Everything the editor needs is already in `files_versions` except a revision id.

**Mapping.** For each row of `VersioningService.listVersions`, **reversed** — `listByFileId` orders
`desc(createdAt), desc(id)` (`versioning-queries.service.ts:55`), newest first, which is the opposite of what the panel
wants — then the live file appended last:

| Editor field | Source |
|---|---|
| `created` | `Math.floor(row.mtime / 1000)` — rows are ms, the editor wants seconds |
| `key` | `` `${row.fileId}_${row.id}` `` — see below |
| `version` | 1-based ordinal of the row in the ascending list |
| `user` | `{id: String(row.authorId), name: <fullName>}`, omitted when `authorId` is null (a system write or a deleted account — the same case `nc-version-xml.ts:63` already handles) |
| `changes` | omitted in phase 1 |

**Why `${fileId}_${id}` for the key.** It is unique, stable, inside the `[0-9a-zA-Z.=_-]` charset, and short enough to
survive `generateRevisionId`'s 20-character truncation without being crc32'd into a collision risk. The tempting
alternative — the content `checksum` — is wrong twice over: it is 64 characters, so upstream would hash it anyway, and
the blob store **dedups**, so two versions with identical content would share a revision id and the panel would show two
rows the server treats as one document.

**Endpoints.** Add to `VersioningController` (not a new controller: these are per-file routes and want the same
`SpaceGuard` resolution every other versioning route has):

- `GET  versions/editor-history/*` → the array above.
- `GET  versions/editor-version/:version/*` → `{fileType, url, version, key}` for that ordinal, JWT-signed with the
  active editor's secret. `url` must be a token-authenticated URL the **document server** can fetch, i.e. built the way
  `only-office-manager.service.ts:258-262` builds `fileUrl` — a browser-session cookie is useless here, the fetch is
  server-to-server.
- Restore reuses the existing `POST versions/restore/:versionId/*`; the editor's ordinal has to be mapped back to a row
  id first, and the response then returns the refreshed history so `onRequestRestore` can call `refreshHistory`.

**Frontend.** One `mod(only-office)` on `only-office.component.ts`: an optional `history` input that, when supplied,
attaches the four events. Absent, behaviour is byte-identical to today. The four handlers themselves belong in a
fork-owned service under `custom-v2`, so the upstream file gains a hook and nothing else.

**Two things worth stating plainly before this is built:**

- **The panel will not show every save.** The coalescing window for origin `onlyoffice` is 300 s
  (`files.config.ts:120`), so several saves inside five minutes are one version. That is intended behaviour (ADR §5.1),
  but in the editor's own panel it will read as missing history, and the decision is still open pending the ADR §19
  soak. Whatever number that soak settles on, this panel is where users will notice it.
- **The mobile apps do not benefit.** ONLYOFFICE's Documents apps connect to a Nextcloud account as a WebDAV storage and
  edit in their own embedded editor — they never load a document-server editor config, so no panel of ours can appear
  there. Mobile version history stays the NC versions DAV tree (`/remote.php/dav/versions/…`), which already works.

---

## 4. Phase 2 — diffs

### 4.1 What has to be stored

A second blob kind: the per-version changes archive. It cannot be reconstructed later (§0), so either it is captured on
the save that produced the version or that version has no diff, forever.

`saveDocument` currently discards both fields it would need. The callback interface
(`only-office.interface.ts`) does not even declare `changesurl` or `history`; `grep` for either across the repo returns
nothing. So the capture is: extend the interface, download the archive inside `saveDocument`, and hand it to versioning
**in the same call that takes the snapshot** — the snapshot is what creates the row the archive belongs to, and it
happens at `only-office-manager.service.ts:414`, before `copyFileContent`.

Storage should mirror the blob store rather than invent a second layout: content-address the archive under the same
`versionsRoot`, add a `changesChecksum` column to `files_versions`, and let the existing per-`(checksum, versionsRoot)`
refcount in `removeBlobIfUnreferenced` govern deletion. **Do not** add a bespoke delete path — the same rule the admin
purge had to follow (`CLAUDE.md`, `VersionsRetention.purgeRoot`): the labeled-version exemption, the refcount and the
ADR §7 audit line all live on that path.

Migrations go through `npm run -w backend db:generate`. Never hand-write the SQL.

### 4.2 What the diff looks like when the archive is absent

Most versions will have no archive: every `webdav`, `sync`, `web`, `nc-chunked` and `restore` write mints a version that
no document server ever saw. That is fine and needs no special handling — `changesUrl` and `previous` are optional, and
an entry without them renders as the plain document at that revision. The panel degrades per-entry, which is exactly how
upstream behaves for versions created outside the editor.

### 4.3 The forcesave difference, which inverts upstream's rule

Upstream skips storing an archive for forcesaves because in Nextcloud a forcesave overwrites the same version. **In this
fork a forcesave mints a version like any other save** — `callBack`'s status-6 arm reaches `saveDocument`
(`only-office-manager.service.ts:173-176`), which snapshots. And `customization.forcesave` is `true` with `autosave`
`false` (`:246-247`), so forcesave is the *normal* save here, not an exception. So we store the archive on every save
that mints a version, and upstream's `!$isForcesave && !$prevIsForcesave` condition must **not** be copied.

The consequence to get right: the `previous` chain must be built from **our rows**, in our ordering, not from an mtime
comparison. Upstream's self-healing `prev` check (`FileVersions.php:181`) exists because their chain is keyed on mtimes
that can drift; ours is keyed on row ids that cannot, so the equivalent guard is simply "the previous ordinal in the same
history array". Coalescing makes this concrete: when a save is coalesced no row is created, so its archive has no row to
attach to and must be **dropped**, not attached to the previous row — attaching it would paint a diff whose base is not
the content the archive was recorded against.

### 4.4 Cost

Archives are small relative to office documents, but they are per-save and they consume the same quota share as version
blobs (`quotaShare`, default 0.5). Worth measuring in the ADR §19 soak rather than estimating here.

---

## 5. What needs a decision before any of this is built

1. **Is phase 1 alone worth shipping?** It gives the editor a version panel and in-editor restore, with no diffs. It is
   the majority of the user-visible value for a fraction of phase 2's cost, and it touches no schema.
2. **Does phase 2 justify a schema change and a second blob kind** for diff highlighting on office documents — the one
   capability no other surface in the fork can offer?
3. **The 300 s window** (§3) becomes visible to users in this panel. Currently deferred to the ADR §19 soak.

Phase 2 must not be started before phase 1 ships: the archive is useless without a panel to show it in, and the panel is
where the ordinal/row-id mapping gets settled.
