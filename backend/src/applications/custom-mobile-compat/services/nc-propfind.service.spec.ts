import { Test } from '@nestjs/testing'
import type { FastifyReply } from 'fastify'
import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'
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
  let fileRowEnsurer: { ensure: jest.Mock }

  beforeEach(async () => {
    webdavSpaces = { propfind: jest.fn() }
    // Default: pass the file id through unchanged. Tests that exercise the
    // negative-id → real-id promotion override this on a per-call basis.
    fileRowEnsurer = { ensure: jest.fn(async (f: WebDAVFile) => f.id) }
    const module = await Test.createTestingModule({
      providers: [NcPropfindService, { provide: WebDAVSpaces, useValue: webdavSpaces }, { provide: NcFileRowEnsurer, useValue: fileRowEnsurer }]
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

  it('sets nc:has-preview to "true" for an image child and "false" for a non-previewable folder', async () => {
    // Cross-client format: NextcloudKit's NSString.boolValue accepts "true"
    // and "1" both. Android's WebdavEntry parses with Boolean.valueOf which
    // ONLY recognizes the literal "true"/"false" strings — "1" parses to
    // false there, which is what made Android Files render no thumbnails
    // for any image. Word-form is the cross-client lingua franca.
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/pic.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toContain('<nc:has-preview>true</nc:has-preview>')
    const folderBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(folderBlock).toContain('<nc:has-preview>false</nc:has-preview>')
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
    // No req.user attached → falls back to owner login.
    expect(state.body).toContain('<oc:owner-display-name>alice</oc:owner-display-name>')
  })

  it('uses requester.fullName for owner-display-name when owner is the requester (personal space)', async () => {
    const r = req()
    ;(r as unknown as { user: { id: number; login: string; fullName: string } }).user = { id: 1, login: 'alice', fullName: 'Alice Liddell' }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:owner-display-name>Alice Liddell</oc:owner-display-name>')
  })

  it('emits oc:share-types as an empty parent element', async () => {
    // Real NC always emits the element; absent → NC iOS skips share-badge
    // logic entirely. Empty parent matches "no shares on this file".
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:share-types></oc:share-types>')
  })

  it('emits oc:comments-unread as "0" when the file has no unread comments (default)', async () => {
    // NC iOS reads oc:comments-unread (oc-namespace, not nc:has-comments) at
    // NKDataFileXML.swift:436 via NSString.boolValue. Emitting under the
    // wrong namespace + element name (the previous nc:has-comments) means
    // the comment badge never lights up regardless of state.
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:comments-unread>0</oc:comments-unread>')
    expect(state.body).not.toContain('<nc:has-comments>')
  })

  it('emits oc:comments-unread as "1" when the WebDAVFile carries hasComments=true', async () => {
    const folder = new WebDAVFile(
      { id: 42, name: 'Photos', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const child = new WebDAVFile(
      { id: 100, name: 'pic.jpg', isDir: false, size: 1234, ctime: Date.now(), mtime: Date.now(), mime: 'image/jpeg', hasComments: true } as never,
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder, child]))
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
    // Pull just the child block to avoid matching the folder's "0" entry.
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/pic.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toContain('<oc:comments-unread>1</oc:comments-unread>')
  })

  it('emits nc:lock as "0" when the file is unlocked', async () => {
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<nc:lock>0</nc:lock>')
    // No descriptive lock children when unlocked.
    expect(state.body).not.toContain('<nc:lock-owner>')
  })

  it('emits nc:lock as "1" plus owner info when the file is locked', async () => {
    const lockedFile = new WebDAVFile(
      {
        id: 100,
        name: 'doc.txt',
        isDir: false,
        size: 12,
        ctime: Date.now(),
        mtime: Date.now(),
        mime: 'text/plain',
        lock: { owner: { login: 'bob', fullName: 'Bob Borg', email: 'bob@example.com' }, app: 'files', isExclusive: true }
      } as never,
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([lockedFile]))
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
    expect(state.body).toContain('<nc:lock>1</nc:lock>')
    expect(state.body).toContain('<nc:lock-owner-type>0</nc:lock-owner-type>')
    expect(state.body).toContain('<nc:lock-owner>bob</nc:lock-owner>')
    expect(state.body).toContain('<nc:lock-owner-displayname>Bob Borg</nc:lock-owner-displayname>')
    expect(state.body).toContain('<nc:lock-owner-editor>files</nc:lock-owner-editor>')
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

  it('emits d:quota-used-bytes and d:quota-available-bytes on the root response only', async () => {
    // iOS Files app reads these on the user-home root PROPFIND to render the
    // quota bar. Without them the bar reads "0 GB used of 0 GB". Children
    // must NOT carry quota props — they're per-collection only.
    const r = req()
    ;(r as unknown as { user: { id: number; login: string; fullName: string; storageUsage: number; storageQuota: number } }).user = {
      id: 1,
      login: 'alice',
      fullName: 'Alice Liddell',
      storageUsage: 1_073_741_824,
      storageQuota: 5_368_709_120
    }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    const rootBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(rootBlock).toContain('<d:quota-used-bytes>1073741824</d:quota-used-bytes>')
    expect(rootBlock).toContain('<d:quota-available-bytes>4294967296</d:quota-available-bytes>')
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/pic.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).not.toContain('<d:quota-used-bytes>')
    expect(childBlock).not.toContain('<d:quota-available-bytes>')
  })

  it('emits -3 for d:quota-available-bytes when the user has no quota cap (ownCloud "unlimited" sentinel)', async () => {
    // Sync-in models "no quota" as storageQuota <= 0. The ownCloud convention
    // (which NC clients implement) is to send -3 (unlimited/unknown) so iOS
    // renders an open-ended quota bar instead of "0 of 0".
    const r = req()
    ;(r as unknown as { user: { id: number; login: string; fullName: string; storageUsage: number; storageQuota: number } }).user = {
      id: 1,
      login: 'alice',
      fullName: 'Alice Liddell',
      storageUsage: 4096,
      storageQuota: 0
    }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    const rootBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(rootBlock).toContain('<d:quota-used-bytes>4096</d:quota-used-bytes>')
    expect(rootBlock).toContain('<d:quota-available-bytes>-3</d:quota-available-bytes>')
  })

  it('does not emit quota props on the trashbin root', async () => {
    // Trashbin doesn't have its own quota in NC; the bar lives under files/.
    const r = req()
    ;(r as unknown as { user: { id: number; login: string; fullName: string; storageUsage: number; storageQuota: number } }).user = {
      id: 1,
      login: 'alice',
      fullName: 'Alice Liddell',
      storageUsage: 4096,
      storageQuota: 1_000_000
    }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'trashbin')
    expect(state.body).not.toContain('<d:quota-used-bytes>')
    expect(state.body).not.toContain('<d:quota-available-bytes>')
  })

  it('promotes a placeholder fileid to the real DB id returned by the ensurer', async () => {
    // The whole point of NcFileRowEnsurer: when an FS-only file shows up in
    // a PROPFIND, look up (or create) its DB row and emit the real id so
    // NC iOS' subsequent /index.php/core/preview?fileId=… calls resolve.
    const fresh = new WebDAVFile(
      { id: -987654, name: 'cat.jpg', isDir: false, size: 1234, ctime: Date.now(), mtime: Date.now(), mime: 'image/jpeg' },
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([fresh]))
    // Ensurer reports the file's real DB id is 4242 — different from the
    // inode-derived placeholder. The response must use 4242.
    fileRowEnsurer.ensure.mockResolvedValueOnce(4242)
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

    expect(fileRowEnsurer.ensure).toHaveBeenCalled()
    expect(state.body).toContain('<oc:fileid>4242</oc:fileid>')
    expect(state.body).toContain('<oc:id>00000000000000004242syncin</oc:id>')
    // The placeholder must be gone — otherwise NC iOS caches the wrong key.
    expect(state.body).not.toContain('<oc:fileid>987654</oc:fileid>')
  })
})
