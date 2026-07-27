import { Injectable } from '@nestjs/common'
import path from 'node:path'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { FileRowEnsurer } from '../../custom-shared/services/file-row-ensurer.service'

// Ensures a Sync-in `files` DB row exists for an FS-only entry yielded during a
// Nextcloud PROPFIND, so we can emit a real, stable `<oc:fileid>` instead of
// the inode-derived placeholder NC iOS rejects on follow-up calls.
//
// Why this matters: NC iOS uses oc:fileid as the primary key for its offline
// cache and for follow-up endpoints — most importantly
// `/index.php/core/preview?fileId=…`. Sync-in tags filesystem-only files
// (those without a row yet) with `id = -stat.ino`, our prop builder maps
// negatives to abs(inode), but that absolute inode value is NOT a real DB id
// — `filesQueries.getUserFile(userId, inode)` returns null and we 404.
// Result: image previews and gallery tap-to-view are broken for every file
// that was uploaded outside the DB-tracking flows (direct disk drop, restored
// from backup, pre-existing volume mount).
//
// Directories: also handled. Sync-in's data model gives directories real DB
// rows on demand (when shared, commented, or made a space root — see
// shares-manager.service.ts, comments-manager.service.ts, spaces-queries
// `spaceRootFiles`). Without ensurer coverage, dir oc:ids were derived from
// `abs(inode)` and could collide with file DB ids in the same listing
// (issue #209). Now dirs go through the same ensure path: lookup by
// (ownerId|space scope, path, name, isDir) first, insert on miss.
//
// The lookup-then-insert-on-miss core (including why blindly calling
// `getOrCreateUserFile` fans out duplicate rows) now lives in the shared
// `FileRowEnsurer` (custom-shared), so custom-versioning can reuse it. What
// stays here is the NC/WebDAV-specific part: the short-circuits, the DAV url
// path normalization, and the `f.id` placeholder fallback.
@Injectable()
export class NcFileRowEnsurer {
  constructor(private readonly fileRowEnsurer: FileRowEnsurer) {}

  // Returns a stable positive file id for the WebDAVFile.
  //
  // Short-circuits (returns f.id unchanged) when the row is already real, the
  // request is against the trash repository, or no user is attached. When the
  // shared ensurer cannot resolve an id (DB error), falls back to f.id —
  // better to render the listing with a placeholder fileid than to drop the
  // entire PROPFIND.
  async ensure(f: WebDAVFile, space: SpaceEnv, user: UserModel | undefined): Promise<number> {
    if (!user) return f.id
    if (f.id > 0) return f.id
    if (space.inTrashRepository) return f.id

    const fileProps = f as unknown as FileProps
    // webdavSpaces.listFiles yields the isCurrent=true root entry via
    // getProps(space.realPath, req.dav.url). req.dav.url is the full NC WebDAV
    // path (/remote.php/dav/files/{user}/Folder/file.txt), so dirName gives the
    // URL prefix (/remote.php/dav/files/{user}/Folder) rather than the in-space
    // relative path (Folder). A leading '/' signals this case; correct it by
    // deriving the path from space.relativeUrl instead.
    const correctedPath = fileProps.path?.startsWith('/') ? path.dirname(space.relativeUrl) : fileProps.path
    const lookupProps = correctedPath !== fileProps.path ? { ...fileProps, path: correctedPath } : fileProps

    const id = await this.fileRowEnsurer.ensureFileId(user, space, lookupProps)
    return id > 0 ? id : f.id
  }
}
