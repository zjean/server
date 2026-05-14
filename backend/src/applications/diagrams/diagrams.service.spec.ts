jest.mock('../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        usersPath: '/tmp/users',
        tmpPath: '/tmp/tmp',
        spacesPath: '/tmp/spaces',
        drawio: { url: 'https://embed.diagrams.net' }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: jest.fn()
}))

import { HttpStatus } from '@nestjs/common'
import { readFile, writeFile } from 'node:fs/promises'
import { ACTION } from '../../common/constants'
import { DiagramsService } from './diagrams.service'

jest.mock('../files/services/files-manager.service', () => ({
  FilesManager: class FilesManager {}
}))
jest.mock('../spaces/services/spaces-manager.service', () => ({
  SpacesManager: class SpacesManager {}
}))
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn()
}))
jest.mock('../files/utils/files', () => ({
  genEtag: jest.fn().mockReturnValue('abc123'),
  getProps: jest.fn().mockResolvedValue({ name: 'test.drawio', mtime: 1000, size: 10, isDir: false, path: '', id: -1 }),
  isPathExists: jest.fn().mockResolvedValue(true)
}))
jest.mock('../files/events/file-events', () => ({ FileEvent: { emit: jest.fn() } }))

const mockUser = { id: 7 } as any
// envPermissions 'amd' = ADD + MODIFY + DELETE → writable
const mockSpaceRw = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: 'amd' } as any
// envPermissions '' → read-only
const mockSpaceRo = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: '' } as any

const FILE_PATH = 'files/personal/test.drawio'

describe('DiagramsService', () => {
  let service: DiagramsService
  let spacesManager: { spaceEnv: jest.Mock }
  let filesManager: { mkFile: jest.Mock }

  beforeEach(() => {
    jest.clearAllMocks()
    spacesManager = { spaceEnv: jest.fn() }
    filesManager = { mkFile: jest.fn() }
    service = new DiagramsService(spacesManager as any, filesManager as any)
  })

  describe('load', () => {
    it('returns xml, etag, editorUrl and isWritable=true for writable space', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      jest.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, FILE_PATH)
      expect(spacesManager.spaceEnv).toHaveBeenCalledWith(mockUser, ['files', 'personal', 'test.drawio'])
      expect(result.xml).toBe('<mxfile/>')
      expect(result.etag).toBe('abc123')
      expect(result.editorUrl).toBe('https://embed.diagrams.net')
      expect(result.isWritable).toBe(true)
    })

    it('returns isWritable=false for read-only space', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      jest.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, FILE_PATH)
      expect(result.isWritable).toBe(false)
    })

    it('throws 413 when file exceeds size limit', async () => {
      const { getProps } = await import('../files/utils/files')
      ;(getProps as jest.Mock).mockResolvedValueOnce({
        name: 'big.drawio',
        mtime: 1000,
        size: 11 * 1024 * 1024,
        isDir: false,
        path: '',
        id: -1
      })
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      await expect(service.load(mockUser, FILE_PATH)).rejects.toMatchObject({ status: 413 })
    })
  })

  describe('save', () => {
    it('throws 403 when space is read-only', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'abc123' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
    })

    it('throws 409 when etag mismatches', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
    })

    it('writes xml, emits FileEvent, and returns new etag on success', async () => {
      const { genEtag } = await import('../files/utils/files')
      const { FileEvent } = await import('../files/events/file-events')
      ;(genEtag as jest.Mock)
        .mockReturnValueOnce('abc123') // before-write etag check
        .mockReturnValueOnce('new-etag') // post-write etag
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      const result = await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'abc123' })
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', '<mxfile/>', 'utf-8')
      expect(FileEvent.emit).toHaveBeenCalledWith('event', expect.objectContaining({ action: ACTION.UPDATE }))
      expect(result.etag).toBe('new-etag')
    })
  })

  describe('createNew', () => {
    it('creates file and returns path', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      filesManager.mkFile.mockResolvedValue(undefined)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      const result = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
      expect(filesManager.mkFile).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledWith(
        '/data/test.drawio',
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
        'utf-8'
      )
      expect(result.path).toBe('files/personal/test.drawio')
    })
  })
})
