import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { ACTION } from '../../common/constants'
import { FilesManager } from '../files/services/files-manager.service'
import { FileEvent } from '../files/events/file-events'
import { getProps, writeFromStream } from '../files/utils/files'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { haveSpaceEnvPermissions } from '../spaces/utils/permissions'
import { UserModel } from '../users/models/user.model'
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
    private readonly filesManager: FilesManager
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
    const beforeXml = await readFile(space.realPath, 'utf-8')
    if (contentEtag(beforeXml) !== expectedEtag) {
      throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
    }

    /* THE LIVE FILE'S INODE MUST SURVIVE (ADR §9, invariant 2). This used to
       write a sibling `.tmp-<pid>-…` file and rename() it over the target,
       which replaces the inode — and trash retention indexes trashed entries by
       inode (`files-trash-retention.service.ts`, `{ id: stats.ino }`), so a
       re-save could mint a fresh inode and keep a trashed diagram alive past
       its retention window. The same tmp name was invisible to
       `isInternalTemporaryEntry`, so a crash between write and rename left an
       orphan listed, synced and downloadable in the user's folder forever.

       `writeFromStream` with no `start` opens the destination with flag 'w':
       it truncates IN PLACE and keeps the inode, which is exactly what both
       editors get out of `copyFileContent`. There is no staging file to orphan
       because there is no staging file: the payload is already whole in memory
       and its size has been checked above, so a tmp copy would validate
       nothing that is not already known. */
    await writeFromStream(space.realPath, Readable.from([Buffer.from(dto.xml, 'utf-8')]))

    const stat = await getProps(space.realPath)
    return { etag: contentEtag(dto.xml), mtime: stat.mtime }
  }

  async createNew(user: UserModel, dto: NewDiagramDto): Promise<{ path: string }> {
    const segments = [...dto.dirPath.split('/').filter(Boolean), dto.name]
    const space = await this.spacesManager.spaceEnv(user, segments)
    if (!space) throw new HttpException('space not found or access denied', HttpStatus.FORBIDDEN)
    await this.filesManager.mkFile(user, space, false, true, false)
    await writeFile(space.realPath, EMPTY_DRAWIO_XML, 'utf-8')
    FileEvent.emit('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    return { path: segments.join('/') }
  }

  private async resolveSpace(user: UserModel, path: string) {
    const space = await this.spacesManager.spaceEnv(user, path.split('/').filter(Boolean))
    if (!space) throw new HttpException('space not found or access denied', HttpStatus.FORBIDDEN)
    return space
  }
}
