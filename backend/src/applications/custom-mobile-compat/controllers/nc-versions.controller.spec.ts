// Mock the config singleton before UserModel / VersioningService import it.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '',
        usersPath: '',
        spacesPath: '',
        tmpPath: '',
        versions: { enabled: true, retentionDays: { users: false, spaces: false }, quotaShare: 0.5, minIntervalSeconds: 60 }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { HttpException, HttpStatus, StreamableFile } from '@nestjs/common'
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { Mock } from 'vitest'
import { VersioningExceptionsFilter } from '../../custom-versioning/filters/versioning-exception.filter'
import { VersioningService } from '../../custom-versioning/services/versioning.service'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcVersionsService } from '../services/nc-versions.service'
import { NcVersionsController } from './nc-versions.controller'

// Dispatch + status-code tests for the NC file-versions DAV tree. The wire
// format itself is covered in utils/nc-version-xml.spec.ts; what is asserted
// here is which handler runs, what it returns, and which of our domain errors
// reach the client intact.

const USER = { id: 7, login: 'alice' } as UserModel
const FILE_ID = 4242
const REVISION = 1_753_005_600
const VERSION_ROW_ID = 11

const SPACE = {
  realPath: '/data/users/alice/files/docs/report.txt',
  dbFile: { ownerId: 7, path: 'docs/report.txt', inTrash: false }
} as unknown as SpaceEnv

const ENTRY = {
  revision: REVISION,
  mtimeMs: REVISION * 1000,
  size: 1234,
  contentType: 'text/plain',
  label: null,
  author: 'alice'
}

interface FakeRes {
  res: FastifyReply
  status?: number
  contentType?: string
  headers: Record<string, string | number>
  body?: unknown
  sent: boolean
}

function makeRes(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as FastifyReply, headers: {}, sent: false }
  const res = {
    status: (code: number) => {
      state.status = code
      return res
    },
    type: (ct: string) => {
      state.contentType = ct
      return res
    },
    header: (k: string, v: string | number) => {
      state.headers[k] = v
      return res
    },
    send: (payload?: unknown) => {
      state.body = payload
      state.sent = true
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
}

function makeReq(method: string, extra: { headers?: Record<string, string>; body?: unknown; user?: UserModel } = {}) {
  return {
    method,
    headers: extra.headers ?? {},
    body: extra.body,
    user: 'user' in extra ? extra.user : USER
  } as unknown as FastifyRequest & { user?: UserModel }
}

const PROPPATCH_BODY =
  '<d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>ship it</nc:version-label></d:prop></d:set></d:propertyupdate>'

describe(NcVersionsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcVersionsController
  let ncVersions: {
    enabled: boolean
    resolveSpace: Mock
    listEntries: Mock
    requireVersionId: Mock
    findEntry: Mock
  }
  let versioning: { getVersionStream: Mock; restoreVersion: Mock; deleteVersion: Mock; setLabel: Mock }

  beforeEach(async () => {
    ncVersions = {
      enabled: true,
      resolveSpace: vi.fn().mockResolvedValue(SPACE),
      listEntries: vi.fn().mockResolvedValue([ENTRY]),
      requireVersionId: vi.fn().mockResolvedValue(VERSION_ROW_ID),
      findEntry: vi.fn().mockResolvedValue(ENTRY)
    }
    versioning = {
      getVersionStream: vi.fn().mockResolvedValue({ stream: Readable.from(['old bytes']), version: { id: VERSION_ROW_ID, size: 1234 } }),
      restoreVersion: vi.fn().mockResolvedValue(undefined),
      deleteVersion: vi.fn().mockResolvedValue(undefined),
      setLabel: vi.fn().mockResolvedValue(undefined)
    }

    moduleRef = await Test.createTestingModule({
      controllers: [NcVersionsController],
      providers: [
        { provide: NcVersionsService, useValue: ncVersions },
        { provide: VersioningService, useValue: versioning }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcVersionsController)
  })

  afterEach(async () => {
    await moduleRef?.close()
    vi.clearAllMocks()
  })

  const collection = (req: FastifyRequest & { user?: UserModel }, res: FakeRes, urlUser = 'alice', fileId = String(FILE_ID)) =>
    controller.collection(urlUser, fileId, req as never, res.res)

  const single = (
    req: FastifyRequest & { user?: UserModel },
    res: FakeRes,
    revision: string = String(REVISION),
    urlUser = 'alice',
    fileId = String(FILE_ID)
  ) => controller.version(urlUser, fileId, revision, req as never, res.res)

  /* ------------------------------------------------- the exception filter */

  // THE ASSERTION THAT WOULD HAVE CAUGHT PR #322. FileError and LockConflict
  // extend Error, not HttpException, so Nest maps them to 500 unless a filter
  // translates them. A new controller does not inherit the versions API's
  // filter — it has to declare it — and every domain error this tree can raise
  // (403 permission denied, 404 unknown revision, 409 size mismatch, 423 lock
  // conflict) arrives as an opaque 500 if this regresses.
  it('declares the versioning exception filter, without which every domain error is a 500', () => {
    const filters = new Reflector().get(EXCEPTION_FILTERS_METADATA, NcVersionsController)
    expect(filters).toContain(VersioningExceptionsFilter)
  })

  /* ------------------------------------------------------------- gating */

  // The flag check is FIRST, before the url-user and id checks, so a disabled
  // deployment leaks nothing about which ids exist.
  describe('while files.versions.enabled is false', () => {
    beforeEach(() => {
      ncVersions.enabled = false
    })

    it('404s the collection and never looks a file up', async () => {
      await expect(collection(makeReq('PROPFIND'), makeRes())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
      expect(ncVersions.resolveSpace).not.toHaveBeenCalled()
    })

    it('404s a version', async () => {
      await expect(single(makeReq('GET'), makeRes())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    })

    it('404s even for a request that would otherwise be forbidden', async () => {
      // Ordering, restated as behaviour: the flag answers before identity does.
      await expect(collection(makeReq('PROPFIND'), makeRes(), 'bob')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    })
  })

  // Upstream's RootCollection::getChildForPrincipal throws Forbidden when the
  // principal in the URL is not the session user.
  it('403s when the url user is not the authenticated user', async () => {
    await expect(collection(makeReq('PROPFIND'), makeRes(), 'bob')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
  })

  it('403s when the request carries no user at all', async () => {
    await expect(collection(makeReq('PROPFIND', { user: undefined }), makeRes())).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
  })

  it.each([['abc'], ['0'], ['-1'], ['1.5'], ['../4242']])('404s a non-positive-integer fileId (%s)', async (fileId) => {
    await expect(collection(makeReq('PROPFIND'), makeRes(), 'alice', fileId)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    expect(ncVersions.resolveSpace).not.toHaveBeenCalled()
  })

  it('404s a fileId the requester does not own', async () => {
    ncVersions.resolveSpace.mockResolvedValue(null)
    await expect(collection(makeReq('PROPFIND'), makeRes())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
  })

  it.each([['abc'], ['0'], ['-1']])('404s a malformed revision (%s)', async (revision) => {
    await expect(single(makeReq('GET'), makeRes(), revision)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
  })

  /* -------------------------------------------------------- the collection */

  describe('PROPFIND of a version collection', () => {
    it('answers 207 with the self entry and one entry per version', async () => {
      const res = makeRes()
      await collection(makeReq('PROPFIND'), res)

      expect(res.status).toBe(HttpStatus.MULTI_STATUS)
      expect(res.contentType).toContain('xml')
      const body = res.body as string
      // The self entry is mandatory: Android discards response[0].
      expect(body).toContain(`<d:href>/remote.php/dav/versions/alice/versions/${FILE_ID}/</d:href>`)
      expect(body).toContain(`<d:href>/remote.php/dav/versions/alice/versions/${FILE_ID}/${REVISION}</d:href>`)
    })

    it('answers 207 with only the self entry for a file with no history', async () => {
      ncVersions.listEntries.mockResolvedValue([])
      const res = makeRes()
      await collection(makeReq('PROPFIND'), res)

      expect(res.status).toBe(HttpStatus.MULTI_STATUS)
      expect((res.body as string).match(/<d:response>/g)).toHaveLength(1)
    })

    // Upstream's VersionCollection throws Forbidden for every mutation of the
    // collection itself; 405 is the closer HTTP answer and is what NK reports
    // without retrying.
    it.each([['GET'], ['PUT'], ['DELETE'], ['MKCOL'], ['MOVE'], ['POST']])('405s %s on the collection', async (method) => {
      await expect(collection(makeReq(method), makeRes())).rejects.toMatchObject({ status: HttpStatus.METHOD_NOT_ALLOWED })
    })
  })

  /* ------------------------------------------------------------- one version */

  it('PROPFIND of one version answers 207 with just that version', async () => {
    const res = makeRes()
    await single(makeReq('PROPFIND'), res)

    expect(res.status).toBe(HttpStatus.MULTI_STATUS)
    expect((res.body as string).match(/<d:response>/g)).toHaveLength(1)
  })

  it('PROPFIND 404s a revision that is not in the history', async () => {
    ncVersions.findEntry.mockResolvedValue(null)
    await expect(single(makeReq('PROPFIND'), makeRes())).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
  })

  describe('GET of a version', () => {
    it('streams the stored bytes with the source file’s name and the revision as ETag', async () => {
      const res = makeRes()
      const result = await single(makeReq('GET'), res)

      expect(result).toBeInstanceOf(StreamableFile)
      expect(ncVersions.requireVersionId).toHaveBeenCalledWith(USER, SPACE, REVISION)
      expect(versioning.getVersionStream).toHaveBeenCalledWith(USER, SPACE, VERSION_ROW_ID)
      expect(res.headers['content-length']).toBe(1234)
      expect(res.headers['etag']).toBe(String(REVISION))
      // Upstream's Plugin::afterGet names the download after the SOURCE file, so
      // a saved revision lands as report.txt rather than as 1753005600.
      expect(res.headers['content-disposition']).toContain('report.txt')
      expect(res.headers['content-disposition']).toContain("filename*=UTF-8''report.txt")
    })

    it('HEAD sends the headers with no body and does not leak the opened stream', async () => {
      const stream = Readable.from(['old bytes'])
      const destroy = vi.spyOn(stream, 'destroy')
      versioning.getVersionStream.mockResolvedValue({ stream, version: { id: VERSION_ROW_ID, size: 1234 } })

      const res = makeRes()
      const result = await single(makeReq('HEAD'), res)

      expect(result).not.toBeInstanceOf(StreamableFile)
      expect(res.status).toBe(HttpStatus.OK)
      expect(res.headers['content-length']).toBe(1234)
      expect(destroy).toHaveBeenCalled()
    })
  })

  describe('MOVE-into-restore', () => {
    const dest = (value: string) => makeReq('MOVE', { headers: { destination: value } })

    // RestoreFileVersionRemoteOperation accepts 201 or 204; a restore always
    // replaces existing content, which is 204 in MOVE semantics.
    it('restores and answers 204', async () => {
      const res = makeRes()
      await single(dest(`https://cloud.example.test/remote.php/dav/versions/alice/restore/${FILE_ID}`), res)

      expect(versioning.restoreVersion).toHaveBeenCalledWith(USER, SPACE, VERSION_ROW_ID)
      expect(res.status).toBe(HttpStatus.NO_CONTENT)
    })

    it('accepts a path-relative Destination', async () => {
      const res = makeRes()
      await single(dest(`/remote.php/dav/versions/alice/restore/${FILE_ID}`), res)
      expect(res.status).toBe(HttpStatus.NO_CONTENT)
    })

    it('400s a MOVE with no Destination header', async () => {
      await expect(single(makeReq('MOVE'), makeRes())).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      expect(versioning.restoreVersion).not.toHaveBeenCalled()
    })

    // A MOVE anywhere else is not a restore. Silently restoring would turn a
    // client bug into a content overwrite.
    it.each([
      ['the files tree', '/remote.php/dav/files/alice/report.txt'],
      ['another version', '/remote.php/dav/versions/alice/versions/4242/1753005000'],
      ["another user's restore folder", '/remote.php/dav/versions/bob/restore/4242']
    ])('400s a MOVE targeting %s', async (_label, destination) => {
      await expect(single(dest(destination), makeRes())).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      expect(versioning.restoreVersion).not.toHaveBeenCalled()
    })
  })

  describe('DELETE of a version', () => {
    it('deletes and answers 204', async () => {
      const res = makeRes()
      await single(makeReq('DELETE'), res)
      expect(res.status).toBe(HttpStatus.NO_CONTENT)
    })

    // Our REST API demands an explicit confirmLabeled flag before deleting a
    // NAMED version. NC's protocol has no way to send one, and a 409 the client
    // cannot resolve reads as "deleting versions is broken" — so the DELETE of
    // one specific revision IS the deliberate act.
    it('passes confirmLabeled so a named version is deletable over a protocol with no flag', async () => {
      await single(makeReq('DELETE'), makeRes())
      expect(versioning.deleteVersion).toHaveBeenCalledWith(USER, SPACE, VERSION_ROW_ID, true)
    })
  })

  describe('PROPPATCH of nc:version-label', () => {
    it('sets the label and answers 207', async () => {
      const res = makeRes()
      await single(makeReq('PROPPATCH', { body: PROPPATCH_BODY }), res)

      expect(versioning.setLabel).toHaveBeenCalledWith(USER, SPACE, VERSION_ROW_ID, 'ship it')
      expect(res.status).toBe(HttpStatus.MULTI_STATUS)
      expect(res.body as string).toContain(`/remote.php/dav/versions/alice/versions/${FILE_ID}/${REVISION}`)
    })

    it('400s a PROPPATCH that is not about the version label', async () => {
      const body = '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>x</d:getlastmodified></d:prop></d:set></d:propertyupdate>'
      await expect(single(makeReq('PROPPATCH', { body }), makeRes())).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      expect(versioning.setLabel).not.toHaveBeenCalled()
    })
  })

  it.each([['LOCK'], ['MKCOL'], ['POST'], ['PUT'], ['REPORT']])('405s %s on a version', async (method) => {
    await expect(single(makeReq(method), makeRes())).rejects.toMatchObject({ status: HttpStatus.METHOD_NOT_ALLOWED })
  })

  /* --------------------------------------------------- domain-error passthrough */

  // These must arrive at the filter AS THEMSELVES. A controller that caught and
  // rewrapped them would flatten 403/409/423 into whatever it chose, and the
  // filter — the thing that makes those statuses correct — would never run.
  describe('domain errors reach the filter intact', () => {
    it('propagates a permission denial from restore rather than rewrapping it', async () => {
      versioning.restoreVersion.mockRejectedValue(new FileError(HttpStatus.FORBIDDEN, 'Permission denied'))
      const req = makeReq('MOVE', { headers: { destination: `/remote.php/dav/versions/alice/restore/${FILE_ID}` } })

      await expect(single(req, makeRes())).rejects.toBeInstanceOf(FileError)
      await expect(single(req, makeRes())).rejects.toMatchObject({ httpCode: HttpStatus.FORBIDDEN })
    })

    it('propagates a permission denial from delete and label', async () => {
      versioning.deleteVersion.mockRejectedValue(new FileError(HttpStatus.FORBIDDEN, 'Permission denied'))
      versioning.setLabel.mockRejectedValue(new FileError(HttpStatus.FORBIDDEN, 'Permission denied'))

      await expect(single(makeReq('DELETE'), makeRes())).rejects.toBeInstanceOf(FileError)
      await expect(single(makeReq('PROPPATCH', { body: PROPPATCH_BODY }), makeRes())).rejects.toBeInstanceOf(FileError)
    })

    it('propagates a lock conflict from restore', async () => {
      versioning.restoreVersion.mockRejectedValue(new LockConflict({ key: 'lock-1' } as never, 'Conflicting lock'))
      const req = makeReq('MOVE', { headers: { destination: `/remote.php/dav/versions/alice/restore/${FILE_ID}` } })

      await expect(single(req, makeRes())).rejects.toBeInstanceOf(LockConflict)
    })

    it('propagates a missing blob from download', async () => {
      versioning.getVersionStream.mockRejectedValue(new FileError(HttpStatus.NOT_FOUND, 'Version content not found'))
      await expect(single(makeReq('GET'), makeRes())).rejects.toBeInstanceOf(FileError)
    })

    it('propagates the 404 the revision mapping raises for an unknown revision', async () => {
      ncVersions.requireVersionId.mockRejectedValue(new FileError(HttpStatus.NOT_FOUND, 'Version not found'))
      await expect(single(makeReq('GET'), makeRes())).rejects.toBeInstanceOf(FileError)
    })

    it('still uses HttpException for its own protocol-level refusals', async () => {
      // The filter only catches FileError / LockConflict, so the controller's own
      // 403/404/405/400 must be HttpExceptions or Nest would 500 them.
      await expect(collection(makeReq('PROPFIND'), makeRes(), 'bob')).rejects.toBeInstanceOf(HttpException)
    })
  })
})
