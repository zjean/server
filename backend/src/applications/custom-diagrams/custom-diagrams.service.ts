import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
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
import { FilesManager } from '../files/services/files-manager.service'
import { FileEvent } from '../files/events/file-events'
import { getProps, writeFromStream } from '../files/utils/files'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { haveSpaceEnvPermissions } from '../spaces/utils/permissions'
import type { FileLock } from '../files/interfaces/file-lock.interface'
import type { SpaceEnv } from '../spaces/models/space-env.model'
import { UserModel } from '../users/models/user.model'
import { DEPTH } from '../webdav/constants/webdav'
import { isDiagramExt } from './constants/diagrams'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import type { NewDiagramDto } from './dto/new-diagram.dto'
import type { SaveDiagramDto } from './dto/save-diagram.dto'

const MAX_DIAGRAM_BYTES = 10 * 1024 * 1024
const EDITOR_URL = process.env['DRAWIO_URL'] ?? 'https://embed.diagrams.net'
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
  constructor(
    private readonly spacesManager: SpacesManager,
    private readonly filesManager: FilesManager,
    private readonly versioning: VersioningService,
    private readonly filesLockManager: FilesLockManager
  ) {}

  async load(user: UserModel, path: string): Promise<LoadDiagramResponse> {
    const space = await this.resolveSpace(user, path)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const stat = await getProps(space.realPath)
    if (stat.size > MAX_DIAGRAM_BYTES) throw new HttpException('file too large', HttpStatus.PAYLOAD_TOO_LARGE)
    const xml = await readFile(space.realPath, 'utf-8')
    return {
      xml,
      etag: contentEtag(xml),
      mtime: stat.mtime,
      name: stat.name,
      isWritable: haveSpaceEnvPermissions(space, SPACE_OPERATION.MODIFY),
      editorUrl: EDITOR_URL
    }
  }

  async save(user: UserModel, dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    const space = await this.resolveSpace(user, dto.path)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    if (!haveSpaceEnvPermissions(space, SPACE_OPERATION.MODIFY)) {
      throw new HttpException('no write permission', HttpStatus.FORBIDDEN)
    }
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
    if (!isDiagramExt(dto.name)) {
      throw new HttpException('not a diagram file', HttpStatus.BAD_REQUEST)
    }
    const segments = [...dto.dirPath.split('/').filter(Boolean), dto.name]
    const space = await this.spacesManager.spaceEnv(user, segments)
    if (!space) throw new HttpException('space not found or access denied', HttpStatus.FORBIDDEN)
    try {
      /* `mkFile` speaks FileError/LockConflict, and BOTH extend Error rather
         than HttpException. This controller carries no `@UseFilters` and the
         app registers no global filter (only `VersioningExceptionsFilter` and
         `WebDAVExceptionsFilter`, both route-scoped), so an untranslated one
         reaches Nest's default handler as a 500 with an opaque body. Creating a
         diagram whose name is already taken is a 400 — `mkFile` even says so —
         and it came back a 500. */
      await this.filesManager.mkFile(user, space, false, true, false)

      /* NOT A DESTRUCTIVE WRITE, and the reason is one line up, not here.
         `mkFile(overwrite=false)` throws `Resource already exists` before this
         is reached, so there is never live content under this path to
         supersede — which is why this call site needs no snapshot hook and no
         lock of its own (mkFile's `checkLocks=true` already ran one). That
         exemption is load-bearing enough to be written down: CLAUDE.md's
         write-path grep list now names `writeFile` too, and this is the comment
         that closes the hit. If the `overwrite=false` argument ever changes,
         this becomes the NINTH destructive path and needs the full save()
         treatment. */
      await writeFile(space.realPath, EMPTY_DRAWIO_XML, 'utf-8')
    } catch (e) {
      this.rethrowAsHttp(e)
    }
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

  // Both routes resolve through here, which is the one place an extension gate
  // cannot be forgotten. See constants/diagrams.ts for why it has to exist.
  private async resolveSpace(user: UserModel, path: string) {
    const segments = path.split('/').filter(Boolean)
    if (!isDiagramExt(segments[segments.length - 1] ?? '')) {
      throw new HttpException('not a diagram file', HttpStatus.BAD_REQUEST)
    }
    const space = await this.spacesManager.spaceEnv(user, segments)
    if (!space) throw new HttpException('space not found or access denied', HttpStatus.FORBIDDEN)
    return space
  }
}
