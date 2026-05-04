import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcSearchService } from '../services/nc-search.service'
import { NcDiscoveryController } from './nc-discovery.controller'

describe(NcDiscoveryController.name, () => {
  let moduleRef: TestingModule
  let controller: NcDiscoveryController
  let basicAuth: { canActivate: jest.Mock }
  let search: { respond: jest.Mock }

  beforeEach(async () => {
    basicAuth = { canActivate: jest.fn() }
    search = { respond: jest.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDiscoveryController],
      providers: [
        { provide: NcBasicAuthGuard, useValue: basicAuth },
        { provide: NcSearchService, useValue: search }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDiscoveryController)
  })

  afterEach(async () => {
    await moduleRef.close()
  })

  describe('status.php', () => {
    it('returns the NC-shape identity object', () => {
      const out = controller.status()
      expect(out).toEqual({
        installed: true,
        maintenance: false,
        needsDbUpgrade: false,
        version: expect.any(String),
        versionstring: expect.any(String),
        edition: expect.any(String),
        productname: expect.any(String),
        extendedSupport: expect.any(Boolean)
      })
      // NC iOS gates the connection on `installed === true && maintenance === false`
      expect(out.installed).toBe(true)
      expect(out.maintenance).toBe(false)
    })

    it('declares CORS-permissive headers via @Header so pre-login probes work', () => {
      // @Header() pushes {name, value} onto an Array under '__headers__',
      // attached to the prototype method. We read the metadata directly
      // because spinning up a full Nest app + fastify inject just for one
      // header check is overkill.
      const headers: { name: string; value: string }[] | undefined = Reflect.getMetadata('__headers__', NcDiscoveryController.prototype.status)
      expect(headers).toEqual(expect.arrayContaining([{ name: 'Access-Control-Allow-Origin', value: '*' }]))
    })
  })

  describe('davRoot', () => {
    function makeRes() {
      const headers: Record<string, string> = {}
      const r = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn((k: string, v: string) => {
          headers[k] = v
          return r
        }),
        send: jest.fn().mockReturnThis()
      }
      return { res: r as unknown as FastifyReply, headers, raw: r }
    }

    function makeReq(method: string, extra: Partial<FastifyRequest> = {}): FastifyRequest & { user?: UserModel; body?: unknown } {
      return { method, headers: {}, ...extra } as unknown as FastifyRequest & { user?: UserModel; body?: unknown }
    }

    it('sets WWW-Authenticate + DAV headers and 401 on the unauth probe (POST)', async () => {
      const { res, headers, raw } = makeRes()
      await controller.davRoot(makeReq('POST'), res)

      expect(headers['WWW-Authenticate']).toMatch(/^Basic realm=".+"$/)
      expect(headers['DAV']).toBe('1, 2, 3')
      expect(raw.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED)
      expect(basicAuth.canActivate).not.toHaveBeenCalled()
      expect(search.respond).not.toHaveBeenCalled()
    })

    it('treats PROPFIND like the rest of the probe — 401 with DAV header', async () => {
      const { res, headers, raw } = makeRes()
      await controller.davRoot(makeReq('PROPFIND'), res)

      expect(headers['DAV']).toBe('1, 2, 3')
      expect(raw.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED)
      expect(basicAuth.canActivate).not.toHaveBeenCalled()
    })

    it('runs NcBasicAuthGuard for SEARCH and re-raises its HttpException on failure', async () => {
      const { res } = makeRes()
      basicAuth.canActivate.mockImplementation(() => {
        throw new HttpException('invalid app password', HttpStatus.UNAUTHORIZED)
      })

      await expect(controller.davRoot(makeReq('SEARCH'), res)).rejects.toBeInstanceOf(HttpException)
      expect(basicAuth.canActivate).toHaveBeenCalledTimes(1)
      expect(search.respond).not.toHaveBeenCalled()
    })

    it('dispatches SEARCH to NcSearchService.respond once auth attaches a user', async () => {
      const { res } = makeRes()
      const user = { id: 1, login: 'alice' } as UserModel
      const xmlBody = '<d:searchrequest xmlns:d="DAV:"></d:searchrequest>'
      basicAuth.canActivate.mockImplementation((ctx) => {
        const req = ctx.switchToHttp().getRequest() as FastifyRequest & { user?: UserModel }
        req.user = user
        return true
      })
      search.respond.mockResolvedValue(res)

      const req = makeReq('SEARCH', { body: xmlBody } as Partial<FastifyRequest>)
      await controller.davRoot(req, res)

      expect(search.respond).toHaveBeenCalledTimes(1)
      expect(search.respond).toHaveBeenCalledWith(user, xmlBody, res)
    })

    it('rejects SEARCH if the guard returns truthy without populating req.user', async () => {
      // Defense-in-depth check: a misbehaving guard that returns true but
      // never sets req.user should not blindly forward to the search service.
      const { res } = makeRes()
      basicAuth.canActivate.mockResolvedValue(true)

      await expect(controller.davRoot(makeReq('SEARCH'), res)).rejects.toBeInstanceOf(HttpException)
      expect(search.respond).not.toHaveBeenCalled()
    })
  })
})
