import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { ACTION } from '../../common/constants'
import { SERVER_NAME } from '../../common/shared'
import { VersioningService } from '../custom-versioning/services/versioning.service'
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

       Holding it around the etag compare is what turns that compare into a real
       CAS: the previous code read, wrote to a tmp file, re-read and renamed,
       narrowing the race but never closing it. */
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

         `origin: 'web'` rather than a new enum value: the ADR's `web` is the
         interactive browser write, which is exactly what this is, and it takes
         the 60-second interactive coalescing window for the same reason. */
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
    await this.filesManager.mkFile(user, space, false, true, false)
    await writeFile(space.realPath, EMPTY_DRAWIO_XML, 'utf-8')
    FileEvent.emit('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    return { path: segments.join('/') }
  }

  /* `LockConflict` extends Error, not HttpException, so letting one escape a
     controller returns an opaque 500. Same translation and same wording as
     `files-methods.service.ts::handleError` and
     `custom-versioning/filters/versioning-exception.filter.ts`. */
  private async acquireLock(user: UserModel, space: SpaceEnv): Promise<[boolean, FileLock]> {
    try {
      return await this.filesLockManager.createOrRefresh(user, space.dbFile, SERVER_NAME, DEPTH.RESOURCE)
    } catch (e) {
      if (e instanceof LockConflict) {
        throw new HttpException('The file is locked', HttpStatus.LOCKED)
      }
      throw e
    }
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
