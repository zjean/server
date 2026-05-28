import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'
import { buildSharedWithMeRecord, type NcOcsShareRecord } from '../utils/nc-ocs-share-record'
import { OCS_OK_V1, type OcsEnvelope } from '../utils/ocs-envelope'

// OCS Shares endpoint — feeds the NC iOS "Shares" tab (NCShares.swift) and
// any other client that lists shares via the standard files_sharing API.
//
// Wire format follows upstream NC ShareAPIController::formatShare
// (apps/files_sharing/lib/Controller/ShareAPIController.php). NextcloudKit
// constructs the URL via NKShareParameter.endpoint = "ocs/v2.php/apps/
// files_sharing/api/v1/shares" and adds query params via .queryParameters,
// of which we honour `shared_with_me` (= true | false). Other parameters
// (reshares, subfiles, path) are accepted but ignored — Sync-in's share
// model has no resharing or per-file scoping that maps cleanly to those.
//
// shared_with_me=true  → return incoming shares (rows from
//                        NcShareMountResolverService.listMounts).
// shared_with_me=false → return outgoing shares (shares the user created).
//                        Returns [] for v1 — out of scope; the Sync-in v2
//                        web app is the canonical surface for managing
//                        outgoing shares.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOcsSharesController {
  constructor(
    private readonly response: NcResponseService,
    private readonly shareMounts: NcShareMountResolverService
  ) {}

  @Get('ocs/v1.php/apps/files_sharing/api/v1/shares')
  async listSharesV1(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('shared_with_me') sharedWithMeRaw?: string
  ): Promise<OcsEnvelope<NcOcsShareRecord[]>> {
    return this.listShares(req, res, sharedWithMeRaw, 1)
  }

  @Get('ocs/v2.php/apps/files_sharing/api/v1/shares')
  async listSharesV2(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('shared_with_me') sharedWithMeRaw?: string
  ): Promise<OcsEnvelope<NcOcsShareRecord[]>> {
    return this.listShares(req, res, sharedWithMeRaw, 2)
  }

  private async listShares(
    req: FastifyRequest & { user: UserModel },
    res: FastifyReply,
    sharedWithMeRaw: string | undefined,
    ocsVersion: 1 | 2
  ): Promise<OcsEnvelope<NcOcsShareRecord[]>> {
    this.response.requireJson(req)
    const sharedWithMe = sharedWithMeRaw === 'true'
    const data = sharedWithMe ? await this.buildIncomingShares(req.user) : []
    return this.response.json(res, data, ocsVersion === 1 ? { statuscode: OCS_OK_V1 } : {})
  }

  private async buildIncomingShares(user: UserModel): Promise<NcOcsShareRecord[]> {
    const mounts = await this.shareMounts.listMounts(user)
    const recipient = { login: user.login, fullName: user.fullName || user.login }
    return mounts.map((m) => buildSharedWithMeRecord(m, recipient))
  }
}
