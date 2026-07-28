import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { FilesRecents } from '../../files/services/files-recents.service'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { type NcRecommendationEntry, toRecommendationEntry } from '../utils/nc-recommendation-entry'
import { createNcXmlBuilder } from '../utils/nc-xml'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

// The OCS recommendations body is not a multistatus, but it needs the same
// builder options as every other emitter in this module — so it takes them from
// the shared util rather than declaring an eighth copy. The reasoning behind the
// `ignoreAttributes: false` flag now lives on NC_XML_BUILDER_OPTIONS in
// nc-xml.ts, with the test that guards it in nc-xml.spec.ts.
//
// Worth recording why the flag matters HERE specifically, since this body has no
// attributes today and upstream's has none either: NC core renders OCS XML in
// `lib/private/AppFramework/OCS/BaseResponse.php::toXML`, which calls
// `writeAttribute` only for keys named `@attributes` or prefixed `@`, and
// `OCA\Recommendations\Controller\RecommendationController::index` returns a
// plain `['enabled' => bool, 'recommendations' => [...]]` array with no such
// keys — so `<ocs>` has no xmlns. NextcloudKit's XMLToRecommendationParser
// navigates by local element name (`xml["ocs", "data", ...]`) and never reads an
// attribute. The flag is therefore byte-for-byte irrelevant to today's output;
// it just stops the next attribute anyone adds from silently becoming a
// malformed `<@_xmlns:d>` ELEMENT.

// /ocs/v2.php/apps/recommendations/api/v1/recommendations powers the
// "Recommended files" carousel at the top of NC iOS's Files tab. Upstream
// implements this in the standalone `recommendations` app (NOT the `files`
// app — see https://github.com/nextcloud/recommendations).
//
// Wire format is XML, not JSON: NextcloudKit's getRecommendedFiles sets
// `Accept: application/xml` and parses with SwiftyXMLParser at path
// `ocs → data → recommendations → element`. Returning JSON here silently
// produces an empty carousel because the XML parser sees no <element> nodes.
//
// @AuthTokenSkip bypasses the global JWT guard — NC mobile clients
// authenticate via Basic Auth (app password) on every request, never with a
// Sync-in JWT. NcBasicAuthGuard handles the credential check.
@Controller()
@AuthTokenSkip()
export class NcRecommendationsController {
  // Bare XMLBuilder. We hand the prolog to fastify and then concatenate the
  // <ocs>…</ocs> body produced from a plain JS object.
  private readonly xml = createNcXmlBuilder()

  constructor(
    private readonly filesRecents: FilesRecents,
    private readonly pathResolver: NcPathResolverService
  ) {}

  @Get('ocs/v2.php/apps/recommendations/api/v1/recommendations')
  @UseGuards(NcBasicAuthGuard)
  async recommendations(
    @Req() req: FastifyRequest & { user: UserModel },
    @Res() res: FastifyReply,
    @Query('limit') rawLimit?: string
  ): Promise<FastifyReply> {
    const limit = clampLimit(rawLimit)

    // Recents are stored across personal + spaces + shares. NC iOS only sees
    // the user's resolved home (default: personal space). Recommendations
    // outside that scope would 404 on tap, so we filter by home prefix.
    const homePrefix = this.pathResolver.toInternalPath(this.pathResolver.resolve(req.user, { mode: 'files', subpath: '' }))
    const recents = await this.filesRecents.getRecents(req.user, limit)
    const entries = recents.map((rec) => toRecommendationEntry(rec, homePrefix)).filter((entry): entry is NcRecommendationEntry => entry !== null)

    return res.header('Content-Type', 'application/xml; charset=utf-8').send(this.renderXml(entries))
  }

  // Build the OCS-shaped XML response NextcloudKit expects:
  //
  //   <?xml version="1.0"?>
  //   <ocs>
  //     <meta><status>ok</status><statuscode>200</statuscode><message>OK</message></meta>
  //     <data>
  //       <enabled>1</enabled>
  //       <recommendations>
  //         <element>… one per file …</element>
  //       </recommendations>
  //     </data>
  //   </ocs>
  //
  // `enabled` mirrors what upstream's RecommendationController->index emits.
  // We always advertise enabled=1: there's no per-user toggle in this fork
  // and the carousel-visibility decision is made server-side by returning
  // an empty <recommendations/> when there's nothing to show.
  private renderXml(entries: NcRecommendationEntry[]): string {
    const body = this.xml.build({
      ocs: {
        meta: { status: 'ok', statuscode: 200, message: 'OK' },
        data: {
          enabled: '1',
          // Array under `element` becomes repeated <element> children, which
          // is the OCS XML array convention NK navigates with
          // `recommendations → element`.
          recommendations: { element: entries }
        }
      }
    })
    return `<?xml version="1.0"?>\n${body}`
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
