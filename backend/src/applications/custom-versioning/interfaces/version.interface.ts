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
  // An ALREADY-PROVEN `files.id` for the file being snapshotted, letting the
  // service skip a resolution it would otherwise repeat. Set it only when the
  // caller has resolved the id for this same space env — restoreVersion does,
  // via the version row its guard just validated (#349). Omitted everywhere
  // else: `files` rows are lazily materialized, so the service must run the
  // ensurer, and a guessed or stale id would anchor history on the wrong file.
  fileId?: number
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
