import { Controller, Get, Header, HttpException, HttpStatus, Param, Req, Res, StreamableFile } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { existsSync, createReadStream } from 'node:fs'
import * as path from 'node:path'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { STATIC_ASSETS_PATH } from '../../../configuration/config.constants'
import { NcResponseService } from '../services/nc-response.service'

// NcThemingController — serves the small subset of /index.php/apps/theming/*
// endpoints stock NC iOS / Android probe to fetch the server's brand assets.
//
// What this changes for the user-visible UX in the NC client:
//   - Login screen logo + the "More" tab account header logo become the
//     Sync-in logo (was the bundled Nextcloud logo when these endpoints 404'd).
//   - Background image stays unset — clients fall back to `theming.color`
//     from /ocs/v{1,2}.php/cloud/capabilities, which we set to #0082c9.
//
// What this DOES NOT change: the iOS app's own navigation chrome title
// ("Nextcloud") is hardcoded in the client binary (`NCBrandColor.shared.brand`)
// and cannot be set server-side. Only a custom-branded build of the NC iOS
// client can change it.
//
// All routes are unauthenticated — real Nextcloud serves these to the login
// screen before the user has signed in, and our login flow page links them.
@Controller()
@AuthTokenSkip()
export class NcThemingController {
  constructor(private readonly response: NcResponseService) {}

  // The login screen logo + the avatar-strip brand logo. NC clients ignore
  // `theming.logo` from capabilities and instead hit this fixed path; we honor
  // it. Returns the raw frontend asset bytes (SVG); the client renders SVG
  // fine on iOS 13+ / Android 8+.
  @Get('index.php/apps/theming/image/logo')
  @Header('cache-control', 'public, max-age=86400')
  logo(@Res({ passthrough: true }) res: FastifyReply): StreamableFile {
    const filePath = this.resolveLogoPath()
    if (!existsSync(filePath)) {
      throw new HttpException('logo not found', HttpStatus.NOT_FOUND)
    }
    res.header('content-type', 'image/svg+xml')
    return new StreamableFile(createReadStream(filePath), { type: 'image/svg+xml' })
  }

  // Login-screen background. We don't ship a per-server background image;
  // returning 404 makes NC clients fall back to a solid color sourced from
  // capabilities.theming.color (#0082c9). This matches how unbranded NC
  // servers behave.
  @Get('index.php/apps/theming/image/background')
  background(): never {
    throw new HttpException('no themed background', HttpStatus.NOT_FOUND)
  }

  // Favicon — used by the NC client for tab icons in some embedded WebViews
  // and by the manifest below. `:app` is unused (real NC uses it to scope to
  // an app like "core" / "files"; we serve the same favicon regardless).
  @Get('index.php/apps/theming/favicon/:app')
  @Header('cache-control', 'public, max-age=86400')
  favicon(@Param('app') _app: string, @Res({ passthrough: true }) res: FastifyReply): StreamableFile {
    const filePath = this.resolveFaviconPath()
    if (!existsSync(filePath)) {
      throw new HttpException('favicon not found', HttpStatus.NOT_FOUND)
    }
    res.header('content-type', 'image/svg+xml')
    return new StreamableFile(createReadStream(filePath), { type: 'image/svg+xml' })
  }

  // Per-app icons. We don't theme app icons; 404 lets clients use their
  // bundled defaults — same posture as an NC server with the theming app
  // disabled.
  @Get('index.php/apps/theming/icon/:app/:image')
  icon(@Param('app') _app: string, @Param('image') _image: string): never {
    throw new HttpException('app icons not themed', HttpStatus.NOT_FOUND)
  }

  // PWA manifest. NC iOS doesn't read this directly, but the NC web client
  // and Android client do, and serving a sensible manifest keeps the brand
  // name consistent if the user opens the URL in a browser. Body shape
  // mirrors what stock NC ships.
  @Get('index.php/apps/theming/manifest/:theme')
  @Header('content-type', 'application/manifest+json')
  manifest(@Param('theme') _theme: string, @Req() req: FastifyRequest): NcThemingManifest {
    const baseUrl = this.response.baseUrl(req)
    return {
      name: 'Sync-in',
      short_name: 'Sync-in',
      start_url: '/',
      theme_color: '#0082c9',
      background_color: '#0082c9',
      display: 'standalone',
      icons: [
        {
          src: `${baseUrl}/index.php/apps/theming/favicon/core?v=1`,
          type: 'image/svg+xml',
          sizes: '128x128'
        }
      ]
    }
  }

  // Indirected so tests can stub the resolved file location without having
  // to run a real frontend build under jest.
  private resolveLogoPath(): string {
    return path.join(STATIC_ASSETS_PATH, 'logo.svg')
  }

  private resolveFaviconPath(): string {
    return path.join(STATIC_ASSETS_PATH, 'favicon.svg')
  }
}

export interface NcThemingManifest {
  name: string
  short_name: string
  start_url: string
  theme_color: string
  background_color: string
  display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser'
  icons: { src: string; type: string; sizes: string }[]
}
