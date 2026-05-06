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
jest.mock('../files/services/files-queries.service', () => ({
  FilesQueries: class FilesQueries {}
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
const mockSpace = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio' } as any

describe('CustomDiagramsService', () => {
  let service: CustomDiagramsService
  let filesQueries: { getUserFile: jest.Mock }
  let spacesManager: { spaceEnv: jest.Mock }
  let filesManager: { mkFile: jest.Mock }

  beforeEach(() => {
    filesQueries = { getUserFile: jest.fn() }
    spacesManager = { spaceEnv: jest.fn() }
    filesManager = { mkFile: jest.fn() }

    service = new CustomDiagramsService(
      filesQueries as any,
      spacesManager as any,
      filesManager as any
    )
  })

  describe('load', () => {
    it('throws 404 when getUserFile returns null', async () => {
      filesQueries.getUserFile.mockResolvedValue(null)
      await expect(service.load(mockUser, 42)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    })

    it('returns xml, etag and editorUrl on success', async () => {
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      jest.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, 42)
      expect(result.xml).toBe('<mxfile/>')
      expect(result.etag).toBe('abc123')
      expect(result.editorUrl).toBe('https://app.diagrams.net')
    })

    it('throws 413 when file exceeds size limit', async () => {
      const { getProps } = await import('../files/utils/files')
      ;(getProps as jest.Mock).mockResolvedValueOnce({ name: 'big.drawio', mtime: 1000, size: 11 * 1024 * 1024, isDir: false, path: '', id: -1 })
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'big.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      await expect(service.load(mockUser, 42)).rejects.toMatchObject({ status: 413 })
    })
  })

  describe('save', () => {
    it('throws 409 when etag mismatches', async () => {
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)

      await expect(
        service.save(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'stale' })
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT })
    })

    it('writes and returns new etag on success', async () => {
      const { genEtag } = await import('../files/utils/files')
      ;(genEtag as jest.Mock)
        .mockReturnValueOnce('abc123')   // first call: current etag (matches dto.etag)
        .mockReturnValueOnce('new-etag') // second call: post-write etag
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      const result = await service.save(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'abc123' })
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', '<mxfile/>', 'utf-8')
      expect(result.etag).toBe('new-etag')
    })
  })

  describe('createNew', () => {
    it('creates file and returns path', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      filesManager.mkFile.mockResolvedValue(undefined)
      jest.mocked(writeFile).mockResolvedValue(undefined)

      const result = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
      expect(filesManager.mkFile).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', ' ', 'utf-8')
      expect(result.path).toBe('files/personal/test.drawio')
    })
  })
})
