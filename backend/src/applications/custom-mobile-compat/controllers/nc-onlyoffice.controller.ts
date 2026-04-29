import { Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { OnlyOfficeManager } from '../../files/modules/only-office/only-office-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import type { NcOnlyOfficeEnvelope } from '../services/nc-onlyoffice-translator.service'
import { NcOnlyOfficeTranslatorService } from '../services/nc-onlyoffice-translator.service'

// NcOnlyOfficeController — exposes the Nextcloud OnlyOffice connector
// protocol so the OnlyOffice Documents mobile app can edit Sync-in files via
// its Nextcloud connection type. Mounted only when
// applications.files.onlyoffice.enabled === true (see
// custom-mobile-compat.module.ts).
//
// /config and /empty and /save run under NcBasicAuthGuard (mobile app
// authenticates with an AUTH_SCOPE.MOBILE_NC app-password). /track is
// authed by OnlyOfficeGuard (token-from-query) because the OnlyOffice
// document server posts back server-to-server with no Basic-Auth — see
// the separate NcOnlyOfficeCallbackController.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOnlyOfficeController {
  constructor(
    private readonly onlyOfficeManager: OnlyOfficeManager,
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager,
    private readonly translator: NcOnlyOfficeTranslatorService
  ) {}

  // GET /index.php/apps/onlyoffice/config?fileId=<id>
  //
  // Resolves fileId → personal-space SpaceEnv (matching nc-extras.preview's
  // approach), then asks Sync-in's existing OnlyOfficeManager for the editor
  // config and reshapes it into NC's connector envelope. The JWT signed by
  // OnlyOfficeManager.getSettings is reused verbatim because the same
  // applications.files.onlyoffice.secret signs both connectors.
  //
  // Shared spaces / non-personal-space files are not yet supported via
  // fileId — same scope limitation as nc-extras.preview's resolveFileId().
  @Get('index.php/apps/onlyoffice/config')
  async config(@Req() req: FastifyRequest & { user: UserModel }, @Query('fileId') fileId?: string): Promise<NcOnlyOfficeEnvelope> {
    const id = Number.parseInt(fileId ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) {
      throw new HttpException('fileId required', HttpStatus.BAD_REQUEST)
    }
    const space = await this.resolveFileId(req.user, id)
    if (!space) {
      throw new HttpException('file not found', HttpStatus.NOT_FOUND)
    }
    // OnlyOfficeManager.getSettings only reads req.headers['user-agent'] — a
    // FastifyRequest is structurally compatible with the FastifySpaceRequest
    // it expects. The cast is intentional: we don't carry a SpaceEnv on the
    // request like the spaces-controller decorators do.
    const synci = await this.onlyOfficeManager.getSettings(req.user, space, req as any)
    return this.translator.toNcEnvelope(synci)
  }

  @Post('index.php/apps/onlyoffice/empty')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  empty(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }

  @Post('index.php/apps/onlyoffice/save')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  save(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }

  // Resolve an `?fileId=<oc:fileid>` query param into a personal-space
  // SpaceEnv for the authenticated user. Mirrors nc-extras.controller's
  // resolveFileId() — files in non-personal spaces are not yet addressable
  // by id from the mobile-compat surface (same scope limitation as
  // /index.php/core/preview).
  private async resolveFileId(user: UserModel, fileId: number): Promise<SpaceEnv | null> {
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, fileId)
    } catch {
      return null
    }
    if (!row?.path) return null
    const pathSegments = row.path.split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...pathSegments]
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
  }
}

// Separate controller for /track because it needs token-from-query auth
// (OnlyOfficeGuard) instead of Basic-Auth — the OnlyOffice document server
// posts the callback server-to-server. Wiring lands in Phase 3 once the
// guard is reachable across modules.
@Controller()
@AuthTokenSkip()
export class NcOnlyOfficeCallbackController {
  @Post('index.php/apps/onlyoffice/track')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  track(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
  }
}
