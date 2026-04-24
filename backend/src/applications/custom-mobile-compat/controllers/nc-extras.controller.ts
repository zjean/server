import { Controller, Get, Header, HttpException, HttpStatus, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common'
import { createReadStream } from 'node:fs'
import { FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'

// NcExtrasController — odds and ends the stock Nextcloud iOS/Android clients
// hit outside of OCS/WebDAV: avatar display + file-preview thumbnails. Kept
// out of NcOcsController because these aren't OCS-enveloped responses.
@Controller()
@AuthTokenSkip()
export class NcExtrasController {
  constructor(private readonly usersManager: UsersManager) {}

  // Avatar binary. NC clients call this for every user they render (chat,
  // shares, activity). We only expose the authenticated user's own avatar —
  // cross-user avatar lookup would be information disclosure, and NC mobile
  // only needs its own anyway (it caches it post-login).
  //
  // :size is intentionally ignored — NC clients downscale client-side and
  // Sync-in only stores one avatar size. Accepted and discarded.
  @Get('index.php/avatar/:user/:size')
  @UseGuards(NcBasicAuthGuard)
  @Header('cache-control', 'private,max-age=86400')
  async avatar(
    @Param('user') user: string,
    @Param('size') _size: string,
    @Req() req: FastifyRequest & { user: UserModel }
  ): Promise<StreamableFile> {
    if (user !== req.user.login) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN)
    }
    let avatarPath: string
    let mime: string
    try {
      const result = await this.usersManager.getAvatar(req.user.login)
      if (!result || !result[0]) {
        throw new HttpException('avatar not found', HttpStatus.NOT_FOUND)
      }
      ;[avatarPath, mime] = result
    } catch (e) {
      if (e instanceof HttpException) throw e
      throw new HttpException('avatar not found', HttpStatus.NOT_FOUND)
    }
    return new StreamableFile(createReadStream(avatarPath), { type: mime })
  }

  // Preview thumbnails. Sync-in has no on-server preview pipeline (see
  // files-scheduler.service.ts line ~169 for a commented-out placeholder), so
  // we return 404. NC clients gracefully fall back to downloading the full
  // file for inline display, which is the correct behavior for a server that
  // doesn't advertise preview support in capabilities.
  @Get('index.php/core/preview')
  @UseGuards(NcBasicAuthGuard)
  preview(@Query('fileId') fileId: string, @Query('x') _x?: string, @Query('y') _y?: string): never {
    if (!fileId) {
      throw new HttpException('fileId is required', HttpStatus.BAD_REQUEST)
    }
    throw new HttpException({ message: 'previews not available' }, HttpStatus.NOT_FOUND)
  }
}
