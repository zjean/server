import { Test, TestingModule } from '@nestjs/testing'
import { getProps } from '../../files/utils/files'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { WebDAVMethods } from '../../webdav/services/webdav-methods.service'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcPropfindService } from '../services/nc-propfind.service'
import { NcDavController } from './nc-dav.controller'

// `getProps` does fs.stat. Mock it so the test doesn't need a real file on disk.
jest.mock('../../files/utils/files', () => ({
  getProps: jest.fn()
}))

const mockedGetProps = getProps as jest.Mock

describe(`${NcDavController.name} — ensureDbRowForUpload`, () => {
  let moduleRef: TestingModule
  let controller: NcDavController
  let spacesQueries: { getOrCreateUserFile: jest.Mock }

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
    spacesQueries = { getOrCreateUserFile: jest.fn() }
    moduleRef = await Test.createTestingModule({
      controllers: [NcDavController],
      providers: [
        { provide: NcPathResolverService, useValue: {} },
        { provide: SpacesManager, useValue: {} },
        { provide: SpacesQueries, useValue: spacesQueries },
        { provide: WebDAVMethods, useValue: {} },
        { provide: NcPropfindService, useValue: {} }
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

  it('does NOT insert for non-personal spaces (out of scope — needs different signature)', async () => {
    const req = {
      space: { inPersonalSpace: false, realPath: '/data/spaces/team/file.pdf', relativeUrl: 'file.pdf' },
      user: { id: 7 }
    } as unknown as FastifyDAVRequest
    await controller.ensureDbRowForUpload(req)
    expect(spacesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
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
