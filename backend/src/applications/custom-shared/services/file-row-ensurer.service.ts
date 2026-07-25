import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { files } from '../../files/schemas/files.schema'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'

// Materializes a `files` DB row for a filesystem entry that does not have one
// yet, and returns its real, positive `files.id`.
//
// WHY THIS EXISTS AT ALL
//
// The `files` table is a sparse, lazily-populated index — not a row-per-file
// mirror. `FileDBProps` carries no `id`; it is a scope + path descriptor, and
// `space.dbFile` is built by `dbFileFromSpace` from the space env alone with no
// DB lookup. Rows are only materialized on demand, by shares, comments,
// favorites, recents, sync-paths and nc-dav. A file that has only ever been
// uploaded and edited therefore has NO row and NO id.
//
// Two independent features need a stable id for such a file:
//   - custom-mobile-compat, to emit a real `<oc:fileid>` instead of the
//     inode-derived placeholder NC iOS rejects on follow-up calls (see
//     NcFileRowEnsurer, which wraps this service);
//   - custom-versioning, whose version rows are keyed on `files.id` precisely
//     so that a rename or move needs no repathing.
//
// WHY WE CANNOT JUST CALL `getOrCreateUserFile`
//
// That helper inserts a row whenever `file.id <= 0` without a path-keyed
// lookup, and the `files` table has NO unique index on (ownerId, path, name)
// — see `files.schema.ts`, which indexes `path` and `name` but does not
// constrain them. Repeated calls for the same path would fan out duplicate
// rows. We do the lookup ourselves first and only insert on a genuine miss.
//
// Directories are handled the same way as files. Sync-in gives directories
// real rows on demand (when shared, commented, or made a space root), so the
// lookup matches on `isDir` too — otherwise a file and a directory at the same
// (path, name), which the schema permits, could alias.
//
// This service is deliberately NOT gated by `files.versions.enabled`:
// mobile-compat's oc:fileid correctness depends on it unconditionally.
@Injectable()
export class FileRowEnsurer {
  private readonly logger = new Logger(FileRowEnsurer.name)

  constructor(
    @Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema,
    private readonly filesQueries: FilesQueries
  ) {}

  // Returns a stable positive `files.id` for `props` within `space`.
  //
  // `props.path` must be the in-space directory path (as stored in
  // `files.path`), NOT a URL — callers holding a WebDAV/DAV url must normalize
  // first (NcFileRowEnsurer does this).
  //
  // Returns 0 rather than throwing on any DB failure, so callers can degrade:
  // rendering a listing with a placeholder id, or skipping a version snapshot,
  // both beat failing the user's request.
  async ensureFileId(user: UserModel, space: SpaceEnv, props: FileProps): Promise<number> {
    try {
      if (space.inPersonalSpace) {
        const existing = await this.findUserFileByPath(user.id, props)
        if (existing > 0) return existing
        // Force id to 0 so getOrCreateUserFile does not take its lookup-by-id
        // branch with a placeholder (negative inode) value.
        return (await this.filesQueries.getOrCreateUserFile(user.id, { ...props, id: 0 })) || 0
      }
      // Shared / external space: getSpaceFileId already does the path-keyed
      // lookup against (spaceId|spaceExternalRootId|shareExternalId, path,
      // name); fall through to the upsert helper only on a miss.
      const dbFile = dbFileFromSpace(user.id, space)
      const existing = await this.filesQueries.getSpaceFileId(props, dbFile)
      if (existing > 0) return existing
      return (await this.filesQueries.getOrCreateSpaceFile(0, props, dbFile)) || 0
    } catch (e) {
      this.logger.warn({
        tag: this.ensureFileId.name,
        msg: `failed to ensure file row for ${props.path}/${props.name}: ${(e as Error).message}`
      })
      return 0
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
