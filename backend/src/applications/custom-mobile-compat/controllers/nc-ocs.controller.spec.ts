import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { NcOcsController } from './nc-ocs.controller'

describe(NcOcsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcOcsController

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcOcsController],
      providers: [
        NcResponseService,
        { provide: UsersManager, useValue: { listAppPasswords: vi.fn(), validateAppPassword: vi.fn(), deleteAppPassword: vi.fn() } },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true, evictCache: vi.fn() } }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcOcsController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  function fakeReq(login = 'alice'): FastifyRequest & { user: UserModel } {
    return {
      headers: { accept: 'application/json' },
      user: { id: 7, login, isActive: true } as UserModel
    } as unknown as FastifyRequest & { user: UserModel }
  }

  function fakeRes(): FastifyReply {
    return {
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis()
    } as unknown as FastifyReply
  }

  describe('userProvisioning v1/v2 parity', () => {
    // The route-level @UseGuards(NcBasicAuthGuard) is what populates req.user.
    // Without it the v1 handler used to dereference an undefined req.user and
    // raise a 500 on every unauthenticated hit. We assert both handlers carry
    // the guard via Nest's reflect metadata — overrideGuard above masks the
    // real guard at runtime, so this is the only place that catches a missing
    // decorator regression.
    it('both handlers are guarded by NcBasicAuthGuard', () => {
      const v1Guards = Reflect.getMetadata('__guards__', NcOcsController.prototype.userProvisioningV1) as unknown[] | undefined
      const v2Guards = Reflect.getMetadata('__guards__', NcOcsController.prototype.userProvisioningV2) as unknown[] | undefined
      expect(v1Guards).toContain(NcBasicAuthGuard)
      expect(v2Guards).toContain(NcBasicAuthGuard)
    })

    it('v1 returns OCS-v1 envelope (statuscode 100) for self', () => {
      const out = controller.userProvisioningV1('alice', fakeReq('alice'), fakeRes())
      expect(out.ocs.meta.statuscode).toBe(100)
      expect(out.ocs.meta.status).toBe('ok')
      expect(out.ocs.data.id).toBe('alice')
    })

    it('v2 returns OCS-v2 envelope (statuscode 200) for self', () => {
      const out = controller.userProvisioningV2('alice', fakeReq('alice'), fakeRes())
      expect(out.ocs.meta.statuscode).toBe(200)
      expect(out.ocs.meta.status).toBe('ok')
      expect(out.ocs.data.id).toBe('alice')
    })

    it('v1 throws 403 when :userid does not match the authenticated user', () => {
      expect(() => controller.userProvisioningV1('bob', fakeReq('alice'), fakeRes())).toThrow(
        expect.objectContaining({ status: HttpStatus.FORBIDDEN })
      )
    })

    it('v2 throws 403 when :userid does not match the authenticated user', () => {
      expect(() => controller.userProvisioningV2('bob', fakeReq('alice'), fakeRes())).toThrow(
        expect.objectContaining({ status: HttpStatus.FORBIDDEN })
      )
    })
  })
})
