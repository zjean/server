// Mock configuration loader before any module that transitively imports it (UserModel → config.environment)
jest.mock('../../configuration/config.environment', () => ({
  configuration: { applications: { files: { usersPath: '/tmp/users', tmpPath: '/tmp/tmp', spacesPath: '/tmp/spaces' } } },
  serverConfig: {},
  exportConfiguration: jest.fn()
}))

import { Test } from '@nestjs/testing'
import { CustomDiagramsController } from './custom-diagrams.controller'
import { CustomDiagramsService } from './custom-diagrams.service'

const mockUser = { id: 7 } as any
const mockService = {
  load: jest.fn(),
  save: jest.fn(),
  createNew: jest.fn()
}

describe('CustomDiagramsController', () => {
  let controller: CustomDiagramsController

  beforeEach(async () => {
    jest.clearAllMocks()
    const module = await Test.createTestingModule({
      controllers: [CustomDiagramsController],
      providers: [{ provide: CustomDiagramsService, useValue: mockService }]
    }).compile()
    controller = module.get(CustomDiagramsController)
  })

  it('load delegates to service', async () => {
    mockService.load.mockResolvedValue({
      xml: '<mxfile/>',
      etag: 'abc',
      mtime: 0,
      name: 'f.drawio',
      isWritable: true,
      editorUrl: 'https://app.diagrams.net'
    })
    const result = await controller.load(mockUser, 'files/personal/f.drawio')
    expect(mockService.load).toHaveBeenCalledWith(mockUser, 'files/personal/f.drawio')
    expect(result.xml).toBe('<mxfile/>')
  })

  it('save delegates to service', async () => {
    mockService.save.mockResolvedValue({ etag: 'new', mtime: 1 })
    const result = await controller.save(mockUser, { path: 'files/personal/f.drawio', xml: '<mxfile/>', etag: 'abc' })
    expect(mockService.save).toHaveBeenCalledWith(mockUser, { path: 'files/personal/f.drawio', xml: '<mxfile/>', etag: 'abc' })
    expect(result.etag).toBe('new')
  })

  it('createNew delegates to service', async () => {
    mockService.createNew.mockResolvedValue({ path: 'files/personal/test.drawio' })
    const result = await controller.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
    expect(result.path).toBe('files/personal/test.drawio')
  })
})
