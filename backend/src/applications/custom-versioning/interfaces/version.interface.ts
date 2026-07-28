import type { customFilesVersions } from '../schemas/files-versions.schema'

// One value per destructive write entry point (ADR §4). `web-patch` and
// `sync-make` exist because saveMultipart's PATCH branch and
// mkFile(overwrite=true) are separate destructive paths that a
// saveStream-centric design misses.
export type VersionOrigin = (typeof customFilesVersions.origin)['enumValues'][number]

export type VersionRow = typeof customFilesVersions.$inferSelect
export type VersionInsert = typeof customFilesVersions.$inferInsert

// What a snapshot needs from its caller. `origin` is the only required field —
// everything else is derived from `user` + `space` inside the service so hook
// sites stay one-liners.
export interface SnapshotOptions {
  origin: VersionOrigin
}

// API shape. `size` is the logical size of the snapshotted content; `mtime` is
// the mtime OF THE SUPERSEDED CONTENT in unix milliseconds.
export interface VersionProps {
  id: number
  fileId: number
  size: number
  mtime: number
  createdAt: Date
  origin: VersionOrigin
  label: string | null
  checksum: string
  // Absent for system-originated snapshots, or when the author account is gone
  // (authorId is ON DELETE SET NULL).
  author?: { login: string; fullName: string }
}

// Backs the versions-usage display, which ADR §7 makes a release blocker:
// enabling versioning silently reduces effective quota by up to `quotaShare`,
// so that consumption has to be visible rather than mysterious.
export interface VersionsUsage {
  // Sum of logical version sizes in this space's versions root. Over-counts
  // when dedup hits, which makes the cap conservative.
  used: number
  // quota * quotaShare, or null when the space has no quota (unlimited) or the
  // cap is disabled.
  ceiling: number | null
  count: number
}

/* --------------------------------------------------------- admin surface */

// A versions root is either a user's home or a space's (ADR §1). Nothing else
// is a valid discriminator, which is why parseVersionsRoot returns null rather
// than a third kind.
export type VersionsRootKind = 'user' | 'space'

// One row of the operator's "who is consuming version storage" table.
//
// EVERY FIGURE HERE IS LOGICAL, not on-disk. `used` is SUM(size) over the
// root's rows, and the blob store is content-addressed per root — two versions
// of unchanged content are one file on disk but two full sizes here. That is
// the same number the quota cap is computed from, so it is the right number to
// show an operator asking "what is charged against this user's quota", and the
// wrong one to compare against `du`.
export interface VersionsRootUsage {
  versionsRoot: string
  kind: VersionsRootKind
  // The login for a user root, the alias for a space root.
  name: string
  used: number
  // How much of `used` is NAMED history. It is the part no automatic rule and
  // no admin purge will remove, so it is what an operator needs to know before
  // expecting a purge to reclaim `used`.
  labeledBytes: number
  count: number
  files: number
  // quota * quotaShare for the OWNER of this root, taken from the same function
  // the nightly backstop enforces (#338: a ceiling derived from a second
  // premise reported a limit nothing would ever apply). `null` means nothing
  // caps this root — no quota on the user/space, or quotaShare disabled.
  ceiling: number | null
}

// Instance-wide version storage, plus the heaviest roots.
export interface VersionsStorageSummary {
  used: number
  labeledBytes: number
  count: number
  // Distinct versions roots and distinct files that hold any history at all.
  roots: number
  files: number
  topRoots: VersionsRootUsage[]
}

export interface VersionsPurgeResult {
  versionsRoot: string
  removed: number
  // Logical bytes of the rows removed — the same over-counting caveat as
  // VersionsRootUsage.used. Reclaimed disk is at most this.
  removedBytes: number
  // Named versions left behind. A purge is unlabeled-only by construction, so
  // this is how an operator learns why a root is not empty afterwards.
  keptLabeled: number
}
