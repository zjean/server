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
  const id = typeof fileId === 'number' && Number.isFinite(fileId) ? Math.max(0, Math.floor(fileId)) : 0
  return `${String(id).padStart(20, '0')}${NC_INSTANCE_ID}`
}
