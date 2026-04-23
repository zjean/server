import { All, Controller, HttpException, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'

// NcDavController — WebDAV, chunked uploads, trashbin, legacy redirect.
//
// Wave 2 of the execution plan — handlers are still stubs here so the module
// compiles against the constants + services wired in Wave 1. The real
// delegation into WebDAVMethods / FilesManager + chunked staging plumbing
// follows in separate commits.
@Controller()
@UseGuards(NcBasicAuthGuard)
export class NcDavController {
  // /remote.php/webdav/* — legacy clients. 301 to the modern dav files route.
  @All('remote.php/webdav')
  @All('remote.php/webdav/')
  @All('remote.php/webdav/*')
  legacyWebdav(@Req() req: FastifyRequest & { user: UserModel }, @Res({ passthrough: true }) res: FastifyReply): void {
    const rest = (req.url ?? '').replace(/^\/remote\.php\/webdav\/?/, '')
    const location = `/remote.php/dav/files/${encodeURIComponent(req.user.login)}/${rest}`
    res.status(HttpStatus.MOVED_PERMANENTLY).header('location', location)
    return
  }

  // /remote.php/dav/files/{user}/* — wave-2 real implementation.
  @All('remote.php/dav/files/:user')
  @All('remote.php/dav/files/:user/')
  @All('remote.php/dav/files/:user/*')
  notImplementedFiles(@Param('user') _user: string, @Req() _req: FastifyRequest, @Res({ passthrough: true }) _res: FastifyReply): never {
    throw new HttpException('WebDAV files not yet implemented (wave 2)', HttpStatus.NOT_IMPLEMENTED)
  }

  // /remote.php/dav/uploads/{user}/* — wave-2 real implementation.
  @All('remote.php/dav/uploads/:user/:uploadId')
  @All('remote.php/dav/uploads/:user/:uploadId/*')
  notImplementedUploads(@Req() _req: FastifyRequest): never {
    throw new HttpException('WebDAV chunked uploads not yet implemented (wave 2)', HttpStatus.NOT_IMPLEMENTED)
  }

  // /remote.php/dav/trashbin/{user}/* — wave-2 real implementation.
  @All('remote.php/dav/trashbin/:user')
  @All('remote.php/dav/trashbin/:user/')
  @All('remote.php/dav/trashbin/:user/*')
  notImplementedTrashbin(@Req() _req: FastifyRequest): never {
    throw new HttpException('WebDAV trashbin not yet implemented (wave 2)', HttpStatus.NOT_IMPLEMENTED)
  }
}
