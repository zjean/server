import { All, Controller, ExecutionContext, Get, Header, HttpCode, HttpException, HttpStatus, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UserModel } from '../../users/models/user.model'
import { NC_AUTH_REALM } from '../constants/routes'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcSearchService } from '../services/nc-search.service'

// Public unauthenticated probes issued by NC mobile clients before / during
// server selection. Keep these lightweight and stable.
@Controller()
@AuthTokenSkip()
export class NcDiscoveryController {
  constructor(
    private readonly basicAuth: NcBasicAuthGuard,
    private readonly search: NcSearchService
  ) {}

  // status.php — server identity. iOS/Android gate connection on this
  // returning a sensible productname + version. Real NC server emits
  // `Access-Control-Allow-Origin: *` here for pre-login probe paths;
  // mirror it.
  @Get('status.php')
  @Header('Access-Control-Allow-Origin', '*')
  status(): NcStatus {
    return {
      installed: true,
      maintenance: false,
      needsDbUpgrade: false,
      // Advertise as NC 33.x so modern mobile clients (iOS 33.x) accept us as
      // a current peer. Major matters most; the patch (.0) is informational.
      version: '33.0.0.0',
      versionstring: '33.0.0-sync-in',
      edition: '',
      productname: 'Sync-in',
      extendedSupport: false
    }
  }

  // Cheap connectivity canary.
  @Get('index.php/204')
  @HttpCode(HttpStatus.NO_CONTENT)
  connectivity(): void {
    return
  }

  // /remote.php/dav root.
  //
  // Two concerns share this path, dispatched by HTTP method:
  //
  //   * SEARCH — NextcloudKit's getRecent fires HTTP SEARCH at the DAV root
  //     with the scope (`/files/<userId>`) inside the XML body. See
  //     https://github.com/nextcloud/NextcloudKit
  //     Sources/NextcloudKit/NextcloudKit+WebDAV.swift::searchBodyRequest.
  //     Requires Basic Auth.
  //   * Anything else (POST, PROPFIND, …) — the unauth probe NC clients
  //     issue before committing to a server. We return 401 + WWW-Authenticate
  //     so the client knows this host speaks NC DAV, then drives the login
  //     flow separately.
  //
  // Why a single `@All` handler instead of a sibling `@Search` controller:
  // NestJS' `@All` expands to every HTTP method `@nestjs/platform-fastify`
  // exposes — including SEARCH — so a separate `@Search('remote.php/dav')`
  // controller collides with this one and Fastify throws
  // FST_ERR_DUPLICATED_ROUTE at boot. Internal req.method dispatch matches
  // the convention already in nc-comments / nc-dav controllers.
  @All('remote.php/dav')
  @All('remote.php/dav/')
  async davRoot(@Req() req: FastifyRequest & { user?: UserModel; body?: unknown }, @Res() res: FastifyReply): Promise<FastifyReply | void> {
    res.header('WWW-Authenticate', `Basic realm="${NC_AUTH_REALM}"`)
    res.header('DAV', '1, 2, 3')

    if (req.method === 'SEARCH') {
      // Inline-invoke NcBasicAuthGuard rather than `@UseGuards(...)` so the
      // probe path stays unauth (no DB hit on every cold connectivity check).
      // The guard reads req via switchToHttp().getRequest() and writes the
      // 401 + WWW-Authenticate header itself on failure, so a thrown
      // HttpException already carries the right shape — we just re-raise.
      const ctx = makeHttpExecutionContext(req, res)
      try {
        await this.basicAuth.canActivate(ctx)
      } catch (err) {
        if (err instanceof HttpException) throw err
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED)
      }
      if (!req.user) {
        // Defense in depth — NcBasicAuthGuard should have populated this.
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED)
      }
      // Body arrives as a string when the XML body parser registered in
      // bootstrapWebDAV handled it; or as Buffer/raw if a different
      // content-type sneaks in. NcSearchService.parseSearchBody accepts both.
      const body = req.body as string | Buffer | null | undefined
      return this.search.respond(req.user, body, res)
    }

    return res.status(HttpStatus.UNAUTHORIZED).send()
  }
}

interface NcStatus {
  installed: boolean
  maintenance: boolean
  needsDbUpgrade: boolean
  version: string
  versionstring: string
  edition: string
  productname: string
  extendedSupport: boolean
}

// Minimal ExecutionContext shim. NcBasicAuthGuard only consumes
// `switchToHttp().getRequest()` / `getResponse()`; the other ArgumentsHost
// surface goes unused, so we cast and stub instead of pulling in a heavier
// helper.
function makeHttpExecutionContext(req: FastifyRequest, res: FastifyReply): ExecutionContext {
  const http = {
    getRequest: () => req,
    getResponse: () => res,
    getNext: () => undefined as never
  }
  return {
    switchToHttp: () => http,
    switchToRpc: () => {
      throw new Error('not RPC')
    },
    switchToWs: () => {
      throw new Error('not WS')
    },
    getArgs: () => [req, res] as never,
    getArgByIndex: (i: number) => [req, res][i] as never,
    getType: () => 'http',
    getClass: () => NcDiscoveryController as never,
    getHandler: () => NcDiscoveryController.prototype.davRoot as never
  } as unknown as ExecutionContext
}
