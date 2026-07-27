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

// Where a copy lands before it is hashed and renamed into its shard. It must
// sit inside the versions root so the publish step is a same-filesystem rename
// (atomic); a temp dir on another device would silently become a second copy.
// Leftovers here are crash debris and are safe for the retention GC to remove.
export const VERSIONS_STAGING_DIR = '.staging'

// Discriminator prefixes for the `versionsRoot` column. Recording which root a
// blob was written to keeps it resolvable after a cross-space move, when the
// file's current space no longer matches where its blobs live (ADR §15).
export const VERSIONS_ROOT_USER_PREFIX = 'user:'
export const VERSIONS_ROOT_SPACE_PREFIX = 'space:'

// The message every endpoint 404s with while `files.versions.enabled` is false.
//
// Exported because the v2 UI needs to tell "the feature is off" apart from the
// other 404 these routes can produce: SpaceGuard answers 404 'Space not found'
// for a path the caller cannot reach (space.guard.ts:82). Status alone is
// ambiguous, so the frontend matches on this constant — which it imports from
// here, so the two never drift.
export const VERSIONS_DISABLED_MESSAGE = 'Versioning is not enabled'
