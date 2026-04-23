import { HttpException, HttpStatus, StreamableFile } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyRequest } from 'fastify'
import * as fs from 'node:fs'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcExtrasController } from './nc-extras.controller'

describe(NcExtrasController.name, () => {
  let moduleRef: TestingModule
  let controller: NcExtrasController
  let getAvatar: jest.Mock

  beforeAll(async () => {
    getAvatar = jest.fn()
    moduleRef = await Test.createTestingModule({
      controllers: [NcExtrasController],
      providers: [
        {
          provide: UsersManager,
          useValue: { getAvatar }
        }
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
  })

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
    it('returns 404 with "previews not available" body', () => {
      try {
        controller.preview('42', '32', '32')
        fail('expected HttpException')
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException)
        const err = e as HttpException
        expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND)
        expect(err.getResponse()).toEqual({ message: 'previews not available' })
      }
    })

    it('rejects missing fileId with 400', () => {
      expect(() => controller.preview(undefined as unknown as string)).toThrow(HttpException)
      try {
        controller.preview(undefined as unknown as string)
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST)
      }
    })
  })
})
