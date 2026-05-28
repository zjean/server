# NC mobile compat — shared-with-me

**Date:** 2026-05-28
**Module:** `backend/src/applications/custom-mobile-compat/`
**Upstream references:** `nextcloud/server@main:apps/files_sharing`, `nextcloud/NextcloudKit@main`, `nextcloud/ios@main`

## Goal

Make Sync-in shares received by a user (`shareRootFiles`) visible to NC stock iOS and Android clients, in both surfaces those clients expose:

1. **File browser** — share-mount roots appear as folders in the user's NC home (`/remote.php/dav/files/{user}/<share-alias>`), with the iOS "shared with me" folder icon and a "shared with you by &lt;owner&gt;" VoiceOver hint. Children inside the mount are browseable and inherit the share's permission set.
2. **Shares tab** — the dedicated NC iOS "Shares" screen (`iOSClient/Shares/NCShares.swift`) lists each incoming share, opening into the same mount on tap.

Out of scope for v1:

- **Outgoing shares.** The Shares tab can also list shares the user *created* (`shared_with_me=false`). We'll keep that mode unimplemented for now (returns empty list). Sync-in's UI for outgoing shares is the v2 web app; iOS-side parity is a follow-up.
- **Recipient-side mount rename.** NC stores `file_target` per recipient so Bob can rename Alice's `/Photos` to `/AlicePhotos` in his home only. Sync-in's `shares` table doesn't model this; the mount name will be `share.name`. Adding rename is a separate piece of state and YAGNI for the first cut.
- **Group-folder semantics (`nc:mount-type=group`).** Sync-in spaces are conceptually closer to NC group folders, but spaces are tracked separately ([[2026-05-28-nc-spaces-design]] — future). This doc covers user-to-user shares only.

## What upstream NC actually does

Grounded by reading the four authoritative repos. Skim-able cross-reference:

| Behavior | Upstream source | Line |
|---|---|---|
| iOS Shares tab fetch | `nextcloud/ios:iOSClient/Shares/NCShares.swift` | `getServerData()` → `readSharesAsync` |
| iOS Shares request shape | `nextcloud/NextcloudKit:Sources/NextcloudKit/NextcloudKit+Share.swift` | `NKShareParameter.endpoint` (`/ocs/v2.php/apps/files_sharing/api/v1/shares`) + `queryParameters` (`shared_with_me`) |
| OCS share JSON shape | `nextcloud/server:apps/files_sharing/lib/Controller/ShareAPIController.php` | `formatShare()` lines 124–209 |
| iOS PROPFIND parser fields | `nextcloud/NextcloudKit:Sources/NextcloudKit/Models/NKDataFileXML.swift` | `nc:mount-type` → line 448, `oc:owner-id` → 428, `oc:share-types` → 418, `oc:permissions` → 402 |
| iOS folder-icon decision | `nextcloud/ios:iOSClient/Main/Collection Common/Cell/NCCellMain.swift` | `cellMainDirectory` lines 82–106 |
| iOS share-badge derivation | `nextcloud/ios:iOSClient/Main/Collection Common/Cell/NCListCell.swift` | line 441: `isShare = perms.contains(S) && !parentPerms.contains(S)` |

### Two-signal model

iOS decides "this folder is shared with me" purely from a PROPFIND signal: the `oc:permissions` letter string contains `S` on the mount-root and does **not** contain `S` on the parent (home root). `nc:mount-type=shared` is informational — it doesn't drive a badge. The OCS Shares-tab list is a separate flat view fed by the OCS endpoint, but each row links back to a fileId that must be PROPFIND-able under the user's home for the row to render anything.

So both surfaces require the DAV side to work first. Build DAV first, Shares-tab second.

## What Sync-in already has

`backend/src/applications/shares/services/shares-queries.service.ts`:

- **`shareRootFiles(user, opts)`** (line 648). Returns one row per incoming share root the user can see (direct user share, group share, or admin-created share). Each row carries:
  - `id` — the underlying file's real DB id (= what we emit as `oc:fileid`)
  - `path` — the file's path inside the donor space
  - `isDir`, `mime`, `size`, `ctime`, `mtime`
  - `root.{id, alias, name, description, permissions, ownerId, ownerLogin, ownerEmail, ownerFullName}` — share-level metadata, with `root.permissions` already intersected through `shareMembers`
  - `origin.{ownerId, ownerLogin, spaceId, spaceAlias, ...}` — where the file lives in the donor's tree

That's exactly the data the DAV virtual-entry and OCS share-record both need. No new query work.

- **`listShares(user)`** (line 487). Outgoing shares — out of scope for v1 (will return empty for `shared_with_me=false`).

## Architecture

Six work items, each landing as its own PR. Order is build-order.

```
                +-----------------------------------+
                |  shares/services/shares-queries   |
                |  .shareRootFiles(user, opts)      |  (existing)
                +-----------------------------------+
                             |
        +--------------------+-----------------------+
        |                                            |
        v                                            v
+---------------------+                +-----------------------------+
|  nc-propfind        |                |  nc-ocs-shares.controller   |
|  injects virtual    |  (new)         |  GET .../shares             |  (new)
|  share-mount rows   |                |  ?shared_with_me=true       |
|  at home root       |                +-----------------------------+
+---------------------+
        |
        v
+---------------------+
|  nc-path-resolver   |  (extended)
|  recognises share-  |
|  alias subpaths     |
+---------------------+
        |
        v
+---------------------+
|  nc-permissions     |  (extended)
|  emits S on mount   |
|  roots              |
+---------------------+
```

### 1. `nc-permissions.ts` — emit `S` for share mounts

Add an optional `isShareMount` flag to `toNcPermissions`:

```ts
export function toNcPermissions(
  syncinPermissions: string | undefined | null,
  isDir: boolean,
  mode: NcPermissionsMode = 'files',
  isShareMount: boolean = false,
): NcPermissionsResult
```

When `isShareMount` is true, prepend `S` to the letter string. The numeric `share-permissions` bitmask is unaffected (NC's `S` letter has no bitmask equivalent — it's a marker, not a capability).

The flag is set only for the **mount-root** PROPFIND response, never for children inside the mount, never for the parent home-root. This matches iOS's `isShare = perms.contains(S) && !parent.perms.contains(S)` rule.

### 2. `nc-path-resolver.service.ts` — resolve share-alias subpaths

Today the resolver maps `/remote.php/dav/files/{user}/<subpath>` to one space (personal by default, or a configured `mobileHome`). Extend it:

```
If subpath's first segment matches a row from shareRootFiles(user).root.alias:
  - donor space = row.origin.spaceAlias
  - donor relative path = row.path + '/' + rest-of-subpath
  - effective permissions = row.root.permissions (overrides the donor space's permissions for this request)
  - share-mount metadata = { rootShareId: row.root.id, owner: row.root.{ownerLogin, ownerFullName} }
```

Add a new `NcResolvedPath.shareMount?: { ... }` field; propfind / propbuilder use its presence to set `isShareMount=true` and emit `oc:owner-id` from the donor.

Edge cases:

- **Alias collision** with a real top-level folder in the user's personal space (e.g. user has a personal folder literally named `photos` and Alice shares a `photos` folder). NC's behaviour is mount wins — the share-mount shadows the personal folder. We'll do the same. The personal folder remains reachable via direct WebDAV (Sync-in's own `/files/personal/photos/` route), just not via the NC client.
- **Two shares with the same alias.** Sync-in's share-creation code enforces alias uniqueness per recipient (the same way upstream NC dedupes mountpoint names with " (2)" suffixes). No change needed.

### 3. `nc-propfind.service.ts` — inject virtual share-mount entries at home root

When the request URL is exactly `/remote.php/dav/files/{user}/` (or `/remote.php/dav/files/{user}` no trailing slash) and Depth ≥ 1, after computing the personal-space response set, append one `<d:response>` per `shareRootFiles(user)` row:

| Property | Value |
|---|---|
| `<d:href>` | `/remote.php/dav/files/{user}/{share.alias}/` |
| `<oc:id>`, `<oc:fileid>` | `row.id` (real DB id of underlying file) |
| `<oc:permissions>` | `toNcPermissions(row.root.permissions, row.isDir, 'files', isShareMount=true).letters` — always includes `S` |
| `<ocs:share-permissions>` | bitmask from same call |
| `<oc:owner-id>` | `row.root.ownerLogin` |
| `<oc:owner-display-name>` | `row.root.ownerFullName` |
| `<nc:mount-type>` | `"shared"` |
| `<d:getlastmodified>` | `row.mtime` (RFC 1123) |
| `<oc:size>` | `row.size` (or omit for folders if expensive — iOS tolerates absence) |
| `<d:resourcetype>` | `<d:collection/>` if `row.isDir`, else empty |
| `<d:getcontenttype>` | translated `row.mime` (`image-jpeg` → `image/jpeg`, see [[feedback_nc_mobile_strong_etag]] neighbours in `utils/mime.ts`) |
| `<d:getetag>` | strong ETag (no `W/` prefix — see [[feedback_nc_mobile_strong_etag]]) |

The home root's *own* `<d:response>` must continue to omit `S` from its permissions — that's how iOS knows the root itself isn't a share, just a container holding share-mounts.

### 4. `nc-ocs-shares.controller.ts` — populate the Shares tab

New controller at `controllers/nc-ocs-shares.controller.ts`. Single route:

```
GET /ocs/v2.php/apps/files_sharing/api/v1/shares
GET /ocs/v1.php/apps/files_sharing/api/v1/shares
```

(NextcloudKit constructs with `v2.php`, but `v1.php` is widely cached by older clients — implement both, same handler.)

Query parameters honoured (per `NKShareParameter.queryParameters`):

- `shared_with_me`: `"true"` | `"false"` (default `"false"`)
- `reshares`: ignored in v1 — Sync-in shares aren't recursively reshareable in the NC sense
- `subfiles`: ignored in v1 — we only ever list mount-roots
- `path`: ignored in v1 — used by NC to fetch shares scoped to one file; not needed for the Shares-tab use case

Response envelope (OCS standard, JSON):

```json
{
  "ocs": {
    "meta": {
      "status": "ok",
      "statuscode": 200,
      "message": "OK"
    },
    "data": [ /* share records */ ]
  }
}
```

Share record (for `shared_with_me=true`), one per `shareRootFiles(user)` row:

| Field | Source | Notes |
|---|---|---|
| `id` | `row.root.id` | Share id (Sync-in's `shares.id`) |
| `share_type` | `0` for direct user, `1` for group, `7` for admin-share (NC's `IShare::TYPE_USER`/`TYPE_GROUP`) | Derive from the `shareMembers` join already implicit in `shareRootFiles` |
| `uid_owner` | `row.root.ownerLogin` | Sharer's login |
| `displayname_owner` | `row.root.ownerFullName` ||
| `uid_file_owner` | same as `uid_owner` | Sync-in doesn't separate "shared by" from "owns"; use the same value |
| `displayname_file_owner` | `row.root.ownerFullName` ||
| `permissions` | bitmask from `toNcPermissions(row.root.permissions, row.isDir).shareMask` ||
| `can_edit`, `can_delete` | derived from same bitmask ||
| `stime` | `mount.ctime` epoch **seconds** (file ctime, not share createdAt) | `shareRootFiles` doesn't expose the share's `createdAt` without an upstream-query mod; file ctime sorts close enough for the iOS Shares tab's only use of stime. Trade-off: if we re-issue a share against the same file, the row's apparent stime will shift to the file's last ctime update rather than the new share time. |
| `path` | `/{row.root.alias}` | Recipient-relative path from home root |
| `file_target` | `/{row.root.alias}` | Same — no per-recipient rename in v1 |
| `item_type` | `"folder"` if `row.isDir` else `"file"` ||
| `item_source`, `file_source` | `row.id` | Underlying file's real DB id — matches `oc:fileid` from PROPFIND |
| `file_parent` | `-1` or omit | Home root has no NC-visible file id; iOS doesn't seem to use this field for shared-with-me rows |
| `mimetype` | translated `row.mime` (`image-jpeg` → `image/jpeg`) ||
| `has_preview` | `"true"` if image (matches our DAV emission, see [[feedback_nc_mobile_has_preview_emit]]) else `"false"` | Word form, not 1/0 |
| `is-mount-root` | `true` ||
| `mount-type` | `"shared"` ||
| `item_size` | `row.size` ||
| `item_mtime` | `row.mtime` epoch **seconds** | Divide by 1000 |
| `storage_id`, `storage` | static `"home::"+login` and `1` | iOS doesn't appear to gate on these for shared-with-me; safe defaults |

`shared_with_me=false` (outgoing shares) returns empty array in v1.

Auth: same Bearer/cookie chain the rest of `custom-mobile-compat` already enforces (via `NcMobileAuthGuard`).

### 5. `nc-sync-log.service.ts` — fan out donor events to recipients

The sync log already supports per-viewer fan-out via `resolveViewers(actorId, spaceAlias, spaceId)`, currently used for shared spaces (one event on a shared space becomes N rows, one per member). Extend `resolveViewers` so it also includes recipients of direct shares whose source file is inside the actor's space or a subtree of it.

This is the trickiest piece. Naive query: "for each share where the source file is `actor.spaceId + actor.path + actor.path-prefix`, add `share.recipientUserId`". Risk: a single file edit inside a deeply shared folder fans out into many recipients × many sync-log rows. Mitigation: cap fan-out, or do the fan-out lazily on REPORT (incremental sync) by joining the sync-log query against the shares table at read time. **Decision: lazy/join-at-read is cleaner and avoids write amplification — defer to PR-5 design notes.**

Without this, the iOS app still shows shared-with-me folders, but won't refresh their contents incrementally until the user does a manual pull-to-refresh, which forces a full PROPFIND. That's acceptable for an MVP — ship items 1–4 first, do 5 as a follow-up.

### 6. OCS capabilities — advertise `files_sharing`

`backend/src/applications/custom-mobile-compat/constants/capabilities.ts` already returns the OCS capabilities payload. Ensure `files_sharing.api_enabled = true` and `files_sharing.public.enabled` reflects reality. iOS gates the Shares tab on `files_sharing.api_enabled`; if it's false or absent, no Shares tab is shown.

Check upstream NC's exact capability shape — there are nested keys for federation, reshare permissions, and remote shares that are best emitted with `false`/`0` rather than omitted, to keep iOS from probing follow-up endpoints we don't implement.

## fileId stability

NC iOS caches fileIds as primary keys; an unstable id for the same logical object will silently break thumbnails and break-link app-handoffs. For shared-with-me rows, the fileId we emit is `row.id` from `shareRootFiles` — i.e. the *underlying file's* real DB id, not the share id. This means:

- Bob sees the same fileId for Alice's `/Photos` whether he browses via the DAV home, via the Shares tab, or via a direct PROPFIND on `/dav/files/bob/Photos/`. iOS de-duplicates correctly.
- If Alice deletes and re-creates `/Photos`, the file id changes, and Bob's iOS cache invalidates that share. Expected.
- If Sync-in renames the share alias (`share.alias` changes), the **DAV path** changes but the **fileId** doesn't. iOS will treat the rename as a delete + add at the new path, which is the same behaviour real NC has for mountpoint renames.

## Build order and PR plan

Each numbered item below is a separate PR targeting `zjean/server` `main` via the `feat/` branch prefix, squash-merged per repo convention.

1. **`feat/nc-permissions-S-flag`** — extend `toNcPermissions` with `isShareMount`. Pure utility change + spec coverage. No behaviour change in the wider system until callers opt in.
2. **`feat/nc-path-resolver-share-alias`** — extend the resolver to recognise share-alias subpaths. Unit-test via the resolver's existing spec; wire into propfind in PR 3.
3. **`feat/nc-propfind-share-mounts`** — inject virtual share-mount entries into home-root PROPFIND. The first PR that's user-visible: load NC iOS, log in as Bob, the shared folder should appear with the badge. Browsing into it should work (resolver from PR 2 handles the deep PROPFIND).
4. **`feat/nc-ocs-shares-endpoint`** — implement the `/shares` OCS endpoint with `shared_with_me=true`. Populates the iOS Shares tab.
5. **`feat/nc-sync-log-share-fanout`** — extend `resolveViewers` to include share recipients. After this, iOS incremental refresh picks up donor-side changes to shared folders. Lazy/join-at-read approach (no write amplification).
6. **`chore/nc-capabilities-files-sharing`** — advertise `files_sharing.api_enabled`. Belongs in PR 4 if not already done.

PRs 1, 2, 6 are small and can stack in any order. PR 3 needs 1+2. PR 4 needs 1 (for permission bitmask). PR 5 is a follow-up; not blocking the MVP.

## Verification

For each PR, the verify path is:

- Unit tests for utility / resolver changes (`*.spec.ts` next to the file).
- Manual smoke against the local dev server with the real iOS / Android NC client pointed at it (Sync-in dev URL is `localhost:8080`; the NC client needs a host the LAN can reach — use `tailscale ip` or `ngrok http 8080`).
  - Set up a second test user (`bob`), have the maintainer share a folder from `sync-in` to `bob`, log into NC iOS as `bob`.
  - PRs 1-3: shared folder appears in home with the "shared with me" icon and "shared with you by sync-in" VoiceOver hint; tapping into it lists the children.
  - PR 4: the Shares tab populates with the same folder.
  - PR 5: edit a file inside the share as `sync-in`, pull-to-refresh-or-better as `bob` — change appears without a full PROPFIND.

No automated end-to-end against a real iOS device — this remains manual verification, same as the rest of `custom-mobile-compat`.

## Open questions (carry forward, not blocking design)

- **Per-share `Accept` quirks** — real NC iOS sometimes sends `Accept: application/json` to OCS endpoints, sometimes XML; our existing OCS controller already content-negotiates. Confirm during PR 4.
- **Group-folder mount-type** for spaces — adjacent design, separate doc. Will share the same `nc-propfind` virtual-entry plumbing.
- **Federation / TYPE_REMOTE shares** — Sync-in doesn't have federated shares. Out of scope forever (or until we do).
