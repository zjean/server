import { Controller, Get, HttpException, HttpStatus, Param, ParseIntPipe, Res, StreamableFile, UseFilters } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { OnlyOfficeEnvironment } from '../files/editors/only-office/only-office-environment.decorator'
import { getMimeType } from '../files/utils/files'
import { GetSpace } from '../spaces/decorators/space.decorator'
import { SpaceEnv } from '../spaces/models/space-env.model'
import { GetUser } from '../users/decorators/user.decorator'
import { UserModel } from '../users/models/user.model'
import { VERSIONS_ROUTE } from './constants/routes'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersioningService } from './services/versioning.service'

// The ONE version endpoint the DOCUMENT SERVER calls, rather than the browser.
//
// WHY THIS IS A SEPARATE CONTROLLER, and must stay one.
//
// When the editor's history panel asks for a past revision, our answer contains
// a `url`, and the document server fetches that url ITSELF, server-to-server.
// There is no browser session on that request: no cookie, no CSRF header. So
// this route authenticates from a TOKEN_TYPE.ONLY_OFFICE JWT in the `token`
// query parameter — the mechanism upstream Sync-in already uses for the live
// document (`only-office.controller.ts:32-36`), reused here verbatim through
// `@OnlyOfficeEnvironment()`.
//
// That is a DIFFERENT auth model from VersioningController's, and Nest applies
// controller-level guards to every handler on the controller. Putting this route
// there would mean either two guard stacks on one controller — the shape that
// produces an accidentally-public endpoint when someone later adds a route and
// inherits the wrong one — or a chain in which the class-level SpaceGuard runs
// BEFORE OnlyOfficeGuard has established who the caller is, which cannot work at
// all. Same reasoning as VersionsAdminController being separate for its
// role-based authorization.
//
// `@OnlyOfficeEnvironment()` is a composite of three things, all needed:
//   - OnlyOfficeContext, the metadata that makes the global AuthTokenAccessGuard
//     stand down for this route (auth-token-access.guard.ts:20-22);
//   - UseGuards(OnlyOfficeGuard, SpaceGuard), in that order, so the token
//     establishes the user and the space is then resolved and authorized AS that
//     user;
//   - ContextInterceptor, which populates the request context.
//
// Authorization is therefore exactly as strong as the live-document route's,
// plus one more check: `getVersionStream` re-verifies through `requireVersionFor`
// that the version id belongs to the file the resolved space env points at. That
// is what makes taking a ROW ID in the path safe here, in a feature that
// otherwise refuses to accept row ids from the editor — a forged id resolves to
// another file's version and is rejected, rather than being served.
@Controller(VERSIONS_ROUTE.BASE)
@UseFilters(VersioningExceptionsFilter)
export class VersionsOfficeController {
  constructor(private readonly versioning: VersioningService) {}

  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.EDITOR_CONTENT}/:versionId/*`)
  @OnlyOfficeEnvironment()
  async editorContent(
    @GetUser() user: UserModel,
    @GetSpace() space: SpaceEnv,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<StreamableFile> {
    if (!this.versioning.enabled) {
      throw new HttpException(VERSIONS_DISABLED_MESSAGE, HttpStatus.NOT_FOUND)
    }
    // getVersionStream hands back an OPEN descriptor whose ownership travels
    // with the stream (ADR §9 / invariant 6). Nothing between here and the
    // return can throw, which is what keeps that safe — StreamableFile consumes
    // it. A check added ABOVE this call is fine; one added below would leak a
    // descriptor on every rejection.
    const { stream, version } = await this.versioning.getVersionStream(user, space, versionId)
    res.header('content-length', version.size)
    // No content-disposition. Unlike the browser download route, this response
    // is consumed by the document server as a document to render, not offered to
    // a human as a file to save.
    return new StreamableFile(stream, { type: getMimeType(space.realPath, false).replace('-', '/') })
  }
}
