import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { FilesManager } from '../files/services/files-manager.service'
import { FilesQueries } from '../files/services/files-queries.service'
import { genEtag, getProps } from '../files/utils/files'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { UserModel } from '../users/models/user.model'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import type { NewDiagramDto } from './dto/new-diagram.dto'
import type { SaveDiagramDto } from './dto/save-diagram.dto'

const MAX_DIAGRAM_BYTES = 10 * 1024 * 1024
const EDITOR_URL = process.env['DRAWIO_URL'] ?? 'https://app.diagrams.net'

@Injectable()
export class CustomDiagramsService {
  constructor(
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager,
    private readonly filesManager: FilesManager
  ) {}

  async load(user: UserModel, fileId: number): Promise<LoadDiagramResponse> {
    const space = await this.resolveSpace(user, fileId)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const stat = await getProps(space.realPath)
    if (stat.size > MAX_DIAGRAM_BYTES) throw new HttpException('file too large', HttpStatus.PAYLOAD_TOO_LARGE)
    const xml = await readFile(space.realPath, 'utf-8')
    const etag = genEtag(null, space.realPath, false)
    return {
      xml,
      etag,
      mtime: stat.mtime,
      name: stat.name,
      isWritable: true,
      editorUrl: EDITOR_URL
    }
  }

  async save(user: UserModel, dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    const space = await this.resolveSpace(user, dto.fileId)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const current = genEtag(null, space.realPath, false)
    if (current !== dto.etag) throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
    await writeFile(space.realPath, dto.xml, 'utf-8')
    const stat = await getProps(space.realPath)
    return { etag: genEtag(stat, undefined, false), mtime: stat.mtime }
  }

  async createNew(user: UserModel, dto: NewDiagramDto): Promise<{ path: string }> {
    const segments = [...dto.dirPath.split('/').filter(Boolean), dto.name]
    const space = await this.spacesManager.spaceEnv(user, segments)
    await this.filesManager.mkFile(user, space, false, true, false)
    await writeFile(space.realPath, ' ', 'utf-8')
    return { path: segments.join('/') }
  }

  private async resolveSpace(user: UserModel, fileId: number) {
    const row = await this.filesQueries.getUserFile(user.id, fileId)
    if (!row?.path) throw new HttpException('file not found', HttpStatus.NOT_FOUND)
    const pathSegments = row.path.split('/').filter(Boolean)
    const space = await this.spacesManager.spaceEnv(user, ['files', 'personal', ...pathSegments])
    return space
  }
}
