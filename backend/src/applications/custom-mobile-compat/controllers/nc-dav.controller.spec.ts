import { Test, TestingModule } from '@nestjs/testing'
import { getProps } from '../../files/utils/files'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { WebDAVMethods } from '../../webdav/services/webdav-methods.service'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcPropfindService } from '../services/nc-propfind.service'
import { NcSyncReportService } from '../services/nc-sync-report.service'
import { NcDavController } from './nc-dav.controller'

// `getProps` does fs.stat. Mock it so the test doesn't need a real file on disk.
jest.mock('../../files/utils/files', () => ({
  getProps: jest.fn()
}))

// `dbFileFromSpace` reads several SpaceEnv branches; mock it to return a known
// stub so the test asserts the flow, not the helper's internal logic.
jest.mock('../../spaces/utils/paths', () => ({
  dbFileFromSpace: jest.fn()
}))

const mockedGetProps = getProps as jest.Mock
const mockedDbFileFromSpace = dbFileFromSpace as jest.Mock

describe(`${NcDavController.name} — ensureDbRowForUpload`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesQueries: { getOrCreateUserFile: jest.Mock; getOrCreateSpaceFile: jest.Mock }

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
    spacesQueries = { getOrCreateUserFile: jest.fn(), getOrCreateSpaceFile: jest.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: spacesQueries },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} }
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
    jest.clearAllMocks()
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
    expect(spacesQueries.getOrCreateSpaceFile).toHaveBeenCalledWith(0, fileProps, { ownerId: 7, spaceId: 42, path: 'sub' })
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
  let spacesManager: { spaceEnv: jest.Mock }

  beforeAll(async () => {
    spacesManager = { spaceEnv: jest.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        // Real resolver — its decoding logic is part of what we're testing.
        NcPathResolverService,
        { provide: SpacesManager, useValue: spacesManager },
        { provide: SpacesQueries, useValue: {} },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} },
        { provide: NcSyncReportService, useValue: {} }
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
    jest.clearAllMocks()
    spacesManager.spaceEnv.mockResolvedValue({ enabled: true } as unknown)
  })

  it('decodes %20 in req.dav.url so PROPFIND hrefs are not double-encoded', async () => {
    const req = {
      url: '/remote.php/dav/files/john/My%20folder',
      headers: {},
      params: {},
      user: { login: 'john', settings: null }
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
      user: { login: 'john', settings: null }
    } as unknown as FastifyDAVRequest
    await (controller as unknown as { attachSpace: (r: FastifyDAVRequest, i: { mode: 'files'; subpath: string }) => Promise<void> }).attachSpace(
      req,
      { mode: 'files', subpath: 'My%20folder' }
    )
    expect(req.dav.url).toBe('/remote.php/dav/files/john/My folder')
  })
})
