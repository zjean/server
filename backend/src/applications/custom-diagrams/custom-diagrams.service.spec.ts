import { HttpStatus } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { CustomDiagramsService } from './custom-diagrams.service'

// Mock heavy transitive deps before any service code is evaluated.
// FilesManager → archiver → archiver-utils/glob has an incomplete install in
// this repo's node_modules (no dist/), so we intercept at the source level.
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
jest.mock('node:fs', () => ({ existsSync: jest.fn() }))
jest.mock('../files/utils/files', () => ({
  genEtag: jest.fn().mockReturnValue('abc123'),
  getProps: jest.fn().mockResolvedValue({ name: 'test.drawio', mtime: 1000, size: 10, isDir: false, path: '', id: -1 })
}))

const mockUser = { id: 7 } as any
// envPermissions 'amd' = ADD + MODIFY + DELETE → writable
const mockSpaceRw = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: 'amd' } as any
// envPermissions '' → read-only
const mockSpaceRo = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: '' } as any

const FILE_PATH = 'files/personal/test.drawio'

describe('CustomDiagramsService', () => {
  let service: CustomDiagramsService
  let spacesManager: { spaceEnv: jest.Mock }
  let filesManager: { mkFile: jest.Mock }

  beforeEach(() => {
    spacesManager = { spaceEnv: jest.fn() }
    filesManager = { mkFile: jest.fn() }
    service = new CustomDiagramsService(spacesManager as any, filesManager as any)
  })

  describe('load', () => {
    it('returns xml, etag, editorUrl and isWritable=true for writable space', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as jest.Mock).mockReturnValue(true)
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
      ;(existsSync as jest.Mock).mockReturnValue(true)
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
      ;(existsSync as jest.Mock).mockReturnValue(true)
      await expect(service.load(mockUser, FILE_PATH)).rejects.toMatchObject({ status: 413 })
    })
  })

  describe('save', () => {
    it('throws 403 when space is read-only', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'abc123' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
    })

    it('throws 409 when etag mismatches', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
    })

    it('writes and returns new etag on success', async () => {
      const { genEtag } = await import('../files/utils/files')
      ;(genEtag as jest.Mock)
        .mockReturnValueOnce('abc123') // current etag check
        .mockReturnValueOnce('new-etag') // post-write etag
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      const result = await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'abc123' })
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', '<mxfile/>', 'utf-8')
      expect(result.etag).toBe('new-etag')
    })
  })

  describe('createNew', () => {
    it('creates file seeded with a valid mxGraph skeleton', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      filesManager.mkFile.mockResolvedValue(undefined)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      jest.mocked(writeFile).mockClear()
      const result = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
      expect(filesManager.mkFile).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledTimes(1)
      const [destPath, contents, encoding] = jest.mocked(writeFile).mock.calls[0]
      expect(destPath).toBe('/data/test.drawio')
      expect(encoding).toBe('utf-8')
      // mxGraph requires <mxfile> wrapper, <mxGraphModel> body, and a root cell
      // pair (id=0 with id=1 parent=0). Assert structure rather than exact bytes
      // so the skeleton can be tweaked without churning the test.
      expect(contents).toMatch(/^<mxfile>/)
      expect(contents).toContain('<mxGraphModel>')
      expect(contents).toContain('<root>')
      expect(contents).toContain('<mxCell id="0"/>')
      expect(contents).toContain('<mxCell id="1" parent="0"/>')
      expect(result.path).toBe('files/personal/test.drawio')
    })
  })
})
