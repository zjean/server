import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesRecents } from '../../files/services/files-recents.service'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcResponseService } from '../services/nc-response.service'
import type { OcsEnvelope } from '../utils/ocs-envelope'
import { type NcRecommendationEntry, toRecommendationEntry } from '../utils/nc-recommendation-entry'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

// /ocs/v2.php/apps/files/api/v1/recommendations powers the "Recommended files"
// carousel at the top of NC iOS's Files tab. Upstream NC implements this as
// part of the `files` app (RecommendedFilesController). Here we project the
// existing Sync-in `files_recents` rolling window onto NC's response shape.
//
// @AuthTokenSkip bypasses the global JWT guard — NC mobile clients
// authenticate via Basic Auth (app password) on every request, never with a
// Sync-in JWT. NcBasicAuthGuard handles the credential check.
@Controller()
@AuthTokenSkip()
export class NcRecommendationsController {
  constructor(
    private readonly response: NcResponseService,
    private readonly filesRecents: FilesRecents,
    private readonly pathResolver: NcPathResolverService
  ) {}

  @Get('ocs/v2.php/apps/files/api/v1/recommendations')
  @UseGuards(NcBasicAuthGuard)
  async recommendations(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('limit') rawLimit?: string
  ): Promise<OcsEnvelope<{ entries: NcRecommendationEntry[] }>> {
    this.response.requireJson(req)
    const limit = clampLimit(rawLimit)

    // Recents are stored across personal + spaces + shares. NC iOS only sees
    // the user's resolved home (default: personal space). Recommendations
    // outside that scope would 404 on tap, so we filter by home prefix.
    const homePrefix = this.pathResolver.toInternalPath(this.pathResolver.resolve(req.user, { mode: 'files', subpath: '' }))
    const recents = await this.filesRecents.getRecents(req.user, limit)
    const entries = recents.map((rec) => toRecommendationEntry(rec, homePrefix)).filter((entry): entry is NcRecommendationEntry => entry !== null)

    return this.response.json(res, { entries })
  }
}

// `limit` arrives as a string from the query parser. Default to 10, clamp to
// 50. Non-numeric, non-positive, or NaN values fall back to the default — NC
// iOS sometimes passes nothing, sometimes 10, sometimes 25.
function clampLimit(raw: string | undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}
