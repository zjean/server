import { Injectable } from '@nestjs/common'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { UserModel } from '../../users/models/user.model'

// One incoming share root a user has access to, normalized from the
// SharesQueries.shareRootFiles row shape so callers don't need to know which
// FileProps fields are populated by the share-list query.
//
// The fileId here is the *underlying file's* real DB id (e.g. Alice's actual
// /Photos folder), not the share id. This matches what oc:fileid emits in
// PROPFIND and what file_source emits in the OCS /shares response, so an iOS
// client that caches one will hit the same row from the other.
export interface NcShareMount {
  shareId: number
  alias: string
  name: string
  fileId: number
  isDir: boolean
  size: number
  mtime: number
  ctime: number
  mime: string
  // Intersected share permissions, Sync-in op-string (e.g. "a:d:m:so").
  permissions: string
  owner: { id: number; login: string; fullName: string }
}

// Lookup of incoming share-mounts for an NC mobile request. Sits between the
// nc-dav.controller (which routes /remote.php/dav/files/{user}/<alias>/... to
// the donor's space) and the nc-propfind.service (which injects one virtual
// child per mount into the home-root listing). Kept separate from
// NcPathResolverService so that resolver stays sync and untouched — share
// resolution needs DB access.
@Injectable()
export class NcShareMountResolverService {
  constructor(private readonly sharesQueries: SharesQueries) {}

  // All share-mount roots the user can browse via NC mobile.
  // No per-request caching here; callers that read mounts multiple times in
  // one request (PROPFIND home + child traversal) should cache at their layer.
  async listMounts(user: UserModel): Promise<NcShareMount[]> {
    const rows = await this.sharesQueries.shareRootFiles(user, {})
    const mounts: NcShareMount[] = []
    for (const r of rows) {
      const m = toMount(r)
      if (m) mounts.push(m)
    }
    return mounts
  }

  // Look up a single mount by its share alias. Returns null when the alias
  // isn't a known mount for this user — including when alias is empty.
  async findByAlias(user: UserModel, alias: string): Promise<NcShareMount | null> {
    if (!alias) return null
    const mounts = await this.listMounts(user)
    return mounts.find((m) => m.alias === alias) ?? null
  }
}

function toMount(f: FileProps): NcShareMount | null {
  // Defensive: shareRootFiles always populates `root`, but a partial row
  // (broken share, deleted donor file) might leak through; skip rather than
  // surface an obviously invalid mount.
  if (!f.root || !f.root.alias) return null
  if (!Number.isFinite(f.id) || f.id <= 0) return null
  const ownerLogin = f.root.owner?.login ?? ''
  return {
    shareId: f.root.id,
    alias: f.root.alias,
    name: f.root.name ?? f.root.alias,
    fileId: f.id,
    isDir: !!f.isDir,
    size: f.size ?? 0,
    mtime: f.mtime ?? 0,
    ctime: f.ctime ?? 0,
    mime: f.mime ?? '',
    permissions: f.root.permissions ?? '',
    owner: {
      id: f.root.owner?.id ?? 0,
      login: ownerLogin,
      fullName: f.root.owner?.fullName ?? ownerLogin
    }
  }
}
