import { HttpStatus } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { writeFromStream } from '../files/utils/files'
import { CustomDiagramsService } from './custom-diagrams.service'
import { Mock } from 'vitest'

// Mock heavy transitive deps before any service code is evaluated.
// FilesManager → archiver → archiver-utils/glob has an incomplete install in
// this repo's node_modules (no dist/), so we intercept at the source level.
vi.mock('../files/services/files-manager.service', () => ({
  FilesManager: class FilesManager {}
}))
vi.mock('../spaces/services/spaces-manager.service', () => ({
  SpacesManager: class SpacesManager {}
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('../files/utils/files', () => ({
  getProps: vi.fn().mockResolvedValue({ name: 'test.drawio', mtime: 1000, size: 10, isDir: false, path: '', id: -1 }),
  writeFromStream: vi.fn().mockResolvedValue(undefined)
}))

// Drains what the service handed writeFromStream, so a case can assert on the
// bytes rather than on the stream object.
async function writtenPayload(call: number): Promise<{ path: string; content: string }> {
  const [dstPath, stream] = vi.mocked(writeFromStream).mock.calls[call] as [string, Readable]
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return { path: dstPath, content: Buffer.concat(chunks).toString('utf-8') }
}

const sha1 = (s: string) => createHash('sha1').update(s, 'utf-8').digest('hex')

const mockUser = { id: 7 } as any
// envPermissions 'amd' = ADD + MODIFY + DELETE → writable
const mockSpaceRw = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: 'amd' } as any
// envPermissions '' → read-only
const mockSpaceRo = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: '' } as any

const FILE_PATH = 'files/personal/test.drawio'

describe('CustomDiagramsService', () => {
  let service: CustomDiagramsService
  let spacesManager: { spaceEnv: Mock }
  let filesManager: { mkFile: Mock }

  beforeEach(() => {
    spacesManager = { spaceEnv: vi.fn() }
    filesManager = { mkFile: vi.fn() }
    service = new CustomDiagramsService(spacesManager as any, filesManager as any)
    vi.mocked(readFile).mockReset()
    vi.mocked(writeFile).mockReset()
    vi.mocked(writeFromStream).mockReset()
    vi.mocked(writeFromStream).mockResolvedValue(undefined)
  })

  describe('load', () => {
    it('returns xml, content-hash etag, editorUrl and isWritable=true for writable space', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, FILE_PATH)
      expect(spacesManager.spaceEnv).toHaveBeenCalledWith(mockUser, ['files', 'personal', 'test.drawio'])
      expect(result.xml).toBe('<mxfile/>')
      expect(result.etag).toBe(sha1('<mxfile/>'))
      expect(result.etag).toMatch(/^[0-9a-f]{40}$/)
      expect(result.editorUrl).toBe('https://embed.diagrams.net')
      expect(result.isWritable).toBe(true)
    })

    it('returns isWritable=false for read-only space', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, FILE_PATH)
      expect(result.isWritable).toBe(false)
    })

    it('throws 413 when file exceeds size limit', async () => {
      const { getProps } = await import('../files/utils/files')
      ;(getProps as Mock).mockResolvedValueOnce({
        name: 'big.drawio',
        mtime: 1000,
        size: 11 * 1024 * 1024,
        isDir: false,
        path: '',
        id: -1
      })
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      await expect(service.load(mockUser, FILE_PATH)).rejects.toMatchObject({ status: 413 })
    })
  })

  describe('save', () => {
    it('throws 403 when space is read-only', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      ;(existsSync as Mock).mockReturnValue(true)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: sha1('<mxfile/>') })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
    })

    it('throws 409 when client etag does not match on-disk content', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<onDiskNow/>' as any)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
      // Nothing may touch the live file before the mismatch is discovered.
      expect(writeFromStream).not.toHaveBeenCalled()
    })

    // #495 / ADR §9 invariant 2. The old implementation wrote a sibling
    // `.tmp-<pid>-…` file and rename()d it over the target, which REPLACES the
    // inode that trash retention keys its records on — and left that tmp file
    // behind, un-hidden by `isInternalTemporaryEntry`, if the process died in
    // between. The write must land on the live path itself.
    it('writes the payload straight into the live path, preserving its inode, and creates no tmp file', async () => {
      const baseXml = '<mxfile><graph/></mxfile>'
      const newXml = '<mxfile><graph><cell/></graph></mxfile>'
      const baseEtag = sha1(baseXml)
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)

      const result = await service.save(mockUser, { path: FILE_PATH, xml: newXml, etag: baseEtag })

      expect(writeFromStream).toHaveBeenCalledTimes(1)
      const written = await writtenPayload(0)
      expect(written.path).toBe('/data/test.drawio')
      expect(written.content).toBe(newXml)
      // No staging file anywhere: nothing to orphan, nothing to rename.
      expect(writeFile).not.toHaveBeenCalled()
      expect(result.etag).toBe(sha1(newXml))
      expect(result.etag).not.toBe(baseEtag)
    })

    // `writeFromStream` truncates the destination the moment the stream opens
    // (flag 'w'), so it must never be reached with a `start` offset or a second
    // destination — the only argument shape that keeps the inode is this one.
    it('never passes a start offset to writeFromStream', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)

      await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><c/></mxfile>', etag: sha1(baseXml) })

      const [, , options] = vi.mocked(writeFromStream).mock.calls[0]
      expect(options?.start ?? 0).toBe(0)
    })

    it('two distinct payloads of equal byte length produce different etags', () => {
      // Same length, different content. The old size+mtime ETag would collide
      // under second-resolution filesystems; content-hash must not.
      const a = '<mxfile><a id="1"/></mxfile>'
      const b = '<mxfile><b id="2"/></mxfile>'
      expect(Buffer.byteLength(a, 'utf-8')).toBe(Buffer.byteLength(b, 'utf-8'))
      expect(sha1(a)).not.toBe(sha1(b))
    })
  })

  describe('createNew', () => {
    it('creates file seeded with a valid mxGraph skeleton', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      filesManager.mkFile.mockResolvedValue(undefined)
      vi.mocked(writeFile).mockResolvedValue(undefined)

      vi.mocked(writeFile).mockClear()
      const result = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
      expect(filesManager.mkFile).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledTimes(1)
      const [destPath, contents, encoding] = vi.mocked(writeFile).mock.calls[0]
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
