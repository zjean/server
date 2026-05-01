import { HttpException, HttpStatus, StreamableFile } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import * as fs from 'node:fs'
import { Readable } from 'node:stream'
import { FilesManager } from '../../files/services/files-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcExtrasController } from './nc-extras.controller'

describe(NcExtrasController.name, () => {
  let moduleRef: TestingModule
  let controller: NcExtrasController
  let getAvatar: jest.Mock
  let generateThumbnail: jest.Mock
  let spaceEnv: jest.Mock
  let getUserFile: jest.Mock

  beforeAll(async () => {
    getAvatar = jest.fn()
    generateThumbnail = jest.fn()
    spaceEnv = jest.fn()
    getUserFile = jest.fn()
    moduleRef = await Test.createTestingModule({
      controllers: [NcExtrasController],
      providers: [
        { provide: UsersManager, useValue: { getAvatar } },
        { provide: FilesManager, useValue: { generateThumbnail } },
        { provide: SpacesManager, useValue: { spaceEnv } },
        { provide: FilesQueries, useValue: { getUserFile } },
        NcPathResolverService
      ]
    })
      // Guard replaced with a no-op — route-level @UseGuards is authoritative
      // on the real app; here we drive `req.user` manually below.
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    controller = moduleRef.get(NcExtrasController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    getAvatar.mockReset()
    generateThumbnail.mockReset()
    spaceEnv.mockReset()
    getUserFile.mockReset()
  })

  function fakeRes(): FastifyReply {
    return {
      header: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis()
    } as unknown as FastifyReply
  }
  function fakePreviewReq(login = 'alice'): FastifyRequest & { user: UserModel } {
    return { user: { id: 7, login } as UserModel } as FastifyRequest & { user: UserModel }
  }

  describe('avatar', () => {
    function fakeReq(login: string): FastifyRequest & { user: UserModel } {
      return { user: { login } as UserModel } as FastifyRequest & { user: UserModel }
    }

    it('forbids access when :user param does not match authenticated user', async () => {
      const req = fakeReq('alice')
      await expect(controller.avatar('bob', '128', req)).rejects.toMatchObject({
        message: 'forbidden',
        status: HttpStatus.FORBIDDEN
      })
      expect(getAvatar).not.toHaveBeenCalled()
    })

    it('returns a StreamableFile when avatar exists', async () => {
      // Use __filename as a convenient readable path — we never read from it
      // in the test, but StreamableFile's createReadStream must resolve.
      getAvatar.mockResolvedValueOnce([__filename, 'image/png'])
      const req = fakeReq('alice')
      const result = await controller.avatar('alice', '128', req)
      expect(getAvatar).toHaveBeenCalledWith('alice')
      expect(result).toBeInstanceOf(StreamableFile)
      // Guard against leaking file descriptors.
      const stream = result.getStream() as fs.ReadStream
      stream.destroy()
    })

    it('returns 404 when UsersManager.getAvatar reports missing', async () => {
      getAvatar.mockResolvedValueOnce(null)
      const req = fakeReq('alice')
      await expect(controller.avatar('alice', '128', req)).rejects.toMatchObject({
        message: 'avatar not found',
        status: HttpStatus.NOT_FOUND
      })
    })

    it('returns 404 when UsersManager.getAvatar throws', async () => {
      getAvatar.mockRejectedValueOnce(new Error('disk gone'))
      const req = fakeReq('alice')
      await expect(controller.avatar('alice', '128', req)).rejects.toBeInstanceOf(HttpException)
    })
  })

  describe('preview', () => {
    it('rejects both ?file and ?fileId missing with 400', async () => {
      const req = fakePreviewReq()
      const res = fakeRes()
      await expect(controller.preview(req, res)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST
      })
    })

    it('resolves ?fileId via FilesQueries and streams a thumbnail', async () => {
      getUserFile.mockResolvedValueOnce({ id: 42, path: 'photos/a.png' })
      const fakeSpace = { realPath: '/tmp/img.png' }
      spaceEnv.mockResolvedValueOnce(fakeSpace)
      generateThumbnail.mockResolvedValueOnce(Readable.from([Buffer.from('jpegdata')]))

      const req = fakePreviewReq()
      const res = fakeRes()
      const result = await controller.preview(req, res, undefined, '42', '128', '128')

      expect(getUserFile).toHaveBeenCalledWith(7, 42)
      expect(spaceEnv).toHaveBeenCalledWith(req.user, ['files', 'personal', 'photos', 'a.png'])
      expect(generateThumbnail).toHaveBeenCalledWith(fakeSpace, 128)
      expect(result).toBeInstanceOf(StreamableFile)
    })

    it('returns 404 when ?fileId is not owned by the user', async () => {
      getUserFile.mockResolvedValueOnce(null)
      const req = fakePreviewReq()
      const res = fakeRes()
      await expect(controller.preview(req, res, undefined, '999')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND
      })
      expect(generateThumbnail).not.toHaveBeenCalled()
    })

    it('returns 404 when ?fileId is not a positive integer', async () => {
      const req = fakePreviewReq()
      const res = fakeRes()
      await expect(controller.preview(req, res, undefined, 'abc')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND
      })
      await expect(controller.preview(req, res, undefined, '-5')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND
      })
      expect(getUserFile).not.toHaveBeenCalled()
    })

    it('streams a thumbnail for a resolvable image path', async () => {
      const fakeSpace = { realPath: '/tmp/img.png' }
      spaceEnv.mockResolvedValueOnce(fakeSpace)
      const stream = Readable.from([Buffer.from('webpdata')])
      generateThumbnail.mockResolvedValueOnce(stream)

      const req = fakePreviewReq()
      const res = fakeRes()
      const result = await controller.preview(req, res, 'photos/a.png', undefined, '128', '128')

      expect(spaceEnv).toHaveBeenCalledTimes(1)
      expect(generateThumbnail).toHaveBeenCalledWith(fakeSpace, 128)
      expect(result).toBeInstanceOf(StreamableFile)
      // Content-Type must match the actual bytes — generateThumbnail emits
      // WebP via sharp, so labeling as image/jpeg breaks NC clients that
      // dispatch decoders by MIME type (was the "black square" bug).
      expect(res.header).toHaveBeenCalledWith('content-type', 'image/webp')
    })

    it('registers both /preview and /preview.png so all NC client variants resolve', () => {
      // @Get(...) is stacked on the same handler. Nest stores each declared
      // path in the method's metadata; verify both ended up there.
      const paths: unknown = Reflect.getMetadata('path', NcExtrasController.prototype.preview)
      const list = Array.isArray(paths) ? paths : [paths]
      expect(list).toEqual(expect.arrayContaining(['index.php/core/preview', 'index.php/core/preview.png']))
    })

    it('maps "not an image" into a 404 for the client', async () => {
      const fakeSpace = { realPath: '/tmp/doc.pdf' }
      spaceEnv.mockResolvedValueOnce(fakeSpace)
      generateThumbnail.mockRejectedValueOnce(Object.assign(new Error('File is not an image'), { status: HttpStatus.BAD_REQUEST }))

      const req = fakePreviewReq()
      const res = fakeRes()
      await expect(controller.preview(req, res, 'doc.pdf')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND
      })
    })

    it('maps FileError (httpCode-shaped) "not an image" into a 404 too', async () => {
      // FilesManager throws FileError, which exposes its code as `httpCode`,
      // not `status`. Production logs surfaced exactly this gap: a real
      // file-decode failure was rendered as a 500 because the catch only
      // looked at err.status. This test locks both names in.
      const fakeSpace = { realPath: '/tmp/elegoo/2.jpg' }
      spaceEnv.mockResolvedValueOnce(fakeSpace)
      generateThumbnail.mockRejectedValueOnce(Object.assign(new Error('File is not an image'), { httpCode: HttpStatus.BAD_REQUEST }))

      const req = fakePreviewReq()
      const res = fakeRes()
      await expect(controller.preview(req, res, '2.jpg')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND
      })
    })

    it('clamps out-of-range dimensions', async () => {
      const fakeSpace = { realPath: '/tmp/a.jpg' }
      spaceEnv.mockResolvedValue(fakeSpace)
      generateThumbnail.mockResolvedValue(Readable.from([Buffer.from('x')]))

      const req = fakePreviewReq()
      const res = fakeRes()
      // Way too big → clamped to 1024
      await controller.preview(req, res, 'a.jpg', undefined, '9999', '9999')
      expect(generateThumbnail).toHaveBeenLastCalledWith(fakeSpace, 1024)
      // Too small → floored to 32
      generateThumbnail.mockClear()
      await controller.preview(req, res, 'a.jpg', undefined, '5', '5')
      expect(generateThumbnail).toHaveBeenLastCalledWith(fakeSpace, 32)
    })

    it('strips /remote.php/dav/files/{user}/ and /files/{user}/ prefixes from the path', async () => {
      const fakeSpace = { realPath: '/tmp/b.jpg' }
      spaceEnv.mockResolvedValue(fakeSpace)
      generateThumbnail.mockResolvedValue(Readable.from([Buffer.from('x')]))

      const req = fakePreviewReq('alice')
      const res = fakeRes()
      await controller.preview(req, res, '/remote.php/dav/files/alice/photos/b.jpg')
      const call1 = spaceEnv.mock.calls.at(-1)
      expect(call1?.[1]).toEqual(['files', 'personal', 'photos', 'b.jpg'])

      spaceEnv.mockClear()
      await controller.preview(req, res, '/files/alice/photos/b.jpg')
      const call2 = spaceEnv.mock.calls.at(-1)
      expect(call2?.[1]).toEqual(['files', 'personal', 'photos', 'b.jpg'])
    })
  })
})
