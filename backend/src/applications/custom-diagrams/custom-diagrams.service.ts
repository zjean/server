import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { ACTION } from '../../common/constants'
import { configuration } from '../../configuration/config.environment'
import { HTTP_METHOD } from '../applications.constants'
import { FilesManager } from '../files/services/files-manager.service'
import { FileEvent } from '../files/events/file-events'
import { getProps } from '../files/utils/files'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { SpaceGuard } from '../spaces/guards/space.guard'
import type { FastifySpaceRequest } from '../spaces/interfaces/space-request.interface'
import type { SpaceEnv } from '../spaces/models/space-env.model'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { canAccessToSpaceUrl, haveSpaceEnvPermissions } from '../spaces/utils/permissions'
import { PATH_TO_SPACE_SEGMENTS } from '../spaces/utils/routes'
import { UserModel } from '../users/models/user.model'
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
    private readonly filesManager: FilesManager
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
    const beforeXml = await readFile(space.realPath, 'utf-8')
    if (contentEtag(beforeXml) !== expectedEtag) {
      throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
    }

    // Write-tmp + rename = atomic CAS on same filesystem. Readers see the old or
    // the new bytes, never a half-written file. The recheck closes the window
    // between the initial readFile and the rename.
    const tmpPath = `${space.realPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmpPath, dto.xml, 'utf-8')
    const recheckXml = await readFile(space.realPath, 'utf-8')
    if (contentEtag(recheckXml) !== expectedEtag) {
      await unlink(tmpPath).catch(() => undefined)
      throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
    }
    await rename(tmpPath, space.realPath)

    const stat = await getProps(space.realPath)
    return { etag: contentEtag(dto.xml), mtime: stat.mtime }
  }

  async createNew(user: UserModel, dto: NewDiagramDto): Promise<{ path: string }> {
    const segments = [...PATH_TO_SPACE_SEGMENTS(dto.dirPath), dto.name]
    // POST maps to ADD. `mkFile` never checks permissions itself — upstream only
    // ever calls it from behind SpaceGuard — so without this the route created
    // files for read-only members (#473).
    const space = await this.authorize(user, segments, HTTP_METHOD.POST)
    await this.filesManager.mkFile(user, space, false, true, false)
    await writeFile(space.realPath, EMPTY_DRAWIO_XML, 'utf-8')
    FileEvent.emit('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    return { path: segments.join('/') }
  }

  private async resolveSpace(user: UserModel, path: string, method: string): Promise<SpaceEnv> {
    return this.authorize(user, PATH_TO_SPACE_SEGMENTS(path), method)
  }

  // The checks SpaceGuard would have run if these routes carried the path in the
  // URL instead of in a query parameter / body. Kept in the service rather than
  // duplicated as a fork-owned guard so that it reuses upstream's own decision
  // function — `SpaceGuard.checkPermissions` is a static for exactly this reason
  // — and so a later change to upstream's permission rules reaches this module
  // too. Equivalent to `@UseGuards(SpaceGuard)`: repository access, space
  // enabled, the per-method operation, the trash gate and the quota gate.
  private async authorize(user: UserModel, segments: string[], method: string): Promise<SpaceEnv> {
    if (!canAccessToSpaceUrl(user, segments)) {
      this.logger.warn(`${user.login} is not allowed to access to this repository : ${segments.join('/')}`)
      throw new HttpException('You are not allowed to access to this repository', HttpStatus.FORBIDDEN)
    }
    const space = await this.spacesManager.spaceEnv(user, segments)
    if (!space) throw new HttpException('space not found or access denied', HttpStatus.FORBIDDEN)
    if (!space.enabled) throw new HttpException('Space is disabled', HttpStatus.FORBIDDEN)
    await SpaceGuard.checkPermissions({ method, space } as FastifySpaceRequest, this.logger)
    return space
  }
}
