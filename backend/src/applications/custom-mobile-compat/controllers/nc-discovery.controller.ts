import { All, Controller, Get, HttpCode, HttpStatus, Req, Res } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { NC_AUTH_REALM } from '../constants/routes'

// Public unauthenticated probes issued by NC mobile clients before / during
// server selection. Keep these lightweight and stable.
@Controller()
export class NcDiscoveryController {
  // status.php — server identity. iOS/Android gate connection on this
  // returning a sensible productname + version.
  @Get('status.php')
  status(): NcStatus {
    return {
      installed: true,
      maintenance: false,
      needsDbUpgrade: false,
      version: '29.0.0.10',
      versionstring: '29.0.0-sync-in',
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

  // /remote.php/dav probe. The NC client POSTs or PROPFINDs this before
  // committing to a server. We return 401 with WWW-Authenticate so the client
  // knows this host speaks NC DAV, then drives the login flow separately.
  @All('remote.php/dav')
  @All('remote.php/dav/')
  davProbe(@Req() _req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply): void {
    res.header('WWW-Authenticate', `Basic realm="${NC_AUTH_REALM}"`)
    res.header('DAV', '1, 2, 3')
    res.status(HttpStatus.UNAUTHORIZED)
    return
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
