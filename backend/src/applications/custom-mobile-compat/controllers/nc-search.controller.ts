import { Controller, HttpException, HttpStatus, Req, Res, Search, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcSearchService } from '../services/nc-search.service'

// SEARCH /remote.php/dav  (and /remote.php/dav/)
//
// NextcloudKit's getRecommendedFiles → no, getRecent → searchBodyRequestAsync
// fires HTTP SEARCH at the DAV root. The scope (`/files/<userId>`) is
// inside the XML body, not the URL — see
// https://github.com/nextcloud/NextcloudKit  Sources/NextcloudKit/NextcloudKit+WebDAV.swift::searchBodyRequest
//
// Routing notes:
//   * Path is the DAV root (no `/files/<user>` segment), so this controller
//     can't share nc-dav.controller's `:user`-scoped routes.
//   * Both `remote.php/dav` and `remote.php/dav/` are observed in the wild
//     depending on whether NK's URL builder emitted a trailing slash.
//   * `@Search` is a stock @nestjs/common method decorator; Fastify supports
//     SEARCH out of the box (no addHttpMethod needed).
//
// `@AuthTokenSkip()` bypasses the global JWT guard — NC mobile clients send
// Basic Auth (app password), never a Sync-in JWT. Auth check happens in
// NcBasicAuthGuard.
@Controller()
@AuthTokenSkip()
export class NcSearchController {
  constructor(private readonly search: NcSearchService) {}

  @Search('remote.php/dav')
  @UseGuards(NcBasicAuthGuard)
  searchRoot(@Req() req: FastifyRequest & { user: UserModel; body?: unknown }, @Res() res: FastifyReply): Promise<FastifyReply> {
    return this.dispatch(req, res)
  }

  @Search('remote.php/dav/')
  @UseGuards(NcBasicAuthGuard)
  searchRootSlash(@Req() req: FastifyRequest & { user: UserModel; body?: unknown }, @Res() res: FastifyReply): Promise<FastifyReply> {
    return this.dispatch(req, res)
  }

  private dispatch(req: FastifyRequest & { user: UserModel; body?: unknown }, res: FastifyReply): Promise<FastifyReply> {
    if (!req.user) {
      // Defense in depth — NcBasicAuthGuard should have populated this.
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED)
    }
    // Body arrives as a string when the XML body parser registered in
    // bootstrapWebDAV handled it; or as Buffer/raw if a different content-type
    // sneaks in. The service's parseSearchBody accepts both forms.
    const body = req.body as string | Buffer | null | undefined
    return this.search.respond(req.user, body, res)
  }
}
