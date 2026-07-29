// The OnlyOffice document server's version-history protocol, as the editor's
// four history events expect it. This is a THIRD PARTY's wire format, not ours:
// every field below is pinned to upstream ONLYOFFICE source, and none of it is
// guessable from our own conventions. Citations are against
// ONLYOFFICE/onlyoffice-nextcloud@master and ONLYOFFICE/server@master.
//
// Two vocabulary items that are easy to conflate and are NOT the same thing
// (design §0):
//   - a DOCUMENT KEY names the live content state and lives in a cache;
//   - a REVISION ID (`key` below) names ONE past revision and lives in a history
//     entry.

// One row of the editor's version panel.
//
// `version` is a 1-based ORDINAL, not a row id — the panel's ordering *is* that
// number, and it is the only version identifier the editor ever sends back to
// us. Everything server-side maps it to a row id; accepting a row id from the
// editor would be an authorization hole.
export interface EditorHistoryEntry {
  // Unix SECONDS. `editor.js:735` does `new Date(fileVersion.created * 1000)`,
  // while our rows hold milliseconds — the same divide-by-1000 trap the NC
  // mobile surface documents for `d:getlastmodified`. Getting it wrong dates
  // every entry to 1970.
  created: number
  key: string
  version: number
  // Omitted when we do not know who wrote the revision — a system-originated
  // snapshot, or an author account since deleted (`authorId` is ON DELETE SET
  // NULL). Upstream instead falls back to the file's OWNER
  // (`EditorController.php:913-920`); we deliberately do not, because naming the
  // owner as the author of a write they may not have made is a false claim, and
  // `user` is optional in the protocol.
  user?: { id: string; name: string }
}

// NOTE there is deliberately no `{currentVersion, history}` type here. The
// history endpoint returns the BARE ARRAY, exactly as upstream's does
// (`EditorController.php:971`), because the wrapper `docEditor.refreshHistory`
// wants is assembled in the BROWSER: `refreshHistory` derives `currentVersion`
// as the maximum ordinal in the array and reformats every `created` into a
// locale string before handing it over (`editor.js:723-752`). A server that
// pre-assembled it would be computing something the client recomputes, and
// sending dates in a shape the client would then try to multiply by 1000.

// What `onRequestHistoryData` hands to `docEditor.setHistoryData`, for ONE
// ordinal.
//
// `changesUrl` and `previous` are phase 2 and are absent here on purpose: they
// are only meaningful as a PAIR (the editor renders `previous`, then replays the
// archive over it — `EditorController.php:1045-1062`), and phase 1 stores no
// changes archive to pair with.
export interface EditorVersionData {
  // Bare extension, no dot — `strtolower(pathinfo(..., PATHINFO_EXTENSION))`
  // (`EditorController.php:1036`).
  fileType: string
  // Fetched by the DOCUMENT SERVER, server-to-server: no cookie, no CSRF header.
  // So it must address a route carrying `@OnlyOfficeEnvironment()` and carry a
  // TOKEN_TYPE.ONLY_OFFICE JWT in its `token` query parameter.
  url: string
  version: number
  key: string
  // Present only when a secret is configured, and then MANDATORY: the document
  // server validates the response through `fillVersionHistoryFromJwt`
  // (`DocsCoServer.js:2874`) and REJECTS an unsigned one rather than ignoring
  // the signature — so the failure mode is "the panel opens and nothing
  // renders", not a warning.
  //
  // `iat`/`exp` are in the body as well as in the token because upstream signs
  // the result object AFTER adding them (`EditorController.php:1065-1071`), so
  // body and token claims are identical.
  iat?: number
  exp?: number
  token?: string
}
