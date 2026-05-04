import { Controller, Get, HttpException, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
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
    return this.response.json(res, {
      editors: this.directEditing.listEditors(),
      creators: this.directEditing.listCreators()
    })
  }

  // POST per upstream — but parameters arrive in the *query string*, not the
  // body. NextcloudKit's `directEditingOpen` builds the URL as
  // `/directEditing/open?path=/<file>&fileId=<id>&editorId=<id>` and POSTs
  // an empty body. Mirroring that exactly.
  @Post('ocs/v2.php/apps/files/api/v1/directEditing/open')
  async open(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('path') _path: string | undefined,
    @Query('editorId') editorId: string | undefined,
    @Query('fileId') fileIdRaw: string | undefined
  ): Promise<OcsEnvelope<OpenResponseData>> {
    this.response.requireJson(req)

    // fileId is the canonical identifier — `supportsFileId: true` in our
    // capability tells iOS to always send it. `path` is sanity-only (we
    // could fall back to it, but every observed iOS request includes both).
    const fileId = Number.parseInt(fileIdRaw ?? '', 10)
    if (!Number.isFinite(fileId) || fileId <= 0) {
      throw new HttpException('fileId required', HttpStatus.BAD_REQUEST)
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
