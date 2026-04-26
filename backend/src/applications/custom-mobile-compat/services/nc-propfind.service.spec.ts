import { Test } from '@nestjs/testing'
import type { FastifyReply } from 'fastify'
import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { NcPropfindService } from './nc-propfind.service'

function fakeReply() {
  const state: { status?: number; type?: string; body?: string } = {}
  const res = {
    type: (t: string) => {
      state.type = t
      return res
    },
    status: (s: number) => {
      state.status = s
      return res
    },
    send: (b: string) => {
      state.body = b
      return res
    }
  }
  return { res: res as unknown as FastifyReply, state }
}

async function* makeGen(items: WebDAVFile[]) {
  for (const i of items) yield i
}

describe('NcPropfindService', () => {
  let service: NcPropfindService
  let webdavSpaces: { propfind: jest.Mock }

  beforeEach(async () => {
    webdavSpaces = { propfind: jest.fn() }
    const module = await Test.createTestingModule({
      providers: [NcPropfindService, { provide: WebDAVSpaces, useValue: webdavSpaces }]
    }).compile()
    service = module.get(NcPropfindService)
  })

  function req(dir = true) {
    const folder = new WebDAVFile(
      { id: 42, name: 'Photos', isDir: dir, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const child = new WebDAVFile(
      { id: 100, name: 'pic.jpg', isDir: false, size: 1234, ctime: Date.now(), mtime: Date.now(), mime: 'image/jpeg' },
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder, child]))
    const space = {
      id: 0,
      alias: SPACE_ALIAS.PERSONAL,
      envPermissions: SPACE_ALL_OPERATIONS,
      permissions: SPACE_ALL_OPERATIONS,
      repository: SPACE_REPOSITORY.FILES,
      root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } }
    }
    return { space } as unknown as FastifyDAVRequest & { space: typeof space }
  }

  it('emits all four namespaces on multistatus', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('xmlns:d="DAV:"')
    expect(state.body).toContain('xmlns:oc="http://owncloud.org/ns"')
    expect(state.body).toContain('xmlns:nc="http://nextcloud.org/ns"')
    expect(state.body).toContain('xmlns:ocs="http://open-collaboration-services.org/ns"')
  })

  it('includes oc:id, oc:fileid, oc:permissions, ocs:share-permissions', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:id>00000000000000000042syncin</oc:id>')
    expect(state.body).toContain('<oc:fileid>42</oc:fileid>')
    expect(state.body).toMatch(/<oc:permissions>[A-Z]+<\/oc:permissions>/)
    expect(state.body).toMatch(/<ocs:share-permissions>\d+<\/ocs:share-permissions>/)
  })

  it('sets nc:has-preview true for an image child', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<nc:has-preview>true</nc:has-preview>')
  })

  it('status is 207 Multi-Status with xml content type', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.status).toBe(207)
    expect(state.type).toBe('application/xml; charset=utf-8')
    expect(state.body?.startsWith('<?xml')).toBe(true)
  })

  it('emits trashbin props with unix-seconds deletion time', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'trashbin')
    expect(state.body).toContain('<nc:trashbin-filename>')
    expect(state.body).toContain('<nc:trashbin-original-location>')
    expect(state.body).toMatch(/<nc:trashbin-deletion-time>\d+<\/nc:trashbin-deletion-time>/)
    expect(state.body).toContain('<oc:permissions></oc:permissions>')
  })

  it('sets owner-id from the space root owner', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:owner-id>alice</oc:owner-id>')
    expect(state.body).toContain('<oc:owner-display-name>alice</oc:owner-display-name>')
  })

  it('children inherit space.permissions, not envPermissions — so trash/D survives the virtual-endpoint-protection strip on the root', async () => {
    // Sync-in strips DELETE from envPermissions on the personal-space root
    // ("virtual endpoint protection") so a user can't delete their own
    // home. That MUST NOT cascade to children, otherwise NC iOS hides the
    // Move-to-trash action for every file.
    const root = new WebDAVFile(
      { id: 1, name: 'personal', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const child = new WebDAVFile(
      { id: 2, name: 'photo.jpg', isDir: false, size: 1, ctime: Date.now(), mtime: Date.now(), mime: 'image/jpeg' },
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([root, child]))
    const space = {
      alias: SPACE_ALIAS.PERSONAL,
      // envPermissions has DELETE stripped (real-world value for personal root)
      envPermissions: 'a:m:si:so',
      // space.permissions retains DELETE
      permissions: SPACE_ALL_OPERATIONS,
      repository: SPACE_REPOSITORY.FILES,
      root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } }
    }
    const r = { space } as unknown as FastifyDAVRequest & { space: typeof space }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')

    // Root response: no D (matches envPermissions strip — protect the root)
    const rootBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(rootBlock).toMatch(/<oc:permissions>[^D]*<\/oc:permissions>/)

    // Child response: HAS D (full permissions)
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/photo.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toMatch(/<oc:permissions>[^<]*D[^<]*<\/oc:permissions>/)
  })

  it('emits a positive oc:fileid even when the upstream id is the negative-inode placeholder', async () => {
    // Sync-in's filesystem-only files (those without a DB row yet — e.g.
    // freshly-uploaded ones) carry `id = -stat.ino`. NC iOS uses oc:fileid /
    // oc:id as the offline-cache primary key and rejects negative / zero
    // values, so we must map them to a stable positive id (abs(inode)).
    const fresh = new WebDAVFile(
      { id: -987654, name: 'PDF Form Sample.pdf', isDir: false, size: 1234, ctime: Date.now(), mtime: Date.now(), mime: 'application/pdf' },
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([fresh]))
    const space = {
      alias: SPACE_ALIAS.PERSONAL,
      envPermissions: SPACE_ALL_OPERATIONS,
      permissions: SPACE_ALL_OPERATIONS,
      repository: SPACE_REPOSITORY.FILES,
      root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } }
    }
    const r = { space } as unknown as FastifyDAVRequest & { space: typeof space }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')

    // Crucially: NOT 0, NOT negative.
    expect(state.body).toContain('<oc:fileid>987654</oc:fileid>')
    expect(state.body).toContain('<oc:id>00000000000000987654syncin</oc:id>')
    expect(state.body).not.toContain('<oc:fileid>0</oc:fileid>')
    expect(state.body).not.toContain('<oc:fileid>-987654</oc:fileid>')
  })
})
