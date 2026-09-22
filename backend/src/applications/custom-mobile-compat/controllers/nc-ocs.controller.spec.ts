import { HttpStatus } from '@nestjs/common'
import type { Mock } from 'vitest'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { comparePassword } from '../../../common/functions'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { NcOcsController } from './nc-ocs.controller'

// comparePassword is bcrypt; stub it so the cases below can state the
// candidate/hash relationship directly instead of generating real hashes.
vi.mock('../../../common/functions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/functions')>()),
  comparePassword: vi.fn()
}))

describe(NcOcsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcOcsController

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcOcsController],
      providers: [
        NcResponseService,
        { provide: UsersManager, useValue: { listAppPasswords: vi.fn(), validateAppPassword: vi.fn(), deleteAppPassword: vi.fn() } },
        { provide: UsersQueries, useValue: { getUserSecrets: vi.fn() } },
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

// #481 — logging out one device could revoke a DIFFERENT device's credential.
//
// `findAppPasswordName` used to identify the caller's own row by diffing
// `currentAccess` before/after a `validateAppPassword` call, then fall back to
// `after[0]` — the NEWEST row — when the diff found nothing. `currentAccess`
// is second-granularity and NcBasicAuthGuard's 900s positive cache means a
// row's previous value can be arbitrarily close, so the diff legitimately
// finds no change; the fallback then deleted whichever device had paired most
// recently while the one the user pressed "log out" on stayed live.
describe(`${NcOcsController.name} — DELETE apppassword identifies the CALLER's row (#481)`, () => {
  let moduleRef: TestingModule
  let controller: NcOcsController
  let usersManager: { deleteAppPassword: Mock }
  let usersQueries: { getUserSecrets: Mock }
  let guard: { evictCache: Mock }

  const row = (name: string, app: AUTH_SCOPE, password: string) => ({ name, app, password })

  beforeAll(async () => {
    usersManager = { deleteAppPassword: vi.fn().mockResolvedValue(undefined) }
    usersQueries = { getUserSecrets: vi.fn() }
    guard = { evictCache: vi.fn().mockResolvedValue(undefined) }
    moduleRef = await Test.createTestingModule({
      controllers: [NcOcsController],
      providers: [
        NcResponseService,
        { provide: UsersManager, useValue: usersManager },
        { provide: UsersQueries, useValue: usersQueries },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true, ...guard } }
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

  beforeEach(() => {
    vi.clearAllMocks()
    // The stand-in hashing scheme: a row's stored "hash" is `hash:<secret>`.
    vi.mocked(comparePassword).mockImplementation(async (candidate: string, hash?: string | null) => hash === `hash:${candidate}`)
  })

  const req = (secret: string) =>
    ({
      headers: { accept: 'application/json', authorization: `Basic ${Buffer.from(`alice:${secret}`).toString('base64')}` },
      user: { id: 7, login: 'alice', isActive: true } as UserModel
    }) as unknown as FastifyRequest & { user: UserModel }

  const res = () => ({ header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() }) as unknown as FastifyReply

  it('deletes the row the caller authenticated with, not the newest one', async () => {
    usersQueries.getUserSecrets.mockResolvedValue({
      appPasswords: [
        // Newest first — this is the order generateAppPassword writes, and the
        // old fallback took [0].
        row('mobile-newest', AUTH_SCOPE.MOBILE_NC, 'hash:phone-b'),
        row('mobile-mine', AUTH_SCOPE.MOBILE_NC, 'hash:phone-a')
      ]
    })

    await controller.revokeAppPassword(req('phone-a'), res())

    expect(usersManager.deleteAppPassword).toHaveBeenCalledTimes(1)
    expect(usersManager.deleteAppPassword).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }), 'mobile-mine', AUTH_SCOPE.MOBILE_NC)
  })

  it('deletes nothing when no mobile_nc row matches the presented secret', async () => {
    usersQueries.getUserSecrets.mockResolvedValue({ appPasswords: [row('mobile-other', AUTH_SCOPE.MOBILE_NC, 'hash:someone-else')] })

    await controller.revokeAppPassword(req('phone-a'), res())

    expect(usersManager.deleteAppPassword).not.toHaveBeenCalled()
  })

  // The scope filter is the other half of the same defect: names are unique
  // per user but not per scope.
  it('ignores a matching row from another scope', async () => {
    usersQueries.getUserSecrets.mockResolvedValue({
      appPasswords: [row('webdav-client', AUTH_SCOPE.WEBDAV, 'hash:phone-a'), row('mobile-mine', AUTH_SCOPE.MOBILE_NC, 'hash:phone-a')]
    })

    await controller.revokeAppPassword(req('phone-a'), res())

    expect(usersManager.deleteAppPassword).toHaveBeenCalledWith(expect.anything(), 'mobile-mine', AUTH_SCOPE.MOBILE_NC)
  })

  it('tolerates a user with no app passwords at all', async () => {
    usersQueries.getUserSecrets.mockResolvedValue({})

    await expect(controller.revokeAppPassword(req('phone-a'), res())).resolves.toBeDefined()
    expect(usersManager.deleteAppPassword).not.toHaveBeenCalled()
  })
})
