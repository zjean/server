import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcActivityService } from '../services/nc-activity.service'
import { NcResponseService } from '../services/nc-response.service'
import type { OcsEnvelope } from '../utils/ocs-envelope'
import type { NcActivityEntry } from '../utils/nc-activity-entry'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// /ocs/v2.php/apps/activity/api/v2/activity — the OCS activity feed, plus its
// `/filter` variant for a single file.
//
// WHY THIS EXISTS, because it is not really about activity. NC Android's
// file-detail Activities tab fetches activities AND file versions in one task
// and then calls populateList only inside
// `if (result.isSuccess() && result.getData() != null)` on the ACTIVITIES
// result (FileDetailActivitiesFragment.java:347). So without a parseable
// response here, the version list served by the NC versions DAV tree (PR #325)
// never renders — the versions are fetched and silently dropped.
//
// The failure mode is subtler than "the call 404s", and the difference decides
// the fix. GetActivitiesRemoteOperation.isSuccess() deliberately accepts 200,
// 304 AND 404 — a deliberate accommodation for servers without the activity app
// — but it then parses the body unconditionally, and
// `jo.getAsJsonObject("ocs").getAsJsonArray("data")` throws
// NullPointerException for any body with no `ocs` key. Nest's own 404 JSON
// (`{"message":"Cannot GET …","statusCode":404}`) is exactly such a body, and
// RemoteOperation.execute does not catch it. So the requirement is an
// OCS-SHAPED body, not a 200 — and an empty `ocs.data` would already have been
// enough. We serve real events because a permanently blank Activities tab above
// the version list is a worse answer than a true one.
//
// DELIBERATELY NOT ADVERTISED IN CAPABILITIES. The `activity` capability key
// stays absent (see the comment at the end of constants/capabilities.ts).
// Android does not consult it — FileDetailActivitiesFragment always adds the tab
// and always makes this call — so serving the endpoint is sufficient there,
// while advertising it would additionally make NC iOS render an activity view
// and probe the endpoints behind it. Fixing Android without changing anything
// for iOS is the smaller, better-understood change.
//
// SCOPE. Personal-space files, like the rest of this module's fileId-keyed
// surface: NcActivityService resolves through the owner-scoped
// FilesQueries.getUserFile.
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcActivityController {
  constructor(
    private readonly activity: NcActivityService,
    private readonly response: NcResponseService
  ) {}

  // The whole-account feed. NC Android's ActivitiesFragment uses this; the
  // file-detail tab uses /filter below.
  @Get('ocs/v2.php/apps/activity/api/v2/activity')
  async activities(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('limit') rawLimit?: string
  ): Promise<OcsEnvelope<NcActivityEntry[]>> {
    this.response.requireJson(req)
    const entries = await this.activity.recent(req.user, this.response.baseUrl(req), clampLimit(rawLimit))
    return this.reply(res, entries)
  }

  // The per-file feed. Android sends `object_type=files&object_id=<fileId>` plus
  // `sort=desc`; upstream also accepts a `since` cursor, which we do not page on
  // (see reply() for why the paging header is omitted).
  //
  // An unparseable or unknown object_id yields an EMPTY FEED, not a 404 — the
  // entire point of this endpoint is that a non-OCS error body here breaks the
  // caller's list, and answering 404 for every file the log has not seen would
  // reintroduce exactly that.
  @Get('ocs/v2.php/apps/activity/api/v2/activity/filter')
  async filtered(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('object_type') objectType?: string,
    @Query('object_id') objectId?: string,
    @Query('limit') rawLimit?: string
  ): Promise<OcsEnvelope<NcActivityEntry[]>> {
    this.response.requireJson(req)
    const limit = clampLimit(rawLimit)
    const fileId = parsePositiveInt(objectId)
    // `files` is the only object type this fork records activity for. Anything
    // else (comments, shares, calendars in upstream) is an empty feed rather
    // than an error, for the same reason.
    if (fileId === null || (objectType && objectType !== 'files')) {
      return this.reply(res, [])
    }
    const entries = await this.activity.forFile(req.user, fileId, this.response.baseUrl(req), limit)
    return this.reply(res, entries)
  }

  // X-Activity-Last-Given is DELIBERATELY NOT SET.
  //
  // GetActivitiesRemoteOperation reads it into `lastGiven` and
  // `hasMoreActivities()` is `lastGiven > 0`, which drives infinite scroll: the
  // client keeps asking for the next page until the header is absent. Emitting
  // it without implementing `since` would make Android request the same page
  // forever. Omitting it means the client treats the first response as the whole
  // feed — capped at `limit`, which is the honest description of what we return.
  private reply(res: FastifyReply, entries: NcActivityEntry[]): OcsEnvelope<NcActivityEntry[]> {
    return this.response.json(res, entries, { totalitems: entries.length, itemsperpage: entries.length })
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
