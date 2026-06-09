import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'
import { NcOcsSharesController } from './nc-ocs-shares.controller'
import { Mock } from 'vitest'

function fakeReply(): FastifyReply {
  return { header: vi.fn() } as unknown as FastifyReply
}

function jsonOnlyReq(): FastifyRequest {
  return { headers: { accept: 'application/json' } } as unknown as FastifyRequest
}

describe(NcOcsSharesController.name, () => {
  let moduleRef: TestingModule
  let controller: NcOcsSharesController
  let shareMounts: { listMounts: Mock }

  const user = { id: 7, login: 'bob', fullName: 'Bob Burns' } as unknown as UserModel

  const mount = {
    shareId: 42,
    alias: 'alice-photos',
    name: "Alice's Photos",
    fileId: 9001,
    isDir: true,
    size: 0,
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_500_000,
    mime: '',
    permissions: 'a:d:m',
    owner: { id: 1, login: 'alice', fullName: 'Alice Liddell' }
  }

  beforeAll(async () => {
    shareMounts = { listMounts: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcOcsSharesController],
      providers: [NcResponseService, { provide: NcShareMountResolverService, useValue: shareMounts }]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcOcsSharesController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns one envelope-wrapped record per incoming share when shared_with_me=true (v2)', async () => {
    shareMounts.listMounts.mockResolvedValue([mount])
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV2(req, fakeReply(), 'true')
    expect(env.ocs.meta.status).toBe('ok')
    expect(env.ocs.meta.statuscode).toBe(200) // OCS v2 uses HTTP-mirror codes
    expect(env.ocs.data).toHaveLength(1)
    expect(env.ocs.data[0].id).toBe('42')
    expect(env.ocs.data[0].file_source).toBe(9001)
    expect(env.ocs.data[0].path).toBe('/alice-photos')
    expect(shareMounts.listMounts).toHaveBeenCalledWith(user)
  })

  it('uses OCS_OK_V1 statuscode (100) on the v1 endpoint', async () => {
    shareMounts.listMounts.mockResolvedValue([mount])
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV1(req, fakeReply(), 'true')
    expect(env.ocs.meta.statuscode).toBe(100)
    expect(env.ocs.data).toHaveLength(1)
  })

  it('returns an empty list when shared_with_me=true and the user has no incoming shares', async () => {
    shareMounts.listMounts.mockResolvedValue([])
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV2(req, fakeReply(), 'true')
    expect(env.ocs.data).toEqual([])
  })

  it('returns an empty list when shared_with_me is false (outgoing shares out of scope for v1)', async () => {
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV2(req, fakeReply(), 'false')
    expect(env.ocs.data).toEqual([])
    // Crucially: we don't even consult the mount resolver for outgoing
    // queries. That avoids a needless DB roundtrip on the iOS Shares-tab
    // refresh path, which fetches both modes back-to-back.
    expect(shareMounts.listMounts).not.toHaveBeenCalled()
  })

  it('treats shared_with_me=undefined as outgoing (matches NC default) — empty list', async () => {
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV2(req, fakeReply(), undefined)
    expect(env.ocs.data).toEqual([])
    expect(shareMounts.listMounts).not.toHaveBeenCalled()
  })

  it('treats shared_with_me=1 or other truthy-looking strings as outgoing (only the exact word "true" counts)', async () => {
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    // NextcloudKit only ever sends 'true' / 'false'; defensive strictness
    // here just keeps the matrix small.
    const env = await controller.listSharesV2(req, fakeReply(), '1')
    expect(env.ocs.data).toEqual([])
    expect(shareMounts.listMounts).not.toHaveBeenCalled()
  })

  it('threads the recipient identity into each record (share_with = requesting user)', async () => {
    shareMounts.listMounts.mockResolvedValue([mount])
    const req = { ...jsonOnlyReq(), user } as FastifyRequest & { user: UserModel }
    const env = await controller.listSharesV2(req, fakeReply(), 'true')
    expect(env.ocs.data[0].share_with).toBe('bob')
    expect(env.ocs.data[0].share_with_displayname).toBe('Bob Burns')
  })
})
