// Directory name of the blob store, placed as a SIBLING of `files` and `trash`
// under a user's or space's home path — exactly like trash.
//
// Deliberately NOT added to SPACE_REPOSITORY / SPACE_ALIAS: unlike `trash`,
// which is URL-reachable and browsable, the versions store must never be
// addressable through a space URL. Sibling placement is also the ONLY reason
// the content indexer does not walk it — the indexer has no dotfolder or
// name-based exclusion (files-content-indexer.service.ts:321), so a
// `.versions` directory inside the files root would be indexed, PROPFINDed
// and synced down to desktop clients. See ADR §1.
export const VERSIONS_REPOSITORY = 'versions'

// Blob paths are <versions>/<digest[0:2]>/<digest> — 256 shard buckets, so a
// single directory never accumulates every version in a root.
export const VERSIONS_SHARD_LENGTH = 2

// Discriminator prefixes for the `versionsRoot` column. Recording which root a
// blob was written to keeps it resolvable after a cross-space move, when the
// file's current space no longer matches where its blobs live (ADR §15).
export const VERSIONS_ROOT_USER_PREFIX = 'user:'
export const VERSIONS_ROOT_SPACE_PREFIX = 'space:'
