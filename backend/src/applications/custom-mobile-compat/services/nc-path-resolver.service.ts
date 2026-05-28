import { Injectable } from '@nestjs/common'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { UserModel } from '../../users/models/user.model'

// NC path → Sync-in path resolution.
//
// Nextcloud clients see a single home at /remote.php/dav/files/{user}/. We map
// that home to a concrete Sync-in (space, repository, relativePath) tuple.
//
// Today's default: the user's personal space (i.e. `files/personal/...`). A
// per-user setting user.settings?.mobileHome can redirect this elsewhere:
//
//   mobileHome = undefined | 'personal'  → personal space, files repo
//   mobileHome = 'space:<alias>'         → alias's space, files repo
//   mobileHome = 'space:<alias>/<root>'  → alias + explicit root segment
//
// We honor the setting from day-1 so a space-home is a data-only flip — the
// v2 settings UI for it is a follow-up phase (see design doc §decisions C).

export interface NcResolvedPath {
  // Sync-in space repository (files vs trash — mirrors WebDAV's split).
  repository: typeof SPACE_REPOSITORY.FILES | typeof SPACE_REPOSITORY.TRASH
  // Space alias; 'personal' for the user's own home, else a spaces.<alias>.
  spaceAlias: string
  // Explicit root alias within the space; null for single-root spaces.
  rootAlias: string | null
  // Path inside the space, with no leading slash; '' for the space root.
  relativePath: string
}

export interface NcPathInput {
  // 'files' or 'trashbin' — which NC mode the request came from.
  mode: 'files' | 'trashbin'
  // Raw subpath after /remote.php/dav/{mode}/{user}/ — may be empty.
  subpath: string
}

interface UserWithSettings extends Pick<UserModel, 'id' | 'login'> {
  // user.settings is the free-form settings blob; mobileHome is a string or
  // absent. We use a loose index signature here because Sync-in's User model
  // doesn't pre-declare this key — it's a custom-module namespace lookup.
  settings?: Record<string, unknown> | null
}

@Injectable()
export class NcPathResolverService {
  resolve(user: UserWithSettings, input: NcPathInput): NcResolvedPath {
    const subpath = normalize(input.subpath)
    const repository = input.mode === 'trashbin' ? SPACE_REPOSITORY.TRASH : SPACE_REPOSITORY.FILES

    const home = this.readMobileHome(user)

    if (home === null || home === 'personal') {
      return {
        repository,
        spaceAlias: SPACE_ALIAS.PERSONAL,
        rootAlias: null,
        relativePath: subpath
      }
    }

    // space:<alias>[/<root>]
    const m = /^space:([^/]+)(?:\/([^/]+))?$/.exec(home)
    if (m) {
      return {
        repository,
        spaceAlias: m[1],
        rootAlias: m[2] ?? null,
        relativePath: subpath
      }
    }

    // Unknown value → fall back to personal to stay safe.
    return {
      repository,
      spaceAlias: SPACE_ALIAS.PERSONAL,
      rootAlias: null,
      relativePath: subpath
    }
  }

  // Build the Sync-in WebDAV-style full path for a resolved tuple.
  //   files/personal/<relative>
  //   files/<spaceAlias>/<relative>
  //   trash/<spaceAlias>/<relative>
  // Callers feed this into FilesManager / WebDAVMethods which expect paths
  // rooted at the repository.
  toInternalPath(resolved: NcResolvedPath): string {
    const segments: string[] = [resolved.repository, resolved.spaceAlias]
    if (resolved.rootAlias) segments.push(resolved.rootAlias)
    if (resolved.relativePath) segments.push(resolved.relativePath)
    return segments.join('/')
  }

  private readMobileHome(user: UserWithSettings): string | null {
    const settings = user.settings
    if (!settings || typeof settings !== 'object') return null
    const v = settings['mobileHome']
    return typeof v === 'string' && v.length > 0 ? v : null
  }
}

// Normalize an NC path segment: strip leading/trailing slashes, collapse
// doubles, reject path-escape attempts. Exported so callers that need to peek
// at the first segment (e.g. share-mount alias lookup in nc-dav.controller)
// don't have to re-implement decode/normalize separately.
export function normalizeNcSubpath(sub: string): string {
  return normalize(sub)
}

function normalize(sub: string): string {
  const decoded = safeDecode(sub)
  // Strip leading and trailing slashes.
  let s = decoded.replace(/^\/+/, '').replace(/\/+$/, '')
  // Collapse internal doubles.
  s = s.replace(/\/{2,}/g, '/')
  // Defense in depth: reject `..` segments. Upstream FilesManager checks this
  // too but catching early gives us a clearer 400 from the resolver if we
  // ever want to surface one.
  const parts = s.split('/')
  for (const p of parts) {
    if (p === '..' || p === '.') return ''
  }
  return s
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
