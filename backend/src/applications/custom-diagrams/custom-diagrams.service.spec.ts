import { HttpStatus } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
// Only the three filesystem probes are faked. `sanitizePath` (reached through
// PATH_TO_SPACE_SEGMENTS) and the rest stay REAL — a stubbed path sanitiser
// would make the traversal case below pass for the wrong reason.
vi.mock('../files/utils/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../files/utils/files')>()),
  getProps: vi.fn().mockResolvedValue({ name: 'test.drawio', mtime: 1000, size: 10, isDir: false, path: '', id: -1 }),
  isPathExists: vi.fn().mockResolvedValue(true),
  isPathIsDir: vi.fn().mockResolvedValue(false)
}))

const sha1 = (s: string) => createHash('sha1').update(s, 'utf-8').digest('hex')

// `authorize` runs canAccessToSpaceUrl, which asks the principal for its
// user-level app permissions — so the mock needs a real answer, not a bare id.
const mockUser = { id: 7, login: 'alice', havePermission: () => true } as any
const mockUserNoRepoAccess = { id: 8, login: 'mallory', havePermission: () => false } as any
const SPACE_BASE = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', enabled: true, inTrashRepository: false, quotaIsExceeded: false }
// envPermissions 'amd' = ADD + MODIFY + DELETE → writable
const mockSpaceRw = { ...SPACE_BASE, envPermissions: 'amd' } as any
// envPermissions '' → read-only
const mockSpaceRo = { ...SPACE_BASE, envPermissions: '' } as any
// A personal-space trash path: full permission bits, but the trash is read-only
// for everyone (space.guard.ts:46-48).
const mockSpaceTrash = { ...SPACE_BASE, envPermissions: 'a:d:m:si:so', inTrashRepository: true } as any
const mockSpaceDisabled = { ...SPACE_BASE, envPermissions: 'amd', enabled: false } as any
const mockSpaceQuotaExceeded = { ...SPACE_BASE, envPermissions: 'amd', quotaIsExceeded: true } as any

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
    vi.mocked(rename).mockReset()
    vi.mocked(unlink).mockReset()
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

    it('returns isWritable=false in the trash even though the permission bits say otherwise', async () => {
      // A personal-space trash path carries SPACE_ALL_OPERATIONS, so the MODIFY
      // bit alone reports it writable — but every save there is refused.
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceTrash)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      const result = await service.load(mockUser, 'trash/personal/test.drawio')
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
      // Should not have written or renamed anything before discovering the mismatch.
      expect(writeFile).not.toHaveBeenCalled()
      expect(rename).not.toHaveBeenCalled()
    })

    it('writes via tmpfile + rename and returns content-hash etag on success', async () => {
      const baseXml = '<mxfile><graph/></mxfile>'
      const newXml = '<mxfile><graph><cell/></graph></mxfile>'
      const baseEtag = sha1(baseXml)
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      // Same content on both reads = no concurrent writer; recheck passes.
      vi.mocked(readFile).mockResolvedValue(baseXml as any)
      vi.mocked(writeFile).mockResolvedValue(undefined as any)
      vi.mocked(rename).mockResolvedValue(undefined as any)

      const result = await service.save(mockUser, { path: FILE_PATH, xml: newXml, etag: baseEtag })

      // writeFile targets a tmpfile alongside the real path, NOT the real path.
      expect(writeFile).toHaveBeenCalledTimes(1)
      const [tmpPath, contents, encoding] = vi.mocked(writeFile).mock.calls[0]
      expect(tmpPath).toMatch(/^\/data\/test\.drawio\.tmp-/)
      expect(contents).toBe(newXml)
      expect(encoding).toBe('utf-8')
      // rename moves tmp → real path atomically.
      expect(rename).toHaveBeenCalledTimes(1)
      const [fromPath, toPath] = vi.mocked(rename).mock.calls[0]
      expect(fromPath).toBe(tmpPath)
      expect(toPath).toBe('/data/test.drawio')
      expect(result.etag).toBe(sha1(newXml))
      expect(result.etag).not.toBe(baseEtag)
    })

    it('throws 409 and unlinks tmpfile when a concurrent writer changes the file between read and rename', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      const concurrentXml = '<mxfile><b/></mxfile>'
      const baseEtag = sha1(baseXml)
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      // First read sees the baseline (etag matches). Second read (after writeFile
      // to tmp) sees a different version — recheck fails → 409, tmpfile cleaned up.
      vi.mocked(readFile)
        .mockResolvedValueOnce(baseXml as any)
        .mockResolvedValueOnce(concurrentXml as any)
      vi.mocked(writeFile).mockResolvedValue(undefined as any)
      vi.mocked(unlink).mockResolvedValue(undefined as any)

      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><c/></mxfile>', etag: baseEtag })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
      expect(writeFile).toHaveBeenCalledTimes(1)
      expect(rename).not.toHaveBeenCalled()
      expect(unlink).toHaveBeenCalledTimes(1)
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

  // #473: the controller carries no SpaceGuard and the path arrives in a query
  // parameter / body rather than in the URL, so every check the guard would have
  // performed has to be performed here. These cases pin each one.
  describe('authorization', () => {
    it('refuses createNew for a read-only member instead of creating the file', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRo)
      await expect(service.createNew(mockUser, { dirPath: 'files/spaces/shared', name: 'test.drawio' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
      expect(filesManager.mkFile).not.toHaveBeenCalled()
      expect(writeFile).not.toHaveBeenCalled()
    })

    it('refuses createNew in the trash', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceTrash)
      await expect(service.createNew(mockUser, { dirPath: 'trash/personal', name: 'test.drawio' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
      expect(filesManager.mkFile).not.toHaveBeenCalled()
    })

    it('refuses createNew when the space quota is exceeded', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceQuotaExceeded)
      await expect(service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })).rejects.toMatchObject({
        status: HttpStatus.INSUFFICIENT_STORAGE
      })
      expect(filesManager.mkFile).not.toHaveBeenCalled()
    })

    it('refuses save in the trash even with full permission bits', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceTrash)
      ;(existsSync as Mock).mockReturnValue(true)
      await expect(service.save(mockUser, { path: 'trash/personal/test.drawio', xml: '<mxfile/>', etag: sha1('<mxfile/>') })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN
      })
      expect(writeFile).not.toHaveBeenCalled()
    })

    it.each([
      ['load', () => service.load(mockUser, FILE_PATH)],
      ['save', () => service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'x' })],
      ['createNew', () => service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })]
    ])('refuses %s on a disabled space', async (_name, call) => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceDisabled)
      ;(existsSync as Mock).mockReturnValue(true)
      await expect(call()).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    })

    it('refuses a repository the user has no app permission for, without touching the space resolver', async () => {
      await expect(service.load(mockUserNoRepoAccess, FILE_PATH)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
      expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    })

    it('normalizes the path before resolving the space (was a raw split)', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile/>' as any)

      await service.load(mockUser, 'files/personal/sub/../test.drawio')
      expect(spacesManager.spaceEnv).toHaveBeenCalledWith(mockUser, ['files', 'personal', 'test.drawio'])
    })

    it('refuses a path that climbs out of a known repository', async () => {
      // sanitizePath normalizes first, so this resolves to `etc/passwd` — a
      // repository canAccessToSpaceUrl does not recognise → 403.
      await expect(service.load(mockUser, 'files/personal/../../etc/passwd')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
      expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
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
