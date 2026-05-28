import { Test, TestingModule } from '@nestjs/testing'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { UserModel } from '../../users/models/user.model'
import { NcShareMountResolverService } from './nc-share-mount-resolver.service'

describe(NcShareMountResolverService.name, () => {
  let moduleRef: TestingModule
  let svc: NcShareMountResolverService
  let sharesQueries: { shareRootFiles: jest.Mock }

  const user = { id: 7, login: 'bob' } as unknown as UserModel

  const aliceRow = {
    id: 9001,
    path: 'Photos',
    isDir: true,
    size: 0,
    ctime: 1000,
    mtime: 2000,
    mime: '',
    root: {
      id: 42,
      alias: 'alice-photos',
      name: "Alice's Photos",
      permissions: 'a:d:m',
      owner: { id: 1, login: 'alice', fullName: 'Alice Anderson' }
    }
  }

  beforeAll(async () => {
    sharesQueries = { shareRootFiles: jest.fn() }
    moduleRef = await Test.createTestingModule({
      providers: [NcShareMountResolverService, { provide: SharesQueries, useValue: sharesQueries }]
    }).compile()
    svc = moduleRef.get(NcShareMountResolverService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('listMounts', () => {
    it('maps a shareRootFiles row to an NcShareMount', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([aliceRow])
      const mounts = await svc.listMounts(user)
      expect(mounts).toHaveLength(1)
      expect(mounts[0]).toEqual({
        shareId: 42,
        alias: 'alice-photos',
        name: "Alice's Photos",
        fileId: 9001,
        isDir: true,
        size: 0,
        mtime: 2000,
        ctime: 1000,
        mime: '',
        permissions: 'a:d:m',
        owner: { id: 1, login: 'alice', fullName: 'Alice Anderson' }
      })
    })

    it('passes the requesting user through to the queries layer', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([])
      await svc.listMounts(user)
      expect(sharesQueries.shareRootFiles).toHaveBeenCalledWith(user, {})
    })

    it('returns empty when the user has no incoming shares', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([])
      expect(await svc.listMounts(user)).toEqual([])
    })

    it('skips rows missing a root descriptor (defensive — should never happen but guard)', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([{ ...aliceRow, root: undefined }])
      expect(await svc.listMounts(user)).toEqual([])
    })

    it('skips rows with a missing or non-positive fileId', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([
        { ...aliceRow, id: 0 },
        { ...aliceRow, id: -1 },
        { ...aliceRow, id: null as unknown as number }
      ])
      expect(await svc.listMounts(user)).toEqual([])
    })

    it('falls back to alias when name is missing, and to login when fullName is missing', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([
        {
          ...aliceRow,
          root: {
            ...aliceRow.root,
            name: undefined,
            owner: { id: 1, login: 'alice', fullName: undefined }
          }
        }
      ])
      const [m] = await svc.listMounts(user)
      expect(m.name).toBe('alice-photos')
      expect(m.owner.fullName).toBe('alice')
    })
  })

  describe('findByAlias', () => {
    it('returns the matching mount', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([aliceRow])
      const m = await svc.findByAlias(user, 'alice-photos')
      expect(m?.shareId).toBe(42)
    })

    it('returns null for an unknown alias', async () => {
      sharesQueries.shareRootFiles.mockResolvedValue([aliceRow])
      expect(await svc.findByAlias(user, 'nope')).toBeNull()
    })

    it('returns null for an empty alias without querying the database', async () => {
      expect(await svc.findByAlias(user, '')).toBeNull()
      expect(sharesQueries.shareRootFiles).not.toHaveBeenCalled()
    })
  })
})
