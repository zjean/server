import path from 'node:path'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpaceModel } from '../../spaces/models/space.model'
import { UserModel } from '../../users/models/user.model'
import { isSafePathSegment } from '../../users/utils/login'
import { VERSIONS_REPOSITORY, VERSIONS_ROOT_SPACE_PREFIX, VERSIONS_ROOT_USER_PREFIX, VERSIONS_SHARD_LENGTH } from '../constants/versioning'
import type { VersionsRootKind } from '../interfaces/version.interface'

// Resolves WHICH versions root a given space env maps to, as the discriminator
// stored in `custom_files_versions.versionsRoot` ('user:<login>' or
// 'space:<alias>').
//
// This mirrors realTrashPathFromSpace (spaces/utils/paths.ts:76-101)
// BRANCH FOR BRANCH — same four cases in the same order, same fallbacks. Trash
// is the proven precedent for "where does out-of-tree data for this space env
// belong", so any divergence here would be a bug, not a simplification. If
// upstream changes that function, this one must be re-checked (see the ADR's
// upstream-sync watch list).
//
// Returning the discriminator rather than a path is deliberate: the caller
// needs it for the DB row anyway, and blob resolution must go through the
// RECORDED root so a cross-space-moved file keeps resolving to the root that
// physically holds its blobs (ADR §15).
//
// Returns null when no root can be resolved — the caller then skips
// versioning rather than guessing.
export function versionsRootFromSpace(user: UserModel, space: SpaceEnv): string | null {
  if (space.inPersonalSpace) {
    // personal user space
    return userVersionsRoot(user.login)
  } else if (space.root?.externalPath) {
    // external path from space or share
    // space case: use the space versions root
    if (space.root.file?.space?.alias) {
      return spaceVersionsRoot(space.root.file.space.alias)
    } else if (space.inFilesRepository && !space.inSharesRepository) {
      return spaceVersionsRoot(space.alias)
    }
    // share case: use the user's root because this type of share has no owner
    return userVersionsRoot(user.login)
  } else if (space.root?.file?.path && space.root.owner?.login) {
    // space root is linked to a file in a personal space
    return userVersionsRoot(space.root.owner.login)
  } else if (space.root?.file?.space?.id) {
    // share linked to a space (with an external path or not).
    // `id` can be set while `alias` is not; upstream's mirrored trash function
    // would throw on path.join(undefined) here, whereas returning a root of
    // 'space:undefined' would quietly write blobs to <spacesPath>/undefined.
    // Honour this function's contract instead: null means "skip versioning".
    if (!space.root.file.space.alias) return null
    return spaceVersionsRoot(space.root.file.space.alias)
  } else if (space.alias) {
    // space files (no root)
    return spaceVersionsRoot(space.alias)
  }
  return null
}

export function userVersionsRoot(login: string): string {
  return `${VERSIONS_ROOT_USER_PREFIX}${login}`
}

export function spaceVersionsRoot(alias: string): string {
  return `${VERSIONS_ROOT_SPACE_PREFIX}${alias}`
}

// Maps a recorded `versionsRoot` back to its directory on disk.
//
// Note the user branch calls UserModel.getHomePath(login) WITHOUT the
// guest/link flags, exactly as UserModel.getTrashPath does (user.model.ts:154).
// That resolves into `usersPath`, whereas a guest's or link's live files sit
// under `tmpPath/{guests,links}/<login>`. Rather than let versions land outside
// the ephemeral tree holding the files they describe, the service skips guest
// and link users entirely (ADR §8) — so this asymmetry is unreachable, and is
// documented here so nobody "fixes" it by passing the flags through.
//
// Returns null — never throws — for an unrecognized discriminator or an unsafe
// login/alias. Every caller is written for null (skip versioning, or 404 the
// version); letting UserModel.getHomePath's "login must be a single path
// segment" error escape instead turned a bad row into a raw 500 on the download
// and restore endpoints.
//
// The alias is validated here explicitly because SpaceModel.getHomePath, unlike
// UserModel.getHomePath, does no checking of its own. The real defence is
// sanitizeName on the space DTO, but that is three layers away, and this
// function turns a database value into a filesystem path — the last place that
// should be trusting it.
export function versionsPathFromRoot(versionsRoot: string): string | null {
  const parsed = parseVersionsRoot(versionsRoot)
  if (!parsed) return null
  try {
    const homePath = parsed.kind === 'user' ? UserModel.getHomePath(parsed.name) : SpaceModel.getHomePath(parsed.name)
    return path.join(homePath, VERSIONS_REPOSITORY)
  } catch {
    return null
  }
}

// Splits a recorded root back into (kind, name), or null for anything that is
// not one of the two valid discriminators or whose name is not a single safe
// path segment.
//
// This is the ONE place the prefix rule is decoded. versionsPathFromRoot builds
// a filesystem path from it and the admin API accepts one from an operator, so a
// second copy of "starts with user: / space:" would be a second copy of the
// validation — and the weaker copy would be the one that mattered. Callers get
// null and decide (skip versioning, 404 the version, 400 the request); nothing
// here throws.
export function parseVersionsRoot(versionsRoot: string): { kind: VersionsRootKind; name: string } | null {
  for (const [prefix, kind] of [
    [VERSIONS_ROOT_USER_PREFIX, 'user'],
    [VERSIONS_ROOT_SPACE_PREFIX, 'space']
  ] as [string, VersionsRootKind][]) {
    if (!versionsRoot.startsWith(prefix)) continue
    const name = versionsRoot.slice(prefix.length)
    return isSafePathSegment(name) ? { kind, name } : null
  }
  return null
}

// <versions>/<digest[0:2]>/<digest>. Rejects anything that is not a plain hex
// digest: the checksum reaches this function from a DB row, and a value
// containing path separators or '..' would otherwise escape the store.
export function blobPathFromRoot(versionsRoot: string, checksum: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(checksum)) return null
  const basePath = versionsPathFromRoot(versionsRoot)
  if (!basePath) return null
  return path.join(basePath, checksum.slice(0, VERSIONS_SHARD_LENGTH), checksum)
}
