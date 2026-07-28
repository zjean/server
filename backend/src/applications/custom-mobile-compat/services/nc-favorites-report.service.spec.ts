import { NotFoundException } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Mock } from 'vitest'
import { FavoritesManager } from '../../custom-favorites/services/favorites-manager.service'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { NcFavoritesReportService } from './nc-favorites-report.service'
import { NcPathResolverService } from './nc-path-resolver.service'
import { NcShareMountResolverService } from './nc-share-mount-resolver.service'

function fakeSpace(realPath: string, relativeUrl: string): SpaceEnv {
  const space = Object.create(SpaceEnv.prototype) as SpaceEnv
  Object.assign(space, {
    id: 0,
    alias: SPACE_ALIAS.PERSONAL,
    name: 'personal',
    enabled: true,
    permissions: 'arwdmsu',
    envPermissions: 'arwdmsu',
    repository: SPACE_REPOSITORY.FILES,
    inPersonalSpace: true,
    inSharesRepository: false,
    realBasePath: path.dirname(realPath),
    realPath,
    relativeUrl,
    url: `files/personal/${relativeUrl}`,
    root: { id: 0, alias: '', name: '', permissions: 'arwdmsu', owner: { id: 7, login: 'alice' } }
  })
  return space
}

function fakeReply() {
  const captured: { status?: number; type?: string; body?: string } = {}
  const reply = {
    type: (t: string) => ((captured.type = t), reply),
    status: (s: number) => ((captured.status = s), reply),
    send: (b: string) => ((captured.body = b), reply)
  }
  return { reply: reply as never, captured }
}

const user = { id: 7, login: 'alice', fullName: 'Alice' } as UserModel

function favorite(navPath: string, name: string, id = 100) {
  return { id, name, isDir: false, mime: 'application/pdf', size: 5, mtime: Date.now(), ctime: Date.now(), isFavorite: true, navPath }
}

describe('NcFavoritesReportService', () => {
  let moduleRef: TestingModule
  let service: NcFavoritesReportService
  let favorites: { getFavorites: Mock; addFavorite: Mock; removeFavorite: Mock }
  let resolver: { resolve: Mock }
  let shareMounts: { listMounts: Mock }
  let spacesManager: { spaceEnv: Mock }
  let tmpRoot: string

  beforeEach(async () => {
    favorites = {
      getFavorites: vi.fn().mockResolvedValue([]),
      addFavorite: vi.fn().mockResolvedValue(undefined),
      removeFavorite: vi.fn().mockResolvedValue(undefined)
    }
    // Default home: personal.
    resolver = {
      resolve: vi.fn().mockReturnValue({ repository: SPACE_REPOSITORY.FILES, spaceAlias: SPACE_ALIAS.PERSONAL, rootAlias: null, relativePath: '' })
    }
    shareMounts = { listMounts: vi.fn().mockResolvedValue([]) }
    spacesManager = { spaceEnv: vi.fn() }
    moduleRef = await Test.createTestingModule({
      providers: [
        NcFavoritesReportService,
        { provide: FavoritesManager, useValue: favorites },
        { provide: NcPathResolverService, useValue: resolver },
        { provide: NcShareMountResolverService, useValue: shareMounts },
        { provide: SpacesManager, useValue: spacesManager }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcFavoritesReportService)
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-fav-report-'))
  })

  afterEach(async () => {
    await moduleRef.close()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  // BYTE-FOR-BYTE ENVELOPE PIN, added before the nc-xml.ts consolidation
  // (#343). This emitter is the only one that OMITS the `d:response` key
  // entirely when there are no entries, rather than passing an empty array —
  // both produce the same bytes today (an empty array contributes nothing), and
  // this pin is what proves that equivalence holds after the two code paths
  // collapse into one shared renderer.
  it('wire-format pin: the multistatus envelope with no favorites, byte for byte', async () => {
    const { reply, captured } = fakeReply()
    await service.respond({ user } as never, reply)
    expect(captured.body).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns"></d:multistatus>'
    )
  })

  describe('respond (REPORT filter-files)', () => {
    it('lists a favorited personal file with an absolute href and oc:favorite=1', async () => {
      const filePath = path.join(tmpRoot, 'report.pdf')
      await fs.writeFile(filePath, 'pdf')
      favorites.getFavorites.mockResolvedValue([favorite('files/personal/report.pdf', 'report.pdf')])
      spacesManager.spaceEnv.mockResolvedValue(fakeSpace(filePath, 'report.pdf'))

      const { reply, captured } = fakeReply()
      await service.respond({ user } as never, reply)

      expect(captured.status).toBe(207)
      expect(captured.body).toContain('<d:href>/remote.php/dav/files/alice/report.pdf</d:href>')
      expect(captured.body).toContain('<oc:favorite>1</oc:favorite>')
      // resolved via the stored repository path (navPath), not a rebuilt one
      expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['files', 'personal', 'report.pdf'])
    })

    it('omits a collaborative-space favorite that is not reachable under the personal home', async () => {
      favorites.getFavorites.mockResolvedValue([favorite('files/marketing/plan.xlsx', 'plan.xlsx')])

      const { reply, captured } = fakeReply()
      await service.respond({ user } as never, reply)

      expect(captured.status).toBe(207)
      expect(captured.body).not.toContain('plan.xlsx')
      expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    })

    it('skips a favorite whose file no longer exists on disk (stat fails)', async () => {
      favorites.getFavorites.mockResolvedValue([favorite('files/personal/ghost.pdf', 'ghost.pdf')])
      spacesManager.spaceEnv.mockResolvedValue(fakeSpace(path.join(tmpRoot, 'ghost.pdf'), 'ghost.pdf'))

      const { reply, captured } = fakeReply()
      await service.respond({ user } as never, reply)

      expect(captured.status).toBe(207)
      expect(captured.body).not.toContain('ghost.pdf')
    })

    it('returns an empty multistatus when the user has no favorites', async () => {
      const { reply, captured } = fakeReply()
      await service.respond({ user } as never, reply)
      expect(captured.status).toBe(207)
      expect(captured.body).toContain('<d:multistatus')
      expect(captured.body).not.toContain('<d:response>')
    })
  })

  describe('respondProppatchFavorite (PROPPATCH toggle)', () => {
    const targetSpace = fakeSpace('/x/report.pdf', 'report.pdf')
    const req = { user, space: targetSpace, dav: { url: '/remote.php/dav/files/alice/report.pdf' } } as never

    it('favorite=true calls addFavorite and returns 207 with a 200 propstat', async () => {
      const { reply, captured } = fakeReply()
      await service.respondProppatchFavorite(req, reply, true)
      expect(favorites.addFavorite).toHaveBeenCalledWith(user, targetSpace)
      expect(captured.status).toBe(207)
      expect(captured.body).toContain('<oc:favorite')
      expect(captured.body).toContain('HTTP/1.1 200 OK')
    })

    it('favorite=false calls removeFavorite and returns 207 with a 204 propstat', async () => {
      const { reply, captured } = fakeReply()
      await service.respondProppatchFavorite(req, reply, false)
      expect(favorites.removeFavorite).toHaveBeenCalledWith(user, targetSpace)
      expect(captured.status).toBe(207)
      expect(captured.body).toContain('HTTP/1.1 204 No Content')
    })

    it('unfavorite is idempotent — swallows NotFoundException from a non-favorited file', async () => {
      favorites.removeFavorite.mockRejectedValue(new NotFoundException('file not found'))
      const { reply, captured } = fakeReply()
      await expect(service.respondProppatchFavorite(req, reply, false)).resolves.toBeDefined()
      expect(captured.status).toBe(207)
    })
  })
})
