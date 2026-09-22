import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { ACTION } from '../../common/constants'
import { SERVER_NAME } from '../../common/shared'
import { VersioningService } from '../custom-versioning/services/versioning.service'
import { FileError } from '../files/models/file-error'
import { LockConflict } from '../files/models/file-lock-error'
import { FilesLockManager } from '../files/services/files-lock-manager.service'
import { configuration } from '../../configuration/config.environment'
import { HTTP_METHOD } from '../applications.constants'
import { FilesManager } from '../files/services/files-manager.service'
import { FileEvent } from '../files/events/file-events'
import { getProps, writeFromStream } from '../files/utils/files'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { SpaceGuard } from '../spaces/guards/space.guard'
import type { FastifySpaceRequest } from '../spaces/interfaces/space-request.interface'
import type { SpaceEnv } from '../spaces/models/space-env.model'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import type { FileLock } from '../files/interfaces/file-lock.interface'
import { UserModel } from '../users/models/user.model'
import { DEPTH } from '../webdav/constants/webdav'
import { canAccessToSpaceUrl, haveSpaceEnvPermissions } from '../spaces/utils/permissions'
import { PATH_TO_SPACE_SEGMENTS } from '../spaces/utils/routes'
import { isDiagramExt } from './constants/diagrams'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import type { NewDiagramDto } from './dto/new-diagram.dto'
import type { SaveDiagramDto } from './dto/save-diagram.dto'

const MAX_DIAGRAM_BYTES = 10 * 1024 * 1024
const EMPTY_DRAWIO_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'

// Content-derived ETag. Shared `genEtag` (size+mtime) collides across versions
// with equal byte length saved in the same mtime granule — possible under
// autosave bursts — and silently breaks optimistic concurrency. SHA-1 over a
// <=10 MB string is microseconds.
function contentEtag(xml: string): string {
  return createHash('sha1').update(xml, 'utf-8').digest('hex')
}

@Injectable()
export class CustomDiagramsService {
  private readonly logger = new Logger(CustomDiagramsService.name)

  constructor(
    private readonly spacesManager: SpacesManager,
    private readonly filesManager: FilesManager,
    private readonly versioning: VersioningService,
    private readonly filesLockManager: FilesLockManager
  ) {}

  async load(user: UserModel, path: string): Promise<LoadDiagramResponse> {
    const space = await this.resolveSpace(user, path, HTTP_METHOD.GET)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const stat = await getProps(space.realPath)
    if (stat.size > MAX_DIAGRAM_BYTES) throw new HttpException('file too large', HttpStatus.PAYLOAD_TOO_LARGE)
    const xml = await readFile(space.realPath, 'utf-8')
    return {
      xml,
      etag: contentEtag(xml),
      mtime: stat.mtime,
      name: stat.name,
      // The trash is read-only for every principal (SpaceGuard.checkPermissions),
      // but a personal-space trash path carries SPACE_ALL_OPERATIONS, so the
      // permission bits alone would report it writable and the client would mount
      // an editable canvas over a file no save can ever reach.
      isWritable: !space.inTrashRepository && haveSpaceEnvPermissions(space, SPACE_OPERATION.MODIFY),
      // Read per request, not captured at module load: the same value feeds the
      // CSP `frame-src` from app.bootstrap, and one source of truth is the point
      // of moving this off `process.env` (#499).
      editorUrl: configuration.applications.files.diagrams.editorUrl
    }
  }

  async save(user: UserModel, dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    // PUT: `checkPermissions` resolves this to MODIFY when the target exists and
    // to ADD when it does not, and additionally refuses a trash path and an
    // exceeded quota — none of which the bare MODIFY test that used to live here
    // could see.
    const space = await this.resolveSpace(user, dto.path, HTTP_METHOD.PUT)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    if (Buffer.byteLength(dto.xml, 'utf-8') > MAX_DIAGRAM_BYTES) {
      throw new HttpException('xml payload too large', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    const expectedEtag = dto.etag

    /* A SERVER LOCK, held across the compare-and-write. Nothing here checked
       locks at all, so a file held by a WebDAV client or an open editor session
       was overwritten silently.

       `createOrRefresh`, NOT `create`: `create` treats ANY existing lock as a
       conflict, the caller's own included — and the same user very plausibly
       has this file open elsewhere in v2, which would have made every save
       fail. `createOrRefresh` refreshes a lock that is already yours and raises
       LockConflict only for someone else's, the same rule `FilesManager` and
       `restoreVersion` follow.

       WHAT THAT DOES AND DOES NOT BUY, PRECISELY — because the obvious reading
       ("the compare is now a CAS") is wrong and was written here once already:

         - Against ANOTHER principal it IS mutual exclusion. Their lock makes
           `acquireLock` throw and this method never reaches the compare; our
           lock makes their WebDAV/editor/upload path conflict for as long as we
           hold it. That is the hole this closed.

         - Against the CALLER'S OWN concurrent saves it is NOT. `createOrRefresh`
           does not block: the second save finds the first save's lock, sees its
           own `owner.id` and returns `[false, existingLock]`, so both run the
           compare-snapshot-write sequence at once. Two tabs (or a tab and a
           phone) therefore still race: both read the same bytes, both match the
           etag, both write, last writer wins, and the loser gets a 200 carrying
           an etag that no longer describes the file. The `finally` below makes
           it slightly worse — whichever call took the lock drops it on the way
           out, possibly while the other is still inside.

           This is not fixable with the lock manager as it stands (there is no
           same-owner barrier, and `create` instead of `createOrRefresh` would
           reject the far more common case of one user with the file legitimately
           open twice), and a bespoke mutex here would only cover one process.
           So it stays a NARROWED race, not a closed one: the window is the
           read-compare-snapshot-write sequence below, and that window is WIDER
           than the old code's, because `snapshotBeforeOverwrite` (whole-file
           blob copy, hash, DB insert) now sits inside it. The frontend's 409
           handling is what makes the narrowed version survivable in practice
           (#496); a genuine same-user CAS would need a compare-and-swap in the
           store, which is out of scope here. */
    const [created, lock] = await this.acquireLock(user, space)
    try {
      const beforeXml = await readFile(space.realPath, 'utf-8')
      if (contentEtag(beforeXml) !== expectedEtag) {
        throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
      }

      /* THE EIGHTH DESTRUCTIVE WRITE PATH (ADR §4). This one was missing from
         the table entirely, so a diagram edited for an hour under drawio's
         `autosave=1` produced an empty version panel and no way back. The
         snapshot captures the bytes the line below is about to destroy and must
         stay immediately in front of it; it never throws (ADR §4), so a
         versioning failure degrades to "no version for this save" rather than
         breaking the save.

         IT IS NOT A CRASH SAFETY NET, AND MUST NOT BE SOLD AS ONE. It returns
         immediately when `files.versions.enabled` is false — the SHIPPED
         DEFAULT (`files.config.ts:151`) — and even enabled it is suppressed by
         `isCoalesced` for any save inside the origin's window, which is most of
         an autosave burst. So in the default configuration the write below is
         genuinely destructive-first: the live file is truncated before the first
         byte lands, and a disk-full or a kill mid-write leaves a truncated
         diagram with nothing to restore from. The old rename-over-inode code
         did protect that one case, and this trades it away deliberately — the
         inode must survive (see the next comment), the payload is already whole
         in memory so a staging copy would validate nothing, and
         `copyFileContent`, the helper both editors use, has exactly the same
         exposure. Do not "fix" it here without fixing it there.

         `origin: 'web'` rather than a new enum value, and the reason is NOT
         that the semantics match — they do not. drawio under `autosave=1` is a
         document-server cadence, which is the very thing ADR §5.1's per-origin
         override exists to separate from a human pressing Save, so by that rule
         this belongs with the editors. The reason is cost: `origin` is a
         mysqlEnum column, a ninth value is a schema migration, and the price of
         not paying it is a version RATE, not a correctness bug — 60s here
         against the editors' 300s, so roughly 5x the rows for the same hour of
         editing, all of it bounded by thinning (ADR §5.3). The bill an operator
         cannot pay today is tuning: `web` has no entry in
         `minIntervalSecondsByOrigin`, so lowering the diagram rate also lowers
         it for every ordinary browser upload. Revisit with the next migration
         that touches this table. */
      await this.versioning.snapshotBeforeOverwrite(user, space, { origin: 'web' })

      /* THE LIVE FILE'S INODE MUST SURVIVE (ADR §9, invariant 2). This used to
         write a sibling `.tmp-<pid>-…` file and rename() it over the target,
         which replaces the inode — and trash retention indexes trashed entries
         by inode (`files-trash-retention.service.ts`, `{ id: stats.ino }`), so
         a re-save could mint a fresh inode and keep a trashed diagram alive
         past its retention window. The same tmp name was invisible to
         `isInternalTemporaryEntry`, so a crash between write and rename left an
         orphan listed, synced and downloadable in the user's folder forever.

         `writeFromStream` with no `start` opens the destination with flag 'w':
         it truncates IN PLACE and keeps the inode, which is exactly what both
         editors get out of `copyFileContent`. There is no staging file to
         orphan because there is no staging file: the payload is already whole
         in memory and its size has been checked above, so a tmp copy would
         validate nothing that is not already known. */
      await writeFromStream(space.realPath, Readable.from([Buffer.from(dto.xml, 'utf-8')]))

      /* Every other write path announces itself on this bus, and three
         subscribers need it: FilesEventManager (quota recompute + content
         indexing + upstream's own recents), NcSyncLog (without an entry, stock
         NC mobile clients are never told the file changed and keep serving the
         copy their sync token points at) and RecentsTouchService. `createNew`
         already emitted ACTION.ADD; the save was the half that never did, so a
         diagram could grow from 1 KB to 10 MB without the storage figure
         moving.

         `source: 'editor'` because that is what this is — the same claim
         Collabora and OnlyOffice make from their own save paths, and what gates
         upstream's `processRecentEditorUpdates`. The fork's own
         `custom-recents-touch` fires on any source, so the two overlap; that
         double-write is deliberate and harmless (both go through
         `FilesQueries.upsertRecent`, see #493). */
      FileEvent.emit('event', { user, space, action: ACTION.UPDATE, rPath: space.realPath, source: 'editor' })

      const stat = await getProps(space.realPath)
      return { etag: contentEtag(dto.xml), mtime: stat.mtime }
    } finally {
      // Only release a lock this call took. A pre-existing one belongs to a
      // session that is still open, and removing it would silently unlock a
      // file someone is working in.
      if (created) {
        await this.filesLockManager.removeLock(lock.key).catch(() => undefined)
      }
    }
  }

  async createNew(user: UserModel, dto: NewDiagramDto): Promise<{ path: string }> {
    // `NewDiagramDto.name` is validated as a non-empty string and nothing else,
    // so it arrives able to carry separators and `..`. Run it through the same
    // sanitiser the path half already gets and keep only the LAST segment — a
    // name is a name, and `dirPath` is the only thing allowed to say where.
    const name = PATH_TO_SPACE_SEGMENTS(dto.name).pop() ?? ''
    if (!name) throw new HttpException('invalid file name', HttpStatus.BAD_REQUEST)
    // The same extension gate `resolveSpace` applies to load/save. Without it
    // this route is a generic "create an arbitrary file" primitive, and the
    // file it creates would then be loadable and writable through /load and
    // /save (see constants/diagrams.ts).
    if (!isDiagramExt(name)) throw new HttpException('not a diagram file', HttpStatus.BAD_REQUEST)
    const segments = [...PATH_TO_SPACE_SEGMENTS(dto.dirPath), name]
    // POST maps to ADD. `mkFile` never checks permissions itself — upstream only
    // ever calls it from behind SpaceGuard — so without this the route created
    // files for read-only members (#473).
    const space = await this.authorize(user, segments, HTTP_METHOD.POST)
    // `mkFile` throws `FileError`/`LockConflict`, both of which extend Error and
    // not HttpException — and this controller carries no `@UseFilters`, so an
    // escaping one is a 500. The commonest case is the most ordinary: creating a
    // diagram whose name is already taken is `FileError(400, 'Resource already
    // exists')`. Same translation and wording as
    // `files-methods.service.ts::handleError`.
    try {
      await this.filesManager.mkFile(user, space, false, true, false)
    } catch (e) {
      if (e instanceof LockConflict) throw new HttpException('The file is locked', HttpStatus.LOCKED)
      if (e instanceof FileError) throw new HttpException(e.message.split(',')[0], e.httpCode)
      throw e
    }
    await writeFile(space.realPath, EMPTY_DRAWIO_XML, 'utf-8')
    FileEvent.emit('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    return { path: segments.join('/') }
  }

  private async acquireLock(user: UserModel, space: SpaceEnv): Promise<[boolean, FileLock]> {
    try {
      return await this.filesLockManager.createOrRefresh(user, space.dbFile, SERVER_NAME, DEPTH.RESOURCE)
    } catch (e) {
      this.rethrowAsHttp(e)
    }
  }

  /* `FileError` and `LockConflict` both extend Error, not HttpException, so
     letting either escape a controller returns an opaque 500 — a 400 or a 423
     arriving as "Internal server error". Same translation and same wording as
     `files-methods.service.ts::handleError`, including its `split(',')` (file
     helpers append the offending path after a comma, and it must not be echoed
     to the client). Anything else is rethrown untouched: an ENOSPC really is a
     500. */
  private rethrowAsHttp(e: unknown): never {
    if (e instanceof LockConflict) {
      throw new HttpException('The file is locked', HttpStatus.LOCKED)
    }
    if (e instanceof FileError) {
      throw new HttpException(e.message.split(',')[0], e.httpCode)
    }
    throw e
  }

  // Both `load` and `save` resolve through here, which is the one place an
  // extension gate cannot be forgotten.
  //
  // THE ORDER OF THESE THREE STEPS IS LOAD-BEARING, and each ordering is pinned
  // by a test:
  //  1. repository access FIRST, because it is the only check that touches no
  //     resolver — a path that sanitises to `etc/passwd` must come back 403
  //     rather than leaking a 400 that says "…but that is not a diagram";
  //  2. the extension gate SECOND, before `spacesManager.spaceEnv` is ever
  //     called, so a non-diagram path is refused without any space resolution
  //     (`#525` pins `expect(spacesManager.spaceEnv).not.toHaveBeenCalled()`);
  //  3. the full guard equivalent last.
  private async resolveSpace(user: UserModel, path: string, method: string): Promise<SpaceEnv> {
    const segments = PATH_TO_SPACE_SEGMENTS(path)
    this.assertRepositoryAccess(user, segments)
    if (!isDiagramExt(segments[segments.length - 1] ?? '')) {
      throw new HttpException('not a diagram file', HttpStatus.BAD_REQUEST)
    }
    return this.authorize(user, segments, method)
  }

  // The checks SpaceGuard would have run if these routes carried the path in the
  // URL instead of in a query parameter / body. Kept in the service rather than
  // duplicated as a fork-owned guard so that it reuses upstream's own decision
  // function — `SpaceGuard.checkPermissions` is a static for exactly this reason
  // — and so a later change to upstream's permission rules reaches this module
  // too. Equivalent to `@UseGuards(SpaceGuard)`: repository access, space
  // enabled, the per-method operation, the trash gate and the quota gate.
  private async authorize(user: UserModel, segments: string[], method: string): Promise<SpaceEnv> {
    this.assertRepositoryAccess(user, segments)
    let space: SpaceEnv
    try {
      // The guard wraps this call for a reason: `spacesManager.spaceEnv` throws
      // a bare `Error` for an unresolvable path (`spaces-manager.service.ts`),
      // and `realPathFromSpace` throws a `FileError`. Neither is an
      // HttpException, so letting one escape turns a malformed path into a 500
      // — `GET /api/diagrams/load?path=files` did exactly that.
      space = await this.spacesManager.spaceEnv(user, segments)
    } catch (e) {
      this.logger.warn({ tag: this.authorize.name, msg: `${e}` })
      throw new HttpException('Space path is not valid', HttpStatus.BAD_REQUEST)
    }
    // 404, not 403, matching the guard: `spaceEnv` returns null for a space that
    // does not exist OR that this user cannot see, and the guard does not
    // distinguish the two either.
    if (!space) throw new HttpException('Space not found', HttpStatus.NOT_FOUND)
    if (!space.enabled) throw new HttpException('Space is disabled', HttpStatus.FORBIDDEN)
    await SpaceGuard.checkPermissions({ method, space } as FastifySpaceRequest, this.logger)
    return space
  }

  private assertRepositoryAccess(user: UserModel, segments: string[]): void {
    if (!canAccessToSpaceUrl(user, segments)) {
      this.logger.warn(`${user.login} is not allowed to access to this repository : ${segments.join('/')}`)
      throw new HttpException('You are not allowed to access to this repository', HttpStatus.FORBIDDEN)
    }
  }
}
