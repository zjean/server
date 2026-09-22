import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { SPACE_ALL_OPERATIONS, SPACE_OPERATION, SPACE_PERMS_SEP, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { USER_PERMISSION } from '../../users/constants/user'
import { getProps } from '../../files/utils/files'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { WebDAVMethods } from '../../webdav/services/webdav-methods.service'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcPropfindService } from '../services/nc-propfind.service'
import { NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'
import { NcSyncReportService } from '../services/nc-sync-report.service'
import { NcFavoritesReportService } from '../services/nc-favorites-report.service'
import { NcDavController } from './nc-dav.controller'
import { Mock } from 'vitest'
import { NO_CLIENT_FILE_ID } from '../../custom-shared/constants/file-ids'

// `getProps` does fs.stat. Mock it so the test doesn't need a real file on disk.
// Partial mock (importActual): vitest is stricter than jest about missing named
// exports — transitive importers of this module reference other exports (fileName, …),
// so keep the real module and override only getProps.
//
// `isPathExists` / `isPathIsDir` are mocked for the same reason: SpaceGuard's
// PUT branch stats the target to decide between ADD and MODIFY (#515).
vi.mock('../../files/utils/files', async (importActual) => ({
  ...(await importActual<typeof import('../../files/utils/files')>()),
  getProps: vi.fn(),
  isPathExists: vi.fn().mockResolvedValue(false),
  isPathIsDir: vi.fn().mockResolvedValue(false)
}))

// `dbFileFromSpace` reads several SpaceEnv branches; mock it to return a known
// stub so the test asserts the flow, not the helper's internal logic.
vi.mock('../../spaces/utils/paths', () => ({
  dbFileFromSpace: vi.fn()
}))

// A stand-in for the UserModel NcBasicAuthGuard attaches to the request.
// attachSpace runs `canAccessToSpaceUrl`, which calls `user.havePermission`,
// so the fake has to answer it (#515). `allow` narrows what the fake holds.
const ncUser = (login: string, allow: (p: string) => boolean = () => true) =>
  ({ id: 7, login, settings: null, havePermission: allow }) as unknown as { id: number; login: string }

const mockedGetProps = getProps as Mock
const mockedDbFileFromSpace = dbFileFromSpace as Mock

describe(`${NcDavController.name} — ensureDbRowForUpload`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesQueries: { getOrCreateUserFile: Mock; getOrCreateSpaceFile: Mock }

  const fileProps = {
    id: -987654, // negative inode placeholder — what parseFS returns for new files
    name: 'PDF Form Sample.pdf',
    path: '.',
    isDir: false,
    size: 1234,
    ctime: Date.now(),
    mtime: Date.now(),
    mime: 'application/pdf'
  }

  beforeAll(async () => {
    spacesQueries = { getOrCreateUserFile: vi.fn(), getOrCreateSpaceFile: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        {
          provide: NcShareMountResolverService,
          useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn().mockResolvedValue(null) }
        },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: spacesQueries },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetProps.mockResolvedValue(fileProps)
    mockedDbFileFromSpace.mockReturnValue({ ownerId: 7, spaceId: 42, path: 'sub' })
  })

  it('inserts a DB row after a PUT to personal space', async () => {
    const req = {
      space: { inPersonalSpace: true, realPath: '/data/users/janwiebe/files/PDF.pdf', relativeUrl: 'PDF.pdf' },
      user: { id: 7, login: 'janwiebe' }
    } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    expect(spacesQueries.getOrCreateUserFile).toHaveBeenCalledWith(7, fileProps)
    expect(mockedGetProps).toHaveBeenCalledWith('/data/users/janwiebe/files/PDF.pdf', 'PDF.pdf', false)
  })

  it('inserts a DB row after a PUT to a shared (non-personal) space via getOrCreateSpaceFile', async () => {
    const space = { inPersonalSpace: false, inTrashRepository: false, realPath: '/data/spaces/team/file.pdf', relativeUrl: 'file.pdf' }
    const req = { space, user: { id: 7, login: 'janwiebe' } } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    // dbFileFromSpace must be called with (userId, space) so it can pick the
    // right ownerId / spaceId / share-external branch.
    expect(mockedDbFileFromSpace).toHaveBeenCalledWith(7, space)
    // Then the space-aware insert is invoked with fileId=0 (caller has no
    // existing id), the FS-derived fileProps, and the dbFile skeleton.
    // Sentinel, not 0: upstream's assertValidFileReferenceId rejects 0 since 2.5.0.
    expect(spacesQueries.getOrCreateSpaceFile).toHaveBeenCalledWith(NO_CLIENT_FILE_ID, fileProps, { ownerId: 7, spaceId: 42, path: 'sub' })
    // The personal-space helper must NOT fire for shared-space writes.
    expect(spacesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('skips for trash-repository writes (uploads should never land there, but guard)', async () => {
    const req = {
      space: { inPersonalSpace: false, inTrashRepository: true, realPath: '/data/trash/x', relativeUrl: 'x' },
      user: { id: 7 }
    } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    expect(spacesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
    expect(spacesQueries.getOrCreateSpaceFile).not.toHaveBeenCalled()
  })

  it('skips silently when the user is missing (defensive — should never happen post-guard)', async () => {
    const req = {
      space: { inPersonalSpace: true, realPath: '/x', relativeUrl: '.' }
    } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    expect(spacesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('skips when the just-PUT path turns out to be a directory (PUT shouldn’t but guard against it)', async () => {
    mockedGetProps.mockResolvedValueOnce({ ...fileProps, isDir: true })
    const req = {
      space: { inPersonalSpace: true, realPath: '/x', relativeUrl: '.' },
      user: { id: 7 }
    } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    expect(spacesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })
})

// Regression: stock NC clients use the basename of <d:href> for display and
// re-use the href verbatim as the URL of the next request. If our PROPFIND
// emits double-encoded hrefs (e.g. "My%2520folder" for a folder named "My
// folder"), the iOS/Android UI shows "My%20folder" with a literal %20, AND
// follow-up navigation lands on a path whose decoded form is "My%20folder"
// (with the encoding baked in), which doesn't exist on disk → empty listing.
//
// The double-encoding originates in NcDavController.attachSpace, which must
// store req.dav.url *decoded* (mirroring upstream WebDAVProtocolGuard) so
// that downstream WebDAVFile.encodeUrl encodes once, not twice.
describe(`${NcDavController.name} — attachSpace URL decoding`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesManager: { spaceEnv: Mock }

  beforeAll(async () => {
    spacesManager = { spaceEnv: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        // Real resolver — its decoding logic is part of what we're testing.
        NcPathResolverService,
        {
          provide: NcShareMountResolverService,
          useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn().mockResolvedValue(null) }
        },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    spacesManager.spaceEnv.mockResolvedValue({ enabled: true, envPermissions: SPACE_ALL_OPERATIONS } as unknown)
  })

  it('decodes %20 in req.dav.url so PROPFIND hrefs are not double-encoded', async () => {
    const req = {
      url: '/remote.php/dav/files/john/My%20folder',
      headers: {},
      params: {},
      user: ncUser('john')
    } as unknown as FastifyDAVRequest
    await (controller as unknown as { attachSpace: (r: FastifyDAVRequest, i: { mode: 'files'; subpath: string }) => Promise<void> }).attachSpace(
      req,
      { mode: 'files', subpath: 'My%20folder' }
    )
    expect(req.dav.url).toBe('/remote.php/dav/files/john/My folder')
  })

  it('strips the query string from the decoded url', async () => {
    const req = {
      url: '/remote.php/dav/files/john/My%20folder?token=abc',
      headers: {},
      params: {},
      user: ncUser('john')
    } as unknown as FastifyDAVRequest
    await (controller as unknown as { attachSpace: (r: FastifyDAVRequest, i: { mode: 'files'; subpath: string }) => Promise<void> }).attachSpace(
      req,
      { mode: 'files', subpath: 'My%20folder' }
    )
    expect(req.dav.url).toBe('/remote.php/dav/files/john/My folder')
  })
})

// Share-mount routing — when the NC home subpath's first segment matches one
// of the user's incoming shares, the request is routed into the SHARES
// repository so SpacesManager.spaceEnv (which already special-cases
// 'shares/<alias>') resolves the share's donor space + permission overlay.
//
// The check happens *before* the path resolver. If the alias collides with a
// real folder in the user's personal/home space, the share wins (matches real
// NC behaviour for recipient-side mountpoints).
describe(`${NcDavController.name} — attachSpace share-mount routing`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesManager: { spaceEnv: Mock }
  let shareMounts: { listMounts: Mock; findByAlias: Mock }

  beforeAll(async () => {
    spacesManager = { spaceEnv: vi.fn() }
    // attachSpace memoizes a listMounts call once per request. findByAlias
    // remains on the surface but is unused by buildUrlSegments after the
    // memo fix; we keep a mock here so the rest of the suite (which provides
    // it as a fallback) compiles.
    shareMounts = { listMounts: vi.fn(), findByAlias: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        NcPathResolverService,
        { provide: NcShareMountResolverService, useValue: shareMounts },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    spacesManager.spaceEnv.mockResolvedValue({ enabled: true, envPermissions: SPACE_ALL_OPERATIONS } as unknown)
    shareMounts.listMounts.mockResolvedValue([])
  })

  const attach = (req: FastifyDAVRequest, input: { mode: 'files' | 'trashbin'; subpath: string }) =>
    (
      controller as unknown as { attachSpace: (r: FastifyDAVRequest, i: { mode: 'files' | 'trashbin'; subpath: string }) => Promise<void> }
    ).attachSpace(req, input)

  it('routes a known share-alias subpath into the shares repository', async () => {
    shareMounts.listMounts.mockResolvedValue([{ alias: 'alice-photos' }])
    const req = {
      url: '/remote.php/dav/files/bob/alice-photos/vacation.jpg',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: 'alice-photos/vacation.jpg' })
    expect(shareMounts.listMounts).toHaveBeenCalledWith(req.user)
    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(req.user, ['shares', 'alice-photos', 'vacation.jpg'])
  })

  it('falls through to the personal home when the first segment is not a share alias', async () => {
    shareMounts.listMounts.mockResolvedValue([])
    const req = {
      url: '/remote.php/dav/files/bob/Documents/notes.txt',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: 'Documents/notes.txt' })
    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(req.user, ['files', 'personal', 'Documents', 'notes.txt'])
  })

  it('does not consult share-mounts for trashbin requests', async () => {
    const req = {
      url: '/remote.php/dav/trashbin/bob/something',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'trashbin', subpath: 'something' })
    expect(shareMounts.listMounts).not.toHaveBeenCalled()
    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(req.user, ['trash', 'personal', 'something'])
  })

  it('does not consult share-mounts at the empty home root', async () => {
    const req = {
      url: '/remote.php/dav/files/bob',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: '' })
    expect(shareMounts.listMounts).not.toHaveBeenCalled()
  })

  it('decodes the share-alias segment before lookup', async () => {
    shareMounts.listMounts.mockResolvedValue([{ alias: 'pôt commun' }])
    const req = {
      url: '/remote.php/dav/files/bob/p%C3%B4t%20commun/x.txt',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: 'p%C3%B4t%20commun/x.txt' })
    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(req.user, ['shares', 'pôt commun', 'x.txt'])
  })

  it('fetches share-mounts at most once per COPY/MOVE request — destination resolution reuses the memo', async () => {
    shareMounts.listMounts.mockResolvedValue([{ alias: 'alice-photos' }])
    const req = {
      url: '/remote.php/dav/files/bob/alice-photos/source.jpg',
      method: 'MOVE',
      headers: { destination: 'https://host/remote.php/dav/files/bob/alice-photos/renamed.jpg' },
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: 'alice-photos/source.jpg' })
    // attachSpace path + mapNcPathToInternal path together should produce
    // exactly one listMounts call thanks to makeMountsMemo.
    expect(shareMounts.listMounts).toHaveBeenCalledTimes(1)
  })
})

// #483 — a Destination (or request path) that normalizes to nothing must be
// REFUSED, not resolved to the space root.
//
// normalize() used to answer '' both for "the root" and for "this path has a
// `.`/`..` segment I refuse to interpret". Either answer produced the segments
// ['files', 'personal'], which WebDAVMethods.copyMove takes as the destination
// — and since Overwrite defaults to T (RFC 4918), copyMove calls
// deleteDestination() on it first: the user's entire home moved to trash, then
// the source moved on top. FilesManager grants this because the virtual-endpoint
// overlay only strips DELETE, and delete() performs no permission check of its
// own. The same conflation made `PROPFIND /files/bob/a/./b` silently list the
// whole home.
//
// Real sabre/dav never lands there: Server::calculateUri() normalizes dot
// segments and throws Forbidden for anything outside the base URI (see
// sabre-io/dav @ cfa5d40, lib/DAV/Server.php:559). We take the conservative
// route for a surface that only has to satisfy stock NC clients (none of which
// emit dot segments): refuse with 400.
describe(`${NcDavController.name} — attachSpace destination refusal (#483)`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesManager: { spaceEnv: Mock }

  beforeAll(async () => {
    spacesManager = { spaceEnv: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        // Real resolver — the null-vs-'' distinction under test lives in it.
        NcPathResolverService,
        {
          provide: NcShareMountResolverService,
          useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn().mockResolvedValue(null) }
        },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    spacesManager.spaceEnv.mockResolvedValue({ enabled: true, envPermissions: SPACE_ALL_OPERATIONS } as unknown)
  })

  const attach = (req: FastifyDAVRequest, input: { mode: 'files' | 'trashbin'; subpath: string }) =>
    (
      controller as unknown as { attachSpace: (r: FastifyDAVRequest, i: { mode: 'files' | 'trashbin'; subpath: string }) => Promise<void> }
    ).attachSpace(req, input)

  const moveReq = (destination: string) =>
    ({
      url: '/remote.php/dav/files/bob/Documents/report.pdf',
      method: 'MOVE',
      headers: { destination },
      params: {},
      user: ncUser('bob')
    }) as unknown as FastifyDAVRequest

  const expect400 = async (req: FastifyDAVRequest, subpath = 'Documents/report.pdf') => {
    await expect(attach(req, { mode: 'files', subpath })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    expect(req.dav?.copyMove).toBeUndefined()
  }

  it('refuses a MOVE whose Destination is the bare home root', async () => {
    await expect400(moveReq('/remote.php/dav/files/bob/'))
  })

  it('refuses a MOVE whose Destination is the home root with no trailing slash', async () => {
    await expect400(moveReq('/remote.php/dav/files/bob'))
  })

  it('refuses a MOVE whose absolute Destination is the home root', async () => {
    await expect400(moveReq('https://cloud.example.org/remote.php/dav/files/bob/'))
  })

  it('refuses a MOVE whose Destination carries a "." segment', async () => {
    await expect400(moveReq('/remote.php/dav/files/bob/a/./b'))
  })

  it('refuses a MOVE whose Destination carries a ".." segment', async () => {
    await expect400(moveReq('/remote.php/dav/files/bob/a/../b'))
  })

  it('refuses a MOVE whose Destination is the trashbin root', async () => {
    await expect400(moveReq('/remote.php/dav/trashbin/bob/'))
  })

  // The refusal above was only half-applied: `new URL(dest).pathname` runs RFC
  // 3986 remove_dot_segments (treating `%2e` as a dot), so an ABSOLUTE
  // Destination had its dot segments erased before anything could refuse them
  // — the byte-identical request 400'd in relative form and resolved
  // sabre-style in absolute form. Not exploitable (the collapse happens before
  // the prefix check, so `…/bob/../alice/x` then fails `startsWith`), but the
  // decision was reject, not resolve.
  it.each([
    ['https://cloud.example.org/remote.php/dav/files/bob/a/../b', 'plain ".."'],
    ['https://cloud.example.org/remote.php/dav/files/bob/a/./b', 'plain "."'],
    ['https://cloud.example.org/remote.php/dav/files/bob/a/%2e%2e/b', 'lowercase "%2e%2e"'],
    ['https://cloud.example.org/remote.php/dav/files/bob/a/%2E%2E/b', 'uppercase "%2E%2E"'],
    ['https://cloud.example.org/remote.php/dav/files/bob/a%2F..%2Fb', 'encoded separators']
  ])('refuses a MOVE whose ABSOLUTE Destination carries %s (%s)', async (destination) => {
    await expect400(moveReq(destination))
  })

  // Same shape, aimed OUTSIDE the user's tree. This one 400s either way, but
  // for the WRONG reason before the fix: `..` collapsed into
  // `/remote.php/dav/files/alice/secret.txt`, which then failed the
  // `startsWith(/remote.php/dav/files/bob/)` prefix test. Assert the reason,
  // not just the status.
  it('refuses an absolute Destination that climbs out of the home tree as a dot segment, not as a bad prefix', async () => {
    const req = moveReq('https://cloud.example.org/remote.php/dav/files/bob/../alice/secret.txt')
    await expect(attach(req, { mode: 'files', subpath: 'Documents/report.pdf' })).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: expect.stringContaining('must not contain "." or ".." segments')
    })
    expect(req.dav?.copyMove).toBeUndefined()
  })

  // All four refusals used to report "Destination must point at
  // /remote.php/dav/{files,trashbin}/{user}/...", which is wrong for the three
  // that DO point there.
  it.each([
    ['/remote.php/dav/files/bob/a/../b', 'must not contain "." or ".." segments'],
    ['/remote.php/dav/files/bob/', 'must name a file or folder, not the space root'],
    ['/remote.php/dav/caldav/bob/x', 'must point at /remote.php/dav/{files,trashbin}/{user}/...']
  ])('reports a distinct reason for %s', async (destination, fragment) => {
    await expect(attach(moveReq(destination), { mode: 'files', subpath: 'Documents/report.pdf' })).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: expect.stringContaining(fragment)
    })
  })

  it('still accepts an ordinary ABSOLUTE MOVE destination', async () => {
    const req = moveReq('https://cloud.example.org/remote.php/dav/files/bob/Archive/report.pdf')
    await attach(req, { mode: 'files', subpath: 'Documents/report.pdf' })
    expect(req.dav.copyMove).toEqual({ destination: 'personal/Archive/report.pdf', overwrite: true, isMove: true })
  })

  it('still accepts an ordinary MOVE destination', async () => {
    const req = moveReq('/remote.php/dav/files/bob/Archive/report.pdf')
    await attach(req, { mode: 'files', subpath: 'Documents/report.pdf' })
    expect(req.dav.copyMove).toEqual({ destination: 'personal/Archive/report.pdf', overwrite: true, isMove: true })
  })

  it('refuses a request PATH with a "." segment instead of listing the whole home', async () => {
    const req = {
      url: '/remote.php/dav/files/bob/a/./b',
      method: 'PROPFIND',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await expect(attach(req, { mode: 'files', subpath: 'a/./b' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    // The load-bearing half: we never asked for a space at all, so there is no
    // home-root SpaceEnv for a DELETE/MOVE to act on.
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
  })

  it('still resolves the legitimate home root (subpath "") — the root itself is not rejected', async () => {
    const req = {
      url: '/remote.php/dav/files/bob',
      method: 'PROPFIND',
      headers: {},
      params: {},
      user: ncUser('bob')
    } as unknown as FastifyDAVRequest
    await attach(req, { mode: 'files', subpath: '' })
    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(req.user, ['files', 'personal'])
    expect(req.nc.isHomeRoot).toBe(true)
  })
})

// Favorites dispatch — invokeWebDAV must route oc:favorite PROPPATCH bodies to
// NcFavoritesReportService (and leave non-favorite PROPPATCHes on the upstream
// mtime path), and route the REPORT <oc:filter-files> body to the favorites
// listing rather than the sync-collection handler.
describe(`${NcDavController.name} — favorites dispatch`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let webdav: { proppatch: Mock }
  let favoritesReport: { respond: Mock; respondProppatchFavorite: Mock }
  let syncReport: { respond: Mock }

  const invoke = (req: FastifyDAVRequest, res: unknown, mode: 'files' | 'trashbin') =>
    (
      controller as unknown as {
        invokeWebDAV: (r: FastifyDAVRequest, res: unknown, mode: 'files' | 'trashbin') => Promise<unknown>
      }
    ).invokeWebDAV(req, res, mode)

  beforeAll(async () => {
    webdav = { proppatch: vi.fn().mockResolvedValue(undefined) }
    favoritesReport = { respond: vi.fn().mockResolvedValue(undefined), respondProppatchFavorite: vi.fn().mockResolvedValue(undefined) }
    syncReport = { respond: vi.fn().mockResolvedValue(undefined) }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        { provide: NcShareMountResolverService, useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn() } },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: webdav },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: syncReport },
        { provide: NcFavoritesReportService, useValue: favoritesReport }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => vi.clearAllMocks())

  function req(method: string, body: string | null): FastifyDAVRequest {
    return {
      method,
      body,
      space: { repository: 'files' },
      user: { id: 7, login: 'alice' },
      dav: { url: '/remote.php/dav/files/alice/report.pdf' }
    } as unknown as FastifyDAVRequest
  }

  const FAV_SET = `<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>`
  const FAV_REMOVE = `<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:remove><d:prop><oc:favorite/></d:prop></d:remove></d:propertyupdate>`
  const MTIME = `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>x</d:getlastmodified></d:prop></d:set></d:propertyupdate>`
  const FILTER_FILES = `<oc:filter-files xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:"><d:prop><d:displayname/></d:prop><oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>`

  it('routes a PROPPATCH oc:favorite=1 to the favorites service (favorite=true), not the mtime handler', async () => {
    await invoke(req('PROPPATCH', FAV_SET), {}, 'files')
    expect(favoritesReport.respondProppatchFavorite).toHaveBeenCalledWith(expect.anything(), expect.anything(), true)
    expect(webdav.proppatch).not.toHaveBeenCalled()
  })

  it('routes a PROPPATCH oc:favorite <d:remove> to the favorites service (favorite=false)', async () => {
    await invoke(req('PROPPATCH', FAV_REMOVE), {}, 'files')
    expect(favoritesReport.respondProppatchFavorite).toHaveBeenCalledWith(expect.anything(), expect.anything(), false)
    expect(webdav.proppatch).not.toHaveBeenCalled()
  })

  it('leaves a non-favorite PROPPATCH (mtime) on the upstream proppatch handler', async () => {
    await invoke(req('PROPPATCH', MTIME), {}, 'files')
    expect(webdav.proppatch).toHaveBeenCalled()
    expect(favoritesReport.respondProppatchFavorite).not.toHaveBeenCalled()
  })

  it('routes a REPORT <oc:filter-files> body to the favorites listing, not the sync-collection handler', async () => {
    await invoke(req('REPORT', FILTER_FILES), {}, 'files')
    expect(favoritesReport.respond).toHaveBeenCalled()
    expect(syncReport.respond).not.toHaveBeenCalled()
  })
})

// GET/HEAD dispatch — the download handler must call WebDAVMethods.headOrGet
// with SPACE_REPOSITORY.FILES regardless of the resolved space repository,
// exactly like the native WebDAV controller (webdav.controller.ts). headOrGet
// only streams when its `repository` arg is FILES; passing req.space.repository
// (which is SHARES for a recipient-side share-mount) made it 403 every
// download/open/preview of a shared-with-me file on the NC mobile clients.
// The `inSharesList` guard inside headOrGet still rejects the virtual
// shares-list pseudo-root, so passing FILES is safe.
describe(`${NcDavController.name} — GET/HEAD dispatch`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let webdav: { headOrGet: Mock }

  const invoke = (req: FastifyDAVRequest, res: unknown, mode: 'files' | 'trashbin') =>
    (
      controller as unknown as {
        invokeWebDAV: (r: FastifyDAVRequest, res: unknown, mode: 'files' | 'trashbin') => Promise<unknown>
      }
    ).invokeWebDAV(req, res, mode)

  beforeAll(async () => {
    webdav = { headOrGet: vi.fn().mockResolvedValue(undefined) }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        { provide: NcShareMountResolverService, useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn() } },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: webdav },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => vi.clearAllMocks())

  function getReq(repository: SPACE_REPOSITORY): FastifyDAVRequest {
    return {
      method: 'GET',
      space: { repository },
      user: { id: 7, login: 'bob' },
      dav: { url: '/remote.php/dav/files/bob/alice-photos/vacation.jpg' }
    } as unknown as FastifyDAVRequest
  }

  it('downloads a shared-with-me file: calls headOrGet with FILES even though the space is SHARES', async () => {
    await invoke(getReq(SPACE_REPOSITORY.SHARES), {}, 'files')
    expect(webdav.headOrGet).toHaveBeenCalledWith(expect.anything(), expect.anything(), SPACE_REPOSITORY.FILES)
  })

  it('downloads a personal-space file: still calls headOrGet with FILES', async () => {
    await invoke(getReq(SPACE_REPOSITORY.FILES), {}, 'files')
    expect(webdav.headOrGet).toHaveBeenCalledWith(expect.anything(), expect.anything(), SPACE_REPOSITORY.FILES)
  })
})

describe(`${NcDavController.name} — legacy /remote.php/webdav redirect`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController

  const res = () => {
    const headers: Record<string, string> = {}
    const r = {
      statusCode: 0,
      headers,
      status(code: number) {
        r.statusCode = code
        return r
      },
      header(name: string, value: string) {
        headers[name] = value
        return r
      }
    }
    return r
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        { provide: NcShareMountResolverService, useValue: { listMounts: vi.fn().mockResolvedValue([]), findByAlias: vi.fn() } },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: {} }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  const req = (url: string) => ({ url, user: { id: 7, login: 'bob' } }) as unknown as FastifyDAVRequest

  // 308, never 301. This is the URL ONLYOFFICE documents for connecting its
  // Documents mobile app to a Nextcloud account, and real Nextcloud serves the
  // path outright — so no client here has been hardened against a redirect that
  // changes the method. A 301 may legally be replayed as GET (RFC 7231 §6.4.2),
  // which silently turns a PUT into a download of the collection; 308 forbids it.
  it('answers the bare legacy root with 308 and the modern per-user location', async () => {
    const r = res()
    await controller.legacyWebdavRoot(req('/remote.php/webdav'), r as never)
    expect(r.statusCode).toBe(308)
    expect(r.headers.location).toBe('/remote.php/dav/files/bob/')
  })

  it('carries the subpath through, url-encoding the login', async () => {
    const r = res()
    await controller.legacyWebdavRest(req('/remote.php/webdav/docs/report.docx'), r as never)
    expect(r.statusCode).toBe(308)
    expect(r.headers.location).toBe('/remote.php/dav/files/bob/docs/report.docx')
  })

  it('drops the query string from the redirect target', async () => {
    const r = res()
    await controller.legacyWebdavRest(req('/remote.php/webdav/a.docx?x=1'), r as never)
    expect(r.headers.location).toBe('/remote.php/dav/files/bob/a.docx')
  })
})

// #515 — the NC DAV surface performed NO permission check at all.
//
// `attachSpace` reimplemented the SpaceGuard prelude (spaceEnv + `enabled`)
// and stopped there: it never called `canAccessToSpaceUrl` and never called
// `SpaceGuard.checkPermissions`. The handlers it dispatches into do not
// compensate — `WebDAVMethods.delete` / `.put` / `.mkcol` rely entirely on the
// `@UseGuards(SpaceGuard)` declared on webdav.controller.ts, and
// `FilesManager.delete` runs no check of its own.
//
// These cases drive the controller's ROUTE HANDLERS (filesRootBare /
// filesSubpath), not attachSpace directly, so they prove the decision is on
// the path a request takes through this controller — everything short of the
// HTTP layer and the guard chain. An e2e is still the right check for the
// chain itself (NcBasicAuthGuard → handler) and is noted in the PR.
describe(`${NcDavController.name} — space authorization (#515)`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesManager: { spaceEnv: Mock }
  let shareMounts: { listMounts: Mock; findByAlias: Mock }
  let webdav: { delete: Mock; put: Mock; mkcol: Mock; copyMove: Mock; proppatch: Mock }
  let propfind: { respond: Mock }
  let favoritesReport: { respondProppatchFavorite: Mock; respond: Mock }

  // Sync-in permission strings are ':'-separated operation letters.
  const READ_ONLY = ''
  const ADD_ONLY = SPACE_OPERATION.ADD
  const FULL = [SPACE_OPERATION.ADD, SPACE_OPERATION.DELETE, SPACE_OPERATION.MODIFY].join(SPACE_PERMS_SEP)

  const res = () => ({ status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() }) as never

  const space = (envPermissions: string, extra: Record<string, unknown> = {}) =>
    ({
      enabled: true,
      envPermissions,
      id: 5,
      alias: 'ReadOnlyShare',
      url: 'shares/ReadOnlyShare/doc.pdf',
      realPath: '/data/spaces/alice/Photos/doc.pdf',
      inTrashRepository: false,
      quotaIsExceeded: false,
      ...extra
    }) as unknown

  const request = (method: string, url: string, body: string | null = null) =>
    ({ method, url, headers: {}, params: {}, body, user: ncUser('bob') }) as unknown as FastifyDAVRequest

  beforeAll(async () => {
    spacesManager = { spaceEnv: vi.fn() }
    shareMounts = { listMounts: vi.fn(), findByAlias: vi.fn() }
    webdav = {
      delete: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      mkcol: vi.fn().mockResolvedValue(undefined),
      copyMove: vi.fn().mockResolvedValue(undefined),
      proppatch: vi.fn().mockResolvedValue(undefined)
    }
    propfind = { respond: vi.fn().mockResolvedValue(undefined) }
    favoritesReport = { respondProppatchFavorite: vi.fn().mockResolvedValue(undefined), respond: vi.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        NcPathResolverService,
        { provide: NcShareMountResolverService, useValue: shareMounts },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: SpacesQueries, useValue: { getOrCreateUserFile: vi.fn(), getOrCreateSpaceFile: vi.fn() } },
        { provide: WebDAVMethods, useValue: webdav },
        { provide: NcPropfindService, useValue: propfind },
        { provide: NcSyncReportService, useValue: {} },
        { provide: NcFavoritesReportService, useValue: favoritesReport }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDavController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    shareMounts.listMounts.mockResolvedValue([{ alias: 'ReadOnlyShare' }])
    mockedGetProps.mockResolvedValue({ isDir: false })
  })

  // Consequence 1 of the issue. The home root's SpaceEnv already has DELETE
  // stripped by the virtual-endpoint overlay (space-env.model.ts) — what was
  // missing was anyone READING that overlay.
  it('refuses DELETE on the home root instead of trashing the whole tree', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(ADD_ONLY, { alias: 'personal', url: 'files/personal' }))
    const req = request('DELETE', '/remote.php/dav/files/bob')
    await expect(controller.filesRootBare('bob', req, res())).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(webdav.delete).not.toHaveBeenCalled()
  })

  // Consequence 2. A read-only share mount accepted every write verb.
  it.each([
    ['DELETE', () => webdav.delete],
    ['MKCOL', () => webdav.mkcol],
    ['PUT', () => webdav.put]
  ])('refuses %s on a read-only share mount', async (method, handler) => {
    spacesManager.spaceEnv.mockResolvedValue(space(READ_ONLY))
    const req = request(method, '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf')
    await expect(controller.filesSubpath('bob', req, res())).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(handler()).not.toHaveBeenCalled()
  })

  it('still allows DELETE on a share mount that grants it', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(FULL))
    await controller.filesSubpath('bob', request('DELETE', '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf'), res())
    expect(webdav.delete).toHaveBeenCalled()
  })

  it('leaves read verbs alone — PROPFIND on a read-only mount still answers', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(READ_ONLY))
    await controller.filesSubpath('bob', request('PROPFIND', '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf'), res())
    expect(propfind.respond).toHaveBeenCalled()
  })

  // The user-level repository gate — the other half of what SpaceGuard does.
  it('refuses a share-mount path when the user has no SHARES application permission', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(FULL))
    const req = { ...request('PROPFIND', '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf') } as FastifyDAVRequest
    ;(req as { user: unknown }).user = ncUser('bob', (p) => p !== USER_PERMISSION.SHARES)
    await expect(controller.filesSubpath('bob', req, res())).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
  })

  it('refuses the personal home when the user has no PERSONAL_SPACE application permission', async () => {
    shareMounts.listMounts.mockResolvedValue([])
    spacesManager.spaceEnv.mockResolvedValue(space(FULL))
    const req = { ...request('PROPFIND', '/remote.php/dav/files/bob/Documents') } as FastifyDAVRequest
    ;(req as { user: unknown }).user = ncUser('bob', (p) => p !== USER_PERMISSION.PERSONAL_SPACE)
    await expect(controller.filesSubpath('bob', req, res())).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
  })

  // oc:favorite is per-user metadata. Real Nextcloud lets you star something
  // you can only read, so it must NOT be mapped through SPACE_HTTP_PERMISSION
  // (which would demand MODIFY and break starring on every read-only share).
  it('allows an oc:favorite PROPPATCH on a read-only mount but refuses an mtime PROPPATCH', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(READ_ONLY))
    const fav = `<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>`
    await controller.filesSubpath('bob', request('PROPPATCH', '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf', fav), res())
    expect(favoritesReport.respondProppatchFavorite).toHaveBeenCalledWith(expect.anything(), expect.anything(), true)

    const mtime = `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>x</d:getlastmodified></d:prop></d:set></d:propertyupdate>`
    await expect(
      controller.filesSubpath('bob', request('PROPPATCH', '/remote.php/dav/files/bob/ReadOnlyShare/doc.pdf', mtime), res())
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(webdav.proppatch).not.toHaveBeenCalled()
  })

  // Carried in from SpaceGuard.checkPermissions rather than restated here —
  // which is the point of reusing it.
  it('answers 507 rather than 403 when the destination space is over quota', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(FULL, { quotaIsExceeded: true }))
    await expect(controller.filesSubpath('bob', request('MKCOL', '/remote.php/dav/files/bob/ReadOnlyShare/new'), res())).rejects.toMatchObject({
      status: HttpStatus.INSUFFICIENT_STORAGE
    })
    expect(webdav.mkcol).not.toHaveBeenCalled()
  })

  it('refuses a write into the trash repository with the trash-is-read-only rule', async () => {
    spacesManager.spaceEnv.mockResolvedValue(space(FULL, { inTrashRepository: true }))
    await expect(controller.trashbinSubpath('bob', request('MKCOL', '/remote.php/dav/trashbin/bob/personal/x'), res())).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN
    })
    expect(webdav.mkcol).not.toHaveBeenCalled()
  })
})
