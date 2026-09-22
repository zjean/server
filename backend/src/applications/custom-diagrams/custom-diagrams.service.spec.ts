import { HttpException, HttpStatus } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { ACTION } from '../../common/constants'
import { SERVER_NAME } from '../../common/shared'
import { FileEvent } from '../files/events/file-events'
import { FileError } from '../files/models/file-error'
import { LockConflict } from '../files/models/file-lock-error'
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
vi.mock('../custom-versioning/services/versioning.service', () => ({
  VersioningService: class VersioningService {}
}))
vi.mock('../files/services/files-lock-manager.service', () => ({
  FilesLockManager: class FilesLockManager {}
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
const mockSpaceRw = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: 'amd', dbFile: { path: 'test.drawio' } } as any
// envPermissions '' → read-only
const mockSpaceRo = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio', envPermissions: '', dbFile: { path: 'test.drawio' } } as any

const FILE_PATH = 'files/personal/test.drawio'

describe('CustomDiagramsService', () => {
  let service: CustomDiagramsService
  let spacesManager: { spaceEnv: Mock }
  let filesManager: { mkFile: Mock }
  let versioning: { snapshotBeforeOverwrite: Mock }
  let lockManager: { createOrRefresh: Mock; removeLock: Mock }

  beforeEach(() => {
    spacesManager = { spaceEnv: vi.fn() }
    filesManager = { mkFile: vi.fn() }
    versioning = { snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined) }
    // Mirrors the real manager: [created, lock].
    lockManager = {
      createOrRefresh: vi.fn().mockResolvedValue([true, { key: 'lock-1' }]),
      removeLock: vi.fn().mockResolvedValue(true)
    }
    service = new CustomDiagramsService(spacesManager as any, filesManager as any, versioning as any, lockManager as any)
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

    // #494. Quota recompute, the NC sync log and Recents all hang off this bus,
    // and the save emitted nothing — so a diagram could be edited all day
    // without any of the three noticing. `createNew` emitted ACTION.ADD, which
    // is what made the omission easy to miss.
    it('emits an UPDATE FileEvent tagged as an editor save, after the bytes have landed', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)
      const emit = vi.spyOn(FileEvent, 'emit').mockReturnValue(true)
      try {
        await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><b/></mxfile>', etag: sha1(baseXml) })

        expect(emit).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledWith('event', {
          user: mockUser,
          space: mockSpaceRw,
          action: ACTION.UPDATE,
          rPath: '/data/test.drawio',
          source: 'editor'
        })
        // An event announcing content that is not on disk yet would have every
        // subscriber read the OLD bytes.
        expect(vi.mocked(writeFromStream).mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0])
      } finally {
        emit.mockRestore()
      }
    })

    it('emits nothing when the save is rejected', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<onDiskNow/>' as any)
      const emit = vi.spyOn(FileEvent, 'emit').mockReturnValue(true)
      try {
        await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
          status: HttpStatus.CONFLICT
        })
        expect(emit).not.toHaveBeenCalled()
      } finally {
        emit.mockRestore()
      }
    })

    // `writeFromStream` picks its open flag from `options.start`: 'w' (truncate
    // in place, inode kept) when it is 0 or absent, 'a' (append) otherwise —
    // `files/utils/files.ts:253`. So the invariant is about the ARGUMENT LIST,
    // and the obvious way to write this test cannot fail: destructuring
    // `[, , options]` from a two-argument call binds `undefined`, and
    // `options?.start ?? 0` is then `0` no matter what production does. Assert
    // the arity first — that is the assertion with teeth, because the only way
    // a `start` can ever appear is a third argument appearing.
    it('calls writeFromStream with just the live path and the stream, so the write cannot become an append', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)

      await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><c/></mxfile>', etag: sha1(baseXml) })

      const call = vi.mocked(writeFromStream).mock.calls[0]
      expect(call).toHaveLength(2)
      expect(call[0]).toBe('/data/test.drawio')
      // Belt and braces for the day someone does add an options bag: it must
      // still resolve to offset 0.
      expect((call[2] as { start?: number } | undefined)?.start ?? 0).toBe(0)
    })

    /* ------------------------------------------------------- #474 versioning */

    // The eighth destructive write path. It was missing from the ADR §4 table
    // entirely, so an hour of drawio autosaves left an empty version panel.
    it('snapshots the superseded content immediately before overwriting it', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)

      await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><b/></mxfile>', etag: sha1(baseXml) })

      expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledTimes(1)
      expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledWith(mockUser, mockSpaceRw, { origin: 'web' })
      // BEFORE the write, or it captures the new bytes and the old ones are gone.
      expect(versioning.snapshotBeforeOverwrite.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeFromStream).mock.invocationCallOrder[0])
    })

    it('does not snapshot a save the etag check rejects', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<onDiskNow/>' as any)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
      expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
    })

    /* ------------------------------------------------------------ #474 locks */

    it('takes a server lock around the compare-and-write and releases the one it took', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)

      await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><b/></mxfile>', etag: sha1(baseXml) })

      // createOrRefresh, never create: `create` counts the CALLER'S OWN lock as
      // a conflict, and the user plausibly has this file open elsewhere.
      expect(lockManager.createOrRefresh).toHaveBeenCalledWith(mockUser, mockSpaceRw.dbFile, SERVER_NAME, expect.anything())
      expect(lockManager.createOrRefresh.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(readFile).mock.invocationCallOrder[0])
      expect(lockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(vi.mocked(writeFromStream).mock.invocationCallOrder[0]).toBeLessThan(lockManager.removeLock.mock.invocationCallOrder[0])
    })

    it('leaves a pre-existing lock alone — it belongs to a session that is still open', async () => {
      const baseXml = '<mxfile><a/></mxfile>'
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(baseXml as any)
      // What createOrRefresh returns for a lock that was already yours.
      lockManager.createOrRefresh.mockResolvedValue([false, { key: 'editor-lock' }])

      await service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><b/></mxfile>', etag: sha1(baseXml) })

      expect(writeFromStream).toHaveBeenCalledTimes(1)
      expect(lockManager.removeLock).not.toHaveBeenCalled()
    })

    it('releases its lock when the etag check rejects the save', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<onDiskNow/>' as any)
      await expect(service.save(mockUser, { path: FILE_PATH, xml: '<mxfile/>', etag: 'stale' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT
      })
      expect(lockManager.removeLock).toHaveBeenCalledWith('lock-1')
    })

    // LockConflict extends Error, not HttpException — unreached, it is a 500.
    it("translates someone else's lock into 423, and writes nothing", async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile><a/></mxfile>' as any)
      lockManager.createOrRefresh.mockRejectedValue(new LockConflict({ key: 'someone-else' } as any, 'Conflicting lock'))

      await expect(
        service.save(mockUser, { path: FILE_PATH, xml: '<mxfile><b/></mxfile>', etag: sha1('<mxfile><a/></mxfile>') })
      ).rejects.toMatchObject({
        status: HttpStatus.LOCKED
      })
      expect(writeFromStream).not.toHaveBeenCalled()
      expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
      expect(lockManager.removeLock).not.toHaveBeenCalled()
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

  /* --------------------------------------------------------- #474 extension */

  // Neither route gated on the extension, so they doubled as a generic
  // read-any-file / replace-any-file primitive: `load` handed back up to 10 MB
  // of a .docx as JSON *plus* the etag that lets `save` replace it with
  // arbitrary text — no version, no lock, no quota accounting, no event.
  describe('extension gate', () => {
    beforeEach(() => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      ;(existsSync as Mock).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('<mxfile/>' as any)
    })

    it.each(['files/personal/report.docx', 'files/personal/notes', 'files/personal/archive.drawio.zip', 'files/personal/trailing.'])(
      'refuses to load %s',
      async (path) => {
        await expect(service.load(mockUser, path)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
        // The space is never even resolved, so nothing is read.
        expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
        expect(readFile).not.toHaveBeenCalled()
      }
    )

    it('refuses to save a non-diagram path, before any lock or write', async () => {
      await expect(service.save(mockUser, { path: 'files/personal/report.docx', xml: '<mxfile/>', etag: sha1('<mxfile/>') })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST
      })
      expect(lockManager.createOrRefresh).not.toHaveBeenCalled()
      expect(writeFromStream).not.toHaveBeenCalled()
    })

    it('refuses to seed mxGraph xml into a non-diagram name', async () => {
      await expect(service.createNew(mockUser, { dirPath: 'files/personal', name: 'report.docx' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST
      })
      expect(filesManager.mkFile).not.toHaveBeenCalled()
    })

    it.each(['test.drawio', 'test.DRAWIO', 'board.dwb'])('accepts %s', async (name) => {
      await expect(service.load(mockUser, `files/personal/${name}`)).resolves.toMatchObject({ xml: '<mxfile/>' })
    })
  })

  describe('createNew', () => {
    /* `mkFile` throws FileError / LockConflict, and BOTH extend Error rather
       than HttpException. The controller has no `@UseFilters` and the app has
       no global filter, so an untranslated one is a 500 with an opaque body.
       `save` translated LockConflict from the very first commit; `createNew`,
       one method below, did not — POSTing a name that already exists answered
       500 where mkFile itself says 400. */
    it.each([
      [
        'a name that is already taken',
        new FileError(HttpStatus.BAD_REQUEST, 'Resource already exists'),
        HttpStatus.BAD_REQUEST,
        'Resource already exists'
      ],
      [
        "someone else's lock on the parent",
        new LockConflict({ key: 'someone-else' } as any, 'Conflicting lock'),
        HttpStatus.LOCKED,
        'The file is locked'
      ]
    ])('answers %s with an HTTP status, not a 500', async (_label, thrown, status, message) => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      filesManager.mkFile.mockRejectedValue(thrown)
      const emit = vi.spyOn(FileEvent, 'emit').mockReturnValue(true)
      try {
        const err = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(HttpException)
        expect((err as HttpException).getStatus()).toBe(status)
        expect((err as HttpException).message).toBe(message)
        // Nothing was seeded and nothing was announced.
        expect(writeFile).not.toHaveBeenCalled()
        expect(emit).not.toHaveBeenCalled()
      } finally {
        emit.mockRestore()
      }
    })

    // Only the two typed file errors are translated. A disk failure really is
    // a 500 and must not be dressed up as a client error.
    it('lets an unrecognised error through untouched', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpaceRw)
      filesManager.mkFile.mockResolvedValue(undefined)
      const ioError = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      vi.mocked(writeFile).mockRejectedValue(ioError)

      await expect(service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })).rejects.toBe(ioError)
    })

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
