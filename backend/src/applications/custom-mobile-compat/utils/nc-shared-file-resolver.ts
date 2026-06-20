import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'

// Minimal file-row shape the matcher needs. `path` is the full within-tree
// path as produced by filePathSQL ("<dir>/<name>", leading "./" stripped).
export interface ResolverFileRow {
  id: number
  ownerId: number | null
  spaceId: number | null
  path: string
}

// A share-mount root the user has access to: the alias they browse it under
// and the real DB id of the share's root file/folder.
export interface ResolverMount {
  alias: string
  fileId: number
}

// Map a target file id (what NC clients pass to
// /index.php/core/preview?fileId=) to the SHARES url-segments
// (['shares', <alias>, ...relPath]) that SpacesManager.spaceEnv resolves into
// a donor-side realPath.
//
// This is the access boundary for shared-file previews: segments are returned
// ONLY when the target is the share root itself or a descendant of it, in the
// SAME physical storage tree. spaceEnv re-validates the user actually holds
// the share for the returned alias, so a wrong match degrades to a missing
// thumbnail — never to disclosure of a file outside the user's own shares.
export function resolveSharedFileSegments(target: ResolverFileRow, mounts: ResolverMount[], rootById: Map<number, ResolverFileRow>): string[] | null {
  for (const mount of mounts) {
    const root = rootById.get(mount.fileId)
    if (!root) continue
    if (!sameTree(target, root)) continue
    const rel = relativePathUnder(root.path, target.path)
    if (rel === null) continue
    return [SPACE_REPOSITORY.SHARES, mount.alias, ...rel.split('/').filter(Boolean)]
  }
  return null
}

// Two files live in the same physical storage tree when they share a spaceId
// (space files — per-file ownerId may differ) or, for personal files
// (spaceId null), the same ownerId.
function sameTree(a: ResolverFileRow, b: ResolverFileRow): boolean {
  if (a.spaceId != null || b.spaceId != null) return a.spaceId === b.spaceId
  return a.ownerId != null && a.ownerId === b.ownerId
}

// The target's path relative to the root, or null when the target is neither
// the root nor a descendant. Guards against sibling-prefix false positives
// ("Photos" must not match "Photos-private/...").
function relativePathUnder(rootPath: string, targetPath: string): string | null {
  if (rootPath === '') return targetPath
  if (targetPath === rootPath) return ''
  if (targetPath.startsWith(rootPath + '/')) return targetPath.slice(rootPath.length + 1)
  return null
}
