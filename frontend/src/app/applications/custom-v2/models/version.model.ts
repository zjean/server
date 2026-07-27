import { VERSIONS_MAX_DIFF_BYTES, VERSIONS_TEXTUAL_MIMES } from '@sync-in-server/backend/src/applications/custom-versioning/constants/versioning'
import type {
  VersionOrigin,
  VersionProps,
  VersionsUsage
} from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/version.interface'

export type { VersionOrigin, VersionsUsage }

// The JSON wire shape of the backend's `VersionProps`.
//
// It is NOT `VersionProps` itself: the backend types `createdAt` as `Date`, but
// nothing on the wire is a Date — Fastify serializes it to an ISO-8601 string.
// Typing a response as `VersionProps` therefore type-checks while
// `v.createdAt.getTime()` throws at runtime. The conversion happens once, in
// `toVersionModel`, so no component ever sees the string form.
export type VersionApiProps = Omit<VersionProps, 'createdAt'> & { createdAt: string }

// `GET versions/diff/:id/<path>` — a unified diff plus a fast path for "these
// two revisions are byte-identical", which happens whenever a save produced no
// textual change.
export interface VersionDiff {
  diff: string
  identical: boolean
}

// What a version is diffed against: the live file (the default), or another
// version of the same file by id. Mirrors the backend's `VersionDiffDto.against`,
// which accepts the literal `current` or a numeric id as a string.
export type DiffTarget = 'current' | number

// Absent when the snapshot had no acting user, or when the author's account has
// since been deleted (`authorId` is ON DELETE SET NULL) — so a missing author
// is a normal state to render, not an error.
export interface VersionAuthor {
  login: string
  name: string
}

export interface VersionModel {
  readonly id: number
  readonly fileId: number
  // Logical size of the snapshotted content in bytes. It may over-count shared
  // storage: identical content across versions is stored once (the blob store
  // is content-addressed), while every row still reports the full size. This is
  // the same number the quota cap is computed from, so showing it keeps the UI
  // consistent with what the backend enforces.
  readonly size: number
  // Two timestamps, and they mean different things:
  //
  //   mtime     — when THIS revision's bytes were last written. Unix ms.
  //   createdAt — when the revision was superseded, i.e. when the overwrite
  //               that pushed it into history happened.
  //
  // They can be months apart (a document edited in May and overwritten in July),
  // so a history list must be explicit about which one it labels a row with.
  readonly mtime: number
  readonly createdAt: Date
  readonly origin: VersionOrigin
  // i18n key describing the write path that produced the snapshot.
  readonly originLabel: string
  readonly label: string | null
  // A named revision is exempt from every automatic pruning rule (retention
  // days, max-per-file, the quota cap), and deleting one needs an explicit
  // confirmation the API refuses to infer.
  readonly isLabeled: boolean
  readonly checksum: string
  readonly author: VersionAuthor | null
}

// One entry per `origin` enum value. Several origins deliberately share a
// label: the split between a web PUT and a resumed web PATCH matters to the
// backend (they are separate destructive paths) and not at all to a reader.
//
// `Record<VersionOrigin, string>` is the point of this table — it is exhaustive,
// so adding an origin to the backend enum breaks the build here instead of
// silently rendering a blank column.
const ORIGIN_LABELS: Record<VersionOrigin, string> = {
  web: 'Web',
  'web-patch': 'Web',
  webdav: 'WebDAV',
  sync: 'Desktop sync',
  'sync-make': 'Desktop sync',
  'nc-chunked': 'Mobile app',
  'nc-text': 'Mobile editor',
  collabora: 'Collabora',
  onlyoffice: 'OnlyOffice',
  restore: 'Restore'
}

export function toVersionModel(props: VersionApiProps): VersionModel {
  return {
    id: props.id,
    fileId: props.fileId,
    size: props.size,
    mtime: props.mtime,
    createdAt: new Date(props.createdAt),
    origin: props.origin,
    originLabel: ORIGIN_LABELS[props.origin] ?? props.origin,
    label: props.label,
    isLabeled: !!props.label,
    checksum: props.checksum,
    author: props.author ? { login: props.author.login, name: props.author.fullName || props.author.login } : null
  }
}

// The API already returns newest-first (`ORDER BY createdAt DESC, id DESC`), so
// this preserves order rather than imposing one.
export function toVersionModels(list: VersionApiProps[]): VersionModel[] {
  return list.map(toVersionModel)
}

// Fraction of the versions quota ceiling in use, clamped to [0, 1], or null when
// there is no ceiling (`ceiling` is null for a space with no quota, or when the
// `quotaShare` cap is disabled) — in which case a progress bar has nothing to
// fill and the UI should show the byte count alone.
//
// Displaying this is a release requirement, not decoration: turning versioning
// on reduces every user's effective quota by up to `quotaShare`, and this is the
// only place that becomes visible (ADR §7).
export function versionsUsageRatio(usage: VersionsUsage | null): number | null {
  if (!usage || !usage.ceiling) return null
  return Math.min(1, Math.max(0, usage.used / usage.ceiling))
}

/**
 * Whether offering a text comparison for this file is worth doing.
 *
 * Both facts come from the backend's own constants, so the button appears
 * exactly when the endpoint would answer: it 415s a non-text mime and 413s
 * anything over the per-side cap. This only decides whether to OFFER the
 * action — the endpoint stays the authority, and the panel still renders the
 * 415/413 outcomes as ordinary states rather than errors, because a size can
 * change between the check and the click.
 *
 * `mime` is the stored form, with the first `/` replaced by `-` (`text-plain`),
 * which is what `FileProps.mime` carries.
 */
export function isDiffableFile(mime: string | null | undefined, size: number): boolean {
  if (!mime || size > VERSIONS_MAX_DIFF_BYTES) return false
  return mime.startsWith('text') || VERSIONS_TEXTUAL_MIMES.has(mime)
}
