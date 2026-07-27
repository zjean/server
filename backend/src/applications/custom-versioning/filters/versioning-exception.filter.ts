import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'

/**
 * Translates the files domain errors into HTTP responses for the versions API.
 *
 * WHY THIS EXISTS. `FileError` and `LockConflict` extend `Error`, not
 * `HttpException` — `FileError` merely *carries* an `httpCode` field. Nest maps
 * any non-HttpException to a 500, so without a translation every domain error
 * this API can raise arrived as an opaque 500:
 *
 *   - 403 'Permission denied'  (a read-only member trying to restore)
 *   - 404 'Version not found'  (an id belonging to another file)
 *   - 409 'This version is named, confirmation is required to delete it'
 *   - 409 size mismatch, 404 missing blob
 *   - LockConflict             (someone else is editing the file)
 *
 * The files feature has the equivalent translation inside
 * `files-methods.service.ts::handleError`, which is why nothing there is
 * affected. This controller had no such layer.
 *
 * A filter rather than a try/catch per handler: it applies uniformly, including
 * to endpoints added later, which is exactly the failure mode that produced
 * this bug. `webdav.filter.ts` is the precedent for writing the reply directly
 * instead of extending BaseExceptionFilter.
 *
 * The body shape matches Nest's own `{ statusCode, message }`, because the v2
 * UI reads `error.message` to show what the server said.
 */
@Catch(FileError, LockConflict)
export class VersioningExceptionsFilter implements ExceptionFilter {
  catch(exception: FileError | LockConflict, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<FastifyReply>()
    // 423 for a lock conflict, and the message without the lock's path — the
    // same wording and status `files-methods.service.ts` uses.
    const status = exception instanceof LockConflict ? HttpStatus.LOCKED : exception.httpCode
    const message = exception instanceof LockConflict ? 'The file is locked' : exception.message
    res.status(status).send({ statusCode: status, message })
  }
}
