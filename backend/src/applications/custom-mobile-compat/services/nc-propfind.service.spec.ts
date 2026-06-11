import { Test } from '@nestjs/testing'
import type { FastifyReply } from 'fastify'
import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { FavoritesManager } from '../../custom-favorites/services/favorites-manager.service'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'
import { NcPropfindService } from './nc-propfind.service'
import { NcShareMountResolverService } from './nc-share-mount-resolver.service'
import { Mock } from 'vitest'

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
  let webdavSpaces: { propfind: Mock }
  let fileRowEnsurer: { ensure: Mock }
  let shareMounts: { listMounts: Mock }
  let favorites: { getFavoriteIdsForUser: Mock }

  beforeEach(async () => {
    webdavSpaces = { propfind: vi.fn() }
    // Default: pass the file id through unchanged. Tests that exercise the
    // negative-id → real-id promotion override this on a per-call basis.
    fileRowEnsurer = { ensure: vi.fn(async (f: WebDAVFile) => f.id) }
    // Default: no incoming shares — most existing assertions are for the
    // personal-space listing only and shouldn't be perturbed by mount
    // injection. Tests covering injection override per-call.
    shareMounts = { listMounts: vi.fn().mockResolvedValue([]) }
    // Default: no favorites — keeps existing assertions emitting oc:favorite=0.
    favorites = { getFavoriteIdsForUser: vi.fn().mockResolvedValue([]) }
    const module = await Test.createTestingModule({
      providers: [
        NcPropfindService,
        { provide: WebDAVSpaces, useValue: webdavSpaces },
        { provide: NcFileRowEnsurer, useValue: fileRowEnsurer },
        { provide: NcShareMountResolverService, useValue: shareMounts },
        { provide: FavoritesManager, useValue: favorites }
      ]
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

  it('marks oc:favorite=1 on favorited file ids and 0 on the rest', async () => {
    const r = req()
    // Attach a user so the favorites lookup runs; pic.jpg has id 100.
    ;(r as unknown as { user: unknown }).user = { id: 1, login: 'alice', fullName: 'Alice' }
    favorites.getFavoriteIdsForUser.mockResolvedValue([100])
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(favorites.getFavoriteIdsForUser).toHaveBeenCalledWith(1)
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/pic.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toContain('<oc:favorite>1</oc:favorite>')
    const folderBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(folderBlock).toContain('<oc:favorite>0</oc:favorite>')
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

  it('emits d:getetag as a strong ETag (no W/ prefix), even when the source file carries a weak one', async () => {
    // Sync-in's genEtag defaults to weakPrefix=true and produces W/"...".
    // Real Nextcloud (sabre/dav) emits strong ETags. NextcloudKit's parser
    // strips quotes only -- it does NOT strip the W/ prefix -- so a weak
    // ETag lands in iOS's metadata.etag with a literal slash mid-string.
    // iOS then uses that etag as a path component for thumbnail storage:
    //   <docStorage>/<ocId>/<etag><ext> -> "<...>/<ocId>/W/<rest>.preview.ico"
    // The W/ becomes a (nonexistent) intermediate directory and the thumbnail
    // pipeline silently fails -- no preview GET fires from the cell willDisplay
    // gate, list cells stay empty even though hasPreview is true. Strong
    // ETags avoid the slash entirely.
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    // Quotes preserved (NC clients strip them); the W/ prefix removed.
    expect(state.body).toMatch(/<d:getetag>&quot;[a-f0-9-]+&quot;<\/d:getetag>/)
    expect(state.body).not.toContain('<d:getetag>W/')
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

  it('emits oc:share-types as an empty parent for an unshared file', async () => {
    // Real NC always emits the element; absent → NC iOS skips share-badge
    // logic entirely. Empty parent matches "no shares on this file".
    const r = req()
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:share-types></oc:share-types>')
  })

  it('emits <oc:share-type>0</oc:share-type> for a user-shared file (Sync-in COMMON → NC user)', async () => {
    // NC iOS lights up the share badge when any <oc:share-type> child is
    // present under <oc:share-types>. NC code 0 = user-share, which matches
    // Sync-in's COMMON share-type.
    const folder = new WebDAVFile(
      { id: 42, name: 'Photos', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const shared = new WebDAVFile(
      {
        id: 100,
        name: 'shared.jpg',
        isDir: false,
        size: 1,
        ctime: Date.now(),
        mtime: Date.now(),
        mime: 'image/jpeg',
        shares: [{ id: 5, alias: 'abc', name: 'shared.jpg', type: 0 }]
      } as never,
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder, shared]))
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
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/shared.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toContain('<oc:share-types><oc:share-type>0</oc:share-type></oc:share-types>')
  })

  it('emits <oc:share-type>3</oc:share-type> for a link-shared file (Sync-in LINK → NC link)', async () => {
    const folder = new WebDAVFile(
      { id: 42, name: 'Photos', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const shared = new WebDAVFile(
      {
        id: 100,
        name: 'linked.jpg',
        isDir: false,
        size: 1,
        ctime: Date.now(),
        mtime: Date.now(),
        mime: 'image/jpeg',
        shares: [{ id: 5, alias: 'abc', name: 'linked.jpg', type: 1 }]
      } as never,
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder, shared]))
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
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/linked.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    expect(childBlock).toContain('<oc:share-types><oc:share-type>3</oc:share-type></oc:share-types>')
  })

  it('dedupes share-type codes when a file has multiple shares of the same kind', async () => {
    const folder = new WebDAVFile(
      { id: 42, name: 'Photos', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/alice/',
      true
    )
    const shared = new WebDAVFile(
      {
        id: 100,
        name: 'busy.jpg',
        isDir: false,
        size: 1,
        ctime: Date.now(),
        mtime: Date.now(),
        mime: 'image/jpeg',
        shares: [
          { id: 5, alias: 'abc', name: 'busy.jpg', type: 0 },
          { id: 6, alias: 'def', name: 'busy.jpg', type: 0 },
          { id: 7, alias: 'ghi', name: 'busy.jpg', type: 1 }
        ]
      } as never,
      '/remote.php/dav/files/alice/'
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder, shared]))
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
    const childBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/busy.jpg</d:href>')[1]?.split('</d:response>')[0] ?? ''
    // Two distinct codes only — one 0 (user) and one 3 (link). No duplicate 0 entries.
    expect(childBlock).toMatch(/<oc:share-types><oc:share-type>0<\/oc:share-type><oc:share-type>3<\/oc:share-type><\/oc:share-types>/)
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

  // nc:lock-* props are deliberately not emitted: NC clients gate the lock
  // UI on the `files.locking` capability (which we don't advertise), so the
  // props were paying serialization cost for a UI no client renders.
  it('does not emit nc:lock or nc:lock-* props (locking capability disabled)', async () => {
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
    expect(state.body).not.toContain('<nc:lock>')
    expect(state.body).not.toContain('<nc:lock-owner')
    expect(state.body).not.toContain('<nc:lock-owner-type')
    expect(state.body).not.toContain('<nc:lock-owner-editor')
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

  it('falls back to the requesting user for owner-id and owner-display-name when the personal-space root carries no explicit owner', async () => {
    // Production reality: SpaceEnv's constructor builds a synthetic
    // unanchored root for personal spaces without populating owner
    // (space-env.model.ts:71). PROPFINDs against /remote.php/dav/files/<u>/
    // therefore landed with empty <oc:owner-id> and <oc:owner-display-name>.
    // Several NC Android versions gate "can write here" on
    // owner-id == loggedInUser, so empty owner-id was misread as "read-only".
    // Personal-space ownership IS the requesting user by definition; emit
    // them as the owner when no explicit one is set.
    const folder = new WebDAVFile(
      { id: 1, name: 'janwiebe', isDir: true, size: 0, ctime: Date.now(), mtime: Date.now(), mime: undefined },
      '/remote.php/dav/files/janwiebe/',
      true
    )
    webdavSpaces.propfind.mockReturnValue(makeGen([folder]))
    const space = {
      alias: SPACE_ALIAS.PERSONAL,
      envPermissions: SPACE_ALL_OPERATIONS,
      permissions: SPACE_ALL_OPERATIONS,
      repository: SPACE_REPOSITORY.FILES,
      inPersonalSpace: true,
      // Mirrors what SpaceEnv constructor sets when no anchored root exists:
      // id=0, no owner field at all.
      root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS }
    }
    const r = { space } as unknown as FastifyDAVRequest & { space: typeof space }
    ;(r as unknown as { user: { id: number; login: string; fullName: string } }).user = { id: 7, login: 'janwiebe', fullName: 'Jan Wiebe' }
    const { res, state } = fakeReply()
    await service.respond(r, res, 'files')
    expect(state.body).toContain('<oc:owner-id>janwiebe</oc:owner-id>')
    expect(state.body).toContain('<oc:owner-display-name>Jan Wiebe</oc:owner-display-name>')
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

  // Share-mount injection: at the NC home root with Depth: 1, append one
  // virtual <d:response> per row from NcShareMountResolverService. iOS uses
  // these to populate the home listing with folders that carry the
  // "shared with me" badge (driven by 'S' in oc:permissions).
  describe('share-mount injection at home root', () => {
    const mount = {
      shareId: 42,
      alias: 'alice-photos',
      name: "Alice's Photos",
      fileId: 9001,
      isDir: true,
      size: 0,
      ctime: 1000,
      mtime: 2000,
      mime: '',
      permissions: 'a:d:m',
      owner: { id: 1, login: 'alice', fullName: 'Alice Liddell' }
    }

    // A minimal home-root request — Depth: 1, in 'files' mode, with the
    // NC home-root flag set by the controller in attachSpace.
    function homeRootReq() {
      const r = req()
      ;(r as unknown as { user: { id: number; login: string; fullName: string } }).user = { id: 7, login: 'bob', fullName: 'Bob Burns' }
      ;(r as unknown as { nc: { isHomeRoot: boolean } }).nc = { isHomeRoot: true }
      ;(r as unknown as { dav: { depth: string } }).dav = { depth: '1' }
      return r
    }

    it('injects one <d:response> per share-mount the user has received', async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      expect(shareMounts.listMounts).toHaveBeenCalledWith(r.user)
      // d:href targets the user's NC home + the share alias.
      expect(state.body).toContain('<d:href>/remote.php/dav/files/bob/alice-photos/</d:href>')
      // Underlying file's real DB id propagates to oc:fileid (so a follow-up
      // PROPFIND on this href finds the same id from the donor space).
      expect(state.body).toContain('<oc:fileid>9001</oc:fileid>')
    })

    it("emits 'S' in oc:permissions on the mount root — drives iOS's shared-with-me folder icon", async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      // Pull out the mount-root block to scope the assertion.
      const mountBlock = state.body!.split('<d:href>/remote.php/dav/files/bob/alice-photos/</d:href>')[1]?.split('</d:response>')[0] ?? ''
      expect(mountBlock).toMatch(/<oc:permissions>S[A-Z]*<\/oc:permissions>/)
    })

    it("omits 'S' from the home-root response itself (the parent must NOT carry S, or iOS treats nothing as a mount)", async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      // The home root is the first <d:response> (href ends with /alice/ — the
      // default fixture user, since we didn't override the WebDAVFile bases).
      const homeRootBlock = state.body!.split('<d:href>/remote.php/dav/files/alice/</d:href>')[1]?.split('</d:response>')[0] ?? ''
      expect(homeRootBlock).not.toMatch(/<oc:permissions>S[A-Z]*<\/oc:permissions>/)
    })

    it("emits nc:mount-type='shared' on mount-root entries", async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      const mountBlock = state.body!.split('<d:href>/remote.php/dav/files/bob/alice-photos/</d:href>')[1]?.split('</d:response>')[0] ?? ''
      expect(mountBlock).toContain('<nc:mount-type>shared</nc:mount-type>')
    })

    it('emits owner-id / owner-display-name from the donor, not the recipient', async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      const mountBlock = state.body!.split('<d:href>/remote.php/dav/files/bob/alice-photos/</d:href>')[1]?.split('</d:response>')[0] ?? ''
      expect(mountBlock).toContain('<oc:owner-id>alice</oc:owner-id>')
      expect(mountBlock).toContain('<oc:owner-display-name>Alice Liddell</oc:owner-display-name>')
    })

    it('does not inject mounts when not at the home root', async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = req()
      ;(r as unknown as { user: { id: number; login: string } }).user = { id: 7, login: 'bob' }
      ;(r as unknown as { nc: { isHomeRoot: boolean } }).nc = { isHomeRoot: false }
      ;(r as unknown as { dav: { depth: string } }).dav = { depth: '1' }
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      expect(shareMounts.listMounts).not.toHaveBeenCalled()
      expect(state.body).not.toContain('alice-photos')
    })

    it('does not inject mounts in trashbin mode', async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'trashbin')
      expect(shareMounts.listMounts).not.toHaveBeenCalled()
      expect(state.body).not.toContain('alice-photos')
    })

    it('does not inject mounts at Depth: 0 (only the home root itself is described)', async () => {
      shareMounts.listMounts.mockResolvedValue([mount])
      const r = homeRootReq()
      ;(r as unknown as { dav: { depth: string } }).dav = { depth: '0' }
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      expect(shareMounts.listMounts).not.toHaveBeenCalled()
      expect(state.body).not.toContain('alice-photos')
    })

    it('emits nothing extra when the user has no incoming shares', async () => {
      shareMounts.listMounts.mockResolvedValue([])
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      expect(shareMounts.listMounts).toHaveBeenCalled()
      expect(state.body).not.toMatch(/<nc:mount-type>shared<\/nc:mount-type>/)
    })

    it('degrades to "home minus mounts" when listMounts throws — iOS gets a partial home, not a 500', async () => {
      // A DB outage or transient share-side failure shouldn't fail the whole
      // PROPFIND. The user's personal-space entries still render; mounts
      // simply don't appear until the next refresh recovers them.
      shareMounts.listMounts.mockRejectedValue(new Error('database connection lost'))
      const r = homeRootReq()
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      expect(state.status).toBe(207)
      // Personal-space root + child still in the body.
      expect(state.body).toContain('<d:href>/remote.php/dav/files/alice/</d:href>')
      expect(state.body).toContain('<d:href>/remote.php/dav/files/alice/pic.jpg</d:href>')
      // No mount-type=shared entries leaked in.
      expect(state.body).not.toMatch(/<nc:mount-type>shared<\/nc:mount-type>/)
    })

    it("encodes the recipient's login in the hrefBase so non-ASCII logins round-trip identically to real NC", async () => {
      shareMounts.listMounts.mockResolvedValue([
        {
          shareId: 1,
          alias: 'docs',
          name: 'docs',
          fileId: 1,
          isDir: true,
          size: 0,
          ctime: 1_716_891_500_000,
          mtime: 1_716_891_600_000,
          mime: '',
          permissions: 'a:d:m',
          owner: { id: 1, login: 'alice', fullName: 'Alice Liddell' }
        }
      ])
      const r = homeRootReq()
      ;(r as unknown as { user: { id: number; login: string; fullName: string } }).user = { id: 7, login: "o'malley", fullName: "O'Malley" }
      const { res, state } = fakeReply()
      await service.respond(r, res, 'files')
      // login "o'malley" must be rawurlencode-encoded (apostrophe → %27),
      // not left literal (encodeURIComponent's default).
      expect(state.body).toContain('<d:href>/remote.php/dav/files/o%27malley/docs/</d:href>')
    })
  })
})
