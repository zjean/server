import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import path from 'node:path'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { files } from '../../files/schemas/files.schema'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'

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
// Why we can't just call `getOrCreateUserFile` blindly: that helper inserts a
// row whenever `file.id <= 0` without a path-keyed lookup, and the `files`
// table has no unique index on (ownerId, path, name). Repeated PROPFINDs of
// the same folder would fan out duplicate rows. We do the lookup ourselves
// first, only inserting on a genuine miss.
@Injectable()
export class NcFileRowEnsurer {
  private readonly logger = new Logger(NcFileRowEnsurer.name)

  constructor(
    @Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema,
    private readonly filesQueries: FilesQueries
  ) {}

  // Returns a stable positive file id for the WebDAVFile.
  //
  // Short-circuits (returns f.id unchanged) when the row is already real, the
  // request is against the trash repository, or no user is attached. On any
  // DB error, falls back to f.id — better to render the listing with a
  // placeholder fileid than to drop the entire PROPFIND.
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
    try {
      if (space.inPersonalSpace) {
        const existing = await this.findUserFileByPath(user.id, lookupProps)
        if (existing > 0) return existing
        return await this.filesQueries.getOrCreateUserFile(user.id, { ...lookupProps, id: 0 })
      }
      // Shared / external space: getSpaceFileId already does the path-keyed
      // lookup against (spaceId|spaceExternalRootId|shareExternalId, path,
      // name); fall through to the upsert helper only on miss.
      const dbFile = dbFileFromSpace(user.id, space)
      const existing = await this.filesQueries.getSpaceFileId(lookupProps, dbFile)
      if (existing > 0) return existing
      return await this.filesQueries.getOrCreateSpaceFile(0, lookupProps, dbFile)
    } catch (e) {
      this.logger.warn({
        tag: this.ensure.name,
        msg: `failed to ensure file row for ${lookupProps.path}/${lookupProps.name}: ${(e as Error).message}`
      })
      return f.id
    }
  }

  // Path-keyed lookup for personal-space files. Mirrors what
  // FilesQueries.getSpaceFileId does for spaces, but scoped by ownerId.
  // Matches the entry's `isDir` so a file and a directory at the same
  // (path, name) — unlikely but expressible in the schema — don't alias.
  // Returns 0 when not found.
  private async findUserFileByPath(userId: number, file: FileProps): Promise<number> {
    const [row] = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerId, userId), eq(files.path, file.path), eq(files.name, file.name), eq(files.isDir, file.isDir)))
      .limit(1)
    return row?.id ?? 0
  }
}
