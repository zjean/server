// The id a fork caller passes to FilesQueries.getOrCreateUserFile /
// getOrCreateSpaceFile when it has NO client-supplied file id and wants the
// path-keyed lookup-or-insert branch.
//
// Upstream 2.5.0 (commit 0148bfea, "centralize file id validation and
// resolution") added `assertValidFileId` to both helpers:
//
//   if (!Number.isSafeInteger(fileId) || fileId === 0) throw 400
//
// So 0 — which the fork used to mean "no id, skip the lookup-by-id branch" —
// now THROWS, and `undefined` throws too. A negative value is the value that
// both passes the assertion and still fails the helpers' `fileId > 0` test,
// which is exactly the branch we want.
//
// Negative-as-unmaterialized is upstream's own convention, not an invention
// here: getProps() sets `id: -stats.ino` with the comment "use negative number
// to avoid conflicts with existing database ids", and the classic UI carries
// those negative ids until a write materializes the row.
//
// This mattered a lot: passing 0 made every helper throw, FileRowEnsurer
// swallowed it and returned 0, and versioning then skipped EVERY snapshot with
// no error surfaced — a green build and a green unit suite over a dead feature.
export const NO_CLIENT_FILE_ID = -1
