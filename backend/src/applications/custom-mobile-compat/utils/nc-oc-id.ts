// <oc:id> is a 20-character, server-globally-unique identifier. Nextcloud
// builds it as `sprintf("%020d%s", fileid, instanceid)` — zero-padded 20
// digits (wider than the actual numeric id) followed by a short instance
// tag. Mobile clients use the full string as a primary key for offline
// database rows, so it must be stable across requests.
//
// Sync-in doesn't issue an instanceid, so we hardcode a short literal — any
// value works as long as it's constant for this deployment.

const NC_INSTANCE_ID = 'syncin'

export function buildOcId(fileId: number | null | undefined): string {
  return `${String(ncFileId(fileId)).padStart(20, '0')}${NC_INSTANCE_ID}`
}

// Stable positive numeric file id for the NC client cache.
//
// Sync-in tags filesystem-only files (those without a DB row yet — e.g. one
// just uploaded that hasn't been reconciled into the files table) with
// `id = -stat.ino`. NC iOS uses oc:fileid / oc:id as its offline-cache
// primary key and refuses to render rows where that key is 0 or negative
// (multiple zero-keyed rows collapse, hiding the freshly-uploaded file).
//
// Map negatives to their absolute value so the inode-derived id remains
// stable AND positive across requests; null/undefined/non-finite inputs
// fall back to 0.
export function ncFileId(fileId: number | null | undefined): number {
  return typeof fileId === 'number' && Number.isFinite(fileId) ? Math.abs(Math.trunc(fileId)) : 0
}
