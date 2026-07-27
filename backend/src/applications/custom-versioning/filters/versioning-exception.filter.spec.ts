import { ArgumentsHost, HttpStatus } from '@nestjs/common'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'
import { FileLock } from '../../files/interfaces/file-lock.interface'
import { VersioningExceptionsFilter } from './versioning-exception.filter'

describe(VersioningExceptionsFilter.name, () => {
  let filter: VersioningExceptionsFilter
  let sent: { status?: number; body?: any }
  let host: ArgumentsHost

  beforeEach(() => {
    filter = new VersioningExceptionsFilter()
    sent = {}
    const res = {
      status(code: number) {
        sent.status = code
        return this
      },
      send(body: any) {
        sent.body = body
        return this
      }
    }
    host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost
  })

  // The bug this filter exists for: FileError extends Error, not HttpException,
  // so Nest turned every one of these into a 500 — including the 403 that a
  // read-only member gets and the 409 the UI needs to prompt for a named delete.
  it.each([
    [HttpStatus.FORBIDDEN, 'Permission denied'],
    [HttpStatus.NOT_FOUND, 'Version not found'],
    [HttpStatus.CONFLICT, 'This version is named, confirmation is required to delete it']
  ])('maps a FileError to its own status (%i)', (code, message) => {
    filter.catch(new FileError(code, message), host)
    expect(sent.status).toBe(code)
    expect(sent.body).toEqual({ statusCode: code, message })
  })

  // 423 LOCKED and this exact wording are the repo's convention for a lock
  // conflict — see files-methods.service.ts::handleError.
  it('maps a LockConflict to 423 LOCKED without leaking the lock', () => {
    const lock = { key: 'flock|depth:0|path:secret-name.txt|ownerId:2', dbFilePath: 'secret-name.txt' } as unknown as FileLock

    filter.catch(new LockConflict(lock, 'Conflicting lock'), host)

    expect(sent.status).toBe(HttpStatus.LOCKED)
    expect(sent.body).toEqual({ statusCode: HttpStatus.LOCKED, message: 'The file is locked' })
    // The lock's key carries the file path; it must not reach the client.
    expect(JSON.stringify(sent.body)).not.toContain('secret-name.txt')
  })

  // The v2 UI reads `error.message`, so the envelope has to match what Nest
  // itself would have produced.
  it('sends the same body shape as a Nest HttpException', () => {
    filter.catch(new FileError(HttpStatus.NOT_FOUND, 'Version content not found'), host)
    expect(Object.keys(sent.body).sort()).toEqual(['message', 'statusCode'])
  })
})
