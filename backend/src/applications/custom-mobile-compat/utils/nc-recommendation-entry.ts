import type { FileRecent } from '../../files/schemas/file-recent.interface'
import { ncHasPreview } from './nc-preview-predicate'

// Shape consumed by NC iOS for the "Recommended files" carousel on the Files
// tab. Must mirror what upstream NC's `RecommendedFilesController` produces:
//   { id, timestamp, name, directory, extension, mimeType, hasPreview, reason }
// Field semantics (from upstream):
//   - timestamp: Unix seconds, mtime of the file
//   - directory: parent directory relative to the user's NC home (i.e. what
//     the iOS user sees as their root). Root-level files use "/".
//   - extension: characters after the last "." in `name`, or "" when none.
//     NC convention is the last segment only — `archive.tar.gz` → "gz".
//   - mimeType: standard form like `image/jpeg` (slash-separated).
//   - reason: one of "recent", "favorite", "shared". We only have recents.
export interface NcRecommendationEntry {
  id: number
  timestamp: number
  name: string
  directory: string
  extension: string
  mimeType: string
  hasPreview: boolean
  reason: 'recent'
}

// Translate `homePrefix`-relative recents to NC carousel entries. Returns null
// when the recent's storage path is outside the user's NC home — those files
// aren't reachable through the iOS app and would 404 if tapped.
//
// `homePrefix` is the Sync-in internal path prefix that maps to the NC user's
// root, e.g. "files/personal" for the default personal-space home, or
// "files/<spaceAlias>" / "files/<spaceAlias>/<rootAlias>" for a configured
// `mobileHome` setting. Build it with NcPathResolverService.toInternalPath
// against an empty subpath.
export function toRecommendationEntry(rec: FileRecent, homePrefix: string): NcRecommendationEntry | null {
  const directory = computeDirectory(rec.path, homePrefix)
  if (directory === null) return null
  return {
    id: rec.id,
    timestamp: Math.floor((rec.mtime ?? 0) / 1000),
    name: rec.name,
    directory,
    extension: extractExtension(rec.name),
    mimeType: ncMimeType(rec.mime),
    hasPreview: ncHasPreview(rec.mime),
    reason: 'recent'
  }
}

// `path` in `files_recents` stores the parent directory in Sync-in URL form
// (e.g. "files/personal/Documents/Q1"). Strip the home prefix to produce the
// NC-relative directory. Return null when the recent is outside the home.
function computeDirectory(path: string, homePrefix: string): string | null {
  if (path === homePrefix) return '/'
  if (path.startsWith(homePrefix + '/')) return '/' + path.slice(homePrefix.length + 1)
  return null
}

function extractExtension(name: string): string {
  // Treat dotfiles ("name == .foo") as no-extension to match NC's convention:
  // a leading dot is part of the name, not a separator.
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0) return ''
  return name.slice(lastDot + 1)
}

// Sync-in stores mimes with the first `/` replaced by `-` (e.g. `image-jpeg`,
// `application-vnd.openxmlformats-officedocument.wordprocessingml.document`).
// NC clients expect the standard slash form; translate by replacing the first
// `-` with `/`. Pass through anything that already contains a `/`.
function ncMimeType(mime: string | null | undefined): string {
  if (!mime) return 'application/octet-stream'
  if (mime.includes('/')) return mime
  const dash = mime.indexOf('-')
  if (dash < 0) return mime
  return mime.slice(0, dash) + '/' + mime.slice(dash + 1)
}
