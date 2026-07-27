import { HttpStatus, Injectable } from '@nestjs/common'
import { FileError } from '../../files/models/file-error'
import { FilesQueries } from '../../files/services/files-queries.service'
import { getMimeType } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import type { UserModel } from '../../users/models/user.model'
import type { VersionProps } from '../../custom-versioning/interfaces/version.interface'
import { VersioningService } from '../../custom-versioning/services/versioning.service'
import type { NcVersionXmlEntry } from '../utils/nc-version-xml'

// Bridges the NC versions DAV tree onto VersioningService.
//
// Two translations live here, and both are the reason this is a service rather
// than inline controller code.
//
// ── 1. fileId → SpaceEnv ──
//
// NC addresses a version collection by fileId alone, while every
// VersioningService method takes (user, space). The resolution is the same
// owner-scoped lookup nc-comments.controller and nc-onlyoffice-file-resolver
// use: FilesQueries.getUserFile(user.id, fileId) returns a row ONLY if the
// requester owns it, so it is the authorization step as well as the lookup.
// Consequence, identical to those two features: the NC versions surface covers
// PERSONAL-SPACE files only. A version query for a shared or space file 404s.
//
// NOTE ON FileRowEnsurer, because the Phase D handoff asks for it here.
// It is deliberately NOT used, and adding it would be dead code: a client can
// only reach this route with a fileId that our own PROPFIND of the parent
// directory handed it, and that PROPFIND is where NcFileRowEnsurer already runs
// (nc-propfind.service.ts:111). By the time a fileId exists on the wire, the
// `files` row exists — there is nothing left to materialize. The handoff's
// concern (a version query for an FS-only file 404ing) is real but is solved one
// layer up, and solving it twice would hide which layer owns it.
//
// ── 2. version row ↔ NC revision id ──
//
// See ncRevisionOf. This is the subtle one.
@Injectable()
export class NcVersionsService {
  constructor(
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager,
    private readonly versioning: VersioningService
  ) {}

  get enabled(): boolean {
    return this.versioning.enabled
  }

  // Resolves the SpaceEnv for a fileId the requester owns, or null.
  async resolveSpace(user: UserModel, fileId: number): Promise<SpaceEnv | null> {
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, fileId)
    } catch {
      return null
    }
    if (!row?.path) return null
    const urlSegments = ['files', 'personal', ...row.path.split('/').filter(Boolean)]
    try {
      const space = await this.spacesManager.spaceEnv(user, urlSegments)
      return space ?? null
    } catch {
      return null
    }
  }

  // History for one file, newest first, already collapsed to one entry per
  // revision id (see ncRevisionOf).
  async listEntries(user: UserModel, space: SpaceEnv): Promise<NcVersionXmlEntry[]> {
    const contentType = ncContentType(space.realPath)
    const entries: NcVersionXmlEntry[] = []
    const seen = new Set<number>()
    for (const version of await this.versioning.listVersions(user, space)) {
      const revision = ncRevisionOf(version)
      // listVersions is newest-first, so the first row wins a collision — see
      // ncRevisionOf for why one has to.
      if (seen.has(revision)) continue
      seen.add(revision)
      entries.push({
        revision,
        mtimeMs: version.mtime,
        size: version.size,
        contentType,
        label: version.label,
        author: version.author?.login ?? null
      })
    }
    return entries
  }

  // Maps an NC revision id back to one of our version rows.
  //
  // Throws FileError(404) rather than returning null so the caller's error
  // translation is the same for "no such revision" as for every other domain
  // error the versioning service raises.
  async requireVersionId(user: UserModel, space: SpaceEnv, revision: number): Promise<number> {
    const match = (await this.versioning.listVersions(user, space)).find((v) => ncRevisionOf(v) === revision)
    if (!match) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version not found')
    }
    return match.id
  }

  // Finds the single entry for a revision, for a Depth-0 PROPFIND of a version.
  async findEntry(user: UserModel, space: SpaceEnv, revision: number): Promise<NcVersionXmlEntry | null> {
    const entries = await this.listEntries(user, space)
    return entries.find((e) => e.revision === revision) ?? null
  }
}

// THE NC REVISION ID IS THE SUPERSEDED CONTENT'S mtime IN UNIX SECONDS.
//
// Not our row id. This is forced from two directions and neither is negotiable:
//
//   - Upstream's revision id IS a timestamp. The legacy backend names a stored
//     version `<path>.v<filemtime>` (Storage.php:374), VersionFile::getName()
//     returns getRevisionId(), and getLastModified() returns the same
//     timestamp. The whole tree is self-consistent around one number.
//   - NC Android never reads the href. FileVersion.getFileName() is
//     `String.valueOf(modifiedTimestamp / 1000)`, parsed out of
//     d:getlastmodified, and RestoreFileVersionRemoteOperation builds the
//     restore MOVE source from THAT. Name the node anything else and restore
//     asks for a revision that does not exist.
//
// Of our two timestamps, `mtime` is the one that means what upstream's means:
// the mtime of the bytes the version holds. `createdAt` is when the overwrite
// retired them, which can be months later (see the version interface).
//
// COST: one-second resolution, so two versions of one file whose mtimes fall in
// the same second collapse to a single NC entry. That is a property of the
// protocol, not of our storage — upstream cannot represent them either, since
// both would want the same `.v<ts>` filename. The v2 UI, which keys on the row
// id, still shows both. Collisions need sub-second-adjacent overwrites that also
// escaped the coalescing window (different author or origin), so they are rare;
// the newest row wins, deterministically, because listVersions is newest-first.
export function ncRevisionOf(version: Pick<VersionProps, 'mtime'>): number {
  return Math.floor(version.mtime / 1000)
}

// Sync-in stores mimes with the FIRST '/' replaced by '-' ('image-jpeg', and
// note `getMimeType` uses replace, not replaceAll — later dashes are part of the
// subtype). NC clients want the real thing. The two sentinels getMimeType can
// return for an unknown extension ('file') or a directory ('directory') are not
// mime types at all, so they become the generic binary type rather than being
// emitted verbatim.
export function ncContentType(realPath: string): string {
  const stored = getMimeType(realPath, false)
  if (stored === 'file' || stored === 'directory') return 'application/octet-stream'
  return stored.replace('-', '/')
}
