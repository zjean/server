import { Body, Controller, Get, HttpException, HttpStatus, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcDirectEditingService, NC_DIRECT_EDITING_EDITOR_ID, type NcDirectCreator, type NcDirectEditor } from '../services/nc-direct-editing.service'
import { NcResponseService } from '../services/nc-response.service'
import type { OcsEnvelope } from '../utils/ocs-envelope'

// Path where the in-app text editor page is served, relative to baseUrl.
// Kept here (not in the editor-page controller) because /open returns a URL
// pointing at it — the two controllers share this constant by importing
// it from here.
export const NC_DIRECT_EDITING_EDITOR_PATH = '/custom-mobile-compat/text-editor'

interface InfoResponseData {
  editors: Record<string, NcDirectEditor>
  creators: Record<string, NcDirectCreator>
}

interface OpenResponseData {
  url: string
}

// NC iOS direct-editing OCS surface. Lets the stock NC iOS Edit button
// light up for plain-text and source-code files.
//
// End-to-end flow (see services/nc-direct-editing.service.ts for context):
//   1. Capabilities advertise `files.directEditing.url` → this controller's
//      info endpoint.
//   2. iOS GETs /info on first login, caches the editor list keyed by mimetype.
//   3. iOS POSTs /open?path=…&editorId=…&fileId=… when the user taps Edit.
//      We mint a short-lived token and return a URL pointing at our own
//      WKWebView editor page (NcTextEditorController).
//
// AuthTokenSkip + NcBasicAuthGuard mirror what every other NC OCS controller
// in this module uses — NC mobile clients authenticate per-request with
// Basic Auth (app password), not Sync-in JWTs.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcDirectEditingController {
  // Audit U2: instrumentation so a device session reveals whether iOS's
  // "Edit with OnlyOffice" affordance hits this controller's /open
  // (directEditing path) or the OnlyOffice connector at
  // /index.php/apps/onlyoffice/config. Every handler logs entry; correlate
  // by timestamp + URL during testing. Remove this once U2 is resolved
  // (PR description will track that).
  private readonly logger = new Logger(NcDirectEditingController.name)

  constructor(
    private readonly directEditing: NcDirectEditingService,
    private readonly response: NcResponseService,
    private readonly filesQueries: FilesQueries
  ) {}

  @Get('ocs/v2.php/apps/files/api/v1/directEditing')
  async info(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<OcsEnvelope<InfoResponseData>> {
    this.response.requireJson(req)
    this.logger.log({
      tag: 'directEditing.info',
      msg: `user ${req.user.id} (${req.user.login}) ua=${req.headers['user-agent'] ?? '-'}`
    })
    return this.response.json(res, {
      editors: this.directEditing.listEditors(),
      creators: this.directEditing.listCreators()
    })
  }

  // POST per upstream. iOS (NextcloudKit) sends parameters in the query string
  // with an empty body; Android (android-library) sends them in a JSON body
  // (?format=json only in the URL). We accept both: query params take
  // precedence, JSON body fields are the fallback.
  @Post('ocs/v2.php/apps/files/api/v1/directEditing/open')
  async open(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('path') queryPath: string | undefined,
    @Query('editorId') queryEditorId: string | undefined,
    @Query('fileId') fileIdRaw: string | undefined,
    @Body('path') bodyPath: string | undefined = undefined,
    @Body('editorId') bodyEditorId: string | undefined = undefined
  ): Promise<OcsEnvelope<OpenResponseData>> {
    this.response.requireJson(req)
    const _path = queryPath ?? bodyPath
    const editorId = queryEditorId ?? bodyEditorId
    this.logger.log({
      tag: 'directEditing.open',
      msg: `user ${req.user.id} (${req.user.login}) editorId=${editorId ?? '-'} path=${_path ?? '-'} fileId=${fileIdRaw ?? '-'} ua=${req.headers['user-agent'] ?? '-'}`
    })

    // fileId is preferred but optional: NextcloudKit's textOpenFile only
    // appends it when the caller passes one, and NCViewer never does — iOS
    // calls with path+editorId only. Fall back to a path-keyed lookup when
    // fileId is absent. Strip the leading '/' NC prepends, then split on the
    // last '/' to get the in-space (dirPath, name) pair the DB stores.
    let fileId = Number.parseInt(fileIdRaw ?? '', 10)
    if (!Number.isFinite(fileId) || fileId <= 0) {
      if (!_path) {
        throw new HttpException('fileId or path required', HttpStatus.BAD_REQUEST)
      }
      const stripped = _path.replace(/^\/+/, '')
      const slash = stripped.lastIndexOf('/')
      const dirPath = slash >= 0 ? stripped.slice(0, slash) : '.'
      const name = slash >= 0 ? stripped.slice(slash + 1) : stripped
      const resolved = await this.filesQueries.getUserFileByPath(req.user.id, dirPath, name)
      if (!resolved) {
        throw new HttpException('file not found', HttpStatus.NOT_FOUND)
      }
      fileId = resolved
    }

    if (editorId !== NC_DIRECT_EDITING_EDITOR_ID) {
      // Someone advertised a different editor and now wants to open with
      // it — catalog drift. Refuse rather than mint a token under an
      // editor name we don't actually serve.
      throw new HttpException('unknown editorId', HttpStatus.BAD_REQUEST)
    }

    // Owner-scoped lookup. Same constraint as NcOnlyOfficeFileResolver:
    // direct editing currently only supports personal-space files. A user
    // querying someone else's fileId returns null here → 404.
    //
    // We do NOT validate the mimetype here — `getUserFile` returns only
    // {id, path}, and iOS already gates `isAvailableDirectEditingEditorView`
    // on the file's content-type matching our advertised catalog before
    // the Edit button appears. Mimetype enforcement at content-load time
    // (where we resolve a SpaceEnv that carries the mime) is the second
    // layer; opening a token for a non-editable file is harmless because
    // the editor will refuse to load its content.
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(req.user.id, fileId)
    } catch {
      row = null
    }
    if (!row) {
      throw new HttpException('file not found', HttpStatus.NOT_FOUND)
    }

    const token = await this.directEditing.mintEditToken({ user: req.user, fileId })
    const url = `${this.response.baseUrl(req)}${NC_DIRECT_EDITING_EDITOR_PATH}?token=${encodeURIComponent(token)}`

    return this.response.json(res, { url })
  }
}
