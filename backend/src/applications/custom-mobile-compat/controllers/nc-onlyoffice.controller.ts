import { Controller, Get, HttpCode, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'

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
// the separate NcOnlyOfficeCallbackController in a later phase.
//
// Phase 1: route stubs return 501. Real implementations land in subsequent
// phases (see docs/plans/2026-04-29-nc-onlyoffice-connector.md).
@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcOnlyOfficeController {
  @Get('index.php/apps/onlyoffice/config')
  config(): never {
    throw new HttpException('not implemented', HttpStatus.NOT_IMPLEMENTED)
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
